/**
 * Development-only webtrigger to exercise dispatch headlessly.
 *
 * Guarded by the `DEV_WEBTRIGGER_SECRET` environment variable, which is set
 * only in the development environment (`forge variables set -e development`).
 * Without it, or with a wrong `x-dev-secret` header, it answers 403.
 * Body: {"runId": "..."} → startRun, then returns the run and its steps.
 * Body: {"plan": {epicKey, goal, stepsJson}} → planSplit first, then dispatch.
 * Add "statusOnly": true to only read the run.
 * Body: {"injectFault": {"type": "kill-worker"|"duplicate-effect"|"jira-429"}}
 * arms one chaos fault and returns. It does not plan or dispatch. The secret
 * is not enough: the simulation or development fault flag must also be set,
 * and production or staging (`CONDUCTOR_APP_ENV`) is refused.
 */
import { planSplit } from '../actions/index.js';
import { injectFault } from '../chaos/faults.js';
import { startRun } from '../run/stateMachine.js';
import { getRun, listSteps } from '../store/index.js';

function reply(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': ['application/json'] },
    body: JSON.stringify(body),
  };
}

export async function devDispatchWebtrigger(request) {
  const secret = process.env.DEV_WEBTRIGGER_SECRET;
  const headers = request?.headers ?? {};
  const given = [].concat(headers['x-dev-secret'] ?? headers['X-Dev-Secret'] ?? [])[0];
  if (!secret || given !== secret) {
    return reply(403, { error: 'forbidden' });
  }
  try {
    const body = request?.body ? JSON.parse(request.body) : {};
    // Chaos faults. The secret above only proves the caller knows the
    // development webtrigger secret. `injectFault` still refuses unless
    // the simulation flag or the development environment flag is set, so
    // a production or staging install that somehow has the secret cannot
    // arm a kill, a duplicate, or a 429. The reply is the gate result.
    // This branch does not plan or dispatch.
    if (body.injectFault && typeof body.injectFault === 'object' && !Array.isArray(body.injectFault)) {
      return reply(200, injectFault(body.injectFault, process.env));
    }
    if (body.inspectEffects === true) {
      const { getStore } = await import('../store/index.js');
      const store = getStore();
      const out = [];
      for (const status of ['pending', 'retrying', 'applying']) {
        for (const effect of await store.listEffectsByStatus(status)) {
          const ownerId = effect.payload?.childOfStepId;
          const owner = ownerId ? await store.getStep(ownerId) : null;
          out.push({ effect, owner });
        }
      }
      return reply(200, { effects: out });
    }
    if (body.lessonOp && typeof body.lessonOp === 'object') {
      const { lessonOp } = await import('../memory/lessons.js');
      return reply(200, await lessonOp(body.lessonOp));
    }
    if (body.listLessons && typeof body.listLessons === 'object') {
      const { listLessons } = await import('../memory/lessons.js');
      return reply(200, { lessons: await listLessons(body.listLessons) });
    }
    if (typeof body.replayRun === 'string') {
      const { replayRun } = await import('../recorder/replay.js');
      return reply(200, await replayRun(body.replayRun));
    }
    if (body.forkRun && typeof body.forkRun === 'object') {
      const { forkRun } = await import('../recorder/fork.js');
      return reply(200, await forkRun(body.forkRun));
    }
    if (typeof body.listEvents === 'string') {
      const { getStore } = await import('../store/index.js');
      return reply(200, { events: await getStore().listEventsByRun(body.listEvents) });
    }
    if (body.kvsProbe === true) {
      const { runKvsProbe } = await import('./kvsProbe.js');
      return reply(200, await runKvsProbe());
    }
    let runId = String(body.runId ?? '');
    if (body.plan) {
      runId = (await planSplit(body.plan, {})).runId;
      console.log(`[dev-dispatch] planned ${runId}`);
    }
    if (body.statusOnly !== true) {
      console.log(`[dev-dispatch] startRun ${runId}`);
      await startRun(runId);
    }
    const run = await getRun(runId);
    const steps = await listSteps(runId);
    return reply(200, { run, steps });
  } catch (error) {
    console.error('[dev-dispatch] failed', error);
    return reply(500, { error: String(error?.message ?? error) });
  }
}
