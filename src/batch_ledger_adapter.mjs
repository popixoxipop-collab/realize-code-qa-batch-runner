import { JsonLedger, LedgerError } from "./json_ledger.mjs";

function invariant(condition, code, message, details = {}) {
  if (!condition) throw new LedgerError(code, message, details);
}

function clone(value) {
  return structuredClone(value);
}

function normalizeUrl(value) {
  return String(value ?? "").replace(/\/$/, "");
}

function toSubmissionState(value) {
  return ({
    pending: "pending",
    submitting: "submit_intent",
    submitted_unverified: "submitted_unverified",
    submitted: "confirmed",
    analyzing: "submitted_unverified",
    ready: "confirmed",
    complete: "confirmed",
    failed: "failed",
    blocked: "blocked",
  })[value] ?? "pending";
}

function toAnalysisState(value) {
  return ({
    pending: "not_started",
    submitting: "not_started",
    submitted_unverified: "analyzing",
    submitted: "analyzing",
    analyzing: "analyzing",
    ready: "ready",
    complete: "ready",
    failed: "failed",
    blocked: "blocked",
  })[value] ?? "not_started";
}

function fromTeamState(team) {
  if (team.batchSubmission !== undefined) {
    invariant(
      ["pending", "submitting", "submitted_unverified", "submitted", "analyzing", "ready", "complete", "failed", "blocked"].includes(team.batchSubmission),
      "INVALID_LEDGER_STATE",
      "Stored batchSubmission state is unsupported.",
      { batchSubmission: team.batchSubmission },
    );
    return team.batchSubmission;
  }
  if (team.submission === "submit_intent") return "submitting";
  if (team.submission === "submitted_unverified") {
    return team.analysis === "analyzing" ? "analyzing" : "submitted";
  }
  if (team.submission === "confirmed") return team.analysis === "ready" ? "ready" : "submitted";
  if (team.submission === "failed") return "failed";
  if (team.submission === "blocked") return "blocked";
  return "pending";
}

function toAccountSession(value) {
  return ({
    pending: "pending",
    running: "active",
    active: "active",
    complete: "complete",
    completed: "complete",
    failed: "failed",
    blocked: "blocked",
  })[value] ?? "pending";
}

function fromAccountSession(value) {
  if (value === "active") return "running";
  return value;
}

function documentToBatchState(document) {
  return {
    version: 1,
    className: document.run.class,
    repositoryUrl: `https://github.com/${document.run.repository}`,
    teams: Object.fromEntries(Object.entries(document.teams).map(([teamId, team]) => [teamId, {
      name: team.name ?? teamId,
      submission: fromTeamState(team),
      status: team.batchStatus ?? "pending",
      note: team.note ?? "",
    }])),
    accounts: Object.fromEntries(Object.entries(document.accounts).map(([accountId, account]) => [accountId, {
      teamId: account.team,
      status: fromAccountSession(account.session),
      note: account.note ?? "",
    }])),
  };
}

function initialTeamDocument(teamId, team) {
  return {
    submission: toSubmissionState(team.submission),
    analysis: toAnalysisState(team.submission),
    origin: "this_run",
    name: team.name ?? teamId,
    batchSubmission: team.submission ?? "pending",
    batchStatus: team.status ?? "pending",
    note: team.note ?? "",
  };
}

function initialAccountDocument(account) {
  const session = toAccountSession(account.status);
  return {
    team: account.teamId,
    session,
    phase: session === "complete" ? "complete" : session === "blocked" || session === "failed" ? "blocked" : "editing",
    question_fingerprint: null,
    attempt: 0,
    note: account.note ?? "",
  };
}

/**
 * Adapt the strict JsonLedger to the small load/save interface used by the
 * batch orchestrator. The first save creates the roster-shaped document;
 * later saves may update known teams/accounts but may not silently add them.
 */
