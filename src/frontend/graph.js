/**
 * Dependency-graph layout for the Run panel.
 *
 * UI Kit has no graph widget. The panel draws one row per planned step,
 * indented by how many dependency links sit above it, with a lozenge for
 * the step status. A step that waits on two others is drawn once, at the
 * deeper of those two branches, and the row names both indexes.
 *
 * The automatic `summarize` step is not part of the plan graph. It always
 * runs after the planned steps, and the panel says so separately.
 *
 * This file stays free of UI Kit so tests can import it.
 *
 * @module frontend/graph
 */

/**
 * @param {unknown} steps
 * @returns {Array<{stepId?: string, idx: number, title: string, workerType: string, status: string, dependsOn: number[], depth: number, wave: number}>}
 */
export function layoutDependencyGraph(steps) {
  const list = (Array.isArray(steps) ? steps : []).filter(
    (step) => step && step.workerType !== 'summarize',
  );
  const byIdx = new Map(list.map((step) => [step.idx, step]));
  /** @type {Map<number, number>} */
  const memo = new Map();

  /**
   * Longest chain of dependencies above this step. A cycle stops at 0 so a
   * bad stored plan cannot recurse forever; plan time already rejects cycles.
   *
   * @param {number} idx
   * @param {Set<number>} trail
   * @returns {number}
   */
  function depth(idx, trail) {
    if (memo.has(idx)) {
      return memo.get(idx);
    }
    if (trail.has(idx)) {
      return 0;
    }
    const step = byIdx.get(idx);
    const dependsOn = Array.isArray(step?.dependsOn) ? step.dependsOn : [];
    if (dependsOn.length === 0) {
      memo.set(idx, 0);
      return 0;
    }
    trail.add(idx);
    let value = 0;
    for (const dep of dependsOn) {
      if (byIdx.has(dep)) {
        value = Math.max(value, depth(dep, trail) + 1);
      }
    }
    trail.delete(idx);
    memo.set(idx, value);
    return value;
  }

  const nodes = list.map((step) => ({
    stepId: step.stepId,
    idx: step.idx,
    title: typeof step.title === 'string' ? step.title : '',
    workerType: typeof step.workerType === 'string' ? step.workerType : '',
    status: typeof step.status === 'string' ? step.status : '',
    dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : [],
    depth: depth(step.idx, new Set()),
    wave: Number.isInteger(step.wave) && step.wave > 0 ? step.wave : 1,
  }));
  nodes.sort((left, right) => left.depth - right.depth || left.idx - right.idx);
  return nodes;
}

/**
 * Visible indent. UI Kit text collapses leading spaces, so each level is a
 * middle dot rather than a padding prop.
 *
 * @param {number} depth
 * @returns {string}
 */
export function dependencyIndent(depth) {
  const level = Number.isInteger(depth) && depth > 0 ? depth : 0;
  return level === 0 ? '' : `${'· '.repeat(level)}`;
}
