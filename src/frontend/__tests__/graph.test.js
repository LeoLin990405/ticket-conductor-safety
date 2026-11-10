import assert from 'node:assert/strict';
import test from 'node:test';

import { dependencyIndent, layoutDependencyGraph } from '../graph.js';
import { lozengeAppearance } from '../status.js';

test('layout indents a chain and a diamond, and skips summarize', () => {
  const nodes = layoutDependencyGraph([
    { stepId: 'a', idx: 0, title: 'Research A', workerType: 'research', status: 'done', dependsOn: [] },
    { stepId: 'b', idx: 1, title: 'Research B', workerType: 'research', status: 'running', dependsOn: [] },
    { stepId: 'c', idx: 2, title: 'Draft', workerType: 'draft-spec', status: 'waiting', dependsOn: [0, 1] },
    { stepId: 'd', idx: 3, title: 'Check', workerType: 'check-deps', status: 'waiting', dependsOn: [2] },
    { stepId: 's', idx: 4, title: 'Summarize', workerType: 'summarize', status: 'queued', dependsOn: [] },
  ]);

  assert.deepEqual(nodes.map((node) => [node.idx, node.depth, node.status]), [
    [0, 0, 'done'],
    [1, 0, 'running'],
    [2, 1, 'waiting'],
    [3, 2, 'waiting'],
  ]);
  assert.equal(dependencyIndent(0), '');
  assert.equal(dependencyIndent(2), '· · ');
  assert.equal(lozengeAppearance('waiting'), 'new');
});
