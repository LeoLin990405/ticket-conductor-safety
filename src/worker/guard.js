/**
 * Prompt-injection fence and JSON guards for worker LLM calls (WP11).
 *
 * Ticket text, page excerpts, and plan fields are data. They are wrapped in
 * `<untrusted>` tags before they are shown to the model, and any tag the text
 * itself contains is stripped so it cannot close the fence early.
 *
 * The model is only allowed to describe sources this process already
 * retrieved. It cannot add Jira effects: callers never read an `effects`
 * field out of the JSON, and issue keys that were not in the retrieval set
 * are dropped here.
 *
 * @module worker/guard
 */

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string} A single-line string, or '' when the value is not text.
 */
export function clip(value, max) {
  if (typeof value !== 'string') {
    return '';
  }
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length === 0) {
    return '';
  }
  return singleLine.length <= max
    ? singleLine
    : `${singleLine.slice(0, Math.max(1, max) - 1)}…`;
}

/**
 * Wrap one piece of untrusted text. The source and id are ours, not the text's.
 *
 * @param {string} source Short label such as `jira` or `plan`.
 * @param {string} id Issue key, page id, or a fixed plan field name.
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function fenceUntrusted(source, id, text, max = 1500) {
  const safeSource = String(source ?? 'data').replace(/[^a-z0-9-]/g, '') || 'data';
  const safeId = String(id ?? '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64) || 'item';
  // Drop any tag the payload brought with it before we add our own fence.
  // Otherwise a summary of `</untrusted>` would end the data block and the
  // following words would look like instructions.
  const body = String(text ?? '')
    .replace(/<\s*\/\s*untrusted\b[^>]*>/gi, '[removed-closing-tag]')
    .replace(/<\s*untrusted\b[^>]*>/gi, '[removed-opening-tag]')
    .slice(0, max);
  return `<untrusted source="${safeSource}" id="${safeId}">\n${body}\n</untrusted>`;
}

/**
 * @param {string} text
 * @returns {{open: number, close: number}}
 */
export function untrustedTagCounts(text) {
  const source = String(text ?? '');
  return {
    open: source.match(/<untrusted\b/g)?.length ?? 0,
    close: source.match(/<\/untrusted>/g)?.length ?? 0,
  };
}

/**
 * @param {unknown} value
 * @param {number} maxItems
 * @param {number} maxLen
 * @returns {string[]}
 */
export function stringList(value, maxItems, maxLen) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim().length > 0
      ? [value]
      : [];
  /** @type {string[]} */
  const items = [];
  for (const entry of raw) {
    const text = clip(
      typeof entry === 'string' ? entry : '',
      maxLen,
    );
    if (text.length === 0) {
      continue;
    }
    items.push(text);
    if (items.length >= maxItems) {
      break;
    }
  }
  return items;
}

/**
 * Read text out of a Forge LLM message.
 *
 * `chat()` sometimes returns a string and sometimes a list of
 * `{type:'text', text}` parts (the WP0 probe saw the list). Both are text.
 * Tool-call objects are ignored: workers do not register tools.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function messageText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part && typeof part === 'object' && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('');
}

/**
 * Parse the one JSON object a worker asked for.
 *
 * Models often wrap the object in a ```json fence or add a sentence. The
 * first `{` through the last `}` is the only thing accepted. Arrays, empty
 * strings, and broken JSON become null so the caller can use the fallback.
 *
 * @param {unknown} text
 * @returns {Record<string, unknown>|null}
 */
export function parseModelJson(text) {
  if (typeof text !== 'string') {
    return null;
  }
  let raw = text.trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    raw = fenced[1].trim();
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return /** @type {Record<string, unknown>} */ (parsed);
  } catch {
    return null;
  }
}

/**
 * @param {string} value
 * @returns {string} An https URL, or '' when the value is not one.
 */
export function httpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

/**
 * Keep model findings that point at a source this process retrieved.
 *
 * The title and URL are copied from the retrieval record. The model may
 * explain the item (`why`) but may not rename it or attach a different URL.
 *
 * @param {unknown} raw
 * @param {Array<Record<string, any>>} issues
 * @param {Array<Record<string, any>>} pages
 * @returns {Array<{source: string, key: string, title: string, url: string, why: string}>}
 */
export function acceptFindings(raw, issues, pages) {
  const issuesByKey = new Map(
    issues.filter((issue) => issue.key).map((issue) => [String(issue.key), issue]),
  );
  const pagesById = new Map(
    pages.filter((page) => page.id).map((page) => [String(page.id), page]),
  );
  if (!Array.isArray(raw)) {
    return [];
  }
  /** @type {Array<{source: string, key: string, title: string, url: string, why: string}>} */
  const findings = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const key = String(entry.key ?? entry.id ?? '').trim();
    const issue = issuesByKey.get(key);
    const page = pagesById.get(key);
    const known = issue ?? page;
    if (!known) {
      continue;
    }
    const why = clip(
      typeof entry.why === 'string'
        ? entry.why
        : typeof entry.note === 'string'
          ? entry.note
          : '',
      400,
    );
    findings.push({
      source: issue ? 'jira' : 'confluence',
      key,
      title: clip(String(known.summary ?? known.title ?? ''), 180),
      url: httpsUrl(known.url),
      why: why || clip(String(known.excerpt ?? known.summary ?? known.title ?? ''), 180),
    });
    if (findings.length >= 8) {
      break;
    }
  }
  return findings;
}

/**
 * Keep dependency risks whose issue key was actually linked.
 *
 * A risk with no key is a general note. A risk that names some other issue
 * is dropped, because that key was not part of the link set the worker read.
 *
 * @param {unknown} raw
 * @param {Array<Record<string, any>>} links
 * @returns {Array<{key: string, summary: string, status: string, risk: string}>}
 */
export function acceptRisks(raw, links) {
  const byKey = new Map(
    links.filter((link) => link.key).map((link) => [String(link.key), link]),
  );
  if (!Array.isArray(raw)) {
    return [];
  }
  /** @type {Array<{key: string, summary: string, status: string, risk: string}>} */
  const risks = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const risk = clip(entry, 300);
      if (risk) {
        risks.push({ key: '', summary: '', status: '', risk });
      }
    } else if (entry && typeof entry === 'object') {
      const key = String(entry.key ?? '').trim();
      if (key && !byKey.has(key)) {
        continue;
      }
      const link = key ? byKey.get(key) : undefined;
      const risk = clip(
        typeof entry.risk === 'string'
          ? entry.risk
          : typeof entry.why === 'string'
            ? entry.why
            : '',
        300,
      );
      if (!risk && !link) {
        continue;
      }
      risks.push({
        key,
        summary: String(link?.summary ?? ''),
        status: String(link?.status ?? ''),
        risk: risk || `${key} is ${link?.status || 'not done'}.`,
      });
    }
    if (risks.length >= 8) {
      break;
    }
  }
  return risks;
}
