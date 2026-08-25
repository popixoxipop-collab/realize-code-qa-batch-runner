import assert from "node:assert/strict";
import test from "node:test";

import {
  BatchOrchestratorError,
  createBatchOrchestrator,
  groupTraineesByTeam,
} from "../src/batch_orchestrator.mjs";

function account(accountId, teamId, role = "교육생", teamName = teamId) {
  return { accountId, displayName: accountId, teamId, teamName, role };
}

function memoryLedger(initial = null) {
  let state = initial;
  const saves = [];
  return {
    saves,
    async load() {
      return state == null ? null : structuredClone(state);
    },
    async save(next) {
      state = structuredClone(next);
      saves.push(structuredClone(next));
    },
    current() {
      return structuredClone(state);
    },
  };
}

test("filters trainees, runs isolated team lanes in parallel, and keeps each team sequential", async () => {
  const roster = [
    account("manager", "management", "매니저"),
    account("a1", "team-a"),
    account("a2", "team-a"),
    account("b1", "team-b"),
    account("b2", "team-b"),
    account("c1", "team-c"),
    account("c2", "team-c"),
  ];
  const activeTeams = new Set();
  const activeAccountsByTeam = new Set();
  let peakTeams = 0;
  const events = [];
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  const portal = {
    async verifyIsolatedProfiles() { return true; },
    async getRoster({ className }) {
      assert.equal(className, "F반");
      return roster;
    },
    async submitRepositoryOnce({ team, profileId, representative }) {
      assert.equal(representative.teamId, team.id);
      activeTeams.add(team.id);
      peakTeams = Math.max(peakTeams, activeTeams.size);
      events.push(`submit:${team.id}:${profileId}`);
      await pause();
    },
    async confirmTeamSubmission({ team, verifier }) {
      assert.notEqual(verifier.accountId, team.accounts?.[0]?.accountId);
      events.push(`confirm:${team.id}`);
    },
    async waitAnalysisReady({ team }) {
      events.push(`ready:${team.id}`);
      await pause();
    },
    async runAccount({ team, account: current }) {
      assert.equal(activeAccountsByTeam.has(team.id), false, "accounts in one team must never overlap");
      activeAccountsByTeam.add(team.id);
      events.push(`start:${team.id}:${current.accountId}`);
      await pause();
      events.push(`end:${team.id}:${current.accountId}`);
      activeAccountsByTeam.delete(team.id);
      if (current.accountId.endsWith("2")) activeTeams.delete(team.id);
      return { status: "complete" };
    },
  };
  const ledger = memoryLedger();
  const summary = await createBatchOrchestrator({
    className: "F반",
    repositoryUrl: "https://github.com/Team-IZ/Backend",
    requestedConcurrency: 9,
    profileIds: ["profile-1", "profile-2"],
    portal,
    ledger,
  }).run();

  assert.equal(summary.status, "complete");
  assert.equal(summary.actualConcurrency, 2);
  assert.equal(summary.totals.trainees, 6);
  assert.equal(summary.totals.excluded, 1);
  assert.equal(summary.totals.teams, 3);
  assert.equal(summary.totals.accountsComplete, 6);
  assert.equal(peakTeams, 2);
  for (const teamId of ["team-a", "team-b", "team-c"]) {
    const firstEnd = events.indexOf(`end:${teamId}:${teamId.at(-1)}1`);
    const secondStart = events.indexOf(`start:${teamId}:${teamId.at(-1)}2`);
    assert.ok(firstEnd < secondStart, `${teamId} accounts should be sequential`);
    assert.equal(events.filter((event) => event.startsWith(`submit:${teamId}:`)).length, 1);
    assert.equal(events.filter((event) => event === `confirm:${teamId}`).length, 1);
  }
  assert.ok(ledger.saves.length > 0);
});

test("resume skips ready team submission/analysis and completed accounts", async () => {
  const calls = [];
  const ledger = memoryLedger({
    version: 1,
    className: "F반",
    repositoryUrl: "https://github.com/Team-IZ/Backend",
    teams: { "team-a": { name: "team-a", submission: "ready", status: "running", note: "" } },
    accounts: {
      a1: { teamId: "team-a", status: "complete", note: "" },
      a2: { teamId: "team-a", status: "pending", note: "" },
    },
  });
  const portal = {
    async verifyIsolatedProfiles() { return true; },
    async getRoster() { return [account("a1", "team-a"), account("a2", "team-a")]; },
    async submitRepositoryOnce() { calls.push("submit"); },
    async confirmTeamSubmission() { calls.push("confirm"); },
    async waitAnalysisReady() { calls.push("wait"); },
    async runAccount({ account: current }) { calls.push(`run:${current.accountId}`); },
  };
  const summary = await createBatchOrchestrator({
    className: "F반",
    repositoryUrl: "https://github.com/Team-IZ/Backend",
    requestedConcurrency: 1,
    profileIds: ["profile-1"],
    portal,
    ledger,
  }).run();

  assert.deepEqual(calls, ["run:a2"]);
  assert.equal(summary.totals.accountsComplete, 2);
  assert.equal(summary.totals.accountsSkipped, 1);
  assert.equal(summary.teams[0].accounts[0].resumed, true);
  assert.equal(ledger.current().accounts.a2.status, "complete");
});

