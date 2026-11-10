/**
 * Store reads for the Run panel. Split from the Forge resolver so tests do
 * not have to construct `@forge/resolver`.
 *
 * @module resolvers/panelData
 */

import { buildTimeline } from '../recorder/timeline.js';
import { toOtlpJson } from '../recorder/otel.js';
import * as store from '../store/index.js';
import { describeRunMemory } from '../memory/lessons.js';
import { panelModel, planCardFromSteps, previewBlastRadius } from '../blast/preview.js';
import { combineEffectMetrics } from '../effects/metrics.js';
import { readChaosCounters, readRunBudget } from '../run/budget.js';
import { resolveScheduleNow, scheduleFor } from '../run/criticalPath.js';

const { getRun, listRunsByEpic, listSteps } = store;

/**
 * Effects for one run. Prefer the by-run index when the store exports it.
 * Older builds can scan the status indexes, which is the same data.
 *
 * @param {string} runId
 */
async function effectsForRun(runId) {
  if (typeof store.listEffectsByRun === 'function') {
    return store.listEffectsByRun(runId, { limit: 50 });
  }
  const statuses = ['pending', 'applied', 'retrying', 'failed'];
  const pages = await Promise.all(
    statuses.map((status) => store.listEffectsByStatus(status)),
  );
  return pages.flat().filter((effect) => effect.runId === runId);
}

/**
 * Issue key from the UI Kit context, with a payload override for tests.
 *
 * @param {{payload?: Record<string, unknown>, context?: any}} request
 * @returns {string}
 */
export function issueKeyFrom(request) {
  const payloadKey = request?.payload?.issueKey;
  if (typeof payloadKey === 'string' && payloadKey.length > 0) {
    return payloadKey;
  }
  const extensionKey = request?.context?.extension?.issue?.key;
  if (typeof extensionKey === 'string' && extensionKey.length > 0) {
    return extensionKey;
  }
  return '';
}

/**
 * @param {string} issueKey
 * @param {typeof listRunsByEpic} [listRuns]
 */
export async function loadRunsForIssue(issueKey, listRuns = listRunsByEpic) {
  if (!issueKey) {
    return { issueKey: '', runs: [] };
  }
  const runs = await listRuns(issueKey, { limit: 20 });
  return {
    issueKey,
    runs: runs.map((run) => ({
      runId: run.runId,
      goal: run.goal,
      status: run.status,
      createdAt: run.createdAt,
      projectKey: run.projectKey,
    })),
  };
}

/**
 * @param {string} runId
 */
export async function loadRun(runId) {
  const run = await getRun(runId);
  if (!run) {
    return {
      run: null,
      steps: [],
      effects: [],
      memories: [],
      lessons: [],
      appliedMemories: [],
      usedMemory: [],
      usedLessons: [],
      planCard: '',
      events: [],
      timeline: [],
      schedule: null,
      chaos: null,
      effectMetrics: { applied: 0, deduped: 0, retried: 0 },
    };
  }
  const eventsPromise = typeof store.listEventsByRun === 'function'
    ? store.listEventsByRun(runId)
    : Promise.resolve([]);
  const [steps, effects, memoryView, events] = await Promise.all([
    listSteps(runId),
    effectsForRun(runId),
    describeRunMemory(store, run),
    eventsPromise,
  ]);
  // The card is recomputed from the steps, the plan citation, and the
  // effects this load already returned. There is no extra store query.
  // `alreadyApplied` is a tick for the panel. It does not change the score.
  const planCard = memoryView.planCard || planCardFromSteps(steps);
  const appliedRequestKeys = effects
    .filter((effect) => effect.status === 'applied')
    .map((effect) => effect.requestKey);
  const blast = panelModel(previewBlastRadius({
    run,
    steps,
    planCard,
    appliedRequestKeys,
  }));
  // Same steps this load already fetched. The panel badge that draws the
  // path is a later slice; the numbers are here so that badge does not
  // need a second KVS query. Nothing is written back onto the run.
  const schedule = scheduleFor(
    steps,
    readRunBudget(run.budget, run.createdAt),
    resolveScheduleNow(undefined, run),
  );
  // Same run row this load already fetched. Zeros when no fault has fired,
  // so the panel can render the line without a second read. The copy is
  // one sentence; the 2026-11-28 pass is the one that polishes it.
  const chaos = readChaosCounters(run.budget);
  // Same effect rows and the same run row this load already fetched.
  // Counting them does not query KVS again and does not write.
  const effectMetrics = combineEffectMetrics(effects, run.budget, runId);
  return {
    run,
    steps,
    effects,
    ...memoryView,
    events,
    timeline: buildTimeline(events),
    blast,
    schedule,
    chaos,
    effectMetrics,
  };
}

/**
 * OTLP/JSON for one run. Read-only. The panel shows it in a code block.
 *
 * @param {string} runId
 */
export async function exportRunTrace(runId) {
  const detail = await loadRun(runId);
  if (!detail.run) {
    return { ok: false, error: 'run not found' };
  }
  return { ok: true, otlp: toOtlpJson(detail.run, detail.events || []) };
}
