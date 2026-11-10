# Open-source patterns worth borrowing: Ticket Conductor

_Written 2026-11-01. Star counts, licenses and last push are from the GitHub API on that day. **Rule: under Forge we reuse ideas, not runtimes.** None of these engines can run inside Forge (no long-running processes, 25 s/900 s limits, KVS only). We copy small, permissively licensed snippets only where noted._

## Survey (raw)

| Repo | Stars | License | Last push | Relevance |
|---|---|---|---|---|
| [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | 44k | MIT | 2026-11 | checkpoints per super-step, time travel, `interrupt()` HITL |
| [temporalio/temporal](https://github.com/temporalio/temporal) | 24k | MIT | 2026-11 | event history + deterministic replay, sagas |
| [dbos-inc/dbos-transact-ts](https://github.com/dbos-inc/dbos-transact-ts) | 1.4k | MIT | 2026-10 | durable steps checkpointed in a DB table, idempotency keys, fork workflow from step N |
| [inngest/inngest](https://github.com/inngest/inngest) | 6k | SSPL + DOSP (server) / Apache SDK | 2026-11 | `step.run` memoization over stateless functions (closest to Forge async events) |
| [restatedev/restate](https://github.com/restatedev/restate) | 4.6k | BSL 1.1 | 2026-11 | journaled side effects, awakeables |
| [openai/openai-agents-python](https://github.com/openai/openai-agents-python) | 30k | MIT | 2026-11 | handoffs, guardrails (input/output tripwires), tracing spans |
| [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | 60k | MIT | 2026-11 | hierarchical manager process, task `context` deps |
| [microsoft/autogen](https://github.com/microsoft/autogen) (Magentic-One) | 62k | CC-BY-4.0 docs / MIT code | 2026-10 | **Task Ledger + Progress Ledger** orchestrator, stall counter → re-plan |
| [langfuse/langfuse](https://github.com/langfuse/langfuse) | 37k | MIT core (ee/ separate) | 2026-11 | trace → span → generation model, session replay UI, scores |
| [Arize-ai/phoenix](https://github.com/Arize-ai/phoenix) | 12k | Elastic 2.0 | 2026-10 | OpenInference span kinds; idea only |
| [traceloop/openllmetry](https://github.com/traceloop/openllmetry) | 7.5k | Apache-2.0 | 2026-10 | OTel GenAI semantic conventions (`gen_ai.*` attributes) |
| [AgentOps-AI/agentops](https://github.com/AgentOps-AI/agentops) | 5.9k | MIT | 2026-06 | session "waterfall" replay view |
| [letta-ai/letta](https://github.com/letta-ai/letta) | 25k | Apache-2.0 | 2026-10 | core vs archival memory blocks, self-edited memory |
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | 68k | Apache-2.0 | 2026-10 | extract → ADD/UPDATE/DELETE/NOOP memory consolidation |
| [getzep/graphiti](https://github.com/getzep/graphiti) | 32k | Apache-2.0 | 2026-11 | bi-temporal facts (`valid_at`/`invalid_at`), invalidation instead of delete |
| [noahshinn/reflexion](https://github.com/noahshinn/reflexion) | 3.4k | MIT | 2025-01 | verbal self-reflection after failure, fed into next attempt |
| [LeapLabTHU/ExpeL](https://github.com/LeapLabTHU/ExpeL) | 249 | Apache-2.0 | 2024-12 | **insight pool with ADD/EDIT/UPVOTE/DOWNVOTE ops** from success/failure pairs |
| [MineDojo/Voyager](https://github.com/MineDojo/Voyager) | 7.3k | MIT | 2024-04 | skill library of verified programs, retrieved by description |
| [protectai/llm-guard](https://github.com/protectai/llm-guard) | 3.2k | MIT | archived 2026-07 | scanner pipeline (input/output scanners); idea only, Python/ML models |
| [protectai/rebuff](https://github.com/protectai/rebuff) | 1.5k | Apache-2.0 | archived 2024 | **canary tokens** to detect prompt leakage/hijack |
| NVIDIA NeMo-Guardrails | n/a | Apache-2.0 | active | rails as declarative flows; idea only |
| [sooperset/mcp-atlassian](https://github.com/sooperset/mcp-atlassian) | 6k | MIT | 2026-09 | Jira/Confluence MCP tool naming, read-only mode, tool filtering |
| [atlassian/atlassian-mcp-server](https://github.com/atlassian/atlassian-mcp-server) | 1.1k | Apache-2.0 | 2026-10 | official Rovo MCP: the client path for our "call Conductor from Cursor/Claude" demo |

## Top 8 borrowings (ranked by judging impact × demo)

### 1. Durable-step journal à la DBOS/Inngest/Temporal → WP: Flight Recorder (replay/fork)
**Pattern:** every step's output is checkpointed under `(runId, stepId, attempt)`. Replay re-executes the orchestrator code and *returns memoized results* instead of re-calling side effects. "Fork from step N" (DBOS `forkWorkflow`, LangGraph `update_state` + resume from checkpoint) copies the journal up to N and re-executes after it.
**Forge adaptation:** we already have `effect.requestKey`. Add an `event` entity `(runId, seq)` written in the same CAS as state transitions. Replay = run the planner and workers with `mode=replay`: effects look up the journal by requestKey; a hit means "skip + record same". A diff against the current Jira state is computed per effect. Fork = new runId with `parentRunId` + `forkSeq`; copy events ≤ N; enqueue the downstream DAG nodes only. Each hop is one async-event invocation (≤900 s), so there's no long-running loop.
**Reuse:** idea (DBOS is MIT, but its runtime needs Postgres). Copy the *terminology* (workflow/step/fork) for the video.

### 2. Magentic-One Task Ledger + Progress Ledger → WP: Router/watchdog + planner
**Pattern:** the orchestrator keeps a *Task Ledger* (facts, guesses, plan) and an inner *Progress Ledger* that each turn asks "is the request satisfied? are we looping? who's next?" A stall counter > N triggers **re-planning** with updated facts instead of a blind retry.
**Forge adaptation:** the watchdog (5 min scan) already detects stuck steps. Instead of only retrying, increment `stallCount`. At 2, call the planner with a ledger summary (facts learned, failed steps) to produce a revised sub-DAG, and log a `replan` event (shows in the Flight Recorder). Store the ledger as one KVS value per run (<240 KiB).
**Reuse:** idea (MIT code, but Python). Strong "design" story: self-heal = re-plan, not just retry.

### 3. ExpeL insight pool + mem0 consolidation ops → WP12 lessons as planner rules
**Pattern:** ExpeL compares failed vs successful trajectories and edits a rule list with ops `ADD / EDIT / UPVOTE / DOWNVOTE`; rules with zero votes get pruned. mem0 does the same for memories (`ADD/UPDATE/DELETE/NOOP`) to avoid duplicates.
**Forge adaptation:** on run end (async event), an LLM call gets {run summary, top-k existing lessons} and must return a JSON op list validated against a schema. `lesson` entity gets `votes`, `status (proposed/accepted/rejected)`, `sourceRunIds`. The planner injects only accepted lessons with votes ≥ 1 and must cite lesson IDs (which shows as a badge). Human accept/reject acts as a ±vote.
**Reuse:** idea + prompt structure (Apache-2.0, attribution in NOTICE if we copy prompt text).

### 4. Graphiti bi-temporal facts → WP12 memory recall
**Pattern:** facts carry `valid_at` / `invalid_at`; new contradicting info *invalidates* old facts instead of deleting them, so you can ask "what did we believe at time T".
**Forge adaptation:** lessons and memory items get `validFrom/invalidAt/supersededBy`. Pairs naturally with replay: replaying run #3 uses the lessons valid *at that time*, and the diff shows "lesson L7 since added changes step 2". That is a unique demo beat linking #1 and #3.
**Reuse:** idea.

### 5. LangGraph `interrupt()` / OpenAI Agents SDK guardrail tripwires → WP: approval gates + WP11 injection guard
**Pattern:** a node can raise `interrupt(payload)`. State persists, and a resume command with the human's answer continues. Agents SDK runs input/output guardrails in parallel and a `tripwire_triggered` halts the run.
**Forge adaptation:** an `approval` DAG node puts the run in `awaiting-approval` and stores the payload; the Jira issue transition trigger (`avi:jira:updated:issue`) resumes it. Guardrails = a cheap pre-check stage per worker (regex + small LLM classifier) whose tripwire writes a `guard.blocked` event and comment rather than throwing.
**Reuse:** idea; MIT anyway.

### 6. Rebuff canary tokens + LLM Guard scanner pipeline → WP11 injection guard
**Pattern:** Rebuff inserts a random canary in the system prompt; if it appears in the output, the prompt leaked or was hijacked. LLM Guard chains input scanners (prompt injection, secrets, invisible chars) and output scanners (relevance, URL allowlist).
**Forge adaptation:** per-call canary (`crypto.randomUUID()`), plus an output check that the canary is absent and actions ⊆ allowlist for the step type. TS scanner list: invisible-unicode strip, delimiter spoofing, "ignore previous" heuristics, URL allowlist. All under 25 s. Counters feed the panel ("2 injections blocked").
**Reuse:** idea (both archived; Python ML models can't run in Forge).

### 7. OTel GenAI semantic conventions (OpenLLMetry/Langfuse data model) → Flight Recorder schema
**Pattern:** trace → spans with `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, etc.; Langfuse adds sessions, scores, and a nested waterfall.
**Forge adaptation:** name our event fields after OTel GenAI attributes and offer an **"Export run as OTLP JSON"** button (download from panel) so the run opens in Langfuse/Phoenix/Jaeger. That's credible tech-implementation polish at low effort (pure JSON mapping), and the waterfall layout is the reference for our timeline UI.
**Reuse:** spec (Apache-2.0); no code needed.

### 8. sooperset/mcp-atlassian tool design + Voyager skill library → WP: Conductor as rovo:skill/MCP + playbooks
**Pattern:** mcp-atlassian exposes small verb-named tools, a `READ_ONLY_MODE`, and per-tool enable filters. Voyager stores *verified* successful programs as retrievable skills.
**Forge adaptation:** expose `conductor_plan`, `conductor_dispatch`, `conductor_status`, `conductor_recall` with JSON-schema inputs and a read-only subset (status/recall) safe for any agent. Successful DAGs get saved as "playbooks" retrievable by description (Voyager), callable by name from other agents.
**Reuse:** naming/tool-schema conventions (MIT); the official atlassian-mcp-server is the client path for the Cursor/Claude demo clip.

## Novelty risks (someone already does it) and how to differentiate

| Our claim | Already done by | Differentiate by |
|---|---|---|
| Replay / time travel / fork from step | LangGraph Studio time travel, Temporal replay, DBOS fork, LangSmith/Langfuse traces | **Nobody does it for agent writes to Jira with a live-state diff and effect dedupe** inside the Atlassian UI. Pitch it as "replay against today's Jira" + "what would change", not generic time travel. Cite LangGraph/Temporal as inspiration (judges respect it). |
| Learning lessons from failures | Reflexion, ExpeL, Letta self-editing memory, mem0 | Ours are **human-curated, scoped per project, versioned (bi-temporal), cited in the plan, and replay-aware**. Academic systems are single-user benchmarks without governance. |
| Self-healing watchdog | Temporal retries, Inngest retries, Magentic-One stall re-plan | Show **invariants** (0 duplicate writes under injected faults) + re-plan event in the timeline. |
| Agent callable as tool / MCP | mcp-atlassian, official Atlassian MCP, Agents SDK handoffs | Ours is an **orchestrator-as-a-tool** (returns a durable run handle, not one CRUD call). Demo cross-agent delegation end-to-end. |
| Injection guard | LLM Guard, Rebuff, NeMo Guardrails, Agents SDK guardrails | Don't claim novelty. Claim *tickets as untrusted data* + visible refusals in the timeline. |
| Plan → child issues | Atlassian "Work breakdown", many CG25 entries | Already acknowledged in docs/novelty.md; not a pitch point. |

## License notes
- Safe to copy small snippets/prompts: MIT (LangGraph, Temporal, DBOS, Agents SDK, crewAI, Reflexion, Voyager, mcp-atlassian, AgentOps), Apache-2.0 (Letta, mem0, Graphiti, ExpeL, OpenLLMetry, Rebuff), with attribution in `NOTICE`.
- **Do not copy code** from Inngest server (SSPL), Restate (BSL), Phoenix (Elastic 2.0), Langfuse `ee/`. Ideas only.
- Our repo should state its own license (MIT recommended) before the Devpost submission.

## Suggested next WPs from this doc
1. Event schema with OTel GenAI field names + OTLP export (S): unblocks #1 and #7.
2. Stall counter → re-plan (S–M): #2.
3. Lesson ops `ADD/EDIT/UPVOTE/DOWNVOTE` + validity window (M): #3, #4.
4. Canary + scanner chain in WP11 (S): #6.
