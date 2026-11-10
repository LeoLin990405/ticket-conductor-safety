# Scenario 07 — Another agent hands a goal to Conductor

**Not yet executed in Rovo chat.** The local half is executed by `npm test` (`handoffGoal` and `node demo/mcp-client.mjs --local`). The Rovo chat half and the Cursor OAuth half need a development install. Do not deploy production. Do not enable external MCP tools on a production site.

This is the Best Agents path: a second agent invokes Conductor's tools, then reads the run back. The tools are the `action` modules `plan-split`, `dispatch-run`, `get-run-status`, and `recall-memory`. The procedure is the `rovo:skill` `conductor-tools` (`prompts/conductor-tools/SKILL.md`). The same four keys are the `rovo:mcp` module `conductor-mcp`.

## In-app agent

Agent key `conductor-handoff`, name **Conductor handoff**. It is not `conductor-router`.

1. Open Rovo on the dev site and select **Conductor handoff**.
2. Say: "Hand PAY-1 to Conductor. Goal: ship payment refunds. Start the run and tell me the status."
3. Expected tool order, visible in `forge logs` as `[action] recallMemory`, `[action] planSplit`, `[action] dispatchRun`, `[action] getRunStatus`:
   - `recall-memory` with `projectKey` `PAY` and a query that includes the goal.
   - `plan-split` with `epicKey` `PAY-1`, that goal, and `stepsJson` as one JSON string of 1 to 8 objects. `workerType` is `research`, `draft-spec`, or `check-deps`. No `summarize` step.
   - `dispatch-run` with the `runId` from plan-split, once.
   - `get-run-status` with that `runId`.
4. The reply quotes `runId` and `status` `running`, lists each step's `idx`, `title`, and `status`, and does not claim a child issue key until `childIssueKey` is non-null.
5. The Run panel on PAY-1 shows the same run. Child issues appear after the effect applier runs, which is after the action returns.

A second identical request creates a second run (a new `plan-split`). Calling `dispatch-run` twice on the **same** `runId` does not enqueue the steps again.

## MCP client

External tools are off until an admin enables them: Atlassian Administration, Apps, Sites, the site, Connected apps, this Forge app, app details, Tools. Enable `plan-split`, `dispatch-run`, `get-run-status`, and `recall-memory`.

Endpoint, from `app.id`:

`https://mcp.atlassian.com/forge/00000000-0000-4000-8000-0000000000a1`

Cursor config is `demo/cursor-mcp.json`. Claude Code:

```bash
claude mcp add --transport http ticket-conductor https://mcp.atlassian.com/forge/00000000-0000-4000-8000-0000000000a1
```

The client opens OAuth. The user picks the site where the app is installed. Then ask: "Have Conductor plan PAY-1, goal ship payment refunds, and read the status."

`node demo/mcp-client.mjs --print` prints the JSON-RPC `tools/call` bodies and sends nothing. `node demo/mcp-client.mjs --local --epic PAY-1 --project PAY --goal "Ship payment refunds"` runs the handlers in memory. `--live` does not call the endpoint.

## Expected local result

`ok` true, `status` `running`, three steps when the client used the default plan, each `childIssueKey` null, `createdBy` `mcp-local-demo` on the stored run. No Jira request is made.
