import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createMemoryStore, resetStore, setStore } from '../../store/index.js';
import {
  buildEffectEvent,
  configureEffects,
  createForgeQueue,
  effectApplierHandler,
  enqueueCompensations,
  enqueueEffect,
  requestKeyFor,
  resetEffectDependencies,
  retryDelayForFailure,
  retryDelaySeconds,
  MAX_EFFECT_TRIES,
  MAX_RETRY_DELAY_SECONDS,
  parseRetryAfterSeconds,
  combineEffectMetrics,
} from '../index.js';

/**
 * Deterministic clock and ids so applied timestamps and child keys are easy to
 * assert without depending on wall time.
 *
 * @param {number} [start]
 */
function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
    get current() {
      return current;
    },
  };
}

/** @param {string} [prefix] */
function createIds(prefix = 'id') {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

/**
 * A queue fake matching the Forge `Queue.push(event)` surface.
 */
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
 * Build a Jira request fake. `handler(path, init, callNumber)` returns either a
 * fetch Response or a plain object (treated as a successful JSON body).
 *
 * @param {(path: string, init: object, callNumber: number) => any} handler
 */
function createFakeJira(handler) {
  /** @type {Array<{path: string, method: string, body: any}>} */
  const calls = [];
  return {
    calls,
    requestJira: async (path, init = {}) => {
      const call = {
        path,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return handler(path, init, calls.length);
    },
  };
}

/** @param {any} body @param {number} [status] */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Install a fresh memory store plus fake queue/Jira for one test.
 *
 * @param {{requestJira?: Function, queue?: object}} [deps]
 */
function setup(deps = {}) {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now, newId: createIds() });
  setStore(store);
  configureEffects({
    requestJira: deps.requestJira,
    queue: deps.queue,
    logger: null,
    now: clock.now,
  });
  return { clock, store };
}

function teardown() {
  resetEffectDependencies();
  resetStore();
}

/**
 * @param {any} store
 * @returns {Promise<{runId: string, stepId: string}>}
 */
async function seedStep(store) {
  const run = await store.createRun({
    epicKey: 'TC-1',
    projectKey: 'TC',
    goal: 'Ship payment refunds',
    createdBy: 'account-1',
  });
  const [step] = await store.createSteps(run.runId, [
    { title: 'Create child issue', workerType: 'research' },
  ]);
  return { runId: run.runId, stepId: step.stepId };
}

test('requestKeyFor matches the documented sha256 pipe format', () => {
  const expected = createHash('sha256')
    .update('run-1|step-1|createIssue|child-issue', 'utf8')
    .digest('hex');
  assert.equal(
    requestKeyFor({
      runId: 'run-1',
      stepId: 'step-1',
      kind: 'createIssue',
      discriminator: 'child-issue',
    }),
    expected,
  );
  assert.match(expected, /^[0-9a-f]{64}$/);
});

test('requestKeyFor is stable across field order and object discriminator order', () => {
  const first = requestKeyFor({
    runId: 'run-1',
    stepId: 'step-1',
    kind: 'comment',
    discriminator: { b: 2, a: 1 },
  });
  const second = requestKeyFor({
    runId: 'run-1',
    stepId: 'step-1',
    kind: 'comment',
    discriminator: { a: 1, b: 2 },
  });
  assert.equal(first, second);

  const changed = requestKeyFor({
    runId: 'run-1',
    stepId: 'step-2',
    kind: 'comment',
    discriminator: { a: 1, b: 2 },
  });
  assert.notEqual(first, changed);
});

test('requestKeyFor omits an absent step id with an empty segment', () => {
  const expected = createHash('sha256')
    .update('run-1||comment|memory', 'utf8')
    .digest('hex');
  assert.equal(
    requestKeyFor({
      runId: 'run-1',
      kind: 'comment',
      discriminator: 'memory',
    }),
    expected,
  );
});

test('requestKeyFor rejects missing fields and unknown kinds', () => {
  assert.throws(() => requestKeyFor({ stepId: 's', kind: 'comment' }), {
    name: 'EffectValidationError',
  });
  assert.throws(
    () => requestKeyFor({ runId: 'r', stepId: 's', kind: 'deleteIssue' }),
    { name: 'EffectValidationError' },
  );
});

