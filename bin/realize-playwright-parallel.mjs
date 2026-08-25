#!/usr/bin/env node

import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { chromium } from "playwright-core";

import { createGmiAnswerProvider } from "../src/gmi_answer_provider.mjs";
import { canonicalRepository, DEFAULT_REPOSITORY_URL, emit, runPlaywrightClass } from "./realize-playwright.mjs";
import { ExactAnswerMemo, mapConcurrent, normalizeClassList, SerialAnswerBroker } from "../src/parallel_scheduler.mjs";
import { desiredHintCount, fixedScenarioAnswer, parseScenarioAssignments, scenarioPayload } from "../src/qa_scenarios.mjs";

const DEFAULT_BASE_URL = "https://frontend-eight-neon-73.vercel.app";
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

export function parseParallelArgs(argv) {
  const options = {
    classConcurrency: undefined,
    teamConcurrency: 5,
    startAt: 1,
    limitPerClass: Number.POSITIVE_INFINITY,
    headless: true,
    baseUrl: DEFAULT_BASE_URL,
    chromePath: DEFAULT_CHROME,
    ledgerDir: resolve("runs"),
    dryRun: false,
    yes: false,
    answerProvider: "manual",
    prepareRepository: false,
    repositoryUrl: DEFAULT_REPOSITORY_URL,
    repositoryBranch: "",
    analysisTimeoutMs: 45 * 60_000,
    analysisPollMs: 15_000,
    llmConcurrency: 8,
    llmTimeoutMs: 90_000,
    llmMaxAttempts: 4,
    gmiModel: null,
    gmiApiUrl: null,
    envFile: resolve(".env"),
    scenarioSpecs: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("MISSING_OPTION_VALUE", `${option} requires a value.`);
      index += 1;
      return value;
    };
    if (option === "--classes") options.classes = normalizeClassList(next());
    else if (option === "--class-concurrency") options.classConcurrency = Number(next());
    else if (option === "--team-concurrency") options.teamConcurrency = Number(next());
    else if (option === "--start-at") options.startAt = Number(next());
    else if (option === "--limit-per-class") options.limitPerClass = Number(next());
    else if (option === "--base-url") options.baseUrl = next().replace(/\/$/u, "");
    else if (option === "--chrome") options.chromePath = next();
    else if (option === "--ledger-dir") options.ledgerDir = resolve(next());
    else if (option === "--repo") options.repositoryUrl = next();
    else if (option === "--branch") options.repositoryBranch = next();
    else if (option === "--prepare-repository") options.prepareRepository = true;
    else if (option === "--answer-provider") options.answerProvider = next().toLowerCase();
    else if (option === "--autonomous") {
      options.answerProvider = "gmi";
      options.prepareRepository = true;
    }
    else if (option === "--analysis-timeout-minutes") options.analysisTimeoutMs = Number(next()) * 60_000;
    else if (option === "--analysis-poll-seconds") options.analysisPollMs = Number(next()) * 1_000;
    else if (option === "--llm-concurrency") options.llmConcurrency = Number(next());
    else if (option === "--llm-timeout-seconds") options.llmTimeoutMs = Number(next()) * 1_000;
    else if (option === "--llm-max-attempts") options.llmMaxAttempts = Number(next());
    else if (option === "--gmi-model") options.gmiModel = next();
    else if (option === "--gmi-api-url") options.gmiApiUrl = next();
    else if (option === "--env-file") options.envFile = resolve(next());
    else if (option === "--scenario") options.scenarioSpecs.push(next());
    else if (option === "--headed") options.headless = false;
    else if (option === "--dry-run") options.dryRun = true;
    else if (option === "--yes") options.yes = true;
    else if (option === "--help" || option === "-h") options.help = true;
    else fail("UNKNOWN_OPTION", `Unknown option: ${option}`);
  }
  if (options.help) return options;
  if (!options.classes) fail("MISSING_CLASSES", "--classes is required; for example --classes A,B,C,D,E,F.");
  options.classConcurrency ??= options.classes.length;
  for (const [name, value] of [["--class-concurrency", options.classConcurrency], ["--team-concurrency", options.teamConcurrency], ["--start-at", options.startAt]]) {
    if (!Number.isInteger(value) || value < 1) fail("INVALID_CONCURRENCY", `${name} must be a positive integer.`);
  }
  if (!(options.limitPerClass === Number.POSITIVE_INFINITY || (Number.isInteger(options.limitPerClass) && options.limitPerClass > 0))) {
    fail("INVALID_LIMIT", "--limit-per-class must be a positive integer.");
  }
  if (!["manual", "gmi"].includes(options.answerProvider)) fail("INVALID_ANSWER_PROVIDER", "--answer-provider must be manual or gmi.");
  if (options.scenarioSpecs.length > 0 && options.answerProvider !== "gmi") fail("SCENARIO_REQUIRES_GMI", "--scenario requires --autonomous or --answer-provider gmi.");
  options.scenarioMap = parseScenarioAssignments(options.scenarioSpecs, options.classes);
  canonicalRepository(options.repositoryUrl);
  if (!Number.isFinite(options.analysisTimeoutMs) || options.analysisTimeoutMs < 60_000) fail("INVALID_ANALYSIS_TIMEOUT", "--analysis-timeout-minutes must be at least 1.");
  if (!Number.isFinite(options.analysisPollMs) || options.analysisPollMs < 1_000) fail("INVALID_ANALYSIS_POLL", "--analysis-poll-seconds must be at least 1.");
  for (const [name, value] of [["--llm-concurrency", options.llmConcurrency], ["--llm-max-attempts", options.llmMaxAttempts]]) {
    if (!Number.isInteger(value) || value < 1) fail("INVALID_LLM_OPTION", `${name} must be a positive integer.`);
  }
  if (!Number.isInteger(options.llmTimeoutMs) || options.llmTimeoutMs < 1_000) fail("INVALID_LLM_OPTION", "--llm-timeout-seconds must be at least 1.");
  if (!options.dryRun && !options.yes) fail("LIVE_CONFIRMATION_REQUIRED", "Live parallel execution requires --yes. Run --dry-run first.");
  return options;
}

