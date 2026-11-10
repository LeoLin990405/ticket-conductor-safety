/**
 * Offline demo: the scripted naive agent against the mock Jira board.
 *
 *   npm run demo:offline
 *
 * `SAFETY_LIVE_LLM=1` does not call a model or a Jira site. The script says
 * so and still prints the deterministic comparison.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatNaiveComparison, runNaiveComparison } from '../src/safety/naiveAgent.js';
import { terminalSvg } from '../src/safety/terminalSvg.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const comparison = await runNaiveComparison();
const body = formatNaiveComparison(comparison);
const live = process.env.SAFETY_LIVE_LLM === '1'
  ? 'SAFETY_LIVE_LLM=1 is set. This demo does not call a live model or a live Jira site. The numbers below are the scripted agent.'
  : 'Live model: not requested. Set SAFETY_LIVE_LLM=1 only to print this note; the run stays scripted.';
const transcript = [
  'ticket-conductor offline demo',
  `node ${process.version}`,
  live,
  '',
  body,
  '',
].join('\n');
console.log(transcript);

mkdirSync(join(root, 'docs/media'), { recursive: true });
writeFileSync(join(root, 'docs/media/demo-offline.txt'), transcript);
writeFileSync(join(root, 'docs/media/demo-offline.svg'), terminalSvg('npm run demo:offline', [
  `node ${process.version}`,
  `baseline irreversible writes: ${comparison.baseline.irreversibleWrites}`,
  `guarded irreversible writes: ${comparison.guarded.irreversibleWrites}`,
  `guarded blocked: ${comparison.guarded.blocked} of ${comparison.attempts.length}`,
  'mock Jira only; no live site',
]));
