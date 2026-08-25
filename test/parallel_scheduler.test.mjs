import assert from "node:assert/strict";
import test from "node:test";

import { parseParallelArgs } from "../bin/realize-playwright-parallel.mjs";
import { ExactAnswerMemo, groupAccountsByTeam, mapConcurrent, normalizeClassList, runTeamLanes, SerialAnswerBroker } from "../src/parallel_scheduler.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("parallel CLI requires explicit classes and live confirmation", () => {
  const preview = parseParallelArgs(["--classes", "a,b,f", "--class-concurrency", "2", "--team-concurrency", "5", "--dry-run"]);
  assert.deepEqual(preview.classes, ["A반", "B반", "F반"]);
  assert.equal(preview.classConcurrency, 2);
  assert.equal(preview.teamConcurrency, 5);
  assert.equal(preview.dryRun, true);
  assert.throws(() => parseParallelArgs(["--classes", "A,B"]), { code: "LIVE_CONFIRMATION_REQUIRED" });
  assert.throws(() => parseParallelArgs(["--classes", "A,A", "--dry-run"]), { code: "DUPLICATE_CLASS" });
});

test("autonomous CLI selects GMI, team preparation, and bounded tuning options", () => {
  const options = parseParallelArgs([
    "--autonomous",
    "--classes", "f",
    "--repo", "https://github.com/example/project",
    "--llm-concurrency", "12",
    "--analysis-timeout-minutes", "90",
    "--dry-run",
  ]);
  assert.equal(options.answerProvider, "gmi");
  assert.equal(options.prepareRepository, true);
  assert.equal(options.repositoryUrl, "https://github.com/example/project");
  assert.equal(options.llmConcurrency, 12);
  assert.equal(options.analysisTimeoutMs, 90 * 60_000);
});

test("autonomous CLI assigns every selected class to exactly one QA scenario", () => {
  const options = parseParallelArgs([
    "--autonomous",
    "--classes", "D,F,H,C,I,J,E,G",
    "--scenario", "excellent:D,F",
    "--scenario", "moderate:H,C",
    "--scenario", "struggling:I,J",
    "--scenario", "inactive:E,G",
    "--dry-run",
  ]);
  assert.deepEqual(options.scenarioMap, {
    "D반": "excellent", "F반": "excellent",
    "H반": "moderate", "C반": "moderate",
    "I반": "struggling", "J반": "struggling",
    "E반": "inactive", "G반": "inactive",
  });
  assert.throws(() => parseParallelArgs([
    "--autonomous", "--classes", "D,F", "--scenario", "excellent:D", "--dry-run",
  ]), { code: "MISSING_SCENARIO_ASSIGNMENT" });
});

test("bounded scheduler never exceeds configured concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const results = await mapConcurrent([1, 2, 3, 4, 5, 6], 3, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await tick();
    active -= 1;
    return value * 2;
  });
  assert.equal(maximum, 3);
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
});

test("team lanes are parallel while accounts in each team stay sequential", async () => {
  const groups = groupAccountsByTeam([
    { accountId: "a1", teamName: "1팀" },
    { accountId: "a2", teamName: "1팀" },
    { accountId: "b1", teamName: "2팀" },
    { accountId: "b2", teamName: "2팀" },
  ]);
  const activeByTeam = new Map();
  let active = 0;
  let maximum = 0;
  const results = await runTeamLanes({
    groups,
    concurrency: 2,
    runAccount: async (account) => {
      assert.equal(activeByTeam.get(account.teamName) ?? 0, 0);
      activeByTeam.set(account.teamName, 1);
      active += 1;
      maximum = Math.max(maximum, active);
      await tick();
      active -= 1;
      activeByTeam.set(account.teamName, 0);
      return account.accountId;
    },
  });
  assert.equal(maximum, 2);
  assert.deepEqual(results.map((result) => result.completed), [["a1", "a2"], ["b1", "b2"]]);
});

test("a failed account stops only its team lane", async () => {
  const groups = groupAccountsByTeam([
    { accountId: "a1", teamName: "1팀" },
    { accountId: "a2", teamName: "1팀" },
    { accountId: "b1", teamName: "2팀" },
    { accountId: "b2", teamName: "2팀" },
  ]);
  const visited = [];
  const results = await runTeamLanes({
    groups,
    concurrency: 2,
    runAccount: async (account) => {
      visited.push(account.accountId);
      if (account.accountId === "a1") throw Object.assign(new Error("stop"), { code: "TEST_STOP" });
      return account.accountId;
    },
  });
  assert.equal(results[0].status, "failed");
  assert.equal(results[1].status, "complete");
  assert.equal(visited.includes("a2"), false);
  assert.equal(visited.includes("b2"), true);
});

