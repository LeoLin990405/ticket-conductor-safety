/**
 * Last-resort path: a Forge function calls an external LLM through the
 * runtime fetch API. The host must be listed under
 * permissions.external.fetch.backend or the call is rejected.
 * https://developer.atlassian.com/platform/forge/manifest-reference/permissions/
 *
 * Declaring that egress can make the app ineligible for Runs on Atlassian.
 * The Forge LLMs module does not. This spike declares egress so the path
 * can be deployed; the product manifest must not copy it.
 * https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api/
 *
 * The secret is a runtime variable, read from process.env. Set it with
 * `forge variables set --encrypt` and redeploy. Never commit the value.
 * https://developer.atlassian.com/platform/forge/environments-and-versions/
 *
 * Provider request shape, retrieved 2026-11-01:
 * POST https://api.anthropic.com/v1/messages
 * Authorization: Bearer, anthropic-version: 2026-10-21, max_tokens, messages, model.
 * https://docs.anthropic.com/en/api/messages
 * Model id `claude-haiku-5-5` is from that page's model enum ("fastest model
 * for high-volume, real-time tasks"). Unverified until this probe returns 200.
 */

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2026-10-21';
const ANTHROPIC_MODEL = 'claude-haiku-5-5';

/**
 * @returns {Promise<{ ok: boolean, skipped?: boolean, status?: number, text?: string, error?: string }>}
 */
export async function probeExternalLlm() {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      skipped: true,
      error: 'LLM_API_KEY is not set. External call was not attempted.',
    };
  }

  // A single outbound request inside an async consumer can last up to 180s.
  // This web trigger still has the 55s module limit, so the completion is tiny.
  // https://developer.atlassian.com/platform/forge/limits-invocation/
  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 32,
      messages: [
        {
          role: 'user',
          content: 'Reply with the single word pong.',
        },
      ],
    }),
  });

  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    // Cap the echo so a verbose error page cannot blow the web trigger response.
    text: text.slice(0, 800),
  };
}
