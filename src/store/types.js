/**
 * Shared data-model types and constants for the Ticket Conductor store (WP1).
 *
 * Storage choice
 * --------------
 * Production uses the Forge Custom Entity Store (not Forge SQL), with one
 * entity per logical record: `run`, `step`, `effect`, and `memory`. The
 * matching manifest snippet lives in `entities.manifest.yml`.
 *
 * Conventions shared with docs/TASKS.md and docs/DESIGN.md:
 * - All timestamps are epoch milliseconds (`Date.now()`).
 * - IDs are UUID v4 strings.
 * - Queried timestamps are Forge entity `float` attributes because a Forge
 *   entity `integer` is a signed 32-bit value and cannot hold epoch ms.
 * - Memory's category attribute is named `memType`. The JavaScript API also
 *   exposes it as `memType`; `addMemory` additionally accepts the legacy
 *   input alias `type` for callers that use the WP6 shape.
 * - Any single stored value is capped at 64 KiB by this module even though
 *   the platform allows 240 KiB per entity value.
 *
 * The entity key (not an attribute) holds the record id: `runId` for runs,
 * `stepId` for steps, `requestKey` for effects, and `memId` for memories.
 * Adapters add that key back to the record when reading, so every returned
 * object has its id field populated.
 *
 * @module store/types
 */

/**
 * Maximum size, in UTF-8 bytes, of one stored value (64 KiB).
 * A string is measured directly; an object or array is measured by its JSON
 * representation. Values above this limit are rejected by the store.
 *
 * @constant {number}
 */
export const MAX_VALUE_BYTES = 64 * 1024;

/** Human-readable form of {@link MAX_VALUE_BYTES}. @constant {string} */
export const MAX_VALUE_LABEL = '64 KiB';

/**
 * How long a queued step may wait before `findStuckSteps` treats it as stuck.
 * @constant {number}
 */
export const STUCK_QUEUED_MS = 10 * 60 * 1000;

/** @constant {ReadonlyArray<RunStatus>} */
export const RUN_STATUSES = Object.freeze([
  'planning',
  'running',
  'blocked',
  'done',
  'failed',
  // The lead paused after a wave and is waiting for a person.
  // The watchdog does not fail steps while a run is in this status.
  'awaiting-review',
]);

/** @constant {ReadonlyArray<StepStatus>} */
export const STEP_STATUSES = Object.freeze([
  'queued',
  'waiting',
  'running',
  'done',
  'failed',
  'blocked',
]);

/** @constant {ReadonlyArray<EffectStatus>} */
export const EFFECT_STATUSES = Object.freeze([
  'pending',
  'applying',
  'applied',
  'retrying',
  'failed',
]);

/**
 * Jira mutations the effect queue will apply.
 *
 * The last three are compensations (novelty #4). They use the same request
 * key and the same `effect-queue`. `closeIssue` transitions a child to Done
 * and labels it. It never deletes the issue, so the manifest does not need
 * a delete-issue scope. `recordRemovedComment` deletes a comment; the effect
 * row is the record that the comment was removed. `restoreStatus` transitions
 * an issue this run did not create back to the status stored on the forward
 * effect. `setFields` writes named scalar fields and stores the previous
 * values on `result.before`. `restoreFields` writes those values back when
 * the issue still holds what this run wrote.
 *
 * @constant {ReadonlyArray<EffectKind>}
 */
export const EFFECT_KINDS = Object.freeze([
  'createIssue',
  'comment',
  'transition',
  'setFields',
  'closeIssue',
  'recordRemovedComment',
  'restoreStatus',
  'restoreFields',
]);

/**
 * Append-only flight-recorder kinds. One row per thing that happened.
 * `replan` is the Magentic-One stall response: after two stalls the watchdog
 * asks for a partial re-plan and writes this event instead of only retrying.
 *
 * @constant {ReadonlyArray<EventKind>}
 */
export const EVENT_KINDS = Object.freeze([
  'plan.created',
  'step.queued',
  'step.started',
  'step.succeeded',
  'step.failed',
  'step.retried',
  'watchdog.self-heal',
  'effect.written',
  'memory.written',
  'replan',
  'run.forked',
  // SuperAgent lead loop. Names are the ones the timeline renders.
  'wave_started',
  'lead_decision',
  'digest_written',
]);

