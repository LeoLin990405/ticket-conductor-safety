/**
 * Epic comment builder for WP6 run memory.
 *
 * On run completion WP6 does not call Jira directly. It enqueues one
 * `comment` effect through the WP2 queue, so the Jira mutation is deduped by
 * `requestKey` and retried by the effect applier. The effect payload carries
 * both an ADF body (what the applier should post) and a plain-text body (a
 * readable fallback used by tests and non-ADF callers).
 *
 * The header is part of the product contract: a recalled run writes an Epic
 * comment that starts with `[Conductor memory]` (docs/DESIGN.md §2.6).
 *
 * @module memory/comment
 */

/**
 * Header every write-back comment starts with.
 * @constant {string}
 */
export const MEMORY_COMMENT_HEADER = '[Conductor memory]';

/**
 * Stable discriminator for the Epic comment effect. It deliberately contains
 * no summary or decision text: one run gets one comment even when write-back is
 * retried with the same or updated content. The runId in the WP2 request key
 * keeps different runs separate.
 * @constant {string}
 */
export const MEMORY_COMMENT_DISCRIMINATOR = 'memory:epic-comment';

/**
 * Build one ADF text node.
 *
 * @param {string} text
 * @returns {{type: 'text', text: string}}
 */
function textNode(text) {
  return { type: 'text', text };
}

/**
 * Build the Epic comment body for a finished run.
 *
 * @param {{summary?: string, decisions?: Array<{text: string, type?: string}>}} input
 * @returns {{bodyText: string, bodyAdf: object}} Plain text plus ADF payload.
 */
export function buildMemoryComment(input = {}) {
  const summary =
    typeof input.summary === 'string' ? input.summary.trim() : '';
  const decisions = Array.isArray(input.decisions) ? input.decisions : [];

  const textLines = [MEMORY_COMMENT_HEADER];
  if (summary) {
    textLines.push('', summary);
  }
  if (decisions.length > 0) {
    textLines.push('', 'Decisions:');
    for (const decision of decisions) {
      const label = decision.type ? `[${decision.type}] ` : '';
      textLines.push(`- ${label}${decision.text}`);
    }
  }

  /** @type {object[]} */
  const content = [
    {
      type: 'heading',
      attrs: { level: 3 },
      content: [textNode(MEMORY_COMMENT_HEADER)],
    },
  ];
  if (summary) {
    content.push({
      type: 'paragraph',
      content: [textNode(summary)],
    });
  }
  if (decisions.length > 0) {
    content.push({
      type: 'bulletList',
      content: decisions.map((decision) => ({
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: [
              textNode(
                decision.type
                  ? `[${decision.type}] ${decision.text}`
                  : decision.text,
              ),
            ],
          },
        ],
      })),
    });
  }

  return {
    bodyText: textLines.join('\n'),
    bodyAdf: {
      type: 'doc',
      version: 1,
      content,
    },
  };
}
