/**
 * Small Atlassian Document Format builder for worker comments (WP11).
 *
 * Jira Cloud stores comments as ADF. The effect applier posts `bodyAdf` when
 * a worker provides one, and keeps `bodyText` for logs and tests. This file
 * only builds documents. It does not call Jira.
 *
 * Empty text nodes are omitted. Jira rejects a text node whose text is ''.
 *
 * @module worker/adf
 */

/**
 * @param {string} text
 * @param {Array<Record<string, unknown>>} [marks]
 * @returns {{type: 'text', text: string, marks?: Array<Record<string, unknown>>}|null}
 */
export function textNode(text, marks) {
  const value = String(text ?? '');
  if (value.length === 0) {
    return null;
  }
  /** @type {{type: 'text', text: string, marks?: Array<Record<string, unknown>>}} */
  const node = { type: 'text', text: value };
  if (Array.isArray(marks) && marks.length > 0) {
    node.marks = marks;
  }
  return node;
}

/**
 * @param {string} href An https URL the worker already retrieved.
 * @returns {{type: 'link', attrs: {href: string}}}
 */
export function linkMark(href) {
  return { type: 'link', attrs: { href } };
}

/**
 * @param {Array<object|null|undefined>} nodes
 * @returns {object|null}
 */
export function paragraph(nodes) {
  const content = nodes.filter((node) => node && node.type === 'text' && node.text);
  if (content.length === 0) {
    return null;
  }
  return { type: 'paragraph', content };
}

/**
 * @param {number} level
 * @param {string} text
 * @returns {object|null}
 */
export function heading(level, text) {
  const node = textNode(text);
  if (!node) {
    return null;
  }
  return { type: 'heading', attrs: { level }, content: [node] };
}

/**
 * @param {Array<Array<object|null>|null|undefined>} items
 * Each item is the inline nodes of one bullet.
 * @returns {object|null}
 */
export function bulletList(items) {
  const content = [];
  for (const item of items) {
    const para = paragraph(Array.isArray(item) ? item : []);
    if (!para) {
      continue;
    }
    content.push({ type: 'listItem', content: [para] });
  }
  if (content.length === 0) {
    return null;
  }
  return { type: 'bulletList', content };
}

/**
 * @param {Array<object|null|undefined>} blocks
 * @returns {{type: 'doc', version: 1, content: object[]}}
 */
export function doc(blocks) {
  const content = blocks.filter((block) => block && typeof block === 'object');
  if (content.length === 0) {
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Ticket Conductor produced no text.' }],
    });
  }
  return { type: 'doc', version: 1, content };
}

/**
 * Issue key or page id, linked only when we already have an https URL.
 *
 * @param {string} label
 * @param {string} [url]
 * @returns {object|null}
 */
export function sourceLabel(label, url) {
  if (typeof url === 'string' && url.startsWith('https://')) {
    return textNode(label, [linkMark(url)]);
  }
  return textNode(label, [{ type: 'code' }]);
}

/**
 * One-line footer so a reader can see whether the model ran.
 *
 * @param {{generator?: string, model?: string|null}} output
 * @returns {string}
 */
export function sourceLine(output) {
  if (output?.generator === 'llm' && output.model) {
    return `Source: Forge LLM (${output.model}).`;
  }
  return 'Source: deterministic fallback (Forge LLM unavailable).';
}