test("resume passes an active account back to the driver with visible-state reconciliation", async () => {
  const calls = [];
  const ledger = memoryLedger({
    version: 1,
    className: "F반",
    repositoryUrl: "https://github.com/team-iz/backend",
    teams: { "team-a": { name: "team-a", submission: "ready", status: "running", note: "" } },
    accounts: {
      a1: { teamId: "team-a", status: "running", note: "" },
      a2: { teamId: "team-a", status: "pending", note: "" },
    },
  });
  const portal = {
    async verifyIsolatedProfiles() { return true; },
    async getRoster() { return [account("a1", "team-a"), account("a2", "team-a")]; },
    async submitRepositoryOnce() { calls.push("submit"); },
    async confirmTeamSubmission() { calls.push("confirm"); },
    async waitAnalysisReady() { calls.push("wait"); },
    async runAccount({ account: current }) { calls.push(`run:${current.accountId}`); return { status: "complete" }; },
  };
  const summary = await createBatchOrchestrator({
    className: "F반",
    repositoryUrl: "https://github.com/Team-IZ/Backend",
    requestedConcurrency: 1,
    profileIds: ["profile-1"],
    portal,
    ledger,
  }).run();

  assert.deepEqual(calls, ["run:a1", "run:a2"]);
  assert.equal(summary.status, "complete");
  assert.equal(summary.teams[0].accounts[0].resumed, true);
});

test("adapter failures are isolated into a structured partial summary", async () => {
  const portal = {
    async verifyIsolatedProfiles() { return true; },
    async getRoster() { return [account("a1", "team-a"), account("a2", "team-a")]; },
    async submitRepositoryOnce() {},
    async confirmTeamSubmission() {},
    async waitAnalysisReady() {},
    async runAccount({ account: current }) {
      if (current.accountId === "a2") throw Object.assign(new Error("visible completion missing"), { code: "NOT_COMPLETE" });
    },
  };
  const summary = await createBatchOrchestrator({
    className: "F반",
    repositoryUrl: "https://github.com/Team-IZ/Backend",
    requestedConcurrency: 1,
    profileIds: ["profile-1"],
    portal,
    ledger: memoryLedger(),
  }).run();

  assert.equal(summary.status, "partial");
  assert.equal(summary.totals.accountsComplete, 1);
  assert.equal(summary.totals.accountsFailed, 1);
  assert.deepEqual(summary.failures.map(({ code, accountId }) => ({ code, accountId })), [
    { code: "NOT_COMPLETE", accountId: "a2" },
  ]);
});

test("an account failure stops the rest of that team lane", async () => {
  const calls = [];
  const portal = {
    async verifyIsolatedProfiles() { return true; },
    async getRoster() { return [account("a1", "team-a"), account("a2", "team-a")]; },
    async submitRepositoryOnce() {},
    async confirmTeamSubmission() {},
    async waitAnalysisReady() {},
    async runAccount({ account: current }) {
      calls.push(current.accountId);
      throw Object.assign(new Error("visible account mismatch"), { code: "ACCOUNT_MISMATCH" });
    },
  };
  const summary = await createBatchOrchestrator({
    className: "F반",
    repositoryUrl: "https://github.com/Team-IZ/Backend",
    requestedConcurrency: 1,
    profileIds: ["profile-1"],
    portal,
    ledger: memoryLedger(),
  }).run();

  assert.deepEqual(calls, ["a1"]);
  assert.equal(summary.teams[0].accounts.length, 1);
  assert.equal(summary.totals.accountsPending, 1);
  assert.equal(summary.failures[0].code, "ACCOUNT_MISMATCH");
});

