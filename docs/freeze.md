# Architecture freeze — Ticket Conductor

Frozen **2026-11-10** from `main` at `5387dda` (PR #62, comment batching), ahead of the 2026-11-23 calendar item. The simulator on that commit is the architecture. This note does not add an entity, an attribute, a scope, a queue, or an action.

Until **2026-11-24** and **2026-11-25** update `docs/superagent-architecture.md` and `docs/DESIGN.md`, those files can lag the code. This note is the boundary they should be edited toward. They do not move the boundary.

The check is `src/__tests__/architectureFreeze.test.js`. It reads `manifest.yml` and fails `npm test` when a scope, a queue name, an action key, a module key, or a storage entity, attribute, type, or index changes. It also requires `src/store/entities.manifest.yml` to carry the same storage block. Copy in a description or a prompt does not fail it.

## What M3 and M4 may still change

- A bug fix that keeps the lists below. A fix that moves a simulation total may update that scenario's KVS cap.
- Docs, prompt wording, skill-pack wording, panel copy, Devpost copy, and the video script. Wording stays inside the action allowlist below.
- Tests.

`CONDUCTOR_LLM` stays `off` except the M5 recording window. November does not run live Jira or Rovo. No deploy to staging or production. The app id stays `ari:cloud:ecosystem::app/00000000-0000-4000-8000-0000000000a1`.

A new entity, attribute, index, scope, queue, action, or module waits until after Codegeist. So does a new effect kind, event kind, or step status. Forge also refuses to delete an attribute that has already shipped, so the lists below are append-only in production even after the contest. `run.summarizeQueued` is unused and stays.

Keys are not attributes. Writing `runId` on a run, `stepId` on a step, `requestKey` on an effect, `memId` on a memory, or an event id is an undeclared field and Forge returns 422. The event key is `${runId}#${seq}`.

## Module map

`src/index.js` only re-exports. Work stays in the directory that owns it.

| Path | Owns |
|---|---|
| `src/actions/` | Rovo handlers. Accept, validate, enqueue. They do not mutate Jira. |
| `src/run/` | State machine, dependency graph, lead loop, approval gates, run budget, critical path. |
| `src/worker/` | `step-queue` consumer and the built-in workers. The Forge LLM call lives here, behind `CONDUCTOR_LLM`. |
| `src/effects/` | `effect-queue` consumer, request keys, Jira writes, comment batching, effect counters. |
| `src/watchdog/` | `fiveMinute` trigger, the KVS activity gate, stuck-step retry. |
| `src/store/` | Custom Entity Store. Memory adapter in tests, Forge adapter in prod. |
| `src/memory/` | Recall, write-back, lessons. Lessons are rows on `memory`, not their own entity. |
| `src/skills/` | Skill packs and sub-agent briefs. |
| `src/recorder/` | Append-only event log, replay, fork. |
| `src/blast/` | Blast-radius card and the undo plan. Pure. No storage and no Jira. |
| `src/chaos/` | Fault schedule in process memory. Counters ride on `run.budget`. |
| `src/triggers/` | `avi:jira:updated:issue` and `avi:jira:commented:issue`, `ignoreSelf: true`. |
| `src/resolvers/` + `src/frontend/` | UI Kit issue panel. Read-only except retry, lesson ops, replay, and fork. |
| `src/dev/` | `dev-dispatch` webtrigger. Fault injection and the dev probe. |
| `src/platform/` | Queue push retry shared by the producers. |

Runtime on the manifest: `nodejs24.x`, 256 MB, `arm64`. Storage classification: `ugc`.

## Frozen manifest

### Scopes

These four, and no others. A new scope means a reinstall.

- `read:jira-work`
- `write:jira-work`
- `storage:app`
- `search:confluence` (CQL for the research worker; page bodies are not expanded)

There is no delete-issue scope. Undo closes a child and labels it.

### Queues

| Consumer key | Queue | Function |
|---|---|---|
| `step-worker` | `step-queue` | `stepWorker` |
| `effect-applier` | `effect-queue` | `effectApplier` |

`step-queue` messages are `{runId, stepId, attempt}`. `effect-queue` messages are `{requestKey}` plus an optional `delayInSeconds` (0–900). Both consumers and the watchdog function set `timeoutSeconds: 900`. The same two names are the constants in `src/run/dependencies.js`, `src/effects/queue.js`, and `src/watchdog/constants.js`.

### Actions

| Key | Function | Verb | Router and playbook | Handoff, `conductor-tools`, and MCP |
|---|---|---|---|---|
| `plan-split` | `planSplit` | CREATE | yes | yes |
| `dispatch-run` | `dispatchRun` | UPDATE | yes | yes |
| `get-run-status` | `getRunStatus` | GET | yes | yes |
| `recall-memory` | `recallMemory` | GET | yes | yes |
| `record-decision` | `recordDecision` | CREATE | yes | |
| `replay-run` | `replayRun` | GET | yes | |
| `fork-run` | `forkRun` | CREATE | yes | |

`conductor-router` and `conductor-playbook` have all seven. `conductor-handoff`, the `conductor-tools` skill, and `rovo:mcp` (`conductor-mcp`) have the first four. Descriptions are capped at 255 characters and may be edited as copy. The keys may not.

### Other module keys

- `llm:conductor-llm` — one `llm` module, family `claude`. Workers call it from `step-worker`, not from an action.
- `rovo:agent:conductor-router` — supervisor. Prompt `prompts/router.md`.
- `rovo:agent:conductor-handoff` — the second agent. It does not write to Jira itself.
- `rovo:skill:conductor-playbook` — supervisor skill, all seven actions.
- `rovo:skill:conductor-tools` — the reusable four.
- `scheduledTrigger:watchdog` — interval `fiveMinute`.
- `trigger:child-issue-updated`.
- `jira:issuePanel:run-panel` — UI Kit, title "Conductor run".
- `webtrigger:dev-dispatch`.
- Functions: `devDispatch`, `planSplit`, `dispatchRun`, `getRunStatus`, `recallMemory`, `recordDecision`, `replayRun`, `forkRun`, `stepWorker`, `effectApplier`, `watchdogHandler`, `childIssueUpdated`, `panelResolver`.

Panel resolver names: `getRunsForIssue`, `getRun`, `retryStep`, `lessonOp`, `replayRun`, `forkRun`, `exportRunTrace`.

## Frozen storage

Five entities. Attribute types are the manifest types. Indexes are partition, then range.

### `run`

| Attribute | Type |
|---|---|
| `epicKey` | string |
| `projectKey` | string |
| `goal` | string |
| `status` | string |
| `createdBy` | string |
| `createdAt` | float |
| `updatedAt` | float |
| `summary` | any |
| `summarizeQueued` | boolean |
| `forkedFromRunId` | string |
| `forkedFromStepIdx` | integer |
| `forkSeq` | integer |
| `reviewedThroughWave` | integer |
| `ledger` | any |
| `budget` | any |

Indexes: `by-epic` (`epicKey`, `createdAt`), `by-status` (`status`, `updatedAt`).

`budget` holds the caps and the counters in one value: `maxSteps` 8, `maxModelCalls` 28 (8 steps × 3 attempts + 3 lead waves + summarize), `wallClockMs` 5,760,000 (8 × 12 minutes), `usedSteps`, `usedModelCalls`, `usedTokens`, `elapsedMs`, `startedAt`. Optional `chaos` is `{injected, healed, duplicateWrites}`, written only while the fault gate is open and a counter moves. Optional `effects` is `{deduped}`, flushed only when a budget write is already happening. `applied` and `retried` are counted from effect rows at read time and are not stored.

`ledger` holds `{digests, lastDecision, resume}`. Each digest is at most 1024 UTF-8 bytes.

`reviewedThroughWave` is the integer the lead compare-and-swaps. It is not a float.

### `step`

| Attribute | Type |
|---|---|
| `runId` | string |
| `idx` | integer |
| `title` | string |
| `workerType` | string |
| `input` | any |
| `childIssueKey` | string |
| `status` | string |
| `attempt` | integer |
| `deadlineAt` | float |
| `createdAt` | float |
| `output` | any |
| `error` | any |
| `dependsOn` | any |
| `dependencyContext` | any |
| `stallCount` | integer |
| `skill` | string |
| `brief` | any |
| `wave` | integer |

Indexes: `by-run` (`runId`, `idx`), `by-status-deadline` (`status`, `deadlineAt`), `by-status-created` (`status`, `createdAt`), `by-child-issue` (`childIssueKey`, `createdAt`).

`input` may carry `durationMs` and `waveDigest`. Those are keys inside the existing `any` value. `brief` is `{objective, allowedTools, doneWhen, budget}` with `budget.maxRepairAttempts` 1 and `budget.maxOutputBytes` at most 2048. `dependsOn` is a list of step indexes. Empty means the step can start with the run.

### `effect`

| Attribute | Type |
|---|---|
| `runId` | string |
| `stepId` | string |
| `kind` | string |
| `payload` | any |
| `status` | string |
| `tries` | integer |
| `result` | any |
| `appliedAt` | float |
| `updatedAt` | float |

Indexes: `by-status` (`status`, `updatedAt`), `by-run` (`runId`, `updatedAt`).

The entity key is the request key, `sha256(runId|stepId|kind|discriminator)`. `payload.batchedFrom` records the parts of a folded comment. `result.before` is the snapshot undo reads. Both sit on the existing `any` values.

### `memory`

| Attribute | Type |
|---|---|
| `projectKey` | string |
| `scope` | string |
| `memType` | string |
| `text` | string |
| `sourceIssue` | string |
| `runId` | string |
| `validUntil` | float |
| `supersededBy` | string |
| `createdAt` | float |

Index: `by-project` (`projectKey`, `createdAt`).

The category column is `memType` (`decision`, `lesson`, `fact`). Callers may pass `type`; the store writes `memType`. Stored `scope` is `project` or `epic`. A global lesson is `scope: project` with `projectKey` `__global__`. Votes, lesson status, confidence, tier, and the validity window travel inside `text` after `[Conductor lesson]`. `validUntil` is not a query condition.

### `event`

| Attribute | Type |
|---|---|
| `runId` | string |
| `seq` | integer |
| `kind` | string |
| `at` | float |
| `stepId` | string |
| `stepIdx` | integer |
| `journalKey` | string |
| `span` | any |
| `detail` | any |

Indexes: `by-run` (`runId`, `seq`), `by-journal` (`journalKey`, `seq`). `seq` is the only range. `at` is a float timestamp and is never a condition.

One stored value is capped at 64 KiB by the store. Queried timestamps are `float` because a Forge integer is signed 32-bit and cannot hold epoch milliseconds.

### Watchdog gate key

`tc-watchdog-gate` is one Forge KVS key, `{activeUntil}`, not an entity. The `fiveMinute` trigger reads it and returns when the window is closed. While a run is active (2 hours from the last mark) a scan runs on the 15-minute tick. That key is part of the freeze: renaming it or scanning on every trigger changes the KVS bill.

## Behaviour that is in

These are code enums. The manifest test does not list them. The same test file snapshots the arrays so adding a value still fails `npm test`.

**Run status.** `planning`, `running`, `blocked`, `done`, `failed`, `awaiting-review`. The watchdog does not fail steps while the run is `awaiting-review`.

**Step status.** `queued`, `waiting`, `running`, `done`, `failed`, `blocked`. `waiting` is a dependency that is not done, or an approval gate. The watchdog queries `queued` and `running` only.

**Effect status.** `pending`, `applying`, `applied`, `retrying`, `failed`. Up to 5 tries. Backoff is 5, 10, 20, 40 seconds, capped at 900. A Jira 429 with `Retry-After` waits that long instead, still capped at 900. Delta-seconds and an HTTP-date both count. A compensation whose `dependsOnKeys` are not yet `applied` is re-pushed without spending a try.

**Effect kinds.** `createIssue`, `comment`, `transition`, `setFields`, `closeIssue`, `recordRemovedComment`, `restoreStatus`, `restoreFields`. `closeIssue` transitions the child to `Done` and adds `conductor-rolled-back`. It does not delete the issue. `recordRemovedComment` deletes a comment; a 404 is applied. `restoreStatus` writes only while the issue is still at `expectedStatusName`. `setFields` PUTs scalar fields and stores the previous values on `result.before`. `restoreFields` writes those values back while the issue still holds what the run wrote.

**Event kinds.** `plan.created`, `step.queued`, `step.started`, `step.succeeded`, `step.failed`, `step.retried`, `watchdog.self-heal`, `effect.written`, `memory.written`, `replan`, `run.forked`, `wave_started`, `lead_decision`, `digest_written`. `replan` is the stall note the watchdog appends when `stallCount` reaches 2. It is not the budget merge.

**Workers.** `research`, `draft-spec`, `check-deps`, `summarize`, `approval`. The first four run on `step-queue`. `approval` is registered so a plan may name it. `startRun` creates its child and leaves the step `waiting`. It does not push `step-queue`. A step deadline is 12 minutes. Attempt 3 fails the step, blocks the run, and posts one deduped Epic comment (`watchdog-blocked`). `CONDUCTOR_DEMO_STUCK_STEP` can hang one step once.

**Skill packs** in `skills/` and in `src/skills/packs.generated.js`: `research`, `draft-spec`, `check-deps`, `summarize` (`procedure: builtin`), `risk-review`, `test-plan` (`procedure: checklist`). On Forge, `skills/` is not in the bundle. The loader uses the generated packs when the directory is missing. A new file is not visible there until `scripts/gen-skill-packs.mjs` is run, and a new pack is not part of M3 or M4.

**Comment batching (PR #62).** Several comments for the same child, returned by one step, become one effect and one Jira POST. The discriminator is `batch:` plus the part names sorted. A single comment keeps its discriminator, so `research-comment` does not move. A payload that would not fit in 64 KiB stays as separate comments. Epic comments are not folded: `plan:lesson-citation`, `wave-report:<wave>`, `memory:epic-comment`, and `watchdog-blocked`.

**Stable discriminators.** `child-issue` on every step's create. `research-comment`, `draft-spec-comment`, `check-deps-comment`. `skill-full-output` for a checklist skill. `transition:<status>` when a worker transitions.

**Lessons.** `plan-split` calls `applyMemoriesToPlan` before it stores steps. Only an accepted lesson with votes ≥ 1 and keyword overlap is injected. The usual change is a leading `check-deps` whose later steps depend on it. A lesson whose text matches `needs a person`, `needs approval`, `human approval`, or `ask a person` appends one `approval` step and points only the named step at it. Recall returns accepted lessons inside 1536 bytes, plus `skillIndex` (`{name, description}` only, outside that budget). Proposed planner lessons are omitted from the tool.

**Lead loop.** Waves are capped at 3. Work steps are capped at 8. Decisions are `spawn`, `stop`, and `ask`. `ask` sets `awaiting-review`. Resume commands on the Epic are `conductor continue`, `conductor stop`, and `conductor spawn: <worker> | <title>`. A comment that contains `[Conductor wave]` is ignored. The trigger passes `allowLeadLlm: false`. Digests are wrapped in the same `<untrusted>` fence as other model input.

**Blast radius.** `previewBlastRadius` is computed from steps the caller already holds. It is not stored. Score 5 or an external transition or field edit sets `gate.insert`. `gate.fits` is false when the plan is already at 8 work steps. The card budget is 20 KiB and exists so a future change cannot paste comment bodies into the panel payload. `planCompensations` describes undo. The caller enqueues those descriptors on `effect-queue`.

**Approval.** `approveGate` reports the gate done through `reportStep`. The output is `{approved: true, actor, note, generator: 'human'}`. A second call is `duplicate: true`. `childIssueUpdated` calls it when the gate's child moves to a status matching `done`, `closed`, `resolved`, `complete`, or `completed`. A non-approval child still gets a bare done. `releaseWaitingSteps` does not release a gate.

**Budget and critical path.** `criticalPathOf` and `scheduleFor` run on steps already loaded. They are not written onto `run.budget`. Default duration is the 12 minute deadline, or `input.durationMs` when that is a positive integer. `summarize` is off the path. A waiting gate stays on it. `plan-split` calls `applyBudgetReplan` once, after lessons and the blast gate, before `createSteps`. One call merges one cheap pair or merges nothing. Reasons: `within-budget`, `merged`, `merged-still-over`, `no-cheap-pair`, `merge-would-not-help`. Eight serial default steps equal `wallClockMs` and are not merged. `commitRunBudget` records an over-cap counter and does not by itself change `run.status`. `runBudgetStop` is what `startRun`, the step worker, and `spawnWave` consult before the next model call or Jira enqueue: a blown wall clock or a counter past its cap sets the run `blocked`, skips that write, and fails pending forward effects (`createIssue`, `comment`, `transition`, `setFields`) so a message already on `effect-queue` does not call Jira. Compensations are not cancelled. The next model call is also refused once `usedModelCalls` has reached `maxModelCalls`. `get-run-status` returns `budget`, `criticalPath`, `eta`, `budgetOutlook`, and `effectMetrics` `{applied, deduped, retried}`.

**Chaos.** Faults are `kill-worker`, `duplicate-effect`, and `jira-429`. The schedule is process memory. The gate opens only for `CONDUCTOR_FAULT_INJECTION=simulation` with `CONDUCTOR_SIMULATION=1`, or `CONDUCTOR_FAULT_INJECTION=development` with `CONDUCTOR_APP_ENV=development`. `production`, `staging`, and `prod` stay closed. `dev-dispatch` accepts `{injectFault}` and does not plan or dispatch when that body is set. `duplicateWrites` counts a Jira mutation that completed twice for one request key. The duplicate-effect path keeps it at 0.

**Replay and fork.** `replay-run` is a dry run: `duplicateWrites` 0, no model call, no write. An applied effect, or a journal event with `detail.phase === 'applied'`, is a skip. Lessons are read with `lessonsAt` at `run.createdAt` and at now. `fork-run` reruns the transitive `dependsOn` dependents of step N. An empty `dependsOn` means the step starts with the run.

## What waits until after Codegeist

These are not on the M3–M6 calendar. They also need a manifest or a behaviour change this freeze forbids.

- **Teamwork Graph routing** (novelty #8). New scopes, and a spike that has not been done.
- **Playbooks learned from a finished run** (novelty #9). `conductor-playbook` is the supervisor skill. It is not a saved DAG.
- **A `lesson` entity.** Lessons stay on `memory`.
- **Deleting an issue**, and the scope that would allow it. Undo closes and labels.
- **Event kinds `blast.previewed` and `run.undone`.** `docs/blast-radius.md` still describes them. `EVENT_KINDS` does not, and nothing appends them. `journalDetail` is unused by the recorder. The 2026-11-25 doc edit should say so, and should not add the kinds.
- **The lead inserting an approval gate.** `plan-split` inserts one from the blast score or from a lesson. The lead's `spawn` path does not. A wave that asks for a person uses `ask` (`awaiting-review`) instead.
- **Per-workerType deadlines, and watchdog backoff with jitter** (optimisation item 3). The deadline stays 12 minutes for every worker. Effect backoff stays the steps above.
- **Panel poll backoff and a hover reason** (optimisation item 1). The 2026-11-28 item is copy for empty, blocked, awaiting-review, and the budget badge.
- **A run-level token cap.** `usedTokens` is recorded. The limit that exists is per-call `max_completion_tokens`.
- **`rovo:agentConnector`.** Not in the manifest.
- **Custom UI for the timeline.** The panel stays UI Kit.
- **Marketplace publishing.** M6 checks the install link.
- **Forge SQL.** The store stays the Custom Entity Store. The spike report is `docs/spikes/WP0-REPORT.md`.
- **Production and staging.** Not a contest environment.

Optimisation items that are already in, and stay in: schema repair with one retry, the 1–8 step cap, cited lesson ids, `Retry-After`, effect counters, and comment batching. The injection scenario stays the check that a ticket cannot add effects. The 2026-11-29 item re-reads the prompts against the allowlist. It does not add an action.

## Open risks

- **Stale design docs.** `docs/DESIGN.md`, `docs/superagent-architecture.md`, and the `blast.previewed` section of `docs/blast-radius.md` describe shapes the code does not store. Treat this file as the list until those edits land. Do not "fix" the code to match the old paragraph.
- **Inside an `any` value.** `budget.chaos`, `budget.effects`, `ledger`, `brief`, `input.durationMs`, and `payload.batchedFrom` are not manifest attributes. The guard does not see a new key there. A new key still grows every row that writes it, and the KVS budgets would move. M3 and M4 do not add one.
- **KVS reads.** The 2026-11-01 free-tier alert is why the watchdog gate exists. This freeze adds no query. The first live traffic is M4 (from 1 December), with `CONDUCTOR_LLM` still off.
- **Skill bundle.** Editing `skills/*.md` without regenerating `src/skills/packs.generated.js` changes tests (they read the directory) and leaves the Forge bundle on the old text.
- **`summarizeQueued`.** Dead attribute. A cleanup that deletes it fails on a site where the manifest was already installed.
