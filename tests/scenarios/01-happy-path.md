# Scenario 01 — Happy path

Written scenario for the development site. It has not been run against a live Rovo agent or a deployed app.

Seed: [demo/seed.json](../../demo/seed.json), Epic ref `epic-refunds`, summary **Ship payment refunds**. `CONDUCTOR_DEMO_STUCK_STEP` is unset. Scenario 02 covers the hang.

The user is on that Epic in Jira and opens the `conductor-router` agent.

## Steps

1. User sends `demo.primaryGoal`: "Plan and run this Epic: ship payment refunds that are idempotent on the payment id, with one ledger line and a webhook that keeps the original line."
2. The agent calls `recall-memory` (`recallMemory`) with `projectKey` `PAY` and a `query` that includes the goal. The project has no memories yet. The result is `{ memories: [] }`.
3. The agent shows a plan and the `stepsJson` string, then asks "Save this plan and start the run?" It does not call `plan-split` or `dispatch-run` in this turn.
4. User replies `Yes`.
5. The agent calls `plan-split`. The handler is `planSplit({ epicKey, goal, stepsJson }, ctx)`. `stepsJson` is one string. `JSON.parse` yields 1 to 8 objects, each with string `title`, `workerType`, and `input`. `workerType` is `research`, `draft-spec`, or `check-deps`. The reference list is `demo.planSteps` (6 steps). Titles may differ. The plan covers the refund API idempotency rule, the capture dependency, the ledger line, and the duplicate webhook. It does not include `summarize`.
6. `createdBy` on the run is the `accountId` from `ctx`, not a model-supplied field.
7. The agent calls `dispatch-run`. The handler is `dispatchRun({ runId, confirm: true })`, which calls `startRun`.
8. The agent calls `get-run-status` (`getRunStatus`) with the `runId` and reports `idx`, `title`, `status`, `childIssueKey`, and `attempt`.

## Expected storage after plan-split, before dispatch

Custom Entity Store, not Forge SQL. Timestamps are epoch milliseconds stored as `float`.

| Record | Expected |
|---|---|
| `run.status` | `planning` |
| `run.epicKey` | the real key of **Ship payment refunds** |
| `run.projectKey` | `PAY` |
| `run.goal` | the goal passed to `planSplit` |
| `run.createdAt`, `run.updatedAt` | set |
| each `step.status` | `queued` |
| `step.idx` | `0` through `n-1` |
| `step.attempt` | `0` |
| `step.createdAt` | set when the step is queued |
| `step.deadlineAt` | unset |
| `step.childIssueKey` | unset |
| `step.workerType` | the value from `stepsJson` |

No event on `step-queue`. No `effect` rows. KVS key `idem:dispatch:<epicKey>:<hash(goal)>` is not written yet. `lock:run:<runId>` is only the optimistic lock WP1 uses during updates.

## Expected state after dispatch, once queues drain

`dispatchRun` moves the run to `running` and `startRun` enqueues every planned step. The queue push is `{ body: { runId, stepId, attempt } }` on `step-queue`. The consumer is `step-worker`, function `timeoutSeconds` 900. A stale event whose `attempt` is below `step.attempt` exits with no effects.

Each step emits one `createIssue` effect. Payload fields: `projectKey`, `parentKey` (the Epic), `summary` (the step `title`), `description`, `issueType`. `requestKey` is `sha256(runId|stepId|kind|discriminator)` from `requestKeyFor({ runId, stepId, kind, discriminator })`. The discriminator does not include `attempt`, so a later retry does not create a second issue.

`effect-applier` on `effect-queue` receives `{ body: { requestKey } }`. On success, effect `status` is `applied`, `result.issueKey` is set, and `step.childIssueKey` is that key. A second push of the same `requestKey` does not call Jira again (scenario 03).

When a step starts, `status` becomes `running` and `deadlineAt` is now plus 12 minutes. `reportStep(stepId, { status, output, error })` records the outcome. Workers are deterministic in the MVP: `research` runs JQL, `draft-spec` fills a template, `check-deps` reads links. They do not call a model.

When every planned step is `done`, `recomputeRunStatus` sets the run to `done` and enqueues a `summarize` step. That worker calls `writeBack(runId, { summary, decisions: [{ text, type }] })`. The Epic comment body starts with the header `[Conductor memory]`. Memory rows store `type` as attribute `memType`. The expected decision text is `expectedWriteBack.text` in the seed, `memType` `decision`, `scope` `project`, `validUntil` `0`. A panel refresh may show `done` before the comment lands, because the comment is an effect. Once both queues are idle, the run is `done`, `run.summary` is set, the comment exists once, and the memory row exists.

## Expected Jira

- No new child issue before `dispatch-run`.
- After effects apply: one new issue per planned step, parent or Epic link pointing at **Ship payment refunds**, summary equal to the step title.
- The seeded Story, Bug, and Task are unchanged. They are context, not run steps.
- One Epic comment with header `[Conductor memory]` after summarize. The comment effect is deduped by `requestKey`.

## Expected panel

Issue panel on the Epic, fed by `getRunsForIssue` / `getRun`:

- Header: `goal`, status lozenge `running` and then `done`.
- Step tree: `idx`, `title`, `workerType`, `status`, `attempt`, link on `childIssueKey`.
- Effect timeline: `createIssue` rows moving `pending` to `applied`, then the Epic `comment`.
- Memory section: the decision `text` after write-back.
- Polls about every 5 seconds while `running`.

## Expected agent reply

The pre-confirm reply lists the plan and `stepsJson` and asks to save and start. It does not claim a child issue exists.

The post-dispatch reply includes `runId`, run `status`, and the step list from `get-run-status`. Missing `childIssueKey` is described as a pending effect, not as a made-up key.
