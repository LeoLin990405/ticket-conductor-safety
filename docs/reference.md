# Ticket Conductor — reference

Long-form reference for the pieces the README only summarises: the Forge module inventory, action
inputs, storage layout, effect keys, the flight recorder, environment variables, platform limits,
the demo seed, and the byte budgets the simulation enforces.

Everything here comes from [`manifest.yml`](../manifest.yml), [`src/`](../src), [`tests/`](../tests),
and the design docs in this directory. Where a value is a design decision rather than a shipped
behaviour, the row says so.

## Forge module inventory

[`manifest.yml`](../manifest.yml) declares the app. Counts are module keys, not files.

| Module | Keys | Notes |
|---|---|---|
| `rovo:agent` | `conductor-router`, `conductor-handoff` | Router has seven actions and the `conductor-playbook` skill; handoff has four actions and `conductor-tools` |
| `rovo:skill` | `conductor-playbook`, `conductor-tools` | `source.dir` points at [`prompts/conductor-playbook`](../prompts/conductor-playbook) and [`prompts/conductor-tools`](../prompts/conductor-tools) |
| `rovo:mcp` | `conductor-mcp` | Tools: `plan-split`, `dispatch-run`, `get-run-status`, `recall-memory`. Preview, one per app |
| `action` | `plan-split`, `dispatch-run`, `get-run-status`, `recall-memory`, `record-decision`, `replay-run`, `fork-run` | Same seven keys the Router may call |
| `consumer` | `step-worker` (queue `step-queue`), `effect-applier` (queue `effect-queue`) | Both `timeoutSeconds: 900` |
| `scheduledTrigger` | `watchdog` | `interval: fiveMinute` |
| `trigger` | `child-issue-updated` | Jira issue updated and commented events |
| `jira:issuePanel` | `run-panel` | UI Kit, resolver `panelResolver`, resource `src/frontend/index.jsx` |
| `webtrigger` | `dev-dispatch` | Development only; handler `index.devDispatchWebtrigger` |
| `llm` | `conductor-llm` | Family `claude`. Adding this module is a major version, so an existing install must be approved again |
| `function` | one per handler | Handlers are re-exports from [`src/index.js`](../src/index.js) |
| entities | `run`, `step`, `effect`, `memory`, `event` | Custom Entity Store, under `app.storage.entities` |

App runtime: `nodejs24.x`, 256 MB, `arm64`.

Scopes: `read:jira-work`, `write:jira-work`, `storage:app`, `search:confluence`. There is no
`permissions.external` block and no `delete:issue:jira`.

## Actions

`stepsJson` is one JSON string, because a Forge action input cannot be an array.

| Action | Verb | Inputs | Returns |
|---|---|---|---|
| `plan-split` | CREATE | `epicKey`, `goal`, `stepsJson`, optional `projectKey` | `{ok, runId, status, steps, recalledMemories}`; no Jira writes |
| `dispatch-run` | UPDATE | `runId` | `{ok, runId, status}`; a repeat call does not enqueue again |
| `get-run-status` | GET | `runId` or `epicKey` | `{ok, run, steps}`; `waiting` means a dependency is not done |
| `recall-memory` | GET | `projectKey`, `query` | `{ok, memories, skillIndex}`; memories stay inside 1,536 bytes, `skillIndex` does not count |
| `record-decision` | CREATE | `epicKey`, `text`, `type`, optional `projectKey` | Stores one memory; the input is `type`, the stored attribute is `memType` |
| `replay-run` | GET | `runId` | `{ok, dryRun, duplicateWrites, steps, effects, lessons}`; writes nothing |
| `fork-run` | CREATE | `runId`, `stepIdx`, optional `input` | `{ok, runId, status, forkedFromRunId, copy, rerun}` |

`plan-split` rejects more than eight steps, an unknown `workerType`, a `dependsOn` index that is not
in the plan, and a dependency cycle. A rejected plan stores nothing.

The Router prompt is [`prompts/router.md`](../prompts/router.md); the handoff prompt is
[`prompts/handoff.md`](../prompts/handoff.md). Both are `resource:conductor-prompts` entries, so the
prompt text ships as a Forge resource rather than as code.

## Storage

