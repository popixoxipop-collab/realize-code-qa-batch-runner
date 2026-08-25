const TRAINEE_ROLES = new Set(["교육생", "trainee"]);
const MANAGER_ROLES = new Set(["매니저", "manager"]);

const naturalNameCollator = new Intl.Collator("ko", {
  numeric: true,
  sensitivity: "base",
});

export class RosterValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RosterValidationError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new RosterValidationError(code, message, details);
}

function normalizeText(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim()
    : "";
}

function requiredText(value, field, index) {
  const normalized = normalizeText(value);
  if (!normalized) {
    fail("INVALID_ROSTER_RECORD", `${field} must be a non-empty string.`, { index, field });
  }
  return normalized;
}

export function normalizeClassName(value) {
  const normalized = normalizeText(value);
  const match = /^([a-z])(?:\s*반)?$/i.exec(normalized);
  if (!match) {
    fail("INVALID_CLASS_NAME", "className must be a single Latin letter with an optional 반 suffix.", {
      value,
    });
  }
  return `${match[1].toUpperCase()}반`;
}

function classifyRole(value, index) {
  const normalized = requiredText(value, "role", index);
  const comparable = /^[A-Za-z]+$/.test(normalized) ? normalized.toLowerCase() : normalized;
  if (TRAINEE_ROLES.has(comparable)) return "trainee";
  if (MANAGER_ROLES.has(comparable)) return "manager";
  fail("UNSUPPORTED_ROSTER_ROLE", "Only trainee and manager roster roles are supported.", {
    index,
    role: normalized,
  });
}

function parseInput(input) {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch (cause) {
    fail("INVALID_ROSTER_JSON", "Roster input is not valid JSON.", { cause: cause.message });
  }
}

function normalizeAccountId(value, index) {
  if (value === undefined || value === null) return undefined;
  const accountId = requiredText(value, "accountId", index);
  return accountId;
}

function freezeRecord(record) {
  return Object.freeze(record.accountId === undefined
    ? {
        displayName: record.displayName,
        className: record.className,
        teamName: record.teamName,
        role: record.role,
      }
    : {
        displayName: record.displayName,
        className: record.className,
        teamName: record.teamName,
        role: record.role,
        accountId: record.accountId,
      });
}

function displayIdentity(record) {
  return `${record.className}\u0000${record.displayName}`;
}

function teamKey(record) {
  return `${record.className}\u0000${record.teamName}`;
}

export function validateRosterRecords(records) {
  if (!Array.isArray(records)) {
    fail("INVALID_ROSTER", "Roster records must be an array.");
  }

  const normalized = [];
  const accountIds = new Map();
  const displayIdentities = new Map();

  records.forEach((rawRecord, index) => {
    if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) {
      fail("INVALID_ROSTER_RECORD", "Each roster record must be an object.", { index });
    }

    const roleKind = classifyRole(rawRecord.role, index);
    if (roleKind === "manager") return;

    const record = freezeRecord({
      displayName: requiredText(rawRecord.displayName, "displayName", index),
      className: normalizeClassName(rawRecord.className),
      teamName: requiredText(rawRecord.teamName, "teamName", index),
      role: "교육생",
      accountId: normalizeAccountId(rawRecord.accountId, index),
    });

    if (record.accountId !== undefined) {
      const previous = accountIds.get(record.accountId);
      if (previous) {
        fail("DUPLICATE_ACCOUNT", "An accountId is assigned to more than one roster record.", {
          index,
          previousIndex: previous.index,
          accountId: record.accountId,
          previousTeam: previous.teamName,
          teamName: record.teamName,
        });
      }
      accountIds.set(record.accountId, { index, teamName: record.teamName });
    }

    const identity = displayIdentity(record);
    const sameName = displayIdentities.get(identity) ?? [];
    const ambiguous = sameName.find((previous) =>
      previous.accountId === undefined || record.accountId === undefined);
    if (ambiguous) {
      fail("DUPLICATE_ACCOUNT", "A trainee without accountId cannot be distinguished from another roster record.", {
        index,
        previousIndex: ambiguous.index,
        displayName: record.displayName,
        className: record.className,
        previousTeam: ambiguous.teamName,
        teamName: record.teamName,
      });
    }
    sameName.push({ index, accountId: record.accountId, teamName: record.teamName });
    displayIdentities.set(identity, sameName);

    normalized.push(record);
  });

  return Object.freeze(normalized);
}

export function parseRosterRecords(input) {
  return validateRosterRecords(parseInput(input));
}

function stableNaturalCompare(left, right) {
  const byClass = naturalNameCollator.compare(left.className, right.className);
  if (byClass !== 0) return byClass;
  const byTeam = naturalNameCollator.compare(left.teamName, right.teamName);
  return byTeam !== 0 ? byTeam : left.firstSeen - right.firstSeen;
}

export function groupTeams(input) {
  const records = parseRosterRecords(input);
  const grouped = new Map();

  records.forEach((record, index) => {
    const key = teamKey(record);
    let group = grouped.get(key);
    if (!group) {
      group = {
        className: record.className,
        teamName: record.teamName,
        firstSeen: index,
        members: [],
      };
      grouped.set(key, group);
    }
    group.members.push(record);
  });

  const teams = [...grouped.values()]
    .sort(stableNaturalCompare)
    .map((group) => {
      const members = Object.freeze([...group.members]);
      return Object.freeze({
        className: group.className,
        teamName: group.teamName,
        members,
        accountCount: members.length,
      });
    });

  const seenTeams = new Set();
  for (const team of teams) {
    const key = teamKey(team);
    if (seenTeams.has(key)) {
      fail("DUPLICATE_TEAM", "A class contains duplicate team groups.", {
        className: team.className,
        teamName: team.teamName,
      });
    }
    seenTeams.add(key);
  }

  return Object.freeze(teams);
}

export function summarizeRoster(input) {
  const records = parseRosterRecords(input);
  const teams = groupTeams(records);
  const classNames = [...new Set(records.map((record) => record.className))]
    .sort((left, right) => naturalNameCollator.compare(left, right));

  const byClass = classNames.map((className) => {
    const classAccounts = records.filter((record) => record.className === className).length;
    const classTeams = teams.filter((team) => team.className === className).length;
    return Object.freeze({
      className,
      accountCount: classAccounts,
      teamCount: classTeams,
    });
  });

  return Object.freeze({
    accountCount: records.length,
    teamCount: teams.length,
    classCount: classNames.length,
    byClass: Object.freeze(byClass),
  });
}

export function buildRoster(input) {
  const records = parseRosterRecords(input);
  return Object.freeze({
    records,
    teams: groupTeams(records),
    summary: summarizeRoster(records),
  });
}
