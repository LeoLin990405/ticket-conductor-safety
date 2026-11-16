<div align="center">

<img src="docs/assets/banner.svg" alt="Ticket Conductor banner" width="100%">

# Ticket Conductor

**A restricted Rovo supervisor that turns one Jira Epic into a supervised, parallel run.**

Jira as the ledger · one confirm before anything is created · idempotent Jira effects · watchdog retries · replay and fork

[**简体中文**](README.zh-CN.md) · **English**

<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3B82F6?style=flat-square" alt="MIT license"></a>
<a href=".github/workflows/ci.yml"><img src="https://img.shields.io/badge/CI-node%2022.23.4-0EA5E9?style=flat-square" alt="CI on Node 22.23.4"></a>
<a href="manifest.yml"><img src="https://img.shields.io/badge/rovo:agent-2%20agents-8B5CF6?style=flat-square" alt="2 Rovo agents"></a>
<a href="manifest.yml"><img src="https://img.shields.io/badge/rovo:mcp-preview-D97706?style=flat-square" alt="rovo:mcp preview"></a>
<a href="docs/reference.md"><img src="https://img.shields.io/badge/actions-7-22C55E?style=flat-square" alt="7 actions"></a>

</div>

> [!NOTE]
> **Current state.** Development-stage entry for Codegeist 2026. The two agents, seven actions, two
> queue consumers, the watchdog, the Flight Recorder, and the simulation harness are in this
> repository, and nothing here is deployed to production. Live end-to-end runs are development-site
> work only, scheduled in [`docs/milestones.md`](docs/milestones.md).

## 🎯 Project overview & problem

Ticket Conductor is a development-stage Atlassian Forge app for people coordinating work in Jira.
It turns one Epic into a plan of up to eight steps, then supervises queue workers, dependencies,
retries, and result reporting. The problem is not just splitting work: an AI assistant with raw
write tools can create duplicate issues, act on ticket-borne instructions, or keep writing after
approval or resource limits should have stopped it.

This safety entry separates **planning from execution**. The model proposes work through a restricted
action surface; a person reviews the blast-radius preview in the Run panel before the server starts
Jira effects. The goal is a bounded, inspectable workflow, not an autonomous agent with unrestricted
Jira access. The evidence below is offline; it is not a production-safety claim.

