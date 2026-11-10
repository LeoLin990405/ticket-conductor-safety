/**
 * Effect request keys used by the watchdog fallback (WP4).
 *
 * WP2 owns the canonical `requestKeyFor`. This copy exists only so the
 * watchdog can enqueue its Epic comment when WP2 is not injected. The
 * canonical form is the one documented in docs/TASKS.md and matches WP2:
 *
 * `sha256(`${runId}|${stepId}|${kind}|${discriminator}`)` in lowercase hex.
 *
 * The discriminator is attempt independent by design. The watchdog uses
 * `watchdog-blocked`, so a second watchdog pass cannot mint a second comment
 * for the same step.
 *
 * @module watchdog/requestKey
 */

import { createHash } from 'node:crypto';

/**
 * Build the deterministic WP2 request key.
 *
 * Missing optional components become empty strings, which keeps run-level
 * effects (no `stepId`) deterministic as well.
 *
 * @param {{runId?: string, stepId?: string, kind?: string,
 *   discriminator?: string|number}} input Key components.
 * @returns {string} Lowercase sha256 hex digest.
 */
export function requestKeyFor(input = {}) {
  const parts = [
    input.runId ?? '',
    input.stepId ?? '',
    input.kind ?? '',
    input.discriminator ?? '',
  ].map((part) => String(part));
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}