| Entity | Key | Attributes (role) | Indexes |
|---|---|---|---|
| `run` | `runId` | `epicKey`, `projectKey`, `goal`, `status`, `createdBy`, `createdAt`, `updatedAt`, `summary`, `summarizeQueued`, `forkedFromRunId`, `forkedFromStepIdx`, `forkSeq`, `reviewedThroughWave`, `ledger`, `budget` | `by-epic`, `by-status` |
| `step` | `stepId` | `runId`, `idx`, `title`, `workerType`, `input`, `childIssueKey`, `status`, `attempt`, `deadlineAt`, `createdAt`, `output`, `error`, `dependsOn`, `dependencyContext`, `stallCount`, `skill`, `brief`, `wave` | `by-run`, `by-status-deadline`, `by-status-created`, `by-child-issue` |
| `effect` | `requestKey` | `runId`, `stepId`, `kind`, `payload`, `status`, `tries`, `result`, `appliedAt`, `updatedAt` | `by-status`, `by-run` |
| `memory` | `memId` | `projectKey`, `scope`, `memType`, `text`, `sourceIssue`, `runId`, `validUntil`, `supersededBy`, `createdAt` | `by-project` |
| `event` | `${runId}#${seq}` | `runId`, `seq`, `kind`, `at`, `stepId`, `stepIdx`, `journalKey`, `span`, `detail` | `by-run`, `by-journal` |

Run status values: `planning`, `running`, `blocked`, `done`, `failed`, plus `awaiting-review` once
the lead loop pauses. Step status values: `queued`, `running`, `done`, `failed`, `blocked`,
`waiting`.

Timestamps are epoch milliseconds stored as floats. All identifiers are uuid v4. The entity key is
never written as an attribute: Forge returns a bare 422 for an undeclared attribute.

Key-value storage holds only small records: `lock:run:<runId>` (optimistic lock) and
`idem:dispatch:<epicKey>:<hash(goal)>`.

## Effect keys

The applier is the only Jira writer. The key is

```
requestKey = sha256("<runId>|<stepId>|<kind>|<discriminator>")
```

The attempt number is not in the key, so a retry cannot mint a second child issue. A run-level
comment uses an empty step segment. The implementation is
[`src/effects/requestKey.js`](../src/effects/requestKey.js).

Forward kinds in `EFFECT_KINDS`: `createIssue`, `comment`, `transition`, `setFields`.
Compensating kinds: `closeIssue`, `recordRemovedComment`, `restoreStatus`, `restoreFields`.
Compensations use the discriminator `undo:<forwardKind>:<forwardRequestKey>` and close children
instead of deleting them. `setFields` stores the previous scalar values. `restoreFields` writes
them back when the issue still holds what the run wrote. The design note is
[`blast-radius.md`](blast-radius.md).

Effect status values: `pending`, `applied`, `retrying`, `failed`. A failed effect is retried with
backoff up to five times, then the step is marked `blocked`.

Worker types come from the six skill packs in [`skills/`](../skills): `research`, `draft-spec`,
`check-deps`, `risk-review`, `test-plan`, `summarize`. Each pack carries `tools`, `doneWhen`,
`budget`, and an `outputSchema`. A schema violation gets one repair attempt, then the step is
`blocked`.

## Flight recorder

Every plan, dispatch, retry, effect, and memory write appends an `event` row. Kinds:
`plan.created`, `step.queued`, `step.started`, `step.succeeded`, `step.failed`, `step.retried`,
`watchdog.self-heal`, `effect.written`, `memory.written`, `replan`, `run.forked`, `wave_started`,
`lead_decision`, `digest_written`. `blast.previewed` and `run.undone` are designed in
[`blast-radius.md`](blast-radius.md) and are not in `EVENT_KINDS` yet.

- **Replay** re-runs the read-only workers against today's Jira, classifies every proposed effect
  with `lookupAppliedEffect`, and reports `duplicateWrites: 0`. It does not enqueue.
- **Fork** copies events up to step N onto a new run, marks the prefix `done`, and re-runs only the
  strict downstream steps.
- **Stall re-plan.** The first stuck detection retries and logs `step.retried`; at `stallCount` 2 it
  also logs `replan` with a revised tail. The attempt budget is unchanged.
- **Spans.** `span` stores OpenTelemetry GenAI names (`gen_ai.operation.name`, `gen_ai.request.model`,
  and the rest) inside one `any` field, because a Forge attribute name cannot contain a dot. Replay
  forces the deterministic fallback, so the recorded model is `deterministic-fallback`.

Implementation: [`src/recorder/`](../src/recorder). Design note: [`flight-recorder.md`](flight-recorder.md).

## Environment variables and development flags

