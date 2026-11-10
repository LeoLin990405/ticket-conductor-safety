# Flight recorder, replay, and fork

Ticket Conductor keeps an append-only event log for every run and a step journal keyed like a DBOS checkpoint. Replay answers one question: **replay against today's Jira, with a diff of what would change and zero duplicate writes.** Fork copies that log up to a step onto a new run and re-runs only the downstream steps. Prefix results are looked up. They are not written to Jira again.

This is the Codegeist novelty idea in [docs/novelty.md](novelty.md) ("git for agent runs"), shaped by the patterns in [docs/oss-borrow.md](oss-borrow.md). The engines those projects ship do not run inside Forge. There is no long-lived workflow process, and a function still has to finish inside 25 seconds (resolver) or 900 seconds (consumer). We kept the ideas and stored them in the Custom Entity Store.

## What we borrowed, and what we did not copy

| Idea | From | What Conductor actually does |
|---|---|---|
| Event history and deterministic replay | [Temporal](https://github.com/temporalio/temporal) (MIT) | Each plan, step, retry, effect, and memory write is an `event` row. Replay re-executes the deterministic workers against the current Jira read and returns the journalled effect instead of calling Jira again. |
| Time travel and fork-from-checkpoint | [LangGraph](https://github.com/langchain-ai/langgraph) (MIT) | The issue panel scrubs the log. Fork copies events up to step N onto a new `runId`. |
| Durable steps keyed for idempotency, fork from step N | [DBOS](https://github.com/dbos-inc/dbos-transact-ts) (MIT) | A step result is `sha256(runId\|stepId\|step-result\|attempt)`. A Jira write keeps its existing `requestKey`. A hit means skip. |
| `step.run` memoization over stateless invocations | [Inngest](https://github.com/inngest/inngest) (idea only; server is SSPL) | One queue delivery is one invocation. The journal is the memo table. |
| Stall counter, then re-plan | [Magentic-One](https://github.com/microsoft/autogen) (MIT code) | The watchdog increments `stallCount`. At 2 it logs a `replan` event with a revised tail. It does not call a model. |
| GenAI span names | [OpenTelemetry GenAI semantic conventions](https://github.com/traceloop/openllmetry) (Apache-2.0) | `span` stores `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.request.model`, `gen_ai.conversation.id`. Dots are illegal in a Forge attribute name, so they live inside the `any` field `span`. The panel can export OTLP JSON. |

No source from those repositories is vendored here. `gen_ai.request.model` is the hosted model id when the step output says `generator: "llm"`. Otherwise it is `deterministic-fallback`. Replay forces that fallback (`llm: { disabled: true }`) so a dry-run does not call the model.

## Storage

Entity `event`. The key is `${runId}#${seq}` and is **not** stored as an attribute. Writing `eventId`, or a run's own `runId`, into the value is an undeclared attribute and Forge returns a bare 422.

| Attribute | Type | Role |
|---|---|---|
| `runId` | string | Partition of `by-run`. An attribute, because it is not the key. |
| `seq` | integer | Order. Range of `by-run` and `by-journal`. |
| `kind` | string | `plan.created`, `step.queued`, `step.started`, `step.succeeded`, `step.failed`, `step.retried`, `watchdog.self-heal`, `effect.written`, `memory.written`, `replan`, `run.forked`, `wave_started`, `lead_decision`, `digest_written`. The last three are the SuperAgent lead loop (see [docs/wp14-demo.md](wp14-demo.md)). |
| `at` | float | Epoch milliseconds. Stored for durations. Never a query condition. |
| `journalKey` | string | Effect `requestKey`, or the step-result key. Partition of `by-journal`. |
| `span` | any | OTel GenAI attributes. |
| `detail` | any | Small payload for the panel. One event per fact, not one blob per run. |

`step.stallCount` (integer) is the Magentic-One counter. A fork sets `run.forkedFromRunId`, `run.forkedFromStepIdx`, and `run.forkSeq`. Entity fields are only added. `summarizeQueued` stays, unused, because a deployed attribute cannot be removed.

The dev probe on this app showed that float, integer, and string conditions are all accepted. The event index still ranges on integer `seq` so ordering does not depend on a float.

## Replay

`replay-run` (Rovo, GET) and the panel button call `replayRun`. Downstream of a fork is the real `dependsOn` graph: empty means the step starts with the run, and only steps that depend on N are re-run. Replay calls `lessonsAt` at `run.createdAt` and at now. Lessons whose `validFrom`/`validTo` window contains the run are the ones that held then. Newer accepted lessons are named in the diff, with the plan change they would make. It:

1. Loads the run, steps, effects, and journal.
2. Runs `research`, `draft-spec`, and `check-deps` with `mode: 'replay'`. Those workers only read Jira, through `assumeTrustedRoute` in `src/run/forgeJiraClient.js`.
3. Classifies every proposed effect with `lookupAppliedEffect`. Status `applied`, or a journal event with `phase: 'applied'`, is `already-applied-skipped`.
4. Returns the diff. `duplicateWrites` is 0. `summarize` is not re-executed, because that path writes memory.

## Fork

`fork-run` (Rovo, CREATE) and the panel call `forkRun`.

- No new input: copy events for steps at or before N, mark those steps `done` with the original output and child issue, re-run only strict downstream steps.
- New input: the same, except step N is edited and re-run as well.
- No `dependsOn` edges: downstream means a higher `idx`. Edges on `step.dependsOn` or `step.input.dependsOn` select the DAG instead. `summarize` is not copied; the state machine appends a fresh one.
- `startRun` skips steps that are already `done`, so the prefix does not get a second `createIssue`.

## Stall re-plan

The first time the watchdog finds a step stuck, it retries as before and logs `step.retried` plus `watchdog.self-heal`. The second time, `stallCount` becomes 2 and it also logs `replan` with a revised tail (stalled step plus downstream). The live step input is not mutated, and the attempt budget is unchanged, so a later third miss still blocks the run and posts one Epic comment. The re-plan itself does not write to Jira.

## Demo script (under 5 minutes)

Say this while clicking. It is about 3 minutes of talk plus the clicks.

1. **Open the Epic** (0:00). "This run already finished. The panel on the right is the flight recorder: every plan, step, effect, and watchdog retry, in order."
2. **Scrub** (0:20). Drag the range back to the self-heal lozenge. "The gap is the time the step was stuck. The retry marker is the watchdog. Nothing here is a log file. It is the journal."
3. **Replay** (0:50). Click **Replay dry-run**. "Conductor just re-read Jira. The diff says which step would change today. Every effect that already landed is marked already applied, skipped. The board did not move. Duplicate writes: zero."
4. **Fork** (1:30). Leave the input blank, set the step index to 1, click **Fork**. "The new run is linked to the original. Steps 0 and 1 kept their child issues. Only the downstream step was queued, and only that step created a new issue."
5. **Edit and fork** (2:10). Fork step 1 again with a different input. "Step 1 and everything after it re-ran. The prefix was copied from the journal, not rewritten."
6. **Re-plan** (2:40). Point at a `replan` row if a step stalled twice, or describe the lozenge. "After two stalls, Magentic-One style, Conductor asks for a partial re-plan and writes that into the same log. The workers are still the deterministic fallback. `gen_ai.request.model` on the export says so."
7. **Close** (3:10). "LangGraph, Temporal, and DBOS gave us the shape. The difference is that the side effects are Jira writes, deduped by request key, and the diff is against today's project."

Do not deploy to production for the recording. Development tunnel or the development install is enough.
