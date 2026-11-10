/**
 * Chaos fault injection (novelty #7).
 *
 * The gate is closed unless the simulator flag or the development flag is
 * set. These tests pass an env object into the worker and the effect
 * applier. They do not set Forge variables and they do not call Jira.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { getRunStatus } from '../../actions/index.js';
import { devDispatchWebtrigger } from '../../dev/devDispatch.js';
import {
  effectApplierHandler,
  enqueueEffect,
  resetEffectDependencies,
} from '../../effects/index.js';
import { loadRun } from '../../resolvers/panelData.js';
import { createMemoryStore, resetStore, setStore } from '../../store/index.js';
import { createWatchdog } from '../../watchdog/index.js';
import {
  registerWorkerType,
  resetWorkerTypes,
  stepWorkerHandler,
  unregisterWorkerType,
} from '../../worker/index.js';
import {
  APP_ENV,
  FAULT_INJECTION_ENV,
  injectFault,
  isFaultInjectionEnabled,
  resetFaultInjection,
  SIMULATION_ENV,
  takeJira429,
  takeKillWorker,
} from '../faults.js';

const SIMULATION = Object.freeze({
  [FAULT_INJECTION_ENV]: 'simulation',
  [SIMULATION_ENV]: '1',
});

const DEVELOPMENT = Object.freeze({
  [FAULT_INJECTION_ENV]: 'development',
  [APP_ENV]: 'development',
});

/**
 * @param {Record<string, string>} [env]
 */
function workerDeps(store, env = {}) {
  /** @type {string[]} */
  const searches = [];
  /** @type {object[]} */
  const effects = [];
  return {
    searches,
    effects,
    deps: {
      store,
      env,
      llm: { disabled: true },
      useForgeRetrieval: false,
      sleep: async () => {},
      enqueueEffect: async (input) => {
        effects.push(input);
        return { requestKey: 'not-a-real-key', created: true };
      },
      enqueueStep: async () => ({ jobId: 'job' }),
      jira: {
        async searchIssues() {
          searches.push('searchIssues');
          return [];
        },
        async getIssueLinks() {
          return [];
        },
      },
      now: () => 1_700_000_000_000,
      logger: { info() {}, warn() {}, error() {} },
    },
  };
}

/**
 * @param {import('../../store/index.js').Store} store
 * @param {string} workerType
 */
async function seedStep(store, workerType) {
  const run = await store.createRun({
    epicKey: 'PAY-1',
    projectKey: 'PAY',
    goal: 'Ship payment refunds',
    createdBy: 'account-1',
  });
  const [step] = await store.createSteps(run.runId, [
    { title: 'Find related issues', workerType, input: 'refunds' },
  ]);
  return { run, step };
}

function createFakeQueue() {
  /** @type {Array<{body: {requestKey: string}, delayInSeconds?: number}>} */
  const events = [];
  return {
    events,
    async push(event) {
      events.push(JSON.parse(JSON.stringify(event)));
      return { jobId: `job-${events.length}` };
    },
  };
}

/**
 * @param {any} body
 * @param {number} [status]
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ENV_KEYS = [
  'DEV_WEBTRIGGER_SECRET',
  FAULT_INJECTION_ENV,
  SIMULATION_ENV,
  APP_ENV,
];

/**
 * @param {Record<string, string|undefined>} next
 */
function withProcessEnv(next) {
  /** @type {Record<string, string|undefined>} */
  const previous = {};
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key];
    if (next[key] === undefined) delete process.env[key];
    else process.env[key] = next[key];
  }
  return () => {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
}

