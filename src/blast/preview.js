/**
 * Blast-radius preview and compensating-undo plan (novelty #4).
 *
 * This module is pure. It does not read Forge storage, it does not import
 * the effect applier, and it does not call Jira. `plan-split`, `dispatch-run`
 * (inside `startRun`, before any effect is enqueued), `get-run-status`, and
 * the Run panel resolver all call `previewBlastRadius` on steps they already
 * hold. The card is recomputed. It is not a KVS row.
 *
 * `enqueueEffect` accepts `createIssue`, `comment`, `transition`,
 * `setFields`, and the compensating kinds `closeIssue`,
 * `recordRemovedComment`, `restoreStatus`, and `restoreFields`.
 * `planCompensations` describes the undo. The caller enqueues those
 * descriptors. `setFields` stores the previous scalar values on
 * `result.before`. `restoreFields` writes them back when the issue still
 * holds what this run wrote.
 *
 * Why a preview can exist before any write
 * ---------------------------------------
 * Dispatch does not ask the model what to change. `startRun` always enqueues
 * one `createIssue` per step that is not already `done`, with the fixed
 * discriminator `child-issue` (`src/run/stateMachine.js`). Each built-in
 * worker then enqueues one comment with its own fixed discriminator
 * (`research-comment`, `draft-spec-comment`, `check-deps-comment` in
 * `src/worker/content.js`). A checklist skill enqueues `skill-full-output`
 * (`src/skills/runSubAgent.js`). The Epic memory comment uses
 * `memory:epic-comment` (`src/memory/comment.js`) and is posted only after
 * the run finishes. Those names are known from the plan, so the card can
 * list them without running a worker and without draining `effect-queue`.
 *
 * The comment body is not known yet. The card names the slot and leaves the
 * body out, which also keeps the card small.
 *
 * `planCompensations` does not enqueue. The caller passes each descriptor
 * to `enqueueEffect`. The applier applies `closeIssue`,
 * `recordRemovedComment`, `restoreStatus`, and `restoreFields`
 * (`EFFECT_KINDS` in `src/store/types.js`, `src/effects/jira.js`).
 *
 * @module blast/preview
 */

import { createHash } from 'node:crypto';

import {
  MAX_STEPS,
  MAX_WAVES,
  currentWave,
  spawnBudget,
  workSteps,
} from '../run/digest.js';

const textEncoder = new TextEncoder();

/**
 * UTF-8 size of the recomputed card. The card is not a KVS value. The cap
 * exists so a future change that pastes comment bodies into the card fails
 * a unit test instead of quietly growing the panel payload. 8 KiB is far
 * under the store's 64 KiB field cap (`MAX_VALUE_BYTES`). The largest plan
 * the app accepts is 8 steps. With a transition and a field edit on each
 * step, plus the plan-citation comment and the memory comment, that card
 * is about 16 KiB. 20 KiB lets that plan through and rejects a card that
 * has started carrying comment bodies.
 *
 * @constant {number}
 */
export const BLAST_CARD_BUDGET = 20 * 1024;

/**
 * UTF-8 size of the flight-recorder detail for one `blast.previewed` event.
 * Event `detail` is an `any` attribute and shares the 64 KiB field cap with
 * the rest of the event. The journal stores counts and request keys, not the
 * card. 2 KiB leaves room for an 8-step plan (about 17 keys) and rejects a
 * payload that copied step output in.
 *
 * @constant {number}
 */
export const BLAST_JOURNAL_BUDGET = 2 * 1024;

/**
 * UTF-8 size of `effect.result.before`. The applier already stores `result`
 * as `any`. M2 puts the snapshot there so the manifest does not gain an
 * attribute. 2 KiB holds a status name plus the few fields the run changed.
 *
 * @constant {number}
 */
export const BEFORE_SNAPSHOT_BUDGET = 2 * 1024;

/**
 * Score at which the card asks for an approval gate. One point per child
 * issue the plan will create. A 3-step plan (the simulator's DAG) scores 3
 * and does not gate. Five or more child issues does. Comments on those
 * children do not add points: the issue count is the radius.
 *
 * Compared with `>=`, so a plan that scores exactly 5 gates.
 *
 * @constant {number}
 */
export const BLAST_THRESHOLD = 5;

/**
 * Points for a transition or a field edit. Combined with the issue points.
 * A transition or field edit on an issue this run did not create also trips
 * the gate on its own (`risk.external`), even when the score is still under
 * the threshold.
 *
 * @constant {number}
 */
export const BLAST_EXTERNAL_POINTS = 4;

/**
 * Status name used to close a child this run created. The fake Jira in
 * `tests/simulation/fakes.mjs` maps transition id `31` to this name. Closing
 * is a transition. It is not `DELETE /rest/api/3/issue`.
 *
 * @constant {string}
 */
export const CLOSE_STATUS_NAME = 'Done';

/**
 * Label added when a created child is closed. The open board hides an issue
 * that is both this status and this label. The issue row stays in Jira.
 *
 * @constant {string}
 */
export const ROLLBACK_LABEL = 'conductor-rolled-back';

/**
 * Worker types whose comment discriminator is fixed in `src/worker/content.js`.
 * A skill pack with `procedure: builtin` keeps that discriminator
 * (`src/skills/runSubAgent.js` returns the worker's effects unchanged).
 *
 * @constant {Readonly<Record<string, string>>}
 */
export const COMMENT_TEMPLATES = Object.freeze({
  research: 'research-comment',
  'draft-spec': 'draft-spec-comment',
  'check-deps': 'check-deps-comment',
});

/**
 * Checklist skills. They have no built-in worker comment. `runSubAgent`
 * adds one comment with discriminator `skill-full-output`.
 *
 * @constant {ReadonlyArray<string>}
 */
export const CHECKLIST_SKILLS = Object.freeze(['risk-review', 'test-plan']);

/** Forward kinds the preview knows. `setFields` is also an effect kind. */
const FORWARD_KINDS = Object.freeze([
  'createIssue',
  'comment',
  'transition',
  'setFields',
]);

