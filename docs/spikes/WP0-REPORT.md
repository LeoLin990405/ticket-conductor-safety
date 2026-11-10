# WP0 report

Issue #1 asks for this path. The full record (evidence, spike map, live commands, and the WP1–WP9 impact list) is [docs/SPIKES.md](../SPIKES.md). Both files are in the same PR. Decisions below match that document.

No production deploy. No dev deploy either: this environment has no Atlassian credentials. `forge lint` exits with "Not logged in" before it prints manifest errors. The schema check bundled with Forge CLI 14.2.0 (`@forge/manifest` 13.7.0, full validation) returned success for `spikes/capability-spike/manifest.yml`.

## Decisions

| # | Answer | Recommendation |
|---|---|---|
| Q1 | Yes. `@forge/llm` (`chat`, `stream`, `list`) calls an Atlassian-hosted model from a Forge function. The Router can also reason with no extra API. An external model needs `permissions.external.fetch.backend` and `forge variables set --encrypt`. | Router reasoning only for the MVP. Do not add `@forge/llm` or egress. |
| Q2 | No agent-to-agent API. A `rovo:agent` calls same-app `action` keys. `rovo:mcp` exposes those actions to a Rovo Studio agent or an external MCP client. That is not the Router dispatching a worker. | Workers are `@forge/events` consumers, `timeoutSeconds: 900`. |
| Q3 | `rovo:skill` is Preview and lint-schema-valid. The action module key is `action`, not `rovo:action`. `rovo:mcp` is Preview, one per app. | One skill for the Router playbook. MCP stays a stretch. |
| Q4 | Forge SQL quotas are published (`@forge/sql` 4.0.9 exists). Custom entities cover our queries. `integer` cannot store epoch milliseconds. | Custom Entity Store plus KVS locks. Timestamps are `float`. Not SQL. |

## Q1

Primary sources: [Forge LLMs API](https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api/), [SDK](https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api-reference/), [models](https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-models/), [pricing](https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api-pricing/), [limits](https://developer.atlassian.com/platform/forge/limits-llm/), [egress](https://developer.atlassian.com/platform/forge/manifest-reference/permissions/), [variables](https://developer.atlassian.com/platform/forge/environments-and-versions/).

The `llm` module is one per app, family `claude` only, and it is a major version. No free token quota. Published rates are Haiku 4.5 at $1 / $5 per million input / output tokens, Sonnet 4.5 at $3 / $15, Opus 4.6 at $5 / $25. Newer models on the models page have no published rate. Actions die at 55 seconds, so a model call that needs the 5-minute inference budget must run in a consumer. External egress can drop Runs on Atlassian. The old `/platform/forge/llm-api/` path is still not the API. The working paths are the ones above.

## Q2

Primary sources: [Rovo modules](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-index/), [agent](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent/), [agent connector](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent-connector/), [async events](https://developer.atlassian.com/platform/forge/runtime-reference/async-events-api/), [invocation limits](https://developer.atlassian.com/platform/forge/limits-invocation/), [async limits](https://developer.atlassian.com/platform/forge/limits-async-events/).

`rovo:agentConnector` is a person assigning a remote A2A agent, and it makes the app system user unmentionable. Push `{ body }` with `@forge/events` 2 or newer. The consumer reads `event.body`. `timeoutSeconds` max is 900, and only if that function is not also an action. Events for a long consumer must be under 100 KB. At-least-once delivery is why a stale attempt must no-op.

## Q3

Primary sources: [rovo:skill](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-skill/) (2026-10-29, Preview), [action](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-action/), [agent](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent/), [rovo:mcp](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-mcp/).

Skill tools are same-app action keys. The agent selects a skill by description. Explicit invocation by name is not supported in Preview. Action input types are `boolean`, `integer`, `number`, `string` only. A manifest with `type: array` fails validation: `action inputs planJson property type 'array' allowed values are 'boolean', 'integer', 'number', 'string'`. CLI schema also caps an action `description` at 255 characters and inputs at 10. `planSplit` must take `stepsJson` as a string.

## Q4

Primary sources: [SQL limits](https://developer.atlassian.com/platform/forge/limits-sql/), [KVS and Custom Entity limits](https://developer.atlassian.com/platform/forge/limits-kvs-ce/), [entity manifest](https://developer.atlassian.com/platform/forge/storage-reference/entities-manifest/), [queries](https://developer.atlassian.com/platform/forge/storage-reference/entities-api-query/).

Development SQL storage is 128 MiB, `SELECT` timeout 5 seconds, and the `sql` module is a major version. Entity `integer` max is 2,147,483,647. Use `float` for epoch milliseconds. Query pages max out at 100. `findStuckSteps` needs index `by-status-deadline` (running) and a new `by-status-created` (queued). Scope `storage:app` is required. The linted entity block is in the spike manifest.

## Fallback if a live check contradicts this

Each question's fallback is the recommendation above: Router reasoning, in-app queue consumers, plain `action` modules, Custom Entity Store. The commands and the result that confirms each row are in [docs/SPIKES.md](../SPIKES.md#live-verification).
