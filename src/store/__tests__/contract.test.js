import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createMemoryStore,
  createRun,
  getStore,
  resetStore,
  setStore,
} from '../index.js';
import { MEMORY_INDEX_DEFINITIONS } from '../memoryAdapter.js';

const manifest = readFileSync(
  new URL('../entities.manifest.yml', import.meta.url),
  'utf8',
);

/**
 * Extract each top-level entity block from the YAML snippet. Entity entries
 * are indented six spaces; index entries are indented ten spaces.
 *
 * @returns {Record<string, string>}
 */
function entityBlocks() {
  const blocks = {};
  const matches = [...manifest.matchAll(/^ {6}- name: ([a-zA-Z0-9_]+)$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = /** @type {number} */ (match.index) + match[0].length;
    const end =
      index + 1 < matches.length
        ? /** @type {number} */ (matches[index + 1].index)
        : manifest.length;
    blocks[match[1]] = manifest.slice(start, end);
  }
  return blocks;
}

test('entities.manifest.yml declares the WP1 entities plus the flight recorder', () => {
  const blocks = entityBlocks();
  assert.deepEqual(Object.keys(blocks).sort(), [
    'effect',
    'event',
    'memory',
    'run',
    'step',
  ]);
  assert.equal(manifest.includes('spike-run'), false);
  assert.match(manifest, /^app:\n {2}storage:/m);
  assert.match(manifest, /classifications:\n {6}- ugc/m);
});

test('run entity has the by-epic and by-status indexes', () => {
  const block = entityBlocks().run;
  assert.match(block, /^ {10}- name: by-epic$/m);
  assert.match(block, /^ {10}- name: by-status$/m);
  assert.match(block, /^ {10}createdAt:\n {12}type: float$/m);
  assert.match(block, /^ {10}updatedAt:\n {12}type: float$/m);
  assert.match(block, /^ {10}summary:\n {12}type: any$/m);
});

test('step entity has createdAt, the by-status-created index, and input', () => {
  const block = entityBlocks().step;
  assert.match(block, /^ {10}createdAt:\n {12}type: float$/m);
  assert.match(block, /^ {10}deadlineAt:\n {12}type: float$/m);
  assert.match(block, /^ {10}input:\n {12}type: any$/m);
  assert.match(block, /^ {10}- name: by-run$/m);
  assert.match(block, /^ {10}- name: by-status-deadline$/m);
  assert.match(block, /^ {10}- name: by-status-created$/m);
  assert.match(block, /^ {10}- name: by-child-issue$/m);
  // The range attribute for the queued-age index must be createdAt.
  assert.match(
    block,
    /name: by-status-created\n {12}partition:\n {14}- status\n {12}range:\n {14}- createdAt/,
  );
});

test('effect entity uses its key for requestKey and has status/run indexes', () => {
  const block = entityBlocks().effect;
  assert.match(block, /^ {10}- name: by-status$/m);
  assert.match(block, /^ {10}- name: by-run$/m);
  assert.doesNotMatch(block, /^ {10}requestKey:/m);
  assert.match(block, /^ {10}payload:\n {12}type: any$/m);
});

test('event entity orders on integer seq and does not store its key', () => {
  const block = entityBlocks().event;
  assert.match(block, /^ {10}seq:\n {12}type: integer$/m);
  assert.match(block, /^ {10}at:\n {12}type: float$/m);
  assert.doesNotMatch(block, /^ {10}eventId:/m);
  assert.match(
    block,
    /name: by-run\n {12}partition:\n {14}- runId\n {12}range:\n {14}- seq/,
  );
  assert.match(
    block,
    /name: by-journal\n {12}partition:\n {14}- journalKey\n {12}range:\n {14}- seq/,
  );
  assert.doesNotMatch(block, /range:\n {14}- at/);
});

test('memory entity stores the category as memType, not type', () => {
  const block = entityBlocks().memory;
  assert.match(block, /^ {10}memType:\n {12}type: string$/m);
  assert.doesNotMatch(block, /^ {10}type:/m);
  assert.match(block, /^ {10}- name: by-project$/m);
  assert.match(
    block,
    /name: by-project\n {12}partition:\n {14}- projectKey\n {12}range:\n {14}- createdAt/,
  );
});

test('manifest index definitions match the memory adapter definitions', () => {
  const blocks = entityBlocks();
  for (const [entityName, indexes] of Object.entries(
    MEMORY_INDEX_DEFINITIONS,
  )) {
    assert.ok(blocks[entityName], `missing entity block ${entityName}`);
    for (const [indexName, definition] of Object.entries(indexes)) {
      assert.match(
        blocks[entityName],
        new RegExp(`^ {10}- name: ${indexName}$`, 'm'),
        `missing ${entityName}.${indexName}`,
      );
      for (const partition of definition.partition) {
        assert.ok(
          blocks[entityName].includes(`- ${partition}`),
          `missing ${entityName}.${indexName} partition ${partition}`,
        );
      }
      assert.ok(
        blocks[entityName].includes(`- ${definition.range}`),
        `missing ${entityName}.${indexName} range ${definition.range}`,
      );
    }
  }
});

test('named exports use the store installed with setStore', async () => {
  const memory = createMemoryStore();
  setStore(memory);
  try {
    assert.equal(getStore(), memory);
    const run = await createRun({
      epicKey: 'TC-1',
      projectKey: 'TC',
      goal: 'Use the configured store',
      createdBy: 'account-1',
    });
    assert.deepEqual(await memory.getRun(run.runId), run);
    assert.throws(() => setStore({}), {
      name: 'TypeError',
      message: /createRun/,
    });
  } finally {
    resetStore();
  }

  // The default store is the Forge adapter. Constructing it must not import
  // @forge/kvs (that would fail without the WP9 dependency being installed).
  const forgeStore = getStore();
  assert.notEqual(forgeStore, memory);
  assert.equal(typeof forgeStore.createRun, 'function');
  assert.equal(typeof forgeStore.findStuckSteps, 'function');
  setStore(memory);
});
