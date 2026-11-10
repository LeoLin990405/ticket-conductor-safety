/**
 * Plan dependency graph (WP10).
 *
 * A plan is a list of steps. `dependsOn` names other steps by their `idx`
 * (the position in that list, starting at 0). A step may start only when
 * every index in `dependsOn` is `done`. Steps with an empty list start
 * together.
 *
 * The same checks run twice:
 * - at plan time, inside `parsePlanSteps`, before a run is stored;
 * - at dispatch, inside `startRun`, so a plan written straight to the store
 *   cannot deadlock the queue.
 *
 * This module does not talk to Forge storage. Callers pass plain objects.
 *
 * @module run/graph
 */

import { StoreValidationError } from '../store/errors.js';

/**
 * How large `dependencyContext` may be. The store rejects a single field
 * over 64 KiB. Leaving a margin means the step row still has room for
 * `output` and `error` beside this copy of the upstream results.
 * @constant {number}
 */
export const DEPENDENCY_CONTEXT_BUDGET = 48 * 1024;

const textEncoder = new TextEncoder();

/**
 * @param {unknown} value
 * @returns {number}
 */
function jsonBytes(value) {
  try {
    return textEncoder.encode(JSON.stringify(value) ?? '').length;
  } catch {
    return textEncoder.encode(String(value)).length;
  }
}

/**
 * Short text stand-in when a dependency output is too large to copy.
 *
 * @param {unknown} output
 * @returns {string}
 */
function previewOutput(output) {
  let text;
  try {
    text = typeof output === 'string' ? output : JSON.stringify(output);
  } catch {
    text = String(output);
  }
  if (typeof text !== 'string') {
    return '';
  }
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

/**
 * Read `dependsOn` from one plan object.
 *
 * Missing means "no dependencies" (the step starts with the run). Anything
 * that is not a list of indexes is a plan error, not a value we guess at.
 *
 * @param {unknown} value
 * @param {string} label Step label used in the error, e.g. `step 2`.
 * @returns {number[]}
 */
export function readDependsOn(value, label) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new StoreValidationError(
      `${label}.dependsOn must be an array of step indexes`,
    );
  }
  /** @type {number[]} */
  const indexes = [];
  const seen = new Set();
  for (let position = 0; position < value.length; position += 1) {
    const entry = value[position];
    if (!Number.isInteger(entry) || entry < 0) {
      throw new StoreValidationError(
        `${label}.dependsOn[${position}] must be a non-negative integer step index`,
      );
    }
    if (seen.has(entry)) {
      throw new StoreValidationError(
        `${label}.dependsOn lists ${entry} more than once`,
      );
    }
    seen.add(entry);
    indexes.push(entry);
  }
  return indexes;
}

/**
 * Check one plan for bad indexes and cycles.
 *
 * Each item needs `dependsOn`. `idx` is the step's own index. When `idx` is
 * omitted, the array position is used, which is how a plan looks before the
 * store assigns indexes.
 *
 * The function returns the same steps with `dependsOn` normalised to a list
 * of integers. It does not write anything.
 *
 * @template {Record<string, any>} T
 * @param {T[]} steps
 * @returns {Array<T & {idx: number, dependsOn: number[]}>}
 */
export function normalizePlanGraph(steps) {
  if (!Array.isArray(steps)) {
    throw new StoreValidationError('a plan graph must be an array of steps');
  }

  const normalized = steps.map((step, position) => {
    const idx = Number.isInteger(step?.idx) ? step.idx : position;
    const label = `step ${idx}`;
    const dependsOn = readDependsOn(step?.dependsOn, label);
    if (dependsOn.includes(idx)) {
      throw new StoreValidationError(
        `${label}.dependsOn cannot include its own index`,
      );
    }
    return { ...step, idx, dependsOn };
  });

  const known = new Set(normalized.map((step) => step.idx));
  for (const step of normalized) {
    for (const dep of step.dependsOn) {
      if (!known.has(dep)) {
        throw new StoreValidationError(
          `step ${step.idx}.dependsOn references ${dep}, which is not a step in this plan`,
        );
      }
    }
  }

  assertAcyclic(normalized);
  return normalized;
}

