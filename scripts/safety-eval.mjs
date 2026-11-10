/**
 * Print the irreversible-action table and exit 1 when a row fails.
 *
 *   npm run safety-eval
 */
import { formatSafetyReport, runSafetyEval } from '../src/safety/eval.js';

const rows = await runSafetyEval();
console.log(formatSafetyReport(rows));
if (rows.some((row) => row.result !== 'PASS')) {
  process.exitCode = 1;
}
