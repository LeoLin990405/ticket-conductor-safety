# Spike: `rovo:skill` and `rovo:mcp` for other agents

Checked 2026-11-01 against the public Forge docs and against the manifest schema shipped in Forge CLI **14.2.0** (`@forge/manifest` **13.7.0**). No deploy. Production was not touched.

This is novelty recommended item 3 (ranked idea 2 in [docs/novelty.md](novelty.md)): make Conductor a tool other agents can call, matching the Best Agents wording (reusable `rovo:skill` / `rovo:action` modules other agents invoke) and the Atlassian MCP bonus.

## Decision

| Question | Answer | What we shipped |
|---|---|---|
| Does `rovo:skill` exist? | Yes. Preview. CLI 14.2.0 already validates it, including `SKILL.md`. | `conductor-tools`, procedure for a calling agent. The supervisor keeps `conductor-playbook`. |
| Is the module key `rovo:action`? | No. The YAML key is `action`. The doc title is "Action" and the URL contains `rovo-action`. | The four tools stay `action` modules. |
| Can another agent invoke a skill by name? | No. Preview selects a skill from its description. A Forge agent only sees skills listed on its own `skills` array. Skill tools must be `action` keys in the **same app**. There is no cross-app skill import. | `conductor-handoff` lists `conductor-tools` and the four action keys. Its prompt does not tell it to call the skill by name. |
| Does `rovo:mcp` exist on CLI 14.2.0? | Yes. Preview. The schema accepts the module. The public page says one per app. | One module, `conductor-mcp`, tools `plan-split`, `dispatch-run`, `get-run-status`, `recall-memory`. |
| Can an action declare an output schema for a step list? | No. Input and output types are `boolean`, `integer`, `number`, `string` only, max 10. `outputs` also requires Automation `outputContext`. | No `outputs` block. The function returns JSON. The contract is `src/actions/contract.js` and `prompts/conductor-tools/references/io.md`. |
| Fallback if a later deploy rejects `rovo:mcp` | Remove that one module. | The handoff agent and the four `action` modules still run. Other agents in this app call those actions directly. Rovo Studio and Cursor need the MCP module. |

`forge lint` on CLI 14.2.0 in this environment stops at "Not logged in" before it can report manifest problems. The same CLI's local full validator (`validate(false, manifest.yml)` from `@forge/manifest` 13.7.0) returned `success: true` and no errors for the product manifest, including both skills and `rovo:mcp`.

## What "other agents can invoke" actually means

There is still no agent-to-agent call. A `rovo:agent` does not target another agent. The invocable unit is an `action`.

| Caller | How it reaches Conductor |
|---|---|
| `conductor-handoff` (second `rovo:agent` in this app) | Lists the four action keys and the `conductor-tools` skill. This works on deploy, with no admin switch. |
| A custom agent in Rovo Studio | A person adds the app's MCP tools (Connected apps, then the tool). Tutorial path below. |
| Cursor, Claude, or another MCP client | `https://mcp.atlassian.com/forge/<appId>` after an admin enables external tools. Off by default. OAuth 2.1 in the client. |

The Best Agents phrase says `rovo:skill` / `rovo:action`. Forge's module key for the tool is `action`, not `rovo:action`. The skill is the instructions those tools follow. Both are in the manifest. Workers stay queue consumers in this app. This spike does not add `rovo:agentConnector` (that makes the app user unmentionable).

## `rovo:skill` (Preview)

Page last updated 2026-10-29.

https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-skill/

Preview is supported and may be deployed to development, staging, and production. It adds no scopes. Deprecation windows can be shorter than GA.

```yaml
rovo:skill:
  - key: conductor-tools
    source:
      dir: prompts/conductor-tools
    dependencies:
      tools:
        - plan-split
        - dispatch-run
        - get-run-status
        - recall-memory
```

| Property | Required | Limit |
|---|---|---|
| `key` | yes | Unique. `^[a-zA-Z0-9_-]+$` |
| `source.dir` | yes | Relative to the manifest. Must exist, must contain `SKILL.md`, must be unique among skills. `..` is rejected by the file resolver. |
| `dependencies` | no | If present, `tools` is required. |
| `dependencies.tools` | if `dependencies` is set | Min 1, unique, each an `action` key in this app. CLI pattern `^[a-zA-Z0-9-._]+$`, max length 255. |
| `name`, `description` on the module | no | Schema marks them internal. The CLI fills them from `SKILL.md`. Do not set them in YAML. |

Skill-to-skill dependencies are not supported. Scripts in the skill directory are not supported. Directory size limit is 100 MB uncompressed. The file the platform reads is `SKILL.md`, not `skill.md`.

### `SKILL.md` frontmatter

The CLI rules (`skill-file-rules.js` in `@forge/manifest` 13.7.0) match the public page.