/** @constant {ReadonlyArray<MemoryType>} */
export const MEMORY_TYPES = Object.freeze(['decision', 'lesson', 'fact']);

/** @constant {ReadonlyArray<MemoryScope>} */
export const MEMORY_SCOPES = Object.freeze(['project', 'epic']);

/**
 * Run lifecycle: `planning -> running -> done`, with `blocked`/`failed` as
 * terminal error states.
 *
 * @typedef {'planning'|'running'|'blocked'|'done'|'failed'|'awaiting-review'} RunStatus
 */

/**
 * Step lifecycle. `queued -> running -> done`, with `failed`/`blocked` for
 * terminal errors. `waiting` means the step is held until every `dependsOn`
 * step is `done`. An `approval` gate is also stored as `waiting` until
 * `approveGate` reports it `done`, even when its own `dependsOn` is empty.
 * The watchdog does not scan `waiting` (it only queries `queued` and
 * `running`) and it does not retry a gate that was left `queued` or
 * `running`. The watchdog may retry a running step up to 3 attempts.
 *
 * @typedef {'queued'|'waiting'|'running'|'done'|'failed'|'blocked'} StepStatus
 */

/**
 * Effect lifecycle. `pending` and `retrying` are eligible for the watchdog;
 * `applied` and `failed` are terminal.
 *
 * `applying` is the compare-and-set claim the effect applier takes before it
 * calls Jira. A second invocation that still sees `pending` loses the race.
 *
 * @typedef {'pending'|'applying'|'applied'|'retrying'|'failed'} EffectStatus
 */

/**
 * A Jira mutation performed exactly once per deterministic request key.
 *
 * @typedef {'createIssue'|'comment'|'transition'|'setFields'|'closeIssue'|'recordRemovedComment'|'restoreStatus'|'restoreFields'} EffectKind
 */

/**
 * Memory category. Stored in the `memType` attribute.
 *
 * @typedef {'decision'|'lesson'|'fact'} MemoryType
 */

/**
 * Memory visibility. `project` memories are recalled across Epics in the
 * project; `epic` memories belong to one Epic.
 *
 * @typedef {'project'|'epic'} MemoryScope
 */

/**
 * A Ticket Conductor run. `runId` is the entity key, not a stored attribute.
 *
 * @typedef {object} Run
 * @property {string} runId UUID v4.
 * @property {string} epicKey Jira Epic issue key the run belongs to.
 * @property {string} projectKey Jira project key used for memory and issue creation.
 * @property {string} goal Natural-language goal supplied by the user.
 * @property {RunStatus} status Run status.
 * @property {string} createdBy Atlassian account id of the user who asked for the run.
 * @property {number} createdAt Epoch ms.
 * @property {number} updatedAt Epoch ms; used for optimistic updates.
 * @property {any} [summary] Structured or textual summary produced on completion.
 * @property {string} [forkedFromRunId] Original run when this run is a fork.
 * @property {number} [forkedFromStepIdx] Step the fork was taken from.
 * @property {number} [forkSeq] Last copied event seq from the original run.
 * @property {number} [reviewedThroughWave] Highest wave the lead has already
 *   decided. Integer, so the lead can compare-and-swap on it. `0` until the
 *   first wave is reviewed. Do not remove this attribute once it is deployed.
 * @property {object} [ledger] Wave digests and the last lead decision. One
 *   `any` value. Digests are about 1 KB each.
 * @property {object} [budget] Run caps and measured usage (novelty #6).
 *   One `any` value: `maxSteps`, `maxModelCalls`, `wallClockMs`, `usedSteps`,
 *   `usedModelCalls`, `usedTokens`, `elapsedMs`, `startedAt`. Do not remove
 *   this attribute once it is deployed. The critical path and the ETA are
 *   computed on read (`src/run/criticalPath.js`). They are not stored here.
 *   Novelty #7 adds an optional `chaos` object on this same value
 *   (`injected`, `healed`, `duplicateWrites`). It is omitted until a fault
 *   fires, and only while the fault gate is open. An optional `effects`
 *   object (`deduped` only) is the flushed duplicate-drop tally. It is
 *   omitted until that number piggybacks on a budget write. `applied` and
 *   `retried` are not stored.
 */

