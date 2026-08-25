import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDryRunPlan,
  executeBatch,
  parseBatchArgs,
  resolveBatchConfig,
  selectClass,
} from "../src/batch_cli.mjs";

const roster = [
  { accountId: "manager", displayName: "관리자", className: "F반", teamId: "ops", teamName: "운영", role: "매니저" },
  { accountId: "a1", displayName: "교육생 01", className: "F반", teamId: "1팀", teamName: "1팀", role: "교육생" },
  { accountId: "a2", displayName: "교육생 02", className: "F반", teamId: "1팀", teamName: "1팀", role: "교육생" },
  { accountId: "b1", displayName: "교육생 03", className: "F반", teamId: "2팀", teamName: "2팀", role: "교육생" },
  { accountId: "b2", displayName: "교육생 04", className: "F반", teamId: "2팀", teamName: "2팀", role: "교육생" },
];

test("CLI arguments parse class, profiles, concurrency, and safety flags", () => {
  assert.deepEqual(parseBatchArgs(["--class", "F", "--profiles", "p1,p2", "--concurrency", "2", "--dry-run", "-y"]), {
    yes: true,
    dryRun: true,
    json: false,
    className: "F",
    profileIds: ["p1", "p2"],
    requestedConcurrency: 2,
  });
});

test("class selection normalizes a configured class or calls the chooser", async () => {
  assert.equal(await selectClass({ configuredClass: "f", choose: async () => "E반" }), "F반");
  assert.equal(await selectClass({ listClasses: async () => ["E", "F반"], choose: async (classes) => classes[1] }), "F반");
});

test("dry-run plan filters managers and caps concurrency by profiles and teams", () => {
  const plan = buildDryRunPlan(roster, {
    className: "F",
    repositoryUrl: "https://github.com/Team-IZ/Backend",
    round: "round-5",
    requestedConcurrency: 5,
    profileIds: ["p1"],
  });
  assert.equal(plan.totals.trainees, 4);
  assert.equal(plan.totals.excluded, 1);
  assert.equal(plan.totals.teams, 2);
  assert.equal(plan.actualConcurrency, 1);
});

test("JSON config allows a class-only dry run after one-time setup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realize-batch-cli-"));
  try {
    await writeFile(join(directory, "roster.json"), JSON.stringify(roster), "utf8");
    await writeFile(join(directory, "config.json"), JSON.stringify({
      roster: "./roster.json",
      round: "round-5",
      profiles: ["p1", "p2"],
      concurrency: 5,
    }), "utf8");
    const config = await resolveBatchConfig(["--config", join(directory, "config.json"), "--class", "F", "--dry-run"]);
    const result = await executeBatch(config, { chooseClass: async () => "F반" });
    assert.equal(result.mode, "dry-run");
    assert.equal(result.className, "F반");
    assert.equal(result.repositoryUrl, "https://github.com/Team-IZ/Backend");
    assert.equal(result.actualConcurrency, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live driver must expose a profile-isolation proof", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realize-batch-cli-driver-"));
  try {
    const driverPath = join(directory, "driver.mjs");
    await writeFile(driverPath, `export default async () => ({
      getRoster: async () => [],
      submitRepositoryOnce: async () => {},
      confirmTeamSubmission: async () => {},
      waitAnalysisReady: async () => {},
      runAccount: async () => {}
    });`, "utf8");
    const config = await resolveBatchConfig([
      "--driver", driverPath,
      "--class", "F",
      "--round", "round-5",
      "--profiles", "p1",
      "--yes",
    ]);
    await assert.rejects(
      executeBatch(config, { chooseClass: async () => "F반", confirm: async () => true }),
      (error) => error.code === "INVALID_DRIVER",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live execution refuses a roster file and requires the visible portal roster", async () => {
  const config = await resolveBatchConfig([
    "--roster", "examples/sample.roster.json",
    "--class", "F",
    "--round", "round-5",
    "--profiles", "p1",
  ], { cwd: process.cwd() });
  await assert.rejects(executeBatch(config), (error) => error.code === "ROSTER_FILE_LIVE_FORBIDDEN");
});

test("live CLI composes driver, team lanes, and strict resume ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realize-batch-cli-live-"));
  try {
    const driverPath = join(directory, "driver.mjs");
    const ledgerPath = join(directory, "run.json");
    await writeFile(driverPath, `export default async () => ({
      listClasses: async () => ["F반"],
      verifyIsolatedProfiles: async ({ profileIds }) => new Set(profileIds).size === profileIds.length,
      getRoster: async () => ${JSON.stringify(roster)},
      submitRepositoryOnce: async () => {},
      confirmTeamSubmission: async () => {},
      waitAnalysisReady: async () => {},
      runAccount: async ({ account, checkpoints }) => {
        const attemptKey = "sha256:" + "a".repeat(64) + ":0";
        await checkpoints.writeAhead({ phase: "intent", action: "answer_submit", sequence: 1, account: account.accountId, fingerprint: "sha256:" + "a".repeat(64), attempt: 0, attemptKey });
        await checkpoints.confirmed({ phase: "confirmed", action: "answer_submit", sequence: 2, account: account.accountId, fingerprint: "sha256:" + "a".repeat(64), attempt: 0, attemptKey, visibleState: "completion" });
        return { status: "complete" };
      }
    });`, "utf8");
    const config = await resolveBatchConfig([
      "--driver", driverPath,
      "--class", "F",
      "--round", "round-5",
      "--profiles", "p1,p2",
      "--ledger", ledgerPath,
      "--yes",
    ]);
    const result = await executeBatch(config, { chooseClass: async () => "F반", confirm: async () => true });
    assert.equal(result.status, "complete");
    assert.equal(result.actualConcurrency, 2);
    assert.equal(result.totals.accountsComplete, 4);
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.equal(ledger.run.repository, "team-iz/backend");
    assert.ok(Object.values(ledger.accounts).every((account) => account.session === "complete"));

    const resumed = await executeBatch(config, { chooseClass: async () => "F반", confirm: async () => true });
    assert.equal(resumed.status, "complete");
    assert.equal(resumed.totals.accountsSkipped, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