| Field | Required | Rule |
|---|---|---|
| `name` | yes | 1–64 chars. `^[a-z0-9]+(?:-[a-z0-9]+)*$`. Must equal the directory name. |
| `description` | yes | 1–1024 chars. Warning under 50. This is how an agent discovers the skill. |
| `allowed-tools` | no | Space-separated. If set, it must include every `dependencies.tools` entry. |
| `compatibility` | no | String, 1–500. |
| `metadata` | no | Object whose values are strings. |
| `license` | no | String. |

Unknown frontmatter fields are errors. The body should be 500 lines or fewer (warning over that). Each dependency tool should appear as a word in the body (warning if missing). A path like `references/io.md` is checked and warns if the file is missing. `references/`, `scripts/`, and `assets/` are the prefixes the checker looks for. Do not put a script there.

Negative check, same validator, `name: wrong-name` in `prompts/conductor-tools/SKILL.md`:

```text
Skill conductor-tools frontmatter field 'name' must match the parent directory name 'conductor-tools'.
```

A Forge agent loads the skill only when that agent's `skills` list contains the module key, and only when the description matches the request. Explicit invocation by name is not supported in Preview.

https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent/

CLI schema for `rovo:agent` (no public-page re-fetch this session; these numbers are the 14.2.0 schema): `name` max 30, `description` max 255, each `conversationStarters` item max 85, `actions` and `skills` unique and min 1 when present. Nothing in the schema says an action key can belong to only one agent. This app lists the four tools on both agents.

## `action` (the tool other agents call)

https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-action/ (page last updated 2026-08-03)

| Property | Required | Limit in CLI 14.2.0 |
|---|---|---|
| `key` | yes | `^[a-zA-Z0-9_-]+$` |
| `name` | public page says yes | Schema max 255. Not in the `required` array. We set it. |
| `function` or `endpoint` | yes | One of them. |
| `actionVerb` | yes | `GET`, `CREATE`, `UPDATE`, `DELETE`, `TRIGGER`. |
| `description` | yes | **maxLength 255.** The model uses this to decide when to call. The public page does not state 255. |
| `inputs` | public page says yes | Schema allows the module without `inputs`. Max 10 properties. |

Each input needs `title`, `description`, and `type`. `type` is `boolean`, `integer`, `number`, or `string`. There is no `array` and no `object`.

Negative check, `stepsJson` changed to `type: array`:

```text
action inputs stepsJson property type 'array' allowed values are 'boolean', 'integer', 'number', 'string'
```

So a plan is the string `stepsJson`. The handler `JSON.parse`s it. Descriptions for the four reusable tools are written for a calling agent and are copied from `src/actions/contract.js`. A 256-character description fails with:

```text
action property description '...' must NOT have more than 255 characters
```

`actionVerb` matters for who can call. The action page says agents triggered by **automation rules** will not invoke `CREATE`, `UPDATE`, `DELETE`, or `TRIGGER`. `plan-split` is `CREATE`. `dispatch-run` is `UPDATE`. A chat agent and an MCP client can call them. An automation-triggered agent can call the `GET` tools (`get-run-status`, `recall-memory`) and will not call plan or dispatch. Do not change the verbs to chase automation. Rovo's confirmation card is tied to `UPDATE`, and the supervisor prompt depends on that.

Returned data can be any string or JSON object, up to the 5 MB action limit on that page. Model-supplied inputs are not an authorization source. `createdBy` is read from `context.principal.accountId`, not from the goal.

### Why there is no `outputs` block

The CLI schema allows `outputs` (max 10, same four primitive types). If `outputs` is present, `outputContext` is required:

| `outputContext` field | Limit |
|---|---|
| `entityName` | 1–12 |
| `outputType` | `OBJECT` or `LIST` |
| `outputDomain` | 1–12, `^[a-z-]+$` |

That shape is the Automation smart-value map, documented on the automation action page, not on the Rovo action page:

https://developer.atlassian.com/platform/forge/manifest-reference/modules/automation-action/

A step list and a memory list cannot be declared there. Advertising `runId` alone would describe a different object than the one the function returns. The stable contract is the JSON below. Success includes `ok: true`. The Forge export in `src/index.js` wraps a throw as `{ ok: false, error, code }`.

`plan-split` success: `{ ok, runId, status, epicKey, projectKey, steps, recalledMemories }`. `status` is `planning`. Each step is `{ stepId, idx, title, workerType, input, status }`.

`dispatch-run` success: `{ ok, runId, status }`. A second call on the same run stays `running` and does not enqueue again.

`get-run-status` success: `{ ok, run, steps }`. `run` is null when nothing is stored. Otherwise `{ runId, epicKey, projectKey, goal, status, summary, createdAt, updatedAt }`. Each step is `{ idx, title, workerType, status, childIssueKey, attempt }`. `childIssueKey` is null until the effect applier has created the child. `createdAt` and `updatedAt` are epoch milliseconds.

