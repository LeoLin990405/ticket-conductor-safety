/**
 * Cheap gate in front of the watchdog scan, to keep Forge KVS usage low.
 *
 * - One small key, `tc-watchdog-gate`, holds `{activeUntil}`. Starting or
 *   resuming a run writes it once (now + ACTIVE_WINDOW_MS).
 * - The fiveMinute trigger reads only that key. With no active window it
 *   stops there: no step query, no three empty effect queries (each empty
 *   read is billed as 1 KB).
 * - While active it scans only on the :00/:15/:30/:45 tick, so a pass runs
 *   every 15 minutes. The cadence comes from the clock, so it costs no write.
 *
 * @module watchdog/gate
 */

export const GATE_KEY = 'tc-watchdog-gate';
export const ACTIVE_WINDOW_MS = 2 * 60 * 60 * 1000;
export const SCAN_EVERY_MS = 15 * 60 * 1000;
const TICK_MS = 5 * 60 * 1000;

async function defaultKvs() {
  const mod = await import('@forge/kvs');
  return mod.kvs;
}

/**
 * @param {number} nowMs
 * @returns {boolean} True on the one 5-minute tick in each 15-minute slot.
 */
export function onScanTick(nowMs) {
  return nowMs % SCAN_EVERY_MS < TICK_MS;
}

/**
 * Record that a run is active. Failures are swallowed: the gate is an
 * optimisation and must never break run creation.
 *
 * @param {{now?: number, kvs?: any, logger?: any}} [options]
 */
export async function markActive(options = {}) {
  try {
    const kvs = options.kvs ?? await defaultKvs();
    const now = options.now ?? Date.now();
    await kvs.set(GATE_KEY, { activeUntil: now + ACTIVE_WINDOW_MS });
  } catch (error) {
    options.logger?.warn?.('[watchdog-gate] markActive failed', error?.message);
  }
}

/**
 * @param {{now?: number, kvs?: any}} [options]
 * @returns {Promise<{scan: boolean, reason: string}>}
 */
export async function shouldScan(options = {}) {
  const now = options.now ?? Date.now();
  if (!onScanTick(now)) {
    return { scan: false, reason: 'off-tick' };
  }
  let gate = null;
  try {
    const kvs = options.kvs ?? await defaultKvs();
    gate = await kvs.get(GATE_KEY);
  } catch {
    // If the gate cannot be read, scan rather than miss a stuck run.
    return { scan: true, reason: 'gate-unreadable' };
  }
  if (!gate || !Number.isFinite(gate.activeUntil) || gate.activeUntil < now) {
    return { scan: false, reason: 'idle' };
  }
  return { scan: true, reason: 'active' };
}