test('fault injection is inert when the simulation or development flag is absent', async () => {
  assert.equal(isFaultInjectionEnabled({}), false);
  assert.equal(isFaultInjectionEnabled({ [FAULT_INJECTION_ENV]: '1' }), false);
  assert.equal(isFaultInjectionEnabled({ [FAULT_INJECTION_ENV]: 'simulation' }), false);
  assert.equal(isFaultInjectionEnabled({ [FAULT_INJECTION_ENV]: 'development' }), false);
  assert.equal(isFaultInjectionEnabled({
    [FAULT_INJECTION_ENV]: 'simulation',
    [SIMULATION_ENV]: '1',
    [APP_ENV]: 'production',
  }), false);
  assert.equal(isFaultInjectionEnabled({
    [FAULT_INJECTION_ENV]: 'development',
    [APP_ENV]: 'staging',
  }), false);
  assert.equal(isFaultInjectionEnabled({
    [FAULT_INJECTION_ENV]: 'development',
    [APP_ENV]: 'production',
  }), false);
  assert.equal(isFaultInjectionEnabled(SIMULATION), true);
  assert.equal(isFaultInjectionEnabled(DEVELOPMENT), true);

  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  const { run, step } = await seedStep(store, 'research');
  // Ask for every fault. The closed gate must not store them.
  assert.deepEqual(injectFault({ type: 'kill-worker', stepId: step.stepId }, {}), {
    armed: false,
    reason: 'disabled',
  });
  assert.deepEqual(injectFault({ type: 'duplicate-effect' }, {}), {
    armed: false,
    reason: 'disabled',
  });
  assert.deepEqual(injectFault({ type: 'jira-429' }, {}), {
    armed: false,
    reason: 'disabled',
  });
  // A fault armed for the simulator must not be consumed by a production env.
  assert.equal(injectFault({ type: 'kill-worker', stepId: step.stepId }, SIMULATION).armed, true);
  assert.equal(takeKillWorker(step, { [APP_ENV]: 'production' }), null);
  assert.ok(takeKillWorker(step, SIMULATION));

  const harness = workerDeps(store, {});
  const finished = await stepWorkerHandler(
    { body: { runId: run.runId, stepId: step.stepId, attempt: 0 } },
    harness.deps,
  );
  assert.equal(finished.status, 'done');
  assert.ok(harness.searches.length > 0);
  assert.ok(harness.effects.length > 0);
  const stored = await store.getStep(step.stepId);
  assert.equal(stored.status, 'done');
  // A closed gate does not grow the run row.
  assert.equal(Object.hasOwn((await store.getRun(run.runId)).budget, 'chaos'), false);

  const queue = createFakeQueue();
  const calls = [];
  const requestJira = async (path, init = {}) => {
    calls.push({ path, method: init.method ?? 'GET' });
    return jsonResponse({ id: 100 });
  };
  try {
    setStore(store);
    const queued = await enqueueEffect({
      runId: run.runId,
      stepId: step.stepId,
      kind: 'comment',
      payload: { issueKey: 'PAY-2', bodyText: 'no fault' },
      discriminator: 'inert-comment',
    }, { store, queue, env: {} });
    assert.equal(queue.events.length, 1);
    const applied = await effectApplierHandler(queue.events[0], {
      store,
      queue,
      requestJira,
      env: {},
      logger: null,
    });
    assert.equal(applied.status, 'applied');
    assert.equal(calls.length, 1);
    assert.equal(queued.created, true);
    // The disabled duplicate request did not add a second message.
    assert.equal(queue.events.length, 1);
    assert.equal(takeJira429(queued.requestKey, {}), null);
    assert.equal(Object.hasOwn((await store.getRun(run.runId)).budget, 'chaos'), false);
  } finally {
    resetEffectDependencies();
    resetStore();
    resetFaultInjection();
  }

  const restore = withProcessEnv({ DEV_WEBTRIGGER_SECRET: 'test-secret' });
  try {
    const refused = await devDispatchWebtrigger({
      headers: { 'x-dev-secret': 'test-secret' },
      body: JSON.stringify({
        injectFault: { type: 'jira-429' },
        runId: 'does-not-exist',
      }),
    });
    assert.equal(refused.statusCode, 200);
    assert.deepEqual(JSON.parse(refused.body), { armed: false, reason: 'disabled' });

    const restoreProd = withProcessEnv({
      DEV_WEBTRIGGER_SECRET: 'test-secret',
      [FAULT_INJECTION_ENV]: 'simulation',
      [SIMULATION_ENV]: '1',
      [APP_ENV]: 'production',
    });
    try {
      const production = await devDispatchWebtrigger({
        headers: { 'x-dev-secret': 'test-secret' },
        body: JSON.stringify({ injectFault: { type: 'kill-worker' } }),
      });
      assert.deepEqual(JSON.parse(production.body), { armed: false, reason: 'disabled' });
    } finally {
      restoreProd();
    }

    // The development flag opens the same webtrigger. A runId in the body
    // must not fall through to startRun (that would 500 on a missing run).
    const restoreDev = withProcessEnv({
      DEV_WEBTRIGGER_SECRET: 'test-secret',
      [FAULT_INJECTION_ENV]: 'development',
      [APP_ENV]: 'development',
    });
    try {
      const armed = await devDispatchWebtrigger({
        headers: { 'x-dev-secret': 'test-secret' },
        body: JSON.stringify({
          injectFault: { type: 'duplicate-effect' },
          runId: 'does-not-exist',
        }),
      });
      assert.equal(armed.statusCode, 200);
      const parsed = JSON.parse(armed.body);
      assert.equal(parsed.armed, true);
      assert.equal(parsed.type, 'duplicate-effect');
    } finally {
      restoreDev();
      resetFaultInjection();
    }
  } finally {
    restore();
    resetFaultInjection();
  }
});

