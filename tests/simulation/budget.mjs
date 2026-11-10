/**
 * Per-scenario KVS byte budgets.
 *
 * The numbers are the billed totals from {@link createSimulationKvs}: every
 * get, query page, set, and compare-and-set, with a 1 KiB floor on each
 * operation. They were measured with `SIM_BUDGET_DEBUG=1 npm run test:simulation`
 * on 2026-11-06, after every run started storing `run.budget` and a batch of
 * work steps wrote that step count once. Each cap is that measurement plus
 * about 15 percent, rounded up to the next 1,000 bytes. A comment tweak stays
 * inside that margin. A new read loop does not.
 *
 * A scenario fails when it exceeds the cap. It also fails when the counter
 * stays at zero, because that would mean the run never touched the fake.
 *
 * `assertWithinBudget` also records the measurement. `formatHeadroomReport`
 * prints every key below, sorted by name, after the scenarios finish. The
 * table fails the run when a scenario is over its cap, never touched KVS,
 * or has no measurement. A scenario above 90% of either cap is a warning
 * on stderr and does not fail the run. Rows are sorted by scenario name,
 * so a reverse or shuffled run prints the same table when the totals match.
 *
 * @module tests/simulation/budget
 */

/**
 * @type {Record<string, {reads: number, writes: number}>}
 */
export const KVS_BUDGETS = Object.freeze({
  // Measured reads 689719, writes 207981. Two waves, five children.
  'dag-waves': { reads: 794_000, writes: 240_000 },
  // Measured reads 177579, writes 67229. One hang and one retry.
  watchdog: { reads: 205_000, writes: 78_000 },
  // Measured reads 258845, writes 100523. Pause, resume, one follow-up.
  approval: { reads: 298_000, writes: 116_000 },
  // Measured reads 76005, writes 53317. Fail, accept, second plan.
  lessons: { reads: 88_000, writes: 62_000 },
  // Measured reads 484498, writes 162887. Run, replay, fork.
  recorder: { reads: 558_000, writes: 188_000 },
  // Measured reads 340568, writes 119009 on 2026-11-09. The status call
  // inside the handoff now lists effect rows. Writes did not move.
  handoff: { reads: 392_000, writes: 137_000 },
  // Measured reads 140867, writes 62190. Model throws.
  'llm-throw': { reads: 162_000, writes: 72_000 },
  // Measured reads 129314, writes 62190. Empty model message.
  'llm-empty': { reads: 149_000, writes: 72_000 },
  // Measured reads 129321, writes 62193. Prose that is not JSON.
  'llm-malformed': { reads: 149_000, writes: 72_000 },
  // Measured reads 176965, writes 77805. Poisoned tickets.
  injection: { reads: 204_000, writes: 90_000 },
  // Measured reads 379540, writes 92916. Double dispatch, then redelivery.
  'duplicate-dispatch': { reads: 437_000, writes: 107_000 },
  // Measured reads 324837, writes 98077. Cycle reject, then one chain.
  'dependency-graph': { reads: 374_000, writes: 113_000 },
  // Measured reads 48934, writes 21181. One repair, then blocked.
  'schema-repair': { reads: 57_000, writes: 25_000 },
  // Measured reads 46722, writes 19815. Refused search, one child.
  'brief-tool': { reads: 54_000, writes: 23_000 },
  // Measured reads 348690, writes 119099. Plan, preview, drain, compare.
  'blast-preview': { reads: 401_000, writes: 137_000 },
  // Measured reads 791520, writes 197625. Undo, including the gate child.
  'blast-undo': { reads: 911_000, writes: 228_000 },
  // Measured reads 264285, writes 99894. Sibling finishes, gate stays waiting, then approve.
  'approval-gate': { reads: 304_000, writes: 115_000 },
  // Measured reads 116391, writes 61440. Five steps, one inserted gate, no worker runs.
  'approval-blast': { reads: 134_000, writes: 71_000 },
  // Measured reads 338645, writes 121831. Lesson inserts one gate; research finishes first.
  'approval-lesson': { reads: 390_000, writes: 141_000 },
  // Measured reads 158354, writes 59948. Gate stays waiting, then the child
  // transition approves it and the draft finishes. Includes one redelivery.
  'approval-trigger': { reads: 183_000, writes: 69_000 },
  // Measured reads 272847, writes 93471 on 2026-11-09. The finishing status
  // call lists the effect rows. Writes stayed 93,471.
  'run-budget': { reads: 314_000, writes: 108_000 },
  // Measured reads 36691, writes 22528 on 2026-11-09. Two plans, no dispatch.
  // Each status call reads an empty effect page (1 KiB floor). Writes did not move.
  'critical-path': { reads: 43_000, writes: 26_000 },
  // Measured reads 170410, writes 61121 on 2026-11-09. One duplicate fault,
  // one heal, the child issue created once. The status calls list effects,
  // and the heal write carries `budget.effects.deduped`.
  'chaos-counters': { reads: 196_000, writes: 71_000 },
  // Measured reads 280602, writes 80138 on 2026-11-09. Kill, duplicate, and
  // 429 in one run. The comment retry waits on Retry-After: 1. Status calls
  // list effects. The duplicate's heal write stores the dedupe tally.
  'chaos-proof': { reads: 323_000, writes: 93_000 },
  // Measured reads 267717, writes 70880 on 2026-11-09. One research step,
  // a duplicate child issue, and a comment 429 with Retry-After 30.
  'effect-throughput': { reads: 308_000, writes: 82_000 },
  // Measured reads 147835, writes 66225 on 2026-11-10. One child, two
  // comment parts, one POST, then undo. Other scenarios did not move.
  'comment-batching': { reads: 171_000, writes: 77_000 },
});

