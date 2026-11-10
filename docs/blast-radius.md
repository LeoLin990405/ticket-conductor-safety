# Blast radius and compensating undo

> Note: [`docs/freeze.md`](freeze.md) and [`docs/milestones.md`](milestones.md) reflect the current implementation state. Where this design note differs, they win.

Design for novelty #4 (see [docs/novelty.md](novelty.md)). The preview is wired. `plan-split`, `startRun` (before it enqueues), `get-run-status`, and the Run panel call `previewBlastRadius` on steps they already hold. The card is not stored. Compensating kinds are still descriptors only. `enqueueEffect` still accepts only `createIssue`, `comment`, and `transition`.

The pure functions live in `src/blast/preview.js`. Unit tests are in `src/blast/__tests__/preview.test.js`. They do not boot the simulator and they do not call Jira.

## What the code does today

A plan does not choose its Jira writes at runtime. The writes are templates.

| When | Kind | Discriminator | Where it is built |
|---|---|---|---|
| `startRun`, and the lead when it spawns a step | `createIssue` | `child-issue` | `buildCreateIssuePayload` in `src/run/stateMachine.js`. Parent is the Epic. Issue type is `step.input.issueType` or `Sub-task`. A step with status `done` is skipped (fork prefix). |
| `research` worker | `comment` on the child | `research-comment` | `commentEffect` in `src/worker/content.js` |
| `draft-spec` worker | `comment` on the child | `draft-spec-comment` | same |
| `check-deps` worker | `comment` on the child | `check-deps-comment` | same |
| Checklist skill (`risk-review`, `test-plan`) | `comment` on the child | `skill-full-output` | `withFullComment` in `src/skills/runSubAgent.js` |
| Builtin skill (`procedure: builtin`) | the worker's own comment | the worker discriminator | `runSubAgent` returns the worker effects unchanged |
| `plan-split`, only when a lesson was applied | `comment` on the Epic | `plan:lesson-citation` | `publishPlanCard` in `src/memory/lessons.js`. Header `[Conductor plan]`. |
| `writeBack`, after the run reaches done | `comment` on the Epic | `memory:epic-comment` | `src/memory/comment.js`. Header `[Conductor memory]`. `stepId` is null. |
| Lead, after a wave | `comment` on the Epic | `wave-report:<wave>` | `postWaveReport` in `src/run/leadLoop.js`. Header `[Conductor wave]`. |
| Watchdog, when a step exhausts retries | `comment` on the Epic | `watchdog-blocked` | `src/watchdog/watchdog.js` |

The request key is `sha256("<runId>|<stepId>|<kind>|<discriminator>")` from `requestKeyFor` (`src/effects/requestKey.js`). The attempt number is not part of it. A run-level comment uses an empty step segment. `plannedRequestKey` in the stub uses that same string. For the three kinds the queue accepts today, the digest matches `requestKeyFor`. The stub also hashes `setFields` and the compensating kinds, which `requestKeyFor` still rejects.

The effect applier (`src/effects/applier.js`) is the only Jira writer. It claims the row (`pending` or `retrying` to `applying`), calls `applyJiraEffect`, and stores `result`. A comment that only has `childOfStepId` waits until the step's `childIssueKey` appears, then re-pushes itself without spending a try. Applied and failed rows are never sent to Jira again. `result` today is `{issueKey}`, `{commentId}`, or `{transitionId}`. There is no before-image.

`src/effects/jira.js` has no field-edit route and no delete route. The manifest scopes are `read:jira-work` and `write:jira-work`. Undo must stay inside those scopes.

The fake board (`tests/simulation/fakes.mjs`) matches that surface. `POST /rest/api/3/issue` creates `PAY-101` upward (`nextNumber` starts at 100). Seed issues are `PAY-1` through `PAY-6`. Comments are appended to `mutations` and are not stored on the issue. `GET/POST .../transitions` knows `In Progress` (id `21`) and `Done` (id `31`). Any other path, including comment delete and issue edit, returns 404. `mutations` is append-only.

The Run panel (`src/frontend/index.jsx`) already shows a plan card, the dependency graph, the flight recorder, and a flat effect list (`kind · status`). `loadRun` in `src/resolvers/panelData.js` loads steps, events, and effects. Effects use `listEffectsByRun(runId, { limit: 50 })`.