test("an account mismatch quarantines its profile before the next team", async () => {
  const calls = [];
  const portal = {
    async verifyIsolatedProfiles() { return true; },
    async getRoster() {
      return [
        account("a1", "team-a"),
        account("a2", "team-a"),
        account("b1", "team-b"),
        account("b2", "team-b"),
      ];
    },
    async submitRepositoryOnce({ team }) { calls.push(`submit:${team.id}`); },
    async confirmTeamSubmission({ team }) { calls.push(`confirm:${team.id}`); },
    async waitAnalysisReady({ team }) { calls.push(`wait:${team.id}`); },
    async runAccount({ team, account: current }) {
      calls.push(`run:${team.id}:${current.accountId}`);
      throw Object.assign(new Error("visible account mismatch"), { code: "ACCOUNT_MISMATCH" });
    },
  };
  const summary = await createBatchOrchestrator({
    className: "F반",
    repositoryUrl: "https://github.com/Team-IZ/Backend",
    requestedConcurrency: 1,
    profileIds: ["profile-1"],
    portal,
    ledger: memoryLedger(),
  }).run();

  assert.deepEqual(calls, ["submit:team-a", "confirm:team-a", "wait:team-a", "run:team-a:a1"]);
  assert.equal(summary.teams[0].quarantineProfile, true);
  assert.equal(summary.teams[1].status, "pending");
  assert.equal(summary.teams[1].error.code, "NO_SAFE_PROFILE_AVAILABLE");
  assert.equal(summary.totals.teamsPending, 1);
});

test("an interrupted repository submission remains ambiguous on resume", async () => {
  const ledger = memoryLedger();
  const portal = {
    async verifyIsolatedProfiles() { return true; },
    async getRoster() { return [account("a1", "team-a")]; },
    async submitRepositoryOnce() { throw new Error("connection closed after click"); },
    async confirmTeamSubmission() {},
    async waitAnalysisReady() {},
    async runAccount() {},
  };
  const options = {
    className: "F반",
    repositoryUrl: "https://github.com/Team-IZ/Backend",
    requestedConcurrency: 1,
    profileIds: ["profile-1"],
    portal,
    ledger,
  };
  const first = await createBatchOrchestrator(options).run();
  assert.equal(first.ledger.teams["team-a"].submission, "submitting");

  const second = await createBatchOrchestrator(options).run();
  assert.equal(second.failures[0].code, "AMBIGUOUS_TEAM_SUBMISSION");
  assert.equal(second.ledger.teams["team-a"].submission, "submitting");
});

test("blocked team and account states require reconciliation instead of replay", async () => {
  const calls = [];
  const portal = {
    async verifyIsolatedProfiles() { return true; },
    async getRoster() { return [account("a1", "team-a"), account("a2", "team-a")]; },
    async submitRepositoryOnce() { calls.push("submit"); },
    async confirmTeamSubmission() { calls.push("confirm"); },
    async waitAnalysisReady() { calls.push("wait"); },
    async runAccount({ account: current }) { calls.push(`run:${current.accountId}`); },
  };
  const blockedTeam = memoryLedger({
    version: 1,
    className: "F반",
    repositoryUrl: "https://github.com/team-iz/backend",
    teams: { "team-a": { name: "team-a", submission: "blocked", status: "failed", note: "manual review" } },
    accounts: {
      a1: { teamId: "team-a", status: "pending", note: "" },
      a2: { teamId: "team-a", status: "pending", note: "" },
    },
  });
  const teamResult = await createBatchOrchestrator({
    className: "F반",
    repositoryUrl: "https://github.com/Team-IZ/Backend",
    requestedConcurrency: 1,
    profileIds: ["profile-1"],
    portal,
    ledger: blockedTeam,
  }).run();
  assert.equal(teamResult.failures[0].code, "TEAM_PREVIOUSLY_BLOCKED");
  assert.deepEqual(calls, []);

  const blockedAccount = memoryLedger({
    version: 1,
    className: "F반",
    repositoryUrl: "https://github.com/team-iz/backend",
    teams: { "team-a": { name: "team-a", submission: "ready", status: "running", note: "" } },
    accounts: {
      a1: { teamId: "team-a", status: "blocked", note: "manual review" },
      a2: { teamId: "team-a", status: "pending", note: "" },
    },
  });
  const accountResult = await createBatchOrchestrator({
    className: "F반",
    repositoryUrl: "https://github.com/Team-IZ/Backend",
    requestedConcurrency: 1,
    profileIds: ["profile-1"],
    portal,
    ledger: blockedAccount,
  }).run();
  assert.equal(accountResult.failures[0].code, "ACCOUNT_RECONCILIATION_REQUIRED");
  assert.equal(accountResult.totals.accountsBlocked, 1);
  assert.deepEqual(calls, []);
});

test("resume fails closed when the visible roster loses an account", async () => {
  const ledger = memoryLedger({
    version: 1,
    className: "F반",
    repositoryUrl: "https://github.com/team-iz/backend",
    teams: { "team-a": { name: "team-a", submission: "ready", status: "running", note: "" } },
    accounts: {
      a1: { teamId: "team-a", status: "complete", note: "" },
      a2: { teamId: "team-a", status: "pending", note: "" },
    },
  });
  const portal = {
    async verifyIsolatedProfiles() { return true; },
    async getRoster() { return [account("a1", "team-a")]; },
    async submitRepositoryOnce() {},
    async confirmTeamSubmission() {},
    async waitAnalysisReady() {},
    async runAccount() {},
  };
  await assert.rejects(createBatchOrchestrator({
    className: "F반",
    repositoryUrl: "https://github.com/Team-IZ/Backend",
    requestedConcurrency: 1,
    profileIds: ["profile-1"],
    portal,
    ledger,
  }).run(), (error) => error.code === "ROSTER_CHANGED");
});

