# Ticket Conductor: gated, deduplicated and undoable Jira writes for an AI agent

## 1. Project overview

Ticket Conductor is an Atlassian Forge app for Jira Cloud, built for the Codegeist 2026 hackathon. A user asks a Rovo agent to turn an Epic into a plan of up to 8 steps. The app runs the plan as parallel workers. Each step becomes a Jira child issue and gets comments or transitions.

The irreversible-action risk is concrete: a multi-agent run can create many tickets, post comments and move issues in a team's live project, and a retry or duplicate message could repeat any of it. This entry covers how the app keeps those writes bounded, reviewable and undoable. It is a small-scale design, not a general agent-safety solution.

Everything below is tested **in simulation only**. The tests run against in-memory fakes. The model call is off (`CONDUCTOR_LLM=off`) unless a scenario passes a scripted model (`README.md`, `docs/milestones.md`). No live Jira site and no live Rovo agent are required to run the suite.

## 2. Safety approach

1. **The agent cannot write to Jira.** `conductor-router` only has seven app actions. `plan-split` validates a plan and stores it as `planning` with no Jira call. Jira is written only by the effect applier (`src/effects/applier.js`). There is no delete-issue scope. Scopes are `read:jira-work`, `write:jira-work`, `storage:app`, `search:confluence` (`manifest.yml`, `docs/freeze.md`).
2. **Every write is a deduplicated effect.** Each write is a stored row keyed by `sha256(runId|stepId|kind|discriminator)`, and the attempt number is not in the key (`src/effects/requestKey.js`). Retries, duplicate queue messages and concurrent consumers hit the same row, and `applied` rows never reach Jira again.
3. **Blast-radius preview.** `previewBlastRadius` (`src/blast/preview.js`) is a pure function. It lists the writes a plan will make, with request keys, and scores them (child issue 1, transition 4). `plan-split` and `get-run-status` return this card before anything is dispatched.
4. **Server-side confirmation token.** `plan-split` returns `acknowledgement` and `confirmToken` (`src/safety/guard.js`). `acknowledgement` is the line `<score> points, <issues> issues, <transitions> transitions, <field changes> field changes`. The token is the sha256 of the run id, the Epic key, that line, and the sorted request keys of the `createIssue`, `transition`, and `setFields` rows. `dispatch-run` calls `startRun` with `requireConfirmation` (`src/actions/index.js`, `src/run/stateMachine.js`). The run stays `planning` and nothing is enqueued unless `confirm` is the boolean `true`, `acknowledgeBlastRadius` matches the line, and `confirmToken` matches the card. The string `"true"` is refused. `handoffGoal` (`src/actions/handoff.js`) does not dispatch. `fork-run` has its own acknowledgement and token. The dev webtrigger (`src/dev/devDispatch.js`) uses the same handlers and returns 409 without the token. The router prompt (`prompts/router.md`) and the playbook (`prompts/conductor-playbook/SKILL.md`) say "plan and run" is not a confirmation of a plan the user has seen. That matches `tests/scenarios/06-adversarial-tries.md` Try 3.
5. **Risk-triggered approval gate, before the gated children exist.** If the score is 5 or more, or a step transitions an issue it did not create, `plan-split` appends an `approval` step (`src/run/approval.js`). `stepIdsBlockedByOpenApproval` keeps those dependents from getting a child issue at dispatch. The gate's own child is created so a person can move it to Done. The Jira trigger (`src/triggers/childIssueUpdated.js`) records `{approved, actor, note, generator: 'human'}` and `releaseWaitingSteps` then enqueues the held `createIssue`. Non-risky siblings keep running. The watchdog ignores waiting steps.
6. **Compensating undo.** `closeIssue` transitions a child to Done and adds a `conductor-rolled-back` label, and never deletes an issue. `recordRemovedComment` removes a comment. `restoreStatus` writes only if the issue is still in the status the run left it in, so a person's later change is not overwritten. Undo uses the same key scheme, so a second Undo does nothing. The only `method: 'DELETE'` in `src/effects/jira.js` is the comment delete.
7. **Budgets fail closed.** Caps are `maxSteps` 8, `maxModelCalls` 28, and `wallClockMs` of 8 × 12 minutes (`src/run/budget.js`). `commitRunBudget` only records. `runBudgetStop` is checked by `startRun` before the first enqueue, by the step worker before it comments or calls the model (`src/worker/index.js`), and by `spawnWave` before another child (`src/run/leadLoop.js`). A stop sets a running run to `blocked` and skips that write. `completeText` (`src/worker/llm.js`) does not call `chat` when the caller passes a budget that has used up `maxModelCalls`. Equal to the wall-clock or step cap is still inside. The next model call is refused once `usedModelCalls` has reached 28.
8. **Bounded plans and fault injection.** `plan-split` rejects more than 8 steps, unknown worker types and cycles, and stores nothing on rejection. Waves are capped at 3, and a step gets 3 attempts before the run is `blocked`. Ticket text sent to the model is fenced as `<untrusted>` and cannot add effects (`src/worker/guard.js`). Chaos mode can kill a worker, duplicate an effect message or return a Jira 429. It is closed in `production` and `staging` (`src/chaos/faults.js`).