Replay (`src/recorder/replay.js`) re-reads Jira and classifies effects with `lookupAppliedEffect`. Status `applied`, or a journal event with `detail.phase === 'applied'`, is `already-applied-skipped`. `duplicateWrites` is 0. Replay does not enqueue. Fork (`src/recorder/fork.js`) copies the prefix as `done`, and `startRun` does not create a second child for those steps.

## (a) The card

`previewBlastRadius({ run, steps, planCard, appliedRequestKeys })` builds the card from the plan and the templates above. It does not call a worker, the model, the store, or Jira. Call it with `listSteps` rows (or the `plan-split` steps, which carry `input`). Do not call it with `get-run-status` steps: those omit `input`.

A `done` step contributes nothing. That is the fork prefix.

Certain rows, in step order:

- One `createIssue` / `child-issue` per remaining step, including a planned `summarize` step. `startRun` creates that child. The description text is not copied onto the card. Dispatch still builds it with `buildCreateIssuePayload` (goal, step title, brief). The card records project, parent, summary, and issue type.
- One child comment when the template table has a discriminator. `research`, `draft-spec`, and `check-deps` win even if `step.skill` is set, because the builtin skill path keeps the worker comment. `risk-review` and `test-plan`, and any other step that has a `skill` but no builtin comment, use `skill-full-output`. `summarize` and `approval` get no child comment.
- One `transition` when `step.input.transitionTo` is a non-empty string. No built-in worker reads this field yet. It is the template slot M2 enqueues, and the card lists it so the gate can see it. `transitionTarget: 'epic'` or `transitionIssueKey` aims it at an existing issue. Otherwise the target is the child of that step.
- One `setFields` when `step.input.fields` is a non-empty object. Same target rules, with `fieldsTarget` and `fieldsIssueKey`. Values on the card are clipped to 80 characters. `setFields` is not in `EFFECT_KINDS` yet. M2 adds it beside the other three kinds, in the allowlist, in `validateEffectPayload`, and in `applyJiraEffect` (`PUT /rest/api/3/issue/{key}` with only the named fields).
- The plan-citation comment when `planCard` is non-empty. Certainty `certain`. `stepId` null.
- The memory comment when the plan has any step. Certainty `if-done`. It is not enqueued at dispatch.

Not on the card, listed under `omitted` so a test can see they were considered:

- `wave-report`. The lead has not decided. The envelope says how many extra issues the next wave may add (`spawnBudget` from `src/run/digest.js`: at most 8 work steps, at most 3 waves).
- `watchdog-blocked`. Only after retries are exhausted.
- `summarize-comment`. The summarize worker passes `defer: false` and drops the comment when `childIssueKey` is still empty. `writeBack` owns the Epic comment, one key, so it is not posted twice.

`appliedRequestKeys` only sets `alreadyApplied` for the panel. It does not change the score.

### Shape

```js
{
  runId, epicKey, projectKey,
  phase: 'preview',          // no Jira write was performed
  counts: { issues, comments, transitions, fieldChanges, ifDone, total },
  writes: [{
    kind,                    // createIssue | comment | transition | setFields
    requestKey,              // plannedRequestKey, same pipe as requestKeyFor
    stepId,                  // null for an Epic comment
    stepIdx,                 // null for an Epic comment
    discriminator,
    template,                // child-issue, research-comment, approval-child, ...
    certainty,               // certain | if-done
    target,                  // { type: 'new-child'|'child-of-step'|'epic'|'issue', ... }
    summary,                 // one line for the panel
    issueType,               // createIssue only
    toStatusName,            // transition only
    fields,                  // [{ field, to }] for createIssue and setFields
    alreadyApplied
  }],
  omitted: [{ template, reason, stepIdx? }],
  envelope: {
    maxSteps: 8, maxWaves: 3, plannedSteps, roomForSpawnedIssues,
    currentWave, nextWaveBudget
  },
  risk: { score, threshold: 5, exceeds, external, reasons },
  gate: { insert, fits, waitFor, appendedIdx, reason },
  byteBudget: 20480,
  bytes,                     // UTF-8 length of this JSON
  overBudget
}
```

