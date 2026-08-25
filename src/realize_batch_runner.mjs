import { createHash } from "node:crypto";

export const DEFAULT_REVIEW_REPOSITORY_URL = "https://github.com/Team-IZ/Backend";

export const DEFAULT_LABELS = Object.freeze({
  answerSubmit: "답변 제출",
  finalSubmit: "답변 제출하고 마치기",
  handoffStart: "시작하기",
  startSession: "이해도 확인 시작하기",
});

export class RunnerStop extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RunnerStop";
    this.code = code;
    this.details = details;
  }
}

function assert(condition, code, message, details) {
  if (!condition) throw new RunnerStop(code, message, details);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeVisibleText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
}

export function normalizeTextarea(value) {
  return String(value ?? "").normalize("NFC").replace(/\r\n?/g, "\n");
}

export function canonicalQuestion(prompt) {
  const canonical = {
    title: normalizeVisibleText(prompt?.title),
    filePath: normalizeVisibleText(prompt?.filePath),
    citedLines: normalizeVisibleText(prompt?.citedLines),
    question: normalizeVisibleText(prompt?.question),
  };
  assert(
    canonical.question.length > 0,
    "EMPTY_QUESTION",
    "The visible question is empty; refusing to select an answer.",
  );
  return canonical;
}

export function fingerprintQuestion(prompt) {
  const canonical = canonicalQuestion(prompt);
  const digest = createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

function normalizeAnswerEntry(value, fingerprint) {
  const raw = typeof value === "string" ? { answer: value } : value;
  assert(raw && typeof raw === "object", "INVALID_ANSWER_BANK", `Invalid answer entry for ${fingerprint}.`);
  const answers = Array.isArray(raw.answers)
    ? raw.answers
    : [raw.answer, ...(Array.isArray(raw.reExplain) ? raw.reExplain : raw.reExplain ? [raw.reExplain] : [])];
  assert(answers.length > 0, "INVALID_ANSWER_BANK", `No answers configured for ${fingerprint}.`);
  for (const answer of answers) {
    assert(typeof answer === "string" && normalizeTextarea(answer).length > 0, "INVALID_ANSWER_BANK", `Empty answer configured for ${fingerprint}.`);
  }
  return Object.freeze({
    fingerprint,
    answers: Object.freeze(answers.map(normalizeTextarea)),
    metadata: raw.metadata ?? null,
  });
}

export function compileAnswerBank(input) {
  const bank = new Map();
  const insert = (fingerprint, value) => {
    assert(/^sha256:[a-f0-9]{64}$/.test(fingerprint), "INVALID_ANSWER_BANK", `Answer-bank key is not a SHA-256 fingerprint: ${fingerprint}`);
    assert(!bank.has(fingerprint), "INVALID_ANSWER_BANK", `Duplicate answer fingerprint: ${fingerprint}`);
    bank.set(fingerprint, normalizeAnswerEntry(value, fingerprint));
  };

  if (input instanceof Map) {
    for (const [fingerprint, value] of input) insert(fingerprint, value);
  } else if (Array.isArray(input)) {
    for (const value of input) {
      assert(value && typeof value === "object", "INVALID_ANSWER_BANK", "Array answer-bank entries must be objects.");
      const computed = value.prompt ? fingerprintQuestion(value.prompt) : null;
      const fingerprint = value.fingerprint ?? computed;
      assert(fingerprint, "INVALID_ANSWER_BANK", "Each answer-bank entry needs a prompt or fingerprint.");
      assert(!computed || !value.fingerprint || computed === value.fingerprint, "INVALID_ANSWER_BANK", `Configured fingerprint does not match its prompt: ${value.fingerprint}`);
      insert(fingerprint, value);
    }
  } else {
    assert(input && typeof input === "object", "INVALID_ANSWER_BANK", "answerBank must be an object, Map, or array.");
    for (const [fingerprint, value] of Object.entries(input)) insert(fingerprint, value);
  }
  assert(bank.size > 0, "INVALID_ANSWER_BANK", "answerBank is empty.");
  return bank;
}

export function resolveAnswer(compiledBank, prompt, attempt = 0) {
  const fingerprint = fingerprintQuestion(prompt);
  const entry = compiledBank.get(fingerprint);
  assert(entry, "UNKNOWN_PROMPT", "No exact answer-bank fingerprint matches the visible question.", {
    fingerprint,
    prompt: canonicalQuestion(prompt),
  });
  const answer = entry.answers[attempt];
  assert(answer, "REEXPLAIN_EXHAUSTED", "No configured re-explanation remains for this exact question.", {
    fingerprint,
    attempt,
  });
  return { answer, attempt, entry, fingerprint };
}

export function splitIntoChunks(value, chunkSize) {
  assert(Number.isInteger(chunkSize) && chunkSize >= 8 && chunkSize <= 20, "INVALID_CHUNK_SIZE", "Typing chunk size must be between 8 and 20 characters.");
  const characters = Array.from(String(value));
  const chunks = [];
  for (let index = 0; index < characters.length; index += chunkSize) {
    chunks.push(characters.slice(index, index + chunkSize).join(""));
  }
  return chunks;
}

function percentile(samples, fraction) {
  if (samples.length === 0) return 0;
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

const DEFAULT_WAIT_PROFILES = Object.freeze({
  homeLoad: { seedMs: 2_000, minTimeoutMs: 2_000, maxTimeoutMs: 60_000, minPollMs: 80, maxPollMs: 1_000 },
  grading: { seedMs: 8_000, minTimeoutMs: 5_000, maxTimeoutMs: 180_000, minPollMs: 120, maxPollMs: 1_500 },
  typing: { seedMs: 24, minTimeoutMs: 1_000, maxTimeoutMs: 30_000, minPollMs: 4, maxPollMs: 80 },
});

export class AdaptiveWaitStats {
  constructor({ alpha = 0.35, maxSamples = 64, profiles = {} } = {}) {
    assert(alpha > 0 && alpha <= 1, "INVALID_WAIT_CONFIG", "EWMA alpha must be in (0, 1].");
    this.alpha = alpha;
    this.maxSamples = maxSamples;
    this.profiles = {};
    this.state = {};
    for (const [category, defaults] of Object.entries(DEFAULT_WAIT_PROFILES)) {
      this.profiles[category] = { ...defaults, ...(profiles[category] ?? {}) };
      this.state[category] = { ewmaMs: this.profiles[category].seedMs, samples: [], failures: 0 };
    }
  }

  ensure(category) {
    assert(this.state[category], "INVALID_WAIT_CATEGORY", `Unknown wait category: ${category}`);
    return this.state[category];
  }

  observe(category, elapsedMs) {
    const state = this.ensure(category);
    assert(Number.isFinite(elapsedMs) && elapsedMs >= 0, "INVALID_WAIT_SAMPLE", "Wait samples must be finite, non-negative milliseconds.");
    state.ewmaMs = this.alpha * elapsedMs + (1 - this.alpha) * state.ewmaMs;
    state.samples.push(elapsedMs);
    if (state.samples.length > this.maxSamples) state.samples.shift();
    return this.snapshot(category);
  }

  failure(category) {
    this.ensure(category).failures += 1;
  }

  p95(category) {
    const state = this.ensure(category);
    return percentile(state.samples, 0.95) || state.ewmaMs;
  }

  timeoutFor(category) {
    const state = this.ensure(category);
    const profile = this.profiles[category];
    const failureFactor = 1 + Math.min(state.failures, 4) * 0.25;
    return Math.round(clamp(Math.max(state.ewmaMs * 2.5, this.p95(category) * 1.75) * failureFactor, profile.minTimeoutMs, profile.maxTimeoutMs));
  }

  pollIntervalFor(category) {
    const profile = this.profiles[category];
    return Math.round(clamp(this.p95(category) / 12, profile.minPollMs, profile.maxPollMs));
  }

  typingChunkSize() {
    const state = this.ensure("typing");
    if (state.failures > 0) return clamp(16 - state.failures * 2, 8, 20);
    const p95 = this.p95("typing");
    if (p95 <= 20) return 20;
    if (p95 <= 50) return 16;
    if (p95 <= 100) return 12;
    return 8;
  }

  snapshot(category) {
    if (category) {
      const state = this.ensure(category);
      return Object.freeze({
        ewmaMs: Math.round(state.ewmaMs),
        p95Ms: Math.round(this.p95(category)),
        timeoutMs: this.timeoutFor(category),
        pollMs: this.pollIntervalFor(category),
        samples: state.samples.length,
        failures: state.failures,
      });
    }
    return Object.freeze(Object.fromEntries(Object.keys(this.state).map((name) => [name, this.snapshot(name)])));
  }
}

function defaultClock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function readTextareaValue(locator) {
  if (typeof locator.evaluate === "function") {
    return normalizeTextarea(await locator.evaluate((element) => element.value));
  }
  return normalizeTextarea(await locator.getAttribute("value"));
}

async function clearTextarea(locator) {
  await locator.press("ControlOrMeta+A");
  await locator.press("Backspace");
  const value = await readTextareaValue(locator);
  assert(value === "", "TEXTAREA_CLEAR_FAILED", "Textarea did not become empty after select-all and Backspace.", { actual: value });
}

export async function typeVerified({
  locator,
  text,
  waitStats = new AdaptiveWaitStats(),
  maxRetries = 3,
  clock = defaultClock,
  sleep = defaultSleep,
}) {
  const expected = normalizeTextarea(text);
  assert(expected.length > 0, "EMPTY_ANSWER", "Refusing to type an empty answer.");
  let lastActual = "";
  for (let retry = 0; retry <= maxRetries; retry += 1) {
    await clearTextarea(locator);
    const chunkSize = clamp(waitStats.typingChunkSize(), 8, 20);
    let expectedPrefix = "";
    let prefixMismatch = false;
    const attemptStartedAt = clock();
    for (const chunk of splitIntoChunks(expected, chunkSize)) {
      const chunkStartedAt = clock();
      await locator.pressSequentially(chunk);
      waitStats.observe("typing", Math.max(0, clock() - chunkStartedAt));
      expectedPrefix += chunk;
      lastActual = await readTextareaValue(locator);
      if (lastActual !== normalizeTextarea(expectedPrefix)) {
        prefixMismatch = true;
        break;
      }
      if (expectedPrefix !== expected) await sleep(waitStats.pollIntervalFor("typing"));
    }
    lastActual = await readTextareaValue(locator);
    if (!prefixMismatch && lastActual === expected) {
      waitStats.observe("typing", Math.max(0, clock() - attemptStartedAt));
      return { attempts: retry + 1, chunkSize, length: Array.from(expected).length };
    }
    waitStats.failure("typing");
  }
  throw new RunnerStop("TEXTAREA_MISMATCH", "Textarea did not exactly equal the normalized answer after typing retries.", {
    expected,
    actual: lastActual,
    maxRetries,
  });
}

export function locatorFor(tab, spec) {
  assert(tab?.playwright, "INVALID_TAB", "Runner requires an already-selected Browser Tab with tab.playwright.");
  assert(spec, "MISSING_SELECTOR", "A required deterministic selector was not configured.");
  if (typeof spec === "function") return spec(tab);
  if (typeof spec === "string") return tab.playwright.locator(spec);
  if (spec.css) return tab.playwright.locator(spec.css);
  if (spec.testId) return tab.playwright.getByTestId(spec.testId);
  if (spec.role) return tab.playwright.getByRole(spec.role, { name: spec.name, exact: spec.exact ?? true });
  if (spec.text) return tab.playwright.getByText(spec.text, { exact: spec.exact ?? true });
  if (spec.label) return tab.playwright.getByLabel(spec.label, { exact: spec.exact ?? true });
  throw new RunnerStop("INVALID_SELECTOR", "Unsupported deterministic selector specification.", { spec });
}

async function visible(locator) {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function optionalText(tab, spec) {
  if (!spec) return "";
  const locator = locatorFor(tab, spec);
  if (!(await visible(locator))) return "";
  return normalizeVisibleText(await locator.innerText());
}

function compareAccount(actual, expected) {
  if (typeof expected === "string") return normalizeVisibleText(actual) === normalizeVisibleText(expected);
  if (!expected || typeof expected !== "object" || !actual || typeof actual !== "object") return false;
  const entries = Object.entries(expected);
  return entries.length > 0 && entries.every(([key, value]) => normalizeVisibleText(actual[key]) === normalizeVisibleText(value));
}

async function pollUntil(check, {
  category,
  waitStats,
  clock,
  sleep,
  timeoutMs = waitStats.timeoutFor(category),
}) {
  const startedAt = clock();
  let lastValue;
  while (clock() - startedAt <= timeoutMs) {
    lastValue = await check();
    if (lastValue) {
      waitStats.observe(category, Math.max(0, clock() - startedAt));
      return lastValue;
    }
    await sleep(waitStats.pollIntervalFor(category));
  }
  waitStats.failure(category);
  throw new RunnerStop("ADAPTIVE_WAIT_TIMEOUT", `Timed out waiting for ${category} state.`, {
    category,
    timeoutMs,
    lastValue,
    stats: waitStats.snapshot(category),
  });
}

function validateRunnerOptions(options) {
  assert(options?.tab?.playwright, "INVALID_TAB", "createRealizeBatchRunner requires an already-selected Browser Tab.");
  assert(options.expectedAccount, "MISSING_ACCOUNT", "expectedAccount is required for fail-closed account verification.");
  assert(options.checkpoints?.writeAhead instanceof Function, "MISSING_CHECKPOINT", "checkpoints.writeAhead callback is required.");
  assert(options.checkpoints?.confirmed instanceof Function, "MISSING_CHECKPOINT", "checkpoints.confirmed callback is required.");
  const requiredSelectors = ["accountBanner", "question", "textarea", "submitButton", "grading", "reExplain", "handoff", "handoffButton", "completion"];
  for (const name of requiredSelectors) assert(options.selectors?.[name], "MISSING_SELECTOR", `selectors.${name} is required.`);
}

export function createRealizeBatchRunner(options) {
  validateRunnerOptions(options);
  const tab = options.tab;
  const selectors = options.selectors;
  const labels = { ...DEFAULT_LABELS, ...(options.labels ?? {}) };
  const waitStats = options.waitStats ?? new AdaptiveWaitStats(options.waitConfig);
  const compiledBank = compileAnswerBank(options.answerBank);
  const clock = options.clock ?? defaultClock;
  const sleep = options.sleep ?? defaultSleep;
  const maxTypingRetries = options.maxTypingRetries ?? 3;
  const maxSteps = options.maxSteps ?? 100;
  const attempted = new Set(options.resume?.attempted ?? []);
  const confirmed = new Set(options.resume?.confirmed ?? []);
  const explanationAttempt = new Map(Object.entries(options.resume?.explanationAttempt ?? {}).map(([key, value]) => [key, Number(value)]));
  let sequence = Number(options.resume?.sequence ?? 0);

  const readAccount = async () => {
    if (options.readAccount) return options.readAccount(tab);
    return normalizeVisibleText(await locatorFor(tab, selectors.accountBanner).innerText());
  };

  const verifyAccount = async () => {
    const actual = await readAccount();
    assert(compareAccount(actual, options.expectedAccount), "ACCOUNT_MISMATCH", "Visible account does not exactly match the configured account.", {
      expected: options.expectedAccount,
      actual,
    });
    return actual;
  };

  const readPrompt = async () => canonicalQuestion({
    title: await optionalText(tab, selectors.title),
    filePath: await optionalText(tab, selectors.filePath),
    citedLines: await optionalText(tab, selectors.citedLines),
    question: await optionalText(tab, selectors.question),
  });

  const stateIsVisible = async (name) => visible(locatorFor(tab, selectors[name]));

  const detectState = async () => {
    if (await stateIsVisible("completion")) return { kind: "completion" };
    if (await stateIsVisible("reExplain")) return { kind: "reExplain", prompt: await readPrompt() };
    if (await stateIsVisible("handoff")) return { kind: "handoff" };
    if (await stateIsVisible("grading")) return { kind: "grading" };
    if (await stateIsVisible("question")) return { kind: "question", prompt: await readPrompt() };
    if (selectors.homeReady && await stateIsVisible("homeReady")) return { kind: "home" };
    return null;
  };

  const checkpointRecord = (phase, action, data = {}) => ({
    version: 1,
    phase,
    action,
    sequence: ++sequence,
    account: options.expectedAccount,
    at: new Date().toISOString(),
    ...data,
  });

  const waitForInitialState = () => pollUntil(detectState, { category: "homeLoad", waitStats, clock, sleep });

  const waitAfterSubmit = async (previousFingerprint) => {
    let sawGrading = false;
    return pollUntil(async () => {
      const state = await detectState();
      if (!state) return null;
      if (state.kind === "grading") {
        sawGrading = true;
        return null;
      }
      if (["completion", "reExplain", "handoff"].includes(state.kind)) return { ...state, sawGrading };
      if (state.kind === "question") {
        const nextFingerprint = fingerprintQuestion(state.prompt);
        if (nextFingerprint !== previousFingerprint) return { ...state, sawGrading, nextFingerprint };
        return null;
      }
      return null;
    }, { category: "grading", waitStats, clock, sleep });
  };

  const clickExact = async (selectorName, expectedLabel) => {
    const locator = locatorFor(tab, selectors[selectorName]);
    assert(await visible(locator), "BUTTON_NOT_VISIBLE", `${selectorName} is not visible.`);
    const actualLabel = normalizeVisibleText(await locator.innerText());
    assert(actualLabel === normalizeVisibleText(expectedLabel), "BUTTON_LABEL_MISMATCH", `Refusing to click ${selectorName} because its label is not exact.`, {
      expectedLabel,
      actualLabel,
    });
    assert(typeof locator.isEnabled !== "function" || await locator.isEnabled(), "BUTTON_DISABLED", `${selectorName} is disabled.`);
    await locator.click();
    return actualLabel;
  };

  const startFromHome = async () => {
    if (selectors.readyCheckbox) {
      const checkbox = locatorFor(tab, selectors.readyCheckbox);
      if (await visible(checkbox)) await checkbox.setChecked(true);
    }
    assert(selectors.startButton, "MISSING_SELECTOR", "selectors.startButton is required when the home state is visible.");
    const intent = checkpointRecord("intent", "session_start");
    await options.checkpoints.writeAhead(intent);
    await clickExact("startButton", labels.startSession);
    const state = await pollUntil(async () => {
      const current = await detectState();
      return current && current.kind !== "home" ? current : null;
    }, { category: "homeLoad", waitStats, clock, sleep });
    await options.checkpoints.confirmed(checkpointRecord("confirmed", "session_start", { visibleState: state.kind }));
    return state;
  };

  const startHandoff = async () => {
    const intent = checkpointRecord("intent", "code_point_handoff");
    await options.checkpoints.writeAhead(intent);
    await clickExact("handoffButton", labels.handoffStart);
    const state = await pollUntil(async () => {
      const current = await detectState();
      return current && !["handoff", "grading"].includes(current.kind) ? current : null;
    }, { category: "homeLoad", waitStats, clock, sleep });
    await options.checkpoints.confirmed(checkpointRecord("confirmed", "code_point_handoff", { visibleState: state.kind }));
    return state;
  };

  const submitAnswer = async (state) => {
    const prompt = state.prompt;
    const fingerprint = fingerprintQuestion(prompt);
    const attempt = state.kind === "reExplain"
      ? (explanationAttempt.get(fingerprint) ?? 0) + 1
      : (explanationAttempt.get(fingerprint) ?? 0);
    const attemptKey = `${fingerprint}:${attempt}`;
    assert(!attempted.has(attemptKey), "DUPLICATE_SUBMIT_BLOCKED", "This exact question attempt already has a write-ahead checkpoint; refusing to resubmit.", {
      fingerprint,
      attempt,
      confirmed: confirmed.has(attemptKey),
    });
    const selected = resolveAnswer(compiledBank, prompt, attempt);
    const textarea = locatorFor(tab, selectors.textarea);
    const typing = await typeVerified({
      locator: textarea,
      text: selected.answer,
      waitStats,
      maxRetries: maxTypingRetries,
      clock,
      sleep,
    });
    const submitButton = locatorFor(tab, selectors.submitButton);
    const actualLabel = normalizeVisibleText(await submitButton.innerText());
    const allowedLabels = [labels.answerSubmit, labels.finalSubmit].map(normalizeVisibleText);
    assert(allowedLabels.includes(actualLabel), "BUTTON_LABEL_MISMATCH", "Answer button label is neither the normal nor explicit final label.", {
      allowedLabels,
      actualLabel,
    });
    assert(typeof submitButton.isEnabled !== "function" || await submitButton.isEnabled(), "BUTTON_DISABLED", "Answer submit button is disabled after verified typing.");
    const final = actualLabel === normalizeVisibleText(labels.finalSubmit);
    const answerDigest = `sha256:${createHash("sha256").update(selected.answer, "utf8").digest("hex")}`;
    const intent = checkpointRecord("intent", "answer_submit", {
      fingerprint,
      attempt,
      attemptKey,
      answerDigest,
      buttonLabel: actualLabel,
      final,
      typing,
    });
    await options.checkpoints.writeAhead(intent);
    attempted.add(attemptKey);
    await submitButton.click();
    const nextState = await waitAfterSubmit(fingerprint);
    confirmed.add(attemptKey);
    explanationAttempt.set(fingerprint, attempt);
    await options.checkpoints.confirmed(checkpointRecord("confirmed", "answer_submit", {
      fingerprint,
      attempt,
      attemptKey,
      buttonLabel: actualLabel,
      final,
      visibleState: nextState.kind,
      sawGrading: nextState.sawGrading,
    }));
    if (final && nextState.kind !== "completion") {
      throw new RunnerStop("FINAL_NOT_COMPLETE", "The explicit final-answer button did not lead to the completion screen.", {
        visibleState: nextState.kind,
        fingerprint,
      });
    }
    return nextState;
  };

  const runAccount = async () => {
    const actualAccount = await verifyAccount();
    let state = await waitForInitialState();
    for (let step = 0; step < maxSteps; step += 1) {
      if (state.kind === "completion") {
        return {
          status: "complete",
          account: actualAccount,
          steps: step,
          waitStats: waitStats.snapshot(),
          resume: {
            sequence,
            attempted: [...attempted],
            confirmed: [...confirmed],
            explanationAttempt: Object.fromEntries(explanationAttempt),
          },
        };
      }
      if (state.kind === "home") state = await startFromHome();
      else if (state.kind === "handoff") state = await startHandoff();
      else if (state.kind === "grading") {
        state = await pollUntil(async () => {
          const current = await detectState();
          return current && current.kind !== "grading" ? current : null;
        }, { category: "grading", waitStats, clock, sleep });
      } else if (state.kind === "question" || state.kind === "reExplain") {
        state = await submitAnswer(state);
      } else {
        throw new RunnerStop("UNKNOWN_STATE", "Visible RealiZe state is not handled; no action was taken.", { state });
      }
    }
    throw new RunnerStop("STEP_LIMIT", "Runner stopped at its configured step limit without completion.", { maxSteps });
  };

  return Object.freeze({
    runAccount,
    verifyAccount,
    detectState,
    readPrompt,
    waitStats,
    snapshot: () => ({
      sequence,
      attempted: [...attempted],
      confirmed: [...confirmed],
      explanationAttempt: Object.fromEntries(explanationAttempt),
      waitStats: waitStats.snapshot(),
    }),
  });
}