/**
 * Compensating kinds. Same queue, same request-key formula. `enqueueEffect`
 * accepts every kind in this list. Order of this list is not the apply order.
 */
const COMPENSATION_KINDS = Object.freeze([
  'closeIssue',
  'recordRemovedComment',
  'restoreStatus',
  'restoreFields',
]);

const KIND_ORDER = Object.freeze({
  createIssue: 0,
  comment: 1,
  transition: 2,
  setFields: 3,
});

/**
 * Things the plan can cause later that are not concrete rows on the card.
 * The simulator asserts these stay off the pre-dispatch mutation list.
 *
 * @constant {ReadonlyArray<{template: string, reason: string}>}
 */
const STRUCTURAL_OMISSIONS = Object.freeze([
  {
    template: 'wave-report',
    reason: 'Posted by the lead after a wave, discriminator wave-report:<wave>. Counted in the envelope, not as a row.',
  },
  {
    template: 'watchdog-blocked',
    reason: 'Posted only when a step exhausts retries. Not part of the plan.',
  },
  {
    template: 'summarize-comment',
    reason: 'The summarize worker skips the child comment when the child key is still empty. writeBack posts memory:epic-comment instead.',
  },
]);

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/**
 * @param {string} value
 * @returns {number}
 */
function utf8Bytes(value) {
  return textEncoder.encode(value).length;
}

/**
 * Thrown when the preview is given a plan that cannot be listed. Callers
 * should fix the input. This is not a Jira error.
 */
export class BlastInputError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'BlastInputError';
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BlastInputError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Same pipe-hash as `requestKeyFor` in `src/effects/requestKey.js`:
 * `sha256("<runId>|<stepId>|<kind>|<discriminator>")`.
 *
 * An empty `stepId` is the run-level segment (the memory comment and the
 * plan citation pass no step). Discriminators here are strings. Object
 * discriminators stay in `requestKeyFor`; this preview does not use them.
 *
 * `requestKeyFor` accepts the same kinds as this function, including
 * `setFields` and `restoreFields`. For every kind both functions accept,
 * the digest matches. The unit test locks that.
 *
 * @param {{runId: string, stepId?: string|null, kind: string, discriminator?: string}} input
 * @returns {string}
 */
export function plannedRequestKey(input) {
  const runId = requireText(input?.runId, 'runId');
  const stepId = input.stepId === undefined || input.stepId === null
    ? ''
    : requireText(input.stepId, 'stepId');
  const kind = requireText(input.kind, 'kind');
  if (!FORWARD_KINDS.includes(kind) && !COMPENSATION_KINDS.includes(kind)) {
    throw new BlastInputError(
      `kind must be a blast-radius kind; received ${kind}`,
    );
  }
  const discriminator = input.discriminator === undefined || input.discriminator === null
    ? ''
    : String(input.discriminator);
  return createHash('sha256')
    .update(`${runId}|${stepId}|${kind}|${discriminator}`, 'utf8')
    .digest('hex');
}

/**
 * @param {any} step
 * @returns {string|null}
 */
function commentDiscriminator(step) {
  const workerType = typeof step.workerType === 'string' ? step.workerType : '';
  if (Object.prototype.hasOwnProperty.call(COMMENT_TEMPLATES, workerType)) {
    return COMMENT_TEMPLATES[workerType];
  }
  if (workerType === 'summarize' || workerType === 'approval') {
    return null;
  }
  const skill = typeof step.skill === 'string' ? step.skill : '';
  if (CHECKLIST_SKILLS.includes(workerType) || CHECKLIST_SKILLS.includes(skill) || skill.length > 0) {
    return 'skill-full-output';
  }
  return null;
}

/**
 * Where a transition or a field edit lands. The two flags are independent:
 * a step can transition its own child and edit the Epic, or the reverse.
 * Default is the child this step creates. `epic` and an explicit issue key
 * are existing issues, which trip the gate.
 *
 * @param {any} step
 * @param {string} epicKey
 * @param {'transition'|'fields'} which
 * @returns {{type: string, epicKey?: string, issueKey?: string, stepIdx?: number, stepId?: string}}
 */
