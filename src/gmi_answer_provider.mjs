import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const DEFAULT_GMI_API_URL = "https://api.gmi-serving.com/v1/chat/completions";
export const DEFAULT_GMI_MODEL = "MiniMaxAI/MiniMax-M3";

export class GmiAnswerProviderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GmiAnswerProviderError";
    this.code = code;
    this.details = details;
  }
}

function invariant(condition, code, message, details = {}) {
  if (!condition) throw new GmiAnswerProviderError(code, message, details);
}

export function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/gu, "\n").replace(/\\r/gu, "\r").replace(/\\t/gu, "\t").replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
    } else {
      value = value.replace(/\s+#.*$/u, "").trim();
    }
    values[match[1]] = value;
  }
  return values;
}

export async function loadEnvFileIfPresent(path = resolve(".env"), environment = process.env) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (environment[name] === undefined) environment[name] = value;
  }
  return true;
}

function boundedText(value, maximumCharacters) {
  const text = String(value ?? "").normalize("NFC").trim();
  if (text.length <= maximumCharacters) return text;
  const half = Math.floor(maximumCharacters / 2);
  return `${text.slice(0, half)}\n\n[중간 내용 생략]\n\n${text.slice(-half)}`;
}

export function extractCurrentQuestion(visibleText) {
  const text = String(visibleText ?? "").normalize("NFC").trim();
  const markers = [...text.matchAll(/^◆ 질문 \d+$/gmu)];
  if (markers.length === 0) return boundedText(text, 24_000);
  return boundedText(text.slice(markers.at(-1).index), 24_000);
}

export function buildGmiMessages(payload, { repositoryUrl = "" } = {}) {
  const currentQuestion = extractCurrentQuestion(payload?.visibleText);
  const code = boundedText([...new Set((payload?.code ?? []).map((value) => String(value).normalize("NFC").trim()).filter(Boolean))].join("\n\n"), 160_000);
  const retryInstruction = Number(payload?.attempt ?? 0) > 0
    ? "화면에 재설명 요청과 이전 답변이 있다면, 요청의 문구를 문자 그대로 해결하도록 이전 답변을 대체하세요."
    : "질문이 요구하는 실행 흐름, 설계 이유 또는 구체적 실패 사례를 정확히 답하세요.";
  return [
    {
      role: "system",
      content: [
        "당신은 한국어 코드 리뷰 구술 QA의 답변 작성기입니다.",
        "화면에 보이는 현재 질문과 제공된 코드만 근거로 직접적이고 기술적으로 정확한 답변을 작성하세요.",
        "보이지 않는 구현을 단정하지 말고, 필요한 경우 조건부로 표현하세요.",
        "보통 2~4문장으로 답하고 제목, 인사, 서론, 채점 언급, 마크다운 코드 블록은 쓰지 마세요.",
        "출력에는 답변 본문만 포함하세요.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        repositoryUrl ? `검토 저장소: ${repositoryUrl}` : null,
        `현재 시도 번호: ${Number(payload?.attempt ?? 0) + 1}`,
        retryInstruction,
        "",
        "[현재 질문 화면]",
        currentQuestion,
        "",
        "[제시된 코드]",
        code || "(별도 코드 블록 없음)",
      ].filter((value) => value !== null).join("\n"),
    },
  ];
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("");
  return "";
}

