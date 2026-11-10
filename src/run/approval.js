/**
 * Human approval gates as DAG nodes (novelty #5).
 *
 * A gate is an ordinary step whose `workerType` is `approval`. It is not a
 * new entity, a new queue, or a new step status. The graph already holds a
 * step in `waiting` until every index in `dependsOn` is `done`, and the
 * watchdog already ignores `waiting` (`findStuckSteps` only queries `queued`
 * and `running`). This module is the small amount of policy on top of that:
 *
 * - `applyBlastGate` appends one gate when `previewBlastRadius` says the
 *   plan's score is over the threshold and the plan still has room. The
 *   steps the card lists in `gate.waitFor` gain that index on `dependsOn`.
 *   A sibling that is not in `waitFor` is left alone, so it still starts
 *   with the run.
 * - `startRun` does not push an approval step to `step-queue`. It stores
 *   the gate as `waiting` even when its own `dependsOn` is already
 *   satisfied. A person has to approve it. `releaseWaitingSteps` does not
 *   release it when some other step finishes.
 * - `approveGate` reports the gate `done`. Downstream steps then leave
 *   `waiting` through the same path as any other dependency. The Forge
 *   product trigger (`childIssueUpdated`) calls this function when a person
 *   transitions the gate's child issue to a Done-like status. A direct call
 *   is still the in-process stand-in for tests that do not move the issue.
 *
 * The gate's child issue is the normal `createIssue` effect `startRun`
 * already enqueues, with discriminator `child-issue`. The preview calls
 * that row `approval-child` and does not give it a score, so recomputing
 * the card after the gate is stored does not insert a second gate. The
 * approval step does not enqueue a worker comment.
 *
 * @module run/approval
 */

import { gateInsertion, previewBlastRadius } from '../blast/preview.js';
import { NotFoundError, StoreValidationError } from '../store/index.js';

/**
 * @param {unknown} step
 * @returns {boolean}
 */
export function isApprovalGate(step) {
  return !!step && typeof step === 'object' && step.workerType === 'approval';
}

/**
 * Step ids that must not get a child issue yet.
 *
 * A step is held when an approval gate it depends on, directly or through
 * another step that is not `done`, is still open. The gate itself is not
 * held: its child is the issue a person transitions to approve. A sibling
 * that does not depend on the gate is not held.
 *
 * @param {Array<object>|null|undefined} steps
 * @returns {Set<string>}
 */
export function stepIdsBlockedByOpenApproval(steps) {
  const list = Array.isArray(steps) ? steps : [];
  /** @type {Map<number, object>} */
  const byIdx = new Map();
  for (const step of list) {
    if (step && Number.isInteger(step.idx)) byIdx.set(step.idx, step);
  }
  /** @type {Map<string, boolean>} */
  const memo = new Map();
  /**
   * @param {object|null|undefined} step
   * @param {Set<string>} stack
   * @returns {boolean}
   */
  function blockedByGate(step, stack) {
    if (!step || isApprovalGate(step)) return false;
    const id = typeof step.stepId === 'string' ? step.stepId : '';
    if (id && memo.has(id)) return memo.get(id) === true;
    if (id && stack.has(id)) return false;
    if (id) stack.add(id);
    let hit = false;
    const deps = Array.isArray(step.dependsOn) ? step.dependsOn : [];
    for (const idx of deps) {
      const dep = byIdx.get(idx);
      if (!dep) continue;
      if (isApprovalGate(dep) && dep.status !== 'done') {
        hit = true;
        break;
      }
      if (dep.status !== 'done' && blockedByGate(dep, stack)) {
        hit = true;
        break;
      }
    }
    if (id) stack.delete(id);
    if (id) memo.set(id, hit);
    return hit;
  }
  /** @type {Set<string>} */
  const blocked = new Set();
  for (const step of list) {
    if (step?.stepId && blockedByGate(step, new Set())) {
      blocked.add(step.stepId);
    }
  }
  return blocked;
}

