import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBatchLedgerAdapter } from "../src/batch_ledger_adapter.mjs";

test("batch ledger adapter creates and resumes orchestrator state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realize-batch-ledger-adapter-"));
  try {
    const path = join(directory, "run.json");
    const run = { className: "F반", repositoryUrl: "https://github.com/Team-IZ/Backend" };
    const first = createBatchLedgerAdapter(path, { round: "round-5" });
    assert.equal(await first.load(run), null);
    await first.save({
      version: 1,
      ...run,
      teams: { "1팀": { name: "1팀", submission: "ready", status: "running", note: "" } },
      accounts: { trainee1: { teamId: "1팀", status: "complete", note: "" } },
    });

    const resumed = createBatchLedgerAdapter(path, { round: "round-5" });
    const state = await resumed.load(run);
    assert.equal(state.teams["1팀"].submission, "ready");
    assert.equal(state.accounts.trainee1.status, "complete");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("batch ledger adapter refuses a different round anchor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realize-batch-ledger-adapter-"));
  try {
    const path = join(directory, "run.json");
    const run = { className: "F반", repositoryUrl: "https://github.com/Team-IZ/Backend" };
    const first = createBatchLedgerAdapter(path, { round: "round-5" });
    await first.load(run);
    await first.save({ version: 1, ...run, teams: {}, accounts: {} });
    const wrongRound = createBatchLedgerAdapter(path, { round: "round-6" });
    await assert.rejects(wrongRound.load(run), (error) => error.code === "RUN_ANCHOR_MISMATCH");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("account checkpoint context persists answer intent and resume sets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realize-batch-ledger-adapter-"));
  try {
    const path = join(directory, "run.json");
    const run = { className: "F반", repositoryUrl: "https://github.com/Team-IZ/Backend" };
    const adapter = createBatchLedgerAdapter(path, { round: "round-5" });
    await adapter.load(run);
    await adapter.save({
      version: 1,
      ...run,
      teams: { "1팀": { name: "1팀", submission: "ready", status: "running", note: "" } },
      accounts: { trainee1: { teamId: "1팀", status: "running", note: "" } },
    });
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const attemptKey = `${fingerprint}:0`;
    const context = adapter.accountCheckpointContext({ accountId: "trainee1", teamId: "1팀" });
    await context.checkpoints.writeAhead({
      phase: "intent",
      action: "answer_submit",
      sequence: 1,
      fingerprint,
      attempt: 0,
      attemptKey,
    });
    assert.equal(context.activityCount(), 1);

    const resumedAdapter = createBatchLedgerAdapter(path, { round: "round-5" });
    await resumedAdapter.load(run);
    const resumed = resumedAdapter.accountCheckpointContext({ accountId: "trainee1", teamId: "1팀" });
    assert.deepEqual(resumed.resume.attempted, [attemptKey]);
    assert.deepEqual(resumed.resume.confirmed, []);
    await resumed.checkpoints.confirmed({
      phase: "confirmed",
      action: "answer_submit",
      sequence: 2,
      fingerprint,
      attempt: 0,
      attemptKey,
      visibleState: "completion",
    });
    const snapshot = resumedAdapter.snapshot();
    assert.equal(snapshot.accounts.trainee1.session, "complete");
    assert.equal(snapshot.journal.length, 2);
    assert.equal(resumed.hasConfirmedCompletion(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint activity and completion are scoped to the current account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realize-batch-ledger-adapter-"));
  try {
    const path = join(directory, "run.json");
    const run = { className: "F반", repositoryUrl: "https://github.com/Team-IZ/Backend" };
    const adapter = createBatchLedgerAdapter(path, { round: "round-5" });
    await adapter.load(run);
    await adapter.save({
      version: 1,
      ...run,
      teams: { "1팀": { name: "1팀", submission: "ready", status: "running", note: "" } },
      accounts: {
        trainee1: { teamId: "1팀", status: "running", note: "" },
        trainee2: { teamId: "1팀", status: "running", note: "" },
      },
    });
    const first = adapter.accountCheckpointContext({ accountId: "trainee1", teamId: "1팀" });
    const second = adapter.accountCheckpointContext({ accountId: "trainee2", teamId: "1팀" });
    const fingerprint = `sha256:${"b".repeat(64)}`;
    const attemptKey = `${fingerprint}:0`;
    await second.checkpoints.writeAhead({ action: "answer_submit", sequence: 1, fingerprint, attempt: 0, attemptKey });
    await second.checkpoints.confirmed({ action: "answer_submit", sequence: 2, fingerprint, attempt: 0, attemptKey, visibleState: "completion" });

    assert.equal(first.activityCount(), 0);
    assert.equal(first.hasConfirmedCompletion(), false);
    assert.equal(second.hasConfirmedCompletion(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
