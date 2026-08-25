#!/usr/bin/env node

import { createHash } from "node:crypto";

import { createGmiAnswerProvider } from "../src/gmi_answer_provider.mjs";

const visibleText = "◆ 질문 1\n이 메서드가 반환하는 값을 설명하세요.";
const code = ["int value() { return 1; }"];
const fingerprint = `sha256:${createHash("sha256").update(JSON.stringify({ visibleText, code })).digest("hex")}`;

try {
  const provider = await createGmiAnswerProvider({ maxAttempts: 1, maxTokens: 120 });
  const answer = await provider({ visibleText, code, fingerprint, attempt: 0, responseMode: "excellent" });
  process.stdout.write(`${JSON.stringify({ event: "gmi_smoke_ok", answerCharacters: answer.length })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ event: "gmi_smoke_failed", code: error.code ?? "GMI_SMOKE_FAILED", message: error.message })}\n`);
  process.exitCode = 1;
}