test('kill-worker stops the step after evidence is read and before effects are queued', async () => {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  const { run, step } = await seedStep(store, 'research');
  const harness = workerDeps(store, SIMULATION);
  try {
    assert.equal(
      injectFault({ type: 'kill-worker', stepId: step.stepId }, SIMULATION).armed,
      true,
    );
    const killed = await stepWorkerHandler(
      { body: { runId: run.runId, stepId: step.stepId, attempt: 0 } },
      harness.deps,
    );
    assert.equal(killed.status, 'killed');
    assert.equal(killed.fault, 'kill-worker');
    assert.equal(killed.at, 'after-evidence');
    assert.ok(harness.searches.length > 0);
    assert.equal(harness.effects.length, 0);
    const stored = await store.getStep(step.stepId);
    assert.equal(stored.status, 'running');
    assert.equal(stored.attempt, 0);
    assert.equal(stored.output, undefined);
    assert.deepEqual((await store.getRun(run.runId)).budget.chaos, {
      injected: 1,
      healed: 0,
      duplicateWrites: 0,
    });

    // The same hook accepts the development flag. A second step proves the
    // first kill was consumed and did not leak.
    const again = await seedStep(store, 'research');
    const devHarness = workerDeps(store, DEVELOPMENT);
    assert.equal(injectFault({ type: 'kill-worker' }, DEVELOPMENT).armed, true);
    const devKilled = await stepWorkerHandler(
      { body: { runId: again.run.runId, stepId: again.step.stepId, attempt: 0 } },
      devHarness.deps,
    );
    assert.equal(devKilled.status, 'killed');
    assert.equal(devKilled.at, 'after-evidence');
    assert.equal(devHarness.effects.length, 0);
    assert.equal((await store.getStep(again.step.stepId)).status, 'running');
    assert.deepEqual((await store.getRun(again.run.runId)).budget.chaos, {
      injected: 1,
      healed: 0,
      duplicateWrites: 0,
    });
  } finally {
    resetFaultInjection();
    resetWorkerTypes();
  }
});

test('duplicate-effect delivers one request key twice and Jira writes once', async () => {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  const { run, step } = await seedStep(store, 'research');
  const queue = createFakeQueue();
  const calls = [];
  const requestJira = async () => {
    calls.push('jira');
    return jsonResponse({ key: 'PAY-9' });
  };
  try {
    setStore(store);
    assert.equal(injectFault({ type: 'duplicate-effect' }, SIMULATION).armed, true);
    const queued = await enqueueEffect({
      runId: run.runId,
      stepId: step.stepId,
      kind: 'createIssue',
      payload: {
        projectKey: 'PAY',
        parentKey: 'PAY-1',
        summary: 'Child',
        issueType: 'Story',
      },
      discriminator: 'child-issue',
    }, { store, queue, env: SIMULATION });
    assert.equal(queue.events.length, 2);
    assert.equal(queue.events[0].body.requestKey, queued.requestKey);
    assert.equal(queue.events[1].body.requestKey, queued.requestKey);

    const first = await effectApplierHandler(queue.events[0], {
      store,
      queue,
      requestJira,
      env: SIMULATION,
      logger: null,
    });
    const second = await effectApplierHandler(queue.events[1], {
      store,
      queue,
      requestJira,
      env: SIMULATION,
      logger: null,
    });
    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'applied');
    assert.equal(second.requestKey, first.requestKey);
    assert.equal(calls.length, 1);
    const stored = await store.getRun(run.runId);
    const counters = stored.budget.chaos;
    assert.deepEqual(counters, { injected: 1, healed: 1, duplicateWrites: 0 });
    // The heal write already updates the budget. The dedupe tally rides
    // on that write. It is not a second KVS update.
    assert.deepEqual(stored.budget.effects, { deduped: 1 });
    const status = await getRunStatus({ runId: run.runId });
    assert.deepEqual(status.run.budget.chaos, counters);
    assert.deepEqual(status.run.effectMetrics, { applied: 1, deduped: 1, retried: 0 });
    const panel = await loadRun(run.runId);
    assert.deepEqual(panel.chaos, counters);
    assert.equal(panel.chaos.duplicateWrites, 0);
    assert.deepEqual(panel.effectMetrics, status.run.effectMetrics);
  } finally {
    resetEffectDependencies();
    resetStore();
    resetFaultInjection();
  }
});