test('duplicate enqueue creates one effect, one queue message, and one Jira mutation', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira(() => jsonResponse({ key: 'TC-2' }));
  const { store } = setup({ queue, requestJira: jira.requestJira });

  try {
    const { runId, stepId } = await seedStep(store);
    const input = {
      runId,
      stepId,
      kind: 'createIssue',
      payload: {
        projectKey: 'TC',
        parentKey: 'TC-1',
        summary: 'Child issue',
        description: 'Created by Ticket Conductor',
        issueType: 'Sub-task',
      },
      discriminator: 'child-issue',
    };

    const results = await Promise.all([
      enqueueEffect(input),
      enqueueEffect(input),
    ]);
    assert.deepEqual(
      results.map((result) => result.created).sort(),
      [false, true],
    );
    assert.equal(results[0].requestKey, results[1].requestKey);
    assert.equal(queue.events.length, 1);
    assert.equal(queue.events[0].body.requestKey, results[0].requestKey);

    // At-least-once delivery: the same queue message is processed twice.
    const first = await effectApplierHandler(queue.events[0]);
    const duplicate = await effectApplierHandler(queue.events[0]);

    assert.equal(jira.calls.length, 1);
    assert.equal(first.status, 'applied');
    assert.equal(duplicate.status, 'applied');
    assert.deepEqual(first.result, { issueKey: 'TC-2' });
    assert.equal(first.tries, 1);

    const storedStep = await store.getStep(stepId);
    assert.equal(storedStep.childIssueKey, 'TC-2');
    assert.equal(storedStep.status, 'queued');
  } finally {
    teardown();
  }
});

test('duplicate enqueue with a changed payload keeps the original effect', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira(() => jsonResponse({ key: 'TC-2' }));
  const { store } = setup({ queue, requestJira: jira.requestJira });

  try {
    const { runId, stepId } = await seedStep(store);
    const base = {
      runId,
      stepId,
      kind: 'createIssue',
      discriminator: 'child-issue',
    };
    const first = await enqueueEffect({
      ...base,
      payload: {
        projectKey: 'TC',
        parentKey: 'TC-1',
        summary: 'Original summary',
        issueType: 'Sub-task',
      },
    });
    const second = await enqueueEffect({
      ...base,
      payload: {
        projectKey: 'TC',
        parentKey: 'TC-1',
        summary: 'Changed summary must not win',
        issueType: 'Sub-task',
      },
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(queue.events.length, 1);

    await effectApplierHandler(queue.events[0]);
    assert.equal(jira.calls.length, 1);
    assert.equal(jira.calls[0].body.fields.summary, 'Original summary');
  } finally {
    teardown();
  }
});

test('createIssue sends project, parent, ADF description, and issue type', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira(() => jsonResponse({ key: 'TC-7' }));
  const { store } = setup({ queue, requestJira: jira.requestJira });

  try {
    const { runId, stepId } = await seedStep(store);
    await enqueueEffect({
      runId,
      stepId,
      kind: 'createIssue',
      payload: {
        projectKey: 'TC',
        parentKey: 'TC-1',
        summary: 'Draft the refund spec',
        description: 'Plain text description',
        issueType: 'Sub-task',
      },
      discriminator: 'child-issue',
    });

    await effectApplierHandler(queue.events[0]);

    assert.equal(jira.calls.length, 1);
    assert.equal(jira.calls[0].method, 'POST');
    assert.equal(jira.calls[0].path, '/rest/api/3/issue');
    assert.deepEqual(jira.calls[0].body.fields.project, { key: 'TC' });
    assert.deepEqual(jira.calls[0].body.fields.parent, { key: 'TC-1' });
    assert.deepEqual(jira.calls[0].body.fields.issuetype, {
      name: 'Sub-task',
    });
    assert.equal(jira.calls[0].body.fields.summary, 'Draft the refund spec');
    assert.equal(
      jira.calls[0].body.fields.description.content[0].content[0].text,
      'Plain text description',
    );
  } finally {
    teardown();
  }
});

test('comment applies bodyText as ADF and stores the comment id', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira(() => jsonResponse({ id: 10001 }));
  const { store } = setup({ queue, requestJira: jira.requestJira });

  try {
    const { runId, stepId } = await seedStep(store);
    const { requestKey } = await enqueueEffect({
      runId,
      stepId,
      kind: 'comment',
      payload: { issueKey: 'TC-2', bodyText: 'Research finished.' },
      discriminator: 'result-comment',
    });

    const effect = await effectApplierHandler(queue.events[0]);

    assert.equal(jira.calls.length, 1);
    assert.equal(
      jira.calls[0].path,
      '/rest/api/3/issue/TC-2/comment',
    );
    assert.equal(
      jira.calls[0].body.body.content[0].content[0].text,
      'Research finished.',
    );
    assert.equal(effect.status, 'applied');
    assert.deepEqual(effect.result, { commentId: '10001' });
    assert.equal(effect.appliedAt, effect.updatedAt);
    assert.equal((await store.getEffect(requestKey)).status, 'applied');
  } finally {
    teardown();
  }
});

