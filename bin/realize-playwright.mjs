#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { chromium } from "playwright-core";

import { groupAccountsByTeam, runTeamLanes } from "../src/parallel_scheduler.mjs";

const DEFAULT_BASE_URL = "https://frontend-eight-neon-73.vercel.app";
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const DEFAULT_REPOSITORY_URL = "https://github.com/Team-IZ/Backend";

export class AdaptiveNetworkWaits {
  constructor({ alpha = 0.35, minimumMs = 15_000, maximumMs = 300_000 } = {}) {
    this.alpha = alpha;
    this.minimumMs = minimumMs;
    this.maximumMs = maximumMs;
    this.categories = new Map();
  }

  state(category) {
    const seedMs = category === "answer" ? 60_000 : category === "home" ? 8_000 : 5_000;
    if (!this.categories.has(category)) this.categories.set(category, { ewmaMs: seedMs, samples: [], failures: 0 });
    return this.categories.get(category);
  }

  observe(category, elapsedMs) {
    const state = this.state(category);
    state.ewmaMs = this.alpha * elapsedMs + (1 - this.alpha) * state.ewmaMs;
    state.samples.push(elapsedMs);
    if (state.samples.length > 40) state.samples.shift();
    state.failures = Math.max(0, state.failures - 1);
  }

  failure(category) {
    this.state(category).failures += 1;
  }

  timeoutFor(category) {
    const state = this.state(category);
    const ordered = [...state.samples].sort((left, right) => left - right);
    const p95 = ordered.length > 0 ? ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)] : state.ewmaMs;
    const failureFactor = 1 + Math.min(state.failures, 5) * 0.5;
    const categoryMinimum = category === "answer" ? 120_000 : this.minimumMs;
    return Math.round(Math.min(this.maximumMs, Math.max(categoryMinimum, Math.max(state.ewmaMs * 4, p95 * 2.5) * failureFactor)));
  }

  retryDelayFor(category) {
    const state = this.state(category);
    return Math.round(Math.min(120_000, Math.max(5_000, state.ewmaMs * 0.5 * Math.max(1, state.failures))));
  }

  snapshot(category) {
    const state = this.state(category);
    return { ewmaMs: Math.round(state.ewmaMs), samples: state.samples.length, failures: state.failures, timeoutMs: this.timeoutFor(category) };
  }
}

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function parseArgs(argv) {
  const options = {
    className: "F반",
    startAt: 1,
    headless: true,
    baseUrl: DEFAULT_BASE_URL,
    chromePath: DEFAULT_CHROME,
    limit: Number.POSITIVE_INFINITY,
    repositoryUrl: DEFAULT_REPOSITORY_URL,
    repositoryBranch: "",
    prepareRepository: false,
    analysisTimeoutMs: 45 * 60_000,
    analysisPollMs: 15_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("MISSING_OPTION_VALUE", `${option} requires a value.`);
      index += 1;
      return value;
    };
    if (option === "--class") options.className = `${next().replace(/반$/u, "").toUpperCase()}반`;
    else if (option === "--start-at") options.startAt = Number(next());
    else if (option === "--limit") options.limit = Number(next());
    else if (option === "--base-url") options.baseUrl = next().replace(/\/$/u, "");
    else if (option === "--chrome") options.chromePath = next();
    else if (option === "--ledger") options.ledgerPath = resolve(next());
    else if (option === "--repo") options.repositoryUrl = next();
    else if (option === "--branch") options.repositoryBranch = next();
    else if (option === "--prepare-repository") options.prepareRepository = true;
    else if (option === "--analysis-timeout-minutes") options.analysisTimeoutMs = Number(next()) * 60_000;
    else if (option === "--analysis-poll-seconds") options.analysisPollMs = Number(next()) * 1_000;
    else if (option === "--headed") options.headless = false;
    else if (option === "--help" || option === "-h") options.help = true;
    else fail("UNKNOWN_OPTION", `Unknown option: ${option}`);
  }
  if (!Number.isInteger(options.startAt) || options.startAt < 1) fail("INVALID_START_AT", "--start-at must be a positive 1-based index.");
  if (!(options.limit === Number.POSITIVE_INFINITY || (Number.isInteger(options.limit) && options.limit > 0))) {
    fail("INVALID_LIMIT", "--limit must be a positive integer.");
  }
  canonicalRepository(options.repositoryUrl);
  if (!Number.isFinite(options.analysisTimeoutMs) || options.analysisTimeoutMs < 60_000) fail("INVALID_ANALYSIS_TIMEOUT", "--analysis-timeout-minutes must be at least 1.");
  if (!Number.isFinite(options.analysisPollMs) || options.analysisPollMs < 1_000) fail("INVALID_ANALYSIS_POLL", "--analysis-poll-seconds must be at least 1.");
  options.ledgerPath ??= resolve("runs", `playwright-${options.className}.ndjson`);
  return options;
}

