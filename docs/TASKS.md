# Ticket Conductor — Work Packages

Interfaces below are contracts — change them only via a PR that also updates this file. Each work package lists the files it covers.

Shared conventions: ESM JavaScript (Node 22 local, `nodejs24.x` runtime), JSDoc types, tests with `node --test` (`npm test`), queues `step-queue` and `effect-queue`, all timestamps epoch ms, IDs uuid v4.

| ID | Title | Depends on |
|---|---|---|
| WP0 | Week-1 capability spikes: LLM access, agent delegation, rovo:skill, Forge SQL | none (blocks final decisions for WP3/WP5/WP7, but those start on the default design) |
| WP1 | Data model and storage layer | WP0 Q4 (can start immediately on Entity Store) |
| WP2 | Idempotent effects queue + applier | WP1 interface (code against it; use memory adapter) |
| WP3 | Step workers + run state machine | WP1, WP2 |
| WP4 | Watchdog (scheduled retry of stuck steps) | WP1, WP2, WP3 interfaces |
| WP5 | Rovo action handlers (accept + enqueue only) | WP1, WP3 (startRun), WP6 (recall/record) |
| WP6 | Run memory: write-back and recall | WP1, WP2 |
| WP7 | Router/agent prompts, demo data, test scenarios, video script | WP5 interface (prompt); WP0 Q2/Q3 may change wording |
| WP8 | UI Kit Run panel (jira:issuePanel) | WP1 interface |
| WP9 | Integration: manifest, handler exports, Jira trigger, CI | all others (incremental; can start with skeleton exports) |
| WP10 | Step dependency graph (`dependsOn`) | WP3, WP5, WP8 |
| WP15 | Skill library and sub-agent briefs | WP3, WP5, WP10, WP11, the recall tool from #33 |

## WP0 — Week-1 capability spikes: LLM access, agent delegation, rovo:skill, Forge SQL

- **Files owned:** `spikes/`, `docs/spikes/`
- **Dependencies:** none (blocks final decisions for WP3/WP5/WP7, but those start on the default design)

### Inputs / outputs / interface

Inputs: current hello-codegeist app (dev env, your-site.atlassian.net).
Outputs: `docs/spikes/WP0-REPORT.md` answering Q1–Q4 from docs/DESIGN.md §6 with yes/no, evidence (doc URL, `forge logs` excerpt, screenshot) and the chosen fallback. Throwaway spike code lives only under `spikes/` (separate manifests or branches, never merged into root manifest.yml).
Spikes:
1. Q1: can a Forge function call an Atlassian-hosted LLM? Try documented Forge LLM API if it exists; record the exact API.
2. Q2: can rovo:agent A invoke agent B (agentConnector / assignable agents)?
3. Q3: rovo:skill manifest syntax; does `forge lint` accept it; is it invocable by other agents?
4. Q4: Forge SQL availability + quotas; Entity Store index query patterns needed by WP1.
5. Confirm consumer `timeoutSeconds: 900` works and queue push from an action works within 55 s.

### Acceptance criteria

Report merged; each question has a decision + fallback; DESIGN.md §6 is updated accordingly. No production deploy.

## WP1 — Data model and storage layer

- **Files owned:** `src/store/ (and tests under src/store/__tests__/)`
- **Dependencies:** WP0 Q4 (can start immediately on Entity Store)

### Inputs / outputs / interface

Implements DESIGN.md §3 on Custom Entity Store (`@forge/kvs` / `@forge/api` storage). Entity/index definitions are delivered as a YAML snippet `src/store/entities.manifest.yml` that WP9 pastes into manifest.yml.
Interface (ESM, `src/store/index.js`):
```js
createRun({epicKey, projectKey, goal, createdBy}) -> Run            // status 'planning'
getRun(runId) -> Run|null
listRunsByEpic(epicKey, {limit}) -> Run[]
updateRun(runId, patch, {expectedUpdatedAt}) -> Run                 // optimistic, throws ConflictError
createSteps(runId, steps[{title, workerType, input}]) -> Step[]     // idx 0..n-1, status 'queued', attempt 0
getStep(stepId) -> Step|null
listSteps(runId) -> Step[]
updateStep(stepId, patch) -> Step
findStuckSteps(nowMs) -> Step[]                                     // running & deadlineAt<now, or queued >10min
putEffectIfAbsent(effect) -> {effect, created:boolean}               // keyed by requestKey
getEffect(requestKey) / updateEffect(requestKey, patch) / listEffectsByStatus(status)
addMemory(mem) / listMemoriesByProject(projectKey, {limit}) / supersedeMemory(memId, byMemId)
```
Types documented in `src/store/types.js` (JSDoc).

### Acceptance criteria

Unit tests with an in-memory adapter (`src/store/memoryAdapter.js`) pass via `npm test`; Forge adapter used in prod; all functions JSDoc-typed; values >64 KiB rejected with clear error.