| Variable | Where | Effect |
|---|---|---|
| `FORGE_EMAIL`, `FORGE_API_TOKEN` | shell, never committed | `forge lint` and deploys |
| `DEV_WEBTRIGGER_SECRET` | development only, `forge variables set --encrypt` | `dev-dispatch` answers 403 unless `x-dev-secret` matches |
| `CONDUCTOR_DEMO_STUCK_STEP` | development only | Hangs one step on attempt 0 so the watchdog has something to retry |
| `CONDUCTOR_LLM` | development | `off`, `0`, or `fallback` forces the deterministic comment path |
| `CONDUCTOR_FAULT_INJECTION` | simulator or development | `simulation` or `development`. Any other value, including unset, leaves fault injection off |
| `CONDUCTOR_SIMULATION` | simulator only | `1` is required together with `CONDUCTOR_FAULT_INJECTION=simulation`. A Forge install does not set this |
| `CONDUCTOR_APP_ENV` | Forge install | `development` is required together with `CONDUCTOR_FAULT_INJECTION=development`. `production` and `staging` close the gate even if the other variables are set |

`forge variables set -e development --encrypt DEV_WEBTRIGGER_SECRET …` is the documented form.
Setting that variable outside development is forbidden by the repo rules.

The `dev-dispatch` webtrigger accepts `{"runId": "..."}`, `{"plan": {epicKey, goal, stepsJson}}`,
or either shape with `"statusOnly": true`. It also accepts
`{"injectFault": {"type": "kill-worker"|"duplicate-effect"|"jira-429"}}`.
That body arms one in-memory fault and does not plan or dispatch. Optional
fields are `stepId`, `requestKey`, and `retryAfterSeconds` (0–60, default 1,
used as the `Retry-After` header on a 429). The effect retry waits that
long, capped at 900 seconds. A 429 with no header keeps the backoff. The secret check still applies.
The fault is stored only when the simulation or development flag above is
on. A fired fault writes `injected`, `healed`, and `duplicateWrites` onto
`run.budget.chaos` (the existing budget attribute). `get-run-status` returns
that object. A closed gate does not write it. Create the webtrigger with
`forge webtrigger create -e development -s <site> -p jira -f dev-dispatch`.

## Platform limits the design depends on

Copied from [`DESIGN.md`](DESIGN.md) §5, which cites the Atlassian limit pages.

| Item | Limit |
|---|---|
| Regular function / UI resolver | 25 s |
| Web trigger / action / agent connector | 55 s |
| Async event consumer, scheduled trigger | 55 s default, up to 900 s with `timeoutSeconds` |
| Single outbound request in an async event | 180 s |
| Invocation rate | 1,200/min per user; 7,000/min and 300/s per installation |
| KVS / Entity Store value | 240 KiB; key 500 chars; depth 31; 1,000 RPS per installation |
| LLM inference inside a consumer | 5 minutes, and only for a consumer whose timeout is at least that |
| External egress | must be declared; this app declares none |

## Demo seed

[`demo/seed.json`](../demo/seed.json) is the source of truth; [`demo/seed.md`](../demo/seed.md) is
the walkthrough. The seed creates six issues in a company-managed project with key `PAY`:

| Order | Ref | Type | Summary |
|---|---|---|---|
| 1 | `epic-refunds` | Epic | Ship payment refunds |
| 2 | `epic-reconcile` | Epic | Reconcile refund ledger |
| 3 | `story-refund-api` | Story | Define the refund API |
| 4 | `story-ledger-line` | Story | Write the refund ledger line |
| 5 | `bug-duplicate-webhook` | Bug | Duplicate refund webhook creates two ledger lines |
| 6 | `task-capture-dependency` | Task | Confirm dependency on payment capture |

Every issue carries the `conductor-demo` label. The seed creates Jira issues only; it does not
create a run, a step, an effect, or a memory.

## Byte budgets

The simulation bills every KVS get, query page, set, and compare-and-set, with a 1 KiB floor
(`KVS_BYTE_FLOOR` in [`tests/simulation/budget.mjs`](../tests/simulation/budget.mjs)). A scenario
fails on zero usage and on a cap breach; caps are the measured total plus about 15%.

| Value | Cap |
|---|---|
| Blast-radius card | 20 KiB (`BLAST_CARD_BUDGET`), not stored |
| `blast.previewed` journal detail | 2 KiB (`BLAST_JOURNAL_BUDGET`) |
| `effect.result.before` snapshot | 2 KiB (`BEFORE_SNAPSHOT_BUDGET`) |
| Effect payload | 64 KiB (`MAX_VALUE_BYTES`) |
| Recalled memories | 1,536 bytes |
| Wave digest | 1,024 bytes |
| Step output | 64 KiB, larger goes to a Jira comment by reference |
