import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createBatchLedgerAdapter } from "./batch_ledger_adapter.mjs";
import { createBatchOrchestrator, groupTraineesByTeam } from "./batch_orchestrator.mjs";
import { DEFAULT_REVIEW_REPOSITORY_URL } from "./realize_batch_runner.mjs";
import { normalizeClassName } from "./roster.mjs";

export class BatchCliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BatchCliError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new BatchCliError(code, message, details);
}

function valueAfter(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail("MISSING_OPTION_VALUE", `${option} requires a value.`);
  return value;
}

export function parseBatchArgs(args) {
  const parsed = { yes: false, dryRun: false, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--yes" || option === "-y") parsed.yes = true;
    else if (option === "--dry-run") parsed.dryRun = true;
    else if (option === "--json") parsed.json = true;
    else if (option === "--help" || option === "-h") parsed.help = true;
    else if (["--config", "--class", "--repo", "--round", "--concurrency", "--profiles", "--ledger", "--driver", "--roster"].includes(option)) {
      const value = valueAfter(args, index, option);
      index += 1;
      const key = ({
        "--config": "configPath",
        "--class": "className",
        "--repo": "repositoryUrl",
        "--round": "round",
        "--concurrency": "requestedConcurrency",
        "--profiles": "profileIds",
        "--ledger": "ledgerPath",
        "--driver": "driverPath",
        "--roster": "rosterPath",
      })[option];
      parsed[key] = option === "--concurrency"
        ? Number(value)
        : option === "--profiles"
          ? value.split(",").map((entry) => entry.trim()).filter(Boolean)
          : value;
    } else {
      fail("UNKNOWN_OPTION", `Unknown option: ${option}`);
    }
  }
  if (parsed.requestedConcurrency !== undefined
    && (!Number.isInteger(parsed.requestedConcurrency) || parsed.requestedConcurrency < 1)) {
    fail("INVALID_CONCURRENCY", "--concurrency must be a positive integer.");
  }
  return parsed;
}

function resolveFrom(baseDirectory, value) {
  if (!value) return undefined;
  return isAbsolute(value) ? value : resolve(baseDirectory, value);
}

async function loadJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) fail("INVALID_JSON", `Invalid JSON file: ${path}`);
    throw error;
  }
}

export async function resolveBatchConfig(args, { cwd = process.cwd() } = {}) {
  const cli = Array.isArray(args) ? parseBatchArgs(args) : args;
  const configPath = resolveFrom(cwd, cli.configPath);
  const fileConfig = configPath ? await loadJson(configPath) : {};
  const baseDirectory = configPath ? dirname(configPath) : cwd;
  const merged = {
    ...fileConfig,
    ...Object.fromEntries(Object.entries(cli).filter(([, value]) => value !== undefined)),
  };
  const profiles = merged.profileIds ?? merged.profiles ?? [];
  return {
    ...merged,
    repositoryUrl: merged.repositoryUrl ?? merged.repo ?? DEFAULT_REVIEW_REPOSITORY_URL,
    requestedConcurrency: merged.requestedConcurrency ?? merged.concurrency ?? 5,
    profileIds: Array.isArray(profiles) ? profiles : String(profiles).split(",").map((entry) => entry.trim()).filter(Boolean),
    driverPath: resolveFrom(baseDirectory, merged.driverPath ?? merged.driver),
    rosterPath: resolveFrom(baseDirectory, merged.rosterPath ?? merged.roster),
    ledgerPath: merged.ledgerPath ? resolveFrom(baseDirectory, merged.ledgerPath) : undefined,
    configPath,
    baseDirectory,
  };
}

function normalizeClassList(values) {
  const classes = [...new Set(values.map(normalizeClassName))];
  if (classes.length === 0) fail("NO_CLASSES", "The portal driver returned no selectable classes.");
  return classes.sort();
}

export async function selectClass({ configuredClass, listClasses, choose }) {
  if (configuredClass) return normalizeClassName(configuredClass);
  if (typeof listClasses !== "function") fail("CLASS_SELECTION_UNAVAILABLE", "Set --class or implement portal.listClasses().");
  const classes = normalizeClassList(await listClasses());
  if (classes.length === 1) return classes[0];
  if (typeof choose !== "function") fail("CLASS_SELECTION_UNAVAILABLE", "Multiple classes are available but no class chooser was provided.");
  const selected = await choose(classes);
  return normalizeClassName(selected);
}

export function buildDryRunPlan(roster, { className, requestedConcurrency, profileIds, repositoryUrl, round }) {
  const selectedClass = normalizeClassName(className);
  const selected = roster.filter((account) => normalizeClassName(account.className) === selectedClass);
  const plan = groupTraineesByTeam(selected);
  const actualConcurrency = Math.min(requestedConcurrency, plan.teams.length, new Set(profileIds).size);
  return {
    mode: "dry-run",
    className: selectedClass,
    round,
    repositoryUrl,
    requestedConcurrency,
    actualConcurrency,
    totals: {
      roster: plan.rosterCount,
      trainees: plan.traineeCount,
      excluded: plan.excludedCount,
      teams: plan.teams.length,
    },
    teams: plan.teams.map((team, index) => ({
      teamId: team.id,
      teamName: team.name,
      profileId: profileIds[index % Math.max(1, actualConcurrency)] ?? null,
      accounts: team.accounts.map((account) => ({
        accountId: account.accountId,
        displayName: account.displayName ?? account.accountId,
      })),
    })),
  };
}

