/**
 * Forge entry points for Ticket Conductor.
 *
 * The manifest `handler` values are `index.<export>`. This file only
 * re-exports. Work stays in the package that owns it.
 */

import {
  actionHandler,
  dispatchRun as dispatchRunImpl,
  getRunStatus as getRunStatusImpl,
  forkRun as forkRunImpl,
  planSplit as planSplitImpl,
  recallMemory as recallMemoryImpl,
  recordDecision as recordDecisionImpl,
  replayRun as replayRunImpl,
} from './actions/index.js';

// Every Rovo action returns JSON, also on error, and logs entry and failure.
export const planSplit = actionHandler(planSplitImpl, 'planSplit');
export const dispatchRun = actionHandler(dispatchRunImpl, 'dispatchRun');
export const getRunStatus = actionHandler(getRunStatusImpl, 'getRunStatus');
export const recallMemory = actionHandler(recallMemoryImpl, 'recallMemory');
export const recordDecision = actionHandler(recordDecisionImpl, 'recordDecision');
export const replayRun = actionHandler(replayRunImpl, 'replayRun');
export const forkRun = actionHandler(forkRunImpl, 'forkRun');
export { devDispatchWebtrigger } from './dev/devDispatch.js';
export { effectApplierHandler } from './effects/index.js';
export { panelResolver } from './resolvers/index.js';
export { childIssueUpdated } from './triggers/childIssueUpdated.js';
export { watchdogHandler } from './watchdog/index.js';
export { stepWorkerHandler } from './worker/index.js';