/**
 * Insert the blast-radius gate before the steps are stored.
 *
 * `previewBlastRadius` needs a `stepId` on every row so it can name request
 * keys. Those ids are temporary. `createSteps` mints the real ones, and the
 * caller recomputes the card from the stored rows. This function does not
 * read or write KVS, and it does not call Jira.
 *
 * When the card says `insert` but `fits` is false, the plan is already at
 * the 8-step cap. The steps come back unchanged. The confirmation card is
 * still the gate, which is what `gateInsertion` already specifies.
 *
 * An approval step that is already in the plan (a person lesson appended
 * one, or the caller sent one) makes `gate.insert` false. This does not
 * add a second gate.
 *
 * @param {{
 *   run: {runId: string, epicKey: string, projectKey: string, goal?: string},
 *   steps?: Array<any>,
 *   planCard?: string,
 * }} input
 * @returns {{steps: Array<any>, inserted: boolean, reason: string}}
 */
export function applyBlastGate(input) {
  const steps = Array.isArray(input?.steps) ? input.steps : [];
  const previewSteps = steps.map((step, index) => ({
    ...step,
    idx: Number.isInteger(step?.idx) ? step.idx : index,
    stepId: typeof step?.stepId === 'string' && step.stepId.length > 0
      ? step.stepId
      : `preview-${index}`,
    status: typeof step?.status === 'string' ? step.status : 'queued',
  }));
  const card = previewBlastRadius({
    run: input.run,
    steps: previewSteps,
    planCard: input.planCard || '',
  });
  const inserted = gateInsertion(card, previewSteps);
  if (!inserted.insert) {
    return {
      steps,
      inserted: false,
      reason: inserted.reason || '',
    };
  }
  // Drop the preview-only id and status. `createSteps` assigns both, and a
  // leftover `stepId` must not be mistaken for the entity key.
  const shaped = inserted.steps.map((step) => {
    const copy = { ...step };
    delete copy.stepId;
    delete copy.status;
    return copy;
  });
  return {
    steps: shaped,
    inserted: true,
    reason: inserted.reason || '',
  };
}

/**
 * The `output` stored on an approved gate.
 *
 * `generator: 'human'` is what the flight recorder and the panel use to tell
 * a person's decision from a worker result. `childIssueUpdated` and a direct
 * `approveGate` call both go through here, so a transition and a stand-in
 * call leave the same shape.
 *
 * @param {{actor?: string, note?: string}} [approval]
 * @returns {{approved: true, actor: string, note: string, generator: 'human'}}
 */
export function gateApprovalOutput(approval = {}) {
  const actor = typeof approval.actor === 'string' && approval.actor.trim().length > 0
    ? approval.actor.trim()
    : 'simulation';
  const note = typeof approval.note === 'string' ? approval.note : '';
  return {
    approved: true,
    actor,
    note,
    generator: 'human',
  };
}

/**
 * Mark an approval gate `done` and let the graph release whatever waits on it.
 *
 * This is not a Jira write. The child issue stays where `createIssue` left
 * it. The product trigger calls this after a person transitions that child
 * to Done; it does not write a second status. A second call, after the gate
 * is already `done`, does not release the downstream steps again:
 * `reportStep` ignores a terminal step, and this returns before calling it.
 *
 * @param {string} stepId
 * @param {{actor?: string, note?: string}} [approval]
 * @param {object} [overrides] Same dependency bag as `startRun` / `reportStep`.
 * @returns {Promise<{step: object, run: object, approved: boolean, duplicate: boolean}>}
 */
export async function approveGate(stepId, approval = {}, overrides) {
  if (typeof stepId !== 'string' || stepId.length === 0) {
    throw new StoreValidationError('approveGate stepId is required');
  }
  // Imported here so `stateMachine.js` can import `isApprovalGate` from
  // this file without a cycle at load time. `reportStep` is the one write
  // path that releases `waiting` dependents.
  const { reportStep } = await import('./stateMachine.js');
  const { resolveDependencies } = await import('./dependencies.js');
  const dependencies = resolveDependencies(overrides);
  const step = await dependencies.store.getStep(stepId);
  if (!step) {
    throw new NotFoundError('step', stepId);
  }
  if (!isApprovalGate(step)) {
    throw new StoreValidationError(`step ${stepId} is not an approval gate`);
  }
  if (step.status === 'failed' || step.status === 'blocked') {
    throw new StoreValidationError(
      `approval gate ${stepId} is already ${step.status}`,
    );
  }
  if (step.status === 'done') {
    const run = await dependencies.store.getRun(step.runId);
    return { step, run, approved: true, duplicate: true };
  }
  const result = await reportStep(stepId, {
    status: 'done',
    output: gateApprovalOutput(approval),
  }, overrides);
  return {
    step: result.step,
    run: result.run,
    approved: true,
    duplicate: false,
  };
}
