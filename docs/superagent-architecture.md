# Super-agent architecture for Ticket Conductor

_Written 2026-11-01. Request: move the agent toward a "SuperAgent" harness design. This doc maps published super-agent designs onto Conductor, says where an analogy is weak, checks each against Forge limits and the timeline (feature freeze ~2026-12-08, deadline 2026-12-22 15:00 ET), and proposes 3 work packages._

## TL;DR

Conductor already has the super-agent skeleton: a restricted **lead agent** (Router), **sub-agents** (step workers, one per Jira child issue), **memory**, and **self-healing** (watchdog plus idempotent effects). What it is missing compared with DeerFlow 2.0, Anthropic's research system and Manus:

1. **Skills as data.** Worker types are hard-coded handlers. They should be on-demand skill packs.
2. **Scoped context briefs and compression.** Sub-agents should get a minimal brief and return a compact, structured result. Long runs should be summarized into an external working memory (the Jira issues themselves).
3. **A lead loop that re-plans.** Today the flow is plan → fan-out → summarize. The lead agent should read results after each wave, then spawn more sub-agents, stop, or hand off.
4. **Two memory tiers** (global/project plus run), like TRAE 宝 (TRAE Bao).

## Sources (primary)

- [D1] ByteDance DeerFlow 2.0 README: "super agent harness", a lead agent spawning sub-agents "each with its own scoped context, tools, and termination conditions", progressive skill loading, sandbox, long-term memory. https://github.com/bytedance/deer-flow/ · release notes https://github.com/bytedance/deer-flow/releases/tag/v2.0.0
- [D2] DeerFlow backend README: sub-agents are called through a `task()` tool and run in the background with status tracking, max 3 per turn, 15-min timeout. Memory uses confidence-scored facts, scope-safe writes and fail-closed reads. SKILL.md discovery plus SkillScan. https://github.com/bytedance/deer-flow/blob/main/backend/README.md
- [D3] DeerFlow design principles: middleware chain around every LLM turn, skills loaded on demand "without contamination", summarization of old turns, scoped sub-agent context, external working memory on disk, memory injected at a token budget. https://deerflow.tech/en/docs/harness/design-principles
- [T1] TRAE 宝 (2026-10-29): a two-layer system with a **global assistant** (cross-project memory, finds past experience, sets up context) and a **project assistant** (splits work, runs sub-tasks in parallel, integrates, reports). The developer manages by "听汇报、做判断" (hear reports, make decisions). https://www.ithome.com/1/019/458.htm · https://forum.trae.cn/t/topic/464312
- [T2] TRAE built-in Agent and Subagents: a plan is confirmed before execution. The lead picks a sub-agent by matching its `description`. Each sub-agent has its own context window and returns only its result. Project-level definitions override user-level ones. https://docs.trae.cn/ide_built-in-agent · https://docs.trae.ai/ide/subagents?_lang=zh
- [A1] Anthropic, "How we built our multi-agent research system" (orchestrator-worker; lead writes a plan to memory before the context fills; detailed sub-agent task descriptions with objective, output format, tools and boundaries; effort scaled to query complexity; parallel sub-agents; results go to an external store to avoid a "game of telephone"; LLM-judge evaluation; rainbow deploys and resumable state). https://www.anthropic.com/engineering/multi-agent-research-system
- [M1] Manus, "Context Engineering for AI Agents" (stable prompt prefix and KV-cache hit rate; mask tools rather than remove them; filesystem as context; recite goals through a todo.md; keep errors in context; avoid few-shot ruts). https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- [O1] OpenAI Agents SDK handoffs (a handoff is a tool `transfer_to_<agent>` that carries input filters/typed input; also guardrails and tracing). https://openai.github.io/openai-agents-python/handoffs/
- [K1] DeepSeek V3.1 release (hybrid thinking / non-thinking modes, stronger tool/agent use) https://api-docs.deepseek.com/news/news250821 · V3.2 thinking mode with tool calls https://api-docs.deepseek.com/guides/thinking_mode