function writeTarget(step, epicKey, which) {
  const input = asRecord(step.input);
  const flag = which === 'transition' ? input.transitionTarget : input.fieldsTarget;
  const explicitKey = which === 'transition' ? input.transitionIssueKey : input.fieldsIssueKey;
  if (flag === 'epic') {
    return { type: 'epic', epicKey, issueKey: epicKey };
  }
  if (typeof explicitKey === 'string' && explicitKey.length > 0) {
    return { type: 'issue', issueKey: explicitKey };
  }
  return { type: 'child-of-step', stepIdx: step.idx, stepId: step.stepId };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function previewScalar(value) {
  if (typeof value === 'string') {
    return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '(value)';
}

/**
 * @param {any} run
 * @param {any} step
 * @returns {object}
 */
function createIssueWrite(run, step) {
  const input = asRecord(step.input);
  const issueType = typeof input.issueType === 'string' && input.issueType.length > 0
    ? input.issueType
    : 'Sub-task';
  const discriminator = 'child-issue';
  // The approval child is a real createIssue (same discriminator, so the
  // request key matches startRun) but it is not part of the radius. Scoring
  // it would insert a second gate every time the card was recomputed.
  const template = step.workerType === 'approval' ? 'approval-child' : 'child-issue';
  return {
    kind: 'createIssue',
    requestKey: plannedRequestKey({
      runId: run.runId,
      stepId: step.stepId,
      kind: 'createIssue',
      discriminator,
    }),
    stepId: step.stepId,
    stepIdx: step.idx,
    discriminator,
    template,
    certainty: 'certain',
    target: {
      type: 'new-child',
      epicKey: run.epicKey,
      stepIdx: step.idx,
      stepId: step.stepId,
    },
    issueType,
    summary: `Create ${issueType} "${step.title}" under ${run.epicKey}`,
    fields: [
      { field: 'project', to: run.projectKey },
      { field: 'parent', to: run.epicKey },
      { field: 'summary', to: step.title },
      { field: 'issuetype', to: issueType },
    ],
  };
}

/**
 * @param {any} run
 * @param {any} step
 * @param {string} discriminator
 * @returns {object}
 */
function childCommentWrite(run, step, discriminator) {
  return {
    kind: 'comment',
    requestKey: plannedRequestKey({
      runId: run.runId,
      stepId: step.stepId,
      kind: 'comment',
      discriminator,
    }),
    stepId: step.stepId,
    stepIdx: step.idx,
    discriminator,
    template: discriminator,
    certainty: 'certain',
    target: { type: 'child-of-step', stepIdx: step.idx, stepId: step.stepId },
    summary: `Comment on the child of step ${step.idx} (${discriminator})`,
  };
}

/**
 * @param {any} run
 * @param {string} discriminator
 * @param {'certain'|'if-done'} certainty
 * @param {string} summary
 * @returns {object}
 */
function epicCommentWrite(run, discriminator, certainty, summary) {
  return {
    kind: 'comment',
    requestKey: plannedRequestKey({
      runId: run.runId,
      stepId: null,
      kind: 'comment',
      discriminator,
    }),
    stepId: null,
    stepIdx: null,
    discriminator,
    template: discriminator,
    certainty,
    target: { type: 'epic', epicKey: run.epicKey, issueKey: run.epicKey },
    summary,
  };
}

/**
 * Build the card for a plan that has not been dispatched.
 *
 * `steps` are store rows (`listSteps`) or `plan-split` steps. A step with
 * `status: 'done'` is a fork prefix: `startRun` does not create another
 * child for it, and the card does not list one. Pass `planCard` when
 * `plan-split` applied a lesson; the citation comment is then a certain row.
 * Pass `appliedRequestKeys` after dispatch if the panel wants a tick on rows
 * whose effect is already `applied`. That set is display only. It does not
 * change the score.
 *
 * @param {{
 *   run: {runId: string, epicKey: string, projectKey: string, goal?: string},
 *   steps?: Array<any>,
 *   planCard?: string,
 *   appliedRequestKeys?: string[],
 * }} input
 * @returns {object}
 */
export function previewBlastRadius(input) {
  const run = asRecord(input?.run);
  const runId = requireText(run.runId, 'run.runId');
  const epicKey = requireText(run.epicKey, 'run.epicKey');
  const projectKey = requireText(run.projectKey, 'run.projectKey');
  const steps = Array.isArray(input?.steps) ? input.steps : [];
  const applied = new Set(
    Array.isArray(input?.appliedRequestKeys) ? input.appliedRequestKeys : [],
  );

  /** @type {object[]} */
  const writes = [];
  /** @type {Array<{template: string, reason: string, stepIdx?: number}>} */
  const omitted = STRUCTURAL_OMISSIONS.map((entry) => ({ ...entry }));

  const ordered = [...steps].sort((left, right) => {
    const leftIdx = Number.isInteger(left?.idx) ? left.idx : 0;
    const rightIdx = Number.isInteger(right?.idx) ? right.idx : 0;
    return leftIdx - rightIdx;
  });

  for (const step of ordered) {
    if (!step || typeof step !== 'object') {
      throw new BlastInputError('each step must be an object');
    }
    if (step.status === 'done') {
      continue;
    }
    const stepId = requireText(step.stepId, 'step.stepId');
    const title = requireText(step.title, 'step.title');
    const workerType = requireText(step.workerType, 'step.workerType');
    const ready = { ...step, stepId, title, workerType };

    writes.push(createIssueWrite({ runId, epicKey, projectKey }, ready));

    const discriminator = commentDiscriminator(ready);
    if (discriminator) {
      writes.push(childCommentWrite({ runId }, ready, discriminator));
    } else if (workerType !== 'summarize' && workerType !== 'approval') {
      omitted.push({
        template: 'comment',
        reason: `No comment template for workerType ${workerType}. The worker fails before it enqueues an effect.`,
        stepIdx: step.idx,
      });
    }

    const stepInput = asRecord(step.input);
    if (typeof stepInput.transitionTo === 'string' && stepInput.transitionTo.trim().length > 0) {
      const toStatusName = stepInput.transitionTo.trim();
      const target = writeTarget(ready, epicKey, 'transition');
      const transitionDiscriminator = `transition:${toStatusName}`;
      writes.push({
        kind: 'transition',
        requestKey: plannedRequestKey({
          runId,
          stepId,
          kind: 'transition',
          discriminator: transitionDiscriminator,
        }),
        stepId,
        stepIdx: step.idx,
        discriminator: transitionDiscriminator,
        template: 'transition',
        certainty: 'certain',
        target,
        summary: `Transition ${target.issueKey || `child of step ${step.idx}`} to ${toStatusName}`,
        toStatusName,
      });
    }

    if (stepInput.fields && typeof stepInput.fields === 'object' && !Array.isArray(stepInput.fields)) {
      const names = Object.keys(stepInput.fields).sort();
      if (names.length > 0) {
        const target = writeTarget(ready, epicKey, 'fields');
        const fieldsDiscriminator = `fields:${names.join(',')}`;
        writes.push({
          kind: 'setFields',
          requestKey: plannedRequestKey({
            runId,
            stepId,
            kind: 'setFields',
            discriminator: fieldsDiscriminator,
          }),
          stepId,
          stepIdx: step.idx,
          discriminator: fieldsDiscriminator,
          template: 'set-fields',
          certainty: 'certain',
          target,
          summary: `Set ${names.join(', ')} on ${target.issueKey || `child of step ${step.idx}`}`,
          fields: names.map((field) => ({
            field,
            to: previewScalar(stepInput.fields[field]),
          })),
        });
      }
    }
  }

  if (typeof input?.planCard === 'string' && input.planCard.trim().length > 0) {
    writes.push(epicCommentWrite(
      { runId, epicKey },
      'plan:lesson-citation',
      'certain',
      `Comment on ${epicKey} (plan:lesson-citation)`,
    ));
  }

  if (steps.length > 0) {
    writes.push(epicCommentWrite(
      { runId, epicKey },
      'memory:epic-comment',
      'if-done',
      `Comment on ${epicKey} after the run finishes (memory:epic-comment)`,
    ));
  }

  const seen = new Set();
  const unique = [];
  for (const write of writes) {
    if (seen.has(write.requestKey)) continue;
    seen.add(write.requestKey);
    unique.push({ ...write, alreadyApplied: applied.has(write.requestKey) });
  }
  unique.sort((left, right) => {
    const leftIdx = left.stepIdx === null ? Number.MAX_SAFE_INTEGER : left.stepIdx;
    const rightIdx = right.stepIdx === null ? Number.MAX_SAFE_INTEGER : right.stepIdx;
    if (leftIdx !== rightIdx) return leftIdx - rightIdx;
    const order = (KIND_ORDER[left.kind] ?? 9) - (KIND_ORDER[right.kind] ?? 9);
    if (order !== 0) return order;
    return left.discriminator < right.discriminator ? -1 : 1;
  });

  const counts = {
    issues: unique.filter((write) => write.kind === 'createIssue').length,
    comments: unique.filter((write) => write.kind === 'comment').length,
    transitions: unique.filter((write) => write.kind === 'transition').length,
    fieldChanges: unique.filter((write) => write.kind === 'setFields').length,
    ifDone: unique.filter((write) => write.certainty === 'if-done').length,
    total: unique.length,
  };

  const work = workSteps(steps);
  const wave = currentWave(steps);
  const envelope = {
    maxSteps: MAX_STEPS,
    maxWaves: MAX_WAVES,
    plannedSteps: work.length,
    roomForSpawnedIssues: Math.max(0, MAX_STEPS - work.length),
    currentWave: wave,
    nextWaveBudget: spawnBudget({
      goal: run.goal,
      existingSteps: work.length,
      nextWave: wave + 1,
    }),
  };

  const risk = scoreRisk(unique);
  const gate = buildGate(unique, steps, risk);

  const card = {
    runId,
    epicKey,
    projectKey,
    phase: 'preview',
    counts,
    writes: unique,
    omitted,
    envelope,
    risk,
    gate,
    byteBudget: BLAST_CARD_BUDGET,
    bytes: 0,
    overBudget: false,
  };
  card.bytes = utf8Bytes(JSON.stringify(card));
  card.overBudget = card.bytes > BLAST_CARD_BUDGET;
  card.bytes = utf8Bytes(JSON.stringify(card));
  card.overBudget = card.bytes > BLAST_CARD_BUDGET;
  return card;
}

/**
 * Points come from certain writes only. The memory comment (`if-done`) and
 * the lead envelope do not add points. An approval step, once #5 has appended
 * it, does not add points either: the gate is the response to the radius,
 * not more of it.
 *
 * @param {object[]} writes
 * @returns {{score: number, threshold: number, exceeds: boolean, external: boolean, reasons: string[]}}
 */
function scoreRisk(writes) {
  let score = 0;
  let external = false;
  for (const write of writes) {
    if (write.certainty !== 'certain') continue;
    if (write.template === 'child-issue' && write.kind === 'createIssue') {
      score += 1;
      continue;
    }
    if (write.kind === 'transition' || write.kind === 'setFields') {
      score += BLAST_EXTERNAL_POINTS;
      if (write.target?.type === 'epic' || write.target?.type === 'issue') {
        external = true;
      }
    }
  }
  /** @type {string[]} */
  const reasons = [];
  if (score >= BLAST_THRESHOLD) {
    reasons.push(`score ${score} meets the threshold of ${BLAST_THRESHOLD}`);
  }
  if (external) {
    reasons.push('a step transitions or edits an issue this run did not create');
  }
  return {
    score,
    threshold: BLAST_THRESHOLD,
    exceeds: score >= BLAST_THRESHOLD || external,
    external,
    reasons,
  };
}

/**
 * @param {object[]} writes
 * @param {Array<any>} steps
 * @param {{exceeds: boolean, reasons: string[], score: number, threshold: number, external: boolean}} risk
 * @returns {{insert: boolean, fits: boolean, waitFor: number[], appendedIdx: number|null, reason: string}}
 */
function buildGate(writes, steps, risk) {
  const openApproval = steps.some(
    (step) => step?.workerType === 'approval' && step?.status !== 'done',
  );
  if (openApproval) {
    return {
      insert: false,
      fits: true,
      waitFor: [],
      appendedIdx: null,
      reason: 'an approval step is already in the plan',
    };
  }
  if (!risk.exceeds) {
    return {
      insert: false,
      fits: true,
      waitFor: [],
      appendedIdx: null,
      reason: '',
    };
  }
  /** @type {Set<number>} */
  const waitFor = new Set();
  const batch = risk.score >= risk.threshold;
  for (const write of writes) {
    if (!Number.isInteger(write.stepIdx)) continue;
    if (batch && write.kind === 'createIssue' && write.template === 'child-issue') {
      waitFor.add(write.stepIdx);
    }
    if (
      risk.external
      && (write.kind === 'transition' || write.kind === 'setFields')
      && (write.target?.type === 'epic' || write.target?.type === 'issue')
    ) {
      waitFor.add(write.stepIdx);
    }
  }
  const indexes = [...waitFor].sort((left, right) => left - right);
  const maxIdx = steps.reduce((max, step) => (
    Number.isInteger(step?.idx) ? Math.max(max, step.idx) : max
  ), -1);
  const work = workSteps(steps);
  const fits = work.length < MAX_STEPS;
  return {
    insert: true,
    fits,
    waitFor: indexes,
    appendedIdx: fits ? maxIdx + 1 : null,
    reason: risk.reasons.join('; '),
  };
}

/**
 * Append an approval step when the card says so. Existing indexes stay put.
 * The graph already allows a dependency on a later index (`src/run/graph.js`),
 * so the waited steps gain one `dependsOn` entry and nobody else's index moves.
 *
 * This does not write the plan. #5 calls it before `createSteps` / before the
 * lead enqueues a spawned wave. A plan that is already at `MAX_STEPS` (8 work
 * steps) cannot grow a ninth issue: `fits` is false and the steps come back
 * unchanged. The panel warning plus the existing dispatch confirmation is the
 * gate in that case.
 *
 * @param {object} card Result of {@link previewBlastRadius}.
 * @param {Array<any>} steps
 * @returns {{insert: boolean, fits: boolean, gateIdx: number|null, steps: Array<any>, reason: string}}
 */
export function gateInsertion(card, steps) {
  const list = Array.isArray(steps) ? steps : [];
  if (!card?.gate?.insert) {
    return {
      insert: false,
      fits: true,
      gateIdx: null,
      steps: list,
      reason: '',
    };
  }
  if (!card.gate.fits || !Number.isInteger(card.gate.appendedIdx)) {
    return {
      insert: false,
      fits: false,
      gateIdx: null,
      steps: list,
      reason: card.gate.reason || 'plan is already at the step cap',
    };
  }
  const gateIdx = card.gate.appendedIdx;
  const wait = new Set(card.gate.waitFor);
  const patched = list.map((step) => {
    if (!wait.has(step.idx)) return step;
    const dependsOn = Array.isArray(step.dependsOn) ? [...step.dependsOn] : [];
    if (!dependsOn.includes(gateIdx)) dependsOn.push(gateIdx);
    return { ...step, dependsOn };
  });
  const gate = {
    idx: gateIdx,
    title: 'Approve blast radius',
    workerType: 'approval',
    dependsOn: [],
    status: 'queued',
    input: {
      reason: card.gate.reason,
      score: card.risk?.score ?? 0,
    },
  };
  return {
    insert: true,
    fits: true,
    gateIdx,
    steps: [...patched, gate],
    reason: card.gate.reason,
  };
}

/**
 * Small event detail for `blast.previewed`. Counts and request keys only.
 * Keys are dropped from the end if the JSON would pass
 * {@link BLAST_JOURNAL_BUDGET}. The card itself is recomputed, not stored.
 *
 * @param {object} card
 * @returns {{counts: object, score: number, exceeds: boolean, requestKeys: string[], truncated: boolean}}
 */
export function journalDetail(card) {
  const keys = Array.isArray(card?.writes)
    ? card.writes.map((write) => write.requestKey)
    : [];
  /** @type {{counts: object, score: number, exceeds: boolean, requestKeys: string[], truncated: boolean}} */
  const detail = {
    counts: card?.counts ?? {},
    score: card?.risk?.score ?? 0,
    exceeds: card?.risk?.exceeds === true,
    requestKeys: keys,
    truncated: false,
  };
  while (utf8Bytes(JSON.stringify(detail)) > BLAST_JOURNAL_BUDGET && detail.requestKeys.length > 0) {
    detail.requestKeys.pop();
    detail.truncated = true;
  }
  return detail;
}

/**
 * Shrink a before-image until it fits in {@link BEFORE_SNAPSHOT_BUDGET}.
 * Status name and comment id are kept. Field entries are kept in sorted
 * name order until the next one would overflow. M2 calls this before it
 * writes `effect.result.before`.
 *
 * @param {unknown} before
 * @returns {{statusName?: string, commentId?: string, fields?: Record<string, unknown>}}
 */
export function fitBeforeSnapshot(before) {
  const source = asRecord(before);
  /** @type {{statusName?: string, commentId?: string, fields?: Record<string, unknown>}} */
  const fitted = {};
  if (typeof source.statusName === 'string' && source.statusName.length > 0) {
    fitted.statusName = source.statusName;
  }
  if (typeof source.commentId === 'string' && source.commentId.length > 0) {
    fitted.commentId = source.commentId;
  }
  const fields = asRecord(source.fields);
  /** @type {Record<string, unknown>} */
  const kept = {};
  for (const name of Object.keys(fields).sort()) {
    const candidate = { ...fitted, fields: { ...kept, [name]: fields[name] } };
    if (utf8Bytes(JSON.stringify(candidate)) > BEFORE_SNAPSHOT_BUDGET) {
      break;
    }
    kept[name] = fields[name];
  }
  if (Object.keys(kept).length > 0) {
    fitted.fields = kept;
  }
  return fitted;
}

/**
 * @param {any} effect
 * @returns {string|null}
 */
function effectIssueKey(effect, createdByStep) {
  const payload = asRecord(effect.payload);
  const result = asRecord(effect.result);
  if (typeof payload.issueKey === 'string' && payload.issueKey.length > 0) {
    return payload.issueKey;
  }
  if (typeof result.issueKey === 'string' && result.issueKey.length > 0) {
    return result.issueKey;
  }
  if (typeof effect.stepId === 'string' && createdByStep.has(effect.stepId)) {
    return createdByStep.get(effect.stepId) ?? null;
  }
  return null;
}

/**
 * @param {any[]} items
 * @returns {any[]}
 */
function orderCompensations(items) {
  const byKey = new Map(items.map((item) => [item.requestKey, item]));
  const placed = new Set();
  /** @type {any[]} */
  const ordered = [];
  /**
   * @param {any} item
   */
  function visit(item) {
    if (placed.has(item.requestKey)) return;
    for (const dependency of item.dependsOnKeys) {
      const other = byKey.get(dependency);
      if (other) visit(other);
    }
    placed.add(item.requestKey);
    ordered.push(item);
  }
  const sorted = [...items].sort((left, right) => {
    const at = (right.appliedAt ?? 0) - (left.appliedAt ?? 0);
    if (at !== 0) return at;
    return left.requestKey < right.requestKey ? -1 : 1;
  });
  for (const item of sorted) visit(item);
  return ordered;
}

/**
 * Plan the compensating effects for one run.
 *
 * Pass the effect rows from `listEffectsByRun(runId)` with no limit. The
 * panel's helper passes `limit: 50`; undo must not use that helper. Only
 * rows with status `applied` and a forward kind are compensated. A
 * compensation is never compensated, so a second click finds the same keys
 * and `putEffectIfAbsent` returns `created: false`.
 *
 * Forward rows stay `applied`. Re-opening them would let a retry create a
 * second child. The closed issue is the residue. Replay keeps treating the
 * forward key as already applied.
 *
 * `closeIssue` is listed after every `recordRemovedComment` on that same
 * issue (`dependsOnKeys`). The effect queue does not order different keys,
 * so M2's applier re-pushes a compensation whose dependencies are not yet
 * `applied`, the same way a deferred comment waits for `childIssueKey`
 * (`src/effects/applier.js`). Independent children can still close in parallel.
 *
 * @param {Array<any>} effects
 * @returns {{
 *   compensations: Array<object>,
 *   cannotUndo: Array<{requestKey: string, kind: string, reason: string}>,
 *   skipped: Array<{requestKey: string, kind: string, reason: string}>,
 *   irreversible: Array<string>,
 * }}
 */
export function planCompensations(effects) {
  const rows = Array.isArray(effects) ? effects : [];
  /** @type {Map<string, string>} */
  const createdByStep = new Map();
  /** @type {Set<string>} */
  const closing = new Set();
  for (const effect of rows) {
    if (effect?.status !== 'applied' || effect?.kind !== 'createIssue') continue;
    const issueKey = effectIssueKey(effect, createdByStep);
    if (typeof issueKey === 'string' && typeof effect.stepId === 'string') {
      createdByStep.set(effect.stepId, issueKey);
    }
  }
  for (const issueKey of createdByStep.values()) closing.add(issueKey);

  /** @type {object[]} */
  const compensations = [];
  /** @type {Array<{requestKey: string, kind: string, reason: string}>} */
  const cannotUndo = [];
  /** @type {Array<{requestKey: string, kind: string, reason: string}>} */
  const skipped = [];
  /** @type {Map<string, string[]>} */
  const removalsByIssue = new Map();

  /**
   * @param {any} effect
   * @param {string} kind
   * @param {Record<string, unknown>} payload
   * @param {string[]} [dependsOnKeys]
   */
  function pushCompensation(effect, kind, payload, dependsOnKeys = []) {
    const discriminator = `undo:${effect.kind}:${effect.requestKey}`;
    const requestKey = plannedRequestKey({
      runId: effect.runId,
      stepId: effect.stepId ?? null,
      kind,
      discriminator,
    });
    compensations.push({
      kind,
      requestKey,
      runId: effect.runId,
      stepId: effect.stepId ?? null,
      forwardRequestKey: effect.requestKey,
      discriminator,
      payload,
      dependsOnKeys,
      appliedAt: typeof effect.appliedAt === 'number' ? effect.appliedAt : 0,
    });
    return requestKey;
  }

  for (const effect of rows) {
    if (!effect || typeof effect !== 'object') continue;
    const kind = effect.kind;
    if (COMPENSATION_KINDS.includes(kind)) {
      skipped.push({ requestKey: effect.requestKey, kind, reason: 'compensation' });
      continue;
    }
    if (!FORWARD_KINDS.includes(kind)) {
      skipped.push({ requestKey: String(effect.requestKey ?? ''), kind: String(kind), reason: 'not-a-forward-effect' });
      continue;
    }
    if (effect.status !== 'applied') {
      skipped.push({ requestKey: effect.requestKey, kind, reason: 'not-applied' });
      continue;
    }
    if (typeof effect.runId !== 'string' || effect.runId.length === 0) {
      cannotUndo.push({ requestKey: String(effect.requestKey ?? ''), kind, reason: 'missing-run-id' });
      continue;
    }

    if (kind === 'createIssue') {
      const issueKey = effectIssueKey(effect, createdByStep);
      if (!issueKey) {
        cannotUndo.push({ requestKey: effect.requestKey, kind, reason: 'missing-issue-key' });
        continue;
      }
      pushCompensation(effect, 'closeIssue', {
        issueKey,
        toStatusName: CLOSE_STATUS_NAME,
        label: ROLLBACK_LABEL,
      });
      continue;
    }

    if (kind === 'comment') {
      const result = asRecord(effect.result);
      const commentId = result.commentId ?? asRecord(effect.payload).commentId;
      const issueKey = effectIssueKey(effect, createdByStep);
      if (typeof commentId !== 'string' || commentId.length === 0) {
        cannotUndo.push({ requestKey: effect.requestKey, kind, reason: 'missing-comment-id' });
        continue;
      }
      if (!issueKey) {
        cannotUndo.push({ requestKey: effect.requestKey, kind, reason: 'missing-issue-key' });
        continue;
      }
      const requestKey = pushCompensation(effect, 'recordRemovedComment', {
        issueKey,
        commentId: String(commentId),
      });
      const list = removalsByIssue.get(issueKey) ?? [];
      list.push(requestKey);
      removalsByIssue.set(issueKey, list);
      continue;
    }

    if (kind === 'transition') {
      const issueKey = effectIssueKey(effect, createdByStep);
      const before = asRecord(asRecord(effect.result).before);
      const statusName = typeof before.statusName === 'string' ? before.statusName : '';
      if (!issueKey || statusName.length === 0) {
        cannotUndo.push({
          requestKey: effect.requestKey,
          kind,
          reason: !issueKey ? 'missing-issue-key' : 'no-before-snapshot',
        });
        continue;
      }
      if (closing.has(issueKey)) {
        skipped.push({ requestKey: effect.requestKey, kind, reason: 'covered-by-close' });
        continue;
      }
      const after = asRecord(asRecord(effect.result).after);
      const expected = typeof after.statusName === 'string'
        ? after.statusName
        : asRecord(effect.payload).toStatusName;
      pushCompensation(effect, 'restoreStatus', {
        issueKey,
        toStatusName: statusName,
        expectedStatusName: typeof expected === 'string' ? expected : '',
      });
      continue;
    }

    if (kind === 'setFields') {
      const issueKey = effectIssueKey(effect, createdByStep);
      const beforeFields = asRecord(asRecord(asRecord(effect.result).before).fields);
      const names = Object.keys(beforeFields);
      if (!issueKey || names.length === 0) {
        cannotUndo.push({
          requestKey: effect.requestKey,
          kind,
          reason: !issueKey ? 'missing-issue-key' : 'no-before-snapshot',
        });
        continue;
      }
      if (closing.has(issueKey)) {
        skipped.push({ requestKey: effect.requestKey, kind, reason: 'covered-by-close' });
        continue;
      }
      const afterFields = asRecord(asRecord(asRecord(effect.result).after).fields);
      pushCompensation(effect, 'restoreFields', {
        issueKey,
        fields: beforeFields,
        wrote: afterFields,
      });
    }
  }

  for (const compensation of compensations) {
    if (compensation.kind !== 'closeIssue') continue;
    const issueKey = compensation.payload.issueKey;
    const dependencies = removalsByIssue.get(issueKey) ?? [];
    const byApplied = new Map(compensations.map((item) => [item.requestKey, item.appliedAt]));
    compensation.dependsOnKeys = [...dependencies].sort((left, right) => {
      const at = (byApplied.get(right) ?? 0) - (byApplied.get(left) ?? 0);
      if (at !== 0) return at;
      return left < right ? -1 : 1;
    });
  }

  return {
    compensations: orderCompensations(compensations),
    cannotUndo,
    skipped,
    irreversible: [
      'closed-child-remains',
      'kvs-memory-kept',
      'flight-recorder-append-only',
    ],
  };
}

/**
 * Decide whether the applier may perform one compensation against the
 * issue as it looks now. A status or field that has moved since the run
 * wrote it is drift: do not force it back. Closing a child and removing a
 * comment do not use this check.
 *
 * @param {object} compensation
 * @param {{statusName?: string, fields?: Record<string, unknown>}} current
 * @returns {{apply: boolean, reason: string}}
 */
export function compensationApplies(compensation, current) {
  const now = asRecord(current);
  if (compensation?.kind === 'restoreStatus') {
    const expected = compensation.payload?.expectedStatusName;
    if (typeof expected === 'string' && expected.length > 0 && now.statusName !== expected) {
      return { apply: false, reason: 'status-drift' };
    }
  }
  if (compensation?.kind === 'restoreFields') {
    const wrote = asRecord(compensation.payload?.wrote);
    const fields = asRecord(now.fields);
    for (const name of Object.keys(wrote)) {
      if (fields[name] !== wrote[name]) {
        return { apply: false, reason: 'field-drift' };
      }
    }
  }
  return { apply: true, reason: '' };
}

/**
 * The plan-citation comment is enqueued only when a lesson was applied.
 * That lesson leaves `input.citation` on the check-deps step (`src/memory/lessons.js`).
 * Any non-empty citation is enough: the card records the template, not the
 * sentence. A `done` step is a fork prefix and is skipped, so a copied
 * citation does not predict a second Epic comment on the fork.
 *
 * @param {Array<any>} steps
 * @returns {string}
 */
export function planCardFromSteps(steps) {
  /** @type {string[]} */
  const lines = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || step.status === 'done') continue;
    const input = asRecord(step.input);
    if (typeof input.citation === 'string' && input.citation.trim().length > 0) {
      lines.push(input.citation.trim());
    }
  }
  return lines.join('\n');
}

