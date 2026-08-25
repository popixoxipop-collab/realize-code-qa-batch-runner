# RealiZe Code QA Batch Runner

A deterministic, resumable batch runner for **authorized RealiZe demo/QA accounts**. Select a class once; the orchestrator discovers its roster, excludes managers by role, groups trainees by team, and runs isolated team lanes in parallel.

The current default review repository is [Team-IZ/Backend](https://github.com/Team-IZ/Backend).

## What is included

- Interactive class selection or `--class F`
- Multi-class Playwright scheduling with bounded class and team concurrency
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

The deterministic core uses Node's built-in test runner. The standalone browser command uses `playwright-core` with an existing local Chrome installation; it does not download or bundle a browser.

## Standalone Chrome run with live-generated answers

The fixed Playwright command reproduces the verified UI sequence without requiring an interactive browser-control agent for routine clicks and waits:

```bash
npm run playwright:class -- --class F --start-at 3
```

`--start-at` is a 1-based index in the visible trainee order after the manager is excluded. For example, `--start-at 3` skips the first two F-class trainees and resumes with the third. Add `--limit 1` for a one-account verification run or `--headed` to keep Chrome visible.

The command discovers the visible roster, uses a fresh isolated Chrome context for each account, verifies the account banner, and automates session start, code-point handoff, real-key answer entry, submit, grading waits, and completion detection. It writes only hashes and state transitions to `runs/playwright-<class>.ndjson`; credentials and answer text are never persisted.

Waiting is driven by the same API responses visible in Chrome DevTools Network rather than by long fixed DOM sleeps. The runner measures response latency by category, keeps an EWMA and recent p95, and adapts the next timeout and retry delay. If the login response times out after the portal has already entered the account, the runner reconciles against the verified account banner before retrying. Code-point handoff accepts either its matching API response or the rendered next-question/completion UI, so a delayed or changed response route does not create a false failure. Answer submission initially allows up to four minutes because grading can be slow. After an HTTP failure, the runner waits, reloads the current session through its GET API, and retries the preserved answer only when the same prompt proves that the submission was not applied. Three consecutive reconciled answer-API failures stop that account with its session preserved instead of starting another trainee.

When the current question appears, the process emits one JSON object with `event: "answer_required"`, the visible question/code text, and an exact fingerprint, then waits at `ANSWER>`. Generate a fresh 3–5 sentence answer from that visible prompt and the pinned repository source, enter it once, and let the script continue. This is the intended direct-answer mode; no repository-specific answer bank is loaded or published.

The standalone command intentionally stops if an account is not already at the understanding-session stage. Repository submission and analysis orchestration remain behind the stricter portal-adapter workflow below so an unfinished or ambiguous team submission is never replayed automatically.

## Parallel classes and team lanes

Preview all six classes without starting or resuming an assessment:

```bash
npm run playwright:parallel -- \
  --classes A,B,C,D,E,F \
  --class-concurrency 6 \
  --team-concurrency 5 \
  --dry-run
```

After reviewing the visible-roster plans, start the live run explicitly:

```bash
npm run playwright:parallel -- \
  --classes A,B,C,D,E,F \
  --class-concurrency 6 \
  --team-concurrency 5 \
  --yes
```

The scheduler can therefore run up to 30 team lanes at once. Classes run in parallel, teams inside a class run in parallel, and accounts inside one team remain sequential. Every active account gets a fresh Playwright `BrowserContext`; cookies and authentication state are never shared between accounts. Ledger appends from concurrent lanes are serialized per class file.

All simultaneous questions enter one in-memory answer broker. The broker emits `answer_queued` for waiting prompts, activates exactly one `answer_required` prompt at a time, and accepts the answer at `ANSWER[qNNNNNN]>`. During that process only, an answer is reused for concurrent or later accounts when the complete normalized visible prompt and code produce the exact same SHA-256 fingerprint; `answer_reused` reports each reuse. Answer text is never written to disk. A failed account stops only its team lane; the other isolated teams and classes continue, and the final `parallel_result` reports partial failures.

Live parallel execution deliberately requires `--yes`; omitting it fails closed. Use `--limit-per-class 1` for a small live verification, `--start-at N` to apply the same 1-based trainee offset to every selected class, or `--headed` to display the Chrome windows. Because timed sessions keep counting while a question waits in the central queue, choose concurrency that the answer producer can drain within the visible session limits.

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
