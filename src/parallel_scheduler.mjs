export class ParallelSchedulerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ParallelSchedulerError";
    this.code = code;
    this.details = details;
  }
}

function invariant(condition, code, message, details = {}) {
  if (!condition) throw new ParallelSchedulerError(code, message, details);
}

export function normalizeClassList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  const classes = raw.map((item) => `${String(item).normalize("NFKC").trim().replace(/반$/u, "").toUpperCase()}반`);
  invariant(classes.length > 0 && classes.every((item) => /^[A-Z]반$/u.test(item)), "INVALID_CLASSES", "Classes must be comma-separated letters such as A,B,F.");
  invariant(new Set(classes).size === classes.length, "DUPLICATE_CLASS", "Each class may be selected only once.");
  return Object.freeze(classes);
}

export async function mapConcurrent(items, concurrency, worker) {
  invariant(Array.isArray(items), "INVALID_ITEMS", "items must be an array.");
  invariant(Number.isInteger(concurrency) && concurrency > 0, "INVALID_CONCURRENCY", "concurrency must be a positive integer.");
  invariant(typeof worker === "function", "INVALID_WORKER", "worker must be a function.");
  const results = new Array(items.length);
  let cursor = 0;
  const laneCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: laneCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

export function groupAccountsByTeam(accounts) {
  invariant(Array.isArray(accounts), "INVALID_ACCOUNTS", "accounts must be an array.");
  const groups = new Map();
  for (const account of accounts) {
    const teamName = String(account?.teamName ?? "").normalize("NFKC").trim();
    invariant(teamName.length > 0, "INVALID_TEAM", "Every account must have a teamName.");
    if (!groups.has(teamName)) groups.set(teamName, []);
    groups.get(teamName).push(account);
  }
  return [...groups].map(([teamName, teamAccounts]) => Object.freeze({ teamName, accounts: Object.freeze(teamAccounts) }));
}

export async function runTeamLanes({ groups, concurrency, runAccount, prepareTeam = null }) {
  invariant(Array.isArray(groups), "INVALID_TEAM_GROUPS", "groups must be an array.");
  return mapConcurrent(groups, concurrency, async (group) => {
    const completed = [];
    if (prepareTeam) {
      invariant(typeof prepareTeam === "function", "INVALID_TEAM_PREPARER", "prepareTeam must be a function.");
      try {
        await prepareTeam(group);
      } catch (error) {
        return {
          teamName: group.teamName,
          status: "failed",
          phase: "prepare",
          completed,
          failedAccount: null,
          error,
        };
      }
    }
    for (const account of group.accounts) {
      try {
        completed.push(await runAccount(account, group));
      } catch (error) {
        return {
          teamName: group.teamName,
          status: "failed",
          phase: "account",
          completed,
          failedAccount: account,
          error,
        };
      }
    }
    return { teamName: group.teamName, status: "complete", completed };
  });
}

export class SerialAnswerBroker {
  constructor({ ask, onQueued = () => {}, onActive = () => {} }) {
    invariant(typeof ask === "function", "INVALID_ASK", "ask must be a function.");
    this.ask = ask;
    this.onQueued = onQueued;
    this.onActive = onActive;
    this.tail = Promise.resolve();
    this.sequence = 0;
    this.waiting = 0;
  }

  request(payload) {
    const requestId = `q${String(++this.sequence).padStart(6, "0")}`;
    this.waiting += 1;
    this.onQueued({ requestId, waiting: this.waiting, payload });
    const task = this.tail.then(async () => {
      this.waiting -= 1;
      this.onActive({ requestId, waiting: this.waiting, payload });
      const answer = String(await this.ask({ requestId, payload })).normalize("NFC").trim();
      invariant(answer.length > 0, "EMPTY_ANSWER", "Answer must not be empty.", { requestId });
      return answer;
    });
    this.tail = task.catch(() => {});
    return task;
  }
}

export class ExactAnswerMemo {
  constructor({ resolveAnswer, onReuse = () => {}, onStore = () => {} }) {
    invariant(typeof resolveAnswer === "function", "INVALID_ANSWER_RESOLVER", "resolveAnswer must be a function.");
    this.resolveAnswer = resolveAnswer;
    this.onReuse = onReuse;
    this.onStore = onStore;
    this.answers = new Map();
    this.inflight = new Map();
  }

  request(payload) {
    const fingerprint = String(payload?.fingerprint ?? "");
    invariant(/^sha256:[a-f0-9]{64}$/u.test(fingerprint), "INVALID_FINGERPRINT", "An exact SHA-256 prompt fingerprint is required.");
    if (this.answers.has(fingerprint)) {
      this.onReuse({ fingerprint, source: "memory", payload });
      return Promise.resolve(this.answers.get(fingerprint));
    }
    if (this.inflight.has(fingerprint)) {
      this.onReuse({ fingerprint, source: "inflight", payload });
      return this.inflight.get(fingerprint);
    }

    const task = Promise.resolve()
      .then(() => this.resolveAnswer(payload))
      .then((value) => {
        const answer = String(value).normalize("NFC").trim();
        invariant(answer.length > 0, "EMPTY_ANSWER", "Answer must not be empty.");
        this.answers.set(fingerprint, answer);
        this.onStore({ fingerprint, payload });
        return answer;
      })
      .finally(() => this.inflight.delete(fingerprint));
    this.inflight.set(fingerprint, task);
    return task;
  }
}