/**
 * Headers the effect templates write. Duplicated here so this file does not
 * import the memory module or the lead loop. The strings are the product
 * contract in `src/memory/lessonText.js`, `src/memory/comment.js`, and
 * `src/run/leadLoop.js`.
 *
 * @constant {Readonly<Record<string, string>>}
 */
const EPIC_COMMENT_HEADERS = Object.freeze({
  'plan:lesson-citation': '[Conductor plan]',
  'memory:epic-comment': '[Conductor memory]',
});

/**
 * A finished run also posts one Epic wave report. The card lists that
 * template under `omitted` because the lead has not decided yet. The
 * comparison may acknowledge those mutations and nothing else.
 *
 * @constant {ReadonlyArray<{template: string, header: string}>}
 */
const OMITTED_MUTATION_MARKERS = Object.freeze([
  { template: 'wave-report', header: '[Conductor wave]' },
]);

/**
 * @param {object} write
 * @param {string} name
 * @returns {string|undefined}
 */
function fieldTo(write, name) {
  const fields = Array.isArray(write?.fields) ? write.fields : [];
  const found = fields.find((field) => field && field.field === name);
  return found === undefined || found.to === undefined ? undefined : String(found.to);
}

/**
 * Pair the card with the Jira mutations a run actually recorded.
 *
 * Certain rows are always expected. `if-done` rows (the Epic memory
 * comment) are expected when `context.finished` is not `false`. Callers
 * that have not drained the run pass `finished: false`. Child comments
 * are matched by the issue key
 * the create landed on (`context.childIssueKeys`), because the card cannot
 * know `PAY-101` before dispatch. Bodies are matched only for Epic
 * comments, by the fixed header. A wave report is not a miss and not an
 * unexpected extra: the card already lists it under `omitted`.
 *
 * This function does not call Jira. The mutations are the fake board's
 * append-only log, or a hand-built list in a unit test.
 *
 * @param {object} card
 * @param {Array<object>} mutations
 * @param {{
 *   finished?: boolean,
 *   epicKey?: string,
 *   childIssueKeys?: Record<string, string>,
 * }} [context]
 * @returns {{
 *   missing: object[],
 *   extra: object[],
 *   acknowledged: Array<{template: string, mutation: object}>,
 *   paired: number,
 * }}
 */
