/**
 * In-memory store adapter for tests and local development (WP1).
 *
 * `createMemoryStore()` returns the same complete interface as the Forge
 * adapter, including validation, defaults, optimistic updates, index queries,
 * and pagination semantics. Nothing here touches Forge, so WP2–WP6 unit tests
 * run with `node --test` and no extra dependencies.
 *
 * The backend implementation below intentionally mirrors the Forge entity
 * indexes declared in `entities.manifest.yml`. When an index definition
 * changes, update both this file and the YAML snippet.
 *
 * @module store/memoryAdapter
 */

import { StoreValidationError } from './errors.js';
import { createStoreFromBackend } from './storeCore.js';

/**
 * Index definitions shared with the Forge manifest snippet.
 * A named index has an exact-match partition and one range attribute.
 *
 * @constant
 * @type {Readonly<Record<string, Readonly<Record<string, {partition: ReadonlyArray<string>, range: string}>>>>}
 */
export const MEMORY_INDEX_DEFINITIONS = Object.freeze({
  run: Object.freeze({
    'by-epic': Object.freeze({
      partition: Object.freeze(['epicKey']),
      range: 'createdAt',
    }),
    'by-status': Object.freeze({
      partition: Object.freeze(['status']),
      range: 'updatedAt',
    }),
  }),
  step: Object.freeze({
    'by-run': Object.freeze({
      partition: Object.freeze(['runId']),
      range: 'idx',
    }),
    'by-status-deadline': Object.freeze({
      partition: Object.freeze(['status']),
      range: 'deadlineAt',
    }),
    'by-status-created': Object.freeze({
      partition: Object.freeze(['status']),
      range: 'createdAt',
    }),
    'by-child-issue': Object.freeze({
      partition: Object.freeze(['childIssueKey']),
      range: 'createdAt',
    }),
  }),
  effect: Object.freeze({
    'by-status': Object.freeze({
      partition: Object.freeze(['status']),
      range: 'updatedAt',
    }),
    'by-run': Object.freeze({
      partition: Object.freeze(['runId']),
      range: 'updatedAt',
    }),
  }),
  memory: Object.freeze({
    'by-project': Object.freeze({
      partition: Object.freeze(['projectKey']),
      range: 'createdAt',
    }),
  }),
  // `seq` is an integer. The float timestamp `at` is stored on the row and
  // is deliberately not an index range, so queries do not condition on it.
  event: Object.freeze({
    'by-run': Object.freeze({
      partition: Object.freeze(['runId']),
      range: 'seq',
    }),
    'by-journal': Object.freeze({
      partition: Object.freeze(['journalKey']),
      range: 'seq',
    }),
  }),
});

/**
 * Deep-copy a JSON record so callers cannot mutate stored state by changing a
 * returned object. JSON copying also matches the Forge adapter, where all
 * values cross a JSON boundary.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {number}
 */
function compareValues(left, right) {
  if (left === right) {
    return 0;
  }
  return /** @type {number|string} */ (left) < /** @type {number|string} */ (right)
    ? -1
    : 1;
}

/**
 * @param {unknown} value
 * @param {{op: string, value: number|string}} range
 * @returns {boolean}
 */
function matchesRange(value, range) {
  switch (range.op) {
    case 'lt':
      return compareValues(value, range.value) < 0;
    case 'lte':
      return compareValues(value, range.value) <= 0;
    case 'gt':
      return compareValues(value, range.value) > 0;
    case 'gte':
      return compareValues(value, range.value) >= 0;
    case 'eq':
      return compareValues(value, range.value) === 0;
    default:
      throw new StoreValidationError(
        `Unsupported range operator: ${String(range.op)}`,
      );
  }
}

/**
 * Create the low-level in-memory persistence backend.
 *
 * @returns {object} Backend consumed by `createStoreFromBackend`.
 */
