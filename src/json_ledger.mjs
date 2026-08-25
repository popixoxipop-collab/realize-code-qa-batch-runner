import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";

export const LEDGER_SCHEMA_VERSION = 1;

export const TEAM_SUBMISSION_STATES = Object.freeze([
  "pending",
  "submit_intent",
  "submitted_unverified",
  "confirmed",
  "failed",
  "blocked",
]);

export const TEAM_ANALYSIS_STATES = Object.freeze([
  "not_started",
  "analyzing",
  "ready",
  "failed",
  "blocked",
]);

export const TEAM_ORIGINS = Object.freeze(["preexisting", "this_run"]);

export const ACCOUNT_SESSION_STATES = Object.freeze([
  "pending",
  "active",
  "complete",
  "failed",
  "blocked",
]);

export const ACCOUNT_PHASE_STATES = Object.freeze([
  "editing",
  "submit_intent",
  "grading",
  "needs_revision",
  "handoff",
  "complete",
  "blocked",
]);

const CREDENTIAL_KEY = /(?:^|_)(?:password|passwd|pwd|secret|token|cookie|authorization|credential|credentials|api_key|access_token|refresh_token|id_token)(?:$|_)/i;
const COMPACT_CREDENTIAL_KEY = /^(?:password|passwd|pwd|secret|token|cookie|cookies|authorization|credential|credentials|apikey|apisecret|accesstoken|refreshtoken|idtoken|clientsecret)$/;
const COMPACT_CREDENTIAL_TERMS = Object.freeze([
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "cookie",
  "authorization",
  "credential",
  "apikey",
  "apisecret",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "clientsecret",
  "privatekey",
]);
const CREDENTIAL_VALUE_PATTERNS = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/,
  /\b(?:password|passwd|pwd|secret|token|cookie|authorization)\s*[:=]\s*\S+/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i,
]);

export class LedgerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new LedgerError(code, message, details);
}

function assert(condition, code, message, details = {}) {
  if (!condition) fail(code, message, details);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeLabel(value, field) {
  assert(typeof value === "string", "INVALID_RUN_ANCHOR", `${field} must be a string.`, { field });
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  assert(normalized.length > 0, "INVALID_RUN_ANCHOR", `${field} must not be empty.`, { field });
  return normalized;
}

function normalizeRepository(value) {
  const normalized = normalizeLabel(value, "repository");
  let candidate = normalized;
  if (/^https?:\/\//i.test(candidate)) {
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      fail("INVALID_RUN_ANCHOR", "repository must be an owner/repository pair or a valid GitHub URL.", {
        field: "repository",
      });
    }
    assert(
      ["github.com", "www.github.com"].includes(parsed.hostname.toLowerCase())
        && !parsed.username
        && !parsed.password
        && !parsed.search
        && !parsed.hash,
      "INVALID_RUN_ANCHOR",
      "repository URL must identify a plain GitHub repository.",
      { field: "repository" },
    );
    candidate = parsed.pathname.replace(/^\/+|\/+$/g, "");
  }
  candidate = candidate.replace(/\.git$/i, "");
  const segments = candidate.split("/");
  assert(
    segments.length === 2 && segments.every((segment) => /^[A-Za-z0-9._-]+$/.test(segment)),
    "INVALID_RUN_ANCHOR",
    "repository must be an owner/repository pair.",
    { field: "repository" },
  );
  return segments.map((segment) => segment.toLowerCase()).join("/");
}

export function normalizeRunAnchor(anchor) {
  assert(isRecord(anchor), "INVALID_RUN_ANCHOR", "run anchor must be an object.");
  return Object.freeze({
    class: normalizeLabel(anchor.class, "class"),
    round: normalizeLabel(anchor.round, "round"),
    repository: normalizeRepository(anchor.repository),
  });
}

function anchorsEqual(left, right) {
  return left.class === right.class
    && left.round === right.round
    && left.repository === right.repository;
}

function cloneJson(value) {
  try {
    return structuredClone(value);
  } catch {
    fail("INVALID_LEDGER_DATA", "ledger data must be structured-cloneable JSON data.");
  }
}

