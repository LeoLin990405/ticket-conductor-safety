# WP12 demo: a lesson changes the next plan

Run 1 fails for a known reason. Conductor records a lesson and does not apply it yet. A person accepts it on the Lessons tab. Run 2's plan is different and cites that lesson by id.

Project `PAY`. Epic `PAY-1`, goal **Ship payment refunds**.

## Run 1

1. Ask Conductor to plan the Epic with two steps:
   - `Research billing access` (`research`)
   - `Draft the refund spec` (`draft-spec`)
2. Dispatch the run.
3. The research step fails with `Jira 403 missing access to billing-api`.
4. The run is `blocked`.
5. Open the Epic panel, **Lessons** tab.
   - One lesson, status `proposed`, votes `0`, scope `project`.
   - The summary says the last run blocked on missing access to billing-api while working on "Ship payment refunds".
   - `valid from` is set. `validTo` is open. The row is not deleted.

Plan the same goal again before accepting. The plan still starts with research. `usedLessons` is empty. A proposed lesson is not a rule yet.

## Accept

On the Lessons tab, **Accept**.

- Status becomes `accepted`.
- Votes are at least 1. Accept is an upvote.
- Confidence is at least 0.80.
- The previous proposed row is still in storage. It is superseded, not deleted. A replay at the earlier timestamp still returns it (`lessonsAt` / `recall` with `asOf`).

**Reject** would keep the lesson visible and stop the planner from using it. **Downvote** on an accepted lesson that falls below one vote expires it (`validTo` set) and leaves the row in the list.

## Run 2

Plan again with the same two steps and a close goal, **Ship the payment refunds API**.

The stored plan is different:

1. `Check dependencies: missing access to billing-api` (`check-deps`) is first.
2. The research step follows it.
3. The check-deps input cites the lesson: `Lesson <id> (confidence 0.80, scope project): last run failed on missing access to billing-api, so added a check-deps step first.` The clause follows the source outcome: `blocked on`, `failed on`, `needed a watchdog retry on`, or `succeeded and noted:` for a lesson from a successful run's summary.
4. `plan-split` returns `usedLessons: ["<id>"]` and `planCard` with that sentence. `usedMemory` names any other memories that fit the 1.5 KB budget.
5. The Epic gets one comment headed `[Conductor plan]` with the same citation. The Run tab shows it as the plan card. The **Recall** tab lists the citation.

`plan-split` reads two pools: lessons stored on `PAY`, and the global pool (`__global__`). A project lesson outranks a global lesson that matches the same words. Both carry `confidence` and `scope`. A lesson with no scope is not read and cannot be written.

Adding the same failure again does not create a second lesson. The text is deduped. A changed wording is an edit: a new version, the old one kept for replay.