## WP2 — Idempotent effects queue + applier

- **Files owned:** `src/effects/`
- **Dependencies:** WP1 interface (code against it; use memory adapter)

### Inputs / outputs / interface

Interface:
```js
requestKeyFor({runId, stepId, kind, discriminator}) -> string        // sha256 hex
enqueueEffect({runId, stepId, kind, payload, discriminator}) -> {requestKey, created}
// pushes {requestKey} to queue 'effect-queue'
effectApplierHandler(event)                                         // consumer for effect-queue
```
Kinds and payloads:
- `createIssue` `{projectKey, parentKey, summary, description, issueType}` -> result `{issueKey}`; also sets step.childIssueKey
- `comment` `{issueKey, bodyAdf|bodyText}` -> `{commentId}`
- `transition` `{issueKey, toStatusName}` -> `{transitionId, before, after}` when the issue status can be read. `before.statusName` is the status before the POST.
- `closeIssue` `{issueKey, toStatusName, label}` -> transition to Done, then add the label. Never deletes the issue. Optional `dependsOnKeys` waits until those effects are `applied`.
- `recordRemovedComment` `{issueKey, commentId}` -> delete that comment. A 404 (already gone) is applied. The effect row is the record.
- `restoreStatus` `{issueKey, toStatusName, expectedStatusName}` -> transition back only when the issue is still at `expectedStatusName`.
Retries: up to 5 tries with re-push (delay via queue `delayInSeconds`), then status `failed` and step -> `blocked`. The delay is the exponential backoff (5s, 10s, 20s, 40s, capped at 900s). A Jira 429 that includes `Retry-After` waits that long instead, still capped at 900s. Delta-seconds and an HTTP-date are both accepted. A 429 with no usable header keeps the backoff. A compensation whose `dependsOnKeys` are not yet `applied` is re-pushed without spending a try.

### Acceptance criteria

Duplicate enqueue with same key creates exactly one Jira mutation (test with mocked `requestJira`); applied effects are never re-applied; unit tests pass.

## WP3 — Step workers + run state machine

- **Files owned:** `src/worker/`, `src/run/`
- **Dependencies:** WP1, WP2

### Inputs / outputs / interface

Interface:
```js
// src/run/stateMachine.js
startRun(runId) -> Run              // planning->running, enqueue all steps, emits createIssue effects per step
reportStep(stepId, {status, output, error}) -> {step, run}   // recompute run status
recomputeRunStatus(runId) -> Run    // all done->done (+ enqueue summarize step); any failed->blocked
// src/worker/index.js
stepWorkerHandler(event)            // consumer for 'step-queue', payload {runId, stepId, attempt}
registerWorkerType(name, async (step, ctx) => ({output, effects:[...]}))
```
Built-in worker types (deterministic unless WP0 Q1 enables LLM): `research` (JQL search for related issues), `draft-spec` (templated description from step input), `check-deps` (linked issues), `summarize` (aggregate step outputs -> summary + decisions for WP6).
Stale attempts (event.attempt < step.attempt) exit without effects. Set `deadlineAt = now + 12min` on start.

### Acceptance criteria

Scenario test with memory adapter: 4-step run reaches `done`; a failed step makes run `blocked`; duplicate event is a no-op.

## WP4 — Watchdog (scheduled retry of stuck steps)

- **Files owned:** `src/watchdog/`
- **Dependencies:** WP1, WP2, WP3 interfaces

### Inputs / outputs / interface

Interface:
```js
watchdogHandler()                   // scheduledTrigger fiveMinute
// uses store.findStuckSteps, re-pushes {runId, stepId, attempt+1} to 'step-queue'
// attempt >= 3 -> step failed, run blocked, enqueueEffect comment on Epic
// also re-pushes effects in pending/retrying older than 5 min
```
Env flag `CONDUCTOR_DEMO_STUCK_STEP` (forge variable) lets the demo force one step to hang once.

### Acceptance criteria

Tests: stuck step retried with attempt+1; 3rd failure blocks run and posts one (deduped) Epic comment; runs in <25 s for 200 steps.

## WP5 — Rovo action handlers (accept + enqueue only)

- **Files owned:** `src/actions/`
- **Dependencies:** WP1, WP3 (startRun), WP6 (recall/record)

### Inputs / outputs / interface

Handlers (each returns in <55 s, never calls Jira mutations directly):
```js
planSplit({epicKey, goal, steps:[{title, workerType, input}]}, ctx) -> {runId, steps, recalledMemories, blastRadius}
dispatchRun({runId, confirm:true}) -> {runId, status, blastRadius}  // calls stateMachine.startRun; dedupe via idem:dispatch key. blastRadius is present on the planning transition only
getRunStatus({runId?|epicKey}) -> {run, steps:[{idx,title,status,childIssueKey,attempt}], blastRadius}
// run.effectMetrics is {applied, deduped, retried}. applied and retried are
// counted from effect rows (status, tries). deduped is the in-process tally
// plus run.budget.effects.deduped when a budget write has already flushed it.
recallMemory({projectKey, query}) -> {memories:[...]}           // delegates to WP6
recordDecision({epicKey, text, type}) -> {memId}                // delegates to WP6
```
Input validation (max 8 steps, allowed workerTypes from WP3 registry). Action input schemas delivered as `src/actions/actions.manifest.yml` for WP9.

