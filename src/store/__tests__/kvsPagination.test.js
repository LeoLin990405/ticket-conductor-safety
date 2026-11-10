import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { Sort, WhereConditions } from '@forge/kvs';

const require = createRequire(import.meta.url);
const { KvsIndexQueryBuilder } = require('@forge/kvs/out/entity-query.js');

/**
 * @param {object} storageApi
 * @param {string} entityName
 * @param {string} indexName
 * @param {unknown[]} [partition]
 */
function realQuery(storageApi, entityName, indexName, partition = []) {
  return new KvsIndexQueryBuilder(entityName, storageApi, {}).index(indexName, {
    partition,
  });
}

import { createForgeStore } from '../forgeAdapter.js';

/**
 * The in-repo fake implements the same method names, but this test drives the
 * query builder class shipped in @forge/kvs. That class is what turns
 * `.cursor()` into the `cursor` field and renames the service's `cursor`
 * response to `nextCursor` (see @forge/kvs storage-api.js). The adapter pages
 * on `nextCursor`, which is the field apps actually receive.
 */
test('real @forge/kvs query builder pages with cursor and nextCursor', async () => {
  assert.equal(typeof WhereConditions.lessThan, 'function');
  assert.equal(typeof WhereConditions.greaterThanEqualTo, 'function');
  assert.equal(Sort.ASC, 'ASC');
  assert.equal(Sort.DESC, 'DESC');

  /** @type {Array<Record<string, unknown>>} */
  const calls = [];
  const storageApi = {
    async queryEntity(options) {
      calls.push(options);
      if (!options.cursor) {
        return {
          results: [{ key: 'run-1', value: { epicKey: 'PAY-1', createdAt: 2 } }],
          nextCursor: 'page-2',
        };
      }
      return {
        results: [{ key: 'run-2', value: { epicKey: 'PAY-1', createdAt: 1 } }],
      };
    },
  };

  const first = realQuery(storageApi, 'run', 'by-epic', ['PAY-1']);
  const page = await first
    .where(WhereConditions.greaterThanEqualTo(0))
    .sort(Sort.DESC)
    .limit(1)
    .getMany();

  assert.equal(page.nextCursor, 'page-2');
  assert.equal(calls[0].limit, 1);
  assert.equal(calls[0].sort, 'DESC');
  assert.equal(calls[0].partition[0], 'PAY-1');
  assert.equal(calls[0].range.condition, 'GREATER_THAN_EQUAL_TO');

  const second = await first.cursor(page.nextCursor).getMany();
  assert.equal(second.results[0].key, 'run-2');
  assert.equal(calls[1].cursor, 'page-2');
  assert.equal(second.nextCursor, undefined);
});

test('Forge adapter follows nextCursor from a real @forge/kvs query builder', async () => {
  /** @type {Array<Record<string, unknown>>} */
  const calls = [];
  const storageApi = {
    async queryEntity(options) {
      calls.push({ ...options });
      if (!options.cursor) {
        return {
          results: [{ key: 'run-new', value: { epicKey: 'PAY-1', createdAt: 20, projectKey: 'PAY', goal: 'new', status: 'planning', createdBy: 'a', updatedAt: 20 } }],
          nextCursor: 'older',
        };
      }
      return {
        results: [{ key: 'run-old', value: { epicKey: 'PAY-1', createdAt: 10, projectKey: 'PAY', goal: 'old', status: 'planning', createdBy: 'a', updatedAt: 10 } }],
      };
    },
  };

  const sdk = {
    kvs: {
      entity(name) {
        return {
          async get() {
            return undefined;
          },
          async set() {},
          query() {
            return {
              index(indexName, indexOptions) {
                return realQuery(
                  storageApi,
                  name,
                  indexName,
                  indexOptions?.partition,
                );
              },
            };
          },
        };
      },
    },
    WhereConditions,
    Sort,
    Filter: class {
      and() {
        return this;
      }
    },
    FilterConditions: { equalTo() {} },
  };

  const store = createForgeStore({
    sdk,
    now: () => 1_700_000_000_000,
    newId: () => 'generated',
  });
  const runs = await store.listRunsByEpic('PAY-1');
  assert.deepEqual(runs.map((run) => run.runId), ['run-new', 'run-old']);
  assert.equal(calls[0].limit, 100);
  assert.equal(calls[1].cursor, 'older');
  assert.equal(calls[1].limit, 100);
});
