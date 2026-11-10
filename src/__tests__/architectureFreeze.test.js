/**
 * Architecture freeze (M3, the 2026-11-23 package).
 *
 * Forge treats a new scope as a reason to reinstall, and a new queue,
 * entity, or attribute as a manifest change that has to be deployed.
 * Deleting an attribute that already shipped is rejected too. This file
 * reads manifest.yml and compares those lists to the snapshot below.
 * docs/freeze.md is the same list in prose.
 *
 * A bug fix, a doc edit, or panel copy that leaves the manifest alone
 * still passes. Changing a description string also passes: copy is
 * allowed through M4. Adding a scope, a queue, an action, a module, or
 * a storage field fails until this snapshot and the freeze note move
 * together, which is the review signal.
 *
 * The parser is the `yaml` package scripts/gen-entity-schema.mjs already
 * uses. It is a transitive dependency of the Forge CLI. This test does
 * not add a package.
 *
 * @module __tests__/architectureFreeze
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

import { REUSABLE_TOOL_KEYS } from '../actions/contract.js';
import { FAULT_TYPES } from '../chaos/faults.js';
import { EFFECT_QUEUE_NAME } from '../effects/queue.js';
import { STEP_QUEUE_NAME } from '../run/dependencies.js';
import {
  EFFECT_KINDS,
  EFFECT_STATUSES,
  EVENT_KINDS,
  MEMORY_TYPES,
  RUN_STATUSES,
  STEP_STATUSES,
} from '../store/types.js';
import {
  ACTIVE_WINDOW_MS,
  GATE_KEY,
  SCAN_EVERY_MS,
} from '../watchdog/gate.js';
import {
  EFFECT_QUEUE_NAME as WATCHDOG_EFFECT_QUEUE,
  STEP_QUEUE_NAME as WATCHDOG_STEP_QUEUE,
} from '../watchdog/constants.js';

const root = new URL('../../', import.meta.url);

/**
 * App id of this Forge app. A different id is a different app.
 * @constant {string}
 */
const APP_ID = 'ari:cloud:ecosystem::app/00000000-0000-4000-8000-0000000000a1';

/**
 * OAuth scopes, in manifest order. `search:confluence` is the research
 * worker's CQL scope. There is no delete-issue scope.
 *
 * @constant {ReadonlyArray<string>}
 */
const SCOPES = Object.freeze([
  'read:jira-work',
  'write:jira-work',
  'storage:app',
  'search:confluence',
]);

/**
 * The only two async queues. Consumer key, queue name, function key.
 * @constant {ReadonlyArray<{key: string, queue: string, function: string}>}
 */
const QUEUES = Object.freeze([
  Object.freeze({ key: 'step-worker', queue: 'step-queue', function: 'stepWorker' }),
  Object.freeze({ key: 'effect-applier', queue: 'effect-queue', function: 'effectApplier' }),
]);

/**
 * Rovo action keys, in manifest order, with the function and the verb.
 * Descriptions are copy and are not snapshotted.
 *
 * @constant {ReadonlyArray<{key: string, function: string, actionVerb: string}>}
 */
const ACTIONS = Object.freeze([
  Object.freeze({ key: 'plan-split', function: 'planSplit', actionVerb: 'CREATE' }),
  Object.freeze({ key: 'dispatch-run', function: 'dispatchRun', actionVerb: 'UPDATE' }),
  Object.freeze({ key: 'get-run-status', function: 'getRunStatus', actionVerb: 'GET' }),
  Object.freeze({ key: 'recall-memory', function: 'recallMemory', actionVerb: 'GET' }),
  Object.freeze({ key: 'record-decision', function: 'recordDecision', actionVerb: 'CREATE' }),
  Object.freeze({ key: 'replay-run', function: 'replayRun', actionVerb: 'GET' }),
  Object.freeze({ key: 'fork-run', function: 'forkRun', actionVerb: 'CREATE' }),
]);

/** Tools a second agent and `rovo:mcp` may call. Supervisor-only tools stay off this list. */
const REUSABLE_ACTIONS = Object.freeze([
  'plan-split',
  'dispatch-run',
  'get-run-status',
  'recall-memory',
]);

