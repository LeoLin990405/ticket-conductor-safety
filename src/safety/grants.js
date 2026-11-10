/**
 * Human confirmation grants for irreversible Jira writes.
 *
 * `plan-split`, `get-run-status`, and `handoffGoal` do not return a
 * `confirmToken`. The Run panel (`approveFromPanel`) is the surface that
 * mints one. The token is an HMAC of the blast-radius binding under a
 * server secret, it expires, and the first successful check consumes it.
 *
 * The grant table is process-local. The panel mints and consumes the token
 * in the same invocation, so a later agent call cannot read it back. A
 * token presented in another instance fails closed because that instance
 * has no row. Set `CONDUCTOR_CONFIRM_SECRET` (16 characters or more) so
 * every instance of one install uses the same key. When it is unset, the
 * process generates a random key and does not export it.
 *
 * @module safety/grants
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { planCardFromSteps, previewBlastRadius } from '../blast/preview.js';
import {
  acknowledgementText,
  confirmationToken,
  forkAcknowledgement,
  forkConfirmationToken,
} from './guard.js';

/** How long a minted token stays usable. @constant {number} */
export const CONFIRM_TTL_MS = 15 * 60 * 1000;

/** @type {Buffer|null} */
let processSecret = null;

/** @type {Map<string, Grant>} */
const grants = new Map();

/**
 * @typedef {object} Grant
 * @property {string} id
 * @property {'dispatch'|'fork'} kind
 * @property {string} runId
 * @property {string} acknowledgement
 * @property {string} binding
 * @property {number} expiresAt
 * @property {boolean} used
 * @property {string} principal
 */

/**
 * Drop every grant. Tests use this so a file does not keep tokens.
 *
 * @returns {void}
 */
export function resetConfirmationGrants() {
  grants.clear();
}

/**
 * @returns {Buffer}
 */
function secretBytes() {
  const configured = process.env.CONDUCTOR_CONFIRM_SECRET;
  if (typeof configured === 'string' && configured.length >= 16) {
    return Buffer.from(configured, 'utf8');
  }
  if (!processSecret) processSecret = randomBytes(32);
  return processSecret;
}

/**
 * @param {unknown} now
 * @returns {number}
 */
function readNow(now) {
  const value = typeof now === 'function' ? now() : now;
  return Number.isFinite(value) ? Math.trunc(/** @type {number} */ (value)) : Date.now();
}

/**
 * @param {string} material
 * @returns {string}
 */