Reusable-tool extension (Conductor called by other agents): the same four handlers `plan-split`, `dispatch-run`, `get-run-status`, and `recall-memory` are the tools a second agent and `rovo:mcp` invoke. Success objects include `ok: true`. `blastRadius` is the recomputed preview card (`previewBlastRadius`). It is not stored and it is not a Jira write. `dispatch-run` includes it only when the run was still `planning`. The Forge boundary returns `{ok:false, error, code}` on failure. `getRunStatus` returns `run` as `{runId, epicKey, projectKey, goal, status, summary, createdAt, updatedAt, reviewedThroughWave, leadAction, budget, criticalPath, eta, budgetOutlook, effectMetrics}` and each step includes `workerType`, `dependsOn`, and `childIssueKey` (`null` until the child exists). `budget` is the stored cap and the measured usage (`maxSteps`, `maxModelCalls`, `wallClockMs`, `usedSteps`, `usedModelCalls`, `usedTokens`, `elapsedMs`, `startedAt`). `budget.chaos` is `{injected, healed, duplicateWrites}`. The reader returns zeros when the row has not stored `chaos`. The object is written only when the fault gate is open and a counter moves. It is not a new attribute. `run.effectMetrics` is `{applied, deduped, retried}`. `applied` and `retried` are counted from the effect rows (`status`, `tries`) when status is read, which adds one `listEffectsByRun` read and no write. `deduped` is drops this process has not flushed, plus `run.budget.effects.deduped` when a budget write that was already happening carried the tally (the chaos counter write). A pure redelivery still writes 0 KVS bytes and does not grow `budget.effects`. The panel loader returns the same object from the effects it already loaded. `criticalPath` (`indexes`, `keys`, `durationMs`), `eta` (`remainingMs`, `finishAt`), and `budgetOutlook` (`over`, `reasons`) are computed from those steps and are not stored. `plan-split` also returns `dependsOn` on each step and `budgetReplan` (`applied`, `reason`, `mergedIdxs`). `record-decision` stays on the supervisor. Contract: `src/actions/contract.js` and `docs/spike-rovo-skill-mcp.md`.

### Acceptance criteria

Handler unit tests with mocked store; manifest snippet passes `forge lint` when merged by WP9; Router can call them in dev tunnel.

## WP6 — Run memory: write-back and recall

- **Files owned:** `src/memory/`
- **Dependencies:** WP1, WP2

### Inputs / outputs / interface

Interface:
```js
writeBack(runId, {summary, decisions:[{text,type}]}) -> {memIds}   // memory records + enqueueEffect comment on Epic with header "[Conductor memory]"
recall({projectKey, query, k=5}) -> Memory[]                       // keyword/label overlap scoring, skips superseded/expired
record({projectKey, epicKey, text, type}) -> {memId}
```
Called by WP3 `summarize` worker on run done, and by WP5 actions.

### Acceptance criteria

Tests: decisions from run 1 are returned for a related goal in run 2; superseded memory excluded; Epic comment deduped by requestKey.

## WP7 — Router/agent prompts, demo data, test scenarios, video script

- **Files owned:** `prompts/`, `demo/`, `tests/scenarios/`, `docs/VIDEO.md`, `docs/DEVPOST.md`
- **Dependencies:** WP5 interface (prompt); WP0 Q2/Q3 may change wording

### Inputs / outputs / interface

Deliverables:
- `prompts/router.md`: restricted supervisor prompt for `conductor-router` (only the 5 actions; emits plan as JSON matching WP5 `planSplit` input; always asks for confirm before `dispatch-run`; reports status from `get-run-status`; uses recalled memories). Plus `conversationStarters`.
- `demo/seed.md` + `demo/seed.json`: demo Jira project content (Epic "Ship payment refunds", related second Epic, issues/labels) and a script or step-by-step to create them on the dev site.
- `tests/scenarios/*.md`: end-to-end scenarios (happy path, stuck step + watchdog, duplicate request, memory recall, invalid plan) with expected UI/Jira state.
- `docs/VIDEO.md`: 3-minute English script + shot list (follow DESIGN.md goals); `docs/DEVPOST.md`: submission copy draft.

### Acceptance criteria

Prompt keeps the agent inside the 5 actions in 5 adversarial tries (documented); scenarios reference real action/field names from TASKS.md; video script ≤3:00 at 150 wpm.

## WP8 — UI Kit Run panel (jira:issuePanel)