_[A1], [M1], [O1] and [K1] are cited from their official pages. Quotes are paraphrased. Re-check wording before quoting any of them in Devpost copy._

## Mapping

| # | Pattern (source) | Conductor analogue | Strength of fit | Forge feasibility | Demo moment |
|---|---|---|---|---|---|
| 1 | Lead agent + dynamically spawned sub-agents with scoped context and termination conditions [D1][D2][A1] | Router is the lead. Each step is a **sub-agent run** bound to one Jira child issue, with `brief`, `allowedTools`, `doneWhen`, `budget`. | **Strong**: this is already the shape. The gap is that briefs are thin and termination is implicit. | Yes. New fields on `step`. Step worker ≤900 s. | Panel card per sub-agent shows brief, tools and done-when. |
| 2 | Lead loop that re-plans after each wave and scales effort to complexity [A1][T2] | `plan-split` emits **wave 1** only. After the wave finishes, a `lead-review` consumer decides: spawn wave N+1, stop, or ask a human. Small goals get 1–2 steps, big ones up to 8. | **Strong.** | Medium. Planning needs an LLM: the Rovo model through an action call, or the Q1 fallback. A deterministic rule set is the fallback (e.g. research step returned "unknown dependency" → spawn `check-deps`). | Run graph grows live: "wave 2 spawned because step 1 found 3 linked bugs". |
| 3 | Skills as on-demand Markdown packs, progressive loading, scanned before install [D1][D2][D3][T2] | `skills/*.md` with frontmatter `name, description, tools, outputSchema`. The Router sees only `name+description` (cheap index). The worker loads the full body when a step uses it. Project-level skill override = a Confluence page/label later. | **Strong** for the pattern. Weak for "scanning": no untrusted installs in MVP. | Yes. Bundle skills in the app and read them at runtime. 4–6 skills: research, draft-spec, check-deps, test-plan, risk-review, summarize. | Add a new `risk-review.md` live, re-run, and the Router picks it with no code change. |
| 4 | Context engineering: scoped briefs, compact structured returns, summarization, external working memory, todo recitation [D3][A1][M1] | Sub-agent returns `{result≤2 KB, artifacts:[jira refs], confidence}`. Full output goes to the child issue (Jira = filesystem). The lead keeps a **run ledger** (`todo` recitation) and compresses finished waves into a ≤1 KB digest. | **Strong.** It also fixes KVS 240 KiB and the Rovo context limits. | Yes, pure logic. | "Context meter": 38 KB raw → 3 KB digest. |
| 5 | Two-tier memory, global + project, with confidence and scope-safe writes [T1][D2] | Tier 1 is **project/org memory** (decisions and lessons with confidence and scope, fail-closed if scope is missing). Tier 2 is **run memory** (the ledger). Recall = a cheap keyword index → top-k full read, injected at a fixed token budget. Ties into novelty #3 (lessons). | **Strong.** | Yes. `memory` entity exists. Add `confidence`, `scope`, a budgeted injector. | Run 2 shows "recalled 2 lessons (conf 0.8)" and a different plan. |
| 6 | Handoffs as tools with typed input and guardrails [O1] | Conductor hands a step to a **human** (approval gate) or to **another Rovo agent** through the action/MCP surface (novelty #2). Input guard (WP11) acts as an input filter. | **Medium.** Forge has no first-class agent-to-agent handoff (Q2). Humans are the realistic handoff target. | Human handoff yes. Agent handoff depends on the rovo:mcp spike. | Step pauses → assigned to a person → resumes. |
| 7 | Sandbox [D1][D3] | The Jira/Confluence API with the **effects queue** plus **dry-run** is the sandbox: every write is staged, deduped and replayable. | **Weak as code execution.** There is no shell on Forge, so don't claim a sandbox. Reframe it as a "staged-effects sandbox". | Yes (dry-run flag, novelty #1). | Dry run shows the blast radius before anything touches Jira. |
| 8 | Plan-confirm, then execute; manage by "hear reports, make decisions" [T1][T2] | Already in place: Rovo's confirm card. Add a **wave report** comment on the Epic after each wave with a decision prompt. | Strong, cheap. | Yes. | Epic comment "Wave 1 done: 3/3, next: 2 steps — approve?". |
| 9 | Thinking with tool calls; hybrid think/non-think [K1] | Lead uses "think" mode (deliberate plan + review). Workers use fast mode. If Q1 forces an external LLM, DeepSeek V3.2 is a cheap candidate for workers. | **Weak/optional.** Rovo picks the model, and an external LLM adds egress and breaks "Runs on Atlassian". | Only as a fallback. | No demo; mention in Devpost only if used. |
| 10 | Middleware chain around every turn [D3] | One `withHarness()` wrapper on every worker: budget check, guard, ledger append, event log (flight recorder), metrics. | Strong as an engineering pattern. | Yes. | Indirect: it powers the timeline. |

Dropped: DeepSeek model-internal mappings (MoE, MLA, MTP). The user corrected the request: they meant agent-harness architecture.

## Recommended work packages (before the 12-08 freeze)

**WP13 — Skill library + sub-agent briefs (3–4 days).** `skills/*.md` with frontmatter. A loader that keeps the index (name/description) separate from the full body. `step` gets `skill, brief, allowedTools, doneWhen, budget`. The Router prompt lists the skill index only. The worker loads the body plus a typed `outputSchema` and validates the return. Tests: unknown skill → reject; schema violation → one repair retry → `blocked`. Patterns: #1, #3.

**WP14 — Lead loop with waves + context compression (4–5 days).** `plan-split` persists wave 1. When that wave's steps are finished, the lead reviews once, claimed with an integer compare-and-swap on `reviewedThroughWave`. It calls the Forge LLM when the step worker can, and a deterministic rule set otherwise (including the issue trigger). It spawns the next wave (max 3 waves, max 8 steps total), stops, or posts a wave-report comment and pauses in `awaiting-review`. Each wave is compressed into a ≤1 KB digest kept in the run ledger, and full outputs stay on child issues. Later waves read the digest. The watchdog skips `awaiting-review`. Demo script: [docs/wp14-demo.md](wp14-demo.md). Patterns: #2, #4, #8.

**WP15 — Two-tier memory with budgeted injection (2–3 days, merge into WP12).** Add `confidence` and `scope` on memory, plus fail-closed writes when scope is missing. Recall = keyword index → top-k → inject ≤1.5 KB. Every recall is cited in the plan (`usedMemory:[memId]`). Pairs with novelty #3 (lessons). Pattern: #5.

**WP16 (stretch) — `withHarness` middleware + human handoff (2 days).** One wrapper for budget, guard, ledger and event log, so novelty #1 (flight recorder) gets its events for free. Approval-gate handoff to a Jira user. Patterns: #6, #10.

Order: WP13 → WP14 → WP15, with WP16 if time allows. WP13 and WP15 can run in parallel. WP14 depends on WP13's brief/schema.

## Demo storyline (≤60 s of the 5-min video)
"Conductor is a super-agent for Jira." The lead plans wave 1 with 3 sub-agents, each a child issue with its own brief and skill. Results come back compressed, and the context meter shows it. The lead spawns wave 2 because of a finding. The Epic gets a wave report, and the user approves. Run 2 on a similar Epic recalls a lesson and plans differently. Then a new skill file is dropped in and immediately used.

## Honesty notes
- No shell or code sandbox on Forge. Don't use the word "sandbox" except for "staged effects".
- Agent-to-agent handoff depends on spikes Q2 and Q3 and `rovo:mcp` (Preview).
- LLM-driven re-planning depends on Q1. The deterministic policy fallback must demo well on its own.
