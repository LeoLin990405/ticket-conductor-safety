/**
 * Jira issue trigger for child issues created by the effects queue (WP9).
 *
 * The worker normally reports its own result. This trigger covers the case
 * where a person marks the child issue Done, or comments on it, after the
 * issue exists. Events the app itself generates should be ignored in the
 * manifest (`filter.ignoreSelf`) so our own comments do not loop.
 *
 * An approval gate is the exception to the bare "mark the step done" path.
 * The gate stays `waiting` until a person moves its child issue to a
 * Done-like status. That event calls `approveGate`, which stores
 * `generator: 'human'` and releases steps whose `dependsOn` lists the gate.
 * A second delivery of the same transition is a no-op.
 *
 * @module triggers/childIssueUpdated
 */

import { approveGate, isApprovalGate } from '../run/approval.js';
import { resumeAwaitingRun } from '../run/leadLoop.js';
import { resolveDependencies } from '../run/dependencies.js';
import { reportStep } from '../run/stateMachine.js';
import {
  NotFoundError,
  StoreValidationError,
  getStepByChildIssueKey,
  getStore,
} from '../store/index.js';

/** Status names that mean the child issue is finished. @constant */
const DONE_STATUS = /^(done|closed|resolved|complete|completed)$/i;

/**
 * @param {any} event
 * @returns {string}
 */
function issueKeyFrom(event) {
  const issue = event?.issue ?? event?.payload?.issue;
  if (issue && typeof issue.key === 'string') {
    return issue.key;
  }
  if (typeof event?.issueKey === 'string') {
    return event.issueKey;
  }
  return '';
}

/**
 * @param {any} event
 * @returns {string}
 */
function eventTypeFrom(event) {
  return String(event?.eventType ?? event?.payload?.eventType ?? '');
}

/**
 * @param {any} event
 * @returns {string}
 */
function statusToString(event) {
  const items = event?.changelog?.items ?? event?.payload?.changelog?.items ?? [];
  if (!Array.isArray(items)) {
    return '';
  }
  const status = items.find((item) => item && item.field === 'status');
  return typeof status?.toString === 'string' ? status.toString : '';
}

/**
 * @param {any} event
 * @returns {string}
 */
function commentText(event) {
  const comment = event?.comment ?? event?.payload?.comment;
  if (!comment) {
    return '';
  }
  if (typeof comment.body === 'string') {
    return comment.body;
  }
  if (typeof comment.body?.content === 'object') {
    return JSON.stringify(comment.body);
  }
  return '';
}

/**
 * Account id of the person who caused the product event.
 *
 * A Jira issue-updated trigger carries `atlassianId`. A comment trigger
 * carries `comment.author.accountId`. The simulator copies the caller's
 * account onto `atlassianId` because the transition REST body does not.
 *
 * @param {any} event
 * @returns {string}
 */
function actorFromEvent(event) {
  const candidates = [
    event?.user?.accountId,
    event?.payload?.user?.accountId,
    event?.atlassianId,
    event?.payload?.atlassianId,
    event?.actor?.accountId,
    event?.comment?.author?.accountId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return '';
}

/**
 * Dependency bag for work this trigger starts.
 *
 * The manifest invocation is short, so the lead must not call the model
 * (`allowLeadLlm: false`). A simulation passes `leadDependencies` so the
 * released step is pushed onto the in-memory queue instead of `@forge/events`.
 * Omitted fields fall through to the production defaults inside `approveGate`
 * and `reportStep`.
 *
 * @param {{leadDependencies?: object}} deps
 * @returns {object}
 */
function triggerRuntime(deps) {
  const base = deps.leadDependencies && typeof deps.leadDependencies === 'object'
    ? deps.leadDependencies
    : {};
  return { ...base, allowLeadLlm: false };
}

/**
 * Forge product trigger handler.
 *
 * @param {any} event
 * @param {{reportStep?: Function, getStepByChildIssueKey?: Function, leadDependencies?: object}} [deps]
 * @returns {Promise<{status: string, stepId?: string, approved?: boolean, duplicate?: boolean}>}
 */
export async function childIssueUpdated(event, deps = {}) {
  const lookup = deps.getStepByChildIssueKey ?? getStepByChildIssueKey;
  const report = deps.reportStep ?? reportStep;
  const issueKey = issueKeyFrom(event);
  if (!issueKey) {
    return { status: 'ignored', reason: 'missing-issue' };
  }
  const step = await lookup(issueKey);
  if (!step) {
    // A unit test that injects its own lookup is exercising the child-step
    // path. It does not open the Forge store. Production, and a test that
    // passes `listRunsByEpic`, can unpause a run that is waiting on this Epic.
    const canResume = typeof deps.listRunsByEpic === 'function' || !deps.getStepByChildIssueKey;
    if (canResume) {
      const listRuns = deps.listRunsByEpic
        ?? ((key, options) => getStore().listRunsByEpic(key, options));
      const dependencies = deps.leadDependencies
        ?? resolveDependencies({ allowLeadLlm: false });
      try {
        const resumed = await resumeAwaitingRun({
          issueKey,
          event,
          listRuns,
          dependencies,
        });
        if (resumed) {
          return resumed;
        }
      } catch {
        // An unrelated issue should stay ignored when storage is unavailable.
        // A real reply is delivered again; the pause stays in place until then.
      }
    }
    return { status: 'ignored', reason: 'not-a-child-step' };
  }

  const eventType = eventTypeFrom(event);
  const nextStatus = statusToString(event);
  if (DONE_STATUS.test(nextStatus)) {
    // The product trigger is short. The lead still runs, on the deterministic
    // rules, so a person marking the last child Done can finish the wave
    // without a model call. The step worker (900s) is the path that may call
    // the model.
    const runtime = triggerRuntime(deps);
    if (isApprovalGate(step)) {
      // Same write as a direct approveGate call: actor, note, and
      // generator 'human'. A bare { status: 'done' } would release
      // dependents but would drop the approval record. Already-done is
      // idempotent. A failed or blocked gate stays that way; transitioning
      // the child must not throw out of the product trigger.
      const actor = actorFromEvent(event);
      try {
        const approved = await approveGate(step.stepId, {
          ...(actor ? { actor } : {}),
          note: `Transitioned to ${nextStatus}`,
        }, runtime);
        return {
          status: 'reported',
          stepId: approved.step.stepId,
          runStatus: approved.run?.status,
          approved: approved.approved === true,
          duplicate: approved.duplicate === true,
        };
      } catch (error) {
        if (error instanceof StoreValidationError || error instanceof NotFoundError) {
          return {
            status: 'ignored',
            reason: 'approval-not-applied',
            stepId: step.stepId,
          };
        }
        throw error;
      }
    }
    const result = await report(step.stepId, { status: 'done' }, runtime);
    return {
      status: 'reported',
      stepId: result.step.stepId,
      runStatus: result.run.status,
    };
  }

  // A comment must not claim a queued step. The worker still owns that claim.
  if (eventType.includes('commented:issue') && step.status === 'running') {
    const text = commentText(event).slice(0, 500);
    const result = await report(step.stepId, {
      status: 'running',
      output: {
        ...(step.output && typeof step.output === 'object' ? step.output : {}),
        lastComment: text,
      },
    });
    return { status: 'commented', stepId: result.step.stepId };
  }

  return { status: 'ignored', reason: 'no-matching-change', stepId: step.stepId };
}
