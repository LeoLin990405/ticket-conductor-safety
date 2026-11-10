# Scenario 04 — Memory recall

Written scenario. It has not been run live.

Preconditions: scenario 01 has finished on Epic **Ship payment refunds**. `writeBack` has stored a memory and the Epic comment has been applied.

Expected memory, matching `expectedWriteBack` in [demo/seed.json](../../demo/seed.json):

| Field | Value |
|---|---|
| `projectKey` | `PAY` |
| `scope` | `project` |
| `memType` | `decision` |
| `text` | Refunds are idempotent on the payment id. A duplicate webhook returns the original ledger line and does not create a second one. |
| `sourceIssue` | the refunds Epic key |
| `runId` | the finished run |
| `validUntil` | `0` (no expiry) |
| `supersededBy` | unset |
| `createdAt` | epoch ms |

The JS field on `writeBack`'s decisions is `type`. The entity attribute is `memType`. Index `by-project` is partition `projectKey`, range `createdAt`. `recall` pages that index at 100, then scores keyword and label overlap in memory. It skips a row with `supersededBy` set, and a row whose `validUntil` is a past timestamp. `validUntil` `0` stays eligible.

The comment on the Epic starts with the header `[Conductor memory]`. One `requestKey` means one comment.

## Recall on the related Epic

User opens Epic **Reconcile refund ledger** (`epic-reconcile`) and sends `demo.relatedGoal`: "Plan how to reconcile the refund ledger with the provider. Keep one refund per payment id."

1. The agent calls `recall-memory` (`recallMemory`) with `projectKey` `PAY` and a `query` containing the goal (refund, ledger, payment id).
2. The result includes the decision above. A superseded or expired row is absent.
3. The agent shows a 1 to 8 step plan whose `draft-spec` or `check-deps` input keeps one refund per payment id. The reply quotes the decision `text` and names `memType` `decision`.
4. The agent asks to confirm. It does not call `dispatch-run` in this turn.
5. On confirm, `plan-split` (`planSplit`) also returns `recalledMemories` containing that decision. `stepsJson` is a string of `research`, `draft-spec`, and `check-deps` steps. No `summarize` step in the plan.

`get-run-status` (`getRunStatus`) on the new run is independent of the first run's steps. The panel on the reconcile Epic shows the new run. Its memory section can show the project decision because `scope` is `project`.

## Explicit record

User, on the reconcile Epic: "Remember this lesson: reconcile against the provider statement before posting a ledger correction."

The agent calls `record-decision` (`recordDecision`) with:

| Input | Value |
|---|---|
| `epicKey` | the reconcile Epic key |
| `text` | that lesson, in the user's meaning |
| `type` | `lesson` |

Expected: `{ memId }`. The stored attribute `memType` is `lesson`. The agent does not edit the earlier `decision` and does not set `supersededBy`. A later `recall` for a ledger query can return both rows, newest by `createdAt` on `by-project`, still filtered by the overlap score, up to `k` of 5.

## Negative memory cases

- A row with `supersededBy` set to another `memId` is excluded.
- A row with `validUntil` in the past is excluded.
- A row with `validUntil` `0` is kept.
- A memory in another `projectKey` is not returned for `PAY`.

## Expected Jira

The refunds Epic keeps its original `[Conductor memory]` comment. The reconcile Epic has no Conductor comment until its own run finishes or a later effect writes one. `record-decision` is not a promise of an immediate comment. The agent does not call a Jira write action to add one.
