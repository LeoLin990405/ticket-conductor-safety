import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// .mjs because the root package.json has no "type": "module", and WP9 owns
// that file. A .js test here makes Node warn and suggest editing it.
//
// WP7 has no Forge runtime. These checks lock the demo seed and the
// spoken script, and they lock the prompt to the spike contracts:
// planSplit takes stepsJson as a string (action inputs cannot be arrays),
// the playbook is a rovo:skill the prompt does not name, and the video
// narration stays inside 450 words (3:00 at 150 wpm).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ACTION_KEYS = [
  'plan-split',
  'dispatch-run',
  'get-run-status',
  'recall-memory',
  'record-decision',
  'replay-run',
  'fork-run',
];

const PLAN_WORKER_TYPES = ['research', 'draft-spec', 'check-deps'];

const SCENARIO_FILES = [
  '01-happy-path.md',
  '02-stuck-step-watchdog.md',
  '03-duplicate-request.md',
  '04-memory-recall.md',
  '05-invalid-plan.md',
  '06-adversarial-tries.md',
  '07-other-agent-handoff.md',
];

// Names a judge or a later package has to see spelled the same way as
// TASKS.md and the WP0 spike. stepsJson is the string form of the plan.
const SCENARIO_TOKENS = [
  'plan-split',
  'planSplit',
  'dispatch-run',
  'dispatchRun',
  'get-run-status',
  'getRunStatus',
  'recall-memory',
  'recallMemory',
  'record-decision',
  'recordDecision',
  'stepsJson',
  'workerType',
  'memType',
  'by-status-created',
  'by-status-deadline',
  'createdAt',
  'deadlineAt',
  'requestKey',
  'childIssueKey',
  'CONDUCTOR_DEMO_STUCK_STEP',
  'timeoutSeconds',
  'step-queue',
  'effect-queue',
  'idem:dispatch:',
];

const STARTERS = [
  'Plan and run this Epic',
  'Show the status of this run',
  'What did we decide last time?',
  'Remember this decision for the project',
];

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function wordCount(text) {
  // 150 wpm counts whitespace-separated tokens. Hyphenated action names
  // such as plan-split count as one word, which matches a spoken read.
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function narrationOf(markdown) {
  const startMark = '<!-- narration:start -->';
  const endMark = '<!-- narration:end -->';
  const start = markdown.indexOf(startMark);
  const end = markdown.indexOf(endMark);
  assert.ok(start !== -1 && end > start, 'narration markers missing');
  return markdown.slice(start + startMark.length, end);
}

function bulletsUnderHeading(markdown, heading) {
  const start = markdown.indexOf(heading);
  assert.ok(start !== -1, `missing heading ${heading}`);
  const items = [];
  for (const line of markdown.slice(start + heading.length).split('\n')) {
    if (line.startsWith('## ')) break;
    const match = line.match(/^- (.+)$/);
    if (match) items.push(match[1].trim());
  }
  return items;
}

function yamlList(text, key) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  assert.ok(start !== -1, `missing YAML key ${key}`);
  const items = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^\s+- (.+)$/);
    if (!match) break;
    items.push(match[1].trim());
  }
  return items;
}

function skillParts(text) {
  assert.ok(text.startsWith('---\n'), 'SKILL.md needs frontmatter');
  const end = text.indexOf('\n---\n', 4);
  assert.ok(end > 0, 'SKILL.md frontmatter is not closed');
  const front = text.slice(4, end);
  const body = text.slice(end + '\n---\n'.length);
  const name = front.match(/^name: (\S+)$/m);
  const description = front.match(/^description: (.+)$/m);
  const allowed = front.match(/^allowed-tools: (.+)$/m);
  assert.ok(name && description && allowed, 'skill frontmatter is incomplete');
  return {
    name: name[1],
    description: description[1].trim(),
    allowedTools: allowed[1].trim().split(/\s+/),
    body,
  };
}

