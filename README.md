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
- Direct GMI Cloud answer generation through its OpenAI-compatible API
- Atomic JSON resume ledger with run-anchor validation
- Write-ahead/confirmed journal and unresolved-intent reporting
- Credential-shaped field/value rejection before ledger writes
- Exact SHA-256 question fingerprints and fail-closed unknown prompts
- Adaptive real-key typing, grading waits, re-explanation, handoff, and completion detection

## Important browser boundary

A browser tab is not an isolated account. Tabs in the same Chrome profile share cookies. The Playwright commands create a fresh `BrowserContext` for each active account and never share its authentication state. A custom live portal driver must instead implement `verifyIsolatedProfiles()` and prove that every configured profile maps to a distinct authentication context; that lower-level CLI refuses live execution without the proof.

Five teams can run concurrently only when five isolated browser profiles or contexts exist.

## Install and test

```bash
npm install
npm test
npm run check
```

The deterministic core uses Node's built-in test runner. The standalone browser command uses `playwright-core` with an existing local Chrome installation; it does not download or bundle a browser.

## One-command autonomous run

Create an ignored local `.env` once:

```bash
cp .env.example .env
```

Set the real key only inside `.env`:

```dotenv
GMI_API_KEY=replace-with-the-real-key
GMI_MODEL=MiniMaxAI/MiniMax-M3
```

Preview the live roster and execution plan without logging in, submitting, starting a session, or calling GMI:

```bash
npm run autonomous -- --classes F --dry-run
```

Then run one class end to end:

```bash
npm run autonomous -- \
  --classes F \
  --repo https://github.com/Team-IZ/Backend \
  --class-concurrency 1 \
  --team-concurrency 5 \
  --llm-concurrency 8 \
  --yes
```

For all configured classes, change `--classes` to `A,B,C,D,E,F` and choose a class concurrency appropriate for the machine. The autonomous path performs this sequence in every team lane:

```text
representative login
  -> submit only when the visible state says submission is required
  -> verify the exact GitHub owner/repository
  -> confirm the same team submission from a second trainee
  -> poll analysis with jitter until ready
  -> run each trainee session sequentially
  -> generate answers through GMI and submit them with verified real-key input
```

The GMI adapter uses `POST https://api.gmi-serving.com/v1/chat/completions`, model `MiniMaxAI/MiniMax-M3`, and the required `User-Agent: curl/8.0`. Transient network, 408/409/425/429, and 5xx failures are retried with exponential jitter. Authentication errors fail immediately. Model requests are bounded by `--llm-concurrency`; exact duplicate prompts share one in-flight result and later duplicates reuse the in-memory answer.

Neither the API key nor generated answer text is written to the ledger. Logs contain prompt fingerprints, model name, latency, retry metadata, and answer character counts only. `.env`, run ledgers, credentials, and answers are excluded from Git and npm packages.

Useful autonomous options:

```text
--branch NAME                  optional repository branch
--analysis-timeout-minutes N  maximum analysis wait; default 45
--analysis-poll-seconds N     base poll interval with jitter; default 15
--llm-concurrency N           maximum simultaneous GMI calls; default 8
--llm-timeout-seconds N       timeout for one GMI attempt; default 90
--llm-max-attempts N          transient GMI attempts; default 4
--gmi-model ID                default MiniMaxAI/MiniMax-M3
--gmi-api-url URL             override only for an OpenAI-compatible endpoint
--env-file FILE               local environment file; default .env
--start-at N                  1-based trainee resume offset per class
--limit-per-class N           bounded verification scope
--headed                      show Chrome windows
```

The runner fails closed instead of guessing when it sees a different repository, failed analysis, submission deadline, missing teammate confirmation, unknown portal state, exhausted re-explanation, or GMI authentication failure. A repository submit intent is journaled before the click; after interruption, the next run reconciles the visible team state and does not blindly resubmit.

## Standalone Chrome run with live-generated answers

The fixed Playwright command reproduces the verified UI sequence without requiring an interactive browser-control agent for routine clicks and waits:

```bash
npm run playwright:class -- --class F --start-at 3
```

`--start-at` is a 1-based index in the visible trainee order after the manager is excluded. For example, `--start-at 3` skips the first two F-class trainees and resumes with the third. Add `--limit 1` for a one-account verification run or `--headed` to keep Chrome visible.

The command discovers the visible roster, uses a fresh isolated Chrome context for each account, verifies the account banner, and automates session start, code-point handoff, real-key answer entry, submit, grading waits, and completion detection. It writes only hashes and state transitions to `runs/playwright-<class>.ndjson`; credentials and answer text are never persisted.

Waiting is driven by the same API responses visible in Chrome DevTools Network rather than by long fixed DOM sleeps. The runner measures response latency by category, keeps an EWMA and recent p95, and adapts the next timeout and retry delay. If the login response times out after the portal has already entered the account, the runner reconciles against the verified account banner before retrying. Code-point handoff accepts either its matching API response or the rendered next-question/completion UI, so a delayed or changed response route does not create a false failure. Answer submission initially allows up to four minutes because grading can be slow. After an HTTP failure, the runner waits, reloads the current session through its GET API, and retries the preserved answer only when the same prompt proves that the submission was not applied. Three consecutive reconciled answer-API failures stop that account with its session preserved instead of starting another trainee.

When the current question appears, the process emits one JSON object with `event: "answer_required"`, the visible question/code text, and an exact fingerprint, then waits at `ANSWER>`. Generate a fresh 3–5 sentence answer from that visible prompt and the pinned repository source, enter it once, and let the script continue. This is the intended direct-answer mode; no repository-specific answer bank is loaded or published.

Without `--prepare-repository`, the standalone command intentionally stops if an account is not already at the understanding-session stage. The `autonomous` command enables the stricter team preparation flow described above.

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

In manual mode, simultaneous questions enter one in-memory answer broker. The broker emits `answer_queued` for waiting prompts, activates exactly one `answer_required` prompt at a time, and accepts the answer at `ANSWER[qNNNNNN]>`. In autonomous mode, prompts go directly to the bounded GMI provider instead. In either mode, an answer is reused for concurrent or later accounts only when the complete normalized visible prompt and code produce the exact same SHA-256 fingerprint; `answer_reused` reports each reuse. Answer text is never written to disk. A failed account stops only its team lane; the other isolated teams and classes continue, and the final `parallel_result` reports partial failures.

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

## Advanced custom portal-adapter setup

The `autonomous` command does not require this adapter. Use the lower-level adapter API only when integrating a different browser-session service. Copy the templates to ignored local files:

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