test('comment accepts a complete ADF body', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira(() => jsonResponse({ id: 10002 }));
  const { store } = setup({ queue, requestJira: jira.requestJira });

  try {
    const { runId, stepId } = await seedStep(store);
    const bodyAdf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'hello', marks: [{ type: 'strong' }] }],
        },
      ],
    };
    await enqueueEffect({
      runId,
      stepId,
      kind: 'comment',
      payload: { issueKey: 'TC-2', bodyAdf },
      discriminator: 'adf-comment',
    });

    await effectApplierHandler(queue.events[0]);
    assert.deepEqual(jira.calls[0].body.body, bodyAdf);
  } finally {
    teardown();
  }
});

test('transition resolves the workflow id by destination status name', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira((path, init) => {
    if (String(path).endsWith('/transitions') && init.method === 'GET') {
      return jsonResponse({
        transitions: [
          { id: '11', name: 'Start progress', to: { name: 'In Progress' } },
          { id: '31', name: 'Done', to: { name: 'Done' } },
        ],
      });
    }
    if (init.method === 'GET') {
      return jsonResponse({
        key: 'TC-2',
        fields: { status: { name: 'To Do' } },
      });
    }
    return new Response(null, { status: 204 });
  });
  const { store } = setup({ queue, requestJira: jira.requestJira });

  try {
    const { runId, stepId } = await seedStep(store);
    await enqueueEffect({
      runId,
      stepId,
      kind: 'transition',
      payload: { issueKey: 'TC-2', toStatusName: 'done' },
      discriminator: 'transition-done',
    });

    const effect = await effectApplierHandler(queue.events[0]);

    assert.equal(jira.calls.length, 3);
    assert.equal(jira.calls[0].method, 'GET');
    assert.equal(jira.calls[0].path, '/rest/api/3/issue/TC-2');
    assert.equal(jira.calls[1].method, 'GET');
    assert.equal(
      jira.calls[1].path,
      '/rest/api/3/issue/TC-2/transitions',
    );
    assert.equal(jira.calls[2].method, 'POST');
    assert.deepEqual(jira.calls[2].body, { transition: { id: '31' } });
    assert.deepEqual(effect.result, {
      transitionId: '31',
      before: { statusName: 'To Do' },
      after: { statusName: 'done' },
    });
    assert.equal(effect.status, 'applied');
  } finally {
    teardown();
  }
});

test('a retryable Jira failure re-pushes with delay and then succeeds', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira((path, init, callNumber) =>
    callNumber === 1
      ? jsonResponse({ errorMessages: ['boom'] }, 500)
      : jsonResponse({ id: 10003 }),
  );
  const { store } = setup({ queue, requestJira: jira.requestJira });

  try {
    const { runId, stepId } = await seedStep(store);
    const { requestKey } = await enqueueEffect({
      runId,
      stepId,
      kind: 'comment',
      payload: { issueKey: 'TC-2', bodyText: 'retryable' },
      discriminator: 'retry-comment',
    });

    const retrying = await effectApplierHandler(queue.events[0]);
    assert.equal(retrying.status, 'retrying');
    assert.equal(retrying.tries, 1);
    assert.equal(queue.events.length, 2);
    assert.deepEqual(queue.events[1], {
      body: { requestKey },
      delayInSeconds: 5,
    });

    const applied = await effectApplierHandler(queue.events[1]);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.tries, 2);
    assert.deepEqual(applied.result, { commentId: '10003' });
    assert.equal(jira.calls.length, 2);
    assert.equal((await store.getStep(stepId)).status, 'queued');
    // No third push: the retry succeeded.
    assert.equal(queue.events.length, 2);
  } finally {
    teardown();
  }
});

