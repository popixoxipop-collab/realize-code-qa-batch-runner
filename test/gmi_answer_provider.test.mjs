import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGmiMessages,
  createGmiAnswerProvider,
  extractCurrentQuestion,
  normalizeModelAnswer,
  parseEnv,
} from "../src/gmi_answer_provider.mjs";

function response({ status = 200, content = "코드가 값을 조회하고 결과를 반환합니다. 이 방식은 실패 경로를 명시적으로 처리합니다.", retryAfter = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "retry-after" ? retryAfter : null },
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

test("env parser supports local GMI settings without overriding in-memory secrets", () => {
  assert.deepEqual(parseEnv("# note\nGMI_API_KEY='abc'\nexport GMI_MODEL=MiniMaxAI/MiniMax-M3 # model\n"), {
    GMI_API_KEY: "abc",
    GMI_MODEL: "MiniMaxAI/MiniMax-M3",
  });
});

test("answer prompt keeps the current question and code but omits account metadata", () => {
  const visibleText = "제목\n◆ 질문 1\n첫 질문\n내 답변\n이전 답변\n◆ 질문 2\n현재 질문\n0자";
  assert.equal(extractCurrentQuestion(visibleText), "◆ 질문 2\n현재 질문\n0자");
  const messages = buildGmiMessages({
    account: { displayName: "노출하지 않을 이름" },
    attempt: 1,
    visibleText,
    code: ["class Example {}"],
  }, { repositoryUrl: "https://github.com/example/repo" });
  const serialized = JSON.stringify(messages);
  assert.match(serialized, /현재 질문/u);
  assert.match(serialized, /class Example/u);
  assert.match(serialized, /재설명 요청/u);
  assert.equal(serialized.includes("노출하지 않을 이름"), false);
});

test("GMI provider uses the documented OpenAI-compatible request and returns only answer text", async () => {
  let request;
  const events = [];
  const provider = await createGmiAnswerProvider({
    apiKey: "unit-value",
    envFile: "/nonexistent/unit-test.env",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({ content: "답변: 실제 실행 흐름을 먼저 설명합니다. 그다음 설계상 장단점을 비교합니다." });
    },
    onEvent: (event) => events.push(event),
  });
  const answer = await provider({ visibleText: "◆ 질문 1\n설명하세요", code: ["code"], attempt: 0, fingerprint: `sha256:${"a".repeat(64)}` });
  assert.equal(answer, "실제 실행 흐름을 먼저 설명합니다. 그다음 설계상 장단점을 비교합니다.");
  assert.equal(request.url, "https://api.gmi-serving.com/v1/chat/completions");
  assert.equal(request.options.headers["User-Agent"], "curl/8.0");
  assert.equal(request.options.headers.Authorization, "Bearer unit-value");
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "MiniMaxAI/MiniMax-M3");
  assert.equal(body.messages[0].role, "system");
  assert.equal(events.at(-1).event, "llm_response");
  assert.equal(JSON.stringify(events).includes(answer), false);
});

test("GMI provider retries transient HTTP failures and fails closed on authentication", async () => {
  let calls = 0;
  const delays = [];
  const provider = await createGmiAnswerProvider({
    apiKey: "unit-value",
    envFile: "/nonexistent/unit-test.env",
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? response({ status: 503, retryAfter: "0" }) : response();
    },
    sleep: async (delay) => delays.push(delay),
    random: () => 0,
  });
  assert.match(await provider({ visibleText: "질문", code: [] }), /코드가/u);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [0]);

  const denied = await createGmiAnswerProvider({
    apiKey: "unit-value",
    envFile: "/nonexistent/unit-test.env",
    fetchImpl: async () => response({ status: 403 }),
    sleep: async () => assert.fail("403 must not retry"),
  });
  await assert.rejects(() => denied({ visibleText: "질문", code: [] }), { code: "GMI_AUTH_FAILED" });
});

test("GMI provider enforces its configured request concurrency", async () => {
  let active = 0;
  let maximum = 0;
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const provider = await createGmiAnswerProvider({
    apiKey: "unit-value",
    envFile: "/nonexistent/unit-test.env",
    concurrency: 2,
    fetchImpl: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      return response();
    },
  });
  const pending = [provider({ visibleText: "q1" }), provider({ visibleText: "q2" }), provider({ visibleText: "q3" })];
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(maximum, 2);
  release();
  await Promise.all(pending);
  assert.equal(maximum, 2);
});

test("model answer normalization removes wrappers but preserves technical content", () => {
  assert.equal(normalizeModelAnswer("```text\n답변: Optional은 부재를 표현합니다.\n```"), "Optional은 부재를 표현합니다.");
});