export async function loadPortal(driverPath, options) {
  if (!driverPath) fail("DRIVER_REQUIRED", "Live execution requires --driver or config.driver.");
  const module = await import(pathToFileURL(driverPath).href);
  const factory = module.createPortalAdapter ?? module.default;
  if (typeof factory !== "function") fail("INVALID_DRIVER", "Driver must export createPortalAdapter() or a default factory.");
  const portal = await factory(options);
  for (const method of ["getRoster", "verifyIsolatedProfiles", "submitRepositoryOnce", "confirmTeamSubmission", "waitAnalysisReady", "runAccount"]) {
    if (typeof portal?.[method] !== "function") fail("INVALID_DRIVER", `Portal driver is missing ${method}().`);
  }
  return portal;
}

export async function executeBatch(config, { chooseClass, confirm } = {}) {
  if (config.rosterPath && !config.dryRun) {
    fail("ROSTER_FILE_LIVE_FORBIDDEN", "--roster is planning-only; live execution must read the visible portal roster.");
  }
  let portal = null;
  let rosterFromFile = null;
  if (config.rosterPath) rosterFromFile = await loadJson(config.rosterPath);
  if (config.driverPath) {
    portal = await loadPortal(config.driverPath, {
      profileIds: config.profileIds,
      repositoryUrl: config.repositoryUrl,
      round: config.round,
    });
  }

  const className = await selectClass({
    configuredClass: config.className,
    listClasses: portal?.listClasses?.bind(portal)
      ?? (rosterFromFile ? async () => rosterFromFile.map((record) => record.className) : undefined),
    choose: chooseClass,
  });
  const round = config.round ?? await portal?.getRound?.({ className });
  if (!round || typeof round !== "string") fail("ROUND_REQUIRED", "Set --round or implement portal.getRound().");
  const profileIds = config.profileIds.length > 0
    ? config.profileIds
    : await portal?.listProfileIds?.({ className }) ?? [];

  const roster = rosterFromFile ?? await portal.getRoster({ className });
  const selectedRoster = roster.filter((account) => normalizeClassName(account.className) === className);
  const dryRunPlan = buildDryRunPlan(selectedRoster, {
    className,
    requestedConcurrency: config.requestedConcurrency,
    profileIds,
    repositoryUrl: config.repositoryUrl,
    round,
  });
  if (config.dryRun) return dryRunPlan;
  if (profileIds.length === 0) fail("NO_ISOLATED_PROFILES", "Live execution requires at least one isolated profile ID.");
  const isolation = await portal.verifyIsolatedProfiles({ profileIds, className });
  if (isolation !== true) fail("PROFILE_ISOLATION_UNVERIFIED", "Portal driver could not prove that every profile has a distinct authentication context.", { isolation });

  if (!config.yes) {
    const approved = await confirm(dryRunPlan);
    if (!approved) return { ...dryRunPlan, mode: "cancelled", status: "cancelled" };
  }

  const safeRound = round.normalize("NFKC").replace(/[^A-Za-z0-9가-힣._-]+/g, "-");
  const safeClass = className.replace(/[^A-Za-z0-9가-힣._-]+/g, "-");
  const ledgerPath = config.ledgerPath ?? resolve(config.baseDirectory, "runs", `${safeClass}-${safeRound}.json`);
  const ledger = createBatchLedgerAdapter(ledgerPath, { round });
  const cachedPortal = {
    async verifyIsolatedProfiles() { return isolation === true; },
    async getRoster() { return selectedRoster; },
    submitRepositoryOnce: portal.submitRepositoryOnce.bind(portal),
    confirmTeamSubmission: portal.confirmTeamSubmission.bind(portal),
    waitAnalysisReady: portal.waitAnalysisReady.bind(portal),
    runAccount: portal.runAccount.bind(portal),
  };
  return createBatchOrchestrator({
    className,
    repositoryUrl: config.repositoryUrl,
    requestedConcurrency: config.requestedConcurrency,
    profileIds,
    portal: cachedPortal,
    ledger,
    requireAccountCheckpoints: true,
  }).run();
}

export const HELP_TEXT = `Usage: npm run batch -- [options]

Options:
  --config FILE        JSON defaults (driver, round, profiles, concurrency)
  --class F            Class to run; omit for an interactive class menu
  --repo URL           Review repository (defaults to Team-IZ/Backend)
  --round ID           Stable round label/ID; driver.getRound may provide it
  --profiles A,B,C     Distinct isolated browser profile IDs
  --concurrency N      Maximum parallel team lanes (default: 5)
  --driver FILE        Portal driver module for live execution
  --ledger FILE        Resume ledger path
  --roster FILE        JSON roster for planning or a driver-independent dry run
  --dry-run            Print the selected teams/accounts without side effects
  --yes, -y            Skip the final live-run confirmation
  --json               Print machine-readable JSON
  --help, -h           Show this help
`;