- **Files owned:** `src/frontend/`, `src/resolvers/`
- **Dependencies:** WP1 interface

### Inputs / outputs / interface

- `src/resolvers/index.js`: `panelResolver` with defs `getRunsForIssue({issueKey})`, `getRun({runId})` (read-only, uses WP1 store; <25 s).
- `src/frontend/index.jsx`: UI Kit panel: latest run header (goal, status lozenge), step tree (idx, title, workerType, status, attempt, child issue link), timeline of effects, memory section, refresh button / polling every 5 s while running.
- Module snippet `src/frontend/panel.manifest.yml` for WP9.

### Acceptance criteria

Panel renders on Epic in dev env with seeded data; empty state; blocked/failed visuals; no write operations from UI except 'Retry step' (calls a resolver that re-enqueues, optional).

## WP15 — Skill library and sub-agent briefs

- **Files owned:** `src/skills/`, `skills/`, `docs/wp15-demo.md`
- **Dependencies:** WP3, WP5, WP10 (`dependsOn` / `dependencyContext`), WP11 (`@forge/llm`), and the recall tool from #33.

The architecture doc's "WP13" is this package. It is numbered WP15 here so it does not collide with the Flight Recorder package or the callable-skill package.

### Inputs / outputs / interface

```js
listSkillIndex() -> [{name, description}]          // no body, tools, or schema
loadSkill(name) -> SkillPack                       // body included; throws UNKNOWN_SKILL
prepareStepDraft(step, {goal}) -> step draft       // adds skill + brief when a pack exists
buildBrief({skill, step, run}) -> {objective, allowedTools, doneWhen, budget}
runSubAgent({step, ctx, skill, handler, brief}) -> {output, effects, fullOutput}
registerSkillModel(fn|null)                        // default is @forge/llm; null restores it; a null result keeps the checklist
```

`recall-memory` returns `{ok, memories, skillIndex}`. `memories` stays inside the 1536-byte lesson budget. `skillIndex` is `{name, description}` only and is not part of that budget. The same object is what `rovo:mcp` returns, because MCP calls this action.
`plan-split` accepts a `workerType` that is a registered worker or a skill name, and stores `step.skill` and `step.brief`.
`step.brief` is `{objective, allowedTools, doneWhen, budget}`. `budget.maxRepairAttempts` is 1. `budget.maxOutputBytes` is at most 2048.
`step.output` for a skill step is the short result. The full output is the child-issue comment.
A schema failure after the one repair, a tool outside the brief, or a blown tool budget reports the step as `blocked`.

New step attributes (do not remove once deployed): `skill` (string), `brief` (any). `stepId` stays the entity key and is not an attribute.

Skill files: `skills/*.md`. A new file is discovered by scanning the directory. `procedure: checklist` (the default) needs no JavaScript. `procedure: builtin` calls the existing worker.

### Acceptance criteria

Unknown skill is rejected. A schema violation is repaired once, then the step is `blocked` if it is still invalid. `npm test` passes. No production deploy. Demo script in `docs/wp15-demo.md`.

## WP9 — Integration: manifest, handler exports, Jira trigger, CI

- **Files owned:** `manifest.yml`, `src/index.js`, `src/triggers/`, `package.json`, `.github/workflows/`
- **Dependencies:** all others (incremental; can start with skeleton exports)

### Inputs / outputs / interface

- Merge module snippets from WP1/WP5/WP8 into manifest.yml per DESIGN.md §4 (agent `conductor-router`, actions, consumers `step-worker`/`effect-applier` with `timeoutSeconds: 900`, scheduledTrigger `watchdog`, trigger `child-issue-updated`, issuePanel, entities, scopes). Keep app id unchanged; keep or retire hello actions.
- `src/index.js`: export all handlers.
- `src/triggers/childIssueUpdated.js`: on child issue Done/commented -> `reportStep`. A Done-like transition of an approval gate's child calls `approveGate` (actor, note, `generator: 'human'`) instead of a bare done. Already-done is idempotent. A non-approval child keeps the bare done report.
- CI workflow: `npm ci`, `npm test`, `forge lint` (lint may need FORGE creds — skip if not available, never store secrets in repo; use GitHub secrets only if they are added).
- Owns final `forge deploy -e development` only after explicit approval.

### Acceptance criteria

`forge lint` clean; dev deploy shows all modules; end-to-end happy path scenario from WP7 passes on dev site.

## WP10 — Step dependency graph

- **Files owned:** `src/run/` (graph + when steps start), plan schema (`dependsOn` on the step and on `plan-split`), `prompts/router.md` dependency section, Run panel graph
- **Dependencies:** WP3, WP5, WP8

### Inputs / outputs / interface

Additive. Do not remove KVS fields.

`stepsJson` objects gain optional `dependsOn: number[]` (step indexes in the same plan). Omitted or `[]` means the step starts with the run. `plan-split` rejects a self-index, an unknown index, a duplicate index, and a cycle, and stores nothing in that case.

