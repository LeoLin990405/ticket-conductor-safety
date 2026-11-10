/**
 * Partial re-plan after a Magentic-One-style stall.
 *
 * Magentic-One keeps a progress ledger and, when a step stalls past a small
 * threshold, asks the orchestrator to re-plan instead of retrying blindly.
 * Forge has no long-running orchestrator loop, so the watchdog is the ledger:
 * each time it finds a step stuck it increments `stallCount`. At 2 it records
 * a `replan` event whose payload is a revised tail (the stalled step and its
 * downstream steps). The deterministic workers stay in charge; this function
 * does not call a model and does not write to Jira.
 *
 * The revised input is a proposal on the event. The live step input is left
 * alone so an in-flight retry still matches the attempt the watchdog queued.
 *
 * @module recorder/replan
 */

import { downstreamIdxs } from './graph.js';

/** Second stall triggers the re-plan. The first stall is an ordinary retry. */
export const STALL_REPLAN_THRESHOLD = 2;

/**
 * @param {unknown} input
 * @returns {unknown}
 */
function annotate(input) {
  const note = 'Stalled twice. Re-plan: narrow this step and continue downstream.';
  if (typeof input === 'string') {
    return `${input}\n${note}`;
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return { ...input, replanNote: note };
  }
  if (input === undefined || input === null || input === '') {
    return note;
  }
  return { value: input, replanNote: note };
}

/**
 * Build the partial plan the watchdog logs on the `replan` event.
 *
 * @param {import('../store/types.js').Step[]} steps
 * @param {import('../store/types.js').Step} stalled
 * @returns {object}
 */
export function buildPartialReplan(steps, stalled) {
  const executable = steps.filter((step) => step.workerType !== 'summarize');
  const downstream = new Set(downstreamIdxs(executable, stalled.idx));
  const revisedSteps = executable
    .filter((step) => step.idx === stalled.idx || downstream.has(step.idx))
    .sort((left, right) => left.idx - right.idx)
    .map((step) => ({
      idx: step.idx,
      title: step.title,
      workerType: step.workerType,
      input: step.idx === stalled.idx ? annotate(step.input) : step.input,
    }));
  return {
    stallCount: STALL_REPLAN_THRESHOLD,
    stepIdx: stalled.idx,
    stepId: stalled.stepId,
    workerType: stalled.workerType,
    reason: 'Magentic-One stall counter reached 2. Requesting a partial re-plan instead of only retrying.',
    revisedSteps,
  };
}
