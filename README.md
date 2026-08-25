# RealiZe Code QA Batch Runner

A deterministic, resumable batch runner for **authorized RealiZe demo/QA accounts**. Select a class once; the orchestrator discovers its roster, excludes managers by role, groups trainees by team, and runs isolated team lanes in parallel.

The current default review repository is [Team-IZ/Backend](https://github.com/Team-IZ/Backend).

## What is included

- Interactive class selection or `--class F`
- Live-roster adapter contract; no hard-coded real account list
- Exact `role=교육생` filtering and manager exclusion
- One parallel lane per team, with accounts sequential inside each team
- Effective concurrency capped by requested lanes, team count, and verified isolated profiles
- One repository submission per team, followed by analysis wait and account sessions
- Atomic JSON resume ledger with run-anchor validation
- Write-ahead/confirmed journal and unresolved-intent reporting
- Credential-shaped field/value rejection before ledger writes
- Exact SHA-256 question fingerprints and fail-closed unknown prompts
- Adaptive real-key typing, grading waits, re-explanation, handoff, and completion detection

## Important browser boundary

A browser tab is not an isolated account. Tabs in the same Chrome profile share cookies. The live portal driver must implement `verifyIsolatedProfiles()` and prove that every configured profile maps to a distinct authentication context. The CLI refuses live execution without that proof.

With one Chrome profile, use one lane. Five teams can run concurrently only when five isolated browser profiles/contexts exist.

## Install and test

```bash
npm install
npm test
npm run check
```

The package has no runtime dependency. Tests use Node's built-in test runner.

## Preview a class plan without browser side effects

```bash
npm run batch -- \
  --roster examples/sample.roster.json \
  --class F \
  --round demo-round \
  --profiles profile-1,profile-2 \
  --concurrency 5 \
  --dry-run
```

The output reports selected trainees, excluded managers, teams, assigned profiles, and the actual concurrency cap. It never logs in, submits a repository, or sends an answer. `--roster` is accepted only with `--dry-run`; live execution always reads the visible portal roster.

## One-time live setup

Copy the templates to ignored local files:

```bash
cp examples/realize.config.example.json realize.config.json
cp examples/portal-driver.template.mjs portal-driver.local.mjs
```

Connect `portal-driver.local.mjs` to the browser sessions your environment provides. Do not put passwords, cookies, access tokens, or a real roster in the configuration. The driver must expose only visible account metadata and actions:

```js
export async function createPortalAdapter(options) {
  return {
    listClasses,              // -> ["E반", "F반"]
    getRound,                // -> stable round ID or label
    listProfileIds,          // -> isolated profile IDs
    verifyIsolatedProfiles,  // -> true only after real context comparison
    getRoster,               // -> visible roster records
    submitRepositoryOnce,    // one submission attempt per team
    confirmTeamSubmission,   // verify from a second teammate account
    waitAnalysisReady,
    runAccount,              // receives central checkpoints + resume data
  };
}
```

Required roster record:

```js
{
  accountId: "stable-pseudonymous-id", // ASCII machine ID; never a name/email
  displayName: "Visible name",
  className: "F반",
  teamId: "1팀",
  teamName: "1팀",
  role: "교육생" // or "매니저"
}
```

After the one-time setup, run:

```bash
npm run batch -- --config realize.config.json
```

The CLI shows the visible classes, asks for one class, prints the team/account/concurrency plan, and asks once before live side effects. For a previously reviewed plan, `--yes` skips only that last confirmation:

```bash
npm run batch -- --config realize.config.json --class F --yes
```

Useful overrides:

```text
--repo URL           repository URL; default is Team-IZ/Backend
--round ID           stable round label/ID
--profiles A,B,C     distinct isolated profile IDs
--concurrency N      maximum parallel team lanes; default 5
--ledger FILE        explicit resume-ledger location
--dry-run            plan only, no browser mutations
--json               compact machine-readable output
```

Use `npm run batch -- --help` for the full list.

## Scheduling model

For a class with five teams and five isolated profiles:

```text
1팀 profile-1: representative submission -> teammate confirmation -> analysis -> trainee 1 -> ... -> trainee 5
2팀 profile-2: representative submission -> teammate confirmation -> analysis -> trainee 1 -> ... -> trainee 5
3팀 profile-3: representative submission -> teammate confirmation -> analysis -> trainee 1 -> ... -> trainee 5
4팀 profile-4: representative submission -> teammate confirmation -> analysis -> trainee 1 -> ... -> trainee 5
5팀 profile-5: representative submission -> teammate confirmation -> analysis -> trainee 1 -> ... -> trainee 5
```

The team lanes run concurrently. Accounts in one lane never overlap. Effective concurrency is:

```js
Math.min(requestedConcurrency, teamCount, distinctIsolatedProfileCount)
```

## Resume behavior

The default ledger path is `runs/<class>-<round>.json`. It stores only run anchors, team/account states, hashes, and checkpoint metadata.

- Completed accounts are skipped.
- Confirmed team submissions are not replayed.
- A submission left at write-ahead intent is treated as ambiguous and is not blindly repeated.
- An interrupted `running` account resumes from its central write-ahead/confirmed journal and the currently visible portal state.
- Failed or blocked accounts are not replayed; they require explicit reconciliation.
- A different class, round, or repository cannot reuse the ledger.
- Credential-like keys and values are rejected before disk writes.
- A changed team/account set fails closed and requires explicit reconciliation.
- Account/auth mismatch, CAPTCHA, safety prompt, repository-access failure, and exhausted re-explanations quarantine that profile lane; untouched teams remain pending if no safe profile remains.

## Low-level account runner

The batch portal driver's `runAccount({ checkpoints, resume })` can use the included deterministic account runner with an already-selected Browser `Tab`. Always pass through the central values supplied by the orchestrator:

```js
import {
  AdaptiveWaitStats,
  createRealizeBatchRunner,
  fingerprintQuestion,
} from "./src/index.mjs";

const runner = createRealizeBatchRunner({
  tab,
  expectedAccount: "Trainee Name · 교육생",
  answerBank: [
    {
      prompt: {
        title: "Visible code-point title",
        filePath: "src/main/java/example/Controller.java",
        citedLines: "↳ Controller.java:10–15",
        question: "Exact visible question text",
      },
      answer: "A concise, code-grounded answer.",
      reExplain: ["A more literal replacement answer."],
    },
  ],
  selectors,
  checkpoints,
  resume,
});

const result = await runner.runAccount();
```

The low-level runner returns `reconciledCompletion: true` when the verified account is already on the completion screen before it performs any new action. Otherwise, live completion is accepted only after that same account has a central confirmed checkpoint whose visible state is `completion`.

Selectors remain dependency-injected because portal markup can change. The runner refuses to guess when the visible account, prompt fingerprint, state, or button label differs from configuration.

## Safety boundary

Use only with accounts and assessments you are authorized to test. This repository intentionally excludes real rosters, credentials, repository-specific answer banks, run ledgers, and a bypass around the portal UI. The public orchestrator API also calls `verifyIsolatedProfiles()` itself; distinct profile labels alone are never treated as proof of separate authentication contexts.

## License

MIT
