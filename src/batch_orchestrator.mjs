export class BatchOrchestratorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BatchOrchestratorError";
    this.code = code;
    this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new BatchOrchestratorError(code, message, details);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalId(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function clone(value) {
  return structuredClone(value);
}

function repositoryIdentity(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.hostname.toLowerCase()}/${parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").toLowerCase()}`;
  } catch {
    return canonicalId(value).replace(/\.git$/i, "").toLowerCase();
  }
}

function errorRecord(error, context = {}) {
  return {
    ...context,
    code: typeof error?.code === "string" ? error.code : "ADAPTER_ERROR",
    name: typeof error?.name === "string" ? error.name : "Error",
    message: typeof error?.message === "string" ? error.message : String(error),
  };
}

const PROFILE_QUARANTINE_CODES = new Set([
  "ACCOUNT_MISMATCH",
  "ANALYSIS_REPEATED_FAILURE",
  "ANALYSIS_RETRIES_EXHAUSTED",
  "AUTH_CONTEXT_MISMATCH",
  "BROWSER_SAFETY_PROMPT",
  "CAPTCHA",
  "CAPTCHA_DETECTED",
  "PROFILE_NOT_CONNECTED",
  "REEXPLAIN_EXHAUSTED",
  "REPOSITORY_ACCESS_FAILED",
  "REPOSITORY_ACCESS_FAILURE",
  "REPOSITORY_ACCESS_DENIED",
  "REPOSITORY_NOT_ACCESSIBLE",
  "SAFETY_PROMPT",
  "SESSION_ISOLATION_LOST",
]);

function shouldQuarantineProfile(error) {
  return error?.quarantineProfile === true
    || error?.details?.quarantineProfile === true
    || PROFILE_QUARANTINE_CODES.has(error?.code);
}

function accountIdOf(account) {
  return canonicalId(account?.accountId ?? account?.id);
}

function teamDescriptorOf(account) {
  const nested = account?.team && typeof account.team === "object" ? account.team : null;
  const rawId = account?.teamId ?? nested?.id ?? (typeof account?.team === "string" ? account.team : undefined);
  const rawName = account?.teamName ?? nested?.name ?? rawId;
  return {
    id: canonicalId(rawId),
    name: canonicalId(rawName),
    rawId: String(rawId ?? ""),
    rawName: String(rawName ?? ""),
  };
}

function validateProfiles(profileIds) {
  invariant(Array.isArray(profileIds), "INVALID_PROFILES", "profileIds must be an array.");
  const seen = new Set();
  return profileIds.map((profileId, index) => {
    const normalized = canonicalId(profileId);
    invariant(normalized.length > 0, "INVALID_PROFILE", "Every profile ID must be non-empty.", { index });
    invariant(!seen.has(normalized), "DUPLICATE_PROFILE", "Duplicate isolated profile ID detected; refusing parallel execution.", { profileId: normalized });
    seen.add(normalized);
    return normalized;
  });
}

/**
 * Validate a flat roster, retain only exact role=교육생 entries, and group them
 * by team while preserving roster order.
 */
