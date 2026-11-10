/**
 * Read-only resolver for the Run panel (WP8), plus an optional retry.
 *
 * The panel must stay under the 25 second UI resolver limit, so these
 * handlers only read the store or push one queue event. They do not call Jira.
 *
 * @module resolvers
 */

import resolverModule from '@forge/resolver';

import { deadlineFor } from '../run/stateMachine.js';
import {
  getStep,
  updateStep,
} from '../store/index.js';
import { lessonOp } from '../memory/lessons.js';
import { forkRun } from '../recorder/fork.js';
import { replayRun } from '../recorder/replay.js';
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
  const runId = request?.payload?.runId;
  const stepIdx = request?.payload?.stepIdx;
  if (typeof runId !== 'string' || runId.length === 0) {
    return { ok: false, error: 'runId is required' };
  }
  try {
    /** @type {Record<string, unknown>} */
    const input = { runId, stepIdx };
    if (request?.payload && Object.prototype.hasOwnProperty.call(request.payload, 'input')) {
      input.input = request.payload.input;
    }
    const result = await forkRun(input);
    return { ok: true, ...result };
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