function mac(material) {
  return createHmac('sha256', secretBytes()).update(material, 'utf8').digest('hex');
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function sameMac(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * @param {object|null|undefined} card
 * @returns {string}
 */
function dispatchBinding(card) {
  return [
    'tc-irreversible-v2',
    typeof card?.runId === 'string' ? card.runId : '',
    typeof card?.epicKey === 'string' ? card.epicKey : '',
    acknowledgementText(card),
    confirmationToken(card),
  ].join('\n');
}

/**
 * @param {unknown} runId
 * @param {unknown} stepIdx
 * @param {unknown} input
 * @returns {string}
 */
function forkBinding(runId, stepIdx, input) {
  return [
    'tc-fork-v2',
    String(runId ?? ''),
    String(stepIdx),
    forkConfirmationToken(runId, stepIdx, input),
  ].join('\n');
}

/**
 * @param {Grant} grant
 * @returns {string}
 */
function tokenFor(grant) {
  const material = [grant.id, String(grant.expiresAt), grant.binding].join('\n');
  return `v2.${grant.id}.${mac(material)}`;
}

/**
 * @param {unknown} token
 * @returns {{id: string, mac: string}|null}
 */
function parseToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v2') return null;
  if (!/^[0-9a-f]{32}$/.test(parts[1])) return null;
  if (!/^[0-9a-f]{64}$/.test(parts[2])) return null;
  return { id: parts[1], mac: parts[2] };
}

/**
 * @param {{
 *   kind: 'dispatch'|'fork',
 *   runId: string,
 *   acknowledgement: string,
 *   binding: string,
 *   now: number,
 *   principal?: string,
 * }} input
 * @returns {{ok: true, confirmToken: string, acknowledgement: string, expiresAt: number, confirmationId: string}}
 */
function mint(input) {
  const id = randomBytes(16).toString('hex');
  /** @type {Grant} */
  const grant = {
    id,
    kind: input.kind,
    runId: input.runId,
    acknowledgement: input.acknowledgement,
    binding: input.binding,
    expiresAt: input.now + CONFIRM_TTL_MS,
    used: false,
    principal: typeof input.principal === 'string' ? input.principal : '',
  };
  grants.set(id, grant);
  return {
    ok: true,
    confirmToken: tokenFor(grant),
    acknowledgement: grant.acknowledgement,
    expiresAt: grant.expiresAt,
    confirmationId: id,
  };
}

/**
 * @param {object|null|undefined} card
 * @param {{now?: number|(() => number), principal?: string}} [options]
 * @returns {{ok: true, confirmToken: string, acknowledgement: string, expiresAt: number, confirmationId: string}}
 */
export function issueDispatchGrant(card, options = {}) {
  const now = readNow(options.now);
  return mint({
    kind: 'dispatch',
    runId: typeof card?.runId === 'string' ? card.runId : '',
    acknowledgement: acknowledgementText(card),
    binding: dispatchBinding(card),
    now,
    principal: options.principal,
  });
}

/**
 * @param {{runId?: unknown, stepIdx?: unknown, input?: unknown, now?: number|(() => number), principal?: string}} input
 * @returns {{ok: true, confirmToken: string, acknowledgement: string, expiresAt: number, confirmationId: string}}
 */
export function issueForkGrant(input) {
  const now = readNow(input?.now);
  const runId = typeof input?.runId === 'string' ? input.runId : '';
  return mint({
    kind: 'fork',
    runId,
    acknowledgement: forkAcknowledgement(runId, input?.stepIdx),
    binding: forkBinding(runId, input?.stepIdx, input?.input),
    now,
    principal: input?.principal,
  });
}

/**
 * Load the stored plan and mint a dispatch grant. The token is returned
 * only to the caller of this function. Action handlers do not call it.
 *
 * @param {{
 *   runId?: unknown,
 *   store?: {getRun: Function, listSteps: Function},
 *   now?: number|(() => number),
 *   principal?: string,
 * }} input
 * @returns {Promise<{ok: true, confirmToken: string, acknowledgement: string, expiresAt: number, confirmationId: string}|{ok: false, code: string, reason: string}>}
 */
export async function issueHumanConfirmation(input) {
  const runId = typeof input?.runId === 'string' ? input.runId.trim() : '';
  const store = input?.store;
  if (!runId || !store || typeof store.getRun !== 'function' || typeof store.listSteps !== 'function') {
    return { ok: false, code: 'CONFIRMATION_REQUIRED', reason: 'run is not available to approve' };
  }
  const run = await store.getRun(runId);
  if (!run) {
    return { ok: false, code: 'CONFIRMATION_REQUIRED', reason: 'run is not available to approve' };
  }
  const steps = await store.listSteps(runId);
  const card = previewBlastRadius({
    run,
    steps,
    planCard: planCardFromSteps(steps),
  });
  return issueDispatchGrant(card, { now: input.now, principal: input.principal });
}

/**
 * @param {unknown} token
 * @param {{kind: 'dispatch'|'fork', binding: string, acknowledgement: string, now: number}} expected
 * @returns {{ok: true, code: 'CONFIRMED'}|{ok: false, code: string, reason: string}}
 */
function consume(token, expected) {
  const parsed = parseToken(token);
  if (!parsed) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      reason: 'confirmToken does not match this blast radius',
    };
  }
  const grant = grants.get(parsed.id);
  if (!grant || grant.kind !== expected.kind) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      reason: 'confirmToken does not match this blast radius',
    };
  }
  if (grant.used) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      reason: 'confirmToken was already used',
    };
  }
  if (expected.now >= grant.expiresAt) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      reason: 'confirmToken has expired',
    };
  }
  const material = [grant.id, String(grant.expiresAt), expected.binding].join('\n');
  if (!sameMac(parsed.mac, mac(material)) || grant.binding !== expected.binding) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      reason: 'confirmToken does not match this blast radius',
    };
  }
  if (grant.acknowledgement !== expected.acknowledgement) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      reason: 'acknowledgeBlastRadius must match the blast-radius card',
    };
  }
  grant.used = true;
  return { ok: true, code: 'CONFIRMED' };
}