export function groupTraineesByTeam(roster) {
  invariant(Array.isArray(roster), "INVALID_ROSTER", "Portal roster must be an array.");
  const seenAccounts = new Set();
  const teamById = new Map();
  const teamIdByName = new Map();
  const teams = [];
  let excludedCount = 0;

  for (const [rosterIndex, account] of roster.entries()) {
    invariant(account && typeof account === "object", "INVALID_ACCOUNT", "Every roster entry must be an object.", { rosterIndex });
    const accountId = accountIdOf(account);
    invariant(accountId.length > 0, "INVALID_ACCOUNT", "Every roster entry must have a non-empty accountId or id.", { rosterIndex });
    invariant(
      /^[A-Za-z0-9._:-]+$/.test(accountId),
      "SENSITIVE_ACCOUNT_ID",
      "accountId must be a non-secret machine identifier, not a display name or email address.",
      { rosterIndex },
    );
    invariant(!seenAccounts.has(accountId), "DUPLICATE_ACCOUNT", "Duplicate account ID detected in roster.", { accountId, rosterIndex });
    seenAccounts.add(accountId);

    const role = canonicalId(account.role);
    invariant(
      role === "교육생" || role === "매니저",
      "UNSUPPORTED_ROSTER_ROLE",
      "Every visible roster entry must have the exact role 교육생 or 매니저.",
      { accountId, rosterIndex, role },
    );
    if (role === "매니저") {
      excludedCount += 1;
      continue;
    }

    const descriptor = teamDescriptorOf(account);
    invariant(descriptor.id.length > 0, "INVALID_TEAM", "Every trainee must have a non-empty team ID.", { accountId, rosterIndex });
    invariant(descriptor.name.length > 0, "INVALID_TEAM", "Every trainee must have a non-empty team name.", { accountId, rosterIndex });

    const existing = teamById.get(descriptor.id);
    if (existing) {
      invariant(
        existing.name === descriptor.name && existing.rawId === descriptor.rawId && existing.rawName === descriptor.rawName,
        "DUPLICATE_TEAM",
        "The same canonical team ID appears with a conflicting duplicate descriptor.",
        { teamId: descriptor.id, firstName: existing.name, duplicateName: descriptor.name },
      );
    } else {
      const existingIdForName = teamIdByName.get(descriptor.name);
      invariant(
        existingIdForName === undefined,
        "DUPLICATE_TEAM",
        "The same canonical team name maps to multiple team IDs.",
        { teamName: descriptor.name, firstTeamId: existingIdForName, duplicateTeamId: descriptor.id },
      );
      const team = {
        id: descriptor.id,
        name: descriptor.name,
        rawId: descriptor.rawId,
        rawName: descriptor.rawName,
        accounts: [],
      };
      teamById.set(descriptor.id, team);
      teamIdByName.set(descriptor.name, descriptor.id);
      teams.push(team);
    }

    teamById.get(descriptor.id).accounts.push({
      ...account,
      accountId,
      teamId: descriptor.id,
      teamName: descriptor.name,
    });
  }

  return {
    rosterCount: roster.length,
    traineeCount: teams.reduce((count, team) => count + team.accounts.length, 0),
    excludedCount,
    teams: teams.map(({ rawId, rawName, ...team }) => team),
  };
}

function validateOptions(options) {
  invariant(options && typeof options === "object", "INVALID_OPTIONS", "Batch options are required.");
  invariant(nonEmpty(options.className), "INVALID_CLASS", "className must be a non-empty string.");
  invariant(nonEmpty(options.repositoryUrl), "INVALID_REPOSITORY", "repositoryUrl must be a non-empty URL.");
  let parsedUrl;
  try {
    parsedUrl = new URL(options.repositoryUrl);
  } catch {
    throw new BatchOrchestratorError("INVALID_REPOSITORY", "repositoryUrl is not a valid URL.");
  }
  invariant(parsedUrl.protocol === "https:", "INVALID_REPOSITORY", "repositoryUrl must use HTTPS.");
  const repositorySegments = parsedUrl.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/");
  invariant(
    ["github.com", "www.github.com"].includes(parsedUrl.hostname.toLowerCase())
      && !parsedUrl.username
      && !parsedUrl.password
      && !parsedUrl.search
      && !parsedUrl.hash
      && repositorySegments.length === 2
      && repositorySegments.every((segment) => /^[A-Za-z0-9._-]+$/.test(segment)),
    "INVALID_REPOSITORY",
    "repositoryUrl must be a plain GitHub owner/repository URL.",
  );
  invariant(Number.isInteger(options.requestedConcurrency) && options.requestedConcurrency > 0, "INVALID_CONCURRENCY", "requestedConcurrency must be a positive integer.");
  const profileIds = validateProfiles(options.profileIds);
  for (const method of ["verifyIsolatedProfiles", "getRoster", "submitRepositoryOnce", "confirmTeamSubmission", "waitAnalysisReady", "runAccount"]) {
    invariant(typeof options.portal?.[method] === "function", "INVALID_PORTAL_ADAPTER", `portal.${method} must be a function.`);
  }
  invariant(typeof options.ledger?.load === "function", "INVALID_LEDGER_ADAPTER", "ledger.load must be a function.");
  invariant(typeof options.ledger?.save === "function", "INVALID_LEDGER_ADAPTER", "ledger.save must be a function.");
  if (options.requireAccountCheckpoints) {
    invariant(typeof options.ledger?.accountCheckpointContext === "function", "INVALID_LEDGER_ADAPTER", "Live execution requires ledger.accountCheckpointContext().");
  }
  return {
    className: options.className.trim(),
    repositoryUrl: parsedUrl.href.replace(/\/$/, ""),
    requestedConcurrency: options.requestedConcurrency,
    profileIds,
    portal: options.portal,
    ledger: options.ledger,
    requireAccountCheckpoints: options.requireAccountCheckpoints === true,
  };
}

function initialLedger(className, repositoryUrl) {
  return {
    version: 1,
    className,
    repositoryUrl,
    teams: {},
    accounts: {},
  };
}

