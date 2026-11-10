/**
 * Forge Custom Entity Store adapter for production (WP1).
 *
 * `@forge/kvs` is imported lazily so unit tests do not need the package
 * installed. Tests inject a fake SDK through `createForgeStore({sdk})`; the
 * production singleton from `index.js` loads the real module on first use.
 *
 * The entity and index definitions this adapter expects are the ones in
 * `entities.manifest.yml`. Queries follow `nextCursor` until exhausted, page
 * at 100 (the platform maximum), and never rely on in-memory `and`/`or`
 * filters.
 *
 * @module store/forgeAdapter
 */

import { StoreError, StoreValidationError } from './errors.js';
import { createStoreFromBackend } from './storeCore.js';

/** Forge query condition method for each internal range operator. @constant */
const RANGE_METHODS = Object.freeze({
  lt: 'lessThan',
  lte: 'lessThanEqualTo',
  gt: 'greaterThan',
  gte: 'greaterThanEqualTo',
  eq: 'equalTo',
});

/**
 * @typedef {object} ForgeKvsSdk
 * @property {object} kvs The `kvs` instance exported by `@forge/kvs`.
 * @property {Function} WhereConditions `WhereConditions` helper object.
 * @property {Function} FilterConditions `FilterConditions` helper object.
 * @property {Function} Filter `Filter` class used by transactions.
 * @property {object} Sort `Sort` enum with ASC/DESC.
 */

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>|null}
 */
function unwrapEntityValue(raw) {
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return null;
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  const keys = Object.keys(record);
  // Query results are `{ key, value }`; a direct get returns attributes only.
  // Handle both shapes so the adapter also works with SDK minor versions that
  // wrap get results.
  if (keys.length === 1 && keys[0] === 'value') {
    const value = record.value;
    return value !== null && typeof value === 'object'
      ? /** @type {Record<string, unknown>} */ (value)
      : null;
  }
  if (
    keys.length === 2 &&
    keys.includes('key') &&
    keys.includes('value') &&
    record.value !== null &&
    typeof record.value === 'object'
  ) {
    return /** @type {Record<string, unknown>} */ (record.value);
  }
  return record;
}

/**
 * Strip undefined values and force a JSON-safe deep copy before writing.
 * Forge entity values cross a JSON boundary and undefined is not a valid
 * attribute value.
 *
 * @param {Record<string, unknown>} record
 * @returns {Record<string, unknown>}
 */
/**
 * The row key of each entity. It is the KVS key, not a declared attribute, so
 * it must never be written into the value: Forge rejects undeclared attributes
 * with a bare 422 (seen live: startRun's updateRun carried `runId`).
 * @type {Record<string, string>}
 */
const KEY_FIELDS = {
  run: 'runId',
  step: 'stepId',
  effect: 'requestKey',
  memory: 'memId',
  // The event key is `${runId}#${seq}`, not a field named eventId. Stripping
  // `eventId` means a caller cannot sneak the key into the value (Forge 422).
  event: 'eventId',
};

import { ENTITY_ATTRIBUTES } from './entitySchema.generated.js';

/** Backoff for a transient KVS 422 right after a deploy. @constant {number[]} */
export const TRANSIENT_422_BACKOFF_MS = Object.freeze([500, 1500, 4000, 8000]);

/**
 * A KVS 422 is transient only when the record matches the deployed schema:
 * every attribute is declared for that entity. Seen on dev for the first
 * requests after a major deploy that added attributes (5.4.0, 5.5.0); the
 * same write succeeds later. A 422 for an undeclared attribute is a real
 * error and is not retried. The budget (~14 s) fits a 25 s webtrigger; it
 * covers short blips but not the ~5 minute window seen after the 5.12.0
 * schema deploy, so check `kvsProbe` before demoing after a schema change.
 *
 * @param {unknown} error
 * @param {string} entityName
 * @param {Record<string, unknown>} stored
 * @returns {boolean}
 */
export function isTransientKvs422(error, entityName, stored) {
  const e = /** @type {any} */ (error);
  const status = e?.responseDetails?.status ?? e?.status;
  if (e?.code === 'CONDITIONAL_CHECK_FAILED') return false;
  if (status !== 422 && e?.code !== 'UNPROCESSABLE_ENTITY') return false;
  const declared = ENTITY_ATTRIBUTES[entityName];
  if (!Array.isArray(declared)) return false;
  return Object.keys(stored).every((field) => declared.includes(field));
}

