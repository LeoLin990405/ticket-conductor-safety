/**
 * Forge LLM adapter for Ticket Conductor step workers (WP11).
 *
 * Choice
 * ------
 * Workers call the Atlassian-hosted Forge LLMs API (`@forge/llm` `chat` and
 * `list`). WP0 ran that call on the dev site and got a reply from
 * `claude-haiku-4-5-20251001`. The call stays inside Atlassian, so the app
 * can still qualify for Runs on Atlassian. Docs and the required manifest
 * module are recorded in `LLM.md`.
 *
 * Two other options were rejected:
 * - Rovo agent-to-agent delegation. Forge has no API for one `rovo:agent` to
 *   invoke another. `rovo:agentConnector` is a person assigning a remote
 *   agent, and it makes the app user unmentionable.
 * - An external model over `fetch`. That needs egress and an encrypted
 *   secret, and it can drop Runs on Atlassian. Ticket text must not be able
 *   to cause that fetch.
 *
 * Where the call runs
 * -------------------
 * Only the `step-worker` consumer (timeoutSeconds 900) may call `chat`.
 * An action dies at 55 seconds. The LLM inference budget is 5 minutes, and
 * only when the caller is an async consumer whose timeout is at least that.
 * No tools are passed. Temperature is omitted because several current Claude
 * models reject it, and it cannot be combined with `top_p`.
 *
 * Fallback
 * --------
 * `node --test` never loads the SDK. A Forge invocation that cannot list or
 * call a model returns `{ok:false}` and the worker uses its deterministic
 * text instead. Set the Forge variable `CONDUCTOR_LLM` to `off` to force
 * that path on a site.
 *
 * @module worker/llm
 */

import { noteModelResult } from '../run/budget.js';
import { messageText } from './guard.js';

/**
 * Active models, cheapest adequate first. WP0's live `list()` marked the
 * Haiku id active on 2026-11-01. `list()` still wins when it disagrees.
 * @constant {ReadonlyArray<string>}
 */
export const PREFERRED_MODEL_IDS = Object.freeze([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
]);

/** Process-local model id. Not tenant data: the catalogue is per app. */
let cachedModel = null;

/**
 * Forget the cached model id. Tests call this between cases.
 * @returns {void}
 */
export function resetLlmCache() {
  cachedModel = null;
}

/**
 * True when `list()` has already chosen a model id for this process.
 * The simulator expects this to be false between scenarios so one world's
 * catalogue cannot pick the next world's model.
 *
 * @returns {boolean}
 */
export function hasCachedLlmModel() {
  return cachedModel !== null;
}

/**
 * @param {unknown} listed `list()` payload, or a bare model array.
 * @returns {string|null}
 */
export function chooseModel(listed) {
  const models = Array.isArray(listed)
    ? listed
    : Array.isArray(listed?.models)
      ? listed.models
      : [];
  const active = models.filter(
    (entry) =>
      entry &&
      typeof entry.model === 'string' &&
      String(entry.status ?? '').toLowerCase() === 'active',
  );
  const preferred = PREFERRED_MODEL_IDS.find((id) =>
    active.some((entry) => entry.model === id),
  );
  return preferred || active[0]?.model || null;
}

/**
 * True when this process is a `node --test` run.
 *
 * The test runner sets `NODE_TEST_CONTEXT`. Those runs must stay
 * deterministic and must not import `@forge/llm` unless a test passed a mock.
 *
 * @returns {boolean}
 */
export function isNodeTestProcess() {
  return typeof process.env.NODE_TEST_CONTEXT === 'string'
    && process.env.NODE_TEST_CONTEXT.length > 0;
}

/**
 * @param {{disabled?: boolean}|null|undefined} llm
 * @returns {boolean}
 */
export function llmDisabled(llm) {
  if (llm && llm.disabled === true) {
    return true;
  }
  const flag = process.env.CONDUCTOR_LLM;
  return flag === 'off' || flag === '0' || flag === 'fallback';
}

/**
 * Whether this invocation is the Forge runtime.
 *
 * `getAppContext()` throws outside a Forge function (unit tests, a plain
 * Node script). The boolean is cached. It is not installation data.
 *
 * @returns {Promise<boolean>}
 */