test('demo/seed.json parses and describes the Payments demo', () => {
  const raw = read('demo/seed.json');
  assert.doesNotMatch(raw, /ATATT|AKIA|BEGIN PRIVATE KEY/);
  const seed = JSON.parse(raw);

  assert.equal(seed.site, 'your-site.atlassian.net');
  assert.equal(seed.product, 'jira');
  assert.equal(seed.environment, 'development');
  assert.equal(seed.project.key, 'PAY');
  assert.equal(seed.project.name, 'Payments');

  const refs = seed.issues.map((issue) => issue.ref);
  assert.equal(new Set(refs).size, refs.length);
  assert.deepEqual(new Set(seed.createOrder), new Set(refs));
  assert.equal(seed.createOrder.length, refs.length);

  const byRef = new Map(seed.issues.map((issue) => [issue.ref, issue]));
  const summaries = new Set();
  for (const issue of seed.issues) {
    assert.equal(typeof issue.summary, 'string');
    assert.ok(issue.summary.length > 0);
    assert.ok(!summaries.has(issue.summary), `duplicate summary ${issue.summary}`);
    summaries.add(issue.summary);
    assert.ok(issue.labels.includes('conductor-demo'));
    for (const label of issue.labels) {
      assert.ok(seed.labels.includes(label), `label ${label} is not in the catalog`);
    }
    assert.equal(typeof issue.description, 'string');
    assert.ok(issue.description.length > 0);
    if (issue.issueType === 'Epic') {
      assert.equal(issue.epicRef, undefined);
    } else {
      assert.equal(byRef.get(issue.epicRef).issueType, 'Epic');
    }
  }

  const epics = seed.issues.filter((issue) => issue.issueType === 'Epic');
  assert.ok(epics.length >= 2);
  const primary = byRef.get(seed.demo.primaryEpicRef);
  const related = byRef.get(seed.demo.relatedEpicRef);
  assert.equal(primary.summary, 'Ship payment refunds');
  assert.equal(primary.issueType, 'Epic');
  assert.equal(related.issueType, 'Epic');
  assert.notEqual(related.summary, primary.summary);

  for (const link of seed.issueLinks) {
    assert.ok(byRef.has(link.fromRef));
    assert.ok(byRef.has(link.toRef));
    assert.equal(link.type, 'Relates');
  }

  assert.equal(seed.demo.stuckStepVariable, 'CONDUCTOR_DEMO_STUCK_STEP');
  assert.ok(seed.demo.primaryGoal.includes('payment id'));
  assert.ok(seed.demo.relatedGoal.includes('ledger'));

  const steps = seed.demo.planSteps;
  assert.ok(steps.length >= 3 && steps.length <= 8);
  for (const step of steps) {
    assert.equal(typeof step.title, 'string');
    assert.ok(step.title.length > 0);
    assert.ok(PLAN_WORKER_TYPES.includes(step.workerType), step.workerType);
    assert.equal(typeof step.input, 'string');
    assert.ok(step.input.length > 0);
  }
  // The value plan-split accepts is this string, not the array itself.
  const stepsJson = JSON.stringify(steps);
  assert.equal(typeof stepsJson, 'string');
  assert.equal(JSON.parse(stepsJson).length, steps.length);

  const memory = seed.expectedWriteBack;
  assert.equal(memory.header, '[Conductor memory]');
  assert.ok(['decision', 'lesson', 'fact'].includes(memory.memType));
  assert.equal(memory.memType, 'decision');
  assert.equal(memory.scope, 'project');
  assert.equal(memory.validUntil, 0);
  assert.match(memory.text, /payment id/);

  const guide = read('demo/seed.md');
  assert.match(guide, /your-site\.atlassian\.net/);
  assert.match(guide, /Do not commit/);
  for (const issue of seed.issues) {
    assert.ok(guide.includes(issue.summary), `seed.md is missing ${issue.summary}`);
  }
});

