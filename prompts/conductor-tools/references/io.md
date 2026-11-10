# Conductor tool contract (version 1)

These are the JSON objects the Forge functions return. Forge action inputs cannot be arrays or objects, so the plan is the string `stepsJson`. Forge does not publish an output schema that can describe a step list. Do not look for an `outputs` block on these actions.

`ok: true` means the tool finished. `ok: false` means it refused the input or the run was missing. The failure object is `{ ok: false, error, code }` and it has no `runId` unless the caller already had one. `code` is `VALIDATION` or `NOT_FOUND` when the store raised that error.

Timestamps are epoch milliseconds. They are stored as Forge `float` attributes because they do not fit a 32-bit integer. Callers do not compare-and-swap them. The entity key (`runId`, `stepId`, `memId`) is not stored as an attribute. It appears in these objects so you can pass it to the next tool.

## plan-split

Success:

```json
{
  "ok": true,
  "runId": "uuid",
  "status": "planning",
  "epicKey": "PAY-1",
  "projectKey": "PAY",
  "steps": [
    {
      "stepId": "uuid",
      "idx": 0,
      "title": "Find related issues",
      "workerType": "research",
      "input": "label = refunds",
      "dependsOn": [],
      "status": "queued"
    }
  ],
  "recalledMemories": [
    {
      "memId": "uuid",
      "projectKey": "PAY",
      "memType": "decision",
      "text": "Refunds stay on the ledger",
      "sourceIssue": "PAY-9",
      "runId": null
    }
  ]
}
```

`workerType` you may send: `research`, `draft-spec`, `check-deps`. One to eight steps. `stepsJson` is the array above, serialized as one string. Each object may include `dependsOn`, an array of `idx` values in that same array. `[]` starts with the run. A cycle, a self-index, or an index that is not in the plan is `ok: false` with `code` `VALIDATION`, and no run is stored. After `dispatch-run`, a step whose dependencies are not done has `status` `waiting`.

## dispatch-run

Success: `{ "ok": true, "runId": "uuid", "status": "running" }`.

A second call with the same `runId` returns `running` again and does not enqueue another copy of the steps.

## get-run-status

Success:

```json
{
  "ok": true,
  "run": {
    "runId": "uuid",
    "epicKey": "PAY-1",
    "projectKey": "PAY",
    "goal": "Ship payment refunds",
    "status": "running",
    "summary": null,
    "createdAt": 1700000000000,
    "updatedAt": 1700000001000,
    "budget": {
      "maxSteps": 8,
      "maxModelCalls": 28,
      "wallClockMs": 5760000,
      "usedSteps": 0,
      "usedModelCalls": 0,
      "usedTokens": 0,
      "elapsedMs": 0,
      "startedAt": 1700000000000
    },
    "criticalPath": { "indexes": [0], "keys": ["step-id"], "durationMs": 720000 },
    "eta": { "remainingMs": 720000, "finishAt": 1700000720000 },
    "budgetOutlook": { "over": false, "reasons": [] }
  },
  "steps": [
    {
      "idx": 0,
      "title": "Find related issues",
      "workerType": "research",
      "status": "queued",
      "dependsOn": [],
      "childIssueKey": null,
      "attempt": 0
    }
  ]
}
```

`run` is null and `steps` is empty when the Epic has no run. `status` on a run is `planning`, `running`, `blocked`, `done`, `failed`, or `awaiting-review`. `budget` is the cap (`maxSteps`, `maxModelCalls`, `wallClockMs`) and the measured usage (`usedSteps`, `usedModelCalls`, `usedTokens`, `elapsedMs`, `startedAt`). It is stored. `criticalPath`, `eta`, and `budgetOutlook` are computed from the steps in this response and the caller's clock. They are not stored. `criticalPath.indexes` is the longest chain of remaining work (`dependsOn`, root first). Each step takes 12 minutes unless that step's `input.durationMs` is a positive integer. `summarize` is not on the path. An approval gate that is not done is. `eta.remainingMs` is that chain. `eta.finishAt` is the clock plus `remainingMs`. `budgetOutlook.reasons` is empty, or any of `wall-clock`, `steps`, and `model-calls`. `usedTokens` counts provider usage from chats that ran. A disabled model leaves the call and token counters at 0.

## recall-memory

Success: `{ "ok": true, "memories": [ /* same memory object as recalledMemories */ ], "skillIndex": [ { "name": "research", "description": "one line" } ] }`.

`memories` is at most five rows and at most 1536 bytes of text. `skillIndex` is names and descriptions only. It is not part of that budget, and it does not include the skill body. Each memory includes `scope`. A planner lesson is included only when it is accepted, has a vote, and has a scope; its `text` is the lesson summary. Rows with `supersededBy` set, and rows whose expiry is in the past, are not included. `rovo:mcp` returns this same object because it calls the action.