test('jira-429 is returned once and the retry then applies the effect', async () => {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  const { run, step } = await seedStep(store, 'research');
  const queue = createFakeQueue();
  const calls = [];
  const requestJira = async () => {
    calls.push('jira');
    return jsonResponse({ id: 10003 });
  };
  /** @type {Array<object>} */
  const warnings = [];
  const logger = {
    info() {},
    error() {},
    warn(_message, details) {
      warnings.push(details);
    },
  };
  try {
    setStore(store);
    assert.equal(
      injectFault({ type: 'jira-429', retryAfterSeconds: 2 }, SIMULATION).armed,
      true,
    );
    const { requestKey } = await enqueueEffect({
      runId: run.runId,
      stepId: step.stepId,
      kind: 'comment',
      payload: { issueKey: 'PAY-2', bodyText: 'rate limit once' },
      discriminator: 'rate-limit',
    }, { store, queue, env: SIMULATION });
    assert.equal(queue.events.length, 1);

    const retrying = await effectApplierHandler(queue.events[0], {
      store,
      queue,
      requestJira,
      env: SIMULATION,
      logger,
    });
    assert.equal(retrying.status, 'retrying');
    assert.equal(retrying.tries, 1);
    assert.equal(calls.length, 0);
    assert.equal(queue.events.length, 2);
    assert.equal(queue.events[1].body.requestKey, requestKey);
    // Retry-After was 2. That replaces the 5 second backoff.
    assert.equal(queue.events[1].delayInSeconds, 2);
    const logged = warnings.find((details) => details?.error?.status === 429);
    assert.ok(logged);
    assert.equal(logged.error.status, 429);

    const applied = await effectApplierHandler(queue.events[1], {
      store,
      queue,
      requestJira,
      env: SIMULATION,
      logger,
    });
    assert.equal(applied.status, 'applied');
    assert.deepEqual(applied.result, { commentId: '10003' });
    assert.equal(calls.length, 1);
    assert.equal((await store.getStep(step.stepId)).status, 'queued');
    assert.deepEqual((await store.getRun(run.runId)).budget.chaos, {
      injected: 1,
      healed: 1,
      duplicateWrites: 0,
    });
  } finally {
    resetEffectDependencies();
    resetStore();
    resetFaultInjection();
  }
});

test('a worker that skips the checkpoint is still killed before its effects are queued', async () => {
  registerWorkerType('chaos-probe', async (step, ctx) => {
    await ctx.jira.searchIssues('project = PAY');
    return {
      output: { summary: 'should not be stored' },
      effects: [{
        kind: 'comment',
        payload: { issueKey: 'PAY-2', bodyText: 'late' },
        discriminator: 'late',
      }],
    };
  });
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  const { run, step } = await seedStep(store, 'chaos-probe');
  const harness = workerDeps(store, SIMULATION);
  try {
    injectFault({ type: 'kill-worker', stepId: step.stepId }, SIMULATION);
    const killed = await stepWorkerHandler(
      { body: { runId: run.runId, stepId: step.stepId, attempt: 0 } },
      harness.deps,
    );
    assert.equal(killed.status, 'killed');
    assert.equal(killed.at, 'before-effects');
    assert.equal(harness.effects.length, 0);
    assert.equal((await store.getStep(step.stepId)).status, 'running');
    assert.deepEqual((await store.getRun(run.runId)).budget.chaos, {
      injected: 1,
      healed: 0,
      duplicateWrites: 0,
    });
  } finally {
    unregisterWorkerType('chaos-probe');
    resetWorkerTypes();
    resetFaultInjection();
  }
});