/** Every `modules.<type>[].key`, sorted, so a new module fails even when the YAML moves. */
const MODULE_KEYS = Object.freeze([
  'action:dispatch-run',
  'action:fork-run',
  'action:get-run-status',
  'action:plan-split',
  'action:recall-memory',
  'action:record-decision',
  'action:replay-run',
  'consumer:effect-applier',
  'consumer:step-worker',
  'function:childIssueUpdated',
  'function:devDispatch',
  'function:dispatchRun',
  'function:effectApplier',
  'function:forkRun',
  'function:getRunStatus',
  'function:panelResolver',
  'function:planSplit',
  'function:recallMemory',
  'function:recordDecision',
  'function:replayRun',
  'function:stepWorker',
  'function:watchdogHandler',
  'jira:issuePanel:run-panel',
  'llm:conductor-llm',
  'rovo:agent:conductor-handoff',
  'rovo:agent:conductor-router',
  'rovo:mcp:conductor-mcp',
  'rovo:skill:conductor-playbook',
  'rovo:skill:conductor-tools',
  'scheduledTrigger:watchdog',
  'trigger:child-issue-updated',
  'webtrigger:dev-dispatch',
]);

/**
 * Custom Entity Store. Attribute name to Forge type, then indexes.
 * The entity key (runId, stepId, requestKey, memId, `${runId}#${seq}`)
 * is absent on purpose.
 *
 * @constant
 */
const ENTITIES = Object.freeze({
  run: entity(
    {
      epicKey: 'string',
      projectKey: 'string',
      goal: 'string',
      status: 'string',
      createdBy: 'string',
      createdAt: 'float',
      updatedAt: 'float',
      summary: 'any',
      summarizeQueued: 'boolean',
      forkedFromRunId: 'string',
      forkedFromStepIdx: 'integer',
      forkSeq: 'integer',
      reviewedThroughWave: 'integer',
      ledger: 'any',
      budget: 'any',
    },
    [
      index('by-epic', ['epicKey'], ['createdAt']),
      index('by-status', ['status'], ['updatedAt']),
    ],
  ),
  step: entity(
    {
      runId: 'string',
      idx: 'integer',
      title: 'string',
      workerType: 'string',
      input: 'any',
      childIssueKey: 'string',
      status: 'string',
      attempt: 'integer',
      deadlineAt: 'float',
      createdAt: 'float',
      output: 'any',
      error: 'any',
      dependsOn: 'any',
      dependencyContext: 'any',
      stallCount: 'integer',
      skill: 'string',
      brief: 'any',
      wave: 'integer',
    },
    [
      index('by-run', ['runId'], ['idx']),
      index('by-status-deadline', ['status'], ['deadlineAt']),
      index('by-status-created', ['status'], ['createdAt']),
      index('by-child-issue', ['childIssueKey'], ['createdAt']),
    ],
  ),
  effect: entity(
    {
      runId: 'string',
      stepId: 'string',
      kind: 'string',
      payload: 'any',
      status: 'string',
      tries: 'integer',
      result: 'any',
      appliedAt: 'float',
      updatedAt: 'float',
    },
    [
      index('by-status', ['status'], ['updatedAt']),
      index('by-run', ['runId'], ['updatedAt']),
    ],
  ),
  memory: entity(
    {
      projectKey: 'string',
      scope: 'string',
      memType: 'string',
      text: 'string',
      sourceIssue: 'string',
      runId: 'string',
      validUntil: 'float',
      supersededBy: 'string',
      createdAt: 'float',
    },
    [
      index('by-project', ['projectKey'], ['createdAt']),
    ],
  ),
  event: entity(
    {
      runId: 'string',
      seq: 'integer',
      kind: 'string',
      at: 'float',
      stepId: 'string',
      stepIdx: 'integer',
      journalKey: 'string',
      span: 'any',
      detail: 'any',
    },
    [
      index('by-run', ['runId'], ['seq']),
      index('by-journal', ['journalKey'], ['seq']),
    ],
  ),
});

/**
 * @param {Record<string, string>} attributes
 * @param {Array<{name: string, partition: string[], range: string[]}>} indexes
 */
