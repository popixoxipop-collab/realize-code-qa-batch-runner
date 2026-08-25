# RealiZe Code QA Batch Runner

A deterministic, resumable runner for **authorized RealiZe demo/QA accounts**. It drives an already-selected Codex Browser `Tab`; it does not import Playwright, browser-client, cookies, or credentials.

## Default review repository

The current default is [Team-IZ/Backend](https://github.com/Team-IZ/Backend). Import `DEFAULT_REVIEW_REPOSITORY_URL` from the runner when preparing the repository-submission step. Override it explicitly for a different authorized QA run.

## What it handles

- Exact SHA-256 question fingerprints and fail-closed unknown prompts
- Account-banner verification before any answer submission
- Real-key input in adaptive 8–20 character chunks
- Exact textarea-content verification
- EWMA and recent p95 timing for loading, grading, and typing
- Write-ahead and confirmed checkpoints around browser side effects
- Grading, re-explanation, code-point handoff, explicit final submission, and completion
- Duplicate-submit prevention after interruption

## Safety boundary

Use only with accounts and assessments you are authorized to test. One Chrome profile is one authentication context: **do not run multiple account workers in parallel in different tabs of the same profile**. True account parallelism requires separately isolated browser profiles or browser instances.

The public package intentionally excludes account rosters, passwords, repository-specific answers, and run ledgers.

## Test

```bash
npm test
npm run check
```

## Runtime usage

Import the module from the supported Codex Node browser runtime and pass an existing `Tab`:

```js
const {
  createRealizeBatchRunner,
  fingerprintQuestion,
  AdaptiveWaitStats,
} = await import("/absolute/path/to/src/realize_batch_runner.mjs");

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
  selectors: {
    accountBanner: { role: "button", name: "내 계정" },
    title: (tab) => customVisibleTextLocator(tab, "title"),
    filePath: (tab) => customVisibleTextLocator(tab, "filePath"),
    citedLines: (tab) => customVisibleTextLocator(tab, "citedLines"),
    question: (tab) => customVisibleTextLocator(tab, "question"),
    textarea: { css: 'textarea[placeholder="답을 입력해 주세요"]' },
    submitButton: { role: "button", name: /답변 제출/, exact: false },
    grading: (tab) => gradingStateLocator(tab),
    reExplain: { text: "다시 설명하면" },
    handoff: { text: "마지막 문제예요" },
    handoffButton: { role: "button", name: "시작하기" },
    completion: { text: "끝났어요. 수고했어요" },
  },
  checkpoints: {
    writeAhead: async (record) => persist(record),
    confirmed: async (record) => persist(record),
  },
});

const result = await runner.runAccount();
```

Selectors are dependency-injected because RealiZe markup can change. The runner refuses to guess when the visible account, prompt fingerprint, state, or button label differs from configuration.

## License

MIT