/**
 * Follow `dependsOn` edges. A step that is seen again before its branch
 * finishes is a cycle. The message lists the indexes, e.g. `0 -> 1 -> 0`,
 * so the Router can fix `stepsJson` without guessing.
 *
 * @param {Array<{idx: number, dependsOn: number[]}>} steps
 * @returns {void}
 */
function assertAcyclic(steps) {
  const byIdx = new Map(steps.map((step) => [step.idx, step]));
  /** @type {Map<number, 0|1|2>} */
  const color = new Map();
  /** @type {number[]} */
  const stack = [];

  /**
   * @param {number} idx
   * @returns {void}
   */
  function visit(idx) {
    const state = color.get(idx) ?? 0;
    if (state === 2) {
      return;
    }
    if (state === 1) {
      const start = stack.indexOf(idx);
      const cycle = stack.slice(start).concat(idx);
      throw new StoreValidationError(
        `plan has a dependency cycle: ${cycle.join(' -> ')}`,
      );
    }
    color.set(idx, 1);
    stack.push(idx);
    const step = byIdx.get(idx);
    for (const dep of step?.dependsOn ?? []) {
      visit(dep);
    }
    stack.pop();
    color.set(idx, 2);
  }

  for (const step of steps) {
    visit(step.idx);
  }
}

/**
 * True when every dependency is already `done`. An empty `dependsOn` is
 * ready immediately. A missing dependency is not ready.
 *
 * @param {{dependsOn?: number[]}} step
 * @param {Array<{idx: number, status?: string}>} steps
 * @returns {boolean}
 */
export function dependenciesSatisfied(step, steps) {
  const done = new Set(
    steps.filter((candidate) => candidate.status === 'done').map((candidate) => candidate.idx),
  );
  const dependsOn = Array.isArray(step.dependsOn) ? step.dependsOn : [];
  return dependsOn.every((idx) => done.has(idx));
}

/**
 * Copy the outputs of the steps this one waits on.
 *
 * The worker receives the stored step object. Putting the upstream outputs
 * on `step.dependencyContext` is how a later step sees them, without the
 * worker module having to know about the graph. Order follows `dependsOn`.
 *
 * @param {{dependsOn?: number[]}} step
 * @param {Array<{idx: number, title?: string, workerType?: string, output?: unknown}>} steps
 * @param {number} [budget]
 * @returns {Array<{idx: number, title: string, workerType: string, output: unknown, truncated?: boolean}>}
 */
export function dependencyContextFor(step, steps, budget = DEPENDENCY_CONTEXT_BUDGET) {
  const byIdx = new Map(steps.map((candidate) => [candidate.idx, candidate]));
  const dependsOn = Array.isArray(step.dependsOn) ? step.dependsOn : [];
  const full = dependsOn.map((idx) => {
    const dep = byIdx.get(idx);
    return {
      idx,
      title: typeof dep?.title === 'string' ? dep.title : '',
      workerType: typeof dep?.workerType === 'string' ? dep.workerType : '',
      output: dep?.output,
    };
  });
  if (jsonBytes(full) <= budget) {
    return full;
  }

  const compact = full.map((entry) => ({
    idx: entry.idx,
    title: entry.title,
    workerType: entry.workerType,
    output: previewOutput(entry.output),
    truncated: true,
  }));
  if (jsonBytes(compact) <= budget) {
    return compact;
  }

  // Last resort: keep the identity of each dependency and drop the body.
  // The full output still lives on the dependency's own step row.
  return compact.map((entry) => ({
    idx: entry.idx,
    title: entry.title,
    workerType: entry.workerType,
    output: null,
    truncated: true,
  }));
}
