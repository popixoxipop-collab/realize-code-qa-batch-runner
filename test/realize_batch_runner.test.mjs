import assert from "node:assert/strict";
import test from "node:test";

import {
  AdaptiveWaitStats,
  DEFAULT_REVIEW_REPOSITORY_URL,
  RunnerStop,
  createRealizeBatchRunner,
  fingerprintQuestion,
  typeVerified,
} from "../src/realize_batch_runner.mjs";

test("public runner default review repository points to Team-IZ Backend", () => {
  assert.equal(DEFAULT_REVIEW_REPOSITORY_URL, "https://github.com/Team-IZ/Backend");
});

class FakeTextarea {
  constructor({ corruptFirstChunk = false, clock = null } = {}) {
    this.value = "stale";
    this.corruptFirstChunk = corruptFirstChunk;
    this.corrupted = false;
    this.selectAll = false;
    this.chunkLengths = [];
    this.clock = clock;
  }

  async press(key) {
    if (key === "ControlOrMeta+A") this.selectAll = true;
    if (key === "Backspace" && this.selectAll) {
      this.value = "";
      this.selectAll = false;
    }
  }

  async pressSequentially(chunk) {
    this.chunkLengths.push(Array.from(chunk).length);
    this.clock?.advance(12);
    if (this.corruptFirstChunk && !this.corrupted) {
      this.value += chunk.slice(1);
      this.corrupted = true;
      return;
    }
    this.value += chunk;
  }

  async evaluate() {
    return this.value;
  }
}

class FakeLocator {
  constructor(config = {}) {
    this.config = config;
  }

  async isVisible() {
    return typeof this.config.visible === "function" ? this.config.visible() : Boolean(this.config.visible);
  }

  async innerText() {
    return typeof this.config.text === "function" ? this.config.text() : String(this.config.text ?? "");
  }

  async isEnabled() {
    return this.config.enabled ?? true;
  }

  async click() {
    await this.config.click?.();
  }

  async press(key) {
    return this.config.press?.(key);
  }

  async pressSequentially(chunk) {
    return this.config.pressSequentially?.(chunk);
  }

  async evaluate(fn) {
    return this.config.evaluate?.(fn);
  }

  async setChecked(value) {
    return this.config.setChecked?.(value);
  }
}

class FakeTab {
  constructor(locators) {
    this.locators = locators;
    this.playwright = {
      locator: (selector) => {
        if (!(selector in this.locators)) throw new Error(`Unknown fake selector: ${selector}`);
        return this.locators[selector];
      },
    };
  }
}

function virtualTime() {
  let now = 0;
  return {
    now: () => now,
    advance: (milliseconds) => { now += milliseconds; },
    sleep: async (milliseconds) => { now += milliseconds; },
  };
}

const selectors = Object.freeze({
  accountBanner: "account",
  title: "title",
  filePath: "path",
  citedLines: "lines",
  question: "question",
  textarea: "textarea",
  submitButton: "submit",
  grading: "grading",
  reExplain: "reExplain",
  handoff: "handoff",
  handoffButton: "handoffButton",
  completion: "completion",
});

test("typeVerified retries corrupted real-key chunks and ends with exact text", async () => {
  const time = virtualTime();
  const textarea = new FakeTextarea({ corruptFirstChunk: true, clock: time });
  const stats = new AdaptiveWaitStats({ profiles: { typing: { seedMs: 12, minPollMs: 1, maxPollMs: 5 } } });
  const answer = "이 답변은 실제 키 이벤트 청크를 재시도한 뒤 정확히 일치해야 합니다.";
  const result = await typeVerified({
    locator: textarea,
    text: answer,
    waitStats: stats,
    maxRetries: 2,
    clock: time.now,
    sleep: time.sleep,
  });
  assert.equal(textarea.value, answer);
  assert.equal(result.attempts, 2);
  assert.ok(textarea.chunkLengths.every((length) => length >= 8 && length <= 20));
  assert.equal(stats.snapshot("typing").failures, 1);
});

