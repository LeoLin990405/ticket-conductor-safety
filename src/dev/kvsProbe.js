/**
 * Dev-only experiment: which Forge KVS conditional writes are accepted.
 * Writes scratch rows under `kvs-probe-*` keys and deletes them afterwards.
 */
export async function runKvsProbe() {
  const { kvs, Filter, FilterConditions } = await import('@forge/kvs');
  const tag = `kvs-probe-${Date.now()}`;
  const now = Date.now();
  const baseRun = {
    epicKey: 'PROBE-1', projectKey: 'PROBE', goal: 'kvs probe', status: 'planning',
    createdBy: 'probe', createdAt: now, updatedAt: now,
  };
  const baseStep = {
    runId: tag, idx: 0, title: 'probe', workerType: 'research', status: 'queued',
    attempt: 0, createdAt: now,
  };
  const results = {};
  async function attempt(name, fn) {
    try {
      await fn();
      results[name] = 'ok';
    } catch (error) {
      results[name] = `${error?.name ?? 'Error'} ${error?.code ?? ''} ${String(error?.message ?? error).slice(0, 160)}`.trim();
    }
  }
  const cond = (entityName, key, value, field, expected) =>
    kvs.transact().set(key, value, {
      entityName,
      conditions: new Filter().and(field, FilterConditions.equalTo(expected)),
    }).execute();

  const runKey = `${tag}-run`;
  const stepKey = `${tag}-step`;
  await attempt('plainSetRun', () => kvs.entity('run').set(runKey, baseRun));
  await attempt('plainSetStep', () => kvs.entity('step').set(stepKey, baseStep));
  await attempt('condString_status', () => cond('run', runKey, { ...baseRun, goal: 'a' }, 'status', 'planning'));
  await attempt('condFloatInt_updatedAt', () => cond('run', runKey, { ...baseRun, goal: 'b' }, 'updatedAt', now));
  const frac = now + 0.5;
  await attempt('plainSetFractionalFloat', () => kvs.entity('run').set(runKey, { ...baseRun, updatedAt: frac }));
  await attempt('condFloatFractional_updatedAt', () => cond('run', runKey, { ...baseRun, updatedAt: frac, goal: 'c' }, 'updatedAt', frac));
  await attempt('condInteger_attempt', () => cond('step', stepKey, { ...baseStep, title: 'd' }, 'attempt', 0));
  await attempt('plainSetBoolean_summarizeQueued', () => kvs.entity('run').set(runKey, { ...baseRun, summarizeQueued: true }));
  await attempt('condFloat_withBooleanValue', () => cond('run', runKey, { ...baseRun, summarizeQueued: true, goal: 'e' }, 'updatedAt', now));
  // WP14 attributes: a 422 here right after a deploy means the schema has not propagated yet.
  await attempt('plainSetRun_wp14', () => kvs.entity('run').set(runKey, { ...baseRun, reviewedThroughWave: 0, ledger: { digests: [] } }));
  // Novelty #6. A 422 here right after a deploy means `budget` has not propagated yet.
  await attempt('plainSetRun_budget', () => kvs.entity('run').set(runKey, {
    ...baseRun,
    reviewedThroughWave: 0,
    budget: {
      maxSteps: 8,
      maxModelCalls: 28,
      wallClockMs: 5760000,
      usedSteps: 0,
      usedModelCalls: 0,
      usedTokens: 0,
      elapsedMs: 0,
      startedAt: now,
    },
  }));
  await attempt('condInteger_reviewedThroughWave', () => cond('run', runKey, { ...baseRun, reviewedThroughWave: 1, ledger: { digests: [] } }, 'reviewedThroughWave', 0));
  await attempt('plainSetStep_wave', () => kvs.entity('step').set(stepKey, { ...baseStep, wave: 1 }));
  await attempt('condMismatch_status', () => cond('run', runKey, { ...baseRun, goal: 'f' }, 'status', 'nope'));
  const final = await kvs.entity('run').get(runKey).catch(() => null);
  await kvs.entity('run').delete(runKey).catch(() => {});
  await kvs.entity('step').delete(stepKey).catch(() => {});
  return { results, finalRun: final };
}