test('five failed tries mark the effect failed, block its step, and stop retrying', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira(() =>
    jsonResponse({ errorMessages: ['permanent boom'] }, 500),
  );
  const { store } = setup({ queue, requestJira: jira.requestJira });

  try {
    const { runId, stepId } = await seedStep(store);
    const { requestKey } = await enqueueEffect({
      runId,
      stepId,
      kind: 'comment',
      payload: { issueKey: 'TC-2', bodyText: 'always fails' },
      discriminator: 'terminal-comment',
    });
    assert.equal(queue.events.length, 1);

    let effect;
    for (let attempt = 1; attempt <= MAX_EFFECT_TRIES; attempt += 1) {
      // Use the latest delivered message. For attempts 1–4 the handler pushes
      // exactly one new message with the retry.
      effect = await effectApplierHandler(queue.events[queue.events.length - 1]);
      assert.equal(effect.tries, attempt);
      if (attempt < MAX_EFFECT_TRIES) {
        assert.equal(effect.status, 'retrying');
        assert.equal(
          queue.events[queue.events.length - 1].delayInSeconds,
          retryDelaySeconds(attempt),
        );
      }
    }

    assert.equal(effect.status, 'failed');
    assert.equal(effect.tries, MAX_EFFECT_TRIES);
    // Initial message + four retry messages; the fifth failure is terminal.
    assert.equal(queue.events.length, MAX_EFFECT_TRIES);
    assert.equal(jira.calls.length, MAX_EFFECT_TRIES);

    const step = await store.getStep(stepId);
    assert.equal(step.status, 'blocked');
    assert.equal(step.error.name, 'EffectApplyError');
    assert.equal(step.error.status, 500);
    assert.match(step.error.message, /status 500/);

    // A late duplicate delivery is a no-op.
    const late = await effectApplierHandler(queue.events[0]);
    assert.equal(late.status, 'failed');
    assert.equal(jira.calls.length, MAX_EFFECT_TRIES);
    assert.equal((await store.getEffect(requestKey)).status, 'failed');
  } finally {
    teardown();
  }
});

test('an applied effect is never re-applied after a duplicate queue event', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira(() => jsonResponse({ key: 'TC-3' }));
  const { store } = setup({ queue, requestJira: jira.requestJira });

  try {
    const { runId, stepId } = await seedStep(store);
    await enqueueEffect({
      runId,
      stepId,
      kind: 'createIssue',
      payload: {
        projectKey: 'TC',
        parentKey: 'TC-1',
        summary: 'Once only',
        issueType: 'Sub-task',
      },
      discriminator: 'child-issue',
    });

    await effectApplierHandler(queue.events[0]);
    await effectApplierHandler(queue.events[0]);
    await effectApplierHandler(queue.events[0]);

    assert.equal(jira.calls.length, 1);
  } finally {
    teardown();
  }
});

test('concurrent duplicate deliveries invoke Jira once', async () => {
  const queue = createFakeQueue();
  let jiraCalls = 0;
  const jira = createFakeJira(() => {
    jiraCalls += 1;
    return jsonResponse({ id: 10004 });
  });
  const { store } = setup({ queue, requestJira: jira.requestJira });

  try {
    const { runId, stepId } = await seedStep(store);
    await enqueueEffect({
      runId,
      stepId,
      kind: 'comment',
      payload: { issueKey: 'TC-2', bodyText: 'concurrent duplicate' },
      discriminator: 'concurrent-comment',
    });

    const results = await Promise.all([
      effectApplierHandler(queue.events[0]),
      effectApplierHandler(queue.events[0]),
      effectApplierHandler({ body: queue.events[0].body }),
    ]);
    assert.equal(jiraCalls, 1);
    for (const result of results) {
      assert.equal(result.status, 'applied');
    }
  } finally {
    teardown();
  }
});

test('a missing effect is ignored instead of failing the consumer', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira(() => jsonResponse({ id: 1 }));
  setup({ queue, requestJira: jira.requestJira });

  try {
    const result = await effectApplierHandler({
      body: { requestKey: 'does-not-exist' },
    });
    assert.equal(result, null);
    assert.equal(jira.calls.length, 0);
  } finally {
    teardown();
  }
});

test('malformed events and payloads fail before writing anything', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira(() => jsonResponse({ id: 1 }));
  const { store } = setup({ queue, requestJira: jira.requestJira });

  try {
    await assert.rejects(effectApplierHandler({ body: {} }), {
      name: 'EffectValidationError',
    });
    await assert.rejects(effectApplierHandler(null), {
      name: 'EffectValidationError',
    });

    const { runId, stepId } = await seedStep(store);
    await assert.rejects(
      enqueueEffect({
        runId,
        stepId,
        kind: 'comment',
        payload: { issueKey: 'TC-2' },
        discriminator: 'missing-body',
      }),
      { name: 'EffectValidationError' },
    );
    assert.equal(queue.events.length, 0);
    assert.deepEqual(await store.listEffectsByStatus('pending'), []);
  } finally {
    teardown();
  }
});

test('effects can be injected per call without configureEffects', async () => {
  const store = createMemoryStore();
  const queue = createFakeQueue();
  const jira = createFakeJira(() => jsonResponse({ id: 20001 }));
  const { runId, stepId } = await seedStep(store);

  const { requestKey } = await enqueueEffect(
    {
      runId,
      stepId,
      kind: 'comment',
      payload: { issueKey: 'TC-2', bodyText: 'per-call deps' },
      discriminator: 'per-call',
    },
    { store, queue },
  );
  const effect = await effectApplierHandler(
    { body: { requestKey } },
    { store, queue, requestJira: jira.requestJira, logger: null },
  );
  assert.equal(effect.status, 'applied');
  assert.equal(jira.calls.length, 1);
});