/**
 * A scenario is `warn` when it is still inside the cap and either counter
 * is strictly above this fraction of that cap. 90% exactly stays `ok`.
 * Equal to the cap is 100%, so it warns. Only a counter past the cap is
 * `over`, which fails the run. That matches `assertWithinBudget`, which
 * uses `>` rather than `>=`.
 *
 * @constant {number}
 */
export const KVS_HEADROOM_WARN_RATIO = 0.9;

/**
 * Measurements recorded by {@link assertWithinBudget}, keyed by scenario.
 * The report reads this map after the serial queue finishes. Tests that
 * want a table from plain numbers call {@link buildHeadroomRow} instead.
 *
 * @type {Map<string, {reads: number, writes: number}>}
 */
const measuredByScenario = new Map();

/**
 * Remember one scenario's billed totals. A second call for the same name
 * replaces the first. Scenarios assert the budget once, at the end.
 *
 * @param {string} name
 * @param {{reads: number, writes: number}} usage
 * @returns {void}
 */
export function noteScenarioUsage(name, usage) {
  measuredByScenario.set(name, { reads: usage.reads, writes: usage.writes });
}

/**
 * Drop recorded measurements. The simulation file does not call this.
 * A unit test of the report can, so an earlier case cannot leak a row.
 *
 * @returns {void}
 */
export function resetScenarioUsage() {
  measuredByScenario.clear();
}

/**
 * @param {number} used
 * @param {number} cap
 * @returns {number}
 */
function ratio(used, cap) {
  if (!Number.isFinite(cap) || cap <= 0) return Number.POSITIVE_INFINITY;
  return used / cap;
}

/**
 * Classify one scenario against its cap.
 *
 * `missing` — the scenario never called `assertWithinBudget`.
 * `idle` — a counter stayed at 0. The run did not touch that side of KVS.
 * `over` — a counter is past the cap. The run fails.
 * `warn` — inside the cap, and above 90% of one of them. The run continues.
 * `ok` — inside the cap, and at or under 90% of both.
 *
 * @param {{reads: number, writes: number}|null} used
 * @param {{reads: number, writes: number}} cap
 * @returns {'missing'|'idle'|'over'|'warn'|'ok'}
 */
export function classifyHeadroom(used, cap) {
  if (!used) return 'missing';
  if (used.reads <= 0 || used.writes <= 0) return 'idle';
  if (used.reads > cap.reads || used.writes > cap.writes) return 'over';
  if (
    ratio(used.reads, cap.reads) > KVS_HEADROOM_WARN_RATIO
    || ratio(used.writes, cap.writes) > KVS_HEADROOM_WARN_RATIO
  ) {
    return 'warn';
  }
  return 'ok';
}