`startRun` still creates a child issue for every step. It enqueues `step-queue` only for steps whose dependencies are already `done`. The others are stored as status `waiting` (not scanned by the watchdog). When `reportStep` marks a step `done`, every waiting step whose `dependsOn` indexes are all `done` is set back to `queued` and enqueued. Its row then has `dependencyContext`: `[{idx, title, workerType, output}]` in `dependsOn` order. Workers read that field from the step object. Independent steps are enqueued together.

`updateStep(stepId, patch, {expectedStatus})` writes only while the stored status is still `expectedStatus`, using the existing string compare-and-swap on `status`. A mismatch returns null. Callers that do not pass `expectedStatus` keep the previous retry behaviour. Do not add a condition on a float attribute.

The Run panel shows an indented dependency graph with one status lozenge per planned step.

### Acceptance criteria

A chain does not start the later step until the earlier one is `done`, and the later step's `dependencyContext` contains that output. Two steps with empty `dependsOn` are both enqueued at dispatch. A cycle is rejected at plan time. `npm test` passes. No deploy.

## WP12 — Lessons that change the next plan

Folded in from docs/novelty.md (lessons that change behaviour), docs/oss-borrow.md (ExpeL ops, mem0 dedupe, Graphiti validity), and docs/superagent-architecture.md (WP15 two-tier memory). Owned with WP6's `src/memory/`.

### Interface

```js
addLesson({projectKey, scope, epicKey, text, cause, goal, kind, confidence, votes, status}) -> {op, lessonId, ...}
// scope is required: 'global' | 'project' | 'epic'. Missing scope throws.
// op is 'add' | 'edit' | 'noop'. Identical text on a live head is a noop.
editLesson({lessonId, projectKey, text}) -> {op, lessonId, votes, status, confidence, validFrom, validTo}
upvoteLesson / downvoteLesson / acceptLesson / rejectLesson({lessonId, projectKey})
// accept sets status 'accepted' and votes >= 1. reject sets 'rejected' and does not delete.
// downvote of an accepted lesson with votes < 1 sets validUntil (expired), row kept.
listLessons({projectKey}) -> Lesson[]          // current heads, including expired
lessonsAt({projectKey, asOf, query}) -> Lesson[] // versions that held at asOf
recordFailureLesson({run, step, status, error, kind})  // proposed lesson; deduped
applyMemoriesToPlan({projectKey, epicKey, goal, steps, maxSteps}) -> {
  steps, appliedLessons, appliedMemories, usedLessons, usedMemory, planCard
}
```

`planSplit` calls `applyMemoriesToPlan` before `createSteps`. It returns the WP5 fields plus `appliedLessons`, `appliedMemories`, `usedLessons`, `usedMemory`, and `planCard`. Only an accepted lesson with votes >= 1 and keyword overlap is injected. The usual change is a leading `check-deps` step whose input cites `Lesson <memId>`. That step has `dependsOn: []`. Every later step's indexes shift up by one and gain a dependency on the new step, so the graph still waits for the check. When a lesson is applied, one Epic comment is enqueued with header `[Conductor plan]` and discriminator `plan:lesson-citation`.

`writeBack` stores a `type: 'lesson'` decision as a proposed planner lesson (`kind: 'summarize'`), not as a second plain row. An identical lesson is a noop. `recall-memory` (the tool and MCP action) returns accepted, scoped lessons inside the 1536-byte budget, plus other scoped memories. Proposed planner lessons are omitted from that tool.

`recall({projectKey, query, k, epicKey, asOf, budgetBytes})` reads the project pool and the global pool (`projectKey` `__global__`). Default `budgetBytes` is 1536. `asOf` replays superseded rows that were valid then. Rows with no `scope` are skipped. `validUntil` is not a KVS condition.

Each lesson envelope stores `votes`, `status` (`proposed|accepted|rejected`), `confidence` (0–1), `tier`, `scope`, `validFrom`, `validTo`, and `dedupeKey` in the memory text. The entity attributes are unchanged: expiry still uses `validUntil`, replacement still uses `supersededBy`. No attribute is removed.

The Run panel adds **Recall** (citations for this plan) and **Lessons** (accept, reject, upvote, downvote, edit, add) via resolver `lessonOp`.

### Acceptance criteria

`npm test` covers: run 1 failure records a proposed lesson; run 2 is unchanged until accept; after accept the plan starts with check-deps, later steps depend on it, and the plan card cites the lesson id; reject stops that; edit/downvote keep the old row; `lessonsAt` / `recall({asOf})` return the version that held then; global lessons are recalled and rank under a project lesson; recall honours the byte budget; a summarize lesson is proposed once. The Run panel keeps the dependency graph on the Run tab beside Recall and Lessons.

## WP14 — Lead loop with waves and context compression

