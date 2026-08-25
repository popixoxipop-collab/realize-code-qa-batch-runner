import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  JsonLedger,
  LedgerError,
  assertNoCredentials,
  createJsonLedger,
  loadJsonLedger,
  openJsonLedger,
} from "../src/json_ledger.mjs";

const anchor = Object.freeze({
  class: "F반",
  round: "미니프로젝트 5차",
  repository: "Team-IZ/Backend",
});

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "realize-json-ledger-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertLedgerError(code) {
  return (error) => {
    assert.ok(error instanceof LedgerError);
    assert.equal(error.code, code);
    return true;
  };
}

test("create, update, load, and resume preserve team/account state", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "run.json");
    const ledger = await createJsonLedger(path, {
      anchor,
      teams: ["F반 1팀"],
      accounts: [{ name: "교육생 01", team: "F반 1팀" }],
    });

    await ledger.updateTeam("F반 1팀", {
      submission: "confirmed",
      analysis: "ready",
    });
    await ledger.updateAccount("교육생 01", {
      session: "active",
      phase: "editing",
      attempt: 1,
    });

    const loaded = await loadJsonLedger(path, {
      anchor: { ...anchor, repository: "https://github.com/team-iz/backend.git" },
    });
    const resumed = loaded.resume();
    assert.equal(resumed.document.run.repository, "team-iz/backend");
    assert.equal(resumed.document.teams["F반 1팀"].analysis, "ready");
    assert.equal(resumed.document.accounts["교육생 01"].session, "active");
    assert.deepEqual(resumed.pendingTeams, []);
    assert.deepEqual(resumed.pendingAccounts, ["교육생 01"]);
  });
});

test("load fails closed when class, round, or repository anchor differs", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "run.json");
    await JsonLedger.create(path, { anchor });

    for (const mismatch of [
      { ...anchor, class: "E반" },
      { ...anchor, round: "미니프로젝트 4차" },
      { ...anchor, repository: "KT-AIVLE-mini-proj04/KT-AIVLE-mini-proj05" },
    ]) {
      await assert.rejects(JsonLedger.load(path, { anchor: mismatch }), assertLedgerError("RUN_ANCHOR_MISMATCH"));
    }
  });
});

test("credential-shaped keys and values are rejected without persisting them", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "run.json");
    const ledger = await JsonLedger.create(path, {
      anchor,
      teams: ["F반 1팀"],
      accounts: [{ name: "교육생 02", team: "F반 1팀" }],
    });
    const before = await readFile(path, "utf8");

    assert.throws(
      () => assertNoCredentials({ nested: { password: "do-not-store" } }),
      assertLedgerError("CREDENTIAL_DATA_FORBIDDEN"),
    );
    for (const value of [
      { privateKey: "not-even-a-real-key" },
      { sessionCookie: "opaque" },
      { authorizationHeader: "opaque" },
      { note: ["sk", "proj", "abcdefghijklmnop"].join("-") },
      { note: ["-----BEGIN", "PRIVATE KEY-----"].join(" ") },
    ]) {
      assert.throws(() => assertNoCredentials(value), assertLedgerError("CREDENTIAL_DATA_FORBIDDEN"));
    }
    await assert.rejects(
      ledger.updateAccount("교육생 02", { note: ["Authorization:", "Bearer", "abcdefghijklmnopqrstuvwxyz"].join(" ") }),
      assertLedgerError("CREDENTIAL_DATA_FORBIDDEN"),
    );

    assert.equal(await readFile(path, "utf8"), before);
    assert.equal(ledger.snapshot().accounts["교육생 02"].note, "");
  });
});

test("write-ahead intent survives reload and confirmation resolves it exactly once", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "run.json");
    const ledger = await JsonLedger.create(path, {
      anchor,
      teams: ["F반 1팀"],
      accounts: [{ name: "교육생 01", team: "F반 1팀" }],
    });

    const intent = await ledger.appendWriteAhead({
      intentId: "answer:sha256-example:0",
      action: "answer_submit",
      target: { team: "F반 1팀", account: "교육생 01" },
      data: { attempt: 0, answerDigest: `sha256:${"a".repeat(64)}` },
    });
    assert.equal(intent.phase, "intent");

    const interrupted = await JsonLedger.load(path, { anchor });
    assert.deepEqual(interrupted.resume().unresolvedIntents.map((entry) => entry.intentId), [intent.intentId]);

    const confirmed = await interrupted.appendConfirmed({
      intentId: intent.intentId,
      data: { visibleState: "grading" },
    });
    assert.equal(confirmed.phase, "confirmed");
    assert.deepEqual(interrupted.resume().unresolvedIntents, []);
    await assert.rejects(
      interrupted.appendConfirmed({ intentId: intent.intentId }),
      assertLedgerError("INTENT_ALREADY_CONFIRMED"),
    );
  });
});

test("atomic writes leave a valid target and no temporary files", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "run.json");
    const ledger = await JsonLedger.create(path, {
      anchor,
      teams: ["F반 1팀"],
      accounts: [{ name: "교육생 01", team: "F반 1팀" }],
    });

    await Promise.all(Array.from({ length: 12 }, (_, attempt) => ledger.updateAccount("교육생 01", {
      attempt,
      note: `checkpoint ${attempt}`,
    })));

    const parsed = JSON.parse(await readFile(path, "utf8"));
    assert.equal(parsed.accounts["교육생 01"].attempt, 11);
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
  });
});

test("invalid states, broken confirmation order, and credential-bearing files fail closed", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "run.json");
    const ledger = await openJsonLedger(path, {
      anchor,
      teams: ["F반 1팀"],
      accounts: [{ name: "교육생 01", team: "F반 1팀" }],
    });

    await assert.rejects(
      ledger.updateTeam("F반 1팀", { submission: "done" }),
      assertLedgerError("INVALID_LEDGER_STATE"),
    );
    await assert.rejects(
      ledger.appendConfirmed({ intentId: "missing" }),
      assertLedgerError("INTENT_NOT_FOUND"),
    );

    const poisoned = ledger.snapshot();
    poisoned.accounts["교육생 01"].password = "plaintext";
    await writeFile(path, JSON.stringify(poisoned), "utf8");
    await assert.rejects(
      JsonLedger.load(path, { anchor }),
      assertLedgerError("CREDENTIAL_DATA_FORBIDDEN"),
    );
  });
});