export function normalizeModelAnswer(value) {
  return contentText(value)
    .normalize("NFC")
    .trim()
    .replace(/^```(?:text|markdown)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .replace(/^(?:답변|Answer)\s*:\s*/iu, "")
    .trim();
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMs(response) {
  const raw = response.headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function createLimiter(concurrency) {
  let active = 0;
  const queued = [];
  const release = () => {
    active -= 1;
    queued.shift()?.();
  };
  return async (task) => {
    if (active >= concurrency) await new Promise((resolveQueue) => queued.push(resolveQueue));
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

export async function createGmiAnswerProvider({
  apiKey,
  apiUrl,
  model,
  repositoryUrl = "",
  concurrency = 8,
  timeoutMs = 90_000,
  maxAttempts = 4,
  maxTokens = 700,
  temperature = 0.2,
  envFile = resolve(".env"),
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  random = Math.random,
  onEvent = () => {},
} = {}) {
  await loadEnvFileIfPresent(envFile);
  const secret = apiKey || process.env.GMI_API_KEY;
  apiUrl ||= process.env.GMI_API_URL || DEFAULT_GMI_API_URL;
  model ||= process.env.GMI_MODEL || DEFAULT_GMI_MODEL;
  invariant(typeof secret === "string" && secret.trim().length > 0, "GMI_API_KEY_MISSING", "GMI_API_KEY가 필요합니다. .env 또는 환경변수에 설정하세요.");
  invariant(typeof fetchImpl === "function", "GMI_FETCH_UNAVAILABLE", "이 Node 런타임에는 fetch가 없습니다.");
  invariant(Number.isInteger(concurrency) && concurrency > 0, "INVALID_LLM_CONCURRENCY", "LLM concurrency must be a positive integer.");
  invariant(Number.isInteger(timeoutMs) && timeoutMs >= 1_000, "INVALID_LLM_TIMEOUT", "LLM timeout must be at least 1000ms.");
  invariant(Number.isInteger(maxAttempts) && maxAttempts > 0, "INVALID_LLM_ATTEMPTS", "LLM maxAttempts must be a positive integer.");
  invariant(Number.isInteger(maxTokens) && maxTokens > 0, "INVALID_LLM_MAX_TOKENS", "LLM maxTokens must be a positive integer.");
  const limit = createLimiter(concurrency);

  return (payload) => limit(async () => {
    const messages = buildGmiMessages(payload, { repositoryUrl });
    let lastError;
    for (let requestAttempt = 0; requestAttempt < maxAttempts; requestAttempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      onEvent({ event: "llm_request", provider: "gmi", model, fingerprint: payload?.fingerprint, requestAttempt });
      try {
        const response = await fetchImpl(apiUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secret.trim()}`,
            "Content-Type": "application/json",
            "User-Agent": "curl/8.0",
          },
          body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const code = response.status === 401 || response.status === 403 ? "GMI_AUTH_FAILED" : "GMI_HTTP_FAILED";
          const error = new GmiAnswerProviderError(code, `GMI 요청이 HTTP ${response.status}로 실패했습니다.`, { status: response.status, requestAttempt });
          if (!retryableStatus(response.status) || requestAttempt + 1 >= maxAttempts) throw error;
          lastError = error;
          const delayMs = retryAfterMs(response) ?? Math.min(20_000, Math.round(750 * (2 ** requestAttempt) * (0.75 + random() * 0.5)));
          onEvent({ event: "llm_retry", provider: "gmi", model, fingerprint: payload?.fingerprint, requestAttempt, delayMs, status: response.status });
          await sleep(delayMs);
          continue;
        }
        const data = await response.json();
        const answer = normalizeModelAnswer(data?.choices?.[0]?.message?.content);
        if (answer.length < 10 || answer.length > 4_000) {
          const code = answer.length < 10 ? "GMI_EMPTY_ANSWER" : "GMI_ANSWER_TOO_LONG";
          lastError = new GmiAnswerProviderError(code, answer.length < 10 ? "GMI가 비어 있거나 지나치게 짧은 답변을 반환했습니다." : "GMI 답변이 4000자를 초과했습니다.", { length: answer.length, requestAttempt });
          if (requestAttempt + 1 >= maxAttempts) throw lastError;
          const delayMs = Math.min(20_000, Math.round(750 * (2 ** requestAttempt) * (0.75 + random() * 0.5)));
          onEvent({ event: "llm_retry", provider: "gmi", model, fingerprint: payload?.fingerprint, requestAttempt, delayMs, code });
          await sleep(delayMs);
          continue;
        }
        onEvent({ event: "llm_response", provider: "gmi", model, fingerprint: payload?.fingerprint, requestAttempt, elapsedMs: Date.now() - startedAt, answerCharacters: answer.length });
        return answer;
      } catch (error) {
        if (error instanceof GmiAnswerProviderError) throw error;
        const code = error?.name === "AbortError" ? "GMI_TIMEOUT" : "GMI_NETWORK_FAILED";
        lastError = new GmiAnswerProviderError(code, code === "GMI_TIMEOUT" ? "GMI 응답 시간이 초과됐습니다." : "GMI 네트워크 요청에 실패했습니다.", { requestAttempt });
        if (requestAttempt + 1 >= maxAttempts) throw lastError;
        const delayMs = Math.min(20_000, Math.round(750 * (2 ** requestAttempt) * (0.75 + random() * 0.5)));
        onEvent({ event: "llm_retry", provider: "gmi", model, fingerprint: payload?.fingerprint, requestAttempt, delayMs, code });
        await sleep(delayMs);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new GmiAnswerProviderError("GMI_UNKNOWN_FAILURE", "GMI 답변 생성에 실패했습니다.");
  });
}