export async function runningInForge() {
  if (isNodeTestProcess()) {
    return false;
  }
  try {
    const forgeApi = await import('@forge/api');
    if (typeof forgeApi.getAppContext !== 'function') {
      return false;
    }
    const context = forgeApi.getAppContext();
    return Boolean(context && (context.invocationId || context.moduleKey));
  } catch {
    return false;
  }
}

/**
 * @param {{list?: Function}} client
 * @returns {Promise<string>}
 */
async function selectModel(client) {
  if (cachedModel) {
    return cachedModel;
  }
  if (typeof client.list === 'function') {
    try {
      const chosen = chooseModel(await client.list());
      if (chosen) {
        cachedModel = chosen;
        return cachedModel;
      }
    } catch {
      // list() failed. Try the Haiku id WP0 already saw active, once.
    }
  }
  cachedModel = PREFERRED_MODEL_IDS[0];
  return cachedModel;
}

/**
 * Load `@forge/llm` from inside a Forge function.
 *
 * The import is dynamic so unit tests, which never call this, do not need
 * the package to evaluate worker modules. A missing package is an
 * unavailable model, not a crashed step.
 *
 * @returns {Promise<{chat: Function, list: Function}|null>}
 */
async function loadForgeLlm() {
  try {
    const sdk = await import('@forge/llm');
    if (typeof sdk.chat !== 'function') {
      return null;
    }
    return {
      chat: sdk.chat,
      list: typeof sdk.list === 'function' ? sdk.list : async () => ({ models: [] }),
    };
  } catch {
    return null;
  }
}

/**
 * @param {{disabled?: boolean, chat?: Function, list?: Function}|null|undefined} llm
 * @returns {Promise<{chat: Function, list?: Function}|null>}
 */
async function resolveClient(llm) {
  if (llmDisabled(llm)) {
    return null;
  }
  if (llm && typeof llm.chat === 'function') {
    return llm;
  }
  // A test that forgot to pass a mock must hit the deterministic fallback,
  // not a live model. Production Forge loads the SDK.
  if (isNodeTestProcess()) {
    return null;
  }
  if (!(await runningInForge())) {
    return null;
  }
  return loadForgeLlm();
}

/**
 * Ask the model for text. Callers parse JSON themselves and fall back when
 * `ok` is false. This function never throws for an unavailable model.
 *
 * The request sent to `chat` is built here. Callers cannot add tools,
 * temperature, or a different role order.
 *
 * @param {{system: string, user: string, maxTokens?: number, meter?: {calls?: number, tokens?: number}}} request
 *   `meter` is optional. When `chat` actually runs, the call and its token
 *   usage are added there. A disabled or missing model does not touch it,
 *   so `CONDUCTOR_LLM=off` does not become a run-budget write.
 * @param {{disabled?: boolean, chat?: Function, list?: Function}|null|undefined} [llm]
 * @returns {Promise<{ok: boolean, text?: string, model?: string, usage?: object|null, reason?: string, message?: string}>}
 */
export async function completeText(request, llm) {
  if (llmDisabled(llm)) {
    return { ok: false, reason: 'disabled' };
  }
  const client = await resolveClient(llm);
  if (!client) {
    return { ok: false, reason: 'unavailable' };
  }

  let model = PREFERRED_MODEL_IDS[0];
  // Set only after `chat` is the next call. A failure inside model
  // selection is not a completion and must not spend the run budget.
  let chatted = false;
  try {
    model = await selectModel(client);
    const maxTokens = Number.isInteger(request.maxTokens) ? request.maxTokens : 800;
    // No `tools`, no `temperature`, no `top_p`. A tool definition would let
    // untrusted ticket text talk the model into a function call. We do not
    // pass one, and a tool_calls field on the reply is ignored below.
    chatted = true;
    const response = await client.chat({
      model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    });
    const text = messageText(response?.choices?.[0]?.message?.content).trim();
    if (text.length === 0) {
      const empty = { ok: false, reason: 'empty', model };
      noteModelResult(request?.meter, empty);
      return empty;
    }
    const ok = {
      ok: true,
      text,
      model,
      usage: response?.usage ?? null,
    };
    noteModelResult(request?.meter, ok);
    return ok;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = {
      ok: false,
      reason: 'error',
      model,
      message: message.slice(0, 200),
    };
    if (chatted) noteModelResult(request?.meter, failed);
    return failed;
  }
}
