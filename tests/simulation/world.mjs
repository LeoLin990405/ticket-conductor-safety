/**
 * One simulated Forge installation.
 *
 * The world installs the real store adapter on top of {@link createSimulationKvs},
 * points the effects queue and the step queue at the in-memory bus, and hands
 * the real action functions, step worker, and watchdog that bus. `fetch` is
 * replaced so a stray network call fails the scenario.
 *
 * Rovo invocation goes through the same functions the manifest names
 * (`planSplit`, `dispatchRun`, and the rest). The Forge action wrapper only
 * forwards `(payload, context)`. There is no Forge container here, so the
 * simulator passes the in-memory runtime as the third argument those
 * functions already accept in tests. Errors are returned as
 * `{ok:false, error, code}`, which is what `actionHandler` does at the
 * boundary.
 *
 * @module tests/simulation/world
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  dispatchRun,
  forkRun,
  getRunStatus,
  planSplit,
  recallMemory,
  recordDecision,
  replayRun,
} from '../../src/actions/index.js';
import { handoffGoal } from '../../src/actions/handoff.js';
import { issueDispatchGrant, issueForkGrant, issueHumanConfirmation } from '../../src/safety/grants.js';
import {
  configureEffects,
  effectApplierHandler,
  enqueueEffect,
  leftoverEffectDependencies,
  resetEffectDependencies,
} from '../../src/effects/index.js';
import { memoryServiceIsCached, resetMemory } from '../../src/memory/index.js';
import { pendingLockCount, resetLocks } from '../../src/run/locks.js';
import { resetStore, setStore, createForgeStore, storeIsInstalled } from '../../src/store/index.js';
import { hasCachedLlmModel, resetLlmCache } from '../../src/worker/llm.js';
import { listWorkerTypes, resetWorkerTypes, stepWorkerHandler } from '../../src/worker/index.js';
import { hasSkillModel, resetSkillModel } from '../../src/skills/index.js';
import { faultInjectionResidue, resetFaultInjection } from '../../src/chaos/faults.js';
import { childIssueUpdated } from '../../src/triggers/childIssueUpdated.js';
import { createWatchdog } from '../../src/watchdog/index.js';

import {
  createClock,
  createFakeConfluence,
  createFakeJira,
  createFakeLlm,
  createQueueBus,
  createSimulationKvs,
  createWorkerJira,
  DEMO_PAGES,
  seedJiraIssues,
} from './fakes.mjs';

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

/**
 * Action key in the manifest → the function that implements it.
 * The keys are what another agent (and `rovo:mcp`) invoke.
 */
const ROVO_ACTIONS = Object.freeze({
  'plan-split': planSplit,
  'dispatch-run': dispatchRun,
  'get-run-status': getRunStatus,
  'recall-memory': recallMemory,
  'record-decision': recordDecision,
  'replay-run': replayRun,
  'fork-run': forkRun,
});

/**
 * @returns {object}
 */
