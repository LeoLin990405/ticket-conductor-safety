# Blast radius, confirmation, and compensating undo

This note matches the code. The pure functions live in `src/blast/preview.js`. The server-side confirmation check lives in `src/safety/guard.js` and is applied by `dispatch-run` (`src/actions/index.js`) inside `startRun` (`src/run/stateMachine.js`). Unit tests are `src/blast/__tests__/preview.test.js` and `src/safety/__tests__/guard.test.js`. Simulation scenarios are in `tests/simulation/scenarios.test.mjs`. Nothing here calls a live Jira site.

## What a plan will write

`previewBlastRadius({ run, steps, planCard })` lists the Jira writes a plan's templates will make. It does not call a worker, the model, the store, or Jira. The card is not stored.

| When | Kind | Discriminator |
|---|---|---|
| `startRun`, and the lead when it spawns a step | `createIssue` | `child-issue` |
| `research`, `draft-spec`, `check-deps` | `comment` on the child | `<worker>-comment` |
| Checklist skills (`risk-review`, `test-plan`) | `comment` on the child | `skill-full-output` |
| A lesson was applied | `comment` on the Epic | `plan:lesson-citation` |
| The run reaches done | `comment` on the Epic | `memory:epic-comment` |
| `step.input.transitionTo` is set | `transition` | the template in `preview.js` |

`setFields` is listed on the card when `step.input.fields` is set, so the score can see it. It is not in `EFFECT_KINDS` (`src/store/types.js`). The applier does not edit arbitrary fields. `restoreFields` is the matching descriptor and is not enqueued.

The request key is `sha256("<runId>|<stepId>|<kind>|<discriminator>")` from `requestKeyFor` (`src/effects/requestKey.js`). The attempt number is not part of it.

Score, certain rows only:

- `1` per child issue. An approval child does not score, so storing the gate does not insert a second gate.
- `4` per transition or field edit (`BLAST_EXTERNAL_POINTS`).
- Comments score `0`.

`exceeds` is `score >= 5` or an external transition or field edit (the target is the Epic or some other existing issue, not the child this step creates). `plan-split` calls `applyBlastGate` (`src/run/approval.js`) before `createSteps`. When the card says insert and the plan is under 8 work steps, one `approval` step is appended and the steps in `gate.waitFor` depend on it.

## Confirmation before any agent-facing write

`plan-split` returns `acknowledgement` and `confirmToken` next to `blastRadius`. The acknowledgement is the line

```text
<score> points, <issues> issues, <transitions> transitions, <field changes> field changes
```

from `acknowledgementText`. The token is `sha256` of the run id, the Epic key, that line, and the sorted request keys of `createIssue`, `transition`, and `setFields` rows (`confirmationToken`). Comment keys are not in the hash.

`dispatch-run` passes the payload to `startRun` with `requireConfirmation`. `startRun` recomputes the card from the stored steps and calls `evaluateDispatchAuthorization`. The run leaves `planning` only when all of these are true:

- `confirm` is the boolean `true` (the string `"true"` is refused);
- `acknowledgeBlastRadius` equals the acknowledgement line;
- `confirmToken` equals the token for this card.

Otherwise the handler returns `{ ok: false, code: 'CONFIRMATION_REQUIRED', status: 'planning' }` and enqueues nothing. A second call after the run has left `planning` does not enqueue again, which is the existing dispatch dedupe.

`handoffGoal` (`src/actions/handoff.js`) never dispatches. The token is created inside that call, so the caller cannot have echoed it yet. `fork-run` requires its own acknowledgement (`fork <runId> from step <stepIdx>`) and token (`evaluateForkAuthorization`). The dev webtrigger calls the same handlers and answers 409 when the token is missing (`src/dev/devDispatch.js`).