Score (certain rows only):

- `1` per `child-issue`. An `approval-child` does not score. Recomputing the card after the gate is appended must not insert a second gate.
- `4` per `transition` or `setFields` (`BLAST_EXTERNAL_POINTS`).
- Comments score `0`, including the plan citation and the memory comment.
- The lead envelope scores `0`.

`exceeds` is `score >= 5` or `external`. `external` means a transition or a field edit whose target is the Epic or some other issue key, not the child this step creates. A 3-step research / check-deps / draft-spec plan scores 3 and does not gate. That is the simulator's DAG. Five child issues scores 5 and gates. One Epic transition gates even on a one-step plan.

The card is recomputed. It is not a KVS row and it is not a new entity attribute. `BLAST_CARD_BUDGET` is 20 KiB. An 8-step plan with a transition and a field edit on every step, plus both Epic comments, fits (about 16 KiB). A card that inlines comment bodies does not. `journalDetail(card)` is the flight-recorder slice: counts, score, `exceeds`, and the request keys, capped at 2 KiB (`BLAST_JOURNAL_BUDGET`). Keys are dropped from the end if they do not fit, and `truncated` is set.

### Panel

M2 renders `panelModel(card)` on the Run tab, above the existing plan-card `SectionMessage`. The model is plain strings. The panel wraps cells in `Text` and passes `head` and `rows` to `DynamicTable`, the same way `StepTable` does. There is no `Table` component.

- `appearance` is `information`, or `warning` when `gate.insert` is true.
- The summary is `3 child issues, 4 comments (1 after the run finishes), 0 transitions, 0 field changes`.
- `gateNote` names the step indexes that will wait, or says the plan is already at the step cap.

Show the card while the run is `planning`, and keep showing the recomputed card after dispatch. `loadRun` already has the steps. Do not add a store query just for the card. `appliedRequestKeys` can be taken from the effects that load already returned.

The Undo button is M2, under the Effects heading. `appearance="danger"`. Disabled unless the run is `done` or `blocked` and at least one effect is `applied`. A `Modal` confirms it. The copy says the children will be closed, not deleted. The button calls a resolver that enqueues the compensations. It is not a new Rovo action. Adding one later is an interface change and belongs in `docs/TASKS.md` in that PR.

## (b) Compensating effects

`planCompensations(effects)` reads effect rows and returns descriptors. It does not enqueue. M2 enqueues each descriptor with the existing `enqueueEffect` once the new kinds are on `EFFECT_KINDS`. Same `effect-queue`, same applier, same `putEffectIfAbsent`.

Pass `listEffectsByRun(runId)` with **no limit**. The panel helper's `limit: 50` is the wrong call. The Forge adapter already pages at 100 when limit is omitted. Do not also scan `by-status`.

| Kind | Undoes | Payload | Jira call |
|---|---|---|---|
| `closeIssue` | `createIssue` | `{ issueKey, toStatusName: 'Done', label: 'conductor-rolled-back' }` | Transition to Done, then add the label. Never `DELETE /rest/api/3/issue`. |
| `recordRemovedComment` | `comment` | `{ issueKey, commentId }` | `DELETE /rest/api/3/issue/{key}/comment/{id}`. The effect row and the journal are the record. Do not post a second "undo" comment. |
| `restoreStatus` | `transition` on an issue this run did not create | `{ issueKey, toStatusName, expectedStatusName }` | Transition back to `result.before.statusName`. |
| `restoreFields` | `setFields` on an issue this run did not create | `{ issueKey, fields, wrote }` | `PUT` the previous field values. |

`restoreFields` is the pair of `setFields`. The three kinds the milestone names are the first three. A run that never edited a field does not get a `restoreFields` row.

Discriminator for every compensation: `undo:<forwardKind>:<forwardRequestKey>`. `stepId` is the forward row's step id (empty for a run-level comment). One compensation per forward effect. A second Undo hashes to the same keys, `putEffectIfAbsent` returns `created: false`, and the applier skips rows that are already `applied`.

Forward rows stay `applied`. Setting them back to `pending` would let a retry create a second child. Replay keeps seeing `already-applied-skipped` on the forward key. That is what we want.

