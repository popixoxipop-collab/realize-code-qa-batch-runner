import assert from "node:assert/strict";
import test from "node:test";

import { desiredHintCount, fixedScenarioAnswer, parseScenarioAssignments, scenarioPayload, scenarioSeed } from "../src/qa_scenarios.mjs";

const payload = {
  account: { className: "H반", teamName: "1팀", accountId: "account-1" },
  fingerprint: `sha256:${"a".repeat(64)}`,
  visibleText: "코드 포인트\n◆ 질문 2\n이유를 설명하세요\n2번 남음",
  code: ["class Example {}"],
};

test("scenario assignment defaults to excellent and validates complete explicit maps", () => {
  assert.deepEqual(parseScenarioAssignments([], ["D반", "F반"]), { "D반": "excellent", "F반": "excellent" });
  assert.deepEqual(parseScenarioAssignments(["moderate:H,C"], ["H반", "C반"]), { "H반": "moderate", "C반": "moderate" });
  assert.throws(() => parseScenarioAssignments(["inactive:E", "excellent:E"], ["E반"]), { code: "DUPLICATE_SCENARIO_ASSIGNMENT" });
});

test("scenario decisions are deterministic and match the configured hint envelopes", () => {
  assert.equal(scenarioSeed(payload), scenarioSeed({ ...payload, visibleText: payload.visibleText.replace("2번 남음", "1번 남음") }));
  assert.equal(desiredHintCount(payload, "excellent"), 0);
  assert.ok([1, 2].includes(desiredHintCount(payload, "moderate")));
  assert.equal(desiredHintCount(payload, "struggling"), 2);
  assert.equal(desiredHintCount(payload, "inactive"), 2);
});

test("scenario payloads isolate answer modes and fixed failure answers stay non-empty", () => {
  const moderate = scenarioPayload(payload, "moderate");
  assert.equal(moderate.responseMode, "assisted_correct");
  assert.match(moderate.scenarioCacheKey, /^assisted_correct:sha256:/u);
  const struggling = scenarioPayload(payload, "struggling");
  assert.ok(["assisted_basic", "assisted_incorrect"].includes(struggling.responseMode));
  assert.ok(fixedScenarioAnswer("inactive").length >= 15);
  assert.ok(fixedScenarioAnswer("assisted_incorrect").length >= 15);
  assert.equal(fixedScenarioAnswer("excellent"), null);
});