function entity(attributes, indexes) {
  return Object.freeze({
    attributes: Object.freeze({ ...attributes }),
    indexes: Object.freeze(indexes.map((item) => Object.freeze({
      name: item.name,
      partition: Object.freeze([...item.partition]),
      range: Object.freeze([...item.range]),
    }))),
  });
}

/**
 * @param {string} name
 * @param {string[]} partition
 * @param {string[]} range
 */
function index(name, partition, range) {
  return { name, partition, range };
}

/**
 * @param {string} path Path relative to the repo root.
 * @returns {object}
 */
function readYaml(path) {
  return parse(readFileSync(new URL(path, root), 'utf8'));
}

/**
 * Storage block as a map the snapshot can deep-equal. Key order in the
 * YAML does not matter. Index order does, because that is the order Forge
 * declares them in.
 *
 * @param {object} doc Parsed manifest or the entities snippet.
 * @returns {Record<string, {attributes: Record<string, string>, indexes: object[]}>}
 */
function storageMap(doc) {
  const entities = doc?.app?.storage?.entities;
  assert.ok(Array.isArray(entities), 'app.storage.entities is missing');
  /** @type {Record<string, {attributes: Record<string, string>, indexes: object[]}>} */
  const map = {};
  for (const entityDef of entities) {
    assert.equal(typeof entityDef.name, 'string', 'entity is missing a name');
    /** @type {Record<string, string>} */
    const attributes = {};
    for (const [name, spec] of Object.entries(entityDef.attributes ?? {})) {
      attributes[name] = spec?.type;
    }
    const indexes = (entityDef.indexes ?? []).map((item) => ({
      name: item.name,
      partition: item.partition,
      range: item.range,
    }));
    map[entityDef.name] = { attributes, indexes };
  }
  return map;
}

/**
 * `type:key` for every module entry that has a key.
 *
 * @param {object} doc
 * @returns {string[]}
 */
function moduleKeys(doc) {
  /** @type {string[]} */
  const keys = [];
  for (const [type, entries] of Object.entries(doc.modules ?? {})) {
    assert.ok(Array.isArray(entries), `${type} is not a list`);
    for (const entry of entries) {
      assert.equal(typeof entry?.key, 'string', `${type} entry is missing a key`);
      keys.push(`${type}:${entry.key}`);
    }
  }
  keys.sort();
  return keys;
}

/**
 * @param {object} doc
 * @param {string} moduleName `rovo:agent` or `rovo:skill`.
 * @param {string} key
 * @returns {object}
 */
function moduleByKey(doc, moduleName, key) {
  const found = (doc.modules?.[moduleName] ?? []).find((entry) => entry.key === key);
  assert.ok(found, `missing ${moduleName} ${key}`);
  return found;
}

test('frozen scopes, queues, and app id match manifest.yml', () => {
  const manifest = readYaml('manifest.yml');
  assert.equal(manifest.app.id, APP_ID);
  assert.deepEqual(manifest.app.runtime, {
    name: 'nodejs24.x',
    memoryMB: 256,
    architecture: 'arm64',
  });
  assert.deepEqual(manifest.app.storage.classifications, ['ugc']);
  assert.deepEqual(manifest.permissions.scopes, SCOPES);
  assert.deepEqual(
    manifest.modules.consumer.map((consumer) => ({
      key: consumer.key,
      queue: consumer.queue,
      function: consumer.function,
    })),
    QUEUES,
  );
  assert.equal(manifest.modules.scheduledTrigger.length, 1);
  assert.equal(manifest.modules.scheduledTrigger[0].key, 'watchdog');
  assert.equal(manifest.modules.scheduledTrigger[0].interval, 'fiveMinute');
  assert.deepEqual(manifest.modules.llm, [{ key: 'conductor-llm', model: ['claude'] }]);
});

test('frozen entities, attributes, types, and indexes match the manifest and the snippet', () => {
  const manifest = readYaml('manifest.yml');
  const snippet = readYaml('src/store/entities.manifest.yml');
  const fromManifest = storageMap(manifest);
  // The snippet is what WP1 maintains. WP9 pastes it into the root manifest.
  // They have to stay the same storage block or a deploy can ship one and
  // the adapter can enforce the other.
  assert.deepEqual(storageMap(snippet), fromManifest);
  assert.deepEqual(Object.keys(fromManifest), ['run', 'step', 'effect', 'memory', 'event']);
  assert.deepEqual(fromManifest, ENTITIES);
});