/**
 * @template T
 * @param {() => Promise<T>} write
 * @param {string} entityName
 * @param {Record<string, unknown>} stored
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<T>}
 */
async function withTransient422Retry(write, entityName, stored, sleep) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      if (attempt >= TRANSIENT_422_BACKOFF_MS.length || !isTransientKvs422(error, entityName, stored)) {
        throw error;
      }
      console.warn(`[store] transient KVS 422 on ${entityName}; retry ${attempt + 1}`);
      await sleep(TRANSIENT_422_BACKOFF_MS[attempt]);
    }
  }
}

function toStoredRecord(record, entityName) {
  const keyField = KEY_FIELDS[entityName];
  const cleaned = {};
  for (const [field, value] of Object.entries(record)) {
    if (field === keyField) continue;
    if (value !== undefined) {
      cleaned[field] = value;
    }
  }
  return JSON.parse(JSON.stringify(cleaned));
}

/**
 * @param {ForgeKvsSdk|(() => Promise<ForgeKvsSdk>)|undefined} sdkOrLoader
 * @returns {object} Backend consumed by `createStoreFromBackend`.
 */
export function createForgeBackend(sdkOrLoader, backendOptions = {}) {
  const sleep = backendOptions.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  /** @type {(() => Promise<ForgeKvsSdk>)|null} */
  let loader = null;
  if (typeof sdkOrLoader === 'function') {
    loader = sdkOrLoader;
  } else if (sdkOrLoader) {
    loader = async () => sdkOrLoader;
  }

  // Cache the dynamic import: one module load per function instance, not one
  // per storage call.
  /** @type {Promise<ForgeKvsSdk>|null} */
  let sdkPromise = null;

  /**
   * @returns {Promise<ForgeKvsSdk>}
   */
  async function getSdk() {
    if (loader) {
      sdkPromise ??= loader();
    } else {
      // Dynamic import keeps `node --test` runnable without @forge/kvs in
      // package.json while WP9 owns dependency installation.
      sdkPromise ??= /** @type {Promise<ForgeKvsSdk>} */ (
        import('@forge/kvs')
      );
    }
    return sdkPromise;
  }

  /**
   * @param {string} entityName
   * @param {string} key
   * @returns {Promise<{id: string, record: Record<string, unknown>}|null>}
   */
  async function get(entityName, key) {
    const sdk = await getSdk();
    const raw = await sdk.kvs.entity(entityName).get(key);
    const record = unwrapEntityValue(raw);
    return record === null ? null : { id: key, record };
  }

  /**
   * @param {string} entityName
   * @param {string} key
   * @param {Record<string, unknown>} record
   * @returns {Promise<void>}
   */
  async function set(entityName, key, record) {
    const sdk = await getSdk();
    const stored = toStoredRecord(record, entityName);
    await withTransient422Retry(
      () => sdk.kvs.entity(entityName).set(key, stored),
      entityName, stored, sleep,
    );
  }

  /**
   * Insert only when the key is absent. `FAIL_IF_EXISTS` is the platform's
   * idempotent-create primitive; if it fails, re-read to confirm the key
   * exists and only swallow that specific outcome.
   *
   * @param {string} entityName
   * @param {string} key
   * @param {Record<string, unknown>} record
   * @returns {Promise<boolean>}
   */
  async function putIfAbsent(entityName, key, record) {
    const sdk = await getSdk();
    try {
      const stored = toStoredRecord(record, entityName);
      await withTransient422Retry(
        () => sdk.kvs.entity(entityName).set(key, stored, { keyPolicy: 'FAIL_IF_EXISTS' }),
        entityName, stored, sleep,
      );
      return true;
    } catch (error) {
      let existing;
      try {
        existing = await get(entityName, key);
      } catch {
        // A failed follow-up read tells us nothing about the original write,
        // so surface the original storage error.
        throw error;
      }
      if (existing) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Compare-and-set a record on one attribute. The platform transaction fails
   * as a whole when the condition is not met; the exact error class is not
   * documented, so re-read the row to distinguish a lost race from a real
   * storage error.
   *
   * @param {string} entityName
   * @param {string} key
   * @param {Record<string, unknown>} record
   * @param {string} field
   * @param {unknown} expected
   * @returns {Promise<boolean>}
   */
  async function updateIfMatch(
    entityName,
    key,
    record,
    field,
    expected,
  ) {
    const sdk = await getSdk();
    try {
      const stored = toStoredRecord(record, entityName);
      await withTransient422Retry(
        () => sdk.kvs
          .transact()
          .set(key, stored, {
            entityName,
            conditions: new sdk.Filter().and(
              field,
              sdk.FilterConditions.equalTo(expected),
            ),
          })
          .execute(),
        entityName, stored, sleep,
      );
      return true;
    } catch (error) {
      let current;
      try {
        current = await get(entityName, key);
      } catch {
        // The transaction error is the useful failure; do not replace it with
        // a secondary read error.
        throw error;
      }
      if (!current || current.record[field] !== expected) {
        return false;
      }
      // The condition held, so the write itself was refused (for example an
      // attribute the deployed schema does not declare). Float, integer, and
      // string conditions are all accepted by Forge KVS (dev probe, 4.8.0).
      if (error && typeof error === 'object') {
        error.kvsWrite = {
          entityName,
          conditionField: field,
          attributes: Object.keys(record).sort(),
        };
      }
      throw error;
    }
  }

  /**
   * Query one named index and follow `nextCursor` until the result is
   * exhausted or the caller's limit is reached.
   *
   * @param {string} entityName
   * @param {string} indexName
   * @param {{partition?: unknown[], range?: {op: string, value: number|string}, direction?: 'ASC'|'DESC', limit?: number}} [queryOptions]
   * @returns {Promise<Array<{id: string, record: Record<string, unknown>}>>}
   */
  async function query(entityName, indexName, queryOptions = {}) {
    const {
      partition = [],
      range,
      direction = 'ASC',
      limit,
    } = queryOptions;
    if (!Array.isArray(partition)) {
      throw new StoreValidationError('query partition must be an array');
    }
    if (direction !== 'ASC' && direction !== 'DESC') {
      throw new StoreValidationError('query direction must be ASC or DESC');
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      throw new StoreValidationError(
        'query limit must be a non-negative integer',
      );
    }
    if (limit === 0) {
      return [];
    }

    const sdk = await getSdk();
    const results = [];
    const seenCursors = new Set();
    let cursor;

    while (true) {
      let builder = sdk.kvs.entity(entityName).query();
      builder = partition.length
        ? builder.index(indexName, { partition })
        : builder.index(indexName);
      if (range) {
        const method = RANGE_METHODS[range.op];
        if (!method) {
          throw new StoreValidationError(
            `Unsupported range operator: ${String(range.op)}`,
          );
        }
        builder = builder.where(sdk.WhereConditions[method](range.value));
      }
      builder = builder.sort(
        direction === 'DESC' ? sdk.Sort.DESC : sdk.Sort.ASC,
      );
      if (cursor) {
        builder = builder.cursor(cursor);
      }
      const remaining =
        limit === undefined ? 100 : Math.min(100, limit - results.length);
      if (remaining <= 0) {
        break;
      }
      builder = builder.limit(remaining);

      const page = await builder.getMany();
      for (const item of page.results ?? []) {
        const record = unwrapEntityValue(item);
        if (record === null) {
          continue;
        }
        results.push({ id: item.key, record });
        if (limit !== undefined && results.length >= limit) {
          return results;
        }
      }

      const nextCursor = page.nextCursor;
      if (!nextCursor) {
        break;
      }
      if (seenCursors.has(nextCursor)) {
        throw new StoreError(
          `Forge query for ${entityName}.${indexName} returned a repeated cursor`,
          'QUERY_CURSOR_LOOP',
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return results;
  }

  return { get, set, putIfAbsent, updateIfMatch, query };
}

/**
 * Create a complete store backed by the Forge Custom Entity Store.
 *
 * Options:
 * - `sdk`: inject a `@forge/kvs`-shaped SDK (unit tests).
 * - `loadSdk`: inject an async loader for the same shape.
 * - `now`, `newId`: injectable clock/id generator.
 *
 * @param {import('./types.js').StoreOptions & {sdk?: ForgeKvsSdk, loadSdk?: () => Promise<ForgeKvsSdk>}} [options]
 * @returns {import('./types.js').Store}
 */
export function createForgeStore(options = {}) {
  let loader;
  if (options.loadSdk) {
    loader = options.loadSdk;
  } else if (options.sdk) {
    const sdk = options.sdk;
    loader = async () => sdk;
  }
  return createStoreFromBackend(createForgeBackend(loader, { sleep: options.sleep }), options);
}