`recall-memory` success: `{ ok, memories }` with at most five `{ memId, projectKey, memType, text, sourceIssue, runId }`. Superseded and expired rows are already dropped.

`record-decision` stays on the supervisor. It is not on `conductor-mcp` or the handoff agent.

## `rovo:mcp` (Preview)

Page last updated 2026-10-29.

https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-mcp/

https://developer.atlassian.com/platform/forge/build-a-hello-world-rovo-mcp/ (same date)

```yaml
rovo:mcp:
  - key: conductor-mcp
    name: Conductor MCP
    tools:
      - plan-split
      - dispatch-run
      - get-run-status
      - recall-memory
```

| Property | Required | Limit |
|---|---|---|
| `key` | yes | Unique. `^[a-zA-Z0-9_-]+$` |
| `name` | yes | 1–30 characters. "Conductor MCP" is 13. |
| `tools` | yes | 1–50 action keys. Each key unique, under 64 characters, pattern `^[a-zA-Z0-9-._]+$`. Each key must exist as an `action`. |

The public page says an app can have **at most one** `rovo:mcp` module. The CLI 14.2.0 schema does **not** set `maxItems: 1` on the array. A negative manifest with a second module (`second-mcp`) was `success: true` under the local validator. Deploy might still reject a second module. **Unverified on a real deploy.** This app declares one.

Tools see only the site where the app is installed. No new scope is declared for the module. The skill page says `rovo:skill` adds none. The MCP page does not add one either. External OAuth consent still shows the app's existing scopes (`read:jira-work`, `write:jira-work`, `storage:app`). The four handlers do not call Jira. Dispatch only enqueues.

### Rovo Studio

From the hello-world tutorial: Ask Rovo, create an agent, Add tools, Connected apps, pick this app, add the tool, publish. That path is a human attaching the tool. Our handoff agent does not need that step because the actions are on its own manifest.

### External clients

External exposure is **disabled by default**. An admin turns tools on per installation: Atlassian Administration, Apps, Sites, the site, Connected apps, this Forge app, app details, Tools.

https://support.atlassian.com/organization-administration/docs/configure-tools-for-an-external-mcp-server/

Endpoint:

```text
https://mcp.atlassian.com/forge/00000000-0000-4000-8000-0000000000a1
```

The UUID is the part of `app.id` after `ari:cloud:ecosystem::app/`. Transport is streamable HTTP. Claude Code:

```bash
claude mcp add --transport http ticket-conductor https://mcp.atlassian.com/forge/00000000-0000-4000-8000-0000000000a1
```

Cursor config is `demo/cursor-mcp.json`. The client opens an OAuth 2.1 screen, the user picks a site where the app is installed and exposure is on, and calls run as that user.

The JSON-RPC method a client sends is `tools/call` with the action key as the tool name (`plan-split`, and so on). Whether Atlassian publishes that key unchanged from `tools/list` is **unverified** until a logged-in client connects. `node demo/mcp-client.mjs --print` prints the requests and sends nothing.

## What this change does not do

- No deploy, no `forge install`, no production.
- No new entity attributes. Entity fields are not removed (`summarizeQueued` stays). The entity key is not stored as an attribute. `runId` in the JSON is the key the store already uses.
- No compare-and-swap on a float. Callers are told not to send `createdAt` or `updatedAt` back. Existing run updates are unchanged.
- No new Jira route. Actions still do not call `requestJira`. The effect applier and the worker Jira client keep `assumeTrustedRoute` on a path the app builds, not on a whole prebuilt route string.
- No `llm` module, no egress, no `rovo:agentConnector`, no second `rovo:mcp`.

## How to re-check

From the repo root, development only, never `-e production`.

```bash
# Logged-in lint. Without a login, CLI 14.2.0 exits with "Not logged in"
# before it prints manifest errors. FORGE_DISABLE_ANALYTICS=1 skips the
# analytics prompt in a non-interactive shell. Do not deploy.
forge lint
npm test
```

`@forge/manifest` is not a dependency of this app. The `success: true` result above was the full validator bundled in `@forge/cli@14.2.0`. `npm test` does not need a login. The tests lock description length, the skill frontmatter, the handoff order, and `node demo/mcp-client.mjs --local`.

Live, after a development deploy someone else runs:

1. Rovo, agent **Conductor handoff**, "Hand PAY-1 to Conductor. Goal: ship payment refunds." Expect the four actions in `forge logs`, then status `running`.
2. Optionally enable the four tools for external clients and connect Cursor. Do not enable them on a production site.

The written walkthrough is [tests/scenarios/07-other-agent-handoff.md](../tests/scenarios/07-other-agent-handoff.md).