**Review guide:** [project overview](#-project-overview--problem) · [safeguards](#-safety) ·
[evidence and examples](#-supporting-evidence) · [limitations and next steps](#-scope-limits--roadmap).

## ✨ Features

- **Restricted Router.** `conductor-router` is a `rovo:agent` whose whole tool list is seven actions; it never writes to Jira itself.
- **Confirm before creation.** `plan-split` stores a run as `planning` and does not return a confirmation token. The Run panel mints a single-use HMAC and starts the run. `dispatch-run` without that token enqueues nothing.
- **One child issue per step.** Each plan step becomes a Jira child issue plus a `step` record in the Custom Entity Store.
- **Workers are consumers, not agents.** `step-worker` runs on `step-queue` with `timeoutSeconds: 900`; `workerType` picks a handler inside that consumer.
- **Idempotent Jira writes.** Every create, comment, and transition is an `effect` keyed by `sha256(runId|stepId|kind|discriminator)`; the attempt number is not in the key.
- **Watchdog.** A `scheduledTrigger` every five minutes requeues a step that missed its deadline or sat queued more than ten minutes, up to three attempts.
- **Flight recorder.** An append-only `event` entity per run backs dry-run replay against today's Jira and fork-from-step-N.
- **Memory that reaches the next plan.** A finished run writes one `[Conductor memory]` comment; recalled memories are injected inside a 1,536-byte budget.
- **Blast-radius preview.** `previewBlastRadius` lists the Jira writes a plan will make, before anything is dispatched.
- **Simulation-tested.** `npm test` runs the suite under `node --test`, including in-memory fakes for KVS, queues, Jira REST, Confluence CQL, and `@forge/llm`, with per-scenario KVS byte budgets. `npm run safety-eval` prints the irreversible-action checks.

## 🧠 Architecture

```mermaid
flowchart LR
    subgraph callers["Callers"]
        U["User on a Jira Epic"]
        H["conductor-handoff (rovo:agent)"]
        M["conductor-mcp (rovo:mcp)"]
    end

    subgraph act["7 actions, same app"]
        A1["plan-split / dispatch-run"]
        A2["get-run-status / recall-memory / record-decision"]
        A3["replay-run / fork-run"]
    end

    subgraph run["Run"]
        Q1[("step-queue")]
        W["step-worker (900 s)"]
        Q2[("effect-queue")]
        E["effect-applier (requestKey dedupe)"]
    end

    subgraph store["Storage"]
        CE[("Custom Entity Store: run / step / effect / memory / event")]
        KV[("KVS: lock and idempotency keys")]
    end

    subgraph side["Jira and model"]
        J["Jira REST: child issue, comment, transition"]
        L["conductor-llm (@forge/llm, claude)"]
        WD["watchdog (fiveMinute)"]
    end

    U --> A1
    H --> A1
    M --> A1
    A1 --> Q1
    A1 --> Q2
    A1 --> CE
    A1 --> KV
    Q1 --> W
    W --> L
    W --> CE
    W --> Q2
    Q2 --> E
    E --> J
    E --> CE
    J -->|"avi:jira:updated:issue"| T["child-issue-updated trigger"]
    T --> CE
    WD --> Q1
    WD --> CE
    CE --> P["run-panel (jira:issuePanel)"]
    A2 --> CE
    A3 --> CE
```

The implementation is split by package under [`src/`](src): `actions/` holds the seven handlers and
the shared action contract, `run/` the state machine, dependency graph, locks, wave digests, and the
Forge Jira client, `store/` the entities and both adapters, `effects/` the queue and applier,
`worker/` the step worker and its `workerType` handlers, `watchdog/` the retry pass, `memory/` the
write-back and lessons, `recorder/` the flight recorder, `blast/` the preview, `skills/` the pack
loader and briefs, and `frontend/` plus `resolvers/` the UI Kit Run panel.

The design rationale is in [`docs/DESIGN.md`](docs/DESIGN.md); the super-agent mapping is in
[`docs/superagent-architecture.md`](docs/superagent-architecture.md).

## 🛡️ Safety

The irreversible actions here are Jira writes the app cannot cleanly erase: issue creation, status
transitions, and scalar field edits. Comments also mutate Jira, but are excluded from the demo's
irreversible-write count because the app can delete its own comments. A created issue remains even
after undo; there is no delete-issue scope.

| Boundary | Implemented safeguard | Code / evidence |
|---|---|---|
| Model → tools | The Router has seven actions, not raw Jira write tools. `plan-split` validates the goal and plan, stores `planning`, and returns no confirmation token. | [`manifest.yml`](manifest.yml), [`src/actions/index.js`](src/actions/index.js), [`src/safety/goal.js`](src/safety/goal.js) |
| Human → execution | The Run panel uses the Forge resolver context account id, not a payload-supplied identity. It mints and consumes a 15-minute, single-use HMAC grant bound to the run's blast-radius card. The panel path shares grant metadata on `run.grants`; tokens and grant rows are omitted from public responses. | [`src/resolvers/index.js`](src/resolvers/index.js), [`src/safety/grants.js`](src/safety/grants.js) |
| Planning → queues | `startRun` checks the grant before a planning run starts; a bare `confirm: true`, forged, expired, cross-run, or replayed grant does not enqueue work. Shared-grant store errors refuse the start. Steps behind an open approval gate defer even their child-issue creation. | [`src/run/stateMachine.js`](src/run/stateMachine.js), [`src/run/approval.js`](src/run/approval.js), [`failure matrix`](docs/failure-matrix.md) |
| Queues → Jira | Deterministic effect keys and a claimed effect row suppress duplicate application. Timed-out or partially applied effects fail closed rather than automatically repeat the write. A budget stop blocks the run and drains pending forward effects; compensating effects remain eligible. | [`src/effects/applier.js`](src/effects/applier.js), [`src/run/budget.js`](src/run/budget.js) |
| Retrieved text → worker | Ticket and page text is fenced as untrusted data, including stripping embedded fence tags. Worker output handling ignores model-supplied effects and filters references to retrieved sources. This limits write authority; it does not prove that all injected text or misleading answers are harmless. | [`src/worker/guard.js`](src/worker/guard.js), [`src/worker/llm.js`](src/worker/llm.js), `FS-INJECT-ISSUE` |
| Review / recovery | Blast-radius preview exposes planned writes. Flight Recorder events and effect results support inspection and replay. Undo closes and labels created children, conditionally restores status, and uses saved scalar before-values for `restoreFields` only when current values still match what the run wrote. | [`blast radius & undo`](docs/blast-radius.md), [`src/effects/jira.js`](src/effects/jira.js), [`flight recorder`](docs/flight-recorder.md) |

These are application-level controls within the Forge app's declared scopes, **not** a separate
per-user Jira permission system or an independent identity check. See the [threat model](docs/threat-model.md)
for actors, trust boundaries, and the limited SAIF mapping; see the limitations below before deploying.

## 🧪 Supporting evidence

Rechecked on **2026-11-16 (CST, America/Chicago)** from main commit
[`882cfeb`](https://github.com/LeoLin990405/ticket-conductor-safety/commit/882cfeb), using
**Node v22.23.3 / npm 10.9.9**. The repository pins **22.23.4**; this local patch-version mismatch
produced an engine warning during install and is not a claim of a pinned-runtime rerun.
No live Jira site, paid LLM, or production credentials were used.

| Command | Observed result |
|---|---|
| `npm ci` | Installed the lockfile; engine and upstream peer-dependency warnings |
| `npm test` | **366 pass, 1 skipped, 0 fail**; in-memory / injected fakes |
| `npm run safety-eval` | **37 pass, 0 fail**, including the 18-row failure matrix |
| `npm run demo:offline` | Scripted baseline: **6 irreversible mock-Jira writes**; guarded: **0**, **6/6 blocked** without a human grant |
| `npm audit` | **0 vulnerabilities reported** for this lockfile at check time; not a security proof |
| `npm run lint` | **Not validated:** exited 1 because the local Secret Service / keytar service was unavailable |

Use the default test environment: the harness injects fake model clients. Setting `CONDUCTOR_LLM=off`
also disables those fakes and causes model-path assertions to fail; it is not required for offline tests.
The [verification record](docs/evidence/readme-verification-2026-11-16.md) includes this failed diagnostic
attempt, the successful rerun, and the skipped-test explanation.

| Evidence | What it demonstrates (and does not) |
|---|---|
| [Offline demo transcript](docs/media/demo-offline.txt) · [terminal rendering](docs/media/demo-offline.svg) · [source](src/safety/naiveAgent.js) | Six fixed intents: create, transition, field edit, injected instruction, duplicate create, malformed fields. The baseline has raw mock access; the guarded path uses actions and validation. This is a deterministic comparison, not a live-model benchmark or measured attack-success rate. |
| [Safety report](docs/evidence/safety-eval.md) · [JSON](docs/evidence/safety-eval.json) · [terminal rendering](docs/media/safety-eval.svg) | Observed grant, dispatch, budget, undo, malformed-input, injection, timeout, and partial-failure checks. SVGs are generated text renderings, not screenshots of a live Jira session. |
| [Failure matrix](docs/failure-matrix.md) · [scenario implementations](src/safety/failures.js) | Expected and observed outcomes for 18 named failure cases, including unauthorized context, expired/replayed approval, shared-store failure, and in-flight duplicate delivery. |
| [Simulation harness](tests/simulation/) · [written scenarios](tests/scenarios/) | Real handlers with fake KVS, queues, Jira, Confluence, and model responses; written live scenarios are not proof that live runs occurred. |
| [Threat model](docs/threat-model.md) · [design](docs/DESIGN.md) · [submission notes](docs/drawerrr-submission.md) | Design rationale and limits. Older runtime/results in submission or milestone notes are historical; the dated verification record above is this README's rerun. |

Reproduce with the offline quick start below. A recorded live demo video is still a roadmap item;
these transcripts and generated renderings are the demo evidence currently available.

## 🚀 Quick start

**Offline, no Forge account.** Node is pinned to 22.23.4 (`.nvmrc`, CI, and `package.json` `engines`).

```sh
git clone https://github.com/LeoLin990405/ticket-conductor-safety.git
cd ticket-conductor-safety
npm ci && npm run safety-eval && npm run demo:offline
npm test
npm audit
```

`docker build -t ticket-conductor-safety .` then `docker run --rm ticket-conductor-safety` runs the same safety eval and offline demo. `.devcontainer/devcontainer.json` uses that Dockerfile.

A live development site also needs Forge CLI 14.2.0 and a Jira Cloud site with Rovo. No Forge SQL and no external egress are used.

```sh
export FORGE_EMAIL='<your Atlassian account email>'
export FORGE_API_TOKEN='<token from id.atlassian.com/manage-profile/security/api-tokens>'
npm run lint     # = forge lint
```

Deploy to the development environment and install on a site:

```sh
forge deploy -e development
forge install -e development --site '<your-site>.atlassian.net' --product jira
forge install --upgrade -e development --site '<your-site>.atlassian.net' --product jira  # after scope changes
forge tunnel                                                                                # local iteration
```

> [!WARNING]
> **Development environment only.** Do not `forge deploy -e production` or install on any other
> site. Several files here are marked "development only" for that reason.

> [!TIP]
> `dev-dispatch` plans or dispatches a run without Rovo chat. It answers 403 unless the request
> carries `x-dev-secret` equal to `DEV_WEBTRIGGER_SECRET`, which is set only in development. Create
> it with `forge webtrigger create -e development -s <site> -p jira -f dev-dispatch`; request bodies
> are in [`docs/reference.md`](docs/reference.md#environment-variables-and-development-flags).

## 🤖 Agent integrations

Two agents are declared in [`manifest.yml`](manifest.yml), and both of them reach Jira only through
the same seven actions.

| Agent | Reaches | Skill | Prompt |
|---|---|---|---|
| `conductor-router` | `plan-split`, `dispatch-run`, `get-run-status`, `recall-memory`, `record-decision`, `replay-run`, `fork-run` | `conductor-playbook` | [prompts/router.md](prompts/router.md) |
| `conductor-handoff` | `plan-split`, `dispatch-run`, `get-run-status`, `recall-memory` | `conductor-tools` | [prompts/handoff.md](prompts/handoff.md) |

| Action | Purpose | Writes Jira? |
|---|---|---|
| `plan-split` | Validate `stepsJson`, store a run as `planning`, return the recalled memories | no |
| `dispatch-run` | Start a stored run; enqueue child-issue effects and ready steps | indirectly, through effects |
| `get-run-status` | Read a run and its steps | no |
| `recall-memory` | Return project memories plus the skill index | no |
| `record-decision` | Store one `decision`, `lesson`, or `fact` | no |
| `replay-run` | Dry-run against today's Jira and diff | no |
| `fork-run` | Copy the log to step N and re-run downstream steps | through effects |

`rovo:mcp` module `conductor-mcp` publishes `plan-split`, `dispatch-run`, `get-run-status`, and
`recall-memory` as MCP tools. It is a Preview module, one per app, and external clients stay
disabled until a site admin enables them. [`demo/mcp-client.mjs`](demo/mcp-client.mjs) prints the
endpoint and the JSON-RPC calls, or runs the same four handlers against the in-memory store;
[`demo/cursor-mcp.json`](demo/cursor-mcp.json) is the matching client config.

## 🗂️ How a run works

| Stage | Behaviour |
|---|---|
| Plan | `plan-split` rejects more than eight steps, an unknown `workerType`, an out-of-range `dependsOn`, and any cycle; a rejected plan stores nothing |
| Dispatch | A valid human grant lets `dispatch-run` move `planning` to `running`; it enqueues child-issue effects except for steps held behind an open approval gate, and pushes ready steps to `step-queue` |
| Steps | `step-worker` is idempotent per `(stepId, attempt)`; a stale attempt exits without side effects |
| Dependencies | A step stays `waiting` until every `dependsOn` index is `done`; the watchdog does not scan `waiting` |
| Effects | `effect-applier` claims a row, applies it, and stores the result; `applied` and `failed` rows never reach Jira again |
| Watchdog | Attempt < 3 requeues with a new 12-minute deadline; at attempt 3 the step is `failed`, the run `blocked`, and one Epic comment is enqueued |
| Waves | After wave 1 finishes the lead may spawn a later wave, stop, or pause in `awaiting-review`; caps are 3 waves and 8 steps |
| Memory | The `summarize` step produces one `[Conductor memory]` Epic comment and `memory` rows that the next plan recalls |

Effect and step status values, entity attributes, and the compensating kinds are tabulated in
[`docs/reference.md`](docs/reference.md).

## 📁 Repository layout

| Path | Contents |
|---|---|
| `manifest.yml` | All Forge modules: agents, skills, MCP, actions, consumers, triggers, panel, webtrigger, LLM module, entities, scopes |
| `src/actions/` | The seven action handlers, the shared contract, and plan graph validation |
| `src/run/` | Run state machine, dependency graph, locks, wave digests, Forge Jira client |
| `src/store/` | Entity types, store core, Forge adapter, in-memory adapter, generated entity schema |
| `src/effects/` | Effect queue, request keys, applier, Jira payloads, error types |
| `src/worker/` | Step worker, `workerType` handlers, ADF comments, LLM adapter, prompts, guard |
| `src/watchdog/` | Five-minute retry pass, gate, demo hang flag |
| `src/memory/` | Write-back, lessons, scoring, the `[Conductor memory]` comment |
| `src/recorder/` | Event log, journal, replay, fork, re-plan, OTel span fields, timeline |
| `src/skills/`, `skills/` | Skill pack loader, briefs, schema validation, plus the six Markdown packs |
| `src/frontend/`, `src/resolvers/` | UI Kit Run panel and its resolver |
| `src/dev/` | Development-only dispatch webtrigger and a KVS probe |
| `prompts/` | Router and handoff prompts plus the two `rovo:skill` sources |
| `tests/` | `e2e/`, written scenarios, adversarial cases, and the simulation harness with byte budgets |
| `demo/` | Seeded Payments issues, the MCP client demo, and a Cursor config |
| `docs/` | Design, work packages, spikes, milestones, novelty, flight recorder, blast radius, Devpost and video drafts |
| `spikes/` | A separate throwaway Forge app from the week-1 spikes, never merged into the root manifest |

## 🛠️ Development

```sh
npm ci
npm test                    # = node --test
npm run test:simulation     # node --test --test-reporter=spec tests/simulation/*.test.mjs
npm run lint                # forge lint; needs FORGE_EMAIL and FORGE_API_TOKEN
```

- **Simulation harness.** [`tests/simulation/`](tests/simulation) fakes KVS (with read and write byte counters), both queues, Jira REST, Confluence CQL, `@forge/llm`, and the watchdog clock, then drives the real handlers.
- **Byte budgets.** A scenario fails on zero KVS usage or on a cap breach; caps are the measured total plus about 15% in [`tests/simulation/budget.mjs`](tests/simulation/budget.mjs).
- **CI.** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on push and pull request with Node 22.23.4: unit and module tests, simulation scenarios, safety eval, offline demo, then conditional `forge lint`.
- **Lint needs a token.** The CI lint step exits 0 with a message when `FORGE_API_TOKEN` is not configured, so a green run does not always mean the manifest was linted.
- **Recorded result.** Current offline results and the skipped case are in the [dated verification record](docs/evidence/readme-verification-2026-11-16.md); [`docs/milestones.md`](docs/milestones.md) retains historical results.
- **Model off by default.** With `CONDUCTOR_LLM=off` the workers write deterministic comments and store `generator: "fallback"`; `npm test` mocks `chat` and `list` and never calls the SDK.

## 🧭 Scope, limits & roadmap

This is a hackathon project, not a product. The boundaries below are the ones the design and the
tests actually enforce.

- **Not production-validated.** Offline REST and storage fakes cannot establish live Jira workflow,
  Forge authorization, cross-instance concurrency, or real-model behavior. Live adversarial and
  end-to-end runs remain pending; local Forge lint was not completed in this review.
- **Approval is not full identity or permission verification.** The resolver account id is the human
  boundary; there is no second factor or proof that the goal author is the approver. Jira writes use
  app authority (`asApp`), not a per-user permission check. Shared grants need a consistent server-side
  `CONDUCTOR_CONFIRM_SECRET` across instances; the unset fallback is a process-local random key.
- **Stopping is not cancellation.** A timeout fails the effect row but does not cancel an in-flight
  HTTP request; Jira may still accept it. Budget stops drain pending forward effects, not already
  applied work. Partial outcomes need reconciliation rather than blind retries.
- **Undo is compensation, not a transaction.** Created issues, memory rows, and recorder events remain.
  Scalar and status restoration can be skipped after another edit; a partial close can leave the
  issue transitioned without the rollback label.
- **Recorder and injection limits.** Recorder writes are best-effort and can leave gaps; the effect row is the
  write-outcome source of truth. The event log is not a cryptographically tamper-proof audit trail. Fences and output filtering reduce model write authority, but do not
  guarantee answer accuracy, injection immunity, or general data-exfiltration protection.

| Area | Boundary |
|---|---|
| Hosting | Forge app for Jira Cloud; there is no shell and no code sandbox, so the effects queue plus dry-run is the only staging surface |
| Runtime budget | 25 s for a function or resolver, 55 s for an action or webtrigger, 900 s for an async consumer |
| Storage | Custom Entity Store plus KVS; one KVS value is capped at 240 KiB, so one event row is one fact |
| Model | `@forge/llm` with family `claude` only, inference capped at 5 minutes; calls are billed to the app developer and there is no free quota |
| External egress | None declared; URL fetches are outside the agent's tool list |
| Agents | Forge has no agent-to-agent call, so workers are queue consumers and are not presented as agents |
| `rovo:mcp` | Preview, one module per app; external clients are disabled until a site admin enables them |
| Live evidence | Several scenarios in [`tests/scenarios/`](tests/scenarios) say "not yet run live"; the repo does not claim otherwise |
| Distribution | No Marketplace publish, no production deploy, no install link |

Roadmap, taken from [`docs/milestones.md`](docs/milestones.md) and [`docs/novelty.md`](docs/novelty.md):

- [ ] Run the five adversarial tries in [`tests/scenarios/06-adversarial-tries.md`](tests/scenarios/06-adversarial-tries.md) against a live Router
- [ ] Enable `rovo:mcp` for one external client and confirm `tools/list`
- [ ] Finish the live end-to-end pass on the demo site (M4)
- [x] Support approval DAG nodes, score-threshold gate insertion when the plan has room, and deferred gated child creation
- [ ] Validate gate thresholds and approval behavior on a live development site
- [x] Record prior scalar values on `setFields` and restore them with `restoreFields` (a transition already stores `before.statusName`)
- [ ] Record the demo video and finish the Devpost copy (M5, M6)

## 🤝 Contributing

Work package interfaces are documented in [`docs/TASKS.md`](docs/TASKS.md).

1. Interface changes should update `docs/TASKS.md` in the same PR.
2. Before opening a PR, run `npm ci && npm test && npm run lint` and paste the output.
3. Never commit tokens, `.env`, API keys, site credentials, or `forge variables` values.

If the project is useful to you, a ⭐ helps others find it.

## 📄 License & attribution

Released under the MIT License. See [`LICENSE`](LICENSE). `package.json` keeps `"private": true` as an npm publish guard.

Design ideas were drawn from published work — LangGraph, Temporal, DBOS, Inngest, Magentic-One,
OpenTelemetry GenAI semantic conventions, mem0, Graphiti, ExpeL, and others — and are credited per
pattern in [`docs/flight-recorder.md`](docs/flight-recorder.md) and
[`docs/oss-borrow.md`](docs/oss-borrow.md). Both notes state the rule the repository follows: reuse
ideas, not runtimes. `docs/oss-borrow.md` also marks which upstream licenses are safe to borrow from
and which are ideas only.