export function canonicalRepository(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    fail("INVALID_REPOSITORY", "저장소는 일반 HTTPS GitHub owner/repository URL이어야 합니다.");
  }
  const segments = url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/iu, "").split("/");
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash || segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9._-]+$/u.test(segment))) {
    fail("INVALID_REPOSITORY", "저장소는 일반 HTTPS GitHub owner/repository URL이어야 합니다.");
  }
  return Object.freeze({
    url: `https://github.com/${segments[0]}/${segments[1]}`,
    slug: `${segments[0]}/${segments[1]}`,
    identity: `${segments[0]}/${segments[1]}`.toLowerCase(),
  });
}

export function classifyHomeState(body) {
  const text = String(body ?? "");
  if (text.includes("이해도 확인이 끝났어요") || text.includes("리포트를 기다리는 중이에요") || text.includes("다시 볼 수 있는 문제가 있어요")) return "complete";
  if (text.includes("이해도 확인이 진행 중이에요")) return "in_progress";
  if (text.includes("이해도 확인을 시작할 차례예요")) return "ready";
  if (text.includes("코드를 분석하지 못했어요")) return "analysis_failed";
  if (text.includes("코드 분석이 진행 중이에요")) return "analyzing";
  if (text.includes("코드를 제출할 차례예요")) return "submission_required";
  if (text.includes("제출 기한이 지났어요")) return "submission_closed";
  return "unknown";
}