The token is not a secret from the model. `plan-split` returns it, and a caller that copies it can pass the check. The router prompt (`prompts/router.md`) and the playbook (`prompts/conductor-playbook/SKILL.md`) forbid that copy until a later user message agrees to the plan that was shown. "Plan and run" is not that agreement. The handler is what stops a call that omits the token. `startRun` without `requireConfirmation` is the internal transition used by tests after a caller has already been checked. It is not a Rovo action.

`npm run safety-eval` prints a pass/fail table of these refusals, including the string `"true"`, a wrong acknowledgement, a wrong token, handoff, fork, and a wall-clock stop.

## Gated children are not created up front

`stepIdsBlockedByOpenApproval` (`src/run/approval.js`) names every step that depends, directly or through a step that is not `done`, on an open approval gate. `startRun` does not enqueue `createIssue` for those steps. The gate's own child is created, so a person can transition it. A sibling that does not depend on the gate is created and may run.

`releaseWaitingSteps` enqueues the held child's `createIssue` when the gate is approved, then pushes the step. The effect queue is drained before the step worker, so the child exists before the worker comments. The scenario `a plan over the blast threshold grows one approval gate` asserts one child issue after dispatch, not six. `an approval gate holds its dependents while a sibling finishes` asserts the draft has no child until approval.

## Compensating undo

`planCompensations` reads applied effect rows and returns descriptors. `enqueueCompensations` (`src/effects/index.js`) enqueues them on `effect-queue` with discriminator `undo:<forwardKind>:<forwardRequestKey>`. A second Undo hits the same keys and does not call Jira again.

| Kind | Undoes | Jira call |
|---|---|---|
| `closeIssue` | `createIssue` | Transition to Done, then add the label `conductor-rolled-back`. Never `DELETE /rest/api/3/issue`. |
| `recordRemovedComment` | `comment` | `DELETE` the comment. The effect row stays. |
| `restoreStatus` | `transition` on an issue this run did not create | Transition back only when the issue is still in the status the run left it in. |

`restoreFields` is not applied. There is no field-edit route in `src/effects/jira.js`. Closed children remain in Jira, labelled. Memory rows and flight-recorder events are not deleted. The Epic memory comment is a comment effect and is removed when undo runs. The scenario `blast undo returns the board to the seed` checks the seed issues, the labelled residue, and that no issue DELETE was called.

## Budgets fail closed

`src/run/budget.js` still records `usedSteps`, `usedModelCalls`, `usedTokens`, and `elapsedMs`. Equal to a cap is inside, except model calls: `modelCallsExhausted` is true once `usedModelCalls` has reached `maxModelCalls` (28), because the next chat would pass it.

`runBudgetStop` is consulted before the next irreversible action:

- `startRun` sets the run `blocked` and enqueues nothing when the wall clock or a counter is already past its cap. `dispatch-run` returns `{ ok: false, code: 'BUDGET_EXCEEDED' }`.
- The step worker (`src/worker/index.js`) does the same before it comments, transitions, or calls the model.
- `completeText` (`src/worker/llm.js`) does not call `chat` when the caller passes a budget that is exhausted. The meter is not incremented.
- `spawnWave` (`src/run/leadLoop.js`) does not create another child when the step cap is full, the model-call cap is full, or the wall clock is past.

`commitRunBudget` still only records. A planning run that is handed a huge counter does not change status by that write alone. The next write is what stops. Caps are `maxSteps` 8, `maxModelCalls` 28, `wallClockMs` 8 times the 12 minute step deadline.

## What is still out of scope

- `setFields` and `restoreFields` are card descriptors only.
- Undo does not delete issues and does not remove memory rows.
- The confirmation token is visible to the model in the `plan-split` result. The server rejects a missing or mismatched token. It cannot see whether a later chat turn was a person.
- `startRun` without `requireConfirmation` can still enqueue. The Rovo actions, handoff, and the dev webtrigger do not take that path.
- Simulation only. The fake Jira is the board in `tests/simulation/fakes.mjs`. `CONDUCTOR_LLM` stays off unless a scenario passes a scripted model.