### Before-image

M2 stores the snapshot inside `result`, which is already `any`. No new manifest attribute.

```js
// createIssue
{ issueKey }

// comment — add the issue key the applier resolved from childOfStepId
{ commentId, issueKey }

// transition — GET the issue, or read fields.status off the transition list's issue, before POST
{ transitionId, before: { statusName }, after: { statusName } }

// setFields
{ before: { fields }, after: { fields } }
```

Call `fitBeforeSnapshot` before saving `before`. The cap is 2 KiB (`BEFORE_SNAPSHOT_BUDGET`). Status name and comment id stay. Field entries are kept in sorted name order until the next one would overflow.

A transition with no `before.statusName`, a comment with no `commentId` or no resolvable issue key, or a `setFields` with no `before.fields` goes to `cannotUndo` with `no-before-snapshot`, `missing-comment-id`, or `missing-issue-key`. The child comment's issue key is `payload.issueKey`, else `result.issueKey`, else the `createIssue` result for the same `stepId`.

A transition or field edit on a child this run is about to close is `skipped` with `covered-by-close`. Closing replaces it. Pending and retrying rows are `skipped` with `not-applied`. Compensation rows are `skipped` with `compensation`, so Undo does not undo itself.

### Order

The queue does not order different request keys. `closeIssue.dependsOnKeys` lists the `recordRemovedComment` keys for that same issue. M2's applier, on a compensation whose dependency is not yet `applied`, re-pushes with delay and does not spend a try. That is the deferred-comment path in `src/effects/applier.js` (`CHILD_KEY_WAIT_SECONDS`, cap `CHILD_KEY_MAX_WAIT_MS`). Independent children close in parallel. `planCompensations` already returns the descriptors in an order that visits dependencies first, then the rest in reverse `appliedAt`, then `requestKey`.

### What cannot be undone

`irreversible` on the plan is stable:

- `closed-child-remains`. The issue stays in Jira, status Done, label `conductor-rolled-back`. `isRollbackResidue` is that test. There is no delete fallback if the workflow has no transition to Done. The effect fails and the child stays open.
- `kvs-memory-kept`. Lessons and memories stay. Reject does not delete them either. The Epic memory comment is a comment effect and is removed. The KVS row is not.
- `flight-recorder-append-only`. Undo appends events. It does not delete the original `effect.written` rows.

Also not undone, and reported on `cannotUndo` or by `compensationApplies`:

- Status drift. `restoreStatus` applies only when the issue is still at `expectedStatusName` (the status this run left it in). Otherwise reason `status-drift`.
- Field drift. `restoreFields` applies only when each `wrote` value is still the current value. Otherwise `field-drift`.
- A comment delete that Jira refuses. The row fails. It is not papered over with another comment.

## (c) Novelty #5 and the flight recorder

### Approval gate

`gateInsertion(card, steps)` is the signal #5 consumes. It does not write the plan.

When `gate.insert` and `gate.fits`:

- Append one step. Do not insert it at index 0. Lesson injection shifts indexes; this must not, because `dependsOn` is already stored. The graph allows a dependency on a later index (`normalizePlanGraph` in `src/run/graph.js`).
- The new step is `{ idx: appendedIdx, title: 'Approve blast radius', workerType: 'approval', dependsOn: [] }`.
- Every index in `gate.waitFor` gains that idx on `dependsOn`. Other steps are unchanged, so a sibling branch keeps running.
- `waitFor` is every step that has a scoring `createIssue` when the score tripped, plus every step that owns an external transition or field edit.

`fits` is false when `workSteps(steps).length` is already 8 (`MAX_STEPS`). No ninth issue. `gateInsertion` returns the original steps. The panel warning and the existing `dispatch-run` confirmation are the gate. `dispatch-run` does not gain a new required field.

Recomputing the card after the approval step is present returns `gate.insert: false` while that step is not `done`. The approval child uses template `approval-child` and the same `child-issue` discriminator, so its request key still matches `startRun`, and it does not add a score point.