export function parseTraineeButtonLabel(label, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^${escaped} (\\d+팀) (.+?)([A-Za-z][A-Za-z0-9._+-]*@[A-Za-z0-9.-]+)$`, "u").exec(label.trim());
  if (!match) return null;
  return Object.freeze({
    teamName: match[1],
    displayName: match[2],
    accountId: createHash("sha256").update(`${className}\0${match[1]}\0${match[2]}`).digest("hex").slice(0, 20),
  });
}

export function emit(event) {
  stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

const journalTails = new Map();

async function journal(path, event) {
  const previous = journalTails.get(path) ?? Promise.resolve();
  const current = previous.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { encoding: "utf8", mode: 0o600 });
  });
  journalTails.set(path, current.catch(() => {}));
  await current;
}

function apiMatches(request, { method, path }) {
  if (method && request.method() !== method) return false;
  const pathname = new URL(request.url()).pathname;
  return typeof path === "string" ? pathname === path : path.test(pathname);
}

export function isIgnorableRequestFailure(errorText) {
  return errorText === "net::ERR_ABORTED";
}

export function redactApiUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.pathname = url.pathname
    .replace(/(\/assessment-sessions\/)[^/]+/u, "$1:sessionId")
    .replace(/(\/assessment-rounds\/)[^/]+/u, "$1:roundId");
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function waitForApiOutcome(page, waits, { category, method, path, action }) {
  const timeoutMs = waits.timeoutFor(category);
  const startedAt = Date.now();
  let timeoutHandle;
  const response = page.waitForResponse((candidate) => apiMatches(candidate.request(), { method, path }), { timeout: timeoutMs })
    .then(async (candidate) => {
      await candidate.finished().catch(() => {});
      return { kind: "response", status: candidate.status(), ok: candidate.ok(), url: redactApiUrl(candidate.url()) };
    })
    .catch(() => new Promise(() => {}));
  const failed = page.waitForEvent("requestfailed", {
    predicate: (request) => apiMatches(request, { method, path }) && !isIgnorableRequestFailure(request.failure()?.errorText),
    timeout: timeoutMs,
  }).then((request) => ({ kind: "requestfailed", failure: request.failure()?.errorText ?? "request failed", url: redactApiUrl(request.url()) }))
    .catch(() => new Promise(() => {}));
  const timedOut = new Promise((resolveTimeout) => {
    timeoutHandle = setTimeout(() => resolveTimeout({ kind: "timeout" }), timeoutMs);
  });
  await action();
  const outcome = await Promise.race([response, failed, timedOut]);
  clearTimeout(timeoutHandle);
  const elapsedMs = Date.now() - startedAt;
  if (outcome.kind === "response" && outcome.ok) waits.observe(category, elapsedMs);
  else waits.failure(category);
  emit({ event: "network", category, elapsedMs, outcome, adaptive: waits.snapshot(category) });
  return outcome;
}

async function waitForHome(page, expectedName, waits) {
  const timeout = waits.timeoutFor("home");
  await page.waitForURL("**/trainee/home", { timeout });
  await page.getByText(`${expectedName} · 교육생`, { exact: false }).first().waitFor({ timeout });
  await page.getByText("지금 할 일", { exact: true }).waitFor({ timeout });
}

async function loginAs(page, options, account, waits) {
  const accountPrefix = `${options.className} ${account.teamName} ${account.displayName}`;
  let lastOutcome;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${options.baseUrl}/shared/login`, { waitUntil: "domcontentloaded", timeout: waits.timeoutFor("home") });
    await page.getByRole("button", { name: /케이스별 계정/u }).click();
    await page.getByRole("button", { name: new RegExp(`^${options.className}\\d+$`, "u") }).click();
    lastOutcome = await waitForApiOutcome(page, waits, {
      category: "home",
      method: "GET",
      path: "/api/v0/assessment-rounds",
      action: () => page.getByRole("button", { name: new RegExp(`^${accountPrefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u") }).click(),
    });
    if (lastOutcome.kind === "response" && lastOutcome.ok) {
      await waitForHome(page, account.displayName, waits);
      return;
    }
    const reconciled = await waitForHome(page, account.displayName, waits).then(() => true).catch(() => false);
    if (reconciled) {
      emit({ event: "login_reconciled", className: options.className, teamName: account.teamName, accountId: account.accountId, attempt });
      return;
    }
    if (attempt < 2) {
      const delayMs = waits.retryDelayFor("home");
      emit({ event: "login_retry", className: options.className, teamName: account.teamName, accountId: account.accountId, attempt: attempt + 1, delayMs, outcome: lastOutcome });
      await page.waitForTimeout(delayMs);
    }
  }
  fail("LOGIN_NETWORK_FAILED", "로그인 뒤 회차 정보를 받지 못했습니다.", { outcome: lastOutcome, adaptive: waits.snapshot("home") });
}

function bodyContainsRepository(body, repository) {
  const normalized = String(body ?? "").normalize("NFKC").toLowerCase();
  return normalized.includes(repository.identity) || normalized.includes(repository.url.toLowerCase());
}

async function openSubmissionPage(page, options, waits) {
  await page.goto(`${options.baseUrl}/trainee/submission`, { waitUntil: "domcontentloaded", timeout: waits.timeoutFor("home") });
  await page.getByRole("heading", { name: /코드 제출$/u }).waitFor({ timeout: waits.timeoutFor("home") });
  await page.waitForTimeout(300);
  return page.locator("body").innerText();
}

function submissionPageState(body) {
  if (body.includes("코드를 분석하지 못했어요")) return "analysis_failed";
  if (body.includes("분석이 끝났어요") || body.includes("이제 다시 제출할 수 없어요")) return "ready";
  if (body.includes("제출됐어요. 코드를 분석하고 있습니다") || body.includes("제출 완료")) return "analyzing";
  if (body.includes("제출 기한이 지났어요")) return "submission_closed";
  if (body.includes("저장소 주소") && body.includes("주소 확인")) return "draft";
  return "unknown";
}

async function inspectExpectedRepository(page, options, waits, repository) {
  const body = await openSubmissionPage(page, options, waits);
  const state = submissionPageState(body);
  if (!["draft", "submission_closed", "unknown"].includes(state) && !bodyContainsRepository(body, repository)) {
    fail("REPOSITORY_MISMATCH", "현재 팀에 제출된 저장소가 요청한 저장소와 다릅니다.", { expectedRepository: repository.slug, state });
  }
  if (state === "analysis_failed") {
    const failureText = body.split("\n").filter(Boolean).slice(0, 30).join("\n");
    fail("ANALYSIS_FAILED", "제출된 저장소의 코드 분석이 실패했습니다.", { expectedRepository: repository.slug, visibleText: failureText.slice(0, 1_500) });
  }
  if (state === "submission_closed") fail("SUBMISSION_CLOSED", "저장소 제출 기한이 지났습니다.");
  if (state === "unknown") fail("UNKNOWN_SUBMISSION_STATE", "처리하지 않은 코드 제출 화면입니다.", { visibleText: body.slice(0, 1_500) });
  return { state, body };
}

async function submitRepository(page, options, account, waits, repository) {
  const body = await openSubmissionPage(page, options, waits);
  if (submissionPageState(body) !== "draft") return inspectExpectedRepository(page, options, waits, repository);
  const input = page.locator("#repo-url");
  await input.waitFor({ state: "visible", timeout: waits.timeoutFor("home") });
  await pressVerified(input, repository.url);
  const checkOutcome = await waitForApiOutcome(page, waits, {
    category: "repository_check",
    method: "POST",
    path: "/api/v0/submissions/repository-checks",
    action: () => page.getByRole("button", { name: "주소 확인", exact: true }).click(),
  });
  if (checkOutcome.kind !== "response" || !checkOutcome.ok) fail("REPOSITORY_CHECK_FAILED", "GitHub 저장소 주소 확인에 실패했습니다.", { outcome: checkOutcome });
  await page.getByText(new RegExp(`${repository.slug.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} 확인했어요`, "iu")).waitFor({ timeout: waits.timeoutFor("repository_check") });
  if (options.repositoryBranch) await pressVerified(page.locator("#repo-branch"), options.repositoryBranch);
  const submitButton = page.getByRole("button", { name: "제출", exact: true });
  if (!(await submitButton.isEnabled())) fail("REPOSITORY_SUBMIT_DISABLED", "저장소 제출 버튼이 활성화되지 않았습니다.");
  await journal(options.ledgerPath, { event: "team_submission_intent", teamName: account.teamName, accountId: account.accountId, repository: repository.identity, branch: options.repositoryBranch || null });
  const submitOutcome = await waitForApiOutcome(page, waits, {
    category: "repository_submit",
    method: "POST",
    path: "/api/v0/submissions",
    action: () => submitButton.click(),
  });
  if (submitOutcome.kind !== "response" || !submitOutcome.ok) fail("REPOSITORY_SUBMIT_FAILED", "저장소 제출 응답을 확인하지 못했습니다.", { outcome: submitOutcome });
  await page.getByText(/제출됐어요|제출 완료/u).first().waitFor({ timeout: waits.timeoutFor("repository_submit") });
  const inspected = await inspectExpectedRepository(page, options, waits, repository);
  await journal(options.ledgerPath, { event: "team_submission_submitted_unverified", teamName: account.teamName, accountId: account.accountId, repository: repository.identity });
  emit({ event: "team_submission", className: options.className, teamName: account.teamName, accountId: account.accountId, repository: repository.slug, status: "submitted_unverified" });
  return { ...inspected, submitted: true };
}

async function currentHomeState(page) {
  await page.waitForTimeout(300);
  return classifyHomeState(await page.locator("body").innerText());
}

async function waitForAnalysisReady(page, options, account, waits) {
  const deadline = Date.now() + options.analysisTimeoutMs;
  let polls = 0;
  while (Date.now() < deadline) {
    await page.goto(`${options.baseUrl}/trainee/home`, { waitUntil: "domcontentloaded", timeout: waits.timeoutFor("home") });
    await waitForHome(page, account.displayName, waits);
    const state = await currentHomeState(page);
    emit({ event: "analysis_state", className: options.className, teamName: account.teamName, accountId: account.accountId, state, polls });
    if (["ready", "in_progress", "complete"].includes(state)) return state;
    if (state === "analysis_failed") fail("ANALYSIS_FAILED", "저장소 코드 분석이 실패했습니다.", { teamName: account.teamName });
    if (state !== "analyzing") fail("ANALYSIS_STATE_CHANGED", "분석 대기 중 예상하지 못한 홈 상태로 바뀌었습니다.", { state, teamName: account.teamName });
    polls += 1;
    const jitter = 0.85 + Math.random() * 0.3;
    await page.waitForTimeout(Math.min(deadline - Date.now(), Math.round(options.analysisPollMs * jitter)));
  }
  fail("ANALYSIS_TIMEOUT", "분석 준비 제한 시간을 초과했습니다.", { teamName: account.teamName, timeoutMs: options.analysisTimeoutMs });
}

export async function preparePlaywrightTeam({ browser, options, accounts, waits = new AdaptiveNetworkWaits() }) {
  if (!Array.isArray(accounts) || accounts.length === 0) fail("EMPTY_TEAM", "팀 준비에 사용할 교육생 계정이 없습니다.");
  const representative = accounts[0];
  const verifier = accounts.find((account) => account.accountId !== representative.accountId);
  const repository = canonicalRepository(options.repositoryUrl);
  const representativeContext = await browser.newContext();
  try {
    const page = await representativeContext.newPage();
    emit({ event: "team_prepare_start", className: options.className, teamName: representative.teamName, accountId: representative.accountId, repository: repository.slug });
    await loginAs(page, options, representative, waits);
    const initialState = await currentHomeState(page);
    let submission;
    if (initialState === "submission_required") submission = await submitRepository(page, options, representative, waits, repository);
    else if (initialState === "analysis_failed") fail("ANALYSIS_FAILED", "대표 계정에서 저장소 분석 실패 상태를 확인했습니다.", { teamName: representative.teamName });
    else if (["analyzing", "ready", "in_progress", "complete"].includes(initialState)) submission = await inspectExpectedRepository(page, options, waits, repository);
    else if (initialState === "submission_closed") fail("SUBMISSION_CLOSED", "저장소 제출 기한이 지났습니다.", { teamName: representative.teamName });
    else fail("UNKNOWN_TEAM_STATE", "팀 대표 계정의 홈 상태를 판정하지 못했습니다.", { visibleText: (await page.locator("body").innerText()).slice(0, 1_500) });

    if (!verifier) fail("TEAM_CONFIRMATION_UNAVAILABLE", "팀 제출 상태를 확인할 두 번째 교육생 계정이 없습니다.", { teamName: representative.teamName });
    const verifierContext = await browser.newContext();
    try {
      const verifierPage = await verifierContext.newPage();
      await loginAs(verifierPage, options, verifier, new AdaptiveNetworkWaits());
      let verifierState = await currentHomeState(verifierPage);
      for (let confirmationAttempt = 0; verifierState === "submission_required" && confirmationAttempt < 3; confirmationAttempt += 1) {
        await verifierPage.waitForTimeout(Math.min(10_000, options.analysisPollMs));
        await verifierPage.reload({ waitUntil: "domcontentloaded", timeout: waits.timeoutFor("home") });
        await waitForHome(verifierPage, verifier.displayName, waits);
        verifierState = await currentHomeState(verifierPage);
      }
      if (["submission_required", "submission_closed", "unknown"].includes(verifierState)) {
        fail("TEAM_SUBMISSION_UNCONFIRMED", "두 번째 팀원 계정에서 팀 저장소 제출 상태를 확인하지 못했습니다.", { teamName: representative.teamName, verifierState });
      }
      await inspectExpectedRepository(verifierPage, options, new AdaptiveNetworkWaits(), repository);
      await journal(options.ledgerPath, { event: "team_submission_confirmed", teamName: representative.teamName, representativeAccountId: representative.accountId, verifierAccountId: verifier.accountId, repository: repository.identity, origin: submission.submitted ? "this_run" : "preexisting" });
      emit({ event: "team_submission", className: options.className, teamName: representative.teamName, repository: repository.slug, status: "confirmed", origin: submission.submitted ? "this_run" : "preexisting" });
    } finally {
      await verifierContext.close();
    }

    const state = await waitForAnalysisReady(page, options, representative, waits);
    await journal(options.ledgerPath, { event: "team_analysis_ready", teamName: representative.teamName, accountId: representative.accountId, repository: repository.identity, state });
    emit({ event: "team_prepare_result", className: options.className, teamName: representative.teamName, repository: repository.slug, status: "ready", state });
    return { status: "ready", state, submitted: submission.submitted === true };
  } finally {
    await representativeContext.close();
  }
}

export async function discoverRoster(browser, options) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${options.baseUrl}/shared/login`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.getByRole("button", { name: /케이스별 계정/u }).click();
    const classButton = page.getByRole("button", { name: new RegExp(`^${options.className}\\d+$`, "u") });
    await classButton.click();
    const labels = await page.getByRole("button").allTextContents();
    const accounts = labels.map((label) => parseTraineeButtonLabel(label, options.className)).filter(Boolean);
    if (accounts.length === 0) fail("EMPTY_ROSTER", `${options.className} 교육생 계정을 찾지 못했습니다.`);
    return accounts;
  } finally {
    await context.close();
  }
}

async function pressVerified(textarea, answer) {
  await textarea.press("ControlOrMeta+A");
  await textarea.press("Backspace");
  if (await textarea.inputValue() !== "") fail("TEXTAREA_CLEAR_FAILED", "답변 입력란을 비우지 못했습니다.");
  const characters = Array.from(answer);
  for (let index = 0; index < characters.length; index += 14) {
    const chunk = characters.slice(index, index + 14).join("");
    await textarea.pressSequentially(chunk, { delay: 7 });
    const expected = characters.slice(0, index + 14).join("");
    if ((await textarea.inputValue()).normalize("NFC") !== expected.normalize("NFC")) {
      fail("TEXTAREA_MISMATCH", "실제 키 입력 뒤 답변 값이 일치하지 않습니다.");
    }
  }
}

export function promptFingerprint(visibleText, code) {
  const stableText = visibleText
    .replace(/이 문제 \d{2}:\d{2}:\d{2} 남음/gu, "이 문제 <time> 남음")
    .replace(/^\d+자$/gmu, "<characters>")
    .replace(/^\d+번 남음$/gmu, "<retries>");
  return `sha256:${createHash("sha256").update(JSON.stringify({ visibleText: stableText, code })).digest("hex")}`;
}

async function capturePrompt(page) {
  const main = page.locator("main");
  const visibleText = ((await main.count()) ? await main.innerText() : await page.locator("body").innerText()).trim();
  const code = await page.locator("pre, code").allTextContents();
  const fingerprint = promptFingerprint(visibleText, code);
  return { visibleText, code, fingerprint };
}

async function askForAnswer(answerProvider, account, page, attempt) {
  const { visibleText, code, fingerprint } = await capturePrompt(page);
  const answer = String(await answerProvider({
    account: { className: account.className, teamName: account.teamName, displayName: account.displayName, accountId: account.accountId },
    attempt,
    fingerprint,
    visibleText,
    code,
  })).normalize("NFC").trim();
  if (!answer) fail("EMPTY_ANSWER", "답변이 비어 있습니다.");
  return { answer, fingerprint };
}

async function waitForRenderedState(page, previousText, waits, category) {
  const timeout = Math.min(60_000, Math.max(5_000, waits.timeoutFor(category) / 3));
  await page.waitForFunction((before) => document.body.innerText !== before, previousText, { timeout });
}

export function isProblemHandoffUi(previousText, currentText, hasVisibleTextarea) {
  return currentText !== previousText && (hasVisibleTextarea || currentText.includes("끝났어요"));
}

async function waitForProblemHandoff(page, waits, handoff, previousText) {
  const timeoutMs = waits.timeoutFor("problem");
  const startedAt = Date.now();
  let timeoutHandle;
  const response = page.waitForResponse((candidate) => apiMatches(candidate.request(), {
    method: "GET",
    path: /\/api\/v0\/assessment-sessions\/(?:current|[^/]+(?:\/problems\/\d+)?)$/u,
  }), { timeout: timeoutMs }).then(async (candidate) => {
    await candidate.finished().catch(() => {});
    return { kind: "response", status: candidate.status(), ok: candidate.ok(), url: redactApiUrl(candidate.url()) };
  }).catch(() => new Promise(() => {}));
  const ui = page.waitForFunction((before) => {
    const current = document.body.innerText;
    const textarea = [...document.querySelectorAll("textarea")].some((element) => {
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none";
    });
    return current !== before && (textarea || current.includes("끝났어요"));
  }, previousText, { timeout: timeoutMs }).then(() => ({ kind: "ui_transition", ok: true })).catch(() => new Promise(() => {}));
  const timedOut = new Promise((resolveTimeout) => {
    timeoutHandle = setTimeout(() => resolveTimeout({ kind: "timeout" }), timeoutMs);
  });
  await handoff.click();
  const outcome = await Promise.race([response, ui, timedOut]);
  clearTimeout(timeoutHandle);
  const elapsedMs = Date.now() - startedAt;
  if (outcome.ok) waits.observe("problem", elapsedMs);
  else waits.failure("problem");
  emit({ event: "handoff", elapsedMs, outcome, adaptive: waits.snapshot("problem") });
  return outcome;
}

async function reconcileAnswerAfterFailure(page, waits, fingerprint) {
  const delayMs = waits.retryDelayFor("answer");
  emit({ event: "answer_reconcile_wait", delayMs });
  await page.waitForTimeout(delayMs);
  const outcome = await waitForApiOutcome(page, waits, {
    category: "session",
    method: "GET",
    path: /\/api\/v0\/assessment-sessions\/(?:current|[^/]+(?:\/problems\/\d+)?)$/u,
    action: () => page.reload({ waitUntil: "domcontentloaded", timeout: waits.timeoutFor("session") }),
  });
  if (outcome.kind !== "response" || !outcome.ok) {
    fail("ANSWER_RECONCILE_NETWORK_FAILED", "답변 실패 후 세션 상태를 재조회하지 못했습니다.", { outcome });
  }
  await page.waitForTimeout(500);
  const body = await page.locator("body").innerText();
  if (body.includes("끝났어요") || body.includes("채점하는 중")) return { reflected: true, state: "advanced" };
  const textarea = page.locator("textarea:visible").first();
  if (!(await textarea.isVisible().catch(() => false))) return { reflected: true, state: "advanced" };
  const current = await capturePrompt(page);
  return { reflected: current.fingerprint !== fingerprint, state: current.fingerprint === fingerprint ? "same_prompt" : "next_prompt" };
}

async function runAssessment(page, answerProvider, options, account, waits) {
  let body = await page.locator("body").innerText();
  if (classifyHomeState(body) === "complete") return { status: "complete", skipped: true };
  const continuing = body.includes("이해도 확인이 진행 중이에요");
  if (!continuing && !body.includes("이해도 확인을 시작할 차례예요")) {
    fail("ACCOUNT_NOT_READY", "현재 계정은 이해도 확인 시작 상태가 아닙니다.", { visibleText: body.slice(0, 1_500) });
  }
  if (continuing) {
    const outcome = await waitForApiOutcome(page, waits, {
      category: "session",
      method: "GET",
      path: /\/api\/v0\/assessment-sessions\/(?:current|[^/]+\/problems\/\d+)$/u,
      action: () => page.getByRole("button", { name: "이어서 하기", exact: true }).click(),
    });
    if (outcome.kind !== "response" || !outcome.ok) fail("SESSION_RESUME_NETWORK_FAILED", "진행 중 세션 정보를 받지 못했습니다.", { outcome });
    await page.waitForURL("**/trainee/session", { timeout: waits.timeoutFor("session") });
  } else {
    await page.locator("a,button").filter({ hasText: "이해도 확인 시작하기" }).first().click();
    await page.waitForURL("**/trainee/session", { timeout: 15_000 });
    await page.waitForTimeout(800);

    const checkbox = page.locator("input[type=checkbox]");
    const checkboxControl = page.getByRole("checkbox").first();
    if (await checkboxControl.isVisible().catch(() => false)) await checkboxControl.click();
    else if (await checkbox.count()) await checkbox.setChecked(true, { force: true });
    if (await checkbox.count() && !(await checkbox.isChecked())) {
      fail("READY_CHECKBOX_FAILED", "세션 준비 확인란이 선택되지 않았습니다.");
    }
    const fullscreen = page.getByRole("button", { name: "전체화면으로 시작하기", exact: true });
    if (await fullscreen.isVisible().catch(() => false)) {
      const outcome = await waitForApiOutcome(page, waits, {
        category: "session",
        method: "POST",
        path: /\/api\/v0\/assessment-sessions\/[^/]+\/start$/u,
        action: () => fullscreen.click(),
      });
      if (outcome.kind !== "response" || !outcome.ok) fail("SESSION_START_NETWORK_FAILED", "세션 시작 응답을 받지 못했습니다.", { outcome });
    }
  }

  let attempt = 0;
  let pendingAnswer = null;
  let consecutiveAnswerFailures = 0;
  let consecutiveUnknownStates = 0;
  for (let step = 0; step < 120; step += 1) {
    await page.waitForTimeout(500);
    body = await page.locator("body").innerText();
    if (!body.trim()) {
      await page.waitForFunction(() => document.body.innerText.trim().length > 0, undefined, { timeout: 30_000 });
      body = await page.locator("body").innerText();
    }
    if (body.includes("끝났어요. 수고했어요") || body.includes("이해도 확인이 끝났어요")) {
      await journal(options.ledgerPath, { event: "account_complete", accountId: account.accountId, teamName: account.teamName });
      return { status: "complete", skipped: false };
    }
    if (body.includes("채점하는 중")) {
      consecutiveUnknownStates = 0;
      await page.getByText("채점하는 중", { exact: false }).first().waitFor({ state: "hidden", timeout: waits.timeoutFor("answer") }).catch(() => {});
      continue;
    }
    const fullscreen = page.getByRole("button", { name: "전체화면으로 시작하기", exact: true });
    if (await fullscreen.isVisible().catch(() => false)) {
      consecutiveUnknownStates = 0;
      const checkbox = page.locator("input[type=checkbox]").first();
      const checkboxControl = page.getByRole("checkbox").first();
      if (await checkboxControl.isVisible().catch(() => false)) await checkboxControl.check();
      else if (await checkbox.count()) await checkbox.setChecked(true, { force: true });
      if (!(await fullscreen.isEnabled())) fail("READY_CHECKBOX_FAILED", "세션 준비 확인란이 선택되지 않았습니다.");
      const outcome = await waitForApiOutcome(page, waits, {
        category: "session",
        method: "POST",
        path: /\/api\/v0\/assessment-sessions\/[^/]+\/start$/u,
        action: () => fullscreen.click(),
      });
      if (outcome.kind !== "response" || !outcome.ok) fail("SESSION_START_NETWORK_FAILED", "세션 시작 응답을 받지 못했습니다.", { outcome });
      continue;
    }
    const textarea = page.locator("textarea:visible").first();
    if (await textarea.isVisible().catch(() => false)) {
      consecutiveUnknownStates = 0;
      if (!pendingAnswer) pendingAnswer = await askForAnswer(answerProvider, account, page, attempt);
      const { answer, fingerprint } = pendingAnswer;
      if ((await textarea.inputValue()).normalize("NFC") !== answer.normalize("NFC")) await pressVerified(textarea, answer);
      const submit = page.getByRole("button", { name: /^(답변 제출|답변 제출하고 마치기)$/u }).first();
      if (!(await submit.isEnabled())) fail("BUTTON_DISABLED", "답변 제출 버튼이 비활성입니다.");
      const label = (await submit.innerText()).trim();
      const answerDigest = `sha256:${createHash("sha256").update(answer).digest("hex")}`;
      await journal(options.ledgerPath, { event: "answer_submit_intent", accountId: account.accountId, teamName: account.teamName, fingerprint, attempt, answerDigest, label });
      const before = body;
      const outcome = await waitForApiOutcome(page, waits, {
        category: "answer",
        method: "POST",
        path: /\/api\/v0\/assessment-sessions\/[^/]+\/answers$/u,
        action: () => submit.click(),
      });
      if (outcome.kind !== "response" || !outcome.ok) {
        consecutiveAnswerFailures += 1;
        const reconciliation = await reconcileAnswerAfterFailure(page, waits, fingerprint);
        if (reconciliation.reflected) {
          await journal(options.ledgerPath, { event: "answer_submit_reconciled", accountId: account.accountId, teamName: account.teamName, fingerprint, attempt, outcome });
          emit({ event: "answer_reconciled", accountId: account.accountId, fingerprint, attempt, outcome, state: reconciliation.state });
          consecutiveAnswerFailures = 0;
          pendingAnswer = null;
          attempt += 1;
          continue;
        }
        if (consecutiveAnswerFailures >= 3) {
          fail("ANSWER_API_REPEATED_FAILURE", "답변 API가 연속 3회 실패해 현재 계정을 보존한 채 중단합니다.", { outcome, adaptive: waits.snapshot("answer") });
        }
        emit({ event: "answer_retry", accountId: account.accountId, fingerprint, attempt, delayMs: 0, outcome, reconciledState: reconciliation.state });
        continue;
      }
      await waitForRenderedState(page, before, waits, "answer").catch(() => {});
      await journal(options.ledgerPath, { event: "answer_submit_confirmed", accountId: account.accountId, teamName: account.teamName, fingerprint, attempt });
      consecutiveAnswerFailures = 0;
      pendingAnswer = null;
      attempt += 1;
      continue;
    }
    const handoff = page.getByRole("button", { name: "시작하기", exact: true });
    if (await handoff.isVisible().catch(() => false)) {
      consecutiveUnknownStates = 0;
      await journal(options.ledgerPath, { event: "handoff_intent", accountId: account.accountId, teamName: account.teamName });
      const before = body;
      const outcome = await waitForProblemHandoff(page, waits, handoff, before);
      if (!outcome.ok) fail("PROBLEM_NETWORK_FAILED", "다음 코드 포인트 정보를 받지 못했습니다.", { outcome });
      await waitForRenderedState(page, before, waits, "problem");
      await journal(options.ledgerPath, { event: "handoff_confirmed", accountId: account.accountId, teamName: account.teamName });
      attempt = 0;
      continue;
    }
    consecutiveUnknownStates += 1;
    if (consecutiveUnknownStates <= 20) {
      if (consecutiveUnknownStates === 1) emit({ event: "session_state_wait", className: options.className, teamName: account.teamName, accountId: account.accountId });
      await page.waitForTimeout(500);
      continue;
    }
    fail("UNKNOWN_SESSION_STATE", "처리하지 않은 세션 화면입니다.", { visibleText: body.slice(0, 2_000) });
  }
  fail("STEP_LIMIT", "세션 단계 제한을 초과했습니다.");
}

export async function runPlaywrightAccount({ browser, options, account, answerProvider, waits = new AdaptiveNetworkWaits() }) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    emit({ event: "account_start", className: options.className, teamName: account.teamName, displayName: account.displayName, accountId: account.accountId });
    await loginAs(page, options, account, waits);
    const result = await runAssessment(page, answerProvider, options, account, waits);
    emit({ event: "account_result", className: options.className, teamName: account.teamName, displayName: account.displayName, accountId: account.accountId, ...result });
    return { accountId: account.accountId, teamName: account.teamName, ...result };
  } finally {
    await context.close();
  }
}

export async function runPlaywrightClass({ browser, options, answerProvider, teamConcurrency = 1, dryRun = false }) {
  if (!Number.isInteger(teamConcurrency) || teamConcurrency < 1) fail("INVALID_TEAM_CONCURRENCY", "teamConcurrency must be a positive integer.");
  const roster = (await discoverRoster(browser, options)).map((account) => ({ ...account, className: options.className }));
  const selected = roster
    .slice(options.startAt - 1, options.startAt - 1 + options.limit)
    .map((account) => ({ ...account }));
  if (selected.length === 0) fail("EMPTY_SELECTION", "선택 범위에 교육생 계정이 없습니다.", { className: options.className, startAt: options.startAt });
  const groups = groupAccountsByTeam(selected);
  const fullGroups = new Map(groupAccountsByTeam(roster).map((group) => [group.teamName, group]));
  emit({
    event: "plan",
    className: options.className,
    rosterCount: roster.length,
    selectedCount: selected.length,
    teamCount: groups.length,
    teamConcurrency: Math.min(teamConcurrency, groups.length),
    startAt: options.startAt,
    prepareRepository: options.prepareRepository === true,
    repository: options.prepareRepository ? canonicalRepository(options.repositoryUrl).slug : null,
    dryRun,
    selected: selected.map(({ teamName, displayName, accountId }) => ({ teamName, displayName, accountId })),
  });
  if (dryRun) return { className: options.className, status: "planned", rosterCount: roster.length, selectedCount: selected.length, teamCount: groups.length, failedTeams: 0 };

  const results = await runTeamLanes({
    groups,
    concurrency: teamConcurrency,
    prepareTeam: options.prepareRepository
      ? async (group) => preparePlaywrightTeam({
        browser,
        options,
        accounts: fullGroups.get(group.teamName)?.accounts ?? group.accounts,
        waits: new AdaptiveNetworkWaits(),
      })
      : null,
    runAccount: async (account) => runPlaywrightAccount({ browser, options, account, answerProvider, waits: new AdaptiveNetworkWaits() }),
  });
  for (const result of results) {
    if (result.status === "failed") {
      emit({
        event: "team_failed",
        className: options.className,
        teamName: result.teamName,
        phase: result.phase,
        accountId: result.failedAccount?.accountId ?? null,
        code: result.error?.code ?? "PLAYWRIGHT_TEAM_FAILED",
        message: result.error?.message ?? String(result.error),
        details: result.error?.details ?? {},
      });
    }
  }
  const summary = {
    className: options.className,
    status: results.some((result) => result.status === "failed") ? "partial" : "complete",
    rosterCount: roster.length,
    selectedCount: selected.length,
    teamCount: groups.length,
    completedAccounts: results.reduce((count, result) => count + result.completed.length, 0),
    failedTeams: results.filter((result) => result.status === "failed").length,
  };
  emit({ event: "class_result", ...summary });
  return summary;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    stdout.write(`Usage: npm run playwright:class -- --class F --start-at 3 [--limit N] [--headed]\n`);
    return;
  }
  const browser = await chromium.launch({ headless: options.headless, executablePath: options.chromePath });
  const reader = createInterface({ input: stdin, output: stdout });
  const answerProvider = async (payload) => {
    emit({ event: "answer_required", ...payload });
    return reader.question("ANSWER> ");
  };
  try {
    const result = await runPlaywrightClass({ browser, options, answerProvider, teamConcurrency: 1 });
    if (result.failedTeams > 0) fail("PLAYWRIGHT_CLASS_PARTIAL", "하나 이상의 팀 lane이 실패했습니다.", { summary: result });
  } finally {
    reader.close();
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    emit({ event: "failed", code: error.code ?? "PLAYWRIGHT_BATCH_FAILED", message: error.message, details: error.details ?? {} });
    process.exitCode = 1;
  });
}

export { main, parseArgs };
