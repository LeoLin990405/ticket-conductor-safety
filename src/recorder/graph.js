/**
 * Which steps a fork re-runs.
 *
 * Downstream means the WP10 `dependsOn` graph: a step lists the indexes it
 * waits on. An empty list means the step starts with the run, not "every
 * later index". Fork re-runs the transitive dependents of step N. Edges are
 * read from the stored `dependsOn` attribute, the same list `startRun` uses.
 *
 * The automatic `summarize` step is not part of the graph. The state machine
 * appends a fresh one when the forked run finishes.
 *
 * @module recorder/graph
 */

import { readDependsOn as readDependsOnList } from '../run/graph.js';

/**
 * @param {import('../store/types.js').Step} step
 * @returns {number[]}
 */
export function dependsOnOf(step) {
  try {
    return readDependsOnList(step?.dependsOn, `step ${step?.idx ?? '?'}`);
  } catch {
    return [];
  }
}

/**
 * Indexes that transitively depend on `fromIdx`. Does not include `fromIdx`.
 *
 * @param {import('../store/types.js').Step[]} steps
 * @param {number} fromIdx
 * @returns {number[]}
 */
export function downstreamIdxs(steps, fromIdx) {
  /** @type {Map<number, number[]>} */
  const dependents = new Map();
  for (const step of steps) {
    for (const predecessor of dependsOnOf(step)) {
      const list = dependents.get(predecessor) ?? [];
      list.push(step.idx);
      dependents.set(predecessor, list);
    }
  }
  /** @type {Set<number>} */
  const seen = new Set();
  const queue = [...(dependents.get(fromIdx) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || next === fromIdx || seen.has(next)) {
      continue;
    }
    seen.add(next);
    for (const child of dependents.get(next) ?? []) {
      queue.push(child);
    }
  }
  return [...seen].sort((left, right) => left - right);
}

/**
 * Split a plan into the copied prefix and the steps that must re-run.
 *
 * `edited` means step N's input changed, so N itself is re-run. Without an
 * edit, the journal up to and including N is copied and only steps that
 * depend on N are re-run.
 *
 * @param {import('../store/types.js').Step[]} steps
 * @param {number} stepIdx
 * @param {{edited: boolean}} options
 * @returns {{rerun: number[], copy: number[], mode: 'dag'}}
 */
export function selectForkSets(steps, stepIdx, options) {
  const executable = steps.filter((step) => step.workerType !== 'summarize');
  const downstream = downstreamIdxs(executable, stepIdx);
  /** @type {Set<number>} */
  const rerun = new Set(options.edited ? [stepIdx, ...downstream] : downstream);
  const copy = executable
    .map((step) => step.idx)
    .filter((idx) => !rerun.has(idx))
    .sort((left, right) => left - right);
  return {
    rerun: [...rerun].sort((left, right) => left - right),
    copy,
    mode: 'dag',
  };
}