The package described in [docs/superagent-architecture.md](superagent-architecture.md). Demo script: [docs/wp14-demo.md](wp14-demo.md).

### Interface

```js
maybeReviewWave(dependencies, run, steps) -> Run
// Called when every non-summarize step is done and nothing is queued, running, or waiting.
// Claims the wave with compare-and-swap on integer run.reviewedThroughWave (not updatedAt).
// Decides spawn | stop | ask. Caps: 3 waves, 8 steps. Effort: small 1 follow-up, medium 2, large 3.

resumeAwaitingRun({issueKey, event, listRuns, dependencies}) -> {status, action, runId}|null
// awaiting-review only. `conductor stop` or a Done transition stops.
// `conductor continue` or In Progress spawns the suggested steps.
// `conductor spawn: <worker> | <title>` adds that one step.
// A comment that contains `[Conductor wave]` is ignored.
```

`plan-split` still stores the caller's steps as wave 1 (`step.wave`, default 1). After that wave finishes, the lead may append steps whose `dependsOn` lists the finished wave. Those steps receive `input.waveDigest` and a `dependencyContext` built from the digest. Full outputs stay on the step and the child issue.

`run.ledger` (any) holds `{digests:[{wave, text, bytes, stepIdxs}], lastDecision, resume}`. Each digest is at most 1024 UTF-8 bytes. `run.status` `awaiting-review` pauses the run. The watchdog skips steps in that run. The issue trigger resumes it. The trigger passes `allowLeadLlm: false` so the short invocation uses the deterministic rules. The step worker may call `@forge/llm`; the same `<untrusted>` fence wraps the digest.

New event kinds: `wave_started`, `lead_decision`, `digest_written`. The timeline and the dependency graph show the wave. New attributes are append-only: `run.reviewedThroughWave` (integer), `run.ledger` (any), `step.wave` (integer). The entity key is still not stored as an attribute. Jira writes stay on the effects queue (`assumeTrustedRoute`).

### Acceptance criteria

`npm test` covers: a quiet wave stops and posts one Epic wave report; `unknown dependency` spawns `check-deps` with `dependsOn` and the child sees the digest rather than the full output; effort scaling and the 3-wave / 8-step caps; the model JSON is used when a client is passed and the prompt does not contain the raw output; invalid or disabled model calls fall back to the rules; `ask` pauses until `conductor continue`, `conductor stop`, or a Done transition; the wave report cannot unpause the run; the watchdog does not retry during `awaiting-review`; two claims on `reviewedThroughWave` produce one write. No production deploy.

## Flight recorder (replay / fork)

Added after the WP1–WP9 split. It extends the store and the supervisor's Rovo actions. It does not add tools to `rovo:mcp` or `conductor-tools`. The write-up is [docs/flight-recorder.md](flight-recorder.md).

```js
appendEvent({runId, kind, stepId?, stepIdx?, journalKey?, span?, detail?, at?}) -> Event
listEventsByRun(runId) -> Event[]                  // seq ascending; range is integer seq, not float `at`
listEventsByJournalKey(journalKey) -> Event[]      // effect requestKey or step-result key
replayRun(runId) -> {ok, dryRun: true, duplicateWrites: 0, steps, effects, lessons, summary}
forkRun({runId, stepIdx, input?}) -> {ok, runId, forkedFromRunId, copy, rerun, edited}
```

`stepResultKey({runId, stepId, attempt})` is sha256 of `runId|stepId|step-result|attempt`. Effect rows keep `requestKeyFor`. Replay and fork treat an applied effect, or a journal event with `detail.phase === 'applied'`, as a skip. The event entity key is `${runId}#${seq}` and is not stored as an attribute. `step.stallCount` reaches 2 and the watchdog appends kind `replan` without a Jira write. Rovo actions: `replay-run` (GET), `fork-run` (CREATE). Descriptions stay within 255 characters and success payloads include `ok: true`.

Replay calls `lessonsAt({projectKey, asOf: run.createdAt, query: goal})` and the same read at now. Lessons whose `validFrom`/`validTo` window contains the run's `createdAt` are the ones that held then. The diff lists newer accepted lessons and the plan change they would make (a leading `check-deps`, or a citation on the existing one). Replay does not call the model and does not write.

Fork's rerun set is the transitive `dependsOn` dependents of step N (WP10). An empty `dependsOn` means the step starts with the run, not "every later index".

## Approval gates (novelty #5)

No new entity, scope, or queue. `workerType` `approval` is a step. `plan-split` may append one before `createSteps`.