test('concurrent appliers claim the effect once and call Jira once', async () => {
  const store = createMemoryStore();
  const queue = createFakeQueue();
  const jira = createFakeJira(() => jsonResponse({ id: 20002 }));
  const { runId, stepId } = await seedStep(store);
  const { requestKey } = await enqueueEffect(
    {
      runId,
      stepId,
      kind: 'comment',
      payload: { issueKey: 'TC-2', bodyText: 'once' },
      discriminator: 'concurrent',
    },
    { store, queue },
  );

  const deps = { store, queue, requestJira: jira.requestJira, logger: null };
  const [first, second] = await Promise.all([
    effectApplierHandler({ body: { requestKey } }, deps),
    effectApplierHandler({ body: { requestKey } }, deps),
  ]);

  assert.equal(jira.calls.length, 1);
  const stored = await store.getEffect(requestKey);
  assert.equal(stored.status, 'applied');
  assert.equal(first.status === 'applied' || second.status === 'applied', true);
});

test('retryDelaySeconds uses bounded exponential backoff', () => {
  assert.equal(retryDelaySeconds(1), 5);
  assert.equal(retryDelaySeconds(2), 10);
  assert.equal(retryDelaySeconds(3), 20);
  assert.equal(retryDelaySeconds(4), 40);
  assert.equal(retryDelaySeconds(100), 900);
});

test('Retry-After on a 429 replaces the backoff and is capped at 900 seconds', () => {
  const now = 1_700_000_000_000;
  const rateLimit = { status: 429, retryAfter: '30' };
  assert.equal(retryDelayForFailure(1, rateLimit, now), 30);
  // Shorter than the 5 second backoff. The header still wins.
  assert.equal(retryDelayForFailure(1, { status: 429, retryAfter: '2' }, now), 2);
  assert.equal(retryDelayForFailure(1, { status: 429, retryAfter: '0' }, now), 0);
  assert.equal(
    retryDelayForFailure(1, { status: 429, retryAfter: '5000' }, now),
    MAX_RETRY_DELAY_SECONDS,
  );
  // No header, or a header we cannot read, keeps the backoff.
  assert.equal(retryDelayForFailure(1, { status: 429 }, now), 5);
  assert.equal(retryDelayForFailure(1, { status: 429, retryAfter: 'soon' }, now), 5);
  // A 500 may carry the header. It is not a rate-limit delay.
  assert.equal(retryDelayForFailure(1, { status: 500, retryAfter: '30' }, now), 5);
  const later = new Date(now + 45_000).toUTCString();
  assert.equal(parseRetryAfterSeconds(later, now), 45);
  assert.equal(retryDelayForFailure(2, { status: 429, retryAfter: later }, now), 45);
  // A date in the past means retry immediately, not the 10 second backoff.
  const earlier = new Date(now - 5_000).toUTCString();
  assert.equal(retryDelayForFailure(2, { status: 429, retryAfter: earlier }, now), 0);
});

test('a Jira 429 with Retry-After waits that long and then applies', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira((_path, _init, callNumber) => (
    callNumber === 1
      ? new Response(JSON.stringify({ errorMessages: ['slow down'] }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '30',
        },
      })
      : jsonResponse({ id: '10011' })
  ));
  const { store } = setup({ queue, requestJira: jira.requestJira });
  try {
    const { runId, stepId } = await seedStep(store);
    const { requestKey } = await enqueueEffect({
      runId,
      stepId,
      kind: 'comment',
      payload: { issueKey: 'TC-2', bodyText: 'rate limited' },
      discriminator: 'retry-after',
    });
    const retrying = await effectApplierHandler(queue.events[0]);
    assert.equal(retrying.status, 'retrying');
    assert.equal(retrying.tries, 1);
    assert.equal(queue.events[1].delayInSeconds, 30);
    assert.equal(Object.hasOwn((await store.getRun(runId)).budget, 'effects'), false);

    const applied = await effectApplierHandler(queue.events[1]);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.tries, 2);
    const metrics = combineEffectMetrics(
      await store.listEffectsByRun(runId),
      (await store.getRun(runId)).budget,
      runId,
    );
    assert.deepEqual(metrics, { applied: 1, deduped: 0, retried: 1 });
  } finally {
    teardown();
  }
});