`approval` is a registered worker type. The approval step creates a child (the normal `createIssue`) and does not enqueue a worker comment. `startRun` stores the gate as `waiting` and does not push it. Downstream steps are `waiting` until `approveGate` reports the gate `done`. The watchdog already ignores `waiting`, and it also skips a gate that was left `queued` or `running` without advancing the attempt. The person approves by transitioning that child. The product trigger (`src/triggers/childIssueUpdated.js`) calls `approveGate`, so the gate is `done` with `generator: 'human'` and dependents leave `waiting`. A second delivery does not release them again. A direct `approveGate` call remains the in-process stand-in.

Lead loop: not wired on 2026-11-05. A spawned wave is at most 3 issues, and steps that are already `done` are omitted from the card, so the two-wave demo scores under 5 and would not insert a gate. The intended rule, when a later wave can exceed it: before `maybeReviewWave` enqueues spawned `createIssue` effects, recompute the card for the whole plan including the drafts. If `gate.insert && gate.fits`, append the approval step and do not enqueue the spawned creates until that step is `done`. If the score trips but `fits` is false, return the existing `ask` decision (`awaiting-review`) instead of spawning. Do not invent a second pause type.

### Replay and fork

- Replay does not call `planCompensations` and does not enqueue. It may attach a recomputed card. Each certain request key is classified with `lookupAppliedEffect`, the same as today. After undo, forward keys are still `already-applied-skipped`. Compensation keys are separate. `duplicateWrites` stays 0.
- Fork preview omits `done` prefix steps, so Undo of the fork does not close the original children. Those children have no `applied` `createIssue` on the fork's run id. Compensations are planned from effects whose `runId` is the run being undone.
- M2 may append `blast.previewed` once, with `journalKey` `blast-preview:<runId>`, skipping the append when that key already has an event. `detail` is `journalDetail(card)`. M2 may append `run.undone` when the compensations have been enqueued. Both kinds are added to `EVENT_KINDS` in that change, not in this one. Scrubbing the timeline does not undo. Undo is the button.
- Do not copy `blast.previewed` across a fork. The fork computes its own card for the steps it will actually run.

## (d) Simulation

Do not add these scenarios in the design PR. They land with the implementation, in `tests/simulation/scenarios.test.mjs`, and their budgets land in `tests/simulation/budget.mjs`. The harness bills every KVS get, query page, set, and compare-and-set, with a 1 KiB floor (`KVS_BYTE_FLOOR`). A scenario fails on zero usage and on a cap breach. Measure with `SIM_BUDGET_DEBUG=1`, then set the cap the way the existing keys were set: the measured total plus a little room. The numbers below are the starting caps, taken from a real `createWorld` run on this tree (LLM disabled, goal `Ship payment refunds`).

