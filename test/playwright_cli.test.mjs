import assert from "node:assert/strict";
import test from "node:test";

import { AdaptiveNetworkWaits, parseArgs, parseTraineeButtonLabel, promptFingerprint, redactApiUrl } from "../bin/realize-playwright.mjs";

test("standalone CLI parses class and one-based resume index", () => {
  const options = parseArgs(["--class", "f", "--start-at", "3", "--limit", "1", "--headed"]);
  assert.equal(options.className, "F반");
  assert.equal(options.startAt, 3);
  assert.equal(options.limit, 1);
  assert.equal(options.headless, false);
});

test("visible trainee buttons become pseudonymous records without retaining email", () => {
  const account = parseTraineeButtonLabel("F반 1팀 교육생 03trainee03@example.com", "F반");
  assert.equal(account.teamName, "1팀");
  assert.equal(account.displayName, "교육생 03");
  assert.match(account.accountId, /^[a-f0-9]{20}$/u);
  assert.equal(JSON.stringify(account).includes("@"), false);
  assert.equal(parseTraineeButtonLabel("F반 매니저manager@example.com", "F반"), null);
});

test("answer network waits start conservatively and adapt from measured responses", () => {
  const waits = new AdaptiveNetworkWaits();
  assert.equal(waits.timeoutFor("answer"), 240_000);
  waits.observe("answer", 30_000);
  assert.ok(waits.timeoutFor("answer") >= 120_000);
  const firstDelay = waits.retryDelayFor("answer");
  const beforeFailure = waits.timeoutFor("answer");
  waits.failure("answer");
  assert.ok(waits.timeoutFor("answer") >= beforeFailure);
  const secondDelay = waits.retryDelayFor("answer");
  waits.failure("answer");
  assert.ok(waits.retryDelayFor("answer") > secondDelay);
  assert.ok(secondDelay >= firstDelay);
});

test("network logs redact session identifiers and query parameters", () => {
  assert.equal(
    redactApiUrl("https://example.com/api/v0/assessment-sessions/c2a9bbe5-f55f-4f2d-9217-7093483e06c3/answers?debug=true"),
    "https://example.com/api/v0/assessment-sessions/:sessionId/answers",
  );
});

test("prompt fingerprints ignore countdown and retry counters", () => {
  const first = promptFingerprint("문제\n이 문제 00:20:00 남음\n0자\n2번 남음", ["code"]);
  const later = promptFingerprint("문제\n이 문제 00:18:08 남음\n143자\n1번 남음", ["code"]);
  assert.equal(first, later);
  assert.notEqual(first, promptFingerprint("다른 문제\n이 문제 00:20:00 남음\n0자\n2번 남음", ["code"]));
});
