# Threat model

This note is the boundary for the irreversible-action work. The asset is a Jira write the app cannot take back cleanly. The tests stay on the in-memory store and the in-memory Jira client.

## Assets

| Asset | Why it matters |
|---|---|
| Jira issues created by a run | The app has no delete-issue scope. Undo closes the child and labels it `conductor-rolled-back`. The issue stays. |
| Status transitions | A transition moves an issue the run may not have created. Undo writes the previous status only while the issue is still in the status the run left. |
| Scalar field edits | `setFields` stores the previous values and `restoreFields` writes them back only while the issue still holds what the run wrote. |
| The confirmation grant | A bearer token for one blast-radius card. It is HMAC-SHA256 under `CONDUCTOR_CONFIRM_SECRET`, expires in 15 minutes, and is single-use. |
| The run row, including `run.grants` | The shared used-token table. The token itself is not stored. |

Comments are reversible: undo deletes the comment. They are outside the acknowledgement line.

## Actors

| Actor | Can |
|---|---|
| Person on the Epic | Open the Run panel. Forge puts their account id on the resolver context. |
| The model behind `conductor-router` or `conductor-handoff` | Call the seven actions. It receives `acknowledgement` and the blast-radius card. It does not receive `confirmToken` or `run.grants`. |
| Another client (MCP, a second Rovo agent) | The same four read and plan tools, plus dispatch only with a grant it does not have. |
| Author of a Jira issue or comment | Put any text on a ticket the worker will read. |
| A second app instance | Read and compare-and-set the same run row. |
| Holder of `DEV_WEBTRIGGER_SECRET` | Call the development webtrigger. The secret is unset in production. The response does not contain the token. |

## Trust boundaries

```text
ticket text          model                 panel                  server
(untrusted)    ->    (untrusted)     ->    (account id)     ->    (store, HMAC, Jira)
                      seven tools          mints the grant         effect applier
                      no token             consumes it here        is the only writer
```

The model is untrusted. Ticket text is data inside `<untrusted>` fences, and a closing tag in that text is stripped before the fence is closed. Tool results omit the token and the grant id. `get-run-status` returns `publicRun`, which has no `grants` field. The panel load strips `grants` before the browser sees the run.

The panel is the human boundary. `approveRun` reads the account id from the Forge resolver context. An account id in the payload is ignored. An empty context refuses. The token is minted and consumed in that invocation and is not on the response.

The server holds the HMAC key and the store. `startRun` is the only way a planning run becomes running, and it calls `authorizeDispatchShared` on every path, including fork. The effect applier is the only code that calls Jira.

## Attacks and the layer that stops them

| Attack | Layer |
|---|---|
| Model calls Jira REST, or calls `setFields` as a tool | Tool list. Those calls are not actions. `FS-TYPE` and `NAIVE-FIELDS`. |
| Dispatch with `confirm: true`, the string `"true"`, or the public card digest | Grant check in `startRun`. The run stays `planning`. |
| Forged HMAC, replay, expired grant, grant from another run | `run.grants` plus the HMAC. `FS-FORGED`, `FS-REPLAY`, `FS-EXPIRED`, `FS-CROSS-RUN`. |
| Replay on a second instance that does not have the process-local map | The used bit is on the run row. `FS-INSTANCE`. |
| Store write throws while marking the grant used | Fail closed. The run stays `planning`. `FS-STORE-DOWN`. |
| Vague goal (`do it`, `fix this`) or a missing epic, goal, or step list | `plan-split` stores nothing. `FS-AMBIGUOUS`, `FS-MISSING`. |
| Malformed, oversized, or type-confused `stepsJson` or field payload | Rejected before a Jira call. `FS-MALFORMED`, `FS-OVERSIZED`, `FS-TYPE`. |
| Ticket summary or comment says to dispatch, create `PWNED`, or transition `PAY-1` | Fence plus the worker, which returns one comment and drops model-supplied effects. `FS-INJECT-ISSUE`. |
| Caller with no account, or the dev webtrigger without the secret | Resolver and webtrigger. `FS-UNAUTHORIZED`. |
| `dependsOn` as a string, a worker type with a newline, a null in the goal | Plan graph and goal check. `FS-EDGE`. |
| Jira call exceeds the deadline, or a second delivery arrives while the first is `applying` | The row fails, or the second delivery sees `applying` and does not call Jira. `FS-TIMEOUT`, `FS-INFLIGHT`. |
| Transition succeeds and the following label write throws | The error is marked partial. The row fails. The transition is not posted again. `FS-PARTIAL`. |
| Wall-clock or model-call budget is already spent | `runBudgetStop` blocks the run and fails pending forward effects. The applier also refuses a forward effect for a noted run. |

## Where this sits against Google SAIF

Google's Secure AI Framework (SAIF) groups agent risk around excessive agency, prompt injection, privilege, cascading failure, and resource exhaustion. The mapping below is only the part this app actually implements.

| SAIF agent risk | What this app does |
|---|---|
| Excessive agency / rogue tool use | The model cannot write Jira. A human grant is required before `startRun` enqueues, and the grant is bound to the blast-radius card. |
| Prompt injection and goal hijacking | Ticket text is fenced. A vague or incomplete goal stores no run. Model JSON cannot add an effect. |
| Privilege compromise | The panel account id comes from the resolver context. The dev webtrigger requires a separate secret and is not a production path. The HMAC key is not in the tool result. |
| Cascading or partial failure | A timed-out or half-applied effect fails closed so the queue does not repeat the Jira call. Undo restores scalars and closes children. |
| Resource exhaustion | Step, model-call, and wall-clock caps stop the run and drain queued forward effects. |

SAIF items this app does not address: training-data poisoning, model theft, and exfiltration of customer content through a channel other than the seven actions. There is no external egress in the manifest. The in-memory tests do not measure a live frontier model. The scripted naive agent is the baseline in `npm run demo:offline`.
