/**
 * Jira REST adapter for the effects applier (WP2).
 *
 * This module is pure: it takes a `requestJira` function and never imports
 * `@forge/api`. The production wiring in `index.js` supplies a lazily-created
 * `asApp().requestJira` function, while unit tests pass a small mock.
 *
 * Supported effect kinds and payloads (docs/TASKS.md):
 * - `createIssue` `{projectKey, parentKey, summary, description, issueType}`
 * - `comment` `{issueKey, bodyAdf|bodyText}`
 * - `transition` `{issueKey, toStatusName}`
 * - `closeIssue` `{issueKey, toStatusName, label}` — transition, then label.
 *   Never `DELETE /rest/api/3/issue`.
 * - `recordRemovedComment` `{issueKey, commentId}` — delete that comment.
 * - `restoreStatus` `{issueKey, toStatusName, expectedStatusName}`
 * - `setFields` `{issueKey, fields}` — scalar fields only. The result stores
 *   `before.fields` with the values read before the PUT.
 * - `restoreFields` `{issueKey, fields, wrote}` — PUT `fields` only when the
 *   issue still holds `wrote`. Drift is `{skipped: true}` and does not write.
 *
 * `dependsOnKeys` may ride along on a compensation payload. It is not sent
 * to Jira. The applier reads it and waits. This module ignores it.
 *
 * @module effects/jira
 */

import { compensationApplies, fitBeforeSnapshot } from '../blast/preview.js';
import { EffectApplyError, EffectValidationError } from './errors.js';

/**
 * Build a minimal Atlassian Document Format paragraph for plain text.
 *
 * Jira Cloud REST v3 expects rich text fields as ADF. Callers may also pass a
 * complete ADF document when they need formatting.
 *
 * @param {string} text
 * @returns {{type: 'doc', version: 1, content: Array<object>}}
 */
export function textToAdf(text) {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text }],
      },
    ],
  };
}

/**
 * Accept either a complete ADF object or a JSON string containing one.
 * A plain string that is not JSON is wrapped as a text paragraph so an effect
 * never fails only because a caller passed prose.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {Record<string, unknown>}
 */
export function normalizeAdf(value, field) {
  if (value === undefined || value === null) {
    throw new EffectValidationError(`${field} is required`);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return /** @type {Record<string, unknown>} */ (parsed);
        }
      } catch {
        // Fall through to plain-text wrapping.
      }
    }
    if (trimmed.length === 0) {
      throw new EffectValidationError(`${field} must not be empty`);
    }
    return textToAdf(value);
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  throw new EffectValidationError(`${field} must be an ADF object or string`);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EffectValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * @param {string} issueKey
 * @returns {string}
 */