/**
 * Input for {@link Store.createRun}.
 *
 * @typedef {object} CreateRunInput
 * @property {string} epicKey Jira Epic issue key.
 * @property {string} projectKey Jira project key.
 * @property {string} goal What the run should accomplish.
 * @property {string} createdBy Atlassian account id of the requesting user.
 * @property {string} [forkedFromRunId] Set when the run is a fork of another run.
 * @property {number} [forkedFromStepIdx] Zero-based step the fork starts from.
 * @property {number} [forkSeq] Highest original event seq copied into the fork.
 */

/**
 * A plan step backed by one Jira child issue. `stepId` is the entity key.
 *
 * @typedef {object} Step
 * @property {string} stepId UUID v4.
 * @property {string} runId Owning run.
 * @property {number} idx Zero-based position in the plan.
 * @property {string} title Human-readable step title.
 * @property {string} workerType Registered worker type, e.g. `research`.
 * @property {number[]} [dependsOn] Indexes of steps that must be `done` first.
 *   Missing or `[]` means the step can start with the run.
 * @property {any} [dependencyContext] Outputs of `dependsOn` steps, written
 *   when this step is released. Workers read it from the step object.
 * @property {string} [skill] Skill pack name. Omitted when the step has no pack.
 *   Not the entity key. `stepId` stays the key and is never stored as an attribute.
 * @property {object} [brief] Sub-agent brief (WP15). One `any` attribute.
 * @property {any} [input] Worker input supplied by the Router plan.
 * @property {string} [childIssueKey] Jira child issue created for this step.
 * @property {StepStatus} status Step status.
 * @property {number} attempt Current attempt number, starting at 0.
 * @property {number} [deadlineAt] Epoch ms by which a running step must finish.
 * @property {number} createdAt Epoch ms when the step was queued.
 * @property {any} [output] Worker output (capped at 64 KiB by the store).
 * @property {any} [error] Serialized error (capped at 64 KiB by the store).
 * @property {number} [stallCount] How many times the watchdog has found this step stuck.
 * @property {number} [wave] 1-based wave. Plan-split steps are wave 1. The lead
 *   writes 2 and 3. Missing means wave 1. Do not remove this attribute.
 */

/**
 * Input item for {@link Store.createSteps}.
 *
 * @typedef {object} StepDraft
 * @property {string} title Human-readable step title.
 * @property {string} workerType Registered worker type.
 * @property {number[]} [dependsOn] Indexes of earlier steps this one waits on.
 * @property {number} [wave] Wave number. Omitted in a draft means wave 1.
 * @property {string} [skill] Skill pack name, when the plan resolved one.
 * @property {object} [brief] Sub-agent brief. See {@link Step}.
 * @property {any} [input] Worker input.
 */

/**
 * An idempotent Jira mutation. `requestKey` is the entity key.
 *
 * @typedef {object} Effect
 * @property {string} requestKey Deterministic sha256 key from WP2.
 * @property {string} [runId] Owning run, if any.
 * @property {string} [stepId] Owning step, if any.
 * @property {EffectKind} kind Jira mutation kind.
 * @property {any} payload Kind-specific payload (capped at 64 KiB by the store).
 * @property {EffectStatus} status Effect status.
 * @property {number} tries Number of attempts made so far.
 * @property {any} [result] Jira result such as `{issueKey}`, `{commentId}`, or
 *   `{transitionId, before, after}`. Compensations read `before` from here.
 *   There is no separate attribute for the snapshot.
 * @property {number} [appliedAt] Epoch ms when the effect was applied.
 * @property {number} updatedAt Epoch ms; used by status index queries.
 */