```js
applyBlastGate({run, steps, planCard}) -> {steps, inserted, reason}
// Calls previewBlastRadius. Inserts only when gate.insert && gate.fits.
// Temporary preview step ids are not stored. dependsOn is written by createSteps.

approveGate(stepId, {actor, note}?, overrides?) -> {step, run, approved, duplicate}
// Reports the gate done via reportStep. A second call is duplicate: true.
// Not a Jira write. childIssueUpdated calls this when the gate's child
// transitions to a Done-like status. The output is gateApprovalOutput:
// {approved: true, actor, note, generator: 'human'}.

lessonAsksForPerson(lesson) -> boolean
// True for "needs a person", "needs approval", "human approval", "ask a person".
// applyMemoriesToPlan then appends one approval step and points only the
// named step at it. It does not prepend check-deps. A plan already at 8
// steps is not grown; the citation is written onto the target input.
```

`startRun` creates the gate's child (`createIssue`, discriminator `child-issue`) and stores the gate as `waiting`. It does not push `step-queue`. `releaseWaitingSteps` does not release a gate. The watchdog does not retry one.

## Run budget (novelty #6, first slice)

No new entity, scope, or queue. `run.budget` is one `any` attribute. Do not remove it once deployed. The critical path and the merge are the next section. This slice only records.

```js
initialRunBudget(now) -> Budget
// maxSteps: 8 work steps. Summarize is not counted.
// maxModelCalls: 8 steps × 3 attempts + 3 lead waves + 1 summarize.
// wallClockMs: 8 × 12 minutes. Not an ETA.
// usedSteps, usedModelCalls, usedTokens, elapsedMs, and startedAt start at 0
// except startedAt, which is `now` (the simulator clock in tests).

applyRunBudget(budget, {steps, calls, tokens, now, startedAt}) -> Budget
// Adds the deltas and sets elapsedMs from the clock. Does not change status.

commitRunBudget(store, runId, {calls, tokens}, now) -> Run|null
// One update when a chat actually ran. Disabled and unavailable calls add
// nothing, so CONDUCTOR_LLM=off does not write.

readRunBudget(budget, startedAt) -> Budget
// What get-run-status and the panel read. Caps come from the constants.

isWithinRunBudget(budget) -> boolean
// Read-only. A false result does not block the run and does not merge.
```

`createRun` stores the initial budget. `createSteps` adds one `usedSteps` per new work step in that batch (approval gates count, summarize does not) and skips the write when the batch adds none. `startRun` refreshes `elapsedMs` on the planning→running write. A step worker keeps an in-memory meter and `reportStep` flushes it once under the run lock. The lead flushes its own meter after the wave claim, still under that lock. `usedTokens` sums `usage.total_tokens`, or `input_tokens` plus `output_tokens`, from those chats. There is no run-level token cap; per-call `max_completion_tokens` is unchanged.

### Acceptance criteria

`npm test` covers: a new run stores the caps and zero usage; summarize does not increment `usedSteps`; a disabled model does not count; a chat that returns usage or throws does; usage past `maxModelCalls` stays on the run and leaves `status` alone. Scenario `run-budget` plans two steps, advances the simulator clock, dispatches, and drains with the scripted model on. It asserts the stored budget, `usedModelCalls` equal to the fake's chat count, token usage, elapsed wall-clock, and that the run stayed inside the caps. No production deploy.

## Critical path and budget re-plan (novelty #6, second slice)

No new entity, scope, queue, or attribute. The path and the ETA are computed from steps the caller already holds, the same way `previewBlastRadius` is. They are not written onto `run.budget`.

```js
criticalPathOf(steps, now) -> {indexes, keys, durationMs}
// Longest chain of remaining work. dependsOn runs first; indexes are root-first.
// Duration is STEP_DEADLINE_MS (12 min) unless the step has a positive integer
// durationMs on itself or on input.durationMs. input is the existing any attribute.
// summarize contributes 0 and is omitted. done contributes 0.
// A waiting approval gate stays on the path. A running step with no specific
// duration uses the time left until deadlineAt, or one full deadline if that
// clock has already passed.

scheduleFor(steps, budget, now) -> {criticalPath, eta, budgetOutlook}
// eta is {remainingMs, finishAt}. finishAt is now + remainingMs.
// budgetOutlook.reasons is any of 'wall-clock', 'steps', 'model-calls'.
// Read-only. Does not merge.

applyBudgetReplan(steps, budget, now) -> {steps, applied, reason, mergedIdxs, criticalPath, eta, budgetOutlook}
// One pair, or none. reason is within-budget, merged, merged-still-over,
// no-cheap-pair, or merge-would-not-help. Does not call a model.
// Cheap means planned duration <= 12 min, and the step is not approval,
// summarize, running, done, failed, or blocked.
// Prefers the pair that shortens the critical path. Same workerType, then
// a direct dependsOn edge, then the lowest indexes.
// The merged step keeps the upstream workerType. Its duration is the longer
// of the two, not the sum. Title is "left + right".
// Indexes come back as 0..n-1. Call this before createSteps. dependsOn is
// not patched after the row exists, so a stored plan is not rewritten.
```

