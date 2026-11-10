/**
 * Replay a run against today's Jira without side effects.
 *
 * Inspired by Temporal's deterministic replay and LangGraph time travel, and
 * by DBOS returning a checkpoint instead of repeating a step. The pitch is
 * narrower than generic time travel: replay against today's Jira, with a
 * diff of what would change and zero duplicate writes.
 *
 * What this function does:
 * - Re-executes the deterministic workers (research, draft-spec, check-deps)
 *   with the read-only Jira client, so a search that returns different issues
 *   shows up as a step diff.
 * - Looks up every proposed effect by its requestKey. An applied effect, or
 *   a journal event with `phase: 'applied'`, is reported as
 *   `already-applied-skipped`.
 * - Does not call `enqueueEffect`, `updateStep`, `appendEvent`, or any Jira
 *   mutation. `duplicateWrites` is always 0.
 *
 * The summarize step is not re-executed. It only concatenates other outputs
 * and would call memory write-back if it ran inside the worker consumer.
 * Replay never enters that consumer.
 *
 * Jira reads go through the same client as the workers
 * (`src/run/forgeJiraClient.js`), which wraps every path in
 * `assumeTrustedRoute`. This module does not build REST paths itself.
 *
 * @module recorder/replay
 */

import { coalesceCommentEffects } from '../effects/commentBatch.js';
import { requestKeyFor } from '../effects/requestKey.js';
import { lessonsAt } from '../memory/lessons.js';
import { NotFoundError } from '../store/index.js';
import { getWorkerType } from '../worker/index.js';
import { lookupAppliedEffect, lookupJournal, stepResultKey } from './journal.js';
import { stableStringify } from './stable.js';

const REPLAYED_WORKERS = new Set(['research', 'draft-spec', 'check-deps']);

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * Drop fields that change even when the Jira read did not, so the diff stays
 * about outcomes.
 *
 * @param {unknown} output
 * @returns {unknown}
 */
function comparableOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return output ?? null;
  }
  const copy = { ...asRecord(output) };
  delete copy.completedAt;
  return copy;
}

/**
 * @param {string} runId
 * @param {{
 *   store?: import('../store/types.js').Store,
 *   jira?: {searchIssues: Function, getIssueLinks: Function},
 *   now?: () => number,
 *   logger?: {info?: Function, warn?: Function, error?: Function},
 * }} [overrides]
 * @returns {Promise<object>}
 */