test("a failed team preparation stops only that lane before any account starts", async () => {
  const groups = groupAccountsByTeam([
    { accountId: "a1", teamName: "1팀" },
    { accountId: "b1", teamName: "2팀" },
  ]);
  const visited = [];
  const results = await runTeamLanes({
    groups,
    concurrency: 2,
    prepareTeam: async (group) => {
      if (group.teamName === "1팀") throw Object.assign(new Error("analysis failed"), { code: "ANALYSIS_FAILED" });
    },
    runAccount: async (account) => {
      visited.push(account.accountId);
      return account.accountId;
    },
  });
  assert.equal(results[0].status, "failed");
  assert.equal(results[0].phase, "prepare");
  assert.equal(results[0].failedAccount, null);
  assert.deepEqual(visited, ["b1"]);
});

test("central answer broker serializes concurrent questions", async () => {
  const active = [];
  const queued = [];
  let inAsk = 0;
  let maximum = 0;
  const broker = new SerialAnswerBroker({
    onQueued: ({ requestId }) => queued.push(requestId),
    onActive: ({ requestId }) => active.push(requestId),
    ask: async ({ requestId }) => {
      inAsk += 1;
      maximum = Math.max(maximum, inAsk);
      await tick();
      inAsk -= 1;
      return `answer-${requestId}`;
    },
  });
  const answers = await Promise.all([broker.request({}), broker.request({}), broker.request({})]);
  assert.equal(maximum, 1);
  assert.deepEqual(queued, ["q000001", "q000002", "q000003"]);
  assert.deepEqual(active, queued);
  assert.deepEqual(answers, queued.map((requestId) => `answer-${requestId}`));
});

test("exact answer memo deduplicates only identical prompt fingerprints", async () => {
  const firstFingerprint = `sha256:${"a".repeat(64)}`;
  const secondFingerprint = `sha256:${"b".repeat(64)}`;
  let resolutions = 0;
  const reused = [];
  const memo = new ExactAnswerMemo({
    resolveAnswer: async ({ fingerprint }) => {
      resolutions += 1;
      await tick();
      return `answer-${fingerprint.slice(-1)}`;
    },
    onReuse: ({ fingerprint, source }) => reused.push({ fingerprint, source }),
  });
  const [first, duplicate, second] = await Promise.all([
    memo.request({ fingerprint: firstFingerprint }),
    memo.request({ fingerprint: firstFingerprint }),
    memo.request({ fingerprint: secondFingerprint }),
  ]);
  assert.equal(resolutions, 2);
  assert.equal(first, duplicate);
  assert.notEqual(first, second);
  assert.deepEqual(reused, [{ fingerprint: firstFingerprint, source: "inflight" }]);
  assert.equal(await memo.request({ fingerprint: firstFingerprint }), first);
  assert.equal(resolutions, 2);
  assert.equal(reused.at(-1).source, "memory");
});

test("exact answer memo can isolate the same prompt by scenario mode", async () => {
  const fingerprint = `sha256:${"c".repeat(64)}`;
  let resolutions = 0;
  const memo = new ExactAnswerMemo({
    keyFor: (payload) => `${payload.responseMode}:${payload.fingerprint}`,
    resolveAnswer: async ({ responseMode }) => {
      resolutions += 1;
      return `answer-${responseMode}`;
    },
  });
  assert.equal(await memo.request({ fingerprint, responseMode: "excellent" }), "answer-excellent");
  assert.equal(await memo.request({ fingerprint, responseMode: "inactive" }), "answer-inactive");
  assert.equal(await memo.request({ fingerprint, responseMode: "excellent" }), "answer-excellent");
  assert.equal(resolutions, 2);
});

test("class list normalization is strict", () => {
  assert.deepEqual(normalizeClassList("a,B반,f"), ["A반", "B반", "F반"]);
  assert.throws(() => normalizeClassList("A,1"), { code: "INVALID_CLASSES" });
});