function publicAccount(account) {
  return {
    className: account.className,
    teamName: account.teamName,
    displayName: account.displayName,
    accountId: account.accountId,
  };
}

export async function main(argv) {
  const options = parseParallelArgs(argv);
  if (options.help) {
    stdout.write("Autonomous: npm run autonomous -- --classes D,F,H,C,I,J,E,G --scenario excellent:D,F --scenario moderate:H,C --scenario struggling:I,J --scenario inactive:E,G --yes\n");
    stdout.write("Manual: npm run playwright:parallel -- --classes A,B,C,D,E,F --class-concurrency 6 --team-concurrency 5 --yes [--headed]\n");
    stdout.write("Preview: npm run autonomous -- --classes A,B,C,D,E,F --dry-run\n");
    return;
  }

  let browser = null;
  const reader = !options.dryRun && options.answerProvider === "manual" ? createInterface({ input: stdin, output: stdout }) : null;
  try {
    const broker = reader ? new SerialAnswerBroker({
      ask: ({ requestId }) => reader.question(`ANSWER[${requestId}]> `),
      onQueued: ({ requestId, waiting, payload }) => emit({ event: "answer_queued", requestId, waiting, account: publicAccount(payload.account), attempt: payload.attempt, fingerprint: payload.fingerprint }),
      onActive: ({ requestId, waiting, payload }) => emit({ event: "answer_required", requestId, waiting, ...payload }),
    }) : null;
    const gmiProvider = !options.dryRun && options.answerProvider === "gmi" ? await createGmiAnswerProvider({
      apiUrl: options.gmiApiUrl,
      model: options.gmiModel,
      repositoryUrl: canonicalRepository(options.repositoryUrl).url,
      concurrency: options.llmConcurrency,
      timeoutMs: options.llmTimeoutMs,
      maxAttempts: options.llmMaxAttempts,
      envFile: options.envFile,
      onEvent: emit,
    }) : null;
    const answerMemo = options.dryRun ? null : new ExactAnswerMemo({
      resolveAnswer: (payload) => {
        if (broker) return broker.request(payload);
        const fixed = fixedScenarioAnswer(payload.responseMode);
        return fixed ?? gmiProvider(payload);
      },
      keyFor: (payload) => payload.scenarioCacheKey ?? payload.fingerprint,
      onReuse: ({ fingerprint, source, payload }) => emit({
        event: "answer_reused",
        fingerprint,
        source,
        account: publicAccount(payload.account),
        attempt: payload.attempt,
        scenario: payload.scenario ?? null,
        responseMode: payload.responseMode ?? null,
      }),
      onStore: ({ fingerprint, payload }) => emit({ event: "answer_generated", provider: fixedScenarioAnswer(payload.responseMode) ? "fixed-scenario" : options.answerProvider, fingerprint, account: publicAccount(payload.account), attempt: payload.attempt, scenario: payload.scenario ?? null, responseMode: payload.responseMode ?? null }),
    });
    browser = await chromium.launch({ headless: options.headless, executablePath: options.chromePath });

    emit({
      event: "parallel_plan",
      classes: options.classes,
      classConcurrency: Math.min(options.classConcurrency, options.classes.length),
      teamConcurrency: options.teamConcurrency,
      maximumActiveTeamLanes: Math.min(options.classConcurrency, options.classes.length) * options.teamConcurrency,
      startAt: options.startAt,
      limitPerClass: Number.isFinite(options.limitPerClass) ? options.limitPerClass : null,
      answerProvider: options.answerProvider,
      prepareRepository: options.prepareRepository,
      repository: canonicalRepository(options.repositoryUrl).slug,
      llmConcurrency: options.answerProvider === "gmi" ? options.llmConcurrency : null,
      scenarios: options.scenarioMap,
      dryRun: options.dryRun,
    });

    const results = await mapConcurrent(options.classes, options.classConcurrency, async (className) => {
      const scenario = options.scenarioMap[className];
      const classOptions = {
        className,
        startAt: options.startAt,
        limit: options.limitPerClass,
        baseUrl: options.baseUrl,
        chromePath: options.chromePath,
        headless: options.headless,
        ledgerPath: resolve(options.ledgerDir, `playwright-${className}.ndjson`),
        prepareRepository: options.prepareRepository,
        repositoryUrl: canonicalRepository(options.repositoryUrl).url,
        repositoryBranch: options.repositoryBranch,
        analysisTimeoutMs: options.analysisTimeoutMs,
        analysisPollMs: options.analysisPollMs,
      };
      try {
        return await runPlaywrightClass({
          browser,
          options: classOptions,
          answerProvider: options.dryRun
            ? async () => fail("DRY_RUN_ANSWER", "Dry run must not request an answer.")
            : (payload) => answerMemo.request(options.answerProvider === "gmi" ? scenarioPayload(payload, scenario) : payload),
          hintCountProvider: options.answerProvider === "gmi" ? (payload) => desiredHintCount(payload, scenario) : null,
          teamConcurrency: options.teamConcurrency,
          dryRun: options.dryRun,
        });
      } catch (error) {
        emit({ event: "class_failed", className, code: error.code ?? "PLAYWRIGHT_CLASS_FAILED", message: error.message });
        return { className, status: "failed", failedTeams: null };
      }
    });
    const failedClasses = results.filter((result) => result.status === "failed" || result.status === "partial");
    emit({ event: "parallel_result", classes: results, failedClassCount: failedClasses.length });
    if (failedClasses.length > 0) process.exitCode = 1;
  } finally {
    reader?.close();
    await browser?.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    emit({ event: "failed", code: error.code ?? "PLAYWRIGHT_PARALLEL_FAILED", message: error.message, details: error.details ?? {} });
    process.exitCode = 1;
  });
}