test('watchdog retry heals a kill and does not count a normal stuck step', async () => {
  const now = 1_700_000_000_000;
  const store = createMemoryStore({ now: () => now });
  const { run, step } = await seedStep(store, 'research');
  const harness = workerDeps(store, SIMULATION);
  const other = await seedStep(store, 'research');
  /** @type {object[]} */
  const pushes = [];
  try {
    assert.equal(injectFault({ type: 'kill-worker', stepId: step.stepId }, SIMULATION).armed, true);
    const killed = await stepWorkerHandler(
      { body: { runId: run.runId, stepId: step.stepId, attempt: 0 } },
      harness.deps,
    );
    assert.equal(killed.status, 'killed');
    // A second step is overdue for an ordinary reason. The gate is open,
    // but nothing killed it, so its run must not grow a chaos object.
    await store.updateStep(other.step.stepId, {
      status: 'running',
      deadlineAt: now - 1,
      attempt: 0,
    });
    const watchdog = createWatchdog({
      store,
      env: SIMULATION,
      now: () => now + (12 * 60 * 1000) + 1,
      logger: { info() {}, warn() {}, error() {} },
      pushStep: async (body) => {
        pushes.push(body);
      },
      pushEffect: async () => {},
    });
    const summary = await watchdog.run();
    assert.equal(summary.retriedSteps.length, 2);
    assert.equal(summary.errors.length, 0);
    assert.equal(pushes.length, 2);
    assert.deepEqual((await store.getRun(run.runId)).budget.chaos, {
      injected: 1,
      healed: 1,
      duplicateWrites: 0,
    });
    assert.equal((await store.getStep(step.stepId)).attempt, 1);
    assert.equal(Object.hasOwn((await store.getRun(other.run.runId)).budget, 'chaos'), false);
    assert.equal((await store.getStep(other.step.stepId)).attempt, 1);
  } finally {
    resetWorkerTypes();
    resetFaultInjection();
  }
});

test('a second Jira write increments duplicateWrites only while the gate is open', async () => {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  const { run, step } = await seedStep(store, 'research');
  const queue = createFakeQueue();
  let calls = 0;
  const requestJira = async () => {
    calls += 1;
    return jsonResponse({ key: 'PAY-9' });
  };
  const effectInput = {
    runId: run.runId,
    stepId: step.stepId,
    kind: 'createIssue',
    payload: {
      projectKey: 'PAY',
      parentKey: 'PAY-1',
      summary: 'Child',
      issueType: 'Story',
    },
    discriminator: 'child-issue',
  };
  try {
    setStore(store);
    const closed = await enqueueEffect(effectInput, { store, queue, env: {} });
    await effectApplierHandler(queue.events[0], {
      store,
      queue,
      requestJira,
      env: {},
      logger: null,
    });
    // Re-open the row so the applier will call Jira again. The gate is
    // closed, so the second mutation must not store a counter.
    await store.updateEffect(closed.requestKey, { status: 'pending' });
    await effectApplierHandler(queue.events[0], {
      store,
      queue,
      requestJira,
      env: {},
      logger: null,
    });
    assert.equal(calls, 2);
    assert.equal(Object.hasOwn((await store.getRun(run.runId)).budget, 'chaos'), false);

    calls = 0;
    resetFaultInjection();
    const open = await seedStep(store, 'research');
    const openQueue = createFakeQueue();
    const queued = await enqueueEffect({
      ...effectInput,
      runId: open.run.runId,
      stepId: open.step.stepId,
      discriminator: 'child-issue-open',
    }, { store, queue: openQueue, env: SIMULATION });
    await effectApplierHandler(openQueue.events[0], {
      store,
      queue: openQueue,
      requestJira,
      env: SIMULATION,
      logger: null,
    });
    assert.equal(calls, 1);
    assert.equal(Object.hasOwn((await store.getRun(open.run.runId)).budget, 'chaos'), false);
    await store.updateEffect(queued.requestKey, { status: 'pending' });
    await effectApplierHandler(openQueue.events[0], {
      store,
      queue: openQueue,
      requestJira,
      env: SIMULATION,
      logger: null,
    });
    assert.equal(calls, 2);
    assert.deepEqual((await store.getRun(open.run.runId)).budget.chaos, {
      injected: 0,
      healed: 0,
      duplicateWrites: 1,
    });
  } finally {
    resetEffectDependencies();
    resetStore();
    resetFaultInjection();
  }
});