export function accountPreviewWrites(card, mutations, context = {}) {
  const list = Array.isArray(mutations) ? mutations : [];
  const finished = context.finished !== false;
  const epicKey = context.epicKey || card?.epicKey;
  const childKeys = context.childIssueKeys && typeof context.childIssueKeys === 'object'
    ? context.childIssueKeys
    : {};
  const wanted = (Array.isArray(card?.writes) ? card.writes : []).filter((write) => {
    if (write.certainty === 'certain') return true;
    if (write.certainty === 'if-done') return finished;
    return false;
  });
  /** @type {Set<number>} */
  const used = new Set();
  /** @type {object[]} */
  const missing = [];

  /**
   * @param {(mutation: object) => boolean} predicate
   * @returns {object|null}
   */
  function take(predicate) {
    const index = list.findIndex((mutation, position) => (
      !used.has(position) && predicate(mutation)
    ));
    if (index < 0) return null;
    used.add(index);
    return list[index];
  }

  for (const write of wanted) {
    let found = null;
    if (write.kind === 'createIssue') {
      const summary = fieldTo(write, 'summary');
      const parent = fieldTo(write, 'parent');
      found = take((mutation) => (
        mutation.kind === 'createIssue'
        && mutation.summary === summary
        && (parent === undefined || mutation.parentKey === parent)
      ));
    } else if (write.kind === 'comment' && write.target?.type === 'child-of-step') {
      const issueKey = childKeys[write.stepId];
      found = take((mutation) => (
        mutation.kind === 'comment'
        && typeof issueKey === 'string'
        && issueKey.length > 0
        && mutation.issueKey === issueKey
      ));
    } else if (write.kind === 'comment') {
      const header = EPIC_COMMENT_HEADERS[write.template];
      const issueKey = write.target?.issueKey || epicKey;
      found = header
        ? take((mutation) => (
          mutation.kind === 'comment'
          && mutation.issueKey === issueKey
          && typeof mutation.bodyText === 'string'
          && mutation.bodyText.startsWith(header)
        ))
        : null;
    } else if (write.kind === 'transition') {
      const issueKey = write.target?.type === 'child-of-step'
        ? childKeys[write.stepId]
        : (write.target?.issueKey || epicKey);
      found = take((mutation) => (
        mutation.kind === 'transition'
        && mutation.issueKey === issueKey
        && mutation.toStatusName === write.toStatusName
      ));
    } else if (write.kind === 'setFields') {
      const issueKey = write.target?.type === 'child-of-step'
        ? childKeys[write.stepId]
        : (write.target?.issueKey || epicKey);
      found = take((mutation) => (
        mutation.kind === 'setFields' && mutation.issueKey === issueKey
      ));
    }
    if (!found) missing.push(write);
  }

  /** @type {object[]} */
  const extra = [];
  /** @type {Array<{template: string, mutation: object}>} */
  const acknowledged = [];
  list.forEach((mutation, index) => {
    if (used.has(index)) return;
    const marker = OMITTED_MUTATION_MARKERS.find((entry) => (
      (card?.omitted || []).some((item) => item.template === entry.template)
      && mutation.kind === 'comment'
      && mutation.issueKey === epicKey
      && typeof mutation.bodyText === 'string'
      && mutation.bodyText.startsWith(entry.header)
    ));
    if (marker) {
      acknowledged.push({ template: marker.template, mutation });
      return;
    }
    extra.push(mutation);
  });

  return {
    missing,
    extra,
    acknowledged,
    paired: wanted.length - missing.length,
  };
}