## 3. Supporting evidence

On Node 22.23.4, `npm ci && npm test` gives **364 pass, 1 skipped, 0 fail**. `npm audit` reports **0 vulnerabilities** after `package.json` `overrides` pin `glob` 14.0.4, `minimatch` 11.0.5, and `prosemirror-view` 1.42.9 (the transitive copies pulled in by the Forge packages were the advisory range). `npm run safety-eval` prints **12 pass, 0 fail**. `npm run test:headroom` runs `tests/simulation/scenarios.test.mjs` (31 tests, including the KVS headroom report). Those scenarios drive the real handlers against in-memory fakes of Jira, queues and storage.

The safety table (`src/safety/eval.js`, also asserted by `src/safety/__tests__/guard.test.js`) covers:

- dispatch with no confirm, with boolean `confirm` and no token, with the string `"true"`, with the wrong acknowledgement, and with a token from another card: no enqueue, status stays `planning`;
- a matching token enqueues, and the draft that depends on an approval gate is not among the `createIssue` effects;
- `handoffGoal` does not call `dispatch-run` even when the caller sets `confirm: true` on that same call;
- `fork-run` without a token enqueues nothing;
- a run whose elapsed time is already past `wallClockMs` returns `BUDGET_EXCEEDED` and enqueues nothing;
- `completeText` does not call `chat` when `usedModelCalls` is already 28;
- `prompts/router.md` does not treat "plan and run" as agreement to dispatch;
- the only DELETE in `src/effects/jira.js` is a comment delete.

`tests/scenarios/adversarial.runtime.test.mjs` repeats the string-`"true"` refusal and the missing-token refusal against the handlers. `src/run/__tests__/approval.test.js` asserts the gated draft's `createIssue` appears only after `approveGate`. The simulation scenarios `a plan over the blast threshold grows one approval gate` and `an approval gate holds its dependents while a sibling finishes` assert the same on the fake board (`tests/simulation/scenarios.test.mjs`).

Scenarios still fail if storage byte use exceeds the recorded budget in `tests/simulation/budget.mjs`. `src/__tests__/architectureFreeze.test.js` fails if scopes, queues, actions or entities change. `npm run safety-eval` is also a step in `.github/workflows/ci.yml`. `forge lint` is skipped in that workflow when `FORGE_API_TOKEN` is unset. This run did not have that token, so lint was not executed here.

## 4. Limitations

- **Simulation only.** The fake Jira is this repo's model of the REST surface (`tests/simulation/fakes.mjs`), so real workflows, permissions and rate limits may differ.
- **No live LLM or Rovo agent in the tests.** The router-prompt checks are string matches plus handler tests. `npm run safety-eval` reads `prompts/router.md`. It does not chat with a model. `tests/scenarios/06-adversarial-tries.md` is still marked not yet executed live.
- **The token is visible to the caller.** `plan-split` returns `confirmToken`. A caller that copies it, including a model that ignores the prompt, passes the handler. The handler's guarantee is that a call without the matching token and acknowledgement does not enqueue. It cannot see whether a later chat turn was a person.
- **`startRun` without `requireConfirmation` still enqueues.** That flag is set by `dispatch-run`. Unit tests and the lower-level simulator helpers call `startRun` directly. It is not a Rovo action. `handoffGoal` and the dev webtrigger do not use the unguarded path.
- **The gate holds creation of dependents, not of the gate itself.** The gate's child issue is created at dispatch so a person has something to transition. Other children that depend on the gate wait. Close still assumes a status named `Done`.
- **Undo is partial.** Closed children stay, labelled `conductor-rolled-back`. Memory rows and flight-recorder events stay. `setFields` and `restoreFields` are described on the preview card and are not in `EFFECT_KINDS`, so field edits are not applied and not restored (`docs/blast-radius.md`).
- **A budget stop refuses the next enqueue and the next model call.** `commitRunBudget` does not itself flip status. An effect that was already queued can still be applied. The worker checks before it enqueues its own comments.
- **Dependency overrides.** The patched `glob`, `minimatch`, and `prosemirror-view` versions are forced with npm `overrides` because they sit under `@forge/*`. `npm audit` is clean on this lockfile. A future Forge release may carry the patches without the override.

## 5. How to reproduce

```sh
git clone https://github.com/LeoLin990405/ticket-conductor-safety.git && cd ticket-conductor-safety
npm ci                 # Node 22.23.x
npm test               # unit + simulation; no Jira or secrets needed
npm run test:headroom  # tests/simulation/scenarios.test.mjs
npm run safety-eval    # pass/fail table of the irreversible-action checks
npm audit              # 0 vulnerabilities on this lockfile
```

Start with `docs/blast-radius.md`, `src/safety/guard.js`, `docs/freeze.md`, and `tests/simulation/scenarios.test.mjs`.
