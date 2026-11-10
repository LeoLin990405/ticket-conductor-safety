/**
 * Resolver for the Run panel (WP8).
 *
 * Reads stay under the 25 second UI resolver limit. `approveRun` and
 * `forkRun` are the human approval surface: they mint a confirmation grant
 * and consume it in this invocation. The token is not returned. They do
 * not call Jira themselves.
 *
 * @module resolvers
 */

import resolverModule from '@forge/resolver';

import { deadlineFor } from '../run/stateMachine.js';
import {
  getStep,
  getStore,
  updateStep,
} from '../store/index.js';
import { dispatchRun, forkRun } from '../actions/index.js';
import { lessonOp } from '../memory/lessons.js';
import { replayRun } from '../recorder/replay.js';
import { approveFromPanel, issueForkGrant } from '../safety/grants.js';
import { issueKeyFrom, exportRunTrace, loadRun, loadRunsForIssue } from './panelData.js';
import { pushWithRetry } from '../platform/queuePushRetry.js';

// Node's CJS interop exposes `{ default, makeResolver }` while the Forge
// bundler exposes the class itself. Accept both so unit tests and deploy agree.
const Resolver = typeof resolverModule === 'function'
  ? resolverModule
  : resolverModule.default;

const resolver = new Resolver();

export { issueKeyFrom, exportRunTrace, loadRun, loadRunsForIssue } from './panelData.js';

resolver.define('getRunsForIssue', async (request) => {
  return loadRunsForIssue(issueKeyFrom(request));
});

resolver.define('getRun', async (request) => {
  const runId = request?.payload?.runId;
  if (typeof runId !== 'string' || runId.length === 0) {
    return {
      run: null,
      steps: [],
      effects: [],
      memories: [],
      lessons: [],
      appliedMemories: [],
      usedMemory: [],
      usedLessons: [],
      planCard: '',
      chaos: null,
    };
  }
  return loadRun(runId);
});

/**
 * The Forge resolver context carries the person. The payload cannot.
 *
 * @param {object|null|undefined} request
 * @returns {string}
 */
function panelAccountId(request) {
  const direct = request?.context?.accountId;
  if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();
  const principal = request?.context?.principal?.accountId;
  if (typeof principal === 'string' && principal.trim().length > 0) return principal.trim();
  return '';
}

resolver.define('approveRun', async (request) => {
  const runId = request?.payload?.runId;
  return approveFromPanel({
    runId,
    accountId: panelAccountId(request),
    now: () => Date.now(),
    store: getStore(),
    dispatch: (payload) => dispatchRun(payload),
  });
});

resolver.define('retryStep', async (request) => {
  const stepId = request?.payload?.stepId;
  if (typeof stepId !== 'string' || stepId.length === 0) {
    return { ok: false, error: 'stepId is required' };
  }
  const step = await getStep(stepId);
  if (!step) {
    return { ok: false, error: 'step not found' };
  }
  if (step.status !== 'failed' && step.status !== 'blocked') {
    return { ok: false, error: 'only a failed or blocked step can be retried' };
  }
  const attempt = step.attempt + 1;
  const updated = await updateStep(stepId, {
    status: 'queued',
    attempt,
    deadlineAt: deadlineFor(Date.now()),
    error: undefined,
  });
  const { Queue } = await import('@forge/events');
  const queue = new Queue({ key: 'step-queue' });
  await pushWithRetry(() => queue.push({
    body: { runId: step.runId, stepId: step.stepId, attempt },
  }), { label: 'step-queue' });
  return { ok: true, step: updated };
});

resolver.define('lessonOp', async (request) => {
  const payload = request?.payload;
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'lesson op payload is required' };
  }
  return lessonOp(payload);
});

resolver.define('replayRun', async (request) => {
  const runId = request?.payload?.runId;
  if (typeof runId !== 'string' || runId.length === 0) {
    return { ok: false, error: 'runId is required' };
  }
  try {
    const result = await replayRun(runId);
    return { ok: true, ...result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

resolver.define('forkRun', async (request) => {
  const accountId = panelAccountId(request);
  if (!accountId) {
    return { ok: false, code: 'CONFIRMATION_REQUIRED', error: 'the Run panel must be opened by a person' };
  }
  const runId = request?.payload?.runId;
  const stepIdx = request?.payload?.stepIdx;
  if (typeof runId !== 'string' || runId.length === 0) {
    return { ok: false, error: 'runId is required' };
  }
  try {
    const input = request?.payload && Object.prototype.hasOwnProperty.call(request.payload, 'input')
      ? request.payload.input
      : undefined;
    const issued = issueForkGrant({
      runId,
      stepIdx,
      input,
      now: () => Date.now(),
      principal: accountId,
    });
    /** @type {Record<string, unknown>} */
    const payload = {
      runId,
      stepIdx,
      confirm: true,
      acknowledgeBlastRadius: issued.acknowledgement,
      confirmToken: issued.confirmToken,
    };
    if (input !== undefined) payload.input = input;
    const result = await forkRun(payload, { principal: { accountId } });
    if (!result || result.ok === false) {
      return {
        ok: false,
        code: result?.code,
        error: result?.error || 'fork failed',
      };
    }
    return {
      ok: true,
      runId: result.runId,
      status: result.status,
      forkedFromRunId: result.forkedFromRunId,
      forkedFromStepIdx: result.forkedFromStepIdx,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

resolver.define('exportRunTrace', async (request) => {
  const runId = request?.payload?.runId;
  if (typeof runId !== 'string' || runId.length === 0) {
    return { ok: false, error: 'runId is required' };
  }
  return exportRunTrace(runId);
});

export const panelResolver = resolver.getDefinitions();
