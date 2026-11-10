# Scenario 03 — Duplicate request

Written scenario. It has not been run live.

Two different duplicates. Both are idempotent. Neither creates a second Jira mutation.

## A. Dispatch the same goal twice

Preconditions: scenario 01 has called `dispatchRun({ runId, confirm: true })` for Epic **Ship payment refunds** and `demo.primaryGoal`. KVS holds `idem:dispatch:<epicKey>:<hash(goal)>`.

Steps:

1. The user confirms the same goal again, or the client calls `dispatch-run` a second time for that Epic and goal.
2. The handler finds the idempotency key and does not call `startRun` for a new run.

Expected:

- One `run` row for that Epic and goal hash. `runId` in the reply is the original run.
- No second set of `step` rows, no second push of the planned steps to `step-queue`.
- The Run panel lists one run for that goal, not two.
- A different `goal` string is a different hash and may create a new run. That is a new request, not this scenario.

`lock:run:<runId>` is the optimistic lock on `updateRun`, not the dispatch dedupe key. A conflicting `updateRun` throws `ConflictError` when `expectedUpdatedAt` does not match. That is separate from this duplicate.

## B. Deliver the same effect twice

Preconditions: a step has an `effect` whose `requestKey` was computed by `requestKeyFor({ runId, stepId, kind, discriminator })`. `kind` is `createIssue`, `comment`, or `transition`. The discriminator does not include `attempt`.

`putEffectIfAbsent` writes the entity with `keyPolicy: 'FAIL_IF_EXISTS'` when the key is new, and returns `{ effect, created: false }` when the key is already there. A second `enqueueEffect` with the same key returns `{ requestKey, created: false }` and still pushes `{ body: { requestKey } }` to `effect-queue`. Delivery is at-least-once.

`effectApplierHandler` reads the effect. If `status` is `applied`, it returns without calling Jira.

Expected for `createIssue`:

| Check | Expected |
|---|---|
| Effect rows for that `requestKey` | 1 |
| `effect.status` | `applied` |
| `effect.result.issueKey` | one key |
| `step.childIssueKey` | that same key |
| Jira children created for the step | 1 |
| `effect.tries` | unchanged by the duplicate delivery |

Expected for `comment`: one `commentId`. The Epic `[Conductor memory]` comment from `writeBack` is one comment even if the effect is pushed twice.

Expected for `transition`: one transition to `toStatusName`. A duplicate push does not transition again.

A retry of the step (scenario 02) uses the same `requestKey` for the same `kind` and discriminator. The retry may post a new comment only when the discriminator differs (for example the comment is a distinct result). It must not create a second child issue.

## C. Stale worker event

Preconditions: `step.attempt` is `1` because the watchdog already incremented it. An older event arrives with `attempt` `0`.

Expected: `stepWorkerHandler` returns without `reportStep` side effects, without new effects, and without changing `childIssueKey`. The panel stays on attempt `1`.

## Expected panel

The effect timeline shows one `applied` row per `requestKey`. A duplicate delivery does not add a second `applied` row and does not add a second child-issue link.
