# README evidence verification — 2026-11-16

## Scope and provenance

- Checked on 2026-11-16 (CST, America/Chicago).
- Source: main commit `882cfebf37df3f3c072585051bee31fe69cbf670`.
- Local runtime: Node `v22.23.3`, npm `10.9.9`, Linux. The repository pins `22.23.4`;
  this review did not rerun on that exact version. `npm ci` emitted `EBADENGINE` and
  upstream React peer-dependency warnings, but exited 0 without changing the lockfile.
- Documentation-only work: no application, test, manifest, dependency, or workflow changes.
- No live model, live Jira writes, production credentials, deployment, or submission-form changes.
  The tests use injected fake clients; the demo uses an in-memory Jira REST model.
- Generated safety report / demo artifacts were refreshed with the actual local Node version.
  Their check results and write counts match the baseline; this is a new run, not a reused total.

## Commands and observed results

`CONDUCTOR_LLM` was unset for the successful test, evaluation, and demo commands below.
No credentials are required for these offline commands. `npm ci` and `npm audit` contact
package-registry infrastructure; "offline" refers to the agent/Jira evaluation, not package installation.

| Command | Exit | Observed result |
|---|---|---|
| `npm ci` | 0 | 400 packages added; 401 packages audited; engine / peer warnings |
| `npm test` | 0 | 367 tests discovered: 366 pass, 1 skipped, 0 fail |
| `npm run safety-eval` | 0 | 37 pass, 0 fail; 18 named failure-matrix cases |
| `npm run demo:offline` | 0 | Baseline 6 irreversible mock writes; guarded 0; 6 of 6 blocked |
| `npm audit` | 0 | `found 0 vulnerabilities` at check time |
| `npm run lint` | 1 | Local Secret Service / keytar unavailable; Forge manifest lint not validated |

Test summary from the successful `npm test` run:

```text
1..367
# tests 367
# suites 0
# pass 366
# fail 0
# cancelled 0
# skipped 1
# todo 0
```

The skipped test is `scenario 03: a second enqueueEffect still pushes the same requestKey`
in `tests/e2e/pipeline.test.mjs`. The test's TODO describes a disagreement between the
written scenario's duplicate-message expectation and the implementation's enqueue-only-on-first-insert
contract. The skip predates this documentation change; it is not a pass. Replay of an actually
queued message is covered by other tests, but that does not resolve this TODO.

The lint error was:

```text
Error: Keytar error detected: The name org.freedesktop.secrets was not provided by any .service files
Something went wrong while accessing Secret Service API.
```

No credential-store workaround or alternate authenticated path was attempted. A successful offline
test run is not a claim that lint, deployment, or live integration passed.

## Failed diagnostic configuration, retained for transparency

An initial attempt explicitly set `CONDUCTOR_LLM=off` to avoid live calls:

- `CONDUCTOR_LLM=off npm test`: exit 1; 348 pass, 18 fail, 1 skipped.
- `CONDUCTOR_LLM=off npm run safety-eval`: exit 1; 35 pass, 2 fail.
  The failed checks were `a full model-call budget does not call the model` (`disabled`)
  and `ticket summary and comment cannot dispatch or add a write`
  (`model prompt kept the closing tag`).

Code review of `src/worker/llm.js`, `src/safety/eval.js`, and `src/safety/failures.js`
showed that this flag disables even injected fake model clients, preventing those assertions
from exercising their intended paths. With the flag unset, the default harness still uses
fake clients, and both commands pass as reported above. No test or guard was modified to
make the rerun pass. The failed configuration is not evidence of a successful injection;
it did not execute the fake model prompt path the assertion expects.

## How to inspect the claims

- [Generated safety rows](safety-eval.md) and [JSON](safety-eval.json).
- [Named failure matrix](../failure-matrix.md) and [scenario code](../../src/safety/failures.js).
- [Demo transcript](../media/demo-offline.txt) and [scripted baseline source](../../src/safety/naiveAgent.js).
- [Grant implementation](../../src/safety/grants.js), [startRun](../../src/run/stateMachine.js),
  [budget stop](../../src/run/budget.js), and [Jira compensation](../../src/effects/jira.js).
- [Threat model](../threat-model.md) and [README limitations](../../README.md#-scope-limits--roadmap).

The six baseline writes are fixed scripted intents, not sampled frontier-model behavior.
The zero guarded writes are for those unapproved/malformed attempts, not all possible runs.
Authorized runs intentionally write Jira. Timeouts do not cancel in-flight HTTP, undo is
compensating rather than transactional, and recorder writes are best-effort rather than a complete, tamper-proof audit system.
