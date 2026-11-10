/**
 * Stable JSON used to compare plans, inputs, and worker outputs.
 *
 * Key order must not change a diff. Replay uses this to decide whether
 * today's Jira read would change a step, without writing anything.
 *
 * @module recorder/stable
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Keep a checkpoint small enough for one entity value. The full worker
 * output still lives on the step. The journal keeps a copy so replay can
 * show the original side of the diff even if the caller only has events.
 *
 * @param {unknown} value
 * @param {number} [maxChars]
 * @returns {unknown}
 */
export function compactDetail(value, maxChars = 8000) {
  if (value === undefined) {
    return undefined;
  }
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return { truncated: true, reason: 'not-json' };
  }
  if (json === undefined) {
    return undefined;
  }
  if (json.length <= maxChars) {
    return value;
  }
  return { truncated: true, bytes: json.length };
}