test('router prompt stays inside the allowlisted actions and does not name the skill', () => {
  const prompt = read('prompts/router.md');
  for (const key of ACTION_KEYS) {
    assert.ok(prompt.includes(key), key);
  }
  assert.match(prompt, /stepsJson/);
  assert.match(prompt, /memType/);
  assert.match(prompt, /confirm/);
  // The agent discovers the skill from SKILL.md's description. Naming the
  // skill in the always-on prompt is explicit invocation, which Preview rejects.
  assert.equal(prompt.includes('conductor-playbook'), false);
  assert.deepEqual(bulletsUnderHeading(prompt, '## Conversation starters'), STARTERS);
});

test('conductor-playbook skill is discoverable and passes stepsJson as a string', () => {
  const skillPath = 'prompts/conductor-playbook/SKILL.md';
  const skill = skillParts(read(skillPath));
  assert.equal(skill.name, 'conductor-playbook');
  assert.equal(skill.name, path.basename(path.dirname(skillPath)));
  assert.ok(skill.description.length >= 50, `description is ${skill.description.length} chars`);
  assert.ok(skill.description.length <= 1024);
  assert.match(skill.description, /stepsJson/);
  assert.deepEqual(skill.allowedTools, ACTION_KEYS);
  const lines = skill.body.split('\n');
  assert.ok(lines.length <= 500, `skill body is ${lines.length} lines`);
  assert.match(skill.body, /stepsJson/);
  assert.match(skill.body, /string/);
  assert.equal(skill.body.includes('invoke conductor-playbook'), false);

  const manifest = read('prompts/router.manifest.yml');
  assert.deepEqual(yamlList(manifest, 'conversationStarters'), STARTERS);
  // The router's action list is the first `actions:` block. The handoff
  // agent lists four tools later in the file, so this helper must be
  // pointed at the router block only.
  const routerBlock = manifest.slice(
    manifest.indexOf('key: conductor-router'),
    manifest.indexOf('key: conductor-handoff'),
  );
  assert.deepEqual(yamlList(routerBlock, 'actions'), ACTION_KEYS);
  const playbookBlock = manifest.slice(
    manifest.indexOf('key: conductor-playbook'),
    manifest.indexOf('key: conductor-tools'),
  );
  assert.deepEqual(yamlList(playbookBlock, 'tools'), ACTION_KEYS);
  assert.match(manifest, /key: conductor-router/);
  assert.match(manifest, /dir: prompts\/conductor-playbook/);
  assert.match(manifest, /dir: prompts\/conductor-tools/);
  assert.match(manifest, /key: conductor-handoff/);
  assert.match(manifest, /^ {2}rovo:mcp:/m);
  assert.match(manifest, /key: conductor-mcp/);
  assert.match(manifest, /stepsJson/);
  // Still excluded. A connector makes the app user unmentionable, and
  // llm / sql are out of the MVP.
  assert.doesNotMatch(manifest, /^ {2}rovo:agentConnector:/m);
  assert.doesNotMatch(manifest, /^ {2}sql:/m);
  assert.doesNotMatch(manifest, /^ {2}llm:/m);
});

test('scenarios use the real action and field names', () => {
  const combined = SCENARIO_FILES.map((file) => read(`tests/scenarios/${file}`)).join('\n');
  for (const token of SCENARIO_TOKENS) {
    assert.ok(combined.includes(token), `scenarios are missing ${token}`);
  }
  const adversarial = read('tests/scenarios/06-adversarial-tries.md');
  assert.match(adversarial, /Not yet executed live/);
  const tries = adversarial.match(/^## Try \d+\b/gm);
  assert.equal(tries.length, 5);
});

test('video narration is at most 450 words', () => {
  const spoken = narrationOf(read('docs/VIDEO.md'));
  const count = wordCount(spoken);
  assert.ok(count >= 300, `narration is only ${count} words`);
  assert.ok(count <= 450, `narration is ${count} words, max 450`);
});

test('owned scenario directory lists the written cases', () => {
  const files = readdirSync(path.join(root, 'tests/scenarios'));
  for (const file of SCENARIO_FILES) {
    assert.ok(files.includes(file), file);
  }
  assert.ok(files.includes('wp7.test.mjs'));
});