export function createBatchLedgerAdapter(filePath, { round, clock } = {}) {
  invariant(typeof round === "string" && round.trim(), "INVALID_RUN_ANCHOR", "A stable round label or ID is required.");
  let ledger = null;
  let anchor = null;

  const checkpointData = (record) => {
    const { phase, account, at, version, sequence, ...data } = record ?? {};
    return { ...data, runnerSequence: sequence ?? 0 };
  };

  const resumeForAccount = (accountId) => {
    const document = ledger.snapshot();
    const journal = document.journal.filter((entry) => entry.target?.account === accountId);
    const answerIntents = journal.filter((entry) => entry.phase === "intent" && entry.action === "answer_submit");
    const confirmedIds = new Set(journal.filter((entry) => entry.phase === "confirmed").map((entry) => entry.intentId));
    const explanationAttempt = {};
    for (const entry of answerIntents) {
      if (!confirmedIds.has(entry.intentId)) continue;
      if (entry.data.fingerprint && Number.isInteger(entry.data.attempt)) {
        explanationAttempt[entry.data.fingerprint] = Math.max(explanationAttempt[entry.data.fingerprint] ?? 0, entry.data.attempt);
      }
    }
    return {
      sequence: Math.max(0, ...journal.map((entry) => Number(entry.data?.runnerSequence ?? 0))),
      attempted: answerIntents.map((entry) => entry.data.attemptKey).filter(Boolean),
      confirmed: answerIntents.filter((entry) => confirmedIds.has(entry.intentId)).map((entry) => entry.data.attemptKey).filter(Boolean),
      explanationAttempt,
    };
  };

  const ensureAnchor = ({ className, repositoryUrl }) => {
    const candidate = {
      class: String(className ?? "").trim(),
      round: round.trim(),
      repository: normalizeUrl(repositoryUrl),
    };
    if (anchor) {
      invariant(anchor.class === candidate.class && normalizeUrl(anchor.repository) === candidate.repository,
        "RUN_ANCHOR_MISMATCH", "Batch ledger adapter was reused for a different run.", { expected: anchor, actual: candidate });
    } else {
      anchor = candidate;
    }
    return candidate;
  };

  return Object.freeze({
    async load(run) {
      const expected = ensureAnchor(run);
      try {
        ledger = await JsonLedger.load(filePath, { anchor: expected, clock });
        return documentToBatchState(ledger.snapshot());
      } catch (error) {
        if (error instanceof LedgerError && error.code === "LEDGER_NOT_FOUND") return null;
        throw error;
      }
    },

    async save(state) {
      const expected = ensureAnchor({ className: state.className, repositoryUrl: state.repositoryUrl });
      if (!ledger) {
        const teams = Object.fromEntries(Object.entries(state.teams).map(([teamId, team]) => [teamId, initialTeamDocument(teamId, team)]));
        const accounts = Object.fromEntries(Object.entries(state.accounts).map(([accountId, account]) => [accountId, initialAccountDocument(account)]));
        ledger = await JsonLedger.create(filePath, { anchor: expected, teams, accounts, clock });
        return documentToBatchState(ledger.snapshot());
      }

      const current = ledger.snapshot();
      invariant(Object.keys(current.teams).length === Object.keys(state.teams).length,
        "ROSTER_CHANGED", "Team set changed after the ledger was created; reconcile explicitly.");
      invariant(Object.keys(current.accounts).length === Object.keys(state.accounts).length,
        "ROSTER_CHANGED", "Account set changed after the ledger was created; reconcile explicitly.");

      for (const [teamId, team] of Object.entries(state.teams)) {
        invariant(Object.hasOwn(current.teams, teamId), "ROSTER_CHANGED", "Unknown team appeared during resume.", { teamId });
        await ledger.updateTeam(teamId, {
          submission: toSubmissionState(team.submission),
          analysis: toAnalysisState(team.submission),
          name: team.name ?? teamId,
          batchSubmission: team.submission ?? "pending",
          batchStatus: team.status ?? "pending",
          note: team.note ?? "",
        });
      }
      for (const [accountId, account] of Object.entries(state.accounts)) {
        invariant(Object.hasOwn(current.accounts, accountId), "ROSTER_CHANGED", "Unknown account appeared during resume.", { accountId });
        const session = toAccountSession(account.status);
        const stored = ledger.snapshot().accounts[accountId];
        await ledger.updateAccount(accountId, {
          team: account.teamId,
          session,
          phase: session === "complete"
            ? "complete"
            : session === "blocked" || session === "failed"
              ? "blocked"
              : session === "active"
                ? stored.phase
                : "editing",
          question_fingerprint: stored.question_fingerprint,
          attempt: stored.attempt,
          note: account.note ?? "",
        });
      }
      return documentToBatchState(ledger.snapshot());
    },

    snapshot() {
      return ledger ? clone(ledger.snapshot()) : null;
    },

    accountCheckpointContext({ accountId, teamId }) {
      invariant(ledger, "LEDGER_NOT_INITIALIZED", "Account checkpoints require an initialized ledger.");
      const accountJournalLength = () => ledger.snapshot().journal
        .filter((entry) => entry.target?.account === accountId).length;
      const before = accountJournalLength();
      const intentIdFor = (record) => record.attemptKey
        ? `${accountId}:${record.action}:${record.attemptKey}`
        : `${accountId}:${record.action}:${record.sequence}`;

      return Object.freeze({
        resume: resumeForAccount(accountId),
        activityCount: () => accountJournalLength() - before,
        hasConfirmedCompletion: () => {
          const document = ledger.snapshot();
          return document.accounts[accountId]?.session === "complete"
            && document.journal.some((entry) => entry.phase === "confirmed"
              && entry.target?.account === accountId
              && entry.data?.visibleState === "completion");
        },
        checkpoints: Object.freeze({
          writeAhead: async (record) => {
            const intentId = intentIdFor(record);
            const entry = await ledger.appendWriteAhead({
              intentId,
              action: record.action,
              target: { team: teamId, account: accountId },
              data: checkpointData(record),
            });
            const current = ledger.snapshot().accounts[accountId];
            await ledger.updateAccount(accountId, {
              session: "active",
              phase: record.action === "answer_submit"
                ? "submit_intent"
                : record.action === "code_point_handoff"
                  ? "handoff"
                  : "editing",
              question_fingerprint: record.fingerprint ?? current.question_fingerprint,
              attempt: Number.isInteger(record.attempt) ? record.attempt : current.attempt,
            });
            return entry;
          },
          confirmed: async (record) => {
            let intentId = record.attemptKey ? intentIdFor(record) : null;
            if (!intentId) {
              const matches = ledger.resume().unresolvedIntents.filter((entry) =>
                entry.action === record.action && entry.target?.account === accountId);
              invariant(matches.length === 1, "AMBIGUOUS_CHECKPOINT_CONFIRMATION", "Confirmation does not identify exactly one persisted intent.", {
                accountId,
                action: record.action,
                matches: matches.length,
              });
              intentId = matches[0].intentId;
            }
            const entry = await ledger.appendConfirmed({ intentId, data: checkpointData(record) });
            const current = ledger.snapshot().accounts[accountId];
            const visible = record.visibleState;
            await ledger.updateAccount(accountId, {
              session: visible === "completion" ? "complete" : "active",
              phase: ({
                completion: "complete",
                reExplain: "needs_revision",
                handoff: "handoff",
                grading: "grading",
              })[visible] ?? "editing",
              question_fingerprint: record.fingerprint ?? current.question_fingerprint,
              attempt: Number.isInteger(record.attempt) ? record.attempt : current.attempt,
            });
            return entry;
          },
        }),
      });
    },
  });
}