test('a duplicate delivery counts as deduped and does not write the run', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira(() => jsonResponse({ key: 'TC-12' }));
  const { store } = setup({ queue, requestJira: jira.requestJira });
  try {
    const { runId, stepId } = await seedStep(store);
    await enqueueEffect({
      runId,
      stepId,
      kind: 'createIssue',
      payload: {
        projectKey: 'TC',
        parentKey: 'TC-1',
        summary: 'Once',
        issueType: 'Sub-task',
      },
      discriminator: 'child-issue',
    });
    await effectApplierHandler(queue.events[0]);
    const before = await store.getRun(runId);
    await effectApplierHandler(queue.events[0]);
    const after = await store.getRun(runId);
    assert.equal(after.updatedAt, before.updatedAt);
    assert.equal(Object.hasOwn(after.budget, 'effects'), false);
    assert.equal(jira.calls.length, 1);
    const metrics = combineEffectMetrics(
      await store.listEffectsByRun(runId),
      after.budget,
      runId,
    );
    assert.deepEqual(metrics, { applied: 1, deduped: 1, retried: 0 });
  } finally {
    teardown();
  }
});

test('createForgeQueue lazily builds the effect queue and pushes the event', async () => {
  /** @type {Array<{key: string}>} */
  const constructorOptions = [];
  /** @type {Array<object>} */
  const pushed = [];
  const queue = createForgeQueue({
    sdkLoader: async () => ({
      Queue: class FakeQueue {
        constructor(options) {
          constructorOptions.push(options);
        }

        async push(event) {
          pushed.push(event);
          return { jobId: 'job-1' };
        }
      },
    }),
  });

  const event = buildEffectEvent('request-1', 10);
  await queue.push(event);

  assert.deepEqual(constructorOptions, [{ key: 'effect-queue' }]);
  assert.deepEqual(pushed, [
    { body: { requestKey: 'request-1' }, delayInSeconds: 10 },
  ]);
});

// Regression (TD-11): the research worker ran before the step's createIssue
// effect applied, so it had no childIssueKey and dropped its comment.
test('a deferred step comment waits for the child key and posts once', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira((path) =>
    path.endsWith('/comment') ? jsonResponse({ id: 'c1' }) : jsonResponse({ key: 'TC-9' }));
  const { store } = setup({ queue, requestJira: jira.requestJira });
  try {
    const { runId, stepId } = await seedStep(store);
    const comment = {
      runId,
      stepId,
      kind: 'comment',
      payload: { childOfStepId: stepId, bodyText: 'Research: none found' },
      discriminator: 'research-comment',
    };
    await enqueueEffect(comment);
    // Applied before the child exists: no Jira call, re-pushed, still pending.
    const waiting = await effectApplierHandler(queue.events[0]);
    assert.equal(jira.calls.length, 0);
    assert.equal(waiting.status, 'pending');
    assert.equal(queue.events.length, 2);

    await enqueueEffect({
      runId,
      stepId,
      kind: 'createIssue',
      payload: { projectKey: 'TC', parentKey: 'TC-1', summary: 'Child', issueType: 'Task' },
      discriminator: 'child-issue',
    });
    await effectApplierHandler(queue.events[2]);
    assert.equal((await store.getStep(stepId)).childIssueKey, 'TC-9');

    const applied = await effectApplierHandler(queue.events[1]);
    await effectApplierHandler(queue.events[1]); // duplicate delivery
    // A watchdog retry of the worker enqueues the same comment again.
    const again = await enqueueEffect(comment);
    assert.equal(again.created, false);
    assert.equal(applied.status, 'applied');
    const commentCalls = jira.calls.filter((call) => call.path.endsWith('/comment'));
    assert.equal(commentCalls.length, 1);
    assert.match(commentCalls[0].path, /TC-9/);
  } finally {
    teardown();
  }
});

test('a deferred comment whose child issue never appears fails cleanly instead of re-pushing forever', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira(() => jsonResponse({ id: 'c1' }));
  const { store, clock } = setup({ queue, requestJira: jira.requestJira });
  try {
    const { runId, stepId } = await seedStep(store);
    await enqueueEffect({
      runId, stepId, kind: 'comment',
      payload: { childOfStepId: stepId, bodyText: 'Research: none found' },
      discriminator: 'research-comment',
    });
    await effectApplierHandler(queue.events[0]);
    assert.equal(queue.events.at(-1).delayInSeconds, 5);
    clock.advance(2 * 60 * 1000);
    await effectApplierHandler(queue.events[0]);
    assert.equal(queue.events.at(-1).delayInSeconds, 30);
    const pushesBefore = queue.events.length;
    clock.advance(25 * 60 * 1000);
    const result = await effectApplierHandler(queue.events[0]);
    assert.equal(result.status, 'failed');
    assert.equal(result.result.name, 'ChildIssueMissing');
    assert.equal(result.error, undefined);
    assert.equal(queue.events.length, pushesBefore);
    assert.equal(jira.calls.length, 0);
  } finally {
    teardown();
  }
});