export function loadSeed() {
  const url = new URL('../../demo/seed.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/**
 * @param {object} [options]
 * @param {boolean} [options.poison] Copy the injection strings onto seeded issues.
 * @param {boolean} [options.failSearch] Research search throws the billing-api error.
 * @param {{mode?: string, error?: string, reply?: Function}|null} [options.llm]
 *   `null` installs `{disabled:true}` so workers stay on the template and do
 *   not call `chat`. Omit it for the same default.
 * @param {Record<string, string>} [options.env]
 */
/**
 * `fetch` as this process found it. A world replaces it so a stray network
 * call fails the scenario, and `close()` puts this function back. The next
 * world checks the replacement is gone. Scenarios share one process, so a
 * leftover replacement would make a later scenario's network guard the
 * previous world's function.
 */
const originalFetch = globalThis.fetch;

/**
 * Built-in worker names, sorted the same way `listWorkerTypes` sorts.
 * A scenario that registers a temporary type and forgets to reset would
 * otherwise still be registered when a later scenario plans a step.
 */
const BUILTIN_WORKERS = Object.freeze([
  'approval',
  'check-deps',
  'draft-spec',
  'research',
  'summarize',
]);

/**
 * Fail when a previous scenario left process-wide state behind.
 *
 * Each world has its own KVS, clock, and Jira fake. The schedule, the
 * effect clock, the store singleton, and the lock map do not. `close()`
 * clears them. This check runs before the new world resets anything, so
 * a leak fails here instead of being wiped and then showing up as a
 * budget change or a flaky assertion in some other order.
 *
 * @returns {void}
 */
function assertNoScenarioResidue() {
  /** @type {string[]} */
  const problems = [];
  const faults = faultInjectionResidue();
  if (faults) problems.push(`fault injection (${faults})`);
  const effects = leftoverEffectDependencies();
  if (effects.length > 0) problems.push(`effect dependencies (${effects.join(', ')})`);
  if (storeIsInstalled()) problems.push('store singleton');
  const locks = pendingLockCount();
  if (locks > 0) problems.push(`${locks} in-process lock(s)`);
  if (memoryServiceIsCached()) problems.push('cached memory service');
  if (hasCachedLlmModel()) problems.push('cached LLM model id');
  if (!hasSkillModel()) problems.push('skill model hook');
  const workers = listWorkerTypes();
  const workersMatch = workers.length === BUILTIN_WORKERS.length
    && workers.every((name, index) => name === BUILTIN_WORKERS[index]);
  if (!workersMatch) problems.push(`worker registry (${workers.join(', ')})`);
  if (globalThis.fetch !== originalFetch) problems.push('global fetch');
  if (problems.length === 0) return;
  throw new Error(
    `a previous scenario left process state behind: ${problems.join('; ')}. ` +
      'close() clears the fault schedule, the fake clock, and the in-memory fakes. ' +
      'A later scenario must not depend on running after a particular neighbour to stay clean.',
  );
}

export async function createWorld(options = {}) {
  // Refuse a leak before wiping it. The resets below still run so a world
  // that is the first caller in a fresh process starts from the same
  // baseline as a world that followed a careful close().
  assertNoScenarioResidue();
  resetFaultInjection();
  const seed = loadSeed();
  const clock = createClock();
  const bus = createQueueBus(clock);
  const sdk = createSimulationKvs();
  // The Jira fake is built before `runtime` exists. The callback reads this
  // holder, which is assigned once the runtime bag is ready. A transition
  // cannot happen before `createWorld` returns, so the holder is set.
  /** @type {object|null} */
  let runtimeRef = null;
  const jira = createFakeJira({
    issues: seedJiraIssues(seed, { poison: options.poison }),
    failSearch: options.failSearch,
    onIssueUpdated: (event) => {
      if (!runtimeRef) {
        return undefined;
      }
      // Same function the manifest names. `leadDependencies` is the
      // in-memory queue and store, so a gate approval releases the next
      // step onto this world's bus.
      return childIssueUpdated(event, { leadDependencies: runtimeRef });
    },
  });
  const confluence = createFakeConfluence({ pages: [...DEMO_PAGES] });
  const llm = options.llm
    ? createFakeLlm(options.llm)
    : { disabled: true, calls: [] };

  let sequence = 0;
  const store = createForgeStore({
    sdk,
    now: () => clock.now,
    newId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
  });
  setStore(store);

  const env = { ...(options.env ?? {}) };

  const effectQueue = {
    async push(event) {
      const queue = new bus.Queue({ key: 'effect-queue' });
      return queue.push(event);
    },
  };
  configureEffects({
    store,
    queue: effectQueue,
    requestJira: jira.requestJira,
    logger: silentLogger,
    now: () => clock.now,
    // The fault gate reads this object. Scenarios leave it empty, so the
    // hooks stay off and do not push a second effect or wrap Jira.
    env,
  });

  /**
   * @param {{runId: string, stepId: string, attempt: number}} payload
   */
  async function enqueueStep(payload) {
    const queue = new bus.Queue({ key: 'step-queue' });
    return queue.push({ body: payload });
  }

  function enqueue(input) {
    return enqueueEffect(input, {
      store,
      queue: effectQueue,
      sleep: async () => {},
      env,
    });
  }

  const runtime = {
    store,
    enqueueEffect: enqueue,
    enqueueStep,
    jira: createWorkerJira(jira),
    confluence,
    llm,
    now: () => clock.now,
    logger: silentLogger,
    sleep: async () => {},
    env,
    allowLeadLlm: true,
  };
  runtimeRef = runtime;

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
    env,
  });

  const previousFetch = globalThis.fetch;
  /** @type {string[]} */
  const fetches = [];
  globalThis.fetch = async (input) => {
    const target = typeof input === 'string' ? input : String(input?.url ?? input);
    fetches.push(target);
    throw new Error(`simulation forbids fetch(${target}). Ticket text is data.`);
  };

  /** @type {Map<string, object>} */
  const cards = new Map();

  /**
   * @param {object|null|undefined} result
   */
  function rememberCard(result) {
    if (result && typeof result.runId === 'string' && result.blastRadius && typeof result.blastRadius === 'object') {
      cards.set(result.runId, result.blastRadius);
    }
  }

  /**
   * The simulated person approves on the Run panel. The token is minted
   * here and is not taken from the action result. The card, when the
   * action already returned it, is reused so this step does not add a
   * store read.
   *
   * @param {string} key
   * @param {Record<string, unknown>|null|undefined} payload
   * @returns {Promise<Record<string, unknown>>}
   */
  async function withPersonConfirmation(key, payload) {
    const body = payload && typeof payload === 'object' ? { ...payload } : {};
    const explicit = body.confirm !== undefined
      || body.confirmToken !== undefined
      || body.acknowledgeBlastRadius !== undefined;
    if (explicit) return body;
    if (key === 'dispatch-run' && typeof body.runId === 'string') {
      const known = cards.get(body.runId);
      const issued = known
        ? issueDispatchGrant(known, { now: () => clock.now, principal: 'simulated-person' })
        : await issueHumanConfirmation({
          runId: body.runId,
          store,
          now: () => clock.now,
          principal: 'simulated-person',
        });
      if (!issued.ok) return body;
      return {
        ...body,
        confirm: true,
        acknowledgeBlastRadius: issued.acknowledgement,
        confirmToken: issued.confirmToken,
      };
    }
    if (key === 'fork-run') {
      const issued = issueForkGrant({
        runId: body.runId,
        stepIdx: body.stepIdx,
        input: body.input,
        now: () => clock.now,
        principal: 'simulated-person',
      });
      return {
        ...body,
        confirm: true,
        acknowledgeBlastRadius: issued.acknowledgement,
        confirmToken: issued.confirmToken,
      };
    }
    return body;
  }

  return {
    seed,
    clock,
    bus,
    sdk,
    store,
    jira,
    confluence,
    llm,
    runtime,
    watchdog,
    env,
    fetches,
    /**
     * Call one Rovo action the way another agent would, against this world.
     *
     * `dispatch-run` and `fork-run` require a confirmation token. When the
     * payload does not mention `confirm`, `confirmToken`, or
     * `acknowledgeBlastRadius`, this harness mints one the way the Run
     * panel does. It does not read a token from the action result. A
     * payload that sets any of those fields is sent unchanged, so a test
     * can refuse or send a bad token.
     *
     * @param {string} key Manifest action key, such as `plan-split`.
     * @param {Record<string, unknown>} payload
     * @param {Record<string, unknown>} [context]
     */
    async invoke(key, payload, context = { principal: { accountId: 'account-demo' } }) {
      const handler = ROVO_ACTIONS[key];
      if (!handler) {
        return { ok: false, error: `unknown action ${key}`, code: 'UNKNOWN_ACTION' };
      }
      try {
        const result = await handler(await withPersonConfirmation(key, payload), context, runtime);
        rememberCard(result);
        if (result && typeof result === 'object' && result.ok === false) return result;
        return result;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        return {
          ok: false,
          error: normalized.message,
          code: /** @type {any} */ (normalized).code ?? 'ERROR',
        };
      }
    },
    /**
     * Another agent hands a goal to Conductor. The handoff does not dispatch.
     * A later `invoke('dispatch-run')` mints a panel grant for this run.
     *
     * @param {Record<string, unknown>} input
     */
    async handoff(input) {
      const result = await handoffGoal(input, { principal: { accountId: 'account-demo' } }, runtime);
      rememberCard(result);
      return result;
    },
    async drainEffects() {
      let guard = 0;
      while (bus.ready('effect-queue') > 0) {
        guard += 1;
        if (guard > 80) {
          throw new Error(`effect-queue did not drain (${bus.size('effect-queue')} left)`);
        }
        await effectApplierHandler(bus.shift('effect-queue'));
      }
    },
    /**
     * Apply every ready effect, then one ready step, and repeat.
     * Effects go first so a child issue exists before the worker comments.
     *
     * @returns {Promise<object[]>}
     */
    async drain() {
      /** @type {object[]} */
      const stepResults = [];
      let guard = 0;
      while (bus.ready('effect-queue') > 0 || bus.ready('step-queue') > 0) {
        guard += 1;
        if (guard > 120) {
          throw new Error(
            `queues did not drain (effects=${bus.size('effect-queue')} steps=${bus.size('step-queue')})`,
          );
        }
        if (bus.ready('effect-queue') > 0) {
          await effectApplierHandler(bus.shift('effect-queue'));
        } else {
          stepResults.push(await stepWorkerHandler(bus.shift('step-queue'), runtime));
        }
      }
      return stepResults;
    },
    /**
     * Move an issue the way a person would, through the fake transition
     * endpoint. The fake then runs `childIssueUpdated`. `actor` is the
     * account id copied onto that product event.
     *
     * The board only has To Do (11), In Progress (21), and Done (31).
     *
     * @param {string} issueKey
     * @param {string} toStatusName
     * @param {{actor?: string}} [transitionOptions]
     * @returns {Promise<{ok: boolean, status: number, trigger: object|null}>}
     */
    async transitionIssue(issueKey, toStatusName, transitionOptions = {}) {
      const wanted = String(toStatusName ?? '').trim().toLowerCase();
      const transitionId = wanted === 'done'
        ? '31'
        : wanted === 'to do'
          ? '11'
          : wanted === 'in progress'
            ? '21'
            : '';
      if (!transitionId) {
        throw new Error(
          `simulation board has no transition to "${toStatusName}" (To Do, In Progress, Done)`,
        );
      }
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      if (typeof transitionOptions.actor === 'string' && transitionOptions.actor.length > 0) {
        headers['x-atlassian-account-id'] = transitionOptions.actor;
      }
      const eventsBefore = jira.productEvents.length;
      const response = await jira.requestJira(
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ transition: { id: transitionId } }),
        },
      );
      // A 404 does not deliver a product event. Do not report an older one.
      const delivered = jira.productEvents.length > eventsBefore
        ? jira.productEvents.at(-1)
        : null;
      return {
        ok: response.ok === true,
        status: response.status,
        trigger: delivered && typeof delivered.result === 'object' ? delivered.result : null,
      };
    },
    async close() {
      resetFaultInjection();
      resetWorkerTypes();
      resetLocks();
      resetStore();
      resetEffectDependencies();
      resetMemory();
      resetLlmCache();
      resetSkillModel();
      globalThis.fetch = previousFetch;
    },
  };
}

