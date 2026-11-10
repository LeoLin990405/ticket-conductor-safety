# Scenario 02 — Stuck step and Watchdog

Written scenario. It has not been run live. There is no `forge logs` excerpt for it.

Depends on scenario 01's seed and on a dispatched run. Set the development Forge variable `CONDUCTOR_DEMO_STUCK_STEP` to a non-empty value before dispatch. WP4 defines the value format. Do not commit the value. Unset it afterward.

The variable hangs one step once. Other steps still run. This is the video's watchdog shot. The schedule is `fiveMinute`, so the recording cuts across the wait.

## What hangs

The flagged step's first execution does not finish and does not emit a second `createIssue`. Its `createIssue` from `startRun` may already be `applied`, with `childIssueKey` set. The hang is the worker, not the issue create.

On start, that step is `running`, `attempt` is `0`, and `deadlineAt` is now plus 12 minutes. `createdAt` was set earlier, when `planSplit` queued the step.

`step-worker` is a `@forge/events` consumer. Its function has `timeoutSeconds` 900. The event body is `{ runId, stepId, attempt }`. There is no second agent to take the step.

## Watchdog

`watchdogHandler` runs from `scheduledTrigger` interval `fiveMinute`.

`findStuckSteps(nowMs)` pages at 100 and follows `nextCursor`. Two index queries:

1. Index `by-status-deadline`, partition `status` `running`, range `deadlineAt` less than now.
2. Index `by-status-created`, partition `status` `queued`, range `createdAt` less than now minus 10 minutes.

A queued step younger than 10 minutes is not stuck. A running step whose `deadlineAt` is still in the future is not stuck.

While `attempt` < 3, the handler sets `attempt + 1`, sets a new `deadlineAt`, and pushes `{ body: { runId, stepId, attempt } }` to `step-queue`. The demo hang happens once, so the next attempt completes. The panel shows `attempt` go from `0` to `1`, then the step to `done`.

An event with `attempt` < `step.attempt` is stale and writes nothing. The retry's `createIssue` uses the same `requestKey` as the first attempt, so the Epic gains one child for that step, not two.

## Repeated failure

Separate branch, not required for the recording. The contract is: when `attempt` >= 3, the handler sets the step to `failed` and the run to `blocked`, and enqueues one Epic `comment` effect. The acceptance bar on WP4 is that the 3rd failure blocks the run and posts one comment. WP4 owns the comparison that lines those two sentences up. The observable bar here is the blocked run, the failed step, and a single Epic comment. That comment is deduped by `requestKey`, so a second watchdog pass does not add another comment. The success memory from scenario 01 is not required on this branch.

`findStuckSteps` also causes a re-push of effects left in `pending` or `retrying` for more than 5 minutes. A `failed` effect after 5 tries sets the step to `blocked`.

## Expected panel

While the step is hung: that row is `running`, its `attempt` is `0`, and sibling rows can already be `done`.

After the watchdog pass and the retry: the hung row's `attempt` is `1` and it reaches `done`. The run can then follow scenario 01 to `done` and the `[Conductor memory]` comment.

After the third-failure branch: the row is `failed`, the run lozenge is `blocked`, and the Epic has one watchdog comment.

## Live timing

A judge watching the real schedule waits for `deadlineAt` (12 minutes) and then up to one `fiveMinute` interval. WP4 may pull `deadlineAt` forward when `CONDUCTOR_DEMO_STUCK_STEP` is set, so the wait is one watchdog interval. This scenario does not require that shortcut. The video shows the before and after panels and does not film the wait. See [docs/VIDEO.md](../../docs/VIDEO.md).