function assertJsonValue(value, path, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    assert(Number.isFinite(value), "INVALID_LEDGER_DATA", "ledger numbers must be finite.", { path });
    return;
  }
  assert(typeof value === "object", "INVALID_LEDGER_DATA", "ledger data must contain JSON values only.", { path });
  assert(!seen.has(value), "INVALID_LEDGER_DATA", "ledger data must not contain cycles.", { path });
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`, seen));
  } else {
    assert(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
      "INVALID_LEDGER_DATA", "ledger objects must be plain objects.", { path });
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(entry, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function credentialLikeKey(key) {
  const compact = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return CREDENTIAL_KEY.test(key)
    || COMPACT_CREDENTIAL_KEY.test(compact)
    || COMPACT_CREDENTIAL_TERMS.some((term) => compact.startsWith(term) || compact.endsWith(term));
}

/**
 * Reject credential-shaped keys and common credential values before they can reach disk.
 * Error details intentionally contain only the JSON path, never the rejected value.
 */
export function assertNoCredentials(value, path = "$") {
  const walk = (entry, currentPath, seen) => {
    if (typeof entry === "string") {
      assert(
        !CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(entry)),
        "CREDENTIAL_DATA_FORBIDDEN",
        "credential-like data is forbidden in a run ledger.",
        { path: currentPath },
      );
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    assert(!seen.has(entry), "INVALID_LEDGER_DATA", "ledger data must not contain cycles.", { path: currentPath });
    seen.add(entry);
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => walk(item, `${currentPath}[${index}]`, seen));
    } else {
      for (const [key, item] of Object.entries(entry)) {
        const childPath = `${currentPath}.${key}`;
        assert(
          !credentialLikeKey(key),
          "CREDENTIAL_DATA_FORBIDDEN",
          "credential-like fields are forbidden in a run ledger.",
          { path: childPath },
        );
        walk(item, childPath, seen);
      }
    }
    seen.delete(entry);
  };
  walk(value, path, new Set());
  return value;
}

function assertAllowed(value, allowed, field, path) {
  assert(allowed.includes(value), "INVALID_LEDGER_STATE", `${field} has an unsupported state.`, {
    path,
    field,
    value,
  });
}

function validateTeams(teams) {
  assert(isRecord(teams), "INVALID_LEDGER_STATE", "teams must be an object.", { path: "$.teams" });
  for (const [teamName, team] of Object.entries(teams)) {
    assert(normalizeLabel(teamName, "team") === teamName, "INVALID_LEDGER_STATE", "team keys must be normalized, non-empty labels.", {
      path: `$.teams.${teamName}`,
    });
    assert(isRecord(team), "INVALID_LEDGER_STATE", "team state must be an object.", { path: `$.teams.${teamName}` });
    assertAllowed(team.submission, TEAM_SUBMISSION_STATES, "submission", `$.teams.${teamName}.submission`);
    assertAllowed(team.analysis, TEAM_ANALYSIS_STATES, "analysis", `$.teams.${teamName}.analysis`);
    assertAllowed(team.origin, TEAM_ORIGINS, "origin", `$.teams.${teamName}.origin`);
  }
}

function validateAccounts(accounts, teams) {
  assert(isRecord(accounts), "INVALID_LEDGER_STATE", "accounts must be an object.", { path: "$.accounts" });
  for (const [accountName, account] of Object.entries(accounts)) {
    assert(normalizeLabel(accountName, "account") === accountName, "INVALID_LEDGER_STATE", "account keys must be normalized, non-empty labels.", {
      path: `$.accounts.${accountName}`,
    });
    assert(isRecord(account), "INVALID_LEDGER_STATE", "account state must be an object.", { path: `$.accounts.${accountName}` });
    assert(typeof account.team === "string" && Object.hasOwn(teams, account.team),
      "INVALID_LEDGER_STATE", "account must reference an existing team.", { path: `$.accounts.${accountName}.team` });
    assertAllowed(account.session, ACCOUNT_SESSION_STATES, "session", `$.accounts.${accountName}.session`);
    assertAllowed(account.phase, ACCOUNT_PHASE_STATES, "phase", `$.accounts.${accountName}.phase`);
    assert(Number.isInteger(account.attempt) && account.attempt >= 0,
      "INVALID_LEDGER_STATE", "account attempt must be a non-negative integer.", { path: `$.accounts.${accountName}.attempt` });
    assert(account.question_fingerprint === null
      || (typeof account.question_fingerprint === "string"
        && /^sha256:[a-f0-9]{64}$/.test(account.question_fingerprint)),
    "INVALID_LEDGER_STATE", "question_fingerprint must be null or a SHA-256 fingerprint.", {
      path: `$.accounts.${accountName}.question_fingerprint`,
    });
    assert(typeof account.note === "string", "INVALID_LEDGER_STATE", "account note must be a string.", {
      path: `$.accounts.${accountName}.note`,
    });
  }
}

function validateJournal(journal) {
  assert(Array.isArray(journal), "INVALID_LEDGER_STATE", "journal must be an array.", { path: "$.journal" });
  const intents = new Map();
  const confirmed = new Set();
  for (const [index, entry] of journal.entries()) {
    const path = `$.journal[${index}]`;
    assert(isRecord(entry), "INVALID_LEDGER_STATE", "journal entry must be an object.", { path });
    assert(entry.sequence === index + 1, "INVALID_LEDGER_STATE", "journal sequence must be contiguous.", { path });
    assert(entry.phase === "intent" || entry.phase === "confirmed",
      "INVALID_LEDGER_STATE", "journal phase must be intent or confirmed.", { path });
    assert(typeof entry.intentId === "string" && entry.intentId.length > 0,
      "INVALID_LEDGER_STATE", "journal intentId must be a non-empty string.", { path });
    assert(typeof entry.action === "string" && entry.action.trim().length > 0,
      "INVALID_LEDGER_STATE", "journal action must be a non-empty string.", { path });
    assert(typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)),
      "INVALID_LEDGER_STATE", "journal timestamp must be ISO-compatible.", { path });
    assert(isRecord(entry.target), "INVALID_LEDGER_STATE", "journal target must be an object.", { path });
    assert(isRecord(entry.data), "INVALID_LEDGER_STATE", "journal data must be an object.", { path });
    if (entry.phase === "intent") {
      assert(!intents.has(entry.intentId), "INVALID_LEDGER_STATE", "journal intentId must be unique.", { path });
      intents.set(entry.intentId, entry);
    } else {
      const intent = intents.get(entry.intentId);
      assert(intent, "INVALID_LEDGER_STATE", "confirmed entry must reference an earlier intent.", { path });
      assert(!confirmed.has(entry.intentId), "INVALID_LEDGER_STATE", "an intent may be confirmed only once.", { path });
      assert(entry.action === intent.action, "INVALID_LEDGER_STATE", "confirmed action must match its intent.", { path });
      confirmed.add(entry.intentId);
    }
  }
  return { intents, confirmed };
}

export function validateLedgerDocument(document) {
  assertJsonValue(document, "$", new Set());
  assertNoCredentials(document);
  assert(isRecord(document), "INVALID_LEDGER_STATE", "ledger root must be an object.");
  assert(document.schemaVersion === LEDGER_SCHEMA_VERSION, "UNSUPPORTED_LEDGER_VERSION", "ledger schema version is unsupported.", {
    actual: document.schemaVersion,
    expected: LEDGER_SCHEMA_VERSION,
  });
  document.run = normalizeRunAnchor(document.run);
  assert(typeof document.createdAt === "string" && Number.isFinite(Date.parse(document.createdAt)),
    "INVALID_LEDGER_STATE", "createdAt must be ISO-compatible.", { path: "$.createdAt" });
  assert(typeof document.updatedAt === "string" && Number.isFinite(Date.parse(document.updatedAt)),
    "INVALID_LEDGER_STATE", "updatedAt must be ISO-compatible.", { path: "$.updatedAt" });
  validateTeams(document.teams);
  validateAccounts(document.accounts, document.teams);
  validateJournal(document.journal);
  return document;
}

function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  assert(Number.isFinite(date.getTime()), "INVALID_CLOCK", "clock must return a Date-compatible value.");
  return date.toISOString();
}

function defaultTeamState() {
  return { submission: "pending", analysis: "not_started", origin: "this_run" };
}

function defaultAccountState(team) {
  return {
    team,
    session: "pending",
    phase: "editing",
    question_fingerprint: null,
    attempt: 0,
    note: "",
  };
}

function initialTeams(input) {
  if (Array.isArray(input)) {
    return Object.fromEntries(input.map((name) => [normalizeLabel(name, "team"), defaultTeamState()]));
  }
  const teams = cloneJson(input ?? {});
  for (const [name, state] of Object.entries(teams)) {
    teams[name] = { ...defaultTeamState(), ...state };
  }
  return teams;
}

function initialAccounts(input) {
  if (Array.isArray(input)) {
    return Object.fromEntries(input.map((entry) => {
      assert(isRecord(entry), "INVALID_LEDGER_STATE", "account array entries must be objects.");
      const name = normalizeLabel(entry.name, "account");
      return [name, { ...defaultAccountState(entry.team), ...entry, name: undefined }];
    }).map(([name, account]) => {
      delete account.name;
      return [name, account];
    }));
  }
  const accounts = cloneJson(input ?? {});
  for (const [name, state] of Object.entries(accounts)) {
    accounts[name] = { ...defaultAccountState(state?.team), ...state };
  }
  return accounts;
}

function unresolvedFrom(document) {
  const { intents, confirmed } = validateJournal(document.journal);
  return [...intents.values()]
    .filter((intent) => !confirmed.has(intent.intentId))
    .map(cloneJson);
}

function normalizeTarget(target, document) {
  const normalized = { ...target };
  if (normalized.team !== undefined) {
    normalized.team = normalizeLabel(normalized.team, "team");
    assert(Object.hasOwn(document.teams, normalized.team), "UNKNOWN_TEAM", "journal target references an unknown team.", {
      team: normalized.team,
    });
  }
  if (normalized.account !== undefined) {
    normalized.account = normalizeLabel(normalized.account, "account");
    assert(Object.hasOwn(document.accounts, normalized.account), "UNKNOWN_ACCOUNT", "journal target references an unknown account.", {
      account: normalized.account,
    });
  }
  assert(normalized.team !== undefined || normalized.account !== undefined,
    "INVALID_JOURNAL_TARGET", "journal target must identify a team or account.");
  return normalized;
}

/** Write JSON through a same-directory temporary file, fsync it, then atomically rename it. */
export async function atomicWriteJson(filePath, value) {
  const target = resolve(filePath);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  const temporary = resolve(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    try {
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error?.code)) throw error;
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export class JsonLedger {
  constructor(filePath, document, { clock = () => new Date() } = {}) {
    this.path = resolve(filePath);
    this.clock = clock;
    this.document = validateLedgerDocument(cloneJson(document));
    this.writeQueue = Promise.resolve();
  }

  static async create(filePath, { anchor, teams = {}, accounts = {}, clock = () => new Date() } = {}) {
    const timestamp = nowIso(clock);
    const document = validateLedgerDocument({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      run: normalizeRunAnchor(anchor),
      createdAt: timestamp,
      updatedAt: timestamp,
      teams: initialTeams(teams),
      accounts: initialAccounts(accounts),
      journal: [],
    });
    try {
      await readFile(resolve(filePath), "utf8");
      fail("LEDGER_EXISTS", "refusing to replace an existing ledger during create.", { path: resolve(filePath) });
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      if (error?.code !== "ENOENT") throw error;
    }
    await atomicWriteJson(filePath, document);
    return new JsonLedger(filePath, document, { clock });
  }

  static async load(filePath, { anchor, clock = () => new Date() } = {}) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(resolve(filePath), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") fail("LEDGER_NOT_FOUND", "ledger file does not exist.", { path: resolve(filePath) });
      if (error instanceof SyntaxError) fail("INVALID_LEDGER_JSON", "ledger file is not valid JSON.", { path: resolve(filePath) });
      throw error;
    }
    const document = validateLedgerDocument(parsed);
    const expected = normalizeRunAnchor(anchor);
    assert(anchorsEqual(document.run, expected), "RUN_ANCHOR_MISMATCH", "stored run anchors do not match the requested run.", {
      expected,
      actual: document.run,
    });
    return new JsonLedger(filePath, document, { clock });
  }

  static async open(filePath, options = {}) {
    try {
      return await JsonLedger.load(filePath, options);
    } catch (error) {
      if (!(error instanceof LedgerError) || error.code !== "LEDGER_NOT_FOUND") throw error;
      return JsonLedger.create(filePath, options);
    }
  }

  snapshot() {
    return cloneJson(this.document);
  }

  resume() {
    const snapshot = this.snapshot();
    return Object.freeze({
      document: snapshot,
      unresolvedIntents: Object.freeze(unresolvedFrom(snapshot)),
      pendingTeams: Object.freeze(Object.entries(snapshot.teams)
        .filter(([, state]) => state.submission !== "confirmed" || !["ready", "failed", "blocked"].includes(state.analysis))
        .map(([name]) => name)),
      pendingAccounts: Object.freeze(Object.entries(snapshot.accounts)
        .filter(([, state]) => state.session !== "complete")
        .map(([name]) => name)),
    });
  }

  async updateTeam(teamName, patch) {
    return this.#commit((next) => {
      const name = normalizeLabel(teamName, "team");
      assert(Object.hasOwn(next.teams, name), "UNKNOWN_TEAM", "cannot update an unknown team.", { team: name });
      assert(isRecord(patch), "INVALID_LEDGER_STATE", "team patch must be an object.");
      next.teams[name] = { ...next.teams[name], ...cloneJson(patch) };
      return cloneJson(next.teams[name]);
    });
  }

  async updateAccount(accountName, patch) {
    return this.#commit((next) => {
      const name = normalizeLabel(accountName, "account");
      assert(Object.hasOwn(next.accounts, name), "UNKNOWN_ACCOUNT", "cannot update an unknown account.", { account: name });
      assert(isRecord(patch), "INVALID_LEDGER_STATE", "account patch must be an object.");
      next.accounts[name] = { ...next.accounts[name], ...cloneJson(patch) };
      return cloneJson(next.accounts[name]);
    });
  }

  async appendWriteAhead({ intentId = randomUUID(), action, target = {}, data = {} } = {}) {
    return this.#commit((next) => {
      assert(typeof intentId === "string" && intentId.trim().length > 0,
        "INVALID_INTENT", "intentId must be a non-empty string.");
      assert(typeof action === "string" && action.trim().length > 0,
        "INVALID_INTENT", "action must be a non-empty string.");
      assert(isRecord(data), "INVALID_INTENT", "intent data must be an object.");
      assert(!next.journal.some((entry) => entry.intentId === intentId),
        "DUPLICATE_INTENT", "intentId already exists; refusing to replay the write.", { intentId });
      const entry = {
        sequence: next.journal.length + 1,
        phase: "intent",
        intentId: intentId.trim(),
        action: action.trim(),
        target: normalizeTarget(target, next),
        at: nowIso(this.clock),
        data: cloneJson(data),
      };
      next.journal.push(entry);
      return cloneJson(entry);
    });
  }

  async appendConfirmed({ intentId, data = {} } = {}) {
    return this.#commit((next) => {
      assert(typeof intentId === "string" && intentId.trim().length > 0,
        "INVALID_CONFIRMATION", "intentId must be a non-empty string.");
      assert(isRecord(data), "INVALID_CONFIRMATION", "confirmation data must be an object.");
      const intent = next.journal.find((entry) => entry.phase === "intent" && entry.intentId === intentId);
      assert(intent, "INTENT_NOT_FOUND", "confirmation must reference a persisted write-ahead intent.", { intentId });
      assert(!next.journal.some((entry) => entry.phase === "confirmed" && entry.intentId === intentId),
        "INTENT_ALREADY_CONFIRMED", "intent is already confirmed.", { intentId });
      const entry = {
        sequence: next.journal.length + 1,
        phase: "confirmed",
        intentId,
        action: intent.action,
        target: cloneJson(intent.target),
        at: nowIso(this.clock),
        data: cloneJson(data),
      };
      next.journal.push(entry);
      return cloneJson(entry);
    });
  }

  writeAhead(record) {
    return this.appendWriteAhead(record);
  }

  confirmed(record) {
    return this.appendConfirmed(record);
  }

  async #commit(mutator) {
    const operation = this.writeQueue.then(async () => {
      const next = cloneJson(this.document);
      const result = mutator(next);
      next.updatedAt = nowIso(this.clock);
      validateLedgerDocument(next);
      await atomicWriteJson(this.path, next);
      this.document = next;
      return result;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }
}

export function createJsonLedger(filePath, options) {
  return JsonLedger.create(filePath, options);
}

export function loadJsonLedger(filePath, options) {
  return JsonLedger.load(filePath, options);
}

export function openJsonLedger(filePath, options) {
  return JsonLedger.open(filePath, options);
}