function validateLoadedLedger(loaded, className, repositoryUrl) {
  if (loaded == null) return initialLedger(className, repositoryUrl);
  invariant(loaded && typeof loaded === "object" && !Array.isArray(loaded), "INVALID_LEDGER", "ledger.load must return an object or null.");
  if (loaded.className !== undefined) {
    invariant(canonicalId(loaded.className) === className, "LEDGER_SCOPE_MISMATCH", "Ledger className does not match this batch.", { expected: className, actual: loaded.className });
  }
  if (loaded.repositoryUrl !== undefined) {
    invariant(repositoryIdentity(loaded.repositoryUrl) === repositoryIdentity(repositoryUrl), "LEDGER_SCOPE_MISMATCH", "Ledger repositoryUrl does not match this batch.", { expected: repositoryUrl, actual: loaded.repositoryUrl });
  }
  return {
    version: 1,
    className,
    repositoryUrl,
    teams: loaded.teams && typeof loaded.teams === "object" ? clone(loaded.teams) : {},
    accounts: loaded.accounts && typeof loaded.accounts === "object" ? clone(loaded.accounts) : {},
  };
}

function makeLedgerCommitter(ledger, state) {
  let pending = Promise.resolve();
  return async (mutate) => {
    pending = pending.then(async () => {
      mutate(state);
      await ledger.save(clone(state));
    });
    return pending;
  };
}

function teamContext(base, team, profileId) {
  return {
    className: base.className,
    repositoryUrl: base.repositoryUrl,
    profileId,
    team: { id: team.id, name: team.name },
  };
}

function isComplete(status) {
  return status === "complete" || status === "completed";
}