export async function replayRun(runId, overrides = {}) {
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new NotFoundError('run', String(runId));
  }
  const store = overrides.store;
  if (!store || typeof store.getRun !== 'function') {
    const { getStore } = await import('../store/index.js');
    return replayRun(runId, { ...overrides, store: getStore() });
  }
  const jira = overrides.jira ?? await defaultJira();
  const now = overrides.now ?? (() => Date.now());
  const logger = overrides.logger ?? console;

  const run = await store.getRun(runId);
  if (!run) {
    throw new NotFoundError('run', runId);
  }
  const steps = await store.listSteps(runId);
  const effects = typeof store.listEffectsByRun === 'function'
    ? await store.listEffectsByRun(runId)
    : [];

  /** @type {object[]} */
  const stepDiffs = [];
  /** @type {Map<string, object>} */
  const effectDiffs = new Map();

  for (const effect of effects) {
    const looked = await lookupAppliedEffect(store, effect.requestKey);
    effectDiffs.set(effect.requestKey, {
      requestKey: effect.requestKey,
      kind: effect.kind,
      status: effect.status,
      stepId: effect.stepId,
      verdict: looked.verdict,
      journalHit: looked.events.length > 0 || looked.skipWrite,
      wouldWrite: false,
    });
  }

  for (const step of steps) {
    if (!REPLAYED_WORKERS.has(step.workerType)) {
      stepDiffs.push({
        idx: step.idx,
        title: step.title,
        workerType: step.workerType,
        skipped: true,
        changed: false,
        reason: step.workerType === 'summarize'
          ? 'summarize is derived; replay does not write memory'
          : 'no deterministic worker',
      });
      continue;
    }
    const handler = getWorkerType(step.workerType);
    const journalKey = stepResultKey({
      runId: step.runId,
      stepId: step.stepId,
      attempt: step.attempt ?? 0,
    });
    const journal = await lookupJournal(store, journalKey);
    /** @type {unknown} */
    let replayOutput = null;
    /** @type {string|null} */
    let error = null;
    if (!handler) {
      error = `no handler for ${step.workerType}`;
    } else {
      try {
        // dryRun is a signal to workers. The built-ins ignore it and return
        // the same {output, effects} they always return. Replay discards the
        // effects after classifying them; it never enqueues them.
          const result = await handler(step, {
            run,
            store,
            jira,
            logger,
            now,
            attempt: step.attempt ?? 0,
            dryRun: true,
            mode: 'replay',
            // Do not call @forge/llm. completeText treats disabled as the
            // deterministic fallback, so a dry-run cannot spend a model call.
            llm: { disabled: true },
          });
        replayOutput = result?.output ?? null;
        // The same fold the step worker uses before enqueue. A child that
        // received one batched comment is looked up under that batch key,
        // which is the row the applier stored. Looking up each part instead
        // would report those keys as missing even though the text was written.
        const proposed = Array.isArray(result?.effects) ? result.effects : [];
        const coalesced = coalesceCommentEffects(proposed, step);
        for (let index = 0; index < coalesced.length; index += 1) {
          const effect = coalesced[index];
          if (!effect || typeof effect.kind !== 'string') {
            continue;
          }
          const discriminator = effect.discriminator ?? `${effect.kind}:${index}`;
          let key;
          try {
            key = requestKeyFor({
              runId: step.runId,
              stepId: step.stepId,
              kind: effect.kind,
              discriminator,
            });
          } catch {
            continue;
          }
          const looked = await lookupAppliedEffect(store, key);
          effectDiffs.set(key, {
            requestKey: key,
            kind: effect.kind,
            status: looked.effect?.status ?? 'absent',
            stepId: step.stepId,
            stepIdx: step.idx,
            verdict: looked.verdict,
            journalHit: looked.skipWrite || looked.events.length > 0,
            wouldWrite: false,
          });
        }
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    }

    const before = comparableOutput(step.output ?? journal[0]?.detail?.output ?? null);
    const after = comparableOutput(replayOutput);
    const changed = error !== null || stableStringify(before) !== stableStringify(after);
    stepDiffs.push({
      idx: step.idx,
      stepId: step.stepId,
      title: step.title,
      workerType: step.workerType,
      skipped: false,
      changed,
      journalHit: journal.length > 0,
      journalKey,
      before,
      after,
      error,
      reason: changed
        ? `step ${step.idx} would now produce a different outcome`
        : 'unchanged against today\'s Jira',
    });
  }

  const effectList = [...effectDiffs.values()];
  const skippedEffects = effectList.filter((effect) => effect.verdict === 'already-applied-skipped');
  const changedSteps = stepDiffs.filter((step) => step.changed && !step.skipped);
  const lessons = await lessonReplay(store, run, steps, now());
  const lessonNote = lessons.changes.length === 0
    ? ''
    : ` ${lessons.newer.length} newer lesson(s) would change the plan.`;

  return {
    ok: true,
    runId,
    dryRun: true,
    sideEffects: false,
    duplicateWrites: 0,
    summary: changedSteps.length === 0
      ? `Replay against today's Jira: nothing in the step outputs would change. ${skippedEffects.length} effect(s) already applied, skipped. Duplicate writes: 0.${lessonNote}`
      : `Replay against today's Jira: ${changedSteps.length} step(s) would change. ${skippedEffects.length} effect(s) already applied, skipped. Duplicate writes: 0.${lessonNote}`,
    changedSteps: changedSteps.map((step) => step.idx),
    steps: stepDiffs,
    effects: effectList,
    lessons,
  };
}