test("runner fails closed on an unknown exact prompt without clicking submit", async () => {
  let submitClicks = 0;
  const textarea = new FakeTextarea();
  const locators = {
    account: new FakeLocator({ visible: true, text: "F반 1팀 노태현" }),
    title: new FakeLocator({ visible: true, text: "BookController" }),
    path: new FakeLocator({ visible: true, text: "src/BookController.java" }),
    lines: new FakeLocator({ visible: true, text: "10-14" }),
    question: new FakeLocator({ visible: true, text: "은행에 없는 새로운 질문은 무엇인가요?" }),
    textarea,
    submit: new FakeLocator({ visible: true, text: "답변 제출", click: () => { submitClicks += 1; } }),
    grading: new FakeLocator({ visible: false }),
    reExplain: new FakeLocator({ visible: false }),
    handoff: new FakeLocator({ visible: false }),
    handoffButton: new FakeLocator({ visible: false, text: "시작하기" }),
    completion: new FakeLocator({ visible: false }),
  };
  const knownPrompt = {
    title: "BookController",
    filePath: "src/BookController.java",
    citedLines: "10-14",
    question: "이미 알고 있는 질문은 무엇인가요?",
  };
  const runner = createRealizeBatchRunner({
    tab: new FakeTab(locators),
    selectors,
    expectedAccount: "F반 1팀 노태현",
    answerBank: [{ prompt: knownPrompt, answer: "정확한 은행 답변입니다." }],
    checkpoints: { writeAhead: async () => {}, confirmed: async () => {} },
  });
  await assert.rejects(runner.runAccount(), (error) => {
    assert.ok(error instanceof RunnerStop);
    assert.equal(error.code, "UNKNOWN_PROMPT");
    return true;
  });
  assert.equal(submitClicks, 0);
});

test("grading wait learns from observed fake-tab latency and reaches completion", async () => {
  const time = virtualTime();
  let phase = "question";
  let gradingStartedAt = null;
  const textarea = new FakeTextarea({ clock: time });
  const prompt = {
    title: "BookService",
    filePath: "src/BookService.java",
    citedLines: "20-31",
    question: "검색 흐름을 설명하세요.",
  };
  const locators = {
    account: new FakeLocator({ visible: true, text: "F반 1팀 서윤슬" }),
    title: new FakeLocator({ visible: () => phase === "question", text: prompt.title }),
    path: new FakeLocator({ visible: () => phase === "question", text: prompt.filePath }),
    lines: new FakeLocator({ visible: () => phase === "question", text: prompt.citedLines }),
    question: new FakeLocator({ visible: () => phase === "question", text: prompt.question }),
    textarea,
    submit: new FakeLocator({
      visible: () => phase === "question",
      text: "답변 제출하고 마치기",
      click: () => {
        phase = "grading";
        gradingStartedAt = time.now();
      },
    }),
    grading: new FakeLocator({
      visible: () => {
        if (phase === "grading" && time.now() - gradingStartedAt >= 900) phase = "completion";
        return phase === "grading";
      },
    }),
    reExplain: new FakeLocator({ visible: false }),
    handoff: new FakeLocator({ visible: false }),
    handoffButton: new FakeLocator({ visible: false, text: "시작하기" }),
    completion: new FakeLocator({ visible: () => phase === "completion" }),
  };
  const checkpoints = [];
  const waitStats = new AdaptiveWaitStats({
    profiles: {
      grading: { seedMs: 400, minTimeoutMs: 100, maxTimeoutMs: 10_000, minPollMs: 100, maxPollMs: 100 },
      typing: { seedMs: 12, minPollMs: 1, maxPollMs: 4 },
    },
  });
  const before = waitStats.timeoutFor("grading");
  const runner = createRealizeBatchRunner({
    tab: new FakeTab(locators),
    selectors,
    expectedAccount: "F반 1팀 서윤슬",
    answerBank: [{ prompt, answer: "먼저 키워드 조건을 확인하고 검색 결과를 반환합니다." }],
    checkpoints: {
      writeAhead: async (record) => checkpoints.push(record),
      confirmed: async (record) => checkpoints.push(record),
    },
    waitStats,
    clock: time.now,
    sleep: time.sleep,
  });
  const result = await runner.runAccount();
  assert.equal(result.status, "complete");
  assert.ok(waitStats.snapshot("grading").p95Ms >= 900);
  assert.ok(waitStats.timeoutFor("grading") > before);
  assert.deepEqual(checkpoints.filter((record) => record.action === "answer_submit").map((record) => record.phase), ["intent", "confirmed"]);
  assert.equal(checkpoints.at(-1).visibleState, "completion");
  assert.equal(fingerprintQuestion(prompt), checkpoints[0].fingerprint);
});
