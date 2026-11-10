# Ticket Conductor: stop an agent from writing Jira until a person confirms the exact change

## The irreversible action

The action this entry guards is a Jira write the app cannot take back cleanly. One run can create child issues, transition issues, and set scalar fields. The manifest has `write:jira-work` and no delete-issue scope, so a created issue stays. Undo closes it and adds the label `conductor-rolled-back`. A transition is undone only while the issue is still in the status the run left. A field edit is undone only while the issue still holds the values the run wrote. A retry that calls Jira again can duplicate any of those writes. Comments are the exception: undo deletes the comment, and the acknowledgement line does not count them.

The app is an Atlassian Forge app for Jira Cloud. A person asks a Rovo agent to turn an Epic into a plan of at most eight steps. The agent does not write Jira. The effect applier does, after a human grant. Everything reported below ran on Node v22.23.4 against the in-memory store and the in-memory Jira client. No live Jira site and no live model were called.

## Safeguard stack

The stack is identity, authorization, human approval, a preview, and a fail-safe.

**Identity.** `conductor-router` has seven actions. Create, transition, and field edit are not among them. `plan-split` stores a run as `planning`. Only `dispatch-run` and `fork-run` can enqueue Jira work, and both check a grant first. The development webtrigger answers 403 unless `x-dev-secret` matches `DEV_WEBTRIGGER_SECRET`. The Run panel reads the Forge account id from the resolver context. An account id in the payload is ignored (`FS-UNAUTHORIZED`).

**Authorization and approval.** `plan-split`, `get-run-status`, and `handoffGoal` return the acknowledgement line (the blast-radius score and the issue, transition, and field counts) and do not return `confirmToken`. `startRun` calls `authorizeDispatchShared` on every path. `confirm` must be the boolean `true`. The string `"true"`, a missing token, and the public sha256 of the card are refused. The panel mints `v2.<id>.<hmac>` with HMAC-SHA256 under `CONDUCTOR_CONFIRM_SECRET`, or a random process key when that is unset. The grant lasts 15 minutes. `shareGrant` writes the row onto `run.grants`. The token is not stored. The first success compare-and-sets `used`, on the same `updatedAt` condition the status update uses. A second instance with an empty memory map sees that row (`FS-INSTANCE`). A forged mac leaves the row unused (`FS-FORGED`). An expired grant and a grant for a different run are refused (`FS-EXPIRED`, `FS-CROSS-RUN`). A thrown store write refuses the start (`FS-STORE-DOWN`). The panel response omits the token, and the panel payload strips `grants`.

**Preview and fail-safe.** `previewBlastRadius` lists the writes before dispatch. Caps are 8 work steps, 28 model calls, and a wall clock of 8 times 12 minutes. A blown budget sets the run to `blocked`, fails pending forward effects, and the applier refuses a forward effect for a noted run. Undo effects stay queued. A vague goal or a missing epic, goal, or step list stores nothing (`FS-AMBIGUOUS`, `FS-MISSING`). Broken JSON, a payload over 24,000 characters, a numeric `workerType`, and a non-object `setFields` value are rejected before Jira (`FS-MALFORMED`, `FS-OVERSIZED`, `FS-TYPE`). A string `dependsOn`, a newline in the worker type, and a null in the goal are rejected (`FS-EDGE`). Ticket text is fenced as `<untrusted>`, and a closing tag in a summary or comment is stripped. A scripted model that returns `createIssue`, `transition`, `setFields`, and `dispatch-run` still yields one comment (`FS-INJECT-ISSUE`). A call past its deadline fails the row (`FS-TIMEOUT`). A second delivery while the row is `applying` does not call Jira (`FS-INFLIGHT`). A close that transitions and then fails the label write is marked partial and is not transitioned again (`FS-PARTIAL`).

## Evidence

These numbers are from this workspace on Node v22.23.4. `npm audit` reports 0 vulnerabilities.

| Command | Result |
|---|---|
| `npm test` | 366 pass, 1 skipped, 0 fail |
| `npm run safety-eval` | 37 pass, 0 fail |
| `npm run demo:offline` | baseline 6 irreversible writes, guarded 0, 6 of 6 blocked |
| `npm audit` | 0 vulnerabilities |

Eighteen of those rows are the failure matrix, all PASS. `docs/failure-matrix.md` maps each class to the scenario id, the expected behavior, and the observed PASS. `docs/evidence/safety-eval.json` is the machine-readable record from the same command.

The baseline is a scripted agent with a raw mock Jira client and no validator. It creates an issue, transitions `PAY-1`, sets a summary, creates another issue because a ticket comment said to, creates the first issue again with no idempotency key, and PUTs a type-confused field list. That is 6 mutating responses. The guarded run uses the same six intents through `plan-split`, `dispatch-run`, and the effect validator, with no human grant. The write counter on that Jira client stays 0. Codes: `CONFIRMATION_REQUIRED`, `VALIDATION`, and `EFFECT_VALIDATION`.

The challenge cites a study in which frontier agents continued in 40.5% of cases where harm was possible. This repository does not remeasure that study. The 6 and the 0 are the scripted harness. `SAFETY_LIVE_LLM=1` prints a line and does not call a model.

Screenshots of the two commands are `docs/media/safety-eval.svg` and `docs/media/demo-offline.svg`. The full terminal text is the matching `.txt` files.

## Reproduce

Node is pinned to 22.23.4 in `.nvmrc`, `.node-version`, `package.json` `engines`, and CI. A Forge or Atlassian account is not required.

```sh
git clone https://github.com/LeoLin990405/ticket-conductor-safety.git
cd ticket-conductor-safety
npm ci && npm run safety-eval && npm run demo:offline
```

`npm test` and `npm audit` use the same install. CI runs the unit tests, the simulation scenarios, `npm run safety-eval`, and `npm run demo:offline`. A container build is `docker build -t ticket-conductor-safety .` then `docker run --rm ticket-conductor-safety`, which runs the same two commands. `.devcontainer/devcontainer.json` points at that Dockerfile.

The threat model, with assets, actors, the model/panel/server boundary, and a short SAIF map, is `docs/threat-model.md`.

## Limitations

The Jira client is this repository's REST model. A live workflow can reject a transition the mock accepts, or accept a write the mock never sees.

`FS-TIMEOUT` fails the effect row and leaves the HTTP call running. A request Jira has already accepted can still land. A later delivery sees `failed` and does not call Jira again. `FS-PARTIAL` is that case in miniature: one transition is posted, the label write throws, and the transition is not repeated. The issue can sit in Done without the rollback label until a person runs undo.

The used-grant compare-and-set is the run's `updatedAt`. A thrown write refuses the grant. Grants minted inside one process for unit tests and the simulator are enforced in that process and do not write `run.grants`. The panel path always shares.

The account id is the Forge resolver context. There is no second factor, and the app does not prove the panel click and the typed goal belong to the same person.

Undo leaves the issue in place, labelled `conductor-rolled-back`. Memory rows and flight-recorder events stay. A budget stop drains forward effects that are still pending. An effect already `applied` stays applied. `setFields` is scalars only.

`glob` 14.0.4, `minimatch` 11.0.5, and `prosemirror-view` 1.42.9 are forced with `overrides` because they sit under `@forge/*`. `npm audit` is clean on this lockfile.