test('frozen action keys and module keys match manifest.yml', () => {
  const manifest = readYaml('manifest.yml');
  assert.deepEqual(
    manifest.modules.action.map((action) => ({
      key: action.key,
      function: action.function,
      actionVerb: action.actionVerb,
    })),
    ACTIONS,
  );
  assert.deepEqual(moduleKeys(manifest), MODULE_KEYS);

  const router = moduleByKey(manifest, 'rovo:agent', 'conductor-router');
  const handoff = moduleByKey(manifest, 'rovo:agent', 'conductor-handoff');
  const playbook = moduleByKey(manifest, 'rovo:skill', 'conductor-playbook');
  const tools = moduleByKey(manifest, 'rovo:skill', 'conductor-tools');
  const mcp = moduleByKey(manifest, 'rovo:mcp', 'conductor-mcp');
  const allKeys = ACTIONS.map((action) => action.key);

  assert.deepEqual(router.actions, allKeys);
  assert.deepEqual(playbook.dependencies.tools, allKeys);
  assert.deepEqual(handoff.actions, REUSABLE_ACTIONS);
  assert.deepEqual(tools.dependencies.tools, REUSABLE_ACTIONS);
  assert.deepEqual(mcp.tools, REUSABLE_ACTIONS);
  assert.deepEqual(REUSABLE_TOOL_KEYS, REUSABLE_ACTIONS);
  assert.equal(router.actions.includes('record-decision'), true);
  assert.equal(mcp.tools.includes('record-decision'), false);
  assert.equal(mcp.tools.includes('replay-run'), false);
  assert.equal(mcp.tools.includes('fork-run'), false);
});

test('queue names, storage enums, fault names, and the watchdog gate stay on the frozen values', () => {
  // Three modules name the queues. A rename in one of them would push to a
  // queue the manifest does not consume.
  assert.equal(STEP_QUEUE_NAME, 'step-queue');
  assert.equal(WATCHDOG_STEP_QUEUE, 'step-queue');
  assert.equal(EFFECT_QUEUE_NAME, 'effect-queue');
  assert.equal(WATCHDOG_EFFECT_QUEUE, 'effect-queue');

  assert.deepEqual(RUN_STATUSES, [
    'planning',
    'running',
    'blocked',
    'done',
    'failed',
    'awaiting-review',
  ]);
  assert.deepEqual(STEP_STATUSES, [
    'queued',
    'waiting',
    'running',
    'done',
    'failed',
    'blocked',
  ]);
  assert.deepEqual(EFFECT_STATUSES, [
    'pending',
    'applying',
    'applied',
    'retrying',
    'failed',
  ]);
  assert.deepEqual(EFFECT_KINDS, [
    'createIssue',
    'comment',
    'transition',
    'setFields',
    'closeIssue',
    'recordRemovedComment',
    'restoreStatus',
    'restoreFields',
  ]);
  assert.deepEqual(EVENT_KINDS, [
    'plan.created',
    'step.queued',
    'step.started',
    'step.succeeded',
    'step.failed',
    'step.retried',
    'watchdog.self-heal',
    'effect.written',
    'memory.written',
    'replan',
    'run.forked',
    'wave_started',
    'lead_decision',
    'digest_written',
  ]);
  assert.deepEqual(MEMORY_TYPES, ['decision', 'lesson', 'fact']);
  assert.deepEqual(FAULT_TYPES, ['kill-worker', 'duplicate-effect', 'jira-429']);

  // Not an entity. One KVS key, read by the fiveMinute trigger, so an idle
  // install does not scan steps. 15 minutes between scans, 2 hour window.
  assert.equal(GATE_KEY, 'tc-watchdog-gate');
  assert.equal(SCAN_EVERY_MS, 15 * 60 * 1000);
  assert.equal(ACTIVE_WINDOW_MS, 2 * 60 * 60 * 1000);
});