/**
 * @param {string} name
 * @param {{reads: number, writes: number}|null} used
 * @param {{reads: number, writes: number}} cap
 * @returns {{
 *   name: string,
 *   used: {reads: number, writes: number}|null,
 *   cap: {reads: number, writes: number},
 *   readRatio: number|null,
 *   writeRatio: number|null,
 *   status: 'missing'|'idle'|'over'|'warn'|'ok',
 * }}
 */
export function buildHeadroomRow(name, used, cap) {
  return {
    name,
    used,
    cap,
    readRatio: used ? ratio(used.reads, cap.reads) : null,
    writeRatio: used ? ratio(used.writes, cap.writes) : null,
    status: classifyHeadroom(used, cap),
  };
}

/**
 * One row per key in {@link KVS_BUDGETS}, sorted by scenario name.
 * Sorting is what makes a shuffled run print the same table as source
 * order when the byte totals match.
 *
 * @returns {ReturnType<typeof buildHeadroomRow>[]}
 */
export function scenarioHeadroom() {
  return Object.keys(KVS_BUDGETS)
    .sort()
    .map((name) => buildHeadroomRow(name, measuredByScenario.get(name) ?? null, KVS_BUDGETS[name]));
}

/**
 * Group digits so the table matches the way the milestone notes are written
 * (`348,690/401,000`). A fixed grouping avoids a locale-dependent print.
 *
 * @param {number} value
 * @returns {string}
 */
