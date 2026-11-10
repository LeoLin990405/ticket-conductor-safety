import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ACTION_DESCRIPTION_MAX,
  REUSABLE_TOOL_KEYS,
  TOOL_DESCRIPTIONS,
} from '../actions/contract.js';
import { appIdFromManifest, mcpEndpoint, plannedToolCalls } from '../../demo/mcp-client.mjs';

const root = new URL('../../', import.meta.url);

function read(path) {
  return readFileSync(new URL(path, root), 'utf8');
}

test('reusable action descriptions fit the CLI cap and are copied into the manifest', () => {
  const manifest = read('manifest.yml');
  const snippet = read('src/actions/actions.manifest.yml');
  for (const key of REUSABLE_TOOL_KEYS) {
    const description = TOOL_DESCRIPTIONS[key];
    assert.ok(description, key);
    assert.ok(description.length <= ACTION_DESCRIPTION_MAX, `${key} is ${description.length}`);
    assert.ok(description.length >= 50, key);
    assert.ok(manifest.includes(description), `${key} missing from manifest.yml`);
    assert.ok(snippet.includes(description), `${key} missing from the action snippet`);
  }
  assert.equal(manifest.includes('rovo:mcp:'), true);
  assert.equal(manifest.match(/key: conductor-mcp/g).length, 1);
  assert.ok(manifest.includes('ari:cloud:ecosystem::app/00000000-0000-4000-8000-0000000000a1'));
  for (const key of REUSABLE_TOOL_KEYS) {
    assert.ok(manifest.includes(`- ${key}`));
  }
  assert.match(manifest, /key: conductor-handoff/);
  assert.match(manifest, /key: conductor-tools/);
  assert.doesNotMatch(manifest, /type: array/);
});

test('conductor-tools SKILL.md matches the Forge skill file rules', () => {
  const skill = read('prompts/conductor-tools/SKILL.md');
  assert.ok(skill.startsWith('---\n'));
  const end = skill.indexOf('\n---\n', 4);
  assert.ok(end > 0);
  const frontmatter = skill.slice(4, end);
  const body = skill.slice(end + 5);
  const name = frontmatter.match(/^name: (.+)$/m)[1];
  const description = frontmatter.match(/^description: (.+)$/m)[1];
  assert.equal(name, 'conductor-tools');
  assert.ok(description.length >= 50 && description.length <= 1024);
  const allowed = frontmatter.match(/^allowed-tools: (.+)$/m)[1].split(' ');
  for (const key of REUSABLE_TOOL_KEYS) {
    assert.ok(allowed.includes(key), key);
    assert.match(body, new RegExp(`\\b${key}\\b`));
  }
  assert.ok(!allowed.includes('record-decision'));
  assert.ok(body.split('\n').length <= 500);
  assert.ok(read('prompts/conductor-tools/references/io.md').includes('"ok": true'));
});

test('the handoff prompt does not tell the agent to invoke the skill by name', () => {
  const prompt = read('prompts/handoff.md');
  assert.doesNotMatch(prompt, /invoke the skill|call the skill|conductor-tools/);
  assert.match(prompt, /stepsJson/);
  assert.match(prompt, /do not write to Jira/i);
});

test('the printed MCP calls use the action keys and the app id from the manifest', () => {
  const manifest = read('manifest.yml');
  const appId = appIdFromManifest(manifest);
  assert.equal(appId, '00000000-0000-4000-8000-0000000000a1');
  assert.equal(
    mcpEndpoint(appId),
    'https://mcp.atlassian.com/forge/00000000-0000-4000-8000-0000000000a1',
  );
  const calls = plannedToolCalls({
    epicKey: 'PAY-1',
    projectKey: 'PAY',
    goal: 'Ship refunds',
    stepsJson: '[]',
  });
  assert.deepEqual(calls.map((call) => call.name), [
    'recall-memory',
    'plan-split',
    'dispatch-run',
    'get-run-status',
  ]);
  assert.equal(calls[2].arguments.runId, '{{plan-split.runId}}');
  const cursor = read('demo/cursor-mcp.json');
  assert.ok(cursor.includes(mcpEndpoint(appId)));
  assert.doesNotMatch(cursor, /token|secret|api[_-]?key/i);
});
