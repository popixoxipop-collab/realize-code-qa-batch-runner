#!/usr/bin/env node

import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { chromium } from "playwright-core";

import { emit, runPlaywrightClass } from "./realize-playwright.mjs";
import { ExactAnswerMemo, mapConcurrent, normalizeClassList, SerialAnswerBroker } from "../src/parallel_scheduler.mjs";

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
    stdout.write("Usage: npm run playwright:parallel -- --classes A,B,C,D,E,F --class-concurrency 6 --team-concurrency 5 --yes [--headed]\n");
    stdout.write("Preview: npm run playwright:parallel -- --classes A,B,C,D,E,F --dry-run\n");
    return;
  }

  const browser = await chromium.launch({ headless: options.headless, executablePath: options.chromePath });
  const reader = options.dryRun ? null : createInterface({ input: stdin, output: stdout });
  const broker = options.dryRun ? null : new SerialAnswerBroker({
    ask: ({ requestId }) => reader.question(`ANSWER[${requestId}]> `),
    onQueued: ({ requestId, waiting, payload }) => emit({
      event: "answer_queued",
      requestId,
      waiting,
      account: publicAccount(payload.account),
      attempt: payload.attempt,
      fingerprint: payload.fingerprint,
    }),
    onActive: ({ requestId, waiting, payload }) => emit({ event: "answer_required", requestId, waiting, ...payload }),
  });
  const answerMemo = options.dryRun ? null : new ExactAnswerMemo({
    resolveAnswer: (payload) => broker.request(payload),
    onReuse: ({ fingerprint, source, payload }) => emit({
      event: "answer_reused",
      fingerprint,
      source,
      account: publicAccount(payload.account),
      attempt: payload.attempt,
    }),
  });

  emit({
    event: "parallel_plan",
    classes: options.classes,
    classConcurrency: Math.min(options.classConcurrency, options.classes.length),
    teamConcurrency: options.teamConcurrency,
    maximumActiveTeamLanes: Math.min(options.classConcurrency, options.classes.length) * options.teamConcurrency,
    startAt: options.startAt,
    limitPerClass: Number.isFinite(options.limitPerClass) ? options.limitPerClass : null,
    dryRun: options.dryRun,
  });

  try {
    const results = await mapConcurrent(options.classes, options.classConcurrency, async (className) => {
      const classOptions = {
        className,
        startAt: options.startAt,
        limit: options.limitPerClass,
        baseUrl: options.baseUrl,
        chromePath: options.chromePath,
        headless: options.headless,
        ledgerPath: resolve(options.ledgerDir, `playwright-${className}.ndjson`),
      };
      try {
        return await runPlaywrightClass({
          browser,
          options: classOptions,
          answerProvider: options.dryRun ? async () => fail("DRY_RUN_ANSWER", "Dry run must not request an answer.") : (payload) => answerMemo.request(payload),
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
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    emit({ event: "failed", code: error.code ?? "PLAYWRIGHT_PARALLEL_FAILED", message: error.message, details: error.details ?? {} });
    process.exitCode = 1;
  });
}
