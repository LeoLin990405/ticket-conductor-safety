# Ticket Conductor: gated, deduplicated and undoable Jira writes for an AI agent

## 1. Project overview

Ticket Conductor is an Atlassian Forge app for Jira Cloud, built for the Codegeist 2026 hackathon. A user asks a Rovo agent to turn an Epic into a plan of up to 8 steps. The app runs that plan as parallel workers. Each step becomes a Jira child issue and may get comments, transitions, or scalar field edits.

The irreversible-action risk is concrete. One run can create many tickets, post comments, move issues, and edit fields, and a retry can repeat any of it. This entry is how those writes stay bounded, reviewable, and undoable. It is a small design, not a general agent-safety solution.

Everything below is tested **in simulation only**. The model call is off (`CONDUCTOR_LLM=off`) unless a scenario passes a scripted model. No live Jira site and no live Rovo agent are required.

## 2. Safety approach

1. **The agent cannot write to Jira.** `conductor-router` has seven app actions. `plan-split` stores a run as `planning` and does not call Jira. Only the effect applier writes (`src/effects/applier.js`). There is no delete-issue scope. Scopes are `read:jira-work`, `write:jira-work`, `storage:app`, and `search:confluence`.
2. **Every write is one deduplicated effect.** The key is `sha256(runId|stepId|kind|discriminator)`. The attempt number is not in it (`src/effects/requestKey.js`). An `applied` or `failed` row never reaches Jira again.
3. **Blast-radius preview.** `previewBlastRadius` lists the writes, with request keys, and scores them (child issue 1, transition or field edit 4). `plan-split` and `get-run-status` return the card before dispatch.
4. **The token is not in the tool result.** `plan-split`, `get-run-status`, and `handoffGoal` return the acknowledgement line and do not return `confirmToken`. The public sha256 of the card is rejected. The Run panel reads the Forge account id from the resolver context. `approveFromPanel` (`src/safety/grants.js`) mints `v2.<id>.<hmac>` with HMAC-SHA256 under `CONDUCTOR_CONFIRM_SECRET`, or a random process key when that is unset. The grant lasts 15 minutes, the first success uses it, and the panel response does not include it. `startRun` always calls `authorizeDispatch`. The string `"true"` is refused. `handoffGoal` does not dispatch. `fork-run` has its own HMAC; `src/recorder/fork.js` then mints the new run's dispatch grant and does not return it. The dev webtrigger does the same only with `DEV_WEBTRIGGER_SECRET` and `approve: true`, and it does not echo the token. The router prompt says the model will not receive `confirmToken`.
5. **A risky plan grows an approval gate before the gated children exist.** Score 5 or more, or a transition or field edit of an issue the step did not create, appends an `approval` step. Those dependents get no child issue until a person moves the gate's child to Done. Other siblings still run.
6. **Undo includes field edits.** `closeIssue` moves a child to Done and labels it `conductor-rolled-back`. It never deletes the issue. `recordRemovedComment` deletes a comment. `restoreStatus` writes only while the issue is still in the status the run left. `setFields` stores the previous scalar values on `result.before` and PUTs only those fields. `restoreFields` writes them back when the issue still holds what the run wrote. A second Undo hits the same keys. The only DELETE in `src/effects/jira.js` is the comment delete.
7. **A budget stop drains queued forward work.** Caps are `maxSteps` 8, `maxModelCalls` 28, and `wallClockMs` of 8 × 12 minutes. `startRun`, the step worker, and `spawnWave` check `runBudgetStop` before the next enqueue or model call. A stop sets the run to `blocked` and fails pending and retrying `createIssue`, `comment`, `transition`, and `setFields` rows. The applier also refuses a forward effect once that run is noted, so a message still on the queue does not call Jira. Undo effects are not cancelled. `completeText` does not call `chat` once `usedModelCalls` is 28. Equal to the wall-clock or step cap is still inside.
8. **Plans and faults stay bounded.** `plan-split` rejects more than 8 steps, unknown worker types, and cycles, and stores nothing. Waves stop at 3. A step gets 3 attempts. Ticket text is fenced as `<untrusted>` and cannot add effects. Chaos faults are closed in `production` and `staging`.

## 3. Supporting evidence

On Node 22.23.4, `npm ci && npm test` gives **365 pass, 1 skipped, 0 fail**. `npm audit` reports **0 vulnerabilities** (`overrides` pin `glob` 14.0.4, `minimatch` 11.0.5, and `prosemirror-view` 1.42.9). `npm run safety-eval` prints **19 pass, 0 fail**. `npm run test:headroom` runs the 31 simulation scenarios, including the KVS headroom report, with no warning on this run. The handlers run against in-memory fakes. `npm run safety-eval` is also a CI step. `forge lint` is skipped there when `FORGE_API_TOKEN` is unset, so this run did not lint the manifest.

`src/safety/eval.js` (asserted again by `src/safety/__tests__/guard.test.js`) refuses a missing confirm, the string `"true"`, a bad acknowledgement, another card's token, and the public digest. It checks that the panel grant is single-use and expires, that `startRun` without a grant enqueues nothing, that the panel starts a run without returning the token, that a budget stop keeps a pending create and a later comment off Jira, and that `setFields` records the old summary. `src/effects/__tests__/effects.test.js` checks that `restoreFields` skips a summary a person changed.

## 4. Limitations

- **Simulation only.** The fake Jira is this repo's REST model. The prompt checks do not chat with a model, and `tests/scenarios/06-adversarial-tries.md` is still not executed live.
- **Grants are process-local.** The panel consumes the token in one invocation, so the tool result never has it. Another instance has no row. `CONDUCTOR_CONFIRM_SECRET` shares the HMAC key and does not share the used-token table. The handler cannot tell whether the panel click and the chat are the same person. It does require an account id on the resolver context.
- **Two callers sit outside the tool list.** `src/recorder/fork.js` mints the new run's dispatch grant only after the fork action has checked the fork HMAC, and it does not return that grant. The dev webtrigger can approve with `DEV_WEBTRIGGER_SECRET` and `approve: true`. That secret is not set in production, and the response has no token.
- **Undo is still partial.** The gate's own child is created so a person can transition it. Close assumes a status named `Done`. Closed children stay, labelled `conductor-rolled-back`. Memory rows and flight-recorder events stay. `setFields` is scalars only, and a field edit on a child this run created is covered by closing that child. An effect already in `applying` may finish its Jira call. `commitRunBudget` only records; the next stop drains forward effects and leaves compensations so undo can still run.
- **Dependency overrides.** `glob` 14.0.4, `minimatch` 11.0.5, and `prosemirror-view` 1.42.9 are forced because they sit under `@forge/*`. `npm audit` is clean on this lockfile. A later Forge release may carry the patches without the override.

## 5. How to reproduce

```sh
git clone https://github.com/LeoLin990405/ticket-conductor-safety.git && cd ticket-conductor-safety
npm ci                 # Node 22.23.x
npm test               # unit + simulation; no Jira or secrets needed
npm run test:headroom  # tests/simulation/scenarios.test.mjs
npm run safety-eval    # pass/fail table of the irreversible-action checks
npm audit              # 0 vulnerabilities on this lockfile
```

Start with `docs/blast-radius.md`, `src/safety/grants.js`, `docs/freeze.md`, and `tests/simulation/scenarios.test.mjs`.
