# Scenario 05 — Invalid plan

Written scenario. It has not been run live.

The user is on **Ship payment refunds**. Each case starts with no new run for that attempt. A validation failure does not return a `runId`, does not write `step` rows, and does not push `step-queue`.

Handler rules that are specified today (`planSplit`):

- `stepsJson` is a string. The handler `JSON.parse`s it into `steps[{ title, workerType, input }]`.
- More than 8 steps is rejected.
- An unknown `workerType` is rejected.
- Allowed worker types in the WP3 registry include `research`, `draft-spec`, `check-deps`, and `summarize`.

The prompt asks the agent for 1 to 8 steps (the count the user names, when they name one) and tells it not to plan `summarize`. The handler accepts 1 to 8 steps and rejects 0 or more than 8. `summarize` inside `stepsJson` is a legal `workerType`. The agent should still leave it out, because `recomputeRunStatus` enqueues that worker when the planned steps are `done`.

`createdBy` is read from `ctx`. A `createdBy` value inside `stepsJson` is not an input and does not set the field.

## Case 1 — Nine steps

`stepsJson` is a JSON array of 9 objects, each with `title`, `workerType` `research`, and `input`.

Expected: `planSplit` returns a validation error and no `runId`. The panel is unchanged. The agent shortens the plan to at most 8 and asks the user to confirm again. It does not call `dispatch-run`.

## Case 2 — Unknown worker type

`stepsJson`:

```json
[{"title":"Hand this to a specialist","workerType":"delegate-agent","input":"research the refund API"}]
```

Expected: rejected unknown `workerType`. No run. The agent can offer the same work as `workerType` `research`. It does not describe a second agent.

## Case 3 — Not JSON

`stepsJson` is `not json`.

Expected: parse failure, no run. The agent replaces it with a JSON array string.

## Case 4 — JSON object, or a missing field

`stepsJson` is `{"title":"Find issues","workerType":"research","input":"refunds"}` (one object, not an array).

Also try an array element that omits `input`:

```json
[{"title":"Find issues","workerType":"research"}]
```

Expected: the handler rejects both. The parsed value is not an array of `{ title, workerType, input }`. No run. If a build of `planSplit` accepts a missing `input`, that is a WP5 bug against this scenario. The agent must not send that payload either way.

## Case 5 — Dispatch without a real confirm

A run exists in `planning` (the user asked to save and not run).

- `dispatchRun({ runId, confirm: false })` does not call `startRun`. Status stays `planning`. No `step-queue` push. No `createIssue` effect.
- `dispatchRun` with `confirm` omitted does the same.
- `dispatch-run` with a `runId` that `getRun` does not find returns an error and writes nothing.

The string `"true"` is not the boolean `true`. Treat it as not confirmed unless WP5 documents coercion. This scenario expects no `startRun` call for the string.

## Case 6 — Empty plan from the agent

The user says "Just make one step called Do it."

Expected agent behavior: it explains the minimum of 3 steps and asks what else the Epic needs. It does not call `plan-split` with a one-element `stepsJson`. Handler behavior for a one-element array is not specified beyond the parse shape and the maximum of 8.

## Expected panel and Jira

For cases 1 through 4, no new run appears on the panel and no child issue is created. For case 5, the saved run stays `planning` and the step rows have no `childIssueKey`.
