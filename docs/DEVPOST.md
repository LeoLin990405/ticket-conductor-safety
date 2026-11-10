# Ticket Conductor — Devpost draft

Draft. Paste the sections under "Paste into Devpost". Leave out "Notes for the submitter". Replace every bracketed placeholder. Do not invent the YouTube URL or the install link.

## Paste into Devpost

### Project name

Ticket Conductor

### Tagline

A Rovo supervisor that plans a Jira Epic, runs the steps you confirm, and remembers the decisions.

### Category

Apps for Software Teams

### Bonus prize

Best Agents (the Rovo agent bonus).

This entry does not compete for Marketplace, Atlassian MCP, or Teamwork Graph.

### Built with

Forge, Jira Cloud, Rovo, Node.js, Custom Entity Store, Forge key-value storage, Forge async events

### The problem

A software team asks an agent to "just run this Epic" and gets a chat. The chat creates issues with no record of what was confirmed, retries a stuck step by creating a duplicate, and forgets the decision on the next Epic. The work is slow to audit because the plan lived in a transcript.

### What it does

Mention Conductor on an Epic.

1. The Router proposes 1 to 8 steps and waits. Nothing is created until you confirm.
2. On confirm it stores a run and creates one child issue per step.
3. Workers run side by side. The Run panel on the Epic shows the tree and the effect timeline.
4. A stuck step is retried by a scheduled Watchdog. A duplicate delivery with the same request key is applied once.
5. The finished run writes a summary and the decisions back to the Epic. The next run on a related Epic recalls them.

### How we built it

Ticket Conductor is a Forge app. One Rovo agent, `conductor-router`, can call five actions: `plan-split`, `dispatch-run`, `get-run-status`, `recall-memory`, and `record-decision`. It does not write to Jira itself.

`plan-split` takes the plan as `stepsJson`, a single string, because a Forge action input cannot be an array. The handler parses that string, checks the steps, and stores a run in `planning`. `dispatch-run` starts it only when `confirm` is true.

Each step is a Jira child issue plus a record in the Custom Entity Store. Workers are Forge queue consumers. A consumer can run for up to 15 minutes (`timeoutSeconds` 900). They are not other agents. There is no agent-to-agent API to delegate to, and this app does not pretend there is. Specialist work is a worker type on the step: `research`, `draft-spec`, or `check-deps`. A `summarize` worker runs when the planned steps are done.

Every Jira create, comment, and transition goes through an effects queue. The key is a hash of the run, the step, the kind, and a discriminator that ignores the attempt number. A retry cannot mint a second child issue. The Watchdog runs every five minutes, finds a step that has missed its deadline or sat queued for more than ten minutes, and retries it. Three failures block the run and post one comment.

Decisions are stored on the project. The category field is `memType`: `decision`, `lesson`, or `fact`. The Epic comment starts with the header `[Conductor memory]`. The next plan calls `recall-memory` and has to follow what came back.

Storage is the Custom Entity Store for runs, steps, effects, and memories, plus the key-value store for locks. Timestamps are epoch milliseconds stored as floats. The app does not use Forge SQL, and the Router does not call an external model.

### Forge and Atlassian requirement

The app is a Forge app for Jira Cloud and Rovo. The Router is a `rovo:agent`. The same app uses Forge actions, async event consumers, a scheduled trigger, a Jira issue panel, and Forge storage. The MVP declares no external fetch, so the runtime stays on Atlassian.

App id: `ari:cloud:ecosystem::app/00000000-0000-4000-8000-0000000000a1`

### Try it

1. Install the app on a Jira Cloud site where Rovo is enabled. Install link: [install link].
2. Create the demo project in [demo/seed.md](../demo/seed.md). The data file is [demo/seed.json](../demo/seed.json). Project key `PAY`, Epic "Ship payment refunds", related Epic "Reconcile refund ledger".
3. Open **Ship payment refunds**, mention Conductor, and ask it to plan and run the Epic. Confirm the plan when asked.
4. Watch the Run panel. Child issues appear after confirm. The effect timeline shows one applied create per step.
5. For the watchdog shot, set the development variable `CONDUCTOR_DEMO_STUCK_STEP` (do not publish the value), dispatch, and refresh the panel after the retry. The attempt increases. One child issue remains.
6. When the Epic comment headed `[Conductor memory]` is in, open **Reconcile refund ledger** and ask for a plan. The reply quotes the earlier decision and waits for a new confirm.

Written cases, including five adversarial tries that are specified and not yet executed live, are in [tests/scenarios](../tests/scenarios).

### Video

[YouTube URL]

Public, English, about three minutes, under the five-minute Devpost limit. The script and shot list are [docs/VIDEO.md](VIDEO.md). The video covers the Best Agents bonus: one restricted Router, workers that are queue consumers, and a recall on the next Epic.

### Links

- Repository: [repo URL]
- Design: docs/DESIGN.md in that repository

## Notes for the submitter

Do not paste this section into Devpost.

- Team display names and the judge login, if you share a site, are still open. The development site named in the repo is `your-site.atlassian.net`. A public judge may need the install link plus a site where Rovo chat is actually enabled.
- Record the video from `docs/VIDEO.md`. Spoken word count is capped at 450 by `tests/scenarios/wp7.test.mjs`. Cut across the Watchdog wait. The real trigger is `fiveMinute`, and `deadlineAt` is 12 minutes after a step starts, unless WP4 shortens it while `CONDUCTOR_DEMO_STUCK_STEP` is set.
- WP9 still has to merge `prompts/router.manifest.yml` and retire the hello-world agent. Until that ships, the live agent will not match this draft.
- The five adversarial tries in `tests/scenarios/06-adversarial-tries.md` are **not yet executed live**. Do not claim in the submission that a model was scored against them.
- `planSplit` in `docs/TASKS.md` still shows a `steps` array. The spike decision, and this package, use `stepsJson` as a string. Say that in the "how we built it" text. It is already in the paste section.
- The memory entity field is `memType`. The `record-decision` action input is still `type`.
- Marketplace and Teamwork Graph stay unchecked. `rovo:mcp` (`conductor-mcp`) is in the manifest, so the Atlassian MCP bonus can be claimed once a site admin enables external tools and a client connects. Until that live check, say the module is declared and external exposure is off by default. There is no `rovo:agentConnector` and no external egress.