/**
 * One scenario queued by {@link testSerial}. The function runs only after
 * {@link startSerialScenarios} orders the queue.
 *
 * @typedef {{name: string, fn: () => Promise<void>}} SerialCase
 */

/** @type {SerialCase[]} */
const serialCases = [];

let serialStarted = false;

/** Settles when every queued scenario function has finished, pass or fail. */
let serialDone = Promise.resolve();

/**
 * Queue one scenario. The store, the fault schedule, and the effect clock
 * are process-wide, so the cases must not overlap. Call
 * {@link startSerialScenarios} once after the last `testSerial`.
 *
 * Order is not part of the contract. `SIM_SCENARIO_ORDER=reverse` runs the
 * queue backwards. `SIM_SCENARIO_ORDER=shuffle` with `SIM_SCENARIO_SEED`
 * (default `20261121`) runs a seeded shuffle. The default is source order,
 * which is what `node --test` prints. A failure that appears in only one
 * of those orders is a leak, not a reason to pin the order.
 *
 * @param {string} name
 * @param {() => Promise<void>} fn
 * @returns {void}
 */
export function testSerial(name, fn) {
  if (serialStarted) {
    throw new Error(`testSerial(${JSON.stringify(name)}) ran after startSerialScenarios`);
  }
  serialCases.push({ name, fn });
}

