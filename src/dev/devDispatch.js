/**
 * Development-only webtrigger to exercise dispatch headlessly.
 *
 * Guarded by the `DEV_WEBTRIGGER_SECRET` environment variable, which is set
 * only in the development environment (`forge variables set -e development`).
 * Without it, or with a wrong `x-dev-secret` header, it answers 403.
 * Body: {"runId", "approve": true} starts the run. The token is minted in
 * this request and is not written on the response. A body that omits both
 * `approve` and a panel token answers 409 and does not enqueue.
 * Body: {"plan": {epicKey, goal, stepsJson}} plans only until `approve` is
 * also present.
 * Add "statusOnly": true to only read the run.
 * Body: {"injectFault": {"type": "kill-worker"|"duplicate-effect"|"jira-429"}}
 * arms one chaos fault and returns. It does not plan or dispatch. The secret
 * is not enough: the simulation or development fault flag must also be set,
 * and production or staging (`CONDUCTOR_APP_ENV`) is refused.
 */
import { dispatchRun, forkRun, planSplit } from '../actions/index.js';
import { issueForkGrant, issueHumanConfirmation } from '../safety/grants.js';
import { getStore } from '../store/index.js';
import { injectFault } from '../chaos/faults.js';
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
      let payload = body.forkRun;
      if (body.approve === true && !payload.confirmToken) {
        const issued = issueForkGrant({
          runId: payload.runId,
          stepIdx: payload.stepIdx,
          input: payload.input,
          now: () => Date.now(),
          principal: 'dev-webtrigger',
        });
        payload = {
          ...payload,
          confirm: true,
          acknowledgeBlastRadius: issued.acknowledgement,
          confirmToken: issued.confirmToken,
        };
      }
      const forked = await forkRun(payload);
      if (!forked || forked.ok === false) {
        return reply(409, {
          ok: false,
          code: forked?.code || 'CONFIRMATION_REQUIRED',
          error: forked?.error || 'confirmation required',
          runId: payload.runId,
        });
      }
      const { confirmToken: _token, acknowledgement: _line, ...safe } = forked;
      return reply(200, safe);
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
    /** @type {object|null} */
    let planned = null;
    if (body.plan) {
      planned = await planSplit(body.plan, {});
      runId = planned.runId;
      console.log(`[dev-dispatch] planned ${runId}`);
    }
    if (body.statusOnly !== true) {
      console.log(`[dev-dispatch] dispatchRun ${runId}`);
      let confirm = body.confirm;
      let acknowledgeBlastRadius = body.acknowledgeBlastRadius;
      let confirmToken = body.confirmToken;
      if (body.approve === true && !confirmToken) {
        const issued = await issueHumanConfirmation({
          runId,
          store: getStore(),
          now: () => Date.now(),
          principal: 'dev-webtrigger',
        });
        if (!issued.ok) {
          return reply(409, {
            ok: false,
            code: issued.code,
            error: issued.reason,
            runId,
            acknowledgement: planned?.acknowledgement,
          });
        }
        confirm = true;
        acknowledgeBlastRadius = issued.acknowledgement;
        confirmToken = issued.confirmToken;
      }
      const dispatched = await dispatchRun({
        runId,
        confirm,
        acknowledgeBlastRadius,
        confirmToken,
      });
      if (!dispatched || dispatched.ok === false) {
        return reply(409, {
          ok: false,
          code: dispatched?.code || 'CONFIRMATION_REQUIRED',
          error: dispatched?.error || 'confirmation required',
          runId,
          status: dispatched?.status,
          acknowledgement: planned?.acknowledgement,
        });
      }
    }
    const run = await getRun(runId);
    const steps = await listSteps(runId);
    return reply(200, { run, steps });
  } catch (error) {
    console.error('[dev-dispatch] failed', error);
    return reply(500, { error: String(error?.message ?? error) });
  }
}