/**
 * @param {object|null|undefined} payload
 * @param {object|null|undefined} card
 * @param {number|(() => number)} [now]
 * @returns {{ok: true, code: 'CONFIRMED'}|{ok: false, code: string, reason: string}}
 */
export function authorizeDispatch(payload, card, now) {
  if (!payload || payload.confirm !== true) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      reason: 'confirm must be the boolean true',
    };
  }
  const acknowledgement = acknowledgementText(card);
  if (payload.acknowledgeBlastRadius !== acknowledgement) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      reason: 'acknowledgeBlastRadius must match the blast-radius card',
    };
  }
  return consume(payload.confirmToken, {
    kind: 'dispatch',
    binding: dispatchBinding(card),
    acknowledgement,
    now: readNow(now),
  });
}

/**
 * @param {object|null|undefined} payload
 * @param {number|(() => number)} [now]
 * @returns {{ok: true, code: 'CONFIRMED'}|{ok: false, code: string, reason: string}}
 */
export function authorizeFork(payload, now) {
  if (!payload || payload.confirm !== true) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      reason: 'confirm must be the boolean true',
    };
  }
  const runId = typeof payload.runId === 'string' ? payload.runId.trim() : '';
  const acknowledgement = forkAcknowledgement(runId, payload.stepIdx);
  if (payload.acknowledgeBlastRadius !== acknowledgement) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      reason: 'acknowledgeBlastRadius must match the fork card',
    };
  }
  return consume(payload.confirmToken, {
    kind: 'fork',
    binding: forkBinding(runId, payload.stepIdx, payload.input),
    acknowledgement,
    now: readNow(now),
  });
}

/**
 * Run-panel approval. The account id comes from the Forge resolver
 * context. A missing person refuses. The returned object never includes
 * `confirmToken`; `dispatch` consumes it inside this call.
 *
 * @param {{
 *   runId?: unknown,
 *   accountId?: unknown,
 *   now?: number|(() => number),
 *   store?: {getRun: Function, listSteps: Function},
 *   dispatch: (payload: object) => Promise<object>,
 * }} input
 * @returns {Promise<object>}
 */
export async function approveFromPanel(input) {
  const accountId = typeof input?.accountId === 'string' ? input.accountId.trim() : '';
  if (!accountId) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      error: 'the Run panel must be opened by a person',
    };
  }
  const issued = await issueHumanConfirmation({
    runId: input?.runId,
    store: input?.store,
    now: input?.now,
    principal: accountId,
  });
  if (!issued.ok) {
    return { ok: false, code: issued.code, error: issued.reason };
  }
  const started = await input.dispatch({
    runId: typeof input.runId === 'string' ? input.runId.trim() : input.runId,
    confirm: true,
    acknowledgeBlastRadius: issued.acknowledgement,
    confirmToken: issued.confirmToken,
  });
  if (!started || typeof started !== 'object') {
    return { ok: false, code: 'ERROR', error: 'dispatch did not return a result' };
  }
  const rest = { ...started };
  delete rest.confirmToken;
  delete rest.acknowledgement;
  return rest;
}
