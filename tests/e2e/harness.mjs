/**
 * End-to-end harness.
 *
 * Wires the real WP1 Forge adapter, WP2 effect queue, WP3 state machine and
 * step worker, WP4 watchdog, and WP6 memory to the fakes in `./fakes.mjs`.
 * A test drives the queues itself: nothing is deployed and nothing sleeps on
 * the watchdog's five-minute schedule. The clock is advanced explicitly.
 *
 * Module singletons (`setStore`, `configureEffects`, the in-process step lock)
 * are process-wide, so tests in one file must not overlap. `testSerial`
 * queues them. Each file gets its own Node process under `node --test`.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  configureEffects,
  effectApplierHandler,
  enqueueEffect,
  resetEffectDependencies,
} from '../../src/effects/index.js';
import { resetMemory } from '../../src/memory/index.js';
import { STEP_DEADLINE_MS } from '../../src/run/dependencies.js';
import { resetLocks } from '../../src/run/locks.js';
import { startApproved } from '../../src/run/__tests__/harness.js';
import { createFakeForgeSdk } from '../../src/store/__tests__/fakeForgeKvs.js';
import {
  createForgeStore,
  resetStore,
  setStore,
} from '../../src/store/index.js';
import { resetWorkerTypes, stepWorkerHandler } from '../../src/worker/index.js';
import { createWatchdog } from '../../src/watchdog/index.js';
import { RETRY_DEADLINE_MS } from '../../src/watchdog/constants.js';

import {
  createForgeEventSdk,
  createFakeJira,
  createWorkerJira,
  seedJiraIssues,
  DEMO_KEYS,
} from './fakes.mjs';

export {
  DEMO_KEYS,
  INJECTION_TOKEN,
  MEMORY_COMMENT_HEADER,
  PROMPT_INJECTION,
  WATCHDOG_COMMENT_HEADER,
} from './fakes.mjs';

export { STEP_DEADLINE_MS, RETRY_DEADLINE_MS };

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

/**
 * @returns {object} Parsed `demo/seed.json`.
 */
