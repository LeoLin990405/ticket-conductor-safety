# WP0 capability spikes

Decisions for Ticket Conductor, checked against Atlassian docs on 2026-11-01 and against the manifest schema shipped in `@forge/cli` 14.2.0 (`@forge/manifest` 13.7.0). No deploy was run. This environment has no Atlassian credentials, and `forge lint` exits before it reports manifest problems when the CLI is not logged in. The schema check that `forge lint` runs locally did succeed. The commands in [Live verification](#live-verification) still need to be run.

Throwaway code lives only in [`spikes/capability-spike/`](../spikes/capability-spike/). It is a separate Forge app. Do not copy its `app.id`, its `llm` module, its dynamic web trigger, or its egress block into the product `manifest.yml`.

## Decisions

| # | Answer | Recommendation |
|---|---|---|
| Q1 | Yes. A Forge function can call an Atlassian-hosted model through `@forge/llm` (`chat`, `stream`, `list`). The Router can also reason with no extra API. An external model works only with declared egress and an encrypted variable. | Keep planning in the Router's own Rovo model. Do not add `@forge/llm` or an external API to the MVP. |
| Q2 | No documented way for one `rovo:agent` to invoke another agent. A Forge agent invokes `action` modules from the same app. `rovo:mcp` lets a *different* Rovo Studio agent, or an external MCP client, call this app's actions. | Workers stay async consumers in this app (`@forge/events` `Queue`, `timeoutSeconds: 900`). |
| Q3 | `rovo:skill` exists and is Preview. The module key for an action is `action`, not `rovo:action`. `rovo:mcp` is Preview, one module per app. | Add one `rovo:skill` for the Router playbook. Leave `rovo:mcp` as a stretch. Superseded for the bonus work by [docs/spike-rovo-skill-mcp.md](spike-rovo-skill-mcp.md): the product manifest now has `conductor-tools`, the `conductor-handoff` agent, and one `rovo:mcp`. |
| Q4 | Forge SQL is a shipped product (`@forge/sql` 4.0.9 on npm) with published per-install quotas. Custom Entity Store covers the run/step/effect/memory queries. | Custom Entity Store for those four records, KVS for small lock and idempotency keys. Not Forge SQL. Store epoch milliseconds as `float`, never `integer`. |

## Q1. Can a Forge function call an LLM?

Yes. Three different mechanisms exist. They are not interchangeable.

### Option A. The Router's own Rovo model

A `rovo:agent` follows its `prompt` and calls the `action` modules listed on that agent. The action function does ordinary work and returns a string or JSON. The model turns that into the reply. The action does not call a model.

- https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent/
- https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-action/

Action, web trigger, and `rovo:agentConnector` functions stop at 55 seconds. A UI resolver stops at 25 seconds. https://developer.atlassian.com/platform/forge/limits-invocation/

The Forge LLMs pricing page bills `@forge/llm` to the app developer and does not mention the agent's own reasoning. Whether a chat with the agent consumes the customer's Rovo quota is not stated on the agent page. **Unverified.**

### Option B. Forge LLMs, `@forge/llm`

This is the Atlassian-hosted API. It keeps Runs on Atlassian.

- Overview: https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api/
- SDK: https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api-reference/
- Module: https://developer.atlassian.com/platform/forge/manifest-reference/modules/llm/
- Models: https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-models/
- Pricing: https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api-pricing/
- Limits: https://developer.atlassian.com/platform/forge/limits-llm/
- REST shape used by the platform proxy: https://developer.atlassian.com/platform/forge/rest/v2/api-group-forge-llm/

The design note that `/platform/forge/llm-api/` returned 404 is still true as a path. The API lives at the URLs above. Package on npm, resolved 2026-11-01: `@forge/llm` 1.0.9.

```js
import { chat, list } from '@forge/llm';

const listed = await list();
const response = await chat({
  model: 'claude-sonnet-4-6',
  max_completion_tokens: 32,
  messages: [{ role: 'user', content: 'Reply with the single word pong.' }],
});
```

Manifest, one module per app, family `claude` only:

```yaml
modules:
  llm:
    - key: spike-llm
      model:
        - claude
```

Adding the module is a major version. Admins of an existing install must approve it. A brand-new app includes it in the first install consent instead.

Limits, per installation:

| Limit | Value |
|---|---|
| Requests per minute, any model | 100 |
| Tokens per minute, per model | 500,000 |
| Inference time | 5 minutes, and only when the caller is an async consumer whose `timeoutSeconds` is at least 5 minutes. Otherwise the caller's own timeout applies (55 seconds for an action or web trigger). |
| Context, Haiku | 200K in / 64K out |
| Context, Sonnet and Opus | 1M in / 128K out |
| Input | Text only |

`temperature` and `top_p` cannot be sent together. Omit both for `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, and `claude-sonnet-5`.

Models page (page date 2026-08-03, retrieved 2026-11-01) still marks every row `ACTIVE`, including:

| Model id | Tier | "Not sooner than" |
|---|---|---|
| `claude-haiku-4-5-20251001` | Haiku | 2026-10-15 (this date is already past) |
| `claude-sonnet-4-5-20250929` | Sonnet | 2026-09-29 (already past) |
| `claude-sonnet-4-6` | Sonnet | 2027-02-17 |
| `claude-sonnet-5` | Sonnet | 2027-06-30 |
| `claude-opus-4-6` | Opus | 2027-02-05 |
| `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5` | Opus | 2027-04-16, 2027-05-28, 2027-07-24 |

Call `list()` and use a model whose `status` is active. Do not hardcode Haiku 4.5 without that check.

Pricing page (page date 2026-07-23): no free quota. Billed to the app developer.

| | Credits per 1M tokens | Input USD / 1M | Output USD / 1M |
|---|---|---|---|
| Haiku 4.5 | 10 | $1 | $5 |
| Sonnet 4.5 | 30 | $3 | $15 |
| Opus 4.6 | 50 | $5 | $25 |

A credit is $0.10 on the way in and $0.50 on the way out. The pricing table does not list Sonnet 4.6, Sonnet 5, or Opus 4.7 and newer. **Cost of those models is unverified.**

A demo plan of a few thousand tokens on a published Haiku rate is cents, not a budget problem. The reasons to skip it for the MVP are the major-version consent, the lack of a free quota, and the 55-second action ceiling.

### Option C. External model, egress plus an encrypted variable

A function may `fetch` a host listed under `permissions.external.fetch.backend`. Calls to any other host are rejected.

- https://developer.atlassian.com/platform/forge/manifest-reference/permissions/
- https://developer.atlassian.com/platform/forge/runtime-egress-permissions/ (linked from the design; the permissions page is the manifest reference)

That block can make the app ineligible for Runs on Atlassian. The same page says `inScopeEUD: true` (end-user data leaving the app) makes the app ineligible. The Forge LLMs module does not.

CLI 14.2.0 warns when a backend entry is a bare string. The object form validates with no warning:

```yaml
permissions:
  external:
    fetch:
      backend:
        - address: api.anthropic.com
          inScopeEUD: false
```

The secret is a runtime variable, not a manifest variable. Manifest `${VAR}` substitution is build-time only.

```bash
forge variables set --encrypt -e development LLM_API_KEY "<secret>"
forge deploy --non-interactive -e development
```

The value is passed to the function as `process.env.LLM_API_KEY` in clear text. `forge variables list` hides encrypted values. A tunnel does not see deployed variables. Locally, export `FORGE_USER_VAR_LLM_API_KEY` and still read `process.env.LLM_API_KEY`.

- https://developer.atlassian.com/platform/forge/environments-and-versions/
- https://developer.atlassian.com/platform/forge/cli-reference/variables-set/
- https://developer.atlassian.com/platform/forge/tunneling/

One outbound request from an async consumer may last 180 seconds. https://developer.atlassian.com/platform/forge/limits-invocation/

The spike calls `POST https://api.anthropic.com/v1/messages` with `Authorization: Bearer`, `anthropic-version: 2026-10-21`, and model `claude-haiku-5-5`, which that page lists as the fast high-volume model. https://docs.anthropic.com/en/api/messages . Whether that model id still accepts traffic is **unverified** until `check=external` returns HTTP 200.

### Q1 recommendation

Use option A. The Router writes the plan as JSON and `plan-split` only validates, stores, and enqueues. Workers stay deterministic (`research`, `draft-spec`, `check-deps`, `summarize`).

Option B is the approved later step if a worker must generate prose. Call it from the 900-second consumer, after `list()`, with no `temperature`. Do not call it from an action. Option C is the last resort and should not be copied into the product manifest.

## Q2. Can one Rovo agent delegate to another?

No. Not as agent-to-agent inside Forge, and not as "this `rovo:agent` lists another app's actions."

What the module reference actually provides:

| Mechanism | What it does | Same as our workers? |
|---|---|---|
| `rovo:agent` `actions` | Keys of `action` modules this agent may call. Every example is a key in the same manifest. | No. These are short functions. |
| `rovo:agent` `skills` | Keys of `rovo:skill` modules in this app. The agent loads a skill when the description matches. Calling a skill by name is not supported in Preview. | No. A skill is instructions, not a process. |
| `rovo:skill` `dependencies.tools` | Action keys from the same app only. | No. |
| `rovo:mcp` | Exposes this app's actions to custom agents built in Rovo Studio, and (Preview, off by default) to third-party MCP clients at `https://mcp.atlassian.com/forge/<appId>`. | No. A human adds the tool to another agent. Our Router cannot list it. |
| `rovo:agentConnector` | A remote agent, A2A 1.0, that a person assigns, @-mentions, or chats with. Adding it stops the app system user from being mentionable. | No. |

Sources:

- https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-index/
- https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent/
- https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-skill/
- https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-mcp/
- https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent-connector/
- https://developer.atlassian.com/platform/forge/remote-agents-in-jira/

There is no manifest field for a target agent, an assignable worker agent, or another app's action key. **Unverified:** whether the Rovo chat UI can manually attach another app's MCP tools onto a Forge `rovo:agent`. The MCP page says the tools are added to custom agents in Rovo Studio.

### Fallback, confirmed from the docs

Workers are consumers on a queue. The spike uses the same APIs the product will use.

```yaml
modules:
  consumer:
    - key: spike-queue-consumer
      queue: spike-queue
      function: queueConsumer
  function:
    - key: queueConsumer
      handler: index.queueConsumer
      timeoutSeconds: 900
```

```js
import { Queue } from '@forge/events';

const queue = new Queue({ key: 'spike-queue' });
const { jobId } = await queue.push({ body: { source: 'action', holdSeconds: 0 } });
```

The consumer reads `event.body`. Pushing a bare object throws `Event body must be an object.` That wrapper is required since `@forge/events` 2. Resolved package: 3.0.9.

- https://developer.atlassian.com/platform/forge/runtime-reference/async-events-api/ (page date 2026-09-01)
- https://developer.atlassian.com/platform/forge/limits-invocation/
- https://developer.atlassian.com/platform/forge/limits-async-events/

| Limit | Value | Why it matters |
|---|---|---|
| Action runtime | 55 s | Enqueue and return. No step work in the action. |
| Consumer default | 55 s | Raised only with `timeoutSeconds`. |
| Consumer maximum | 900 s | Schema in CLI 14.2.0: `timeoutSeconds` minimum 1, maximum 900. The long timeout applies only when that function is referenced solely by a consumer or a scheduled trigger. |
| `delayInSeconds` | 0 to 900 | Backoff for effect retries. |
| Events per push | 50 | One push per step is fine. |
| Events per minute | 500 per installation | Eight steps is nowhere near this. |
| Combined payload per push | 200 KB | |
| Single event when timeout > 55 s | 100 KB | Push `{ runId, stepId, attempt }` or `{ requestKey }` only. |
| `retryData` | 4 KB | |
| Push chain from one invocation | 1000 push calls | |
| Retention | 24 h, extendable to 96 h on platform errors | |
| Delivery | At least once | Stale `attempt` must no-op. |

`timeoutSeconds: 900` is accepted by the schema. A live consumer that sleeps 60 seconds and still logs `SPIKE_QUEUE_CONSUMER_OK` proves the 55-second default was raised. Sleeping the full 900 seconds is not part of the spike. **Honoring the full 900 is unverified** until someone needs a run that long. The docs and the schema both say 900 is the maximum.

## Q3. `rovo:skill`, `action` / `rovo:agent`, and `rovo:mcp`

### `rovo:skill` (Preview)

Page date 2026-10-29. Preview means supported, with a shorter deprecation window, and it may be deployed to development, staging, and production. It adds no scopes.

https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-skill/

```yaml
rovo:skill:
  - key: plan-playbook
    source:
      dir: skills/plan-playbook
    dependencies:
      tools:
        - echo-plan
```

`source.dir` is relative to the manifest, must contain `SKILL.md`, and must be unique. `dependencies.tools` is required only when `dependencies` is present. Each entry is an `action` key in this app. No duplicate keys. Skill-to-skill dependencies are not supported. Scripts in the skill directory are not supported. Directory size limit is 100 MB uncompressed.

`SKILL.md` frontmatter:

| Field | Required | Rule |
|---|---|---|
| `name` | yes | 1–64 chars, lowercase letters, digits, single hyphens, not starting or ending with a hyphen. Must equal the directory name. |
| `description` | yes | 1–1024 chars. Use at least 50 so the agent can discover it. |
| `allowed-tools` | no | Space-separated. If set, it must include every `dependencies.tools` entry. |
| `compatibility`, `metadata`, `license` | no | See the page. |

The markdown body should be 500 lines or fewer. The agent selects the skill from the description. Explicit invocation by name is not supported in Preview. A Forge agent only sees skills listed on its `skills` property. The same skill can be listed on more than one agent in the same app. That is shared instructions, not delegation.

CLI 14.2.0 (published 2026-10-12) already contains this module. Its schema matches the page: required `key` and `source.dir`, optional `dependencies.tools`. `name` and `description` inside the manifest are marked internal (filled from `SKILL.md`). Do not put them on the module. Full validation of this repo's spike manifest, including the skill file rules, returned no errors. See [Lint and tests](#lint-and-tests).

### `action` (there is no `rovo:action` key)

The doc title is "Action" and the URL contains `rovo-action`. The YAML key is `action`.

https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-action/

| Property | Required | Notes |
|---|---|---|
| `key` | yes | `^[a-zA-Z0-9_-]+$` |
| `name` | public page says yes | CLI schema does not list it as required. The spike sets it. |
| `function` or `endpoint` | yes | One of them. |
| `actionVerb` | yes | `GET`, `CREATE`, `UPDATE`, `DELETE`, `TRIGGER`. Automation-triggered agents will not call `CREATE`, `UPDATE`, `DELETE`, or `TRIGGER`. |
| `description` | yes | The model uses this to decide when to call. CLI 14.2.0 schema: `maxLength` 255. The public page does not state 255. |
| `inputs` | public page says yes | CLI schema allows the module without `inputs`. Max 10 properties. |

Each input, from the CLI schema `ActionInput`: `title`, `description`, and `type` are required. `type` is an enum: `boolean`, `integer`, `number`, `string`. There is no `array` and no `object`.

Negative check, same validator, one input changed to `type: array`:

```text
error: action inputs planJson property type 'array' allowed values are 'boolean', 'integer', 'number', 'string'
```

So `planSplit({ steps: [{ title, workerType, input }] })` cannot be expressed as one input. Pass `stepsJson` as a string and `JSON.parse` it in the function. The public page also warns that model-supplied inputs are not an authorization source. Read `accountId` from `context`.

Returned data can be any string or JSON object, up to the 5 MB action limit on that page.

### `rovo:agent` fields

Page date 2026-10-02. https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent/

| Property | Required | Notes |
|---|---|---|
| `key` | yes | |
| `name` | yes | Max 30 characters. CLI schema agrees. |
| `prompt` | yes | String, or `resource:<key>;<path>` (CLI 10.6.0 or newer; this repo pins 14.2.0). |
| `description` | no | Shown to users. |
| `icon` | no | Resource path or absolute URL. |
| `conversationStarters` | no | Array of strings. |
| `actions` | no | Action keys. Min 1 if the array is present. |
| `skills` | no | `rovo:skill` keys. Preview. Min 1 if present. |
| `followUpPrompt` | no | Used after the answer to suggest follow-ups. |

The same page says: prompt for role and boundaries, skill for a task procedure, action for an executable call. Do not split the always-on prompt into skills just to shrink the file. Long procedures do belong in a skill because an inline prompt is a large part of the manifest. https://developer.atlassian.com/platform/forge/manifest-reference/manifest-size-best-practices/

### `rovo:mcp` (Preview)

Page date 2026-10-29. One per app. https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-mcp/

```yaml
rovo:mcp:
  - key: conductor-spike-mcp
    name: Conductor spike MCP
    tools:
      - echo-plan
      - enqueue-probe
```

`name` max 30 characters. `tools` is required, 1 to 50 action keys, each key under 64 characters. Tools see only the site where the app is installed. External MCP clients are Preview and disabled until an admin enables them. Not required for the demo. The product agent should call its own actions directly.

## Q4. Storage quotas and which store to use

### Forge SQL

https://developer.atlassian.com/platform/forge/limits-sql/ (page date 2025-12-01)
https://developer.atlassian.com/platform/forge/storage-reference/sql/

Per install:

| Resource | Limit |
|---|---|
| Stored data | 1 GiB production, 256 MiB staging, 128 MiB development |
| Tables | 200 |
| DML | 150 requests/second |
| DDL | 25 requests/minute |
| Row size | 6 MiB |
| Query memory | 16 MiB |
| Query time budget | 62.5 seconds per minute, all current invocations |
| Request / response | 1 MiB / 4 MiB |
| `SELECT` timeout | 5 seconds |
| `INSERT` / `UPDATE` / `DELETE` timeout | 10 seconds |
| DDL timeout | 20 seconds |

No foreign keys. One statement per call. Adding the `sql` module is a major version. Data is per install, per environment, per product. `@forge/sql` 4.0.9 is on npm (resolved 2026-11-01), so the SDK exists. **Whether this dev site has provisioned a database is unverified** until a deploy that includes the `sql` module. The quotas above are the documented limits, not a measurement from the site.

Our rows are small. 128 MiB would hold the demo. SQL is still the wrong default: it is a major version, `SELECT` dies at 5 seconds, and every query we need is an equality plus a range.

### Custom Entity Store and KVS

https://developer.atlassian.com/platform/forge/limits-kvs-ce/ (the design cites 2026-09-28)
https://developer.atlassian.com/platform/forge/storage-reference/entities-manifest/
https://developer.atlassian.com/platform/forge/storage-reference/entities/
https://developer.atlassian.com/platform/forge/storage-reference/entities-api/
https://developer.atlassian.com/platform/forge/storage-reference/entities-api-query/ (page date 2026-08-21)
https://developer.atlassian.com/platform/forge/storage-reference/entities-transactions/ (page date 2026-09-28)
https://developer.atlassian.com/platform/forge/storage-reference/kvs-api/

`@forge/kvs` 2.1.1, resolved 2026-11-01. Scope: `storage:app`. The product manifest does not have that scope yet. WP9 adds it, then the install must be upgraded.

Shared limits, per install:

| Limit | Value |
|---|---|
| Request rate | 1000 RPS |
| Reads | 4000 x 10 KB per minute |
| Writes | 4000 x 10 KB per minute |
| Key length | 500, regex `/^(?!\s+$)[a-zA-Z0-9:._\s-#]+$/` |
| Value | 240 KiB |
| Object depth | 31 |
| Reads per key | 12 MB/s |
| Writes per key | 1 MB/s |
| Entities per app | 20 |
| Attributes per entity | 50 |
| Indexes per entity | 7 |
| Attribute name | `^[a-zA-Z][a-zA-Z0-9_]*$` in the CLI schema, max 30. The public page also allows a leading underscore. Lint follows the CLI schema. |
| Index name | 3–50 characters |
| Partition key size, combined | 1700 bytes |
| Range key size, combined | 900 bytes |
| Conditions in one complex query | 100 |
| Query page | 10 by default, 100 maximum, then `nextCursor` |

Attribute types: `string`, `integer`, `float`, `boolean`, `any`.

`integer` is signed 32-bit: -2,147,483,648 through 2,147,483,647. Epoch milliseconds in 2026 are about 1.77e12. They do not fit. The unit test locks that in. `float` allows 0 and magnitudes from 1E-130 to about 1E125, with 38 decimal digits, so an epoch-millisecond value is exact. `string` must be non-empty. `any` may be an object or array but cannot be indexed or used in a filter (422 if you try).

A named index needs exactly one range attribute (the docs say one; the schema requires a non-empty `range` array) and an optional partition list. Partition is an exact match, in declared order. `where` applies to the range. `and` and `or` filters cannot be mixed in one query, and they run in memory, so a page can come back empty while `nextCursor` is set. Do not use them for `findStuckSteps`.

SDK names that match `@forge/kvs` 2.1.1: `WhereConditions.greaterThan`, `WhereConditions.lessThan`, `FilterConditions.equalTo`, `Sort.DESC`. One example on the query page calls `WhereConditions.isGreaterThan` and `SortOrder.DESC`. Those names are not exported by 2.1.1. The transactions page's first sample imports `Conditions` and then calls `FilterConditions`. Import `FilterConditions`.

```js
import { kvs, WhereConditions, Sort } from '@forge/kvs';

const page = await kvs
  .entity('step')
  .query()
  .index('by-status-deadline', { partition: ['running'] })
  .where(WhereConditions.lessThan(nowMs))
  .sort(Sort.ASC)
  .limit(100)
  .getMany();
```

`entity().set(key, value, { keyPolicy: 'FAIL_IF_EXISTS' })` is the idempotent create. **What the SDK throws or returns when the key exists is unverified** until `check=storage` runs. The probe prints both attempts.

Optimistic `updateRun` is a transaction conditioned on `updatedAt`, max 25 operations, each key once, 4 MB payload:

```js
import { kvs, Filter, FilterConditions } from '@forge/kvs';

await kvs.transact()
  .set(runId, nextRun, {
    entityName: 'run',
    conditions: new Filter().and('updatedAt', FilterConditions.equalTo(expectedUpdatedAt)),
  })
  .execute();
```

If any condition fails, the whole transaction fails. **The exact error class is unverified.**

KVS `set` / `get` / `delete` is enough for `lock:run:<runId>` and `idem:dispatch:<epicKey>:<hash>`. Those keys match the key regex. KVS queries can only `beginsWith` on the key. https://developer.atlassian.com/platform/forge/storage-reference/kvs-api-query/

TTL exists (max 1 year) but deletion can lag 48 hours. Do not use TTL as the stuck-step signal.

### Q4 recommendation

Custom Entity Store for `run`, `step`, `effect`, and `memory`. KVS for the two small keys. Not Forge SQL.

Indexed timestamps are `float` epoch milliseconds. The JS interface can keep using numbers. `idx`, `attempt`, and `tries` stay `integer` because they are small.

The spike manifest's `app.storage.entities` block is the schema WP1 should copy. It adds two things the design table did not have:

- `step.createdAt` (`float`) and index `by-status-created` (`status`, `createdAt`), so "queued longer than 10 minutes" is a range query. `by-status-deadline` only sees rows whose `deadlineAt` is set.
- `memory.memType` instead of an attribute named `type`. The CLI schema allows `type`, but `memType` is the name in the linted manifest. The JS field can still be called `type` if WP1 maps it.

`output`, `error`, `payload`, `result`, and `summary` are `any` and are not indexed. Keep the app-level 64 KiB cap on step output. The platform cap is 240 KiB for the whole value. ADF comment bodies can get deep. Store them as a JSON string if a body might pass depth 31. **How the platform counts depth is unverified.**

`findStuckSteps` is two queries, each paged at 100:

1. partition `running`, range `deadlineAt` less than now.
2. partition `queued`, range `createdAt` less than now minus 10 minutes.

Empty string is not a legal `string` attribute. Omit `childIssueKey` until it exists, or use a sentinel. **Whether an omitted attribute is accepted is unverified.** Indexed attributes must always be present or the row will not show up in that index.

## Spike code

[`spikes/capability-spike/`](../spikes/capability-spike/) is one deployable app:

| Piece | Role |
|---|---|
| `src/llmProbe.js` | `list()` then `chat()` on an active Claude model. |
| `src/externalLlmProbe.js` | `fetch` to Anthropic only when `LLM_API_KEY` is set. |
| `src/queueProbe.js` | Action-safe `Queue.push`, consumer with `timeoutSeconds: 900`. |
| `src/storageProbe.js` | Float write, index query, int32 rejection, `FAIL_IF_EXISTS`. |
| `src/index.js` | Web trigger `probe`, actions `echoPlan` and `enqueueProbe`. |
| `skills/plan-playbook/SKILL.md` | The skill the spike agent can load. |
| `manifest.yml` | `llm`, `rovo:skill`, `rovo:agent`, `rovo:mcp`, consumer, dynamic web trigger, entities. |

`app.id` is the placeholder `ari:cloud:ecosystem::app/00000000-0000-4000-8000-00000000c0de`. `forge register` overwrites it. Do not commit the result, and do not use the product id `00000000-0000-4000-8000-0000000000a1`.

The web trigger is dynamic, so it can return the probe JSON. Dynamic web triggers are not eligible for Runs on Atlassian, and the URL is unauthenticated. The handler requires `Authorization: Bearer` matching `SPIKE_TOKEN`. https://developer.atlassian.com/platform/forge/manifest-reference/modules/web-trigger/ and https://developer.atlassian.com/platform/forge/runtime-reference/web-trigger/

## Lint and tests

`forge lint` does not run without a login. From both the repo root and `spikes/capability-spike`, CLI 14.2.0 printed:

```text
Warning: Your version of Forge CLI is out of date. We recommend you update to the latest version to get the latest features and bug fixes.
Run npm install -g @forge/cli@latest to update from version 14.2.0 to 15.0.0.

Error: Not logged in. If a local keychain is available, run forge login, otherwise set environment variables before trying again. See https://go.atlassian.com/dac/platform/forge/getting-started/#log-in-with-an-atlassian-api-token for more.
```

The same CLI's local manifest validator (`@forge/manifest` 13.7.0, full validation, including skill-file rules) returned `success: true` and no errors for `spikes/capability-spike/manifest.yml` and for the untouched product `manifest.yml`. That is the check `forge lint` performs before it tries to reach Atlassian. It is not a substitute for a logged-in `forge lint`, which can also run remote rules. **Logged-in `forge lint` is unverified.** CLI 15.0.0 was not used. The repo pin is 14.2.0, and that pin already knows `rovo:skill`.

Root `npm test` (`node --test`), 2026-11-01:

```text
# tests 2
# pass 2
# fail 0
```

The tests assert that an epoch millisecond does not fit int32, and that the spike manifest still declares `rovo:skill`, `timeoutSeconds: 900`, the `claude` family, a float `createdAt`, and an integer `epochMsInt`.

## Live verification

Run these from a machine that is logged in (`forge login` or `FORGE_EMAIL` and `FORGE_API_TOKEN`). Development environment only. Site `your-site.atlassian.net`. Product `jira`. Do not deploy the repo root. Do not deploy production.

`forge deploy --help` on CLI 14.2.0 shows `-e, --environment`. The commands below use that flag.

```bash
cd spikes/capability-spike
npm ci
forge lint

# Rewrites app.id in this directory only. Do not commit that edit.
# Do not point it at ari:cloud:ecosystem::app/00000000-0000-4000-8000-0000000000a1.
forge register ticket-conductor-wp0-spike

SPIKE_TOKEN="$(openssl rand -hex 24)"
forge variables set --encrypt -e development SPIKE_TOKEN "$SPIKE_TOKEN"

# Optional. Only if you want the external-LLM check to place a real call.
# forge variables set --encrypt -e development LLM_API_KEY "<secret>"

forge deploy --non-interactive -e development
forge install --non-interactive -e development \
  --site your-site.atlassian.net \
  --product jira

# If install stops for consent, run it once without --non-interactive and
# approve storage, Forge LLMs, egress, and the dynamic web trigger.
# Variables are applied only by a deploy, so set them before deploy.
# If you set a variable afterwards, deploy again.

forge webtrigger create -e development \
  --site your-site.atlassian.net \
  --product jira \
  --functionKey spike-probe
```

Export the printed URL as `WEBTRIGGER_URL`. Then:

```bash
curl -sS -H "Authorization: Bearer $SPIKE_TOKEN" "$WEBTRIGGER_URL?check=llm"
curl -sS -H "Authorization: Bearer $SPIKE_TOKEN" "$WEBTRIGGER_URL?check=storage"
curl -sS -H "Authorization: Bearer $SPIKE_TOKEN" "$WEBTRIGGER_URL?check=queue"
curl -sS -H "Authorization: Bearer $SPIKE_TOKEN" "$WEBTRIGGER_URL?check=queue-long"
curl -sS -H "Authorization: Bearer $SPIKE_TOKEN" "$WEBTRIGGER_URL?check=external"
forge logs -e development -n 50 --since 15m
```

`check=all` runs llm, storage, and a zero-wait queue push. It does not call Anthropic and it does not sleep.

| Check | Result that answers the question |
|---|---|
| `forge lint` | Exit 0. Confirms the logged-in CLI accepts `rovo:skill`, `timeoutSeconds: 900`, the `llm` module, and the entity block. |
| `check=llm` | HTTP 200, `forgeLlm.ok: true`, a model id, and `usage` with token counts. That is a Forge function calling an Atlassian-hosted model. `forgeLlm.ok: false` with `no active model` means `list()` returned nothing active. |
| `check=external` without `LLM_API_KEY` | `externalLlm.skipped: true`. The code path is present and did not call out. |
| `check=external` with `LLM_API_KEY` | `externalLlm.ok: true` and `status: 200`. A Forge egress error means the host was rejected. An Anthropic 4xx means the call left Forge and the provider refused it. |
| `check=queue` | HTTP 200 with a `jobId` well under 55 seconds, then `forge logs` contains `SPIKE_QUEUE_CONSUMER_OK` and `"holdSeconds":0`. That is an action-equivalent push (the web trigger is also a 55-second module; the `enqueue-probe` action uses the same `pushProbe`). |
| `check=queue-long` | The same marker with `"holdSeconds":60` and `elapsedMs` at least 60000. The consumer outlived the 55-second default, so `timeoutSeconds` took effect. It does not prove a 900-second run. |
| `check=storage` | `storage.ok: true`, `queriedKeyFound: true`, `integerOverflowRejected: true`, `failIfExists.first: "created"`, and `failIfExists.second` not `"created"`. Read `integerOverflowError`. If the integer write succeeds, the int32 rule does not hold on this site and WP1 must re-check before using `float`. |
| Rovo chat | Open the spike agent "Conductor spike" on the dev site and ask it to plan a one-step spike. The reply should include the `echo-plan` result. That shows the skill was eligible. It does not show agent-to-agent delegation. There is no command that can show that, because no such module field exists. |

When you are done, from the same directory:

```bash
forge uninstall -e development \
  --site your-site.atlassian.net \
  --product jira
```

That removes the throwaway app from the site. It does not uninstall Ticket Conductor, as long as you run it in `spikes/capability-spike` after `forge register` rewrote this manifest's id.

## Impact on WP1–WP9

These should be applied to `docs/DESIGN.md` §6 and `docs/TASKS.md`. This package does not edit those files.

**WP1.** Copy `app.storage.entities` from the spike manifest (`run`, `step`, `effect`, `memory` only). Timestamps that are queried are `float`. Add `step.createdAt` and index `by-status-created`. Store memory's category as attribute `memType`. `putEffectIfAbsent` uses `keyPolicy: 'FAIL_IF_EXISTS'` on the effect key. `updateRun(..., { expectedUpdatedAt })` uses a transaction condition on `updatedAt` and throws `ConflictError` when the transaction fails. `findStuckSteps` runs the two partition queries above and follows `nextCursor`. Reject values over 64 KiB in the app even though the platform allows 240 KiB. Depend on `@forge/kvs`. Scope `storage:app` is WP9's manifest edit.

**WP2.** Depend on `@forge/events` 2 or newer (3.0.9 is current). Push `{ body: { requestKey } }`, not a bare object. The consumer reads `event.body`. The effect consumer function is referenced only by `effect-applier`, with `timeoutSeconds: 900`. Keep the event under 100 KB. `delayInSeconds` for backoff is 0–900.

**WP3.** Same queue rules, body `{ runId, stepId, attempt }`. Do not call an LLM from a worker in the MVP. Set both `createdAt` (when the step is queued) and `deadlineAt` (when it starts) so WP4's two queries work. A stale attempt still no-ops, because delivery is at-least-once.

**WP4.** `findStuckSteps` may return more than one page. The 200-step test must loop on `nextCursor`. Do not introduce a second agent. Three failures still block the run and enqueue one deduped Epic comment.

**WP5.** Manifest key is `action`. Descriptions must be 255 characters or fewer. At most 10 inputs, each `string`, `integer`, `number`, or `boolean`. Change `planSplit` to take `stepsJson` (string). The handler parses it into `steps[{title, workerType, input}]` and still rejects more than 8 steps or an unknown `workerType`. `get-run-status` and `recall-memory` should be `actionVerb: GET`. `dispatch-run` and `record-decision` may be `UPDATE` or `CREATE` for a chat agent. An automation rule will not invoke those verbs. No LLM calls inside an action. Read the user from `context`.

**WP6.** `recall` queries index `by-project` (partition `projectKey`, range `createdAt`), pages at 100, then scores in memory. Skip `supersededBy` and expired rows in that loop. `validUntil: 0` means no expiry. Map the JS field `type` to attribute `memType`.

**WP7.** Keep `prompts/router.md` as the short role and boundary prompt. Put the plan and dispatch procedure in a `rovo:skill` (`SKILL.md`, description at least 50 characters, body at most 500 lines). Do not tell the agent to invoke the skill by name. Tell it to pass `stepsJson` as a string, not a `steps` array. Do not write worker agents. Conversation starters stay on the agent.

**WP8.** No storage or LLM change. The panel reads the same records through the resolver. Do not call `@forge/llm` from the resolver (25-second limit).

**WP9.** Keep app id `ari:cloud:ecosystem::app/00000000-0000-4000-8000-0000000000a1`. Merge the four entities, `storage:app`, the five actions, `conductor-router`, and the skill if WP7 delivers one. Consumers `step-worker` and `effect-applier` get their own functions with `timeoutSeconds: 900`. Do not add `llm`, `permissions.external`, a dynamic web trigger, `rovo:mcp`, or `rovo:agentConnector` for the MVP. `rovo:agentConnector` would make the app system user unmentionable. After `storage:app` is added, upgrade the dev install. `@forge/kvs` and `@forge/events` are new dependencies. CLI 14.2.0 can lint `rovo:skill`. A bump to 15.0.0 is not required for that syntax. Logged-in `forge lint` is still the gate.

## Unverified until the live commands run

- A real `chat()` response and its token usage on the dev site.
- Whether Haiku 4.5 and Sonnet 4.5 still return `active` from `list()` after their "not sooner than" dates.
- Credit rates for every model except Haiku 4.5, Sonnet 4.5, and Opus 4.6.
- Whether Rovo agent chats are billed to the customer, the developer, or neither.
- Anthropic accepting `claude-haiku-5-5` through the egress path.
- The consumer actually surviving 60 seconds, and ever running to 900.
- The platform rejecting an int32 overflow, and the `FAIL_IF_EXISTS` error shape.
- A partial entity write that omits an optional string attribute.
- Logged-in `forge lint` and a Rovo chat that exercises `plan-playbook`.
- Forge SQL actually provisioning on this site. The recommendation does not depend on that.

## Live verification results

Run 2026-11-01 ~15:47–15:52 Beijing time (UTC+8) from a development machine, Forge CLI 14.2.0, logged in. App `ticket-conductor-spike` registered in Developer Space `codegeist-2026` (id `ari:cloud:ecosystem::app/00000000-0000-4000-8000-0000000000a2`, committed in the spike manifest only), deployed to **development** only, installed in Jira on `your-site.atlassian.net`. Production untouched; hello-codegeist untouched. `forge lint` (logged in): `No issues found.` `rovo:skill`, `llm`, `timeoutSeconds: 900`, entities and `rovo:mcp` all accepted by deploy. All storage indexes reported `ACTIVE`. `forge install --non-interactive --confirm-scopes` succeeded without a manual consent step (scopes: `storage:app`; egress `api.anthropic.com`).

| Q | Result | Evidence |
|---|---|---|
| Q1 `@forge/llm` | **Verified** | `check=llm` HTTP 200 in 6.8 s: `forgeLlm.ok: true`, model `claude-haiku-4-5-20251001`, reply `pong`, usage `15/5/20` tokens. `list()` returned 8 models, all `active`: haiku-4-5-20251001, sonnet-4-5-20250929, sonnet-4-6, opus-4-6, opus-4-7, sonnet-5, opus-4-8, opus-5. Note: probe's `text` field is the raw content array stringified, not plain text (cosmetic). |
| Q1 external egress | **Not tested** (by design) | `check=external`: `skipped: true`, `LLM_API_KEY is not set`. No key was set. |
| Q2 queue workers | **Verified** (async consumer path) | `check=queue` 200 in 2.0 s, `jobId 25245da2…`; log `SPIKE_QUEUE_CONSUMER_OK … "holdSeconds":0,"elapsedMs":0`. `check=queue-long` 200 in 1.7 s, `jobId 5bdf4ab1…`; log `SPIKE_QUEUE_CONSUMER_OK … "holdSeconds":60,"elapsedMs":60000` — consumer outlived 55 s, so `timeoutSeconds: 900` took effect (900 s itself not proven). Agent-to-agent delegation: no command can show it (doc conclusion stands, not contradicted). |
| Q3 `rovo:skill` | **Deploy/lint verified; needs UI test** | Manifest with `rovo:skill` + `rovo:mcp` deployed and installed. Skill execution needs Rovo chat (below). |
| Q4 storage | **Verified** | `check=storage`: `ok: true`, `queriedKeyFound: true`, `integerOverflowRejected: true` (`ForgeKvsError: Data type for property "epochMsInt" is defined as "integer"`), `failIfExists.first: "created"`, `second: "ForgeKvsError: Provided key already exists and cannot be overwritten"`. Use `float` for epoch ms confirmed. |

No PR #11 conclusion was contradicted.

### Needs UI test (human)

1. Open https://your-site.atlassian.net, open Rovo chat, pick agent **Conductor spike**.
2. Click starter "Plan a one-step spike" (or type it). Expect the reply to include the `echo-plan` result — proves the `plan-playbook` skill's tool ran.
3. Type "enqueue a probe with holdSeconds 0". Expect a jobId; then `forge logs -e development` in `spikes/capability-spike` should show `SPIKE_QUEUE_CONSUMER_OK` with `"source"` from the action.
4. Optional: check whether the chat consumed Rovo credits (billing question still unverified).

The spike install is left in place for this test. Remove afterwards with `forge uninstall -e development --site your-site.atlassian.net --product jira` from `spikes/capability-spike`.