/**
 * Effect input for {@link Store.putEffectIfAbsent}. Only `requestKey`,
 * `kind`, and `runId` are required; the store fills safe defaults for
 * `status` (`pending`), `tries` (0), and `updatedAt` (now).
 *
 * @typedef {object} EffectInput
 * @property {string} requestKey Deterministic idempotency key.
 * @property {string} [runId] Owning run.
 * @property {string} [stepId] Owning step.
 * @property {EffectKind} kind Jira mutation kind.
 * @property {any} payload Kind-specific payload.
 * @property {EffectStatus} [status] Initial status, defaults to `pending`.
 * @property {number} [tries] Initial attempt count, defaults to 0.
 * @property {any} [result] Result when seeding an already-applied effect.
 * @property {number} [appliedAt] Apply timestamp when seeding an applied effect.
 */

/**
 * Result of {@link Store.putEffectIfAbsent}.
 *
 * @typedef {object} PutEffectResult
 * @property {Effect} effect The stored effect (existing or newly created).
 * @property {boolean} created True only when this call inserted a new record.
 */

/**
 * A recalled decision/lesson/fact. `memId` is the entity key.
 * The storage attribute for `memType` is also named `memType`.
 *
 * @typedef {object} Memory
 * @property {string} memId UUID v4.
 * @property {string} projectKey Jira project key.
 * @property {MemoryScope} scope Visibility scope.
 * @property {MemoryType} memType Memory category (storage attribute `memType`).
 * @property {string} text Memory text.
 * @property {string} [sourceIssue] Jira issue the memory came from.
 * @property {string} [runId] Run that produced the memory.
 * @property {number} validUntil Epoch ms, or 0 for no expiry.
 * @property {string} [supersededBy] memId that replaced this memory.
 * @property {number} createdAt Epoch ms.
 */

/**
 * Input for {@link Store.addMemory}. The store generates `memId`, `createdAt`,
 * and `validUntil` when they are omitted.
 *
 * @typedef {object} MemoryInput
 * @property {string} [memId] Optional caller-supplied id.
 * @property {string} projectKey Jira project key.
 * @property {MemoryScope} [scope] Defaults to `project`.
 * @property {MemoryType} [memType] Canonical category field.
 * @property {MemoryType} [type] Legacy input alias for `memType`.
 * @property {string} text Memory text.
 * @property {string} [sourceIssue] Jira issue the memory came from.
 * @property {string} [runId] Run that produced the memory.
 * @property {number} [validUntil] Epoch ms, or 0 for no expiry. Defaults to 0.
 * @property {string} [supersededBy] memId that replaced this memory.
 * @property {number} [createdAt] Optional caller-supplied creation time.
 */

/**
 * Options accepted by list queries.
 *
 * @typedef {object} ListOptions
 * @property {number} [limit] Maximum number of records to return.
 */

/**
 * Options for {@link Store.updateRun}. The optimistic check compares the
 * current stored `updatedAt` with `expectedUpdatedAt`.
 *
 * @typedef {object} UpdateRunOptions
 * @property {number} [expectedUpdatedAt] Last `updatedAt` the caller has seen.
 *   This is a float. Prefer the integer or string options below for new claims.
 * @property {number} [expectedReviewedWave] Compare-and-swap on the integer
 *   `reviewedThroughWave`. A mismatch returns null. Do not combine with
 *   `expectedUpdatedAt` (float conditions have been rejected by Forge).
 * @property {RunStatus} [expectedStatus] Compare-and-swap on the string
 *   `status`. A mismatch returns null.
 */

/**
 * Constructor options shared by the memory and Forge stores.
 *
 * @typedef {object} StoreOptions
 * @property {() => number} [now] Clock returning epoch ms; injectable for tests.
 * @property {() => string} [newId] Id generator; injectable for tests.
 */