function groupDigits(value) {
  const negative = value < 0;
  const digits = String(Math.abs(Math.trunc(value)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}

/**
 * @param {number|null} amount
 * @param {number} cap
 * @param {number|null} share
 * @returns {string}
 */
function usageCell(amount, cap, share) {
  if (amount === null || share === null) return 'not measured';
  return `${groupDigits(amount)}/${groupDigits(cap)} (${(share * 100).toFixed(1)}%)`;
}

/**
 * @param {ReturnType<typeof buildHeadroomRow>} row
 * @returns {number}
 */
function worstRatio(row) {
  if (row.readRatio === null || row.writeRatio === null) return -1;
  return Math.max(row.readRatio, row.writeRatio);
}

/**
 * The scenario closest to a cap. Ties break by scenario name so the line
 * does not depend on run order.
 *
 * @param {ReturnType<typeof buildHeadroomRow>[]} rows
 * @returns {ReturnType<typeof buildHeadroomRow>|null}
 */
function closestRow(rows) {
  /** @type {ReturnType<typeof buildHeadroomRow>|null} */
  let best = null;
  for (const row of rows) {
    if (row.readRatio === null || row.writeRatio === null) continue;
    if (!best) {
      best = row;
      continue;
    }
    const ratioDelta = worstRatio(row) - worstRatio(best);
    if (ratioDelta > 0 || (ratioDelta === 0 && row.name < best.name)) best = row;
  }
  return best;
}

/**
 * Render the headroom table. Rows are sorted by name again here so a caller
 * that built them in run order still gets a stable print.
 *
 * @param {ReturnType<typeof buildHeadroomRow>[]} rows
 * @param {{order?: string}} [options]
 * @returns {string}
 */
export function formatHeadroomReport(rows, options = {}) {
  const sorted = rows.slice().sort((left, right) => left.name.localeCompare(right.name));
  const rendered = sorted.map((row) => ({
    row,
    reads: row.used ? usageCell(row.used.reads, row.cap.reads, row.readRatio) : usageCell(null, row.cap.reads, null),
    writes: row.used ? usageCell(row.used.writes, row.cap.writes, row.writeRatio) : usageCell(null, row.cap.writes, null),
  }));
  const nameWidth = Math.max('scenario'.length, ...rendered.map((line) => line.row.name.length));
  const readsWidth = Math.max('reads'.length, ...rendered.map((line) => line.reads.length));
  const writesWidth = Math.max('writes'.length, ...rendered.map((line) => line.writes.length));
  const pad = (value, width) => value.padEnd(width, ' ');
  const lines = [
    `KVS headroom (order: ${options.order ?? 'source'})`,
    'warn above 90% of a cap; fail when a scenario is over its cap, idle, or not measured',
    `${pad('scenario', nameWidth)}  ${pad('reads', readsWidth)}  ${pad('writes', writesWidth)}  status`,
  ];
  for (const line of rendered) {
    lines.push(
      `${pad(line.row.name, nameWidth)}  ${pad(line.reads, readsWidth)}  ${pad(line.writes, writesWidth)}  ${line.row.status}`,
    );
  }
  const closest = closestRow(sorted);
  if (!closest || closest.readRatio === null || closest.writeRatio === null || !closest.used) {
    lines.push('closest: none');
  } else {
    const readsAreCloser = closest.readRatio >= closest.writeRatio;
    const side = readsAreCloser ? 'reads' : 'writes';
    const share = readsAreCloser ? closest.readRatio : closest.writeRatio;
    const used = readsAreCloser ? closest.used.reads : closest.used.writes;
    const cap = readsAreCloser ? closest.cap.reads : closest.cap.writes;
    lines.push(
      `closest: ${closest.name} ${side} ${(share * 100).toFixed(1)}% (${groupDigits(used)}/${groupDigits(cap)})`,
    );
  }
  const warnings = sorted.filter((row) => row.status === 'warn').map((row) => row.name);
  lines.push(warnings.length === 0 ? 'warnings: none' : `warnings: ${warnings.join(', ')}`);
  return lines.join('\n');
}

/**
 * Scenarios the headroom test fails on. A `warn` row is not in this list.
 *
 * @param {ReturnType<typeof buildHeadroomRow>[]} rows
 * @returns {ReturnType<typeof buildHeadroomRow>[]}
 */
export function headroomFailures(rows) {
  return rows.filter((row) => row.status === 'over' || row.status === 'idle' || row.status === 'missing');
}

/**
 * stderr lines for scenarios above 90%. Empty when nothing is that close.
 * The caller prints these with `console.warn` and does not throw.
 *
 * @param {ReturnType<typeof buildHeadroomRow>[]} rows
 * @returns {string[]}
 */
export function headroomWarnings(rows) {
  /** @type {string[]} */
  const lines = [];
  const sorted = rows.slice().sort((left, right) => left.name.localeCompare(right.name));
  for (const row of sorted) {
    if (row.status !== 'warn' || row.readRatio === null || row.writeRatio === null || !row.used) continue;
    const readsAreCloser = row.readRatio >= row.writeRatio;
    const side = readsAreCloser ? 'reads' : 'writes';
    const share = readsAreCloser ? row.readRatio : row.writeRatio;
    const used = readsAreCloser ? row.used.reads : row.used.writes;
    const cap = readsAreCloser ? row.cap.reads : row.cap.writes;
    lines.push(
      `KVS headroom warning: ${row.name} ${side} are ${(share * 100).toFixed(1)}% of the cap (${groupDigits(used)}/${groupDigits(cap)}), above 90%`,
    );
  }
  return lines;
}

/**
 * @param {{usage: () => {reads: number, writes: number}}} sdk
 * @param {string} name Key in {@link KVS_BUDGETS}.
 */
export function assertWithinBudget(sdk, name) {
  const limit = KVS_BUDGETS[name];
  if (!limit) {
    throw new Error(`no KVS budget registered for ${name}`);
  }
  const used = sdk.usage();
  // Record before the throw so the end-of-run table still shows a breach.
  noteScenarioUsage(name, used);
  if (process.env.SIM_BUDGET_DEBUG) {
    console.log(`[kvs] ${name} reads=${used.reads} writes=${used.writes}`);
  }
  if (used.reads <= 0 || used.writes <= 0) {
    throw new Error(
      `${name} did not touch KVS (reads ${used.reads}, writes ${used.writes})`,
    );
  }
  if (used.reads > limit.reads || used.writes > limit.writes) {
    throw new Error(
      `${name} exceeded the KVS budget: reads ${used.reads}/${limit.reads}, writes ${used.writes}/${limit.writes}`,
    );
  }
}
