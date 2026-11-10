# WP4 — Watchdog

Scheduled retry of stuck steps and stale effects. The package owns
`src/watchdog/` only; WP1 storage and the WP2/WP3 queue contracts are injected.

## Public entry points (`src/watchdog/index.js`)

```js
watchdogHandler()                    // scheduledTrigger fiveMinute
createWatchdogHandler(dependencies)  // handler with injected deps
createWatchdog(dependencies)         // returns { run() } for one pass
```

A pass:

1. Calls `store.findStuckSteps(now)`. For each step it re-reads the row so a
   step that finished after the index snapshot is skipped.
2. If `attempt < 3`: sets `status: 'queued'` (the state WP3's worker
   claims), `attempt + 1`, a new `deadlineAt = now + 12 min`, and pushes
   `{runId, stepId, attempt}` to `step-queue`.
3. If `attempt >= 3`: sets the step `failed` with a structured
   `WATCHDOG_ATTEMPTS_EXHAUSTED` error, marks the run `blocked` using WP1's
   optimistic `updateRun`, and enqueues one Epic `comment` effect with
   discriminator `watchdog-blocked`.
4. Lists effects in `pending` and `retrying`, and re-pushes
   `{requestKey}` for rows whose `updatedAt` is older than five minutes.

The pass returns a JSON summary (`retriedSteps`, `failedSteps`,
`skippedSteps`, `repushedEffects`, `errors`) for logs and tests.

## Dependencies

```js
createWatchdog({
  store,        // WP1 Store (createMemoryStore() in tests)
  pushStep,     // async ({runId, stepId, attempt}) => void  (WP3 contract)
  pushEffect,   // async ({requestKey}) => void             (WP2 contract)
  enqueueEffect,// optional WP2 async (input) => {requestKey, created}
  now,          // optional clock
  env,          // optional environment object
  logger,       // optional console-like logger
  concurrency,  // optional, default 10
})
```

When `enqueueEffect` is not supplied, `createStoreEffectEnqueuer` writes the
effect with `store.putEffectIfAbsent` and only pushes when it created the row.
It uses the documented WP2 key:
`sha256(`${runId}|${stepId}|${kind}|${discriminator}`)`, lowercase hex. WP9 can
inject WP2's real `enqueueEffect` to share one implementation.

`@forge/events` is imported lazily by `createForgeQueuePusher`, so the unit
tests need no extra install. Tests inject recorder functions instead.

## Demo flag

`CONDUCTOR_DEMO_STUCK_STEP` is a Forge variable. Any non-empty value selects
step index 0 (`1`, `true`, and `*` included); a decimal value of 2 or more
(`2`) selects that index. The helper `shouldDemoHang(step, env)` returns true
only for a running step on attempt 0, so the hang happens once.
`demoHangDelayMs(step)` sleeps past `deadlineAt`.

WP3 integration: after marking the step running, call `shouldDemoHang`; when
true, await `demoHangDelayMs` and return without calling `reportStep`, leaving
the step `running` so the watchdog retries it at attempt 1. The watchdog does
not hang workers itself because WP3 owns the worker.

## Manifest

See `watchdog.manifest.yml`. WP9 merges the `scheduledTrigger` and `function`
entries. No new scopes are needed.