/**
 * The complete WP1 store interface. Both `createMemoryStore()` and
 * `createForgeStore()` return an object with these methods.
 *
 * @typedef {object} Store
 * @property {(input: CreateRunInput) => Promise<Run>} createRun
 * @property {(runId: string) => Promise<Run|null>} getRun
 * @property {(epicKey: string, options?: ListOptions) => Promise<Run[]>} listRunsByEpic
 * @property {(runId: string, patch: Partial<Run>, options?: UpdateRunOptions) => Promise<Run>} updateRun
 * @property {(runId: string, steps: StepDraft[]) => Promise<Step[]>} createSteps
 * @property {(stepId: string) => Promise<Step|null>} getStep
 * @property {(runId: string) => Promise<Step[]>} listSteps
 * @property {(stepId: string, patch: Partial<Step>, options?: {expectedStatus?: StepStatus}) => Promise<Step|null>} updateStep
 * @property {(nowMs?: number) => Promise<Step[]>} findStuckSteps
 * @property {(effect: EffectInput) => Promise<PutEffectResult>} putEffectIfAbsent
 * @property {(requestKey: string) => Promise<Effect|null>} getEffect
 * @property {(requestKey: string, patch: Partial<Effect>, options?: {expectedStatus?: EffectStatus}) => Promise<Effect>} updateEffect
 * @property {(status: EffectStatus, options?: ListOptions) => Promise<Effect[]>} listEffectsByStatus
 * @property {(runId: string, options?: ListOptions) => Promise<Effect[]>} listEffectsByRun
 * @property {(issueKey: string) => Promise<Step|null>} getStepByChildIssueKey
 * @property {(input: MemoryInput) => Promise<Memory>} addMemory
 * @property {(projectKey: string, options?: ListOptions) => Promise<Memory[]>} listMemoriesByProject
 * @property {(memId: string, byMemId: string) => Promise<Memory>} supersedeMemory
 * @property {(input: EventInput) => Promise<FlightEvent>} appendEvent
 * @property {(runId: string, options?: ListOptions) => Promise<FlightEvent[]>} listEventsByRun
 * @property {(journalKey: string, options?: ListOptions) => Promise<FlightEvent[]>} listEventsByJournalKey
 */

/**
 * Flight-recorder event kind. The string is also the timeline label key.
 *
 * @typedef {'plan.created'|'step.queued'|'step.started'|'step.succeeded'|'step.failed'|'step.retried'|'watchdog.self-heal'|'effect.written'|'memory.written'|'replan'|'run.forked'|'wave_started'|'lead_decision'|'digest_written'} EventKind
 */

/**
 * One append-only flight-recorder row. `eventId` is the entity key, never an
 * attribute. `journalKey` is the DBOS-style checkpoint id: an effect
 * `requestKey`, or the step-result key from `stepResultKey`. Replay and fork
 * look that key up and skip the Jira write.
 *
 * `span` holds OpenTelemetry GenAI semantic-convention attributes
 * (`gen_ai.operation.name`, and so on). Those names contain dots, which Forge
 * attribute names cannot, so they live inside the `any` value `span`.
 *
 * `at` is an epoch-ms float. It is stored and never used as a query condition.
 * Ordering uses the integer `seq` (the `by-run` range).
 *
 * @typedef {object} FlightEvent
 * @property {string} eventId Entity key. Not stored as an attribute.
 * @property {string} runId Owning run. An attribute, because the key is eventId.
 * @property {number} seq Monotonic integer per run. Index range. Not a float.
 * @property {EventKind} kind What happened.
 * @property {number} at Epoch ms. Stored as float. Not a query condition.
 * @property {string} [stepId] Step this event is about. An attribute, not the key.
 * @property {number} [stepIdx] Zero-based step index.
 * @property {string} [journalKey] requestKey (or step-result key) for lookup.
 * @property {Record<string, unknown>} [span] OTel GenAI attributes.
 * @property {any} [detail] Small JSON payload for the panel. Not a second log.
 */

/**
 * Input for {@link Store.appendEvent}. `seq` is assigned by the store.
 *
 * @typedef {object} EventInput
 * @property {string} runId Owning run.
 * @property {EventKind} kind Event kind.
 * @property {number} [at] Epoch ms. Defaults to the store clock.
 * @property {string} [stepId] Related step.
 * @property {number} [stepIdx] Zero-based step index.
 * @property {string} [journalKey] Checkpoint key. Effect requestKey or step-result key.
 * @property {Record<string, unknown>} [span] OTel GenAI attributes.
 * @property {any} [detail] Small JSON payload.
 */