/**
 * @param {number} seed
 * @returns {() => number} A function that returns a number in `[0, 1)`.
 */
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Copy `cases` into the order the harness should run.
 * `source` keeps registration order. `reverse` flips it. `shuffle` is a
 * seeded Fisher-Yates, so the same seed is the same order every run.
 *
 * @param {SerialCase[]} cases
 * @param {string} mode `source`, `reverse`, or `shuffle`
 * @param {number} seed Used only for `shuffle`
 * @returns {SerialCase[]}
 */
export function orderSerialCases(cases, mode, seed) {
  if (mode === 'source') return cases.slice();
  if (mode === 'reverse') return cases.slice().reverse();
  if (mode === 'shuffle') {
    const copy = cases.slice();
    const next = mulberry32(seed);
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(next() * (index + 1));
      const held = copy[index];
      copy[index] = copy[swap];
      copy[swap] = held;
    }
    return copy;
  }
  throw new Error(`SIM_SCENARIO_ORDER must be source, reverse, or shuffle (got ${mode})`);
}

/**
 * @returns {'source'|'reverse'|'shuffle'|string}
 */
function readOrderMode() {
  const raw = process.env.SIM_SCENARIO_ORDER;
  if (raw === undefined || raw === '' || raw === 'source') return 'source';
  return raw;
}