| Scenario | What it asserts | Starting KVS cap |
|---|---|---|
| `blast-preview` | `plan-split` of the 3-step DAG. `jira.mutations.length === 0` (already true today before dispatch). `previewBlastRadius` certain `createIssue` keys equal the `child-issue` keys dispatch will enqueue. Certain comments are `research-comment`, `check-deps-comment`, `draft-spec-comment`. Memory comment is `if-done`. No `wave-report` row. `gate.insert === false`. An 8-step plan in the same process sets `gate.insert` and `gate.fits === false`. | reads `20_000`, writes `30_000`. Measured plan-only usage was reads 4,096 / writes 8,192 (3 steps) and writes 18,432 (8 steps). A full drain is ~334k reads and fails this cap. |
| `blast-undo` | Dispatch and `drain()` the same 3-step plan. Then `planCompensations` on `listEffectsByRun` with no limit, enqueue, drain again. Open issues (everything `isRollbackResidue` rejects) match a snapshot of the seed issue map taken before dispatch: same keys (`PAY-1`..`PAY-6`), same status, labels, summary. Residue keys are exactly the created children (`PAY-101` upward), each Done and labelled `conductor-rolled-back`, with no comments left on them. Seed issues have no comments left on them. A second Undo enqueues nothing new (`created: false`) and adds no further Jira mutations. `duplicateWrites` on a following `replay-run` is 0. | reads `500_000`, writes `200_000`. Measured run with no undo was reads 333,741 / writes 118,563 (3 creates, 5 comments, 0 transitions: 3 child comments, 1 wave report, 1 memory comment). Tighten to measured-undo × ~1.3 after the first green run. If it does not fit, the scenario is re-reading too much (a `by-status` scan, or the panel's `limit: 50` in a loop). |

`blast-undo` cannot go green until the fake grows three routes. That change belongs to the simulation PR, not this one:

- `POST .../comment` also pushes the comment onto the issue, not only onto `mutations`.
- `DELETE .../comment/{id}` removes it. 404 if it is already gone, and the applier treats that 404 as applied so a redelivery is safe.
- `PUT .../issue/{key}` updates `fields.labels` and the named `setFields` keys.

`mutations` stays append-only. The seed check is the issue map, not `mutations.length === 0`.

Two further scenarios, after the applier stores `before` and a template actually enqueues a transition (the card already lists `input.transitionTo`; the workers do not emit one today):

- `blast-restore`. A step with `transitionTarget: 'epic'` and `transitionTo: 'In Progress'`. Card `gate.insert` is true and `waitFor` is that step only. After apply, `result.before.statusName` is `To Do`. Undo enqueues `restoreStatus`. If the fake status is moved first, `compensationApplies` returns `status-drift` and the Epic is left alone.
- `blast-fork`. Fork from step 0. The card lists one `createIssue`, for the downstream step. Undo closes that child and does not close the prefix child.

Byte budgets that are not the scenario caps:

| Value | Cap | Where |
|---|---|---|
| Recomputed card | 20 KiB (`BLAST_CARD_BUDGET`) | Not stored. `overBudget` on the card. |
| `blast.previewed` detail | 2 KiB (`BLAST_JOURNAL_BUDGET`) | `event.detail`, counts and request keys. |
| `effect.result.before` | 2 KiB (`BEFORE_SNAPSHOT_BUDGET`) | Existing `result` attribute. |
| Effect payload | 64 KiB (`MAX_VALUE_BYTES`) | Already enforced by the store. |
| Effect value, platform | 240 KiB | Do not approach it. |
| Recall lessons | 1,536 bytes | Unchanged. Undo does not read them. |
| Wave digest | 1,024 bytes | Unchanged. |

Preview itself adds no KVS read when the caller already holds the steps. Undo adds one `by-run` query.

## What M2 changes, and what it does not

Changes, in the implementation PRs:

- Allow the new kinds in `EFFECT_KINDS`, `requestKeyFor`, and `validateEffectPayload`. Implement them in `applyJiraEffect`.
- On `transition` and `setFields`, write `result.before` through `fitBeforeSnapshot`.
- Teach the applier to wait on `dependsOnKeys` for compensations.
- Render the card. Add the Undo resolver. Append `blast.previewed` and `run.undone`.
- Register `approval` when #5 starts, and call `gateInsertion` from `plan-split` and from the lead.
- Add the two scenarios and the two `KVS_BUDGETS` keys. Extend the fake routes in that same PR.

Does not change:

- Manifest scopes. No `delete:issue:jira`. No new scope for comment delete unless a dev-site call returns 403, and even then that scope is a separate decision (see below).
- Entity attributes. `before` lives in `result`.
- `tests/simulation/budget.mjs` in this design PR. The caps above are the numbers to register with the scenarios.
- Replay's `duplicateWrites` rule, the fork prefix, or the 8-step / 3-wave caps.

## Open questions

1. **Comment delete and `write:jira-work`.** The stub's `recordRemovedComment` is a real DELETE. Granular Jira scopes have split comment delete out in some apps. M2 should try the delete once against the dev site only after the November simulation window, or confirm it from the scope reference before then. A 403 becomes `cannotUndo` for that comment. Do not add a scope in the undo PR, and do not post a replacement comment to fake the delete. The fake board can delete, so the seed assertion does not depend on the scope.

2. **The done status is not named `Done` in every workflow.** The fake maps transition id `31` to `Done`, and `CLOSE_STATUS_NAME` is `Done`. The applier already looks up a transition by destination name. If the project has no transition to `Done`, `closeIssue` fails and the child stays open. There is no delete fallback. If the demo project's workflow uses another name, set it from the project's done status in the close payload. Do not hard-code a second name in the stub until that project is known.