/**
 * True when an issue is the residue of undo: closed, and labelled by the
 * compensation. The simulator's open board is every other issue.
 *
 * @param {{fields?: {status?: {name?: string}, labels?: string[]}}|null|undefined} issue
 * @returns {boolean}
 */
export function isRollbackResidue(issue) {
  const fields = asRecord(issue?.fields);
  const status = asRecord(fields.status).name;
  const labels = Array.isArray(fields.labels) ? fields.labels : [];
  return status === CLOSE_STATUS_NAME && labels.includes(ROLLBACK_LABEL);
}

/**
 * Strings the Run panel can put in UI Kit `Text` and `DynamicTable` cells.
 * This file does not import `@forge/react`. M2 wraps each cell in `<Text>`,
 * the same way `StepTable` in `src/frontend/index.jsx` does. There is no
 * `Table` component.
 *
 * @param {object} card
 * @returns {{title: string, appearance: 'information'|'warning', summary: string, gateNote: string, head: object, rows: object[]}}
 */
export function panelModel(card) {
  const counts = card?.counts ?? {};
  const ifDone = counts.ifDone
    ? ` (${counts.ifDone} after the run finishes)`
    : '';
  const summary = `${counts.issues ?? 0} child issues, ${counts.comments ?? 0} comments${ifDone}, ${counts.transitions ?? 0} transitions, ${counts.fieldChanges ?? 0} field changes`;
  const rows = (card?.writes ?? []).map((write) => ({
    key: write.requestKey,
    cells: [
      { key: 'kind', content: write.kind },
      { key: 'target', content: write.summary },
      { key: 'template', content: write.template },
      { key: 'certainty', content: write.certainty },
    ],
  }));
  return {
    title: 'Blast radius',
    appearance: card?.gate?.insert ? 'warning' : 'information',
    summary,
    gateNote: card?.gate?.insert
      ? (card.gate.fits
        ? `An approval gate will wait for steps ${card.gate.waitFor.join(', ')}.`
        : 'This plan is already at the step cap, so dispatch stays on the confirmation card.')
      : '',
    head: {
      cells: [
        { key: 'kind', content: 'Kind' },
        { key: 'target', content: 'Target' },
        { key: 'template', content: 'Template' },
        { key: 'certainty', content: 'Certainty' },
      ],
    },
    rows,
  };
}
