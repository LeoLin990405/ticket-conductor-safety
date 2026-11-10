# WP14 — Lead loop, wave digests, and the human pause

The super-agent doc calls this package WP14. Plan-split still saves wave 1. When that wave finishes, the lead reads a digest of about 1 KB and either spawns the next wave, stops, or asks a person. Caps are 3 waves and 8 steps. A short goal adds at most one follow-up. A broad goal may add three. Full step output stays on the child issue. The Epic gets one wave report per wave, in the "report back, you decide" shape.

The model runs inside the step worker, behind the same `<untrusted>` fence as the other workers. The deterministic rules run when the model is unavailable, and on the Jira issue trigger, which is too short for a model call. `ask` sets the run to `awaiting-review`. Reply on the Epic with one line, or transition it:

- `conductor continue` — spawn the steps the lead suggested
- `conductor stop` — stop and summarize
- `conductor spawn: check-deps | Check the unknown dependency` — add that one step
- Transition to **Done** stops. Transition to **In Progress** continues.

The wave report itself starts with `[Conductor wave]`, so it cannot unpause the run. The watchdog does not retry steps while the run is paused.

`run.reviewedThroughWave` is an integer. The review claims it with compare-and-swap. That condition is not the float `updatedAt`. `run.ledger` and `step.wave` are new attributes. Do not remove them after a deploy. The run id and the step id stay entity keys and are not written as attributes. The wave report is a `comment` effect. The applier calls Jira with `assumeTrustedRoute`.

Events on the flight recorder: `wave_started`, `digest_written`, `lead_decision`. The Run panel graph labels each row with its wave. The timeline shows the same three kinds.

## Demo script

About 90 seconds. Do this on the dev site or against `node --test`. Do not deploy to production.

1. Open the Epic and start a one-step research plan whose goal is short, for example "Ship refunds". Point at the graph: every row says **wave 1**. The flight recorder has **Wave started**.
2. Let the step finish with an ordinary "nothing found" result. The lead stops. The Epic comment starts with `[Conductor wave]`, then "Report back, you decide.", then `Decision: stop` and the reason. The run goes to done and the summary comment follows. Say: "A small task that came back clean does not grow a second wave."
3. Run it again, and make the research summary include the words "unknown dependency". A **wave 2** `check-deps` child appears, and its `dependsOn` points at the research step. Open the child. The context is the short digest. The recorder shows **Digest written** and **Lead decision**. Say: "The lead saw about a kilobyte. Jira kept the rest."
4. Force a pause (a step output with `askHuman`, or a third wave that still has a follow-up). The panel says "Report back, you decide." The status lozenge is `awaiting-review`. Comment `conductor continue` or transition the Epic to Done. The run moves again, and the watchdog does not burn a retry while you are reading.
5. Close on the caps. "Three waves, eight steps, and a smaller budget when the goal is small. The model can choose. The rules still finish the run when the model is off."