test('compensations close a child, record a removed comment, and restore a status once', async () => {
  const queue = createFakeQueue();
  const issue = {
    key: 'TC-9',
    fields: { status: { name: 'To Do' }, labels: ['keep-me'] },
  };
  const epic = {
    key: 'TC-1',
    fields: { status: { name: 'In Progress' }, labels: [] },
  };
  const comments = [{ id: 'c1' }];
  const jira = createFakeJira((path, init) => {
    const method = init.method ?? 'GET';
    if (method === 'DELETE' && String(path).endsWith('/comment/c1')) {
      const index = comments.findIndex((comment) => comment.id === 'c1');
      if (index < 0) return jsonResponse({ errorMessages: ['gone'] }, 404);
      comments.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && String(path).endsWith('/transitions')) {
      return jsonResponse({
        transitions: [
          { id: '11', name: 'To Do', to: { name: 'To Do' } },
          { id: '31', name: 'Done', to: { name: 'Done' } },
        ],
      });
    }
    if (method === 'GET' && String(path).endsWith('/issue/TC-9')) {
      return jsonResponse(issue);
    }
    if (method === 'GET' && String(path).endsWith('/issue/TC-1')) {
      return jsonResponse(epic);
    }
    if (method === 'POST' && String(path).endsWith('/transitions')) {
      const id = String(init.body ? JSON.parse(init.body).transition.id : '');
      const target = String(path).includes('TC-9') ? issue : epic;
      target.fields.status = { name: id === '31' ? 'Done' : 'To Do' };
      return new Response(null, { status: 204 });
    }
    if (method === 'PUT' && String(path).endsWith('/issue/TC-9')) {
      const labels = JSON.parse(init.body).fields.labels;
      issue.fields.labels = labels;
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ errorMessages: [`unexpected ${method} ${path}`] }, 500);
  });
  const { store } = setup({ queue, requestJira: jira.requestJira });

  try {
    const { runId, stepId } = await seedStep(store);
    const forwardKey = requestKeyFor({
      runId,
      stepId,
      kind: 'createIssue',
      discriminator: 'child-issue',
    });
    const commentKey = requestKeyFor({
      runId,
      stepId,
      kind: 'comment',
      discriminator: 'research-comment',
    });
    const [removed, closed, restored] = await enqueueCompensations({
      compensations: [
        {
          kind: 'recordRemovedComment',
          runId,
          stepId,
          discriminator: `undo:comment:${commentKey}`,
          payload: { issueKey: 'TC-9', commentId: 'c1' },
          dependsOnKeys: [],
        },
        {
          kind: 'closeIssue',
          runId,
          stepId,
          discriminator: `undo:createIssue:${forwardKey}`,
          payload: { issueKey: 'TC-9', toStatusName: 'Done', label: 'conductor-rolled-back' },
          dependsOnKeys: [
            requestKeyFor({
              runId,
              stepId,
              kind: 'recordRemovedComment',
              discriminator: `undo:comment:${commentKey}`,
            }),
          ],
        },
        {
          kind: 'restoreStatus',
          runId,
          stepId: null,
          discriminator: 'undo:transition:forward',
          payload: {
            issueKey: 'TC-1',
            toStatusName: 'To Do',
            expectedStatusName: 'In Progress',
          },
        },
      ],
    });

    // Deliver the close before the comment delete. It must wait and not
    // transition the child yet.
    const waiting = await effectApplierHandler({ body: { requestKey: closed.requestKey } });
    assert.equal(waiting.status, 'pending');
    assert.equal(issue.fields.status.name, 'To Do');
    assert.equal(comments.length, 1);
    const closeCalls = jira.calls.filter((call) => call.path.includes('TC-9') && call.method !== 'GET');
    assert.equal(closeCalls.length, 0);

    await effectApplierHandler({ body: { requestKey: removed.requestKey } });
    assert.deepEqual(comments, []);
    const removedAgain = await effectApplierHandler({ body: { requestKey: removed.requestKey } });
    assert.equal(removedAgain.status, 'applied');
    assert.equal(removedAgain.tries, 1);
    const deletes = jira.calls.filter((call) => call.method === 'DELETE');
    assert.equal(deletes.length, 1);

    const closedEffect = await effectApplierHandler(queue.events.find((event) =>
      event.body.requestKey === closed.requestKey && event.delayInSeconds === 5));
    assert.equal(closedEffect.status, 'applied');
    assert.equal(issue.fields.status.name, 'Done');
    assert.deepEqual(issue.fields.labels, ['keep-me', 'conductor-rolled-back']);
    const issueDeletes = jira.calls.filter((call) =>
      call.method === 'DELETE' && !call.path.includes('/comment/'));
    assert.deepEqual(issueDeletes, []);

    const callsBeforeRedelivery = jira.calls.length;
    const redelivered = await effectApplierHandler({ body: { requestKey: closed.requestKey } });
    assert.equal(redelivered.status, 'applied');
    assert.equal(redelivered.tries, 1);
    assert.equal(jira.calls.length, callsBeforeRedelivery);

    const restoredEffect = await effectApplierHandler({ body: { requestKey: restored.requestKey } });
    assert.equal(restoredEffect.status, 'applied');
    assert.equal(restoredEffect.result.skipped, undefined);
    assert.equal(epic.fields.status.name, 'To Do');
    assert.equal(restoredEffect.result.before.statusName, 'In Progress');

    const second = await enqueueCompensations({
      compensations: [
        {
          kind: 'closeIssue',
          runId,
          stepId,
          discriminator: `undo:createIssue:${forwardKey}`,
          payload: { issueKey: 'TC-9', toStatusName: 'Done', label: 'conductor-rolled-back' },
        },
      ],
    });
    assert.equal(second[0].created, false);
    assert.equal(second[0].requestKey, closed.requestKey);
    assert.equal(queue.events.filter((event) => event.body.requestKey === closed.requestKey).length, 2);
  } finally {
    teardown();
  }
});

