#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import {
  HELP_TEXT,
  executeBatch,
  resolveBatchConfig,
} from "../src/batch_cli.mjs";

const terminal = createInterface({ input: stdin, output: stdout });

async function chooseClass(classes) {
  stdout.write(`\n반을 선택하세요.\n${classes.map((name, index) => `  ${index + 1}. ${name}`).join("\n")}\n`);
  const answer = await terminal.question("번호: ");
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= classes.length) throw new Error("올바른 반 번호가 아닙니다.");
  return classes[index];
}

async function confirm(plan) {
  stdout.write(`\n${plan.className} · ${plan.totals.teams}팀 · 교육생 ${plan.totals.trainees}명 · 병렬 ${plan.actualConcurrency}개\n`);
  stdout.write(`저장소: ${plan.repositoryUrl}\n회차: ${plan.round}\n`);
  const answer = await terminal.question("실제 제출과 Q&A를 시작할까요? [y/N] ");
  return /^(?:y|yes|예)$/i.test(answer.trim());
}

try {
  const config = await resolveBatchConfig(process.argv.slice(2));
  if (config.help) {
    stdout.write(HELP_TEXT);
  } else {
    const result = await executeBatch(config, { chooseClass, confirm });
    stdout.write(`${JSON.stringify(result, null, config.json ? 0 : 2)}\n`);
    if (["failed", "partial"].includes(result.status)) process.exitCode = 2;
  }
} catch (error) {
  const code = error?.code ?? "BATCH_CLI_FAILED";
  stdout.write(`${JSON.stringify({ status: "failed", code, message: error?.message ?? String(error) }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  terminal.close();
}
