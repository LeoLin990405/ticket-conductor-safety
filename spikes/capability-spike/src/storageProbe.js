import { kvs, Sort, WhereConditions } from '@forge/kvs';

import { epochMsFitsEntityInteger } from './timestamps.js';

/**
 * Custom Entity Store probe.
 *
 * Queries always name one index. A partition is an exact match, in the
 * order declared in the manifest. `where` filters the single range attribute.
 * Page size defaults to 10 and cannot exceed 100; follow nextCursor.
 * https://developer.atlassian.com/platform/forge/storage-reference/entities-api-query/
 *
 * @forge/kvs 2.1.1 exports WhereConditions.greaterThan and Sort.DESC.
 * One example on the query page calls WhereConditions.isGreaterThan and
 * SortOrder.DESC. Those names are not in this package. Use the SDK names.
 * https://developer.atlassian.com/platform/forge/storage-reference/entities-api-query/
 *
 * `integer` is int32. `float` has 38 decimal digits and accepts epoch ms.
 * https://developer.atlassian.com/platform/forge/storage-reference/entities-manifest/
 *
 * keyPolicy FAIL_IF_EXISTS is the idempotent write WP2 needs.
 * https://developer.atlassian.com/platform/forge/storage-reference/entities-api/
 *
 * The package requires the storage:app scope.
 * https://developer.atlassian.com/platform/forge/storage-reference/entities-api-query/
 */

const ENTITY = 'spike-run';
const EPIC_KEY = 'SPIKE';

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * @returns {Promise<Record<string, unknown>>}
 */
export async function probeStorage() {
  const createdAt = Date.now();
  const localIntegerCheck = epochMsFitsEntityInteger(createdAt);

  const record = {
    epicKey: EPIC_KEY,
    // Float attribute. A whole-number millisecond timestamp is in range.
    createdAt,
    // Keep the integer attribute inside int32 so the happy-path write can succeed.
    epochMsInt: 1,
    status: 'planning',
  };

  await kvs.entity(ENTITY).set('probe-ok', record);

  const page = await kvs
    .entity(ENTITY)
    .query()
    .index('by-epic', { partition: [EPIC_KEY] })
    .where(WhereConditions.greaterThan(0))
    .sort(Sort.DESC)
    .limit(10)
    .getMany();

  const found = (page.results || []).some((row) => row.key === 'probe-ok');

  let integerOverflowRejected = false;
  let integerOverflowError = null;
  try {
    await kvs.entity(ENTITY).set('probe-int', {
      epicKey: EPIC_KEY,
      createdAt,
      epochMsInt: createdAt,
      status: 'planning',
    });
    // The platform accepted an epoch-ms integer. Delete it and report the surprise.
    await kvs.entity(ENTITY).delete('probe-int');
  } catch (error) {
    integerOverflowRejected = true;
    integerOverflowError = errorText(error);
  }

  // A fresh key so a second curl of this probe is not confused with the first.
  const idemKey = `probe-idem-${createdAt}`;
  let firstWrite = 'unknown';
  let secondWrite = 'unknown';
  try {
    await kvs.entity(ENTITY).set(idemKey, record, { keyPolicy: 'FAIL_IF_EXISTS' });
    firstWrite = 'created';
  } catch (error) {
    firstWrite = errorText(error);
  }
  try {
    await kvs.entity(ENTITY).set(idemKey, record, { keyPolicy: 'FAIL_IF_EXISTS' });
    secondWrite = 'created';
  } catch (error) {
    secondWrite = errorText(error);
  }
  try {
    await kvs.entity(ENTITY).delete(idemKey);
  } catch (error) {
    // The two write results above are the evidence. Cleanup failure is reported, not fatal.
    secondWrite = `${secondWrite}; delete: ${errorText(error)}`;
  }

  return {
    ok: found && integerOverflowRejected && firstWrite === 'created' && secondWrite !== 'created',
    queriedKeyFound: found,
    nextCursor: page.nextCursor || null,
    localIntegerCheckFits: localIntegerCheck,
    integerOverflowRejected,
    integerOverflowError,
    failIfExists: {
      first: firstWrite,
      second: secondWrite,
    },
  };
}