function issuePath(issueKey) {
  return `/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
}

/**
 * @param {Response|object|null|undefined} response
 * @returns {boolean}
 */
function isOk(response) {
  // Real fetch Responses always have `ok`. A hand-written test fake may return
  // the parsed body directly, so a missing `ok` means success unless it also
  // exposes an HTTP error status.
  if (response === null || response === undefined) {
    return true;
  }
  if (response.ok === false) {
    return false;
  }
  if (typeof response.status === 'number' && response.status >= 400) {
    return false;
  }
  return true;
}

/**
 * @param {Response|object|null|undefined} response
 * @returns {Promise<Record<string, any>|null>}
 */
async function readJsonBody(response) {
  if (response === null || response === undefined) {
    return null;
  }
  if (typeof response.json === 'function') {
    try {
      return await response.json();
    } catch {
      // Some successful Jira endpoints return 204 with no JSON body.
      return null;
    }
  }
  if (typeof response === 'object') {
    return /** @type {Record<string, any>} */ (response);
  }
  return null;
}

/**
 * @param {Response|object|null|undefined} response
 * @returns {Promise<string>}
 */
async function readErrorBody(response) {
  if (response === null || response === undefined) {
    return '';
  }
  try {
    if (typeof response.text === 'function') {
      return String(await response.text()).slice(0, 500);
    }
    if (typeof response === 'object') {
      return JSON.stringify(response).slice(0, 500);
    }
  } catch {
    // Ignore an unreadable error body; the HTTP status is enough.
  }
  return '';
}

/**
 * Throw a typed error when Jira returns a non-2xx response.
 *
 * @param {Response|object|null|undefined} response
 * @param {string} operation
 * @param {string} kind
 * @returns {Promise<void>}
 */
async function assertJiraOk(response, operation, kind) {
  if (isOk(response)) {
    return;
  }
  const status = typeof response?.status === 'number' ? response.status : undefined;
  const body = await readErrorBody(response);
  /** @type {{status?: number, kind?: string, body?: string, retryAfter?: string}} */
  const details = { status, kind, body };
  // Only a 429 carries the header the applier waits on. A 500 keeps the
  // exponential backoff even if a proxy attached Retry-After.
  if (status === 429) {
    const retryAfter = readRetryAfterHeader(response);
    if (retryAfter !== undefined) details.retryAfter = retryAfter;
  }
  throw new EffectApplyError(
    `Jira ${operation} failed with status ${String(status)}` +
      (body ? `: ${body}` : ''),
    details,
  );
}

/**
 * The raw `Retry-After` header, if the response has one.
 *
 * Fetch `Headers.get` is case-insensitive. A hand-written test fake may
 * pass a plain object instead, so those keys are compared ignoring case.
 * The value is not parsed here. The applier owns the clock.
 *
 * @param {Response|object|null|undefined} response
 * @returns {string|undefined}
 */
export function readRetryAfterHeader(response) {
  const headers = response && typeof response === 'object'
    ? /** @type {{headers?: unknown}} */ (response).headers
    : undefined;
  if (!headers) return undefined;
  if (typeof /** @type {{get?: unknown}} */ (headers).get === 'function') {
    const value = /** @type {{get: (name: string) => string|null}} */ (headers).get('retry-after');
    if (value != null && String(value).trim().length > 0) return String(value).trim();
  }
  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (headers))) {
      if (key.toLowerCase() !== 'retry-after') continue;
      if (value == null) return undefined;
      const text = String(value).trim();
      return text.length > 0 ? text : undefined;
    }
  }
  return undefined;
}

/**
 * @param {any} payload
 * @returns {{projectKey: string, parentKey?: string, summary: string, description?: unknown, issueType: string}}
 */
function validateCreateIssuePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new EffectValidationError('createIssue payload must be an object');
  }
  return {
    projectKey: requireString(payload.projectKey, 'createIssue.projectKey'),
    parentKey:
      payload.parentKey === undefined || payload.parentKey === null
        ? undefined
        : requireString(payload.parentKey, 'createIssue.parentKey'),
    summary: requireString(payload.summary, 'createIssue.summary'),
    description: payload.description,
    issueType: requireString(payload.issueType, 'createIssue.issueType'),
  };
}

/**
 * @param {any} payload
 * @returns {{issueKey: string, body: Record<string, unknown>}}
 */
function validateCommentPayload(payload, { allowDeferredKey = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new EffectValidationError('comment payload must be an object');
  }
  // A step comment may be enqueued before its child issue exists. It then
  // carries `childOfStepId`, and the applier fills `issueKey` from the step's
  // `childIssueKey` when it applies the effect.
  const deferred =
    allowDeferredKey &&
    payload.issueKey === undefined &&
    typeof payload.childOfStepId === 'string' &&
    payload.childOfStepId.length > 0;
  const issueKey = deferred
    ? undefined
    : requireString(payload.issueKey, 'comment.issueKey');
  if (payload.bodyAdf === undefined && payload.bodyText === undefined) {
    throw new EffectValidationError(
      'comment payload needs bodyAdf or bodyText',
    );
  }
  const body =
    payload.bodyAdf !== undefined
      ? normalizeAdf(payload.bodyAdf, 'comment.bodyAdf')
      : normalizeAdf(payload.bodyText, 'comment.bodyText');
  return { issueKey, body };
}

/**
 * @param {any} payload
 * @returns {{issueKey: string, toStatusName: string}}
 */
function validateTransitionPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new EffectValidationError('transition payload must be an object');
  }
  return {
    issueKey: requireString(payload.issueKey, 'transition.issueKey'),
    toStatusName: requireString(
      payload.toStatusName,
      'transition.toStatusName',
    ),
  };
}

/**
 * Close a child this run created. The payload names the destination status
 * and the label. `dependsOnKeys`, when present, is for the applier only.
 *
 * @param {any} payload
 * @returns {{issueKey: string, toStatusName: string, label: string}}
 */
function validateCloseIssuePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new EffectValidationError('closeIssue payload must be an object');
  }
  return {
    issueKey: requireString(payload.issueKey, 'closeIssue.issueKey'),
    toStatusName: requireString(payload.toStatusName, 'closeIssue.toStatusName'),
    label: requireString(payload.label, 'closeIssue.label'),
  };
}

/**
 * Record that a comment this run posted has been removed. The effect row is
 * the record. This function does not post a replacement comment.
 *
 * @param {any} payload
 * @returns {{issueKey: string, commentId: string}}
 */
function validateRemovedCommentPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new EffectValidationError('recordRemovedComment payload must be an object');
  }
  return {
    issueKey: requireString(payload.issueKey, 'recordRemovedComment.issueKey'),
    commentId: requireString(payload.commentId, 'recordRemovedComment.commentId'),
  };
}

/**
 * Put an issue back to the status this run found it in. `expectedStatusName`
 * is the status the forward transition left behind. The applier refuses the
 * write when the issue has moved on (status drift).
 *
 * @param {any} payload
 * @returns {{issueKey: string, toStatusName: string, expectedStatusName: string}}
 */
function validateRestoreStatusPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new EffectValidationError('restoreStatus payload must be an object');
  }
  return {
    issueKey: requireString(payload.issueKey, 'restoreStatus.issueKey'),
    toStatusName: requireString(payload.toStatusName, 'restoreStatus.toStatusName'),
    expectedStatusName: requireString(
      payload.expectedStatusName,
      'restoreStatus.expectedStatusName',
    ),
  };
}

/**
 * Build the Jira `fields` object for a child issue.
 *
 * `description` accepts either a plain string or an ADF document. Plain text
 * is wrapped in ADF because Jira Cloud REST v3 does not accept a bare string
 * for a rich-text field.
 *
 * @param {{projectKey: string, parentKey?: string, summary: string, description?: unknown, issueType: string}} payload
 * @returns {Record<string, unknown>}
 */
function createIssueFields(payload) {
  /** @type {Record<string, unknown>} */
  const fields = {
    project: { key: payload.projectKey },
    summary: payload.summary,
    issuetype: { name: payload.issueType },
  };
  if (payload.parentKey !== undefined) {
    fields.parent = { key: payload.parentKey };
  }
  if (payload.description !== undefined) {
    fields.description =
      typeof payload.description === 'string'
        ? textToAdf(payload.description)
        : normalizeAdf(payload.description, 'createIssue.description');
  }
  return fields;
}

/**
 * Find a Jira transition whose destination status matches `toStatusName`.
 *
 * Jira transition ids are workflow-specific, so the applier must read the
 * available transitions first instead of hardcoding an id.
 *
 * @param {Array<any>} transitions
 * @param {string} toStatusName
 * @returns {{id: string, name?: string}|null}
 */
function findTransition(transitions, toStatusName) {
  const wanted = toStatusName.trim().toLowerCase();
  for (const transition of transitions) {
    const destination =
      transition?.to?.name ?? transition?.name ?? transition?.toStatusName;
    if (
      typeof destination === 'string' &&
      destination.trim().toLowerCase() === wanted
    ) {
      if (transition.id === undefined || transition.id === null) {
        return null;
      }
      return {
        id: String(transition.id),
        name: typeof transition.name === 'string' ? transition.name : undefined,
      };
    }
  }
  return null;
}

/**
 * @param {unknown} issue
 * @returns {string}
 */
function statusNameOf(issue) {
  const fields = issue && typeof issue === 'object'
    ? /** @type {Record<string, any>} */ (issue).fields
    : undefined;
  const status = fields && typeof fields === 'object' ? fields.status : undefined;
  const name = status && typeof status === 'object' ? status.name : undefined;
  return typeof name === 'string' ? name : '';
}

/**
 * @param {unknown} issue
 * @returns {string[]}
 */
function labelsOf(issue) {
  const fields = issue && typeof issue === 'object'
    ? /** @type {Record<string, any>} */ (issue).fields
    : undefined;
  const labels = fields && typeof fields === 'object' ? fields.labels : undefined;
  if (!Array.isArray(labels)) return [];
  return labels.filter((label) => typeof label === 'string');
}

/**
 * Read one issue. Compensations need the live status and the live labels.
 * The preview's before-image is not a second source of truth at apply time.
 *
 * @param {Function} requestJira
 * @param {string} issueKey
 * @param {string} kind
 * @returns {Promise<Record<string, any>|null>}
 */
async function readIssue(requestJira, issueKey, kind) {
  const response = await requestJira(issuePath(issueKey), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  await assertJiraOk(response, 'read issue', kind);
  return readJsonBody(response);
}

/**
 * Look up a transition by destination name and POST it.
 *
 * Jira transition ids are workflow-specific. The name in the payload is the
 * stable part. There is no delete fallback when the workflow has no
 * transition to that name: the effect fails and the issue stays as it is.
 *
 * @param {Function} requestJira
 * @param {string} issueKey
 * @param {string} toStatusName
 * @param {string} kind
 * @returns {Promise<{transitionId: string}>}
 */
async function transitionIssue(requestJira, issueKey, toStatusName, kind) {
  const listResponse = await requestJira(
    `${issuePath(issueKey)}/transitions`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
    },
  );
  await assertJiraOk(listResponse, 'list transitions', kind);
  const listBody = await readJsonBody(listResponse);
  const transitions = Array.isArray(listBody)
    ? listBody
    : Array.isArray(listBody?.transitions)
      ? listBody.transitions
      : [];
  const transition = findTransition(transitions, toStatusName);
  if (!transition) {
    throw new EffectApplyError(
      `No Jira transition to status "${toStatusName}" on ${issueKey}`,
      { kind },
    );
  }

  const response = await requestJira(
    `${issuePath(issueKey)}/transitions`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transition: { id: transition.id } }),
    },
  );
  await assertJiraOk(response, 'transition issue', kind);
  return { transitionId: transition.id };
}

/**
 * Remember the status we are about to leave. The cap is 2 KiB and lives in
 * the existing `result` attribute. A missing status omits `before` so the
 * planner can report `no-before-snapshot` instead of inventing one.
 *
 * @param {string} transitionId
 * @param {string} beforeName
 * @param {string} toStatusName
 * @returns {Record<string, unknown>}
 */
function transitionResult(transitionId, beforeName, toStatusName) {
  /** @type {Record<string, unknown>} */
  const result = { transitionId };
  if (beforeName.length > 0) {
    result.before = fitBeforeSnapshot({ statusName: beforeName });
    result.after = { statusName: toStatusName };
  }
  return result;
}

/**
 * Perform one Jira mutation described by an effect.
 *
 * The caller is responsible for deduplication and for persisting the returned
 * result. This function only talks to Jira.
 *
 * @param {import('../store/types.js').Effect} effect
 * @param {{requestJira: (path: string, init?: object) => Promise<any>}} options
 * @returns {Promise<Record<string, unknown>>} Kind-specific result. A transition
 *   includes `before` when the issue had a status. A skipped restore includes
 *   `{skipped: true, reason}`.
 */
export async function applyJiraEffect(effect, options) {
  const requestJira = options?.requestJira;
  if (typeof requestJira !== 'function') {
    throw new EffectValidationError(
      'applyJiraEffect needs a requestJira function',
    );
  }

  if (effect.kind === 'createIssue') {
    const payload = validateCreateIssuePayload(effect.payload);
    const response = await requestJira('/rest/api/3/issue', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: createIssueFields(payload) }),
    });
    await assertJiraOk(response, 'create issue', effect.kind);
    const body = await readJsonBody(response);
    const issueKey = body?.key ?? body?.issueKey;
    if (typeof issueKey !== 'string' || issueKey.length === 0) {
      throw new EffectApplyError(
        'Jira create issue response did not include an issue key',
        { kind: effect.kind },
      );
    }
    return { issueKey };
  }

  if (effect.kind === 'comment') {
    const payload = validateCommentPayload(effect.payload);
    const response = await requestJira(
      `${issuePath(payload.issueKey)}/comment`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: payload.body }),
      },
    );
    await assertJiraOk(response, 'add comment', effect.kind);
    const body = await readJsonBody(response);
    const commentId = body?.id ?? body?.commentId;
    if (commentId === undefined || commentId === null) {
      throw new EffectApplyError(
        'Jira add comment response did not include a comment id',
        { kind: effect.kind },
      );
    }
    return { commentId: String(commentId) };
  }

  if (effect.kind === 'transition') {
    const payload = validateTransitionPayload(effect.payload);
    // Read the status first and copy the name before the POST. The fake
    // board (and a careless client) can hand back the live issue, and the
    // transition mutates that same object. The planner refuses to restore a
    // transition that has no `result.before.statusName`.
    const issue = await readIssue(requestJira, payload.issueKey, effect.kind);
    const beforeName = statusNameOf(issue);
    const moved = await transitionIssue(
      requestJira,
      payload.issueKey,
      payload.toStatusName,
      effect.kind,
    );
    return transitionResult(moved.transitionId, beforeName, payload.toStatusName);
  }

  if (effect.kind === 'closeIssue') {
    const payload = validateCloseIssuePayload(effect.payload);
    // Transition, then label. There is no DELETE. If the transition is
    // accepted and a later call throws, the error is marked partial so the
    // applier fails the row instead of transitioning again.
    const moved = await transitionIssue(
      requestJira,
      payload.issueKey,
      payload.toStatusName,
      effect.kind,
    );
    try {
      const issue = await readIssue(requestJira, payload.issueKey, effect.kind);
      const labels = labelsOf(issue);
      if (!labels.includes(payload.label)) {
        labels.push(payload.label);
      }
      const response = await requestJira(issuePath(payload.issueKey), {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: { labels } }),
      });
      await assertJiraOk(response, 'label rolled-back issue', effect.kind);
      return {
        transitionId: moved.transitionId,
        issueKey: payload.issueKey,
        label: payload.label,
      };
    } catch (error) {
      if (error && typeof error === 'object') {
        error.partial = true;
      }
      throw error;
    }
  }

  if (effect.kind === 'recordRemovedComment') {
    const payload = validateRemovedCommentPayload(effect.payload);
    const response = await requestJira(
      `${issuePath(payload.issueKey)}/comment/${encodeURIComponent(payload.commentId)}`,
      {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      },
    );
    // A redelivery that loses the race with the first delete sees 404.
    // The comment is already gone. That is the applied state, not a failure
    // and not a reason to post a second comment.
    const status = typeof response?.status === 'number' ? response.status : undefined;
    if (status !== 404) {
      await assertJiraOk(response, 'delete comment', effect.kind);
    }
    return {
      commentId: payload.commentId,
      issueKey: payload.issueKey,
    };
  }

  if (effect.kind === 'restoreStatus') {
    const payload = validateRestoreStatusPayload(effect.payload);
    const issue = await readIssue(requestJira, payload.issueKey, effect.kind);
    const current = statusNameOf(issue);
    if (current.length === 0) {
      throw new EffectApplyError(
        `Jira issue ${payload.issueKey} has no status to restore`,
        { kind: effect.kind },
      );
    }
    const decision = compensationApplies(
      { kind: 'restoreStatus', payload },
      { statusName: current },
    );
    if (!decision.apply) {
      // Drift is a decision, not a transient error. Marking the row applied
      // keeps a redelivery from forcing the issue back later.
      return {
        skipped: true,
        reason: decision.reason,
        statusName: current,
      };
    }
    const moved = await transitionIssue(
      requestJira,
      payload.issueKey,
      payload.toStatusName,
      effect.kind,
    );
    return transitionResult(moved.transitionId, current, payload.toStatusName);
  }

  if (effect.kind === 'setFields') {
    const payload = validateSetFieldsPayload(effect.payload);
    const issue = await readIssue(requestJira, payload.issueKey, effect.kind);
    const beforeFields = readScalarFields(issue, Object.keys(payload.fields));
    const response = await requestJira(issuePath(payload.issueKey), {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: payload.fields }),
    });
    await assertJiraOk(response, 'set fields', effect.kind);
    return {
      issueKey: payload.issueKey,
      before: fitBeforeSnapshot({ fields: beforeFields }),
      after: { fields: payload.fields },
    };
  }

  if (effect.kind === 'restoreFields') {
    const payload = validateRestoreFieldsPayload(effect.payload);
    const issue = await readIssue(requestJira, payload.issueKey, effect.kind);
    const current = readScalarFields(issue, Object.keys(payload.wrote));
    const decision = compensationApplies(
      { kind: 'restoreFields', payload },
      { fields: current },
    );
    if (!decision.apply) {
      return {
        skipped: true,
        reason: decision.reason,
        fields: current,
      };
    }
    const response = await requestJira(issuePath(payload.issueKey), {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: payload.fields }),
    });
    await assertJiraOk(response, 'restore fields', effect.kind);
    return {
      issueKey: payload.issueKey,
      before: fitBeforeSnapshot({ fields: current }),
      after: { fields: payload.fields },
    };
  }

  throw new EffectValidationError(`Unsupported effect kind: ${effect.kind}`);
}

/**
 * Validate an enqueue payload for a known kind. Called by `enqueueEffect` so a
 * malformed action input fails before an effect or queue message is written.
 *
 * @param {string} kind
 * @param {unknown} payload
 * @returns {void}
 */
export function validateEffectPayload(kind, payload) {
  if (kind === 'createIssue') {
    validateCreateIssuePayload(payload);
  } else if (kind === 'comment') {
    validateCommentPayload(payload, { allowDeferredKey: true });
  } else if (kind === 'transition') {
    validateTransitionPayload(payload);
  } else if (kind === 'closeIssue') {
    validateCloseIssuePayload(payload);
  } else if (kind === 'recordRemovedComment') {
    validateRemovedCommentPayload(payload);
  } else if (kind === 'restoreStatus') {
    validateRestoreStatusPayload(payload);
  } else if (kind === 'setFields') {
    validateSetFieldsPayload(payload);
  } else if (kind === 'restoreFields') {
    validateRestoreFieldsPayload(payload);
  } else {
    throw new EffectValidationError(`Unsupported effect kind: ${kind}`);
  }
}

/**
 * Scalar field values the before-image can compare with `===`.
 * Objects and arrays are refused so a later drift check is not a
 * reference comparison.
 *
 * @param {unknown} value
 * @returns {string|number|boolean|null|undefined}
 */
function scalarField(value) {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    return value.length > 500 ? value.slice(0, 500) : value;
  }
  return undefined;
}

/**
 * @param {unknown} fields
 * @param {string} label
 * @returns {Record<string, string|number|boolean|null>}
 */
function copyScalarFields(fields, label) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new EffectValidationError(`${label} must be an object`);
  }
  const names = Object.keys(fields).sort();
  if (names.length < 1 || names.length > 12) {
    throw new EffectValidationError(`${label} must name 1 to 12 fields`);
  }
  /** @type {Record<string, string|number|boolean|null>} */
  const copy = {};
  for (const name of names) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
      throw new EffectValidationError(`${label} field name is not allowed`);
    }
    const scalar = scalarField(fields[name]);
    if (scalar === undefined) {
      throw new EffectValidationError(
        `${label}.${name} must be a string, number, boolean, or null`,
      );
    }
    copy[name] = scalar;
  }
  return copy;
}

/**
 * @param {unknown} issue
 * @param {string[]} names
 * @returns {Record<string, string|number|boolean|null>}
 */
function readScalarFields(issue, names) {
  const fields = issue && typeof issue === 'object'
    ? /** @type {{fields?: unknown}} */ (issue).fields
    : undefined;
  const record = fields && typeof fields === 'object' && !Array.isArray(fields)
    ? /** @type {Record<string, unknown>} */ (fields)
    : {};
  /** @type {Record<string, string|number|boolean|null>} */
  const before = {};
  for (const name of names) {
    const scalar = Object.prototype.hasOwnProperty.call(record, name)
      ? scalarField(record[name])
      : null;
    before[name] = scalar === undefined ? null : scalar;
  }
  return before;
}

/**
 * @param {any} payload
 * @returns {{issueKey: string, fields: Record<string, string|number|boolean|null>}}
 */
function validateSetFieldsPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new EffectValidationError('setFields payload must be an object');
  }
  return {
    issueKey: requireString(payload.issueKey, 'setFields.issueKey'),
    fields: copyScalarFields(payload.fields, 'setFields.fields'),
  };
}

/**
 * @param {any} payload
 * @returns {{issueKey: string, fields: Record<string, string|number|boolean|null>, wrote: Record<string, string|number|boolean|null>}}
 */
function validateRestoreFieldsPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new EffectValidationError('restoreFields payload must be an object');
  }
  return {
    issueKey: requireString(payload.issueKey, 'restoreFields.issueKey'),
    fields: copyScalarFields(payload.fields, 'restoreFields.fields'),
    wrote: copyScalarFields(payload.wrote, 'restoreFields.wrote'),
  };
}
