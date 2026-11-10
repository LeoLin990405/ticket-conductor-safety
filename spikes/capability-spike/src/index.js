import { probeExternalLlm } from './externalLlmProbe.js';
import { bearerMatches, headerValue, jsonResponse, queryValue } from './http.js';
import { probeForgeLlm } from './llmProbe.js';
import { pushProbe, queueConsumer } from './queueProbe.js';
import { probeStorage } from './storageProbe.js';

export { queueConsumer };

/**
 * Action used by the plan-playbook skill. Action inputs cannot be arrays,
 * so the plan arrives as a JSON string.
 * https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-action/
 *
 * The user's account id, when this runs from Rovo chat, is on `context`,
 * not in the model-supplied inputs.
 *
 * @param {{ planJson?: string }} payload
 * @param {{ principal?: { accountId?: string } }} context
 */
export function echoPlan(payload, context) {
  const raw = payload && payload.planJson;
  let plan = null;
  let parseError = null;
  try {
    plan = JSON.parse(raw || '');
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  return {
    accepted: !parseError,
    plan,
    parseError,
    accountId: context && context.principal ? context.principal.accountId : null,
  };
}

/**
 * Action that only enqueues. It must return inside the 55-second action limit.
 * https://developer.atlassian.com/platform/forge/limits-invocation/
 *
 * @param {{ holdSeconds?: number }} payload
 */
export async function enqueueProbe(payload) {
  return pushProbe({
    holdSeconds: payload && payload.holdSeconds,
    source: 'action',
  });
}

/**
 * Dynamic web trigger. Anyone with the URL can call it, so SPIKE_TOKEN is required.
 * `check` selects one probe. `all` runs the three checks that do not wait
 * and do not call an external model.
 *
 * @param {{ headers?: Record<string, string[]>, queryParameters?: Record<string, string[]> }} request
 */
export async function probe(request) {
  const expected = process.env.SPIKE_TOKEN || '';
  const presented = headerValue(request.headers, 'authorization');
  if (!bearerMatches(presented, expected)) {
    return jsonResponse(401, {
      ok: false,
      error: 'Set SPIKE_TOKEN with forge variables set --encrypt, redeploy, and send Authorization: Bearer <token>.',
    });
  }

  const check = queryValue(request, 'check') || 'all';
  const result = { check };

  try {
    if (check === 'llm' || check === 'all') {
      result.forgeLlm = await probeForgeLlm();
    }
    if (check === 'external') {
      result.externalLlm = await probeExternalLlm();
    }
    if (check === 'storage' || check === 'all') {
      result.storage = await probeStorage();
    }
    if (check === 'queue' || check === 'queue-long' || check === 'all') {
      result.queue = await pushProbe({
        holdSeconds: check === 'queue-long' ? 60 : 0,
        source: 'webtrigger',
      });
    }
    if (!result.forgeLlm && !result.externalLlm && !result.storage && !result.queue) {
      return jsonResponse(400, {
        ok: false,
        error: 'Unknown check. Use llm, external, storage, queue, queue-long, or all.',
      });
    }
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      check,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      partial: result,
    });
  }

  return jsonResponse(200, { ok: true, ...result });
}