test('restoreStatus leaves the issue alone when the status has drifted', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira((path, init) => {
    if ((init.method ?? 'GET') === 'GET' && !String(path).endsWith('/transitions')) {
      return jsonResponse({
        key: 'TC-1',
        fields: { status: { name: 'Done' } },
      });
    }
    return jsonResponse({ errorMessages: ['should not transition'] }, 500);
  });
  const { store } = setup({ queue, requestJira: jira.requestJira });

  try {
    const { runId, stepId } = await seedStep(store);
    const { requestKey } = await enqueueEffect({
      runId,
      stepId,
      kind: 'restoreStatus',
      payload: {
        issueKey: 'TC-1',
        toStatusName: 'To Do',
        expectedStatusName: 'In Progress',
      },
      discriminator: 'undo:transition:drift',
    });
    const effect = await effectApplierHandler({ body: { requestKey } });
    assert.equal(effect.status, 'applied');
    assert.equal(effect.result.skipped, true);
    assert.equal(effect.result.reason, 'status-drift');
    assert.equal(jira.calls.length, 1);
    assert.equal(jira.calls[0].method, 'GET');
    const again = await effectApplierHandler({ body: { requestKey } });
    assert.equal(again.tries, 1);
    assert.equal(jira.calls.length, 1);
  } finally {
    teardown();
  }
});

test('a comment delete that is already gone is applied and not posted again', async () => {
  const queue = createFakeQueue();
  const jira = createFakeJira(() => jsonResponse({ errorMessages: ['gone'] }, 404));
  const { store } = setup({ queue, requestJira: jira.requestJira });

  try {
    const { runId, stepId } = await seedStep(store);
    const { requestKey } = await enqueueEffect({
      runId,
      stepId,
      kind: 'recordRemovedComment',
      payload: { issueKey: 'TC-9', commentId: 'c-missing' },
      discriminator: 'undo:comment:missing',
    });
    const effect = await effectApplierHandler({ body: { requestKey } });
    assert.equal(effect.status, 'applied');
    assert.equal(effect.result.commentId, 'c-missing');
    assert.equal(jira.calls.length, 1);
    assert.equal(jira.calls[0].method, 'DELETE');
    assert.equal(jira.calls.some((call) => call.method === 'POST'), false);
  } finally {
    teardown();
  }
});

test('enqueueEffect keeps the pending row when the queue push is refused', async () => {
  let refused = 0;
  const queue = { async push() { refused += 1; throw new Error('400 Bad Request'); } };
  const { store } = setup({ queue });
  try {
    const { runId, stepId } = await seedStep(store);
    const result = await enqueueEffect({
      runId, stepId, kind: 'comment',
      payload: { issueKey: 'TC-1', bodyText: 'hi' },
      discriminator: 'x',
    }, { queue, store, sleep: async () => {} });
    assert.equal(result.created, true);
    assert.equal(result.pushed, false);
    assert.equal(refused, 3);
    assert.equal((await store.getEffect(result.requestKey)).status, 'pending');
  } finally {
    teardown();
  }
});
