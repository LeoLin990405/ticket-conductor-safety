# Ticket Conductor — demo video

English spoken script for a finished video of at most 3:00 at 150 words per minute (450 words). Devpost allows 5:00. This cut stays inside the design goal of 3:00. Do not add lines that are not in the narration block. Pauses and cuts have to leave the finished video at or under 3:00.

Category: Apps for Software Teams. Bonus: Best Agents. The picture is the seeded Payments project from [demo/seed.md](../demo/seed.md).

The narration block is the whole spoken script. `tests/scenarios/wp7.test.mjs` counts its words. Shot cues are not spoken.

## Narration

<!-- narration:start -->

Ticket Conductor turns one Rovo chat on a Jira Epic into a supervised run. Jira stays the ledger. The Router only plans and enqueues.

I am on the Epic Ship payment refunds, in the Payments project. I open Rovo and say: Conductor, plan and run this.

The Router may call only plan-split, dispatch-run, get-run-status, recall-memory, and record-decision. It calls recall-memory for the project. Nothing is stored yet. It proposes a short plan, one to eight steps: research the refund issues, draft the refund API so a refund is idempotent on the payment id, check the capture dependency, and draft the one-line ledger rule. It shows each title, worker type, and input, then the stepsJson string it will send. That value is one string. Child issues stay uncreated until I confirm. It asks me to save the plan and start the run.

I say yes. It calls plan-split, then dispatch-run with confirm set to true. The run moves from planning to running. Child issues appear under the Epic. The Run panel shows the goal, a status lozenge, and each step's index, title, worker type, status, and attempt.

The workers are Forge queue consumers. Each one can run for up to fifteen minutes. They run side by side. Every Jira write is an effect. A second delivery with the same requestKey is applied once.

One step is stuck on purpose. A demo variable hangs it a single time. Every five minutes the Watchdog looks for a running step whose deadline has passed, or a queued step whose createdAt is older than ten minutes. It retries with the next attempt. The panel shows that new attempt, and the step then completes.

When the planned steps are done, the app adds a summarize step. The Epic gets one comment whose header is Conductor memory. The decision is stored with memType decision: refunds are idempotent on the payment id, and a duplicate webhook must keep the original ledger line.

I open the related Epic, Reconcile refund ledger, and ask for a plan. recall-memory returns that decision. The new plan follows it. The Router waits for a fresh confirm before dispatch-run.

One chat. A plan you confirm. Parallel work you can see. A watchdog for the step that sticks. Decisions the next Epic can recall.

<!-- narration:end -->

## Shot list

Record on the development site after [demo/seed.md](../demo/seed.md). Set `CONDUCTOR_DEMO_STUCK_STEP` only for the watchdog shot, and do not show the value. The Watchdog's real wait is the `deadlineAt` window plus a `fiveMinute` cycle. Cut from the hung panel to the retried panel. Do not film the wait, and do not add narration to cover it.

Times are a straight read of the narration above at 150 words per minute. The block is 379 words, which is 2:32. Rounding is to the nearest second.

| Time | Picture | Spoken beat |
|---|---|---|
| 0:00–0:10 | Title card, then Jira project Payments. | What Conductor is. Jira is the ledger. The Router plans and enqueues. |
| 0:10–0:18 | Epic **Ship payment refunds**. Open Rovo. The starter "Plan and run this Epic" is visible. Send the primary goal. | The ask. |
| 0:18–0:56 | Router reply: numbered plan, `stepsJson` in a code block, the confirm question. Issue navigator has no new children. | Five actions, empty memory, the plan, confirm before any child issue. |
| 0:56–1:14 | Type "Yes". Reply shows `runId` and status `running`. Children appear. Run panel: lozenge, step tree, attempts at 0. | `plan-split`, then `dispatch-run` with confirm true. Panel fields. |
| 1:14–1:29 | Panel step tree with several rows `running` or `done` together. Effect timeline: one `applied` `createIssue` per step. | Queue consumers, fifteen minute ceiling, parallel steps, one write per `requestKey`. |
| 1:29–1:51 | Cut. Before: one row `running`, attempt 0. After: same row attempt 1, then `done`. Siblings were already moving. | Demo hang, Watchdog rule, retry. |
| 1:51–2:10 | Epic comment whose first line is `[Conductor memory]`. Panel memory section shows `memType` `decision`. | Summarize, the decision text. |
| 2:10–2:22 | Epic **Reconcile refund ledger**. New plan that quotes the decision. Confirm question, no dispatch yet. | Recall on the related Epic. |
| 2:22–2:32 | End card: plan, confirm, parallel steps, watchdog, recall. | Close. |

If the live titles differ from [demo/seed.json](../demo/seed.json) `planSteps`, keep the spoken beats (API, capture, ledger, webhook) and do not read a title that is not on screen.

## What this cut has to show

The five design goals, in order: the ask, a confirmed plan that then creates children, parallel steps on the panel, one stuck step retried and one duplicate `requestKey` applied once, then the Epic memory and a recall on the related Epic.

The Best Agents beat is on screen when the reply stays inside the allowlisted actions and the workers show up as step rows, not as other agents.

## Flight recorder beat

The narration above is the 3-minute plan-and-run cut. A second cut, still under 5 minutes, scrubs the flight recorder, replays the run against today's Jira, and forks from a step. The script and the LangGraph / Temporal / DBOS credit are in [flight-recorder.md](flight-recorder.md). Replay writes nothing. Fork re-runs only the downstream steps.
