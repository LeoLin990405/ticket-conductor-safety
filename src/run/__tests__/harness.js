/**
 * Shared scenario harness for WP3 tests.
 *
 * It wires the real WP3 state machine and step worker to the WP1 in-memory
 * store, a fake WP2 `enqueueEffect` (the real module is built in parallel and is
 * not on this branch), and an in-memory `step-queue`.
 */

import { issueHumanConfirmation } from '../../safety/grants.js';
import { createMemoryStore } from '../../store/index.js';
import { startRun } from '../stateMachine.js';
import {
  resetWorkerTypes,
  stepWorkerHandler,
} from '../../worker/index.js';

/**
 * Start a run the way the Run panel does: mint a grant, then call `startRun`.
 * `startRun` itself no longer has a path that skips the grant.
 *
 * @param {string} runId
 * @param {object} overrides
 */
export async function startApproved(runId, overrides) {
  const issued = await issueHumanConfirmation({
    runId,
    store: overrides?.store,
    now: overrides?.now,
    principal: 'test-harness',
  });
  if (!issued.ok) return startRun(runId, overrides);
  return startRun(runId, {
    ...overrides,
    confirmation: {
      confirm: true,
      acknowledgeBlastRadius: issued.acknowledgement,
      confirmToken: issued.confirmToken,
    },
  });
}

/**
 * @param {object} [options]
 * @param {Array<object>} [options.searchResults] Issues returned by the fake JQL search.
 * @param {Array<object>} [options.links] Links returned by the fake issue lookup.
 * @returns {object}
 */
export function createHarness(options = {}) {
  let now = 1_700_000_000_000;
  let idCounter = 0;
  const newId = () =>
    `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`;

  const store = createMemoryStore({ now: () => now, newId });

  /** @type {Array<{runId: string, stepId: string, attempt: number}>} */
  const stepEvents = [];
  /** @type {Array<object>} */
  const enqueuedEffects = [];
  /** @type {string[]} */
  const jqlQueries = [];
  /** @type {string[]} */
  const linkRequests = [];
  /** @type {Array<{level: string, args: any[]}>} */
  const logs = [];

  const logger = {
    info: (...args) => logs.push({ level: 'info', args }),
    warn: (...args) => logs.push({ level: 'warn', args }),
    error: (...args) => logs.push({ level: 'error', args }),
  };

  const jira = {
    async searchIssues(jql) {
      jqlQueries.push(jql);
      return options.searchResults ?? [];
    },
    async getIssueLinks(issueKey) {
      linkRequests.push(issueKey);
      return options.links ?? [];
    },
  };

  /**
   * Fake WP2 effects API. It records the call and simulates only the part the
   * state machine depends on: the createIssue applier eventually stores the
   * child issue key on the step. Real Jira mutations are WP2's job.
   */
  async function enqueueEffect(input) {
    enqueuedEffects.push(input);
    const requestKey =
      `${input.runId ?? '-'}|${input.stepId ?? '-'}|${input.kind}|` +
      `${input.discriminator}`;
    if (input.kind === 'createIssue') {
      const step = await store.getStep(input.stepId);
      if (step && !step.childIssueKey) {
        await store.updateStep(step.stepId, {
          childIssueKey: `TC-${step.idx + 1}`,
        });
      }
    }
    return { requestKey, created: true };
  }

  async function enqueueStep(payload) {
    stepEvents.push(payload);
    return { jobId: `job-${stepEvents.length}` };
  }

  const dependencies = {
    store,
    enqueueEffect,
    enqueueStep,
    jira,
    now: () => now,
    logger,
  };

  return {
    store,
    dependencies,
    stepEvents,
    enqueuedEffects,
    jqlQueries,
    linkRequests,
    logs,
    get now() {
      return now;
    },
    advance(ms) {
      now += ms;
    },
    async createRun(goal = 'Ship payment refunds') {
      return store.createRun({
        epicKey: 'TC-1',
        projectKey: 'TC',
        goal,
        createdBy: 'account-123',
      });
    },
    async createSteps(runId, steps) {
      return store.createSteps(runId, steps);
    },
    /**
     * Process one queued step event.
     *
     * @param {{asConsumerEvent?: boolean}} [processOptions]
     * @returns {Promise<object|undefined>}
     */
    async processNext(processOptions = {}) {
      const event = stepEvents.shift();
      if (!event) {
        return undefined;
      }
      return stepWorkerHandler(
        processOptions.asConsumerEvent ? { body: event } : event,
        dependencies,
      );
    },
    /**
     * Drain the simulated queue. The loop guard keeps a broken retry path from
     * hanging the test process.
     *
     * @returns {Promise<Array<object>>}
     */
    async processAll() {
      const results = [];
      let guard = 0;
      while (stepEvents.length > 0) {
        guard += 1;
        if (guard > 100) {
          throw new Error('step-queue did not drain after 100 events');
        }
        const result = await this.processNext();
        if (result) {
          results.push(result);
        }
      }
      return results;
    },
    resetWorkerTypes,
  };
}