`plan-split` calls `applyBudgetReplan` after the lesson pass and the blast-radius gate, and before `prepareStepDraft` / `createSteps`. A plan that fits does not change the `plan.created` event. A merge adds `detail.budgetReplan` on that same event. It does not write kind `replan` (that kind is the stall helper in `src/recorder/replan.js`). `get-run-status` and the panel loader call `scheduleFor` on the steps they already loaded.

Over means elapsed + critical path `>` `wallClockMs`, or the projected work-step count `>` `maxSteps`, or `usedModelCalls` plus one call per remaining non-approval step `>` `maxModelCalls`. Equal to a cap is still inside, so eight serial default steps are not merged. Going over does not change `run.status`.

### Acceptance criteria

`npm test` covers the longest chain, the lower-index tie break, a specific duration, done steps, summarize, a waiting gate, a running deadline, an eight-step plan that is not merged, a merge that picks the pair on the critical path, a no-op when nothing would help, a step-cap sibling merge, and a model-call merge. Scenario `critical-path` plans a chain whose longest path includes an approval gate and skips a shorter branch, checks the ETA against the simulator clock, then plans a chain past `wallClockMs` and asserts the two cheap steps were merged, the new path is shorter, and the run stayed `planning`. No production deploy. `CONDUCTOR_LLM` stays off.

## Simulator fault injection (novelty #7, first slice)

No new entity, scope, queue, or attribute. The schedule is an in-memory list in `src/chaos/faults.js`. It is not written to KVS and it is not returned by `get-run-status`.

The counters are the second slice. They share `run.budget` (`any`). `chaos` is omitted until a counter moves, and only while the fault gate is open.

```js
// Stored on run.budget.chaos. Absent means all three are 0.
{ injected, healed, duplicateWrites }

// injected: the fault fired (kill stopped the worker, the extra effect
//   message was pushed, or the applier returned the injected 429).
// healed: the watchdog retried that killed step, the applier dropped that
//   duplicate request key, or the retry after that 429 applied.
// duplicateWrites: a Jira mutation completed twice for one request key.
//   The duplicate-effect path keeps this at 0.
```

`get-run-status` returns `budget.chaos` (zeros when the row has no `chaos` key). The panel loader returns the same three numbers as `chaos`. A closed gate does not read or write them.

```js
isFaultInjectionEnabled(env) -> boolean
// True only when CONDUCTOR_FAULT_INJECTION=simulation and CONDUCTOR_SIMULATION is 1 or true,
// or CONDUCTOR_FAULT_INJECTION=development and CONDUCTOR_APP_ENV=development.
// CONDUCTOR_APP_ENV of production, staging, or prod is false even if the other variables match.

injectFault({type, stepId?, requestKey?, retryAfterSeconds?}, env) -> {armed: false, reason} | {armed: true, id, type}
// type is kill-worker, duplicate-effect, or jira-429.
// A closed gate returns {armed: false, reason: 'disabled'} and stores nothing.
// One fault is consumed once. stepId limits a kill. requestKey limits a duplicate or a 429.
// retryAfterSeconds is the Retry-After header (0–60, default 1). The applier
// waits that many seconds, capped at 900. A 429 with no header keeps the backoff.

resetFaultInjection() -> void
```

`dev-dispatch` accepts `{injectFault: {type, ...}}` after the `x-dev-secret` check. It returns the `injectFault` result and does not plan or dispatch. The step worker installs `ctx.faultCheckpoint` only when the gate is open. Built-in workers call it after they have read their evidence (`after-evidence`). The throw leaves the step `running` and queues no effect. A worker that does not call the checkpoint is killed after its function returns and before `enqueueEffect` (`before-effects`). `enqueueEffect` pushes the same request key a second time when a `duplicate-effect` fault matches and the first push succeeded. The effect applier returns one HTTP 429 for a matching `jira-429` fault and then uses the real `requestJira`. Status 429 stays retryable.

### Acceptance criteria

`npm test` covers a closed gate (missing flag, simulation without `CONDUCTOR_SIMULATION`, development without `CONDUCTOR_APP_ENV`, and production or staging even when the other variables are set), including a worker that still finishes and a Jira call that is not a 429. It also covers each fault: a kill after a Jira read with no queued effect, a duplicate delivery that writes Jira once, and a 429 that retries and then applies. The counters move only while the gate is open: one `injected` per fired fault, one `healed` for the watchdog retry, the dropped duplicate, or the 429 retry, and `duplicateWrites` only when Jira mutates one request key twice. A closed gate leaves `budget.chaos` absent. Scenario `chaos-counters` is one duplicate and one heal. Scenario `chaos-proof` arms all three faults on one run, aimed at different hooks: the child-issue request key is duplicated, the research-comment request key returns one 429, and the step is killed after it has read its evidence. The watchdog retries that step once. The comment applies on the existing effect retry. The run finishes with `budget.chaos` `{injected: 3, healed: 3, duplicateWrites: 0}`, one child issue per step, and one comment per child. No production deploy. `CONDUCTOR_LLM` stays off.
