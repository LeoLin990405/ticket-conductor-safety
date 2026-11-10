import { chat, list } from '@forge/llm';

/**
 * Calls the Atlassian-hosted Forge LLMs API from a Forge function.
 *
 * The manifest must declare one `llm` module with model family `claude`,
 * or lint fails with "LLM package is used but 'llm' module is not defined".
 * https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api-reference/
 * https://developer.atlassian.com/platform/forge/manifest-reference/modules/llm/
 *
 * Temperature is omitted. Several current Claude models reject it, and it
 * cannot be combined with top_p.
 * https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api-reference/
 *
 * Prefer a model `list()` still marks active. The models page (retrieved
 * 2026-11-01, page date 2026-08-03) still labels Haiku 4.5 ACTIVE, but its
 * "not sooner than" date (2026-10-15) is already in the past.
 * https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-models/
 */

const PREFERRED_MODEL_IDS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
];

/**
 * @param {{ model?: string, status?: string }} entry
 * @returns {boolean}
 */
function isActive(entry) {
  const status = String(entry.status || '').toLowerCase();
  return status === 'active';
}

/**
 * @returns {Promise<{ ok: boolean, model?: string, models?: unknown, text?: string, usage?: unknown, error?: string }>}
 */
export async function probeForgeLlm() {
  const listed = await list();
  const models = Array.isArray(listed.models) ? listed.models : [];
  const active = models.filter(isActive);
  const preferred = PREFERRED_MODEL_IDS.find((id) => active.some((entry) => entry.model === id));
  const model = preferred || (active[0] && active[0].model);

  if (!model) {
    return {
      ok: false,
      error: 'list() returned no active model',
      models,
    };
  }

  // A tiny completion. Action and web trigger invocations die at 55 seconds,
  // so this probe must not start a long tool loop.
  // https://developer.atlassian.com/platform/forge/limits-invocation/
  const response = await chat({
    model,
    max_completion_tokens: 32,
    messages: [
      {
        role: 'user',
        content: 'Reply with the single word pong.',
      },
    ],
  });

  const choice = response.choices && response.choices[0];
  const content = choice && choice.message && choice.message.content;
  const text = typeof content === 'string'
    ? content
    : JSON.stringify(content);

  return {
    ok: true,
    model,
    models,
    text,
    usage: response.usage || null,
  };
}
