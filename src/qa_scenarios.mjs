import { createHash } from "node:crypto";

export const QA_SCENARIOS = Object.freeze(["excellent", "moderate", "struggling", "inactive"]);

export class QaScenarioError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "QaScenarioError";
    this.code = code;
    this.details = details;
  }
}

function invariant(condition, code, message, details = {}) {
  if (!condition) throw new QaScenarioError(code, message, details);
}

function normalizeClassName(value) {
  const className = `${String(value ?? "").normalize("NFKC").trim().replace(/반$/u, "").toUpperCase()}반`;
  invariant(/^[A-Z]반$/u.test(className), "INVALID_SCENARIO_CLASS", `Invalid scenario class: ${value}`);
  return className;
}

export function parseScenarioAssignments(specs, selectedClasses) {
  const selected = new Set(selectedClasses);
  const assignments = {};
  if (!Array.isArray(specs) || specs.length === 0) {
    for (const className of selectedClasses) assignments[className] = "excellent";
    return Object.freeze(assignments);
  }

  for (const rawSpec of specs) {
    const match = /^([a-z]+):(.+)$/iu.exec(String(rawSpec).normalize("NFKC").trim());
    invariant(match, "INVALID_SCENARIO_SPEC", "Scenario must use PROFILE:CLASSES, for example moderate:H,C.", { spec: rawSpec });
    const scenario = match[1].toLowerCase();
    invariant(QA_SCENARIOS.includes(scenario), "INVALID_SCENARIO", `Unknown scenario: ${scenario}`, { allowed: QA_SCENARIOS });
    const classes = match[2].split(",").map(normalizeClassName);
    invariant(classes.length > 0 && new Set(classes).size === classes.length, "DUPLICATE_SCENARIO_CLASS", "A scenario spec may list each class only once.", { spec: rawSpec });
    for (const className of classes) {
      invariant(selected.has(className), "SCENARIO_CLASS_NOT_SELECTED", `${className} is not present in --classes.`);
      invariant(assignments[className] === undefined, "DUPLICATE_SCENARIO_ASSIGNMENT", `${className} has more than one scenario.`);
      assignments[className] = scenario;
    }
  }

  const missing = selectedClasses.filter((className) => assignments[className] === undefined);
  invariant(missing.length === 0, "MISSING_SCENARIO_ASSIGNMENT", "Every selected class must have one scenario.", { missing });
  return Object.freeze(assignments);
}

function currentQuestionOrdinal(visibleText) {
  const matches = [...String(visibleText ?? "").matchAll(/^◆ 질문\s+(\d+)$/gmu)];
  return matches.at(-1)?.[1] ?? "unknown";
}

export function scenarioSeed(payload) {
  const account = payload?.account ?? {};
  const code = [...new Set((payload?.code ?? []).map((value) => String(value).normalize("NFC").trim()).filter(Boolean))].join("\n\u0000");
  return createHash("sha256").update([
    account.className ?? "",
    account.teamName ?? "",
    account.accountId ?? "",
    currentQuestionOrdinal(payload?.visibleText),
    code,
  ].join("\u0000")).digest("hex");
}

export function desiredHintCount(payload, scenario) {
  invariant(QA_SCENARIOS.includes(scenario), "INVALID_SCENARIO", `Unknown scenario: ${scenario}`);
  if (scenario === "excellent") return 0;
  if (scenario === "moderate") return 1 + (Number.parseInt(scenarioSeed(payload).slice(0, 2), 16) % 2);
  return 2;
}

export function scenarioPayload(payload, scenario) {
  invariant(QA_SCENARIOS.includes(scenario), "INVALID_SCENARIO", `Unknown scenario: ${scenario}`);
  const seed = scenarioSeed(payload);
  let responseMode = scenario;
  if (scenario === "moderate") responseMode = "assisted_correct";
  if (scenario === "struggling") {
    responseMode = Number.parseInt(seed.slice(2, 4), 16) % 5 === 0 ? "assisted_incorrect" : "assisted_basic";
  }
  return Object.freeze({
    ...payload,
    scenario,
    responseMode,
    scenarioCacheKey: `${responseMode}:${payload.fingerprint}`,
  });
}

export function fixedScenarioAnswer(responseMode) {
  if (responseMode === "inactive") return "힌트를 모두 확인했지만 이 코드가 왜 이렇게 동작하는지 잘 모르겠습니다.";
  if (responseMode === "assisted_incorrect") return "설명을 다시 읽어봤지만 이 코드의 실행 흐름과 설계 이유를 아직 정확히 설명하지 못하겠습니다.";
  return null;
}
