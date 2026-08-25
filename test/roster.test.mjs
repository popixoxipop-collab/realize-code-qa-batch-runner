import assert from "node:assert/strict";
import test from "node:test";

import {
  RosterValidationError,
  buildRoster,
  groupTeams,
  normalizeClassName,
  parseRosterRecords,
  summarizeRoster,
} from "../src/roster.mjs";

const rawRoster = [
  { displayName: "운영 매니저", className: " F ", teamName: "운영", role: "manager", accountId: "manager-1" },
  { displayName: "교육생 10", className: "F", teamName: "10팀", role: "교육생", accountId: "trainee-10-a" },
  { displayName: "교육생 02", className: "Ｆ반", teamName: "2팀", role: "trainee", accountId: "trainee-2-a" },
  { displayName: "교육생 03", className: "f반", teamName: "2팀", role: "교육생" },
  { displayName: "교육생 01", className: "F반", teamName: "1팀", role: "교육생", accountId: "trainee-1-a" },
];

test("normalizeClassName canonicalizes F and F반", () => {
  assert.equal(normalizeClassName("F"), "F반");
  assert.equal(normalizeClassName(" f반 "), "F반");
  assert.equal(normalizeClassName("Ｆ반"), "F반");
  assert.throws(() => normalizeClassName("F class"), (error) => {
    assert.ok(error instanceof RosterValidationError);
    assert.equal(error.code, "INVALID_CLASS_NAME");
    return true;
  });
});

test("parseRosterRecords accepts JSON, normalizes trainees, and excludes managers by role", () => {
  const records = parseRosterRecords(JSON.stringify(rawRoster));
  assert.equal(records.length, 4);
  assert.deepEqual(records.map((record) => record.displayName), ["교육생 10", "교육생 02", "교육생 03", "교육생 01"]);
  assert.ok(records.every((record) => record.className === "F반"));
  assert.ok(records.every((record) => record.role === "교육생"));
  assert.equal("accountId" in records[2], false);
  assert.ok(Object.isFrozen(records));
  assert.ok(records.every(Object.isFrozen));
});

test("unsupported roles and missing required fields fail closed", () => {
  assert.throws(
    () => parseRosterRecords([{ displayName: "A", className: "F", teamName: "1팀", role: "operator" }]),
    (error) => error instanceof RosterValidationError && error.code === "UNSUPPORTED_ROSTER_ROLE",
  );
  assert.throws(
    () => parseRosterRecords([{ displayName: "", className: "F", teamName: "1팀", role: "교육생" }]),
    (error) => error instanceof RosterValidationError && error.code === "INVALID_ROSTER_RECORD",
  );
});

test("duplicate account ids and ambiguous account rows are rejected", () => {
  assert.throws(
    () => parseRosterRecords([
      { displayName: "교육생 01", className: "F", teamName: "1팀", role: "교육생", accountId: "same" },
      { displayName: "교육생 02", className: "F반", teamName: "2팀", role: "교육생", accountId: "same" },
    ]),
    (error) => error instanceof RosterValidationError && error.code === "DUPLICATE_ACCOUNT",
  );
  assert.throws(
    () => parseRosterRecords([
      { displayName: "교육생 01", className: "F", teamName: "1팀", role: "교육생" },
      { displayName: " 교육생 01 ", className: "F반", teamName: "1팀", role: "trainee" },
    ]),
    (error) => error instanceof RosterValidationError && error.code === "DUPLICATE_ACCOUNT",
  );
  assert.throws(
    () => parseRosterRecords([
      { displayName: "교육생 01", className: "F", teamName: "1팀", role: "교육생" },
      { displayName: "교육생 01", className: "F반", teamName: "2팀", role: "교육생", accountId: "known-id" },
    ]),
    (error) => error instanceof RosterValidationError && error.code === "DUPLICATE_ACCOUNT",
  );
});

test("groupTeams uses natural stable team ordering and preserves member order", () => {
  const teams = groupTeams(rawRoster);
  assert.deepEqual(teams.map((team) => team.teamName), ["1팀", "2팀", "10팀"]);
  assert.deepEqual(teams[1].members.map((member) => member.displayName), ["교육생 02", "교육생 03"]);
  assert.deepEqual(teams.map((team) => team.accountCount), [1, 2, 1]);
  assert.ok(Object.isFrozen(teams));
  assert.ok(teams.every((team) => Object.isFrozen(team.members)));
});

test("summarizeRoster and buildRoster report trainee, team, and class counts", () => {
  assert.deepEqual(summarizeRoster(rawRoster), {
    accountCount: 4,
    teamCount: 3,
    classCount: 1,
    byClass: [{ className: "F반", accountCount: 4, teamCount: 3 }],
  });

  const roster = buildRoster(rawRoster);
  assert.equal(roster.records.length, 4);
  assert.equal(roster.teams.length, 3);
  assert.equal(roster.summary.accountCount, 4);
  assert.ok(Object.isFrozen(roster));
});