/**
 * A lesson the planner would inject: accepted, voted, scoped, and inside
 * its validFrom/validTo window at `asOf`.
 *
 * @param {object} lesson
 * @returns {boolean}
 */
function applicableLesson(lesson) {
  return Boolean(
    lesson
    && lesson.rawStatus === 'accepted'
    && Number(lesson.votes) >= 1
    && lesson.scope
    && lesson.status !== 'expired',
  );
}

/**
 * @param {object} lesson
 * @returns {object}
 */
function lessonBrief(lesson) {
  return {
    lessonId: lesson.lessonId,
    summary: lesson.summary,
    validFrom: lesson.validFrom,
    validTo: lesson.validTo,
    votes: lesson.votes,
    scope: lesson.scope,
  };
}

/**
 * Lessons that held when the run was created, and newer accepted lessons
 * that would change the plan if it were drafted now.
 *
 * `lessonsAt` is the bi-temporal read (validFrom/validTo, including a
 * version that was later superseded). This function only reads. It does not
 * call `applyMemoriesToPlan`'s comment publisher.
 *
 * @param {object} store
 * @param {import('../store/types.js').Run} run
 * @param {import('../store/types.js').Step[]} steps
 * @param {number} nowMs
 */
async function lessonReplay(store, run, steps, nowMs) {
  const asOf = typeof run.createdAt === 'number' ? run.createdAt : nowMs;
  const deps = { store };
  let thenRows = [];
  let nowRows = [];
  try {
    thenRows = await lessonsAt({
      projectKey: run.projectKey,
      asOf,
      query: run.goal,
    }, deps);
    nowRows = await lessonsAt({
      projectKey: run.projectKey,
      asOf: nowMs,
      query: run.goal,
    }, deps);
  } catch {
    thenRows = [];
    nowRows = [];
  }
  const validThen = thenRows.filter(applicableLesson).map(lessonBrief);
  const validNow = nowRows.filter(applicableLesson).map(lessonBrief);
  const thenIds = new Set(validThen.map((lesson) => lesson.lessonId));
  const newer = validNow.filter((lesson) => !thenIds.has(lesson.lessonId));
  const planned = steps
    .filter((step) => step.workerType !== 'summarize')
    .map((step) => ({
      idx: step.idx,
      title: step.title,
      workerType: step.workerType,
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.slice() : [],
    }));
  /** @type {object[]} */
  const changes = [];
  let cursor = planned.map((step) => ({
    ...step,
    dependsOn: step.dependsOn.slice(),
  }));
  for (const lesson of newer) {
    const checkAt = cursor.findIndex((step) => step.workerType === 'check-deps');
    const cause = String(lesson.summary || 'a newer lesson');
    if (checkAt === -1 && cursor.length < 8) {
      const shifted = cursor.map((step) => ({
        ...step,
        idx: step.idx + 1,
        dependsOn: [0, ...step.dependsOn.map((index) => index + 1)],
      }));
      const added = {
        idx: 0,
        title: `Check dependencies: ${cause.slice(0, 72)}`,
        workerType: 'check-deps',
        dependsOn: [],
      };
      cursor = [added, ...shifted];
      changes.push({
        change: 'added',
        lessonId: lesson.lessonId,
        title: added.title,
        validFrom: lesson.validFrom,
        validTo: lesson.validTo,
      });
    } else if (checkAt !== -1) {
      changes.push({
        change: 'cited',
        lessonId: lesson.lessonId,
        idx: cursor[checkAt].idx,
        title: cursor[checkAt].title,
        validFrom: lesson.validFrom,
        validTo: lesson.validTo,
      });
    }
  }
  return {
    asOf,
    validThen,
    validNow,
    newer,
    changes,
    planWouldChange: changes.length > 0,
  };
}

/**
 * Lazy read-only Jira client. Tests pass `jira` and never reach this.
 *
 * @returns {Promise<{searchIssues: Function, getIssueLinks: Function}>}
 */
async function defaultJira() {
  const { defaultJiraClient } = await import('../run/dependencies.js');
  return defaultJiraClient;
}