test("repository URL must be a plain HTTPS GitHub repository", () => {
  const portal = {
    async verifyIsolatedProfiles() { return true; },
    async getRoster() { return []; },
    async submitRepositoryOnce() {},
    async confirmTeamSubmission() {},
    async waitAnalysisReady() {},
    async runAccount() {},
  };
  for (const repositoryUrl of [
    "http://github.com/owner/repo",
    "https://gitlab.com/owner/repo",
    "https://github.com/owner/repo/tree/main",
    "https://user@github.com/owner/repo",
    "https://github.com/owner/repo?branch=main",
  ]) {
    assert.throws(
      () => createBatchOrchestrator({
        className: "F반",
        repositoryUrl,
        requestedConcurrency: 1,
        profileIds: ["profile-1"],
        portal,
        ledger: memoryLedger(),
      }),
      (error) => error instanceof BatchOrchestratorError && error.code === "INVALID_REPOSITORY",
    );
  }
});

test("orchestrator refuses unverified profile isolation before reading the roster", async () => {
  let rosterRead = false;
  const portal = {
    async verifyIsolatedProfiles() { return false; },
    async getRoster() { rosterRead = true; return []; },
    async submitRepositoryOnce() {},
    async confirmTeamSubmission() {},
    async waitAnalysisReady() {},
    async runAccount() {},
  };
  await assert.rejects(createBatchOrchestrator({
    className: "F반",
    repositoryUrl: "https://github.com/Team-IZ/Backend",
    requestedConcurrency: 1,
    profileIds: ["profile-1"],
    portal,
    ledger: memoryLedger(),
  }).run(), (error) => error.code === "PROFILE_ISOLATION_UNVERIFIED");
  assert.equal(rosterRead, false);
});

test("live roster rejects unknown roles and sensitive account identifiers", async () => {
  const basePortal = {
    async verifyIsolatedProfiles() { return true; },
    async submitRepositoryOnce() {},
    async confirmTeamSubmission() {},
    async waitAnalysisReady() {},
    async runAccount() {},
  };
  for (const invalid of [
    { accountId: "a1", displayName: "교육생", teamId: "team-a", teamName: "team-a", role: "operator" },
    { accountId: "student@example.com", displayName: "교육생", teamId: "team-a", teamName: "team-a", role: "교육생" },
    { accountId: "교육생 이름", displayName: "교육생", teamId: "team-a", teamName: "team-a", role: "교육생" },
  ]) {
    const portal = { ...basePortal, async getRoster() { return [invalid]; } };
    await assert.rejects(createBatchOrchestrator({
      className: "F반",
      repositoryUrl: "https://github.com/Team-IZ/Backend",
      requestedConcurrency: 1,
      profileIds: ["profile-1"],
      portal,
      ledger: memoryLedger(),
    }).run(), (error) => ["UNSUPPORTED_ROSTER_ROLE", "SENSITIVE_ACCOUNT_ID"].includes(error.code));
  }
});

test("fails closed on duplicate profiles, accounts, and conflicting teams", async (t) => {
  const noopPortal = {
    async verifyIsolatedProfiles() { return true; },
    async getRoster() { return []; },
    async submitRepositoryOnce() {},
    async confirmTeamSubmission() {},
    async waitAnalysisReady() {},
    async runAccount() {},
  };
  const base = {
    className: "F반",
    repositoryUrl: "https://github.com/Team-IZ/Backend",
    requestedConcurrency: 2,
    portal: noopPortal,
    ledger: memoryLedger(),
  };

  await t.test("duplicate profiles", () => {
    assert.throws(
      () => createBatchOrchestrator({ ...base, profileIds: ["profile-1", " profile-1 "] }),
      (error) => error instanceof BatchOrchestratorError && error.code === "DUPLICATE_PROFILE",
    );
  });
  await t.test("duplicate accounts", () => {
    assert.throws(
      () => groupTraineesByTeam([account("a1", "team-a"), account(" a1 ", "team-a")]),
      (error) => error instanceof BatchOrchestratorError && error.code === "DUPLICATE_ACCOUNT",
    );
  });
  await t.test("conflicting duplicate teams", () => {
    assert.throws(
      () => groupTraineesByTeam([account("a1", "team-a", "교육생", "Alpha"), account("b1", "team-b", "교육생", "Alpha")]),
      (error) => error instanceof BatchOrchestratorError && error.code === "DUPLICATE_TEAM",
    );
  });
});