export function loadSeed() {
  const url = new URL('../../demo/seed.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/**
 * @param {string} relativePath Path from the repository root.
 * @returns {string}
 */
export function readProjectFile(relativePath) {
  const url = new URL(`../../${relativePath}`, import.meta.url);
  return readFileSync(url, 'utf8');
}

/**
 * @param {number} [start]
 * @returns {{now: number, advance: (ms: number) => number}}
 */
function createClock(start = 1_700_000_000_000) {
  const clock = {
    now: start,
    /**
     * @param {number} ms
     * @returns {number}
     */
    advance(ms) {
      this.now += ms;
      return this.now;
    },
  };
  return clock;
}

/**
 * Install one isolated Conductor world.
 *
 * `poison: true` copies the adversarial strings into the seeded Jira issues
 * so research/check-deps echo them back as issue text.
 *
 * @param {{poison?: boolean, start?: number}} [options]
 * @returns {Promise<object>}
 */
export async function createWorld(options = {}) {
  const seed = loadSeed();
  const clock = createClock(options.start);
  const bus = createForgeEventSdk();
  const jira = createFakeJira({
    issues: seedJiraIssues(seed, { poison: options.poison }),
  });
  const sdk = createFakeForgeSdk();
  let sequence = 0;
  const store = createForgeStore({
    sdk,
    now: () => clock.now,
    // Fixed ids keep failure output readable. The shape is a uuid v4 so the
    // store's own generator is the only thing we are not exercising.
    newId: () =>
      `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
  });

  // The Forge adapter is the store the rest of the app sees. Tests that
  // forget and call getStore() still hit this fake, not a real install.
  setStore(store);

  const effectQueue = createForgeQueueFor(bus);
  configureEffects({
    store,
    queue: effectQueue,
    requestJira: jira.requestJira,
    logger: silentLogger,
  });

  /**
   * @param {{runId: string, stepId: string, attempt: number}} payload
   */
  async function enqueueStep(payload) {
    const queue = new bus.Queue({ key: 'step-queue' });
    return queue.push({ body: payload });
  }

  /** @param {object} input */
  function enqueue(input) {
    return enqueueEffect(input, { store, queue: effectQueue });
  }

  const dependencies = {
    store,
    enqueueEffect: enqueue,
    enqueueStep,
    jira: createWorkerJira(jira.requestJira),
    now: () => clock.now,
    logger: silentLogger,
    // The demo hang computes a 12-minute sleep. Tests advance the clock
    // instead of waiting. Production uses the real timer from dependencies.js.
    sleep: async () => {},
    env: process.env,
  };

  const watchdog = createWatchdog({
    store,
    pushStep: async (body) => {
      const queue = new bus.Queue({ key: 'step-queue' });
      return queue.push({ body });
    },
    pushEffect: async (body) => {
      const queue = new bus.Queue({ key: 'effect-queue' });
      return queue.push({ body });
    },
    enqueueEffect: enqueue,
    now: () => clock.now,
    logger: silentLogger,
    env: process.env,
  });

  const memoryDeps = {
    store,
    enqueueEffect: enqueue,
    now: () => clock.now,
  };

  const previousFetch = globalThis.fetch;
  const previousDemo = process.env.CONDUCTOR_DEMO_STUCK_STEP;
  /** @type {string[]} */
  const fetches = [];
  globalThis.fetch = async (input) => {
    const target = typeof input === 'string' ? input : String(input?.url ?? input);
    fetches.push(target);
    throw new Error(
      `Ticket Conductor e2e forbids fetch(${target}). Ticket text is data, not a URL to load.`,
    );
  };

  return {
    seed,
    clock,
    bus,
    jira,
    sdk,
    store,
    dependencies,
    watchdog,
    memoryDeps,
    fetches,
    async drainEffects() {
      let guard = 0;
      while (bus.size('effect-queue') > 0) {
        guard += 1;
        if (guard > 40) {
          throw new Error(
            `effect-queue did not drain (${bus.size('effect-queue')} event(s) left). ` +
              'A retry loop should stop at five tries.',
          );
        }
        await effectApplierHandler(bus.shift('effect-queue'));
      }
    },
    /**
     * Apply every queued effect, then run one step, and repeat.
     * Effects are preferred so a `createIssue` lands before the worker that
     * comments on the new child issue. Summarize is enqueued by the last
     * planned step and is picked up by a later iteration of this loop.
     *
     * @returns {Promise<object[]>}
     */
    async drainAll() {
      /** @type {object[]} */
      const stepResults = [];
      let guard = 0;
      while (bus.size('effect-queue') > 0 || bus.size('step-queue') > 0) {
        guard += 1;
        if (guard > 80) {
          throw new Error(
            `queues did not drain (effects=${bus.size('effect-queue')} steps=${bus.size('step-queue')})`,
          );
        }
        if (bus.size('effect-queue') > 0) {
          await effectApplierHandler(bus.shift('effect-queue'));
        } else {
          stepResults.push(
            await stepWorkerHandler(bus.shift('step-queue'), dependencies),
          );
        }
      }
      return stepResults;
    },
    /**
     * Run the next step event. Throws if an effect is still waiting, so a
     * test cannot accidentally start a worker before its child issue exists
     * unless it drained effects first on purpose.
     */
    async processNextStep() {
      if (bus.size('effect-queue') > 0) {
        throw new Error(
          'processNextStep called while effect-queue still has events; drainEffects() first',
        );
      }
      const event = bus.shift('step-queue');
      if (!event) {
        return undefined;
      }
      return stepWorkerHandler(event, dependencies);
    },
    async close() {
      resetWorkerTypes();
      resetLocks();
      resetStore();
      resetEffectDependencies();
      resetMemory();
      globalThis.fetch = previousFetch;
      if (previousDemo === undefined) {
        delete process.env.CONDUCTOR_DEMO_STUCK_STEP;
      } else {
        process.env.CONDUCTOR_DEMO_STUCK_STEP = previousDemo;
      }
    },
  };
}

/**
 * Lazy Forge queue adapter aimed at the in-memory bus.
 * Mirrors `createForgeQueue`: the SDK is loaded on the first push, then one
 * `Queue` instance is reused.
 *
 * @param {ReturnType<typeof createForgeEventSdk>} bus
 * @returns {{push: Function}}
 */
function createForgeQueueFor(bus) {
  /** @type {object|null} */
  let queue = null;
  return {
    /**
     * @param {object} event
     */
    async push(event) {
      if (!queue) {
        queue = new bus.Queue({ key: 'effect-queue' });
      }
      return queue.push(event);
    },
  };
}

/**
 * Create a planned run and its steps. Does not dispatch.
 * Jira and both queues must still be idle afterwards: saving a plan is not
 * a mutation.
 *
 * @param {object} world
 * @param {{goal: string, steps: object[], epicKey?: string}} input
 */
export async function savePlan(world, input) {
  const epicKey = input.epicKey ?? DEMO_KEYS.refundsEpic;
  const run = await world.store.createRun({
    epicKey,
    projectKey: DEMO_KEYS.projectKey,
    goal: input.goal,
    createdBy: 'account-demo',
  });
  const steps = await world.store.createSteps(run.runId, input.steps);
  return { run, steps };
}

/**
 * `startRun` plus a full drain of both queues.
 *
 * @param {object} world
 * @param {string} runId
 */
export async function dispatchAndDrain(world, runId) {
  const started = await startApproved(runId, world.dependencies);
  const stepResults = await world.drainAll();
  return { started, stepResults };
}

/**
 * The Jira writes a finished planned run is allowed to perform.
 *
 * - one `createIssue` per planned step, parented to the Epic
 * - comments only on those new children, one Epic memory comment, and the
 *   wave reports (`[Conductor wave]`) the lead posts after each finished wave
 * - no transitions, no `fetch`, no URL that is not Jira REST
 *
 * @param {object} world
 * @param {{epicKey: string, plannedTitles: string[], descriptionIncludes?: string}} expected
 */
export function assertNoUnapprovedEffects(world, expected) {
  const creates = world.jira.mutationsOf('createIssue');
  const titles = creates.map((mutation) => mutation.summary).sort();
  const wanted = [...expected.plannedTitles].sort();
  if (titles.length !== wanted.length || titles.some((title, index) => title !== wanted[index])) {
    throw new Error(
      `createIssue titles ${JSON.stringify(titles)} did not match ${JSON.stringify(wanted)}`,
    );
  }
  for (const create of creates) {
    if (create.parentKey !== expected.epicKey) {
      throw new Error(
        `createIssue ${create.issueKey} parent ${create.parentKey} is not ${expected.epicKey}`,
      );
    }
    if (create.projectKey !== DEMO_KEYS.projectKey) {
      throw new Error(`createIssue ${create.issueKey} is not in PAY`);
    }
    if (
      expected.descriptionIncludes &&
      !create.descriptionText.includes(expected.descriptionIncludes)
    ) {
      throw new Error(
        `createIssue ${create.summary} description dropped the injected text`,
      );
    }
  }

  const childKeys = new Set(creates.map((create) => create.issueKey));
  const comments = world.jira.mutationsOf('comment');
  const epicComments = [];
  for (const comment of comments) {
    if (comment.issueKey === expected.epicKey) {
      epicComments.push(comment);
      const allowed = comment.bodyText.startsWith('[Conductor memory]')
        || comment.bodyText.startsWith('[Conductor wave]');
      if (!allowed) {
        throw new Error(
          `Epic comment ${comment.commentId} is not a memory write-back or a wave report: ${comment.bodyText.slice(0, 80)}`,
        );
      }
    } else if (!childKeys.has(comment.issueKey)) {
      throw new Error(
        `comment ${comment.commentId} landed on ${comment.issueKey}, which this run did not create`,
      );
    }
  }
  const memoryComments = epicComments.filter((comment) =>
    comment.bodyText.startsWith('[Conductor memory]'),
  );
  const waveComments = epicComments.filter((comment) =>
    comment.bodyText.startsWith('[Conductor wave]'),
  );
  if (memoryComments.length !== 1) {
    throw new Error(
      `expected one Epic memory comment, found ${memoryComments.length}`,
    );
  }
  if (waveComments.length < 1) {
    throw new Error('expected a wave report on the Epic');
  }

  const transitions = world.jira.mutationsOf('transition');
  if (transitions.length !== 0) {
    throw new Error(
      `ticket text caused ${transitions.length} transition(s): ${JSON.stringify(transitions)}`,
    );
  }

  for (const call of world.jira.calls) {
    if (!call.pathname.startsWith('/rest/api/3/')) {
      throw new Error(`unexpected Jira path ${call.path}`);
    }
  }
  if (world.fetches.length !== 0) {
    throw new Error(`fetch was called: ${world.fetches.join(', ')}`);
  }
}

/**
 * Queue tests so they share the process-wide store and lock singletons
 * without overlapping. Register every test in a file through this helper.
 *
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
let chain = Promise.resolve();
export function testSerial(name, fn) {
  const run = chain.then(() => fn());
  // Attach a handler now. The test runner awaits `run` later; without this,
  // a fast failure during import would be an unhandled rejection.
  chain = run.then(
    () => {},
    () => {},
  );
  test(name, () => run);
}