export function createMemoryBackend() {
  /** @type {Map<string, Map<string, Record<string, unknown>>>} */
  const tables = new Map();

  /**
   * @param {string} entityName
   * @returns {Map<string, Record<string, unknown>>}
   */
  function table(entityName) {
    let rows = tables.get(entityName);
    if (!rows) {
      rows = new Map();
      tables.set(entityName, rows);
    }
    return rows;
  }

  /**
   * @param {string} entityName
   * @param {string} key
   * @returns {Promise<{id: string, record: Record<string, unknown>}|null>}
   */
  async function get(entityName, key) {
    const record = table(entityName).get(key);
    return record === undefined ? null : { id: key, record: clone(record) };
  }

  /**
   * @param {string} entityName
   * @param {string} key
   * @param {Record<string, unknown>} record
   * @returns {Promise<void>}
   */
  async function set(entityName, key, record) {
    table(entityName).set(key, clone(record));
  }

  /**
   * @param {string} entityName
   * @param {string} key
   * @param {Record<string, unknown>} record
   * @returns {Promise<boolean>}
   */
  async function putIfAbsent(entityName, key, record) {
    const rows = table(entityName);
    if (rows.has(key)) {
      return false;
    }
    rows.set(key, clone(record));
    return true;
  }

  /**
   * @param {string} entityName
   * @param {string} key
   * @param {Record<string, unknown>} record
   * @param {string} field
   * @param {unknown} expected
   * @returns {Promise<boolean>}
   */
  async function updateIfMatch(entityName, key, record, field, expected) {
    const rows = table(entityName);
    const current = rows.get(key);
    if (!current || current[field] !== expected) {
      return false;
    }
    rows.set(key, clone(record));
    return true;
  }

  /**
   * Mimic a Forge named-index query: exact partition match, one range
   * comparison, sort by the range attribute, then apply the limit.
   *
   * @param {string} entityName
   * @param {string} indexName
   * @param {{partition?: unknown[], range?: {op: string, value: number|string}, direction?: 'ASC'|'DESC', limit?: number}} [queryOptions]
   * @returns {Promise<Array<{id: string, record: Record<string, unknown>}>>}
   */
  async function query(entityName, indexName, queryOptions = {}) {
    const definition = MEMORY_INDEX_DEFINITIONS[entityName]?.[indexName];
    if (!definition) {
      throw new StoreValidationError(
        `Unknown entity index ${entityName}.${indexName}`,
      );
    }

    const {
      partition = [],
      range,
      direction = 'ASC',
      limit,
    } = queryOptions;
    if (!Array.isArray(partition)) {
      throw new StoreValidationError('query partition must be an array');
    }
    if (partition.length !== definition.partition.length) {
      throw new StoreValidationError(
        `Index ${entityName}.${indexName} expects ${definition.partition.length} partition value(s)`,
      );
    }
    if (direction !== 'ASC' && direction !== 'DESC') {
      throw new StoreValidationError('query direction must be ASC or DESC');
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      throw new StoreValidationError(
        'query limit must be a non-negative integer',
      );
    }

    /** @type {Array<{id: string, record: Record<string, unknown>}>} */
    const results = [];
    for (const [id, record] of table(entityName)) {
      const partitionMatches = definition.partition.every(
        (attribute, index) => record[attribute] === partition[index],
      );
      if (!partitionMatches) {
        continue;
      }

      const rangeValue = record[definition.range];
      // A Forge named index only contains rows that have the range attribute.
      if (rangeValue === undefined || rangeValue === null) {
        continue;
      }
      if (range && !matchesRange(rangeValue, range)) {
        continue;
      }
      results.push({ id, record: clone(record) });
    }

    results.sort((left, right) => {
      const order = compareValues(
        left.record[definition.range],
        right.record[definition.range],
      );
      if (order !== 0) {
        return direction === 'DESC' ? -order : order;
      }
      return left.id.localeCompare(right.id);
    });

    if (limit === 0) {
      return [];
    }
    return limit === undefined ? results : results.slice(0, limit);
  }

  /**
   * Delete is not part of the WP1 public interface, but keeping it on the
   * backend makes test cleanup and future admin tooling straightforward.
   *
   * @param {string} entityName
   * @param {string} key
   * @returns {Promise<void>}
   */
  async function remove(entityName, key) {
    table(entityName).delete(key);
  }

  return { get, set, putIfAbsent, updateIfMatch, query, delete: remove };
}

/**
 * Create a complete in-memory WP1 store.
 *
 * @param {import('./types.js').StoreOptions} [options] Clock/id injection.
 * @returns {import('./types.js').Store}
 */
export function createMemoryStore(options = {}) {
  return createStoreFromBackend(createMemoryBackend(), options);
}

/**
 * Alias kept for callers that prefer the adapter naming.
 *
 * @param {import('./types.js').StoreOptions} [options]
 * @returns {import('./types.js').Store}
 */
export const createMemoryAdapter = createMemoryStore;