export function createBatchOrchestrator(rawOptions) {
  const options = validateOptions(rawOptions);

  const run = async () => {
    const isolationVerified = await options.portal.verifyIsolatedProfiles({
      profileIds: options.profileIds,
      className: options.className,
    });
    invariant(
      isolationVerified === true,
      "PROFILE_ISOLATION_UNVERIFIED",
      "Portal adapter could not prove that every profile has a distinct authentication context.",
    );
    const roster = await options.portal.getRoster({ className: options.className });
    const plan = groupTraineesByTeam(roster);
    invariant(plan.teams.length === 0 || options.profileIds.length > 0, "NO_ISOLATED_PROFILES", "At least one isolated profile is required when trainee teams exist.");

    const loaded = await options.ledger.load({
      className: options.className,
      repositoryUrl: options.repositoryUrl,
    });
    const ledgerState = validateLoadedLedger(loaded, options.className, options.repositoryUrl);
    if (loaded) {
      const plannedTeams = new Set(plan.teams.map((team) => team.id));
      const plannedAccounts = new Set(plan.teams.flatMap((team) => team.accounts.map((account) => account.accountId)));
      const storedTeams = new Set(Object.keys(ledgerState.teams));
      const storedAccounts = new Set(Object.keys(ledgerState.accounts));
      const sameSet = (left, right) => left.size === right.size && [...left].every((value) => right.has(value));
      invariant(sameSet(plannedTeams, storedTeams), "ROSTER_CHANGED", "Team set differs from the stored run ledger; reconcile the visible roster explicitly.", {
        planned: [...plannedTeams],
        stored: [...storedTeams],
      });
      invariant(sameSet(plannedAccounts, storedAccounts), "ROSTER_CHANGED", "Account set differs from the stored run ledger; reconcile the visible roster explicitly.", {
        planned: [...plannedAccounts],
        stored: [...storedAccounts],
      });
    }
    const commit = makeLedgerCommitter(options.ledger, ledgerState);

    await commit((state) => {
      for (const team of plan.teams) {
        const priorTeam = state.teams[team.id];
        invariant(!priorTeam || !priorTeam.name || canonicalId(priorTeam.name) === team.name, "DUPLICATE_TEAM", "Ledger team identity conflicts with the roster.", { teamId: team.id });
        state.teams[team.id] = {
          name: team.name,
          submission: priorTeam?.submission ?? "pending",
          status: priorTeam?.status ?? "pending",
          note: priorTeam?.note ?? "",
        };
        for (const account of team.accounts) {
          const priorAccount = state.accounts[account.accountId];
          invariant(!priorAccount || !priorAccount.teamId || canonicalId(priorAccount.teamId) === team.id, "DUPLICATE_ACCOUNT", "Ledger account is assigned to a different team.", { accountId: account.accountId, teamId: team.id });
          state.accounts[account.accountId] = {
            teamId: team.id,
            status: priorAccount?.status ?? "pending",
            note: priorAccount?.note ?? "",
          };
        }
      }
    });

    const actualConcurrency = Math.min(
      options.requestedConcurrency,
      plan.teams.length,
      new Set(options.profileIds).size,
    );
    const results = new Array(plan.teams.length);
    let nextTeamIndex = 0;

    const processTeam = async (team, profileId) => {
      const context = teamContext(options, team, profileId);
      const accountResults = [];
      let submission = ledgerState.teams[team.id].submission;

      if (submission === "submitting") {
        throw new BatchOrchestratorError(
          "AMBIGUOUS_TEAM_SUBMISSION",
          "A prior write-ahead submission has no confirmation; refusing a blind repository resubmit.",
          { teamId: team.id },
        );
      }
      if (submission === "failed") {
        throw new BatchOrchestratorError("TEAM_PREVIOUSLY_FAILED", "Team is failed in the ledger and requires explicit reconciliation.", { teamId: team.id });
      }
      if (submission === "blocked") {
        throw new BatchOrchestratorError("TEAM_PREVIOUSLY_BLOCKED", "Team is blocked in the ledger and requires explicit reconciliation.", { teamId: team.id });
      }

      if (!["submitted_unverified", "submitted", "analyzing", "ready", "complete"].includes(submission)) {
        await commit((state) => {
          state.teams[team.id].status = "running";
          state.teams[team.id].submission = "submitting";
        });
        await options.portal.submitRepositoryOnce({
          ...context,
          representative: team.accounts[0],
        });
        await commit((state) => {
          state.teams[team.id].submission = "submitted_unverified";
        });
        submission = "submitted_unverified";
      }

      if (submission === "submitted_unverified") {
        invariant(team.accounts.length >= 2, "TEAM_CONFIRMATION_UNAVAILABLE", "A second trainee is required to confirm the team-scoped submission.", { teamId: team.id });
        await options.portal.confirmTeamSubmission({
          ...context,
          representative: team.accounts[0],
          verifier: team.accounts[1],
        });
        await commit((state) => {
          state.teams[team.id].submission = "submitted";
        });
        submission = "submitted";
      }

      if (!["ready", "complete"].includes(submission)) {
        await commit((state) => {
          state.teams[team.id].submission = "analyzing";
        });
        await options.portal.waitAnalysisReady({
          ...context,
          representative: team.accounts[0],
        });
        await commit((state) => {
          state.teams[team.id].submission = "ready";
        });
        submission = "ready";
      }

      for (const account of team.accounts) {
        const priorStatus = ledgerState.accounts[account.accountId].status;
        if (isComplete(priorStatus)) {
          accountResults.push({ accountId: account.accountId, status: "complete", resumed: true, skipped: true });
          continue;
        }
        if (["failed", "blocked"].includes(priorStatus)) {
          const failure = errorRecord(new BatchOrchestratorError(
            "ACCOUNT_RECONCILIATION_REQUIRED",
            "Account has a failed or blocked prior state; explicit reconciliation is required before another browser action.",
            { accountId: account.accountId, priorStatus },
          ), { scope: "account", teamId: team.id, accountId: account.accountId });
          accountResults.push({ accountId: account.accountId, status: "blocked", resumed: true, skipped: true, error: failure });
          break;
        }
        await commit((state) => {
          state.accounts[account.accountId].status = "running";
          state.accounts[account.accountId].note = "";
        });
        try {
          const checkpointContext = options.ledger.accountCheckpointContext?.({ accountId: account.accountId, teamId: team.id }) ?? null;
          const result = await options.portal.runAccount({
            ...context,
            account,
            checkpoints: checkpointContext?.checkpoints,
            resume: checkpointContext?.resume,
          });
          if (options.requireAccountCheckpoints) {
            invariant(
              result?.status === "complete" || result?.reconciledCompletion === true,
              "ACCOUNT_NOT_COMPLETE",
              "Live account runner returned without an explicit complete result.",
              { accountId: account.accountId },
            );
            invariant(
              checkpointContext.hasConfirmedCompletion() === true || result?.reconciledCompletion === true,
              "ACCOUNT_COMPLETION_UNCONFIRMED",
              "Live account runner returned without a confirmed completion checkpoint or explicit visible-completion reconciliation.",
              { accountId: account.accountId },
            );
          }
          await commit((state) => {
            state.accounts[account.accountId].status = "complete";
          });
          accountResults.push({ accountId: account.accountId, status: "complete", resumed: priorStatus !== "pending", skipped: false, result: result ?? null });
        } catch (error) {
          const failure = errorRecord(error, { scope: "account", teamId: team.id, accountId: account.accountId });
          failure.quarantineProfile = shouldQuarantineProfile(error);
          await commit((state) => {
            state.accounts[account.accountId].status = "failed";
            state.accounts[account.accountId].note = failure.message;
          });
          accountResults.push({ accountId: account.accountId, status: "failed", resumed: priorStatus !== "pending", skipped: false, error: failure });
          break;
        }
      }

      const failed = accountResults.some((account) => account.status === "failed" || account.status === "blocked");
      await commit((state) => {
        state.teams[team.id].status = failed ? "failed" : "complete";
      });
      return {
        teamId: team.id,
        teamName: team.name,
        profileId,
        status: failed ? "failed" : "complete",
        submission,
        accounts: accountResults,
        quarantineProfile: accountResults.some((account) => account.error?.quarantineProfile === true),
      };
    };

    const worker = async (profileId) => {
      while (true) {
        const teamIndex = nextTeamIndex;
        nextTeamIndex += 1;
        if (teamIndex >= plan.teams.length) return;
        const team = plan.teams[teamIndex];
        try {
          results[teamIndex] = await processTeam(team, profileId);
          if (results[teamIndex].quarantineProfile) return;
        } catch (error) {
          const failure = errorRecord(error, { scope: "team", teamId: team.id });
          failure.quarantineProfile = shouldQuarantineProfile(error);
          await commit((state) => {
            state.teams[team.id].status = "failed";
            state.teams[team.id].note = failure.message;
            if (failure.code === "TEAM_CONFIRMATION_UNAVAILABLE") {
              state.teams[team.id].submission = "blocked";
            }
            // Preserve a write-ahead-only submission as ambiguous. A retry may
            // duplicate a repository submission that actually reached the UI.
          });
          results[teamIndex] = {
            teamId: team.id,
            teamName: team.name,
            profileId,
            status: "failed",
            submission: ledgerState.teams[team.id].submission,
            accounts: [],
            error: failure,
            quarantineProfile: failure.quarantineProfile,
          };
          if (failure.quarantineProfile) return;
        }
      }
    };

    await Promise.all(options.profileIds.slice(0, actualConcurrency).map(worker));

    for (let teamIndex = 0; teamIndex < plan.teams.length; teamIndex += 1) {
      if (results[teamIndex]) continue;
      const team = plan.teams[teamIndex];
      results[teamIndex] = {
        teamId: team.id,
        teamName: team.name,
        profileId: null,
        status: "pending",
        submission: ledgerState.teams[team.id].submission,
        accounts: [],
        error: {
          scope: "team",
          teamId: team.id,
          code: "NO_SAFE_PROFILE_AVAILABLE",
          name: "BatchOrchestratorError",
          message: "No non-quarantined isolated profile remained for this team.",
        },
      };
    }

    const accounts = results.flatMap((team) => team.accounts);
    const failures = results.flatMap((team) => [
      ...(team.error ? [team.error] : []),
      ...team.accounts.flatMap((account) => account.error ? [account.error] : []),
    ]);
    const totals = {
      roster: plan.rosterCount,
      trainees: plan.traineeCount,
      excluded: plan.excludedCount,
      teams: plan.teams.length,
      teamsComplete: results.filter((team) => team.status === "complete").length,
      teamsFailed: results.filter((team) => team.status === "failed").length,
      teamsPending: results.filter((team) => team.status === "pending").length,
      accountsComplete: accounts.filter((account) => account.status === "complete").length,
      accountsSkipped: accounts.filter((account) => account.skipped).length,
      accountsFailed: accounts.filter((account) => account.status === "failed").length,
      accountsBlocked: accounts.filter((account) => account.status === "blocked").length,
      accountsPending: plan.traineeCount
        - accounts.filter((account) => account.status === "complete").length
        - accounts.filter((account) => account.status === "failed").length
        - accounts.filter((account) => account.status === "blocked").length,
    };
    return {
      status: failures.length === 0 ? "complete" : totals.accountsComplete > 0 ? "partial" : "failed",
      className: options.className,
      repositoryUrl: options.repositoryUrl,
      requestedConcurrency: options.requestedConcurrency,
      actualConcurrency,
      profileIds: options.profileIds.slice(0, actualConcurrency),
      totals,
      teams: results,
      failures,
      ledger: clone(ledgerState),
    };
  };

  return Object.freeze({ run });
}

export async function runBatch(options) {
  return createBatchOrchestrator(options).run();
}