/**
 * @returns {number}
 */
function readOrderSeed() {
  const raw = process.env.SIM_SCENARIO_SEED;
  if (raw === undefined || raw === '') return 20261121;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`SIM_SCENARIO_SEED must be an integer (got ${raw})`);
  }
  return Number(raw);
}

/**
 * Short label for the headroom report. Source order prints `source`.
 * A shuffle includes the seed so the log says which order produced the
 * table. The rows themselves are sorted by scenario name.
 *
 * @returns {string}
 */
export function scenarioOrderDescription() {
  const mode = readOrderMode();
  if (mode === 'shuffle') return `shuffle seed ${readOrderSeed()}`;
  return mode;
}

/**
 * Register the queued scenarios with `node:test` and start them.
 *
 * The promise chain starts during this call, which the scenario file
 * makes at the end of its evaluation. Each `test()` callback only waits
 * on its place in the chain, so `node --test` still lists the cases and
 * they still cannot overlap. A thrown scenario does not cancel the rest:
 * the headroom report needs every measurement, including a breach.
 *
 * @returns {Promise<void>} Resolves when every scenario function has settled.
 */
export function startSerialScenarios() {
  if (serialStarted) return serialDone;
  serialStarted = true;
  const mode = readOrderMode();
  const seed = mode === 'shuffle' ? readOrderSeed() : 0;
  const ordered = orderSerialCases(serialCases, mode, seed);
  let chain = Promise.resolve();
  for (const item of ordered) {
    const run = chain.then(() => item.fn());
    chain = run.then(
      () => {},
      () => {},
    );
    test(item.name, () => run);
  }
  serialDone = chain.then(() => {});
  return serialDone;
}

/**
 * The promise {@link startSerialScenarios} returns. The headroom report
 * waits on it. Before that call, the promise is already resolved and the
 * report would see an empty measurement table, so the scenario file calls
 * `startSerialScenarios` first.
 *
 * @returns {Promise<void>}
 */
export function serialScenariosDone() {
  return serialDone;
}
