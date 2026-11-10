/**
 * Run panel for an Epic (WP8).
 *
 * UI Kit only: every visual element comes from `@forge/react`. The panel reads
 * the store through the resolver. Writes are Retry on a failed or blocked
 * step, the lesson operations on the Lessons tab, and Replay / Fork on the
 * Run tab. Replay is read-only. Fork creates a new run and does not rewrite
 * the copied prefix.
 */

import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Button,
  ButtonGroup,
  CodeBlock,
  DynamicTable,
  EmptyState,
  Heading,
  Inline,
  Lozenge,
  Range,
  SectionMessage,
  Spinner,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textfield,
} from '@forge/react';
import { invoke, router, view } from '@forge/bridge';

import { scrubTo } from '../recorder/timeline.js';
import { dependencyIndent, layoutDependencyGraph } from './graph.js';
import { canRetry, chaosSummary, effectMetricsSummary, eventAppearance, hasChaosActivity, hasEffectMetrics, isRunning, lozengeAppearance, subAgentLines } from './status.js';

/**
 * @param {string} issueKey
 */
function openIssue(issueKey) {
  router.navigate(`/browse/${issueKey}`);
}

/**
 * @param {{status?: string}} props
 */
function StatusLozenge({ status }) {
  return <Lozenge appearance={lozengeAppearance(status)}>{status || 'unknown'}</Lozenge>;
}

/**
 * UI Kit Textfield hands the value either as a string or as an event.
 *
 * @param {unknown} event
 * @returns {string}
 */
function readControlValue(event) {
  if (typeof event === 'string') {
    return event;
  }
  if (typeof event === 'number') {
    return String(event);
  }
  const value = event?.target?.value;
  return value === undefined || value === null ? '' : String(value);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function readRange(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(readControlValue(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @param {string|undefined} status
 * @returns {'default'|'inprogress'|'moved'|'new'|'removed'|'success'}
 */
function lessonAppearance(status) {
  if (status === 'accepted') {
    return 'success';
  }
  if (status === 'rejected' || status === 'expired') {
    return 'removed';
  }
  if (status === 'proposed') {
    return 'inprogress';
  }
  return 'default';
}

/**
 * Blast-radius card. The resolver sends plain strings (`panelModel`).
 * UI Kit has no Table component, so the rows go through DynamicTable and
 * every cell is a Text node, the same way StepTable wraps its cells.
 *
 * Shown above the plan card while the run is planning and after dispatch.
 * The resolver recomputes it. This component does not call Jira.
 *
 * @param {{blast?: {title?: string, appearance?: string, summary?: string, gateNote?: string, head?: object, rows?: object[]}}} props
 */
function BlastRadius({ blast }) {
  if (!blast) {
    return null;
  }
  const rows = (blast.rows || []).map((row) => ({
    key: row.key,
    cells: (row.cells || []).map((cell) => ({
      key: cell.key,
      content: <Text>{cell.content}</Text>,
    })),
  }));
  return (
    <Stack space="space.100">
      <SectionMessage appearance={blast.appearance || 'information'} title={blast.title || 'Blast radius'}>
        <Text>{blast.summary}</Text>
        {blast.gateNote ? <Text>{blast.gateNote}</Text> : null}
      </SectionMessage>
      <DynamicTable head={blast.head} rows={rows} />
    </Stack>
  );
}

/**
 * Recall tab: the memories and lessons this plan named, with the citation.
 *
 * @param {{applied: object[], planCard?: string, usedMemory?: string[], usedLessons?: string[]}} props
 */
function RecallView({ applied, planCard, usedMemory, usedLessons }) {
  const rows = applied || [];
  return (
    <Stack space="space.150">
      <Heading size="xsmall">Recall</Heading>
      {planCard ? (
        <SectionMessage appearance="information" title="This plan cites what it used">
          <Text>{planCard}</Text>
        </SectionMessage>
      ) : (
        <Text>This plan did not apply any memories.</Text>
      )}
      {(usedLessons || []).length > 0 ? (
        <Text>{`Lessons used: ${usedLessons.join(', ')}`}</Text>
      ) : null}
      {(usedMemory || []).length > 0 ? (
        <Text>{`Memories used: ${usedMemory.join(', ')}`}</Text>
      ) : null}
      {rows.map((item) => (
        <Text key={`${item.kind || 'memory'}-${item.lessonId || item.memId}`}>
          {item.citation || item.how}
        </Text>
      ))}
    </Stack>
  );
}

/**
 * Lessons tab. Accept and reject are human curation. Upvote and downvote
 * keep a count. Edit writes a new version. Rejected lessons stay listed and
 * are not applied to the next plan.
 *
 * @param {{
 *   lessons: object[],
 *   projectKey: string,
 *   epicKey: string,
 *   onOp: (payload: object) => Promise<void>,
 *   busy: string
 * }} props
 */
function LessonsView({ lessons, projectKey, epicKey, onOp, busy }) {
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editText, setEditText] = useState('');
  const rows = lessons || [];

  return (
    <Stack space="space.200">
      <Heading size="xsmall">Lessons</Heading>
      <Text>
        Failure lessons start as proposed. Accept one to let the next plan use it. Reject keeps it on record and out of the plan.
      </Text>
      <Textfield
        appearance="standard"
        placeholder="Add a project lesson"
        value={draft}
        onChange={(event) => setDraft(readControlValue(event))}
      />
      <ButtonGroup>
        <Button
          appearance="primary"
          isDisabled={busy === 'add' || draft.trim().length === 0}
          onClick={async () => {
            const result = await onOp({
              op: 'add',
              text: draft.trim(),
              scope: 'project',
              projectKey,
              epicKey,
            });
            if (result && result.ok !== false) {
              setDraft('');
            }
          }}
        >
          Add lesson
        </Button>
        <Button
          isDisabled={busy === 'add' || draft.trim().length === 0}
          onClick={async () => {
            const result = await onOp({
              op: 'add',
              text: draft.trim(),
              scope: 'global',
            });
            if (result && result.ok !== false) {
              setDraft('');
            }
          }}
        >
          Add global lesson
        </Button>
      </ButtonGroup>
      {rows.length === 0 ? <Text>No lessons yet. A failed or blocked step records one here.</Text> : null}
      {rows.map((lesson) => {
        const key = lesson.lessonId;
        const window = lesson.validTo
          ? `valid ${lesson.validFrom}–${lesson.validTo}`
          : `valid from ${lesson.validFrom}`;
        return (
          <Stack key={key} space="space.050">
            <Lozenge appearance={lessonAppearance(lesson.status)}>{lesson.status}</Lozenge>
            <Text>{lesson.summary}</Text>
            <Text>
              {`${lesson.lessonId} · votes ${lesson.votes} · confidence ${Number(lesson.confidence).toFixed(2)} · scope ${lesson.scope} · ${window}`}
            </Text>
            <ButtonGroup>
              <Button
                appearance="primary"
                isDisabled={busy === key || lesson.status === 'accepted'}
                onClick={() => onOp({ op: 'accept', lessonId: key, projectKey: lesson.projectKey || projectKey })}
              >
                Accept
              </Button>
              <Button
                appearance="danger"
                isDisabled={busy === key || lesson.status === 'rejected'}
                onClick={() => onOp({ op: 'reject', lessonId: key, projectKey: lesson.projectKey || projectKey })}
              >
                Reject
              </Button>
              <Button
                isDisabled={busy === key}
                onClick={() => onOp({ op: 'upvote', lessonId: key, projectKey: lesson.projectKey || projectKey })}
              >
                Upvote
              </Button>
              <Button
                isDisabled={busy === key}
                onClick={() => onOp({ op: 'downvote', lessonId: key, projectKey: lesson.projectKey || projectKey })}
              >
                Downvote
              </Button>
              <Button
                appearance="subtle"
                isDisabled={busy === key}
                onClick={() => {
                  setEditingId(key);
                  setEditText(lesson.summary);
                }}
              >
                Edit
              </Button>
            </ButtonGroup>
            {editingId === key ? (
              <Stack space="space.050">
                <Textfield
                  appearance="standard"
                  value={editText}
                  onChange={(event) => setEditText(readControlValue(event))}
                />
                <Button
                  appearance="primary"
                  isDisabled={busy === key || editText.trim().length === 0}
                  onClick={() => onOp({
                    op: 'edit',
                    lessonId: key,
                    projectKey: lesson.projectKey || projectKey,
                    text: editText.trim(),
                  })}
                >
                  Save edit
                </Button>
              </Stack>
            ) : null}
          </Stack>
        );
      })}
    </Stack>
  );
}

/**
 * @param {{run: any, onRetry: (stepId: string) => void, retrying: string}} props
 */
function StepTable({ run, onRetry, retrying }) {
  const rows = (run.steps || []).map((step) => ({
    key: step.stepId,
    cells: [
      { key: 'idx', content: <Text>{step.idx}</Text> },
      { key: 'title', content: <Text>{step.title}</Text> },
      { key: 'type', content: <Text>{step.workerType}</Text> },
      { key: 'status', content: <StatusLozenge status={step.status} /> },
      { key: 'attempt', content: <Text>{step.attempt}</Text> },
      {
        key: 'issue',
        content: step.childIssueKey
          ? (
            <Button appearance="subtle" onClick={() => openIssue(step.childIssueKey)}>
              {step.childIssueKey}
            </Button>
          )
          : <Text>Pending</Text>,
      },
      {
        key: 'retry',
        content: canRetry(step.status)
          ? (
            <Button
              appearance="warning"
              isDisabled={retrying === step.stepId}
              onClick={() => onRetry(step.stepId)}
            >
              {retrying === step.stepId ? 'Retrying' : 'Retry step'}
            </Button>
          )
          : <Text></Text>,
      },
    ],
  }));

  return (
    <DynamicTable
      head={{
        cells: [
          { key: 'idx', content: 'Idx' },
          { key: 'title', content: 'Title' },
          { key: 'type', content: 'Worker' },
          { key: 'status', content: 'Status' },
          { key: 'attempt', content: 'Attempt' },
          { key: 'issue', content: 'Child issue' },
          { key: 'retry', content: 'Retry' },
        ],
      }}
      rows={rows}
    />
  );
}

/**
 * Indented plan. Each row is one step. The lozenge is that step's status.
 * "after 0, 1" means the step stays `waiting` until those indexes are done.
 *
 * @param {{steps?: Array<object>}} props
 */
function DependencyGraph({ steps }) {
  const nodes = layoutDependencyGraph(steps);
  const hasSummarize = (steps || []).some((step) => step.workerType === 'summarize');
  if (nodes.length === 0) {
    return null;
  }
  return (
    <Stack space="space.100">
      <Heading size="xsmall">Dependency graph</Heading>
      {nodes.map((node) => (
        <Inline key={node.stepId || String(node.idx)} space="space.100" alignBlock="center">
          <Text>{`${dependencyIndent(node.depth)}wave ${node.wave} · ${node.idx}. ${node.title}`}</Text>
          <StatusLozenge status={node.status} />
          <Text>
            {node.dependsOn.length > 0
              ? `after ${node.dependsOn.join(', ')}`
              : 'starts with the run'}
          </Text>
        </Inline>
      ))}
      {hasSummarize ? <Text>Summarize runs after every planned step.</Text> : null}
    </Stack>
  );
}

/**
 * Scrubbable flight recorder. Sits beside the dependency graph on the Run tab.
 *
 * @param {{timeline: object[], cursor: number, onScrub: (value: number) => void}} props
 */
function FlightRecorder({ timeline, cursor, onScrub }) {
  if (!timeline.length) {
    return (
      <Stack space="space.100">
        <Heading size="xsmall">Flight recorder</Heading>
        <Text>No events yet. They appear after plan-split.</Text>
      </Stack>
    );
  }
  const max = timeline.length - 1;
  const safeCursor = Math.max(0, Math.min(max, cursor));
  const visible = scrubTo(timeline, safeCursor);
  const frame = timeline[safeCursor];
  const rows = visible.map((event) => ({
    key: event.eventId,
    cells: [
      { key: 'seq', content: <Text>{event.seq}</Text> },
      {
        key: 'kind',
        content: <Lozenge appearance={eventAppearance(event.kind)}>{event.label}</Lozenge>,
      },
      { key: 'step', content: <Text>{event.stepIdx === undefined ? '' : event.stepIdx}</Text> },
      { key: 'duration', content: <Text>{event.durationLabel}</Text> },
      {
        key: 'markers',
        content: (event.markers || []).length === 0
          ? <Text></Text>
          : (
            <Inline space="space.050">
              {event.markers.map((marker) => (
                <Lozenge key={marker} appearance={eventAppearance(marker)}>{marker}</Lozenge>
              ))}
            </Inline>
          ),
      },
    ],
  }));
  return (
    <Stack space="space.100">
      <Heading size="xsmall">Flight recorder</Heading>
      <Text>
        {`${frame.label}${frame.title ? ` · ${frame.title}` : ''} · ${frame.durationLabel}`}
      </Text>
      <Range
        value={safeCursor}
        min={0}
        max={max}
        step={1}
        onChange={(value) => onScrub(readRange(value))}
      />
      <DynamicTable
        head={{
          cells: [
            { key: 'seq', content: 'Seq' },
            { key: 'kind', content: 'Event' },
            { key: 'step', content: 'Step' },
            { key: 'duration', content: 'Duration' },
            { key: 'markers', content: 'Markers' },
          ],
        }}
        rows={rows}
      />
    </Stack>
  );
}

function App() {
  const [issueKey, setIssueKey] = useState('');
  const [runs, setRuns] = useState([]);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState('');
  const [lessonBusy, setLessonBusy] = useState('');
  const [cursor, setCursor] = useState(0);
  const [replay, setReplay] = useState(null);
  const [replaying, setReplaying] = useState(false);
  const [forkIdx, setForkIdx] = useState('0');
  const [forkInput, setForkInput] = useState('');
  const [forking, setForking] = useState(false);
  const [trace, setTrace] = useState('');
  const [approving, setApproving] = useState(false);

  const load = useCallback(async (key, preferRunId) => {
    const listed = await invoke('getRunsForIssue', { issueKey: key });
    const nextRuns = listed?.runs || [];
    setRuns(nextRuns);
    if (nextRuns.length === 0) {
      setDetail(null);
      setCursor(0);
      return null;
    }
    const wanted = preferRunId
      ? nextRuns.find((item) => item.runId === preferRunId) || nextRuns[0]
      : nextRuns[0];
    const full = await invoke('getRun', { runId: wanted.runId });
    setDetail(full);
    const length = full?.timeline?.length || 0;
    setCursor(length > 0 ? length - 1 : 0);
    return full?.run?.status;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    async function start() {
      try {
        const context = await view.getContext();
        const key = context?.extension?.issue?.key || '';
        if (cancelled) {
          return;
        }
        setIssueKey(key);
        const status = await load(key);
        if (cancelled) {
          return;
        }
        if (isRunning(status)) {
          timer = setInterval(() => {
            load(key).catch((loadError) => {
              setError(loadError instanceof Error ? loadError.message : String(loadError));
            });
          }, 5000);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    start();
    return () => {
      cancelled = true;
      if (timer) {
        clearInterval(timer);
      }
    };
  }, [load]);

  async function refresh() {
    setError('');
    setLoading(true);
    try {
      await load(issueKey, detail?.run?.runId);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function operateLesson(payload) {
    setLessonBusy(payload.lessonId || payload.op || 'add');
    setError('');
    try {
      const result = await invoke('lessonOp', payload);
      if (result && result.ok === false) {
        setError(result.error || 'Lesson update failed');
      }
      await load(issueKey);
      return result;
    } catch (opError) {
      setError(opError instanceof Error ? opError.message : String(opError));
      return { ok: false };
    } finally {
      setLessonBusy('');
    }
  }

  async function retry(stepId) {
    setRetrying(stepId);
    setError('');
    try {
      const result = await invoke('retryStep', { stepId });
      if (result && result.ok === false) {
        setError(result.error || 'Retry failed');
      }
      await load(issueKey, detail?.run?.runId);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : String(retryError));
    } finally {
      setRetrying('');
    }
  }

  async function onApprove() {
    const runId = detail?.run?.runId;
    if (!runId) {
      return;
    }
    setApproving(true);
    setError('');
    try {
      const result = await invoke('approveRun', { runId });
      if (result && result.ok === false) {
        setError(result.error || 'Approval did not start the run');
      }
      await load(issueKey, runId);
    } catch (approveError) {
      setError(approveError instanceof Error ? approveError.message : String(approveError));
    } finally {
      setApproving(false);
    }
  }

  async function onReplay() {
    const runId = detail?.run?.runId;
    if (!runId) {
      return;
    }
    setReplaying(true);
    setError('');
    setReplay(null);
    try {
      const result = await invoke('replayRun', { runId });
      if (result && result.ok === false) {
        setError(result.error || 'Replay failed');
      } else {
        setReplay(result);
      }
    } catch (replayError) {
      setError(replayError instanceof Error ? replayError.message : String(replayError));
    } finally {
      setReplaying(false);
    }
  }

  async function onFork() {
    const runId = detail?.run?.runId;
    if (!runId) {
      return;
    }
    setForking(true);
    setError('');
    try {
      /** @type {Record<string, unknown>} */
      const payload = { runId, stepIdx: Number(forkIdx) };
      if (forkInput.trim().length > 0) {
        payload.input = forkInput;
      }
      const result = await invoke('forkRun', payload);
      if (result && result.ok === false) {
        setError(result.error || 'Fork failed');
      } else if (result?.runId) {
        await load(issueKey, result.runId);
      }
    } catch (forkError) {
      setError(forkError instanceof Error ? forkError.message : String(forkError));
    } finally {
      setForking(false);
    }
  }

  async function onExport() {
    const runId = detail?.run?.runId;
    if (!runId) {
      return;
    }
    try {
      const result = await invoke('exportRunTrace', { runId });
      if (result && result.ok === false) {
        setError(result.error || 'Export failed');
      } else {
        setTrace(JSON.stringify(result?.otlp ?? result, null, 2));
      }
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    }
  }

  if (loading && !detail) {
    return <Spinner label="Loading Conductor runs" />;
  }

  if (!runs.length) {
    return (
      <Stack space="space.200">
        <EmptyState
          header="No Conductor run on this issue"
          description="Ask the Conductor agent to plan and run this Epic. The run appears here after plan-split."
        />
        <Button onClick={refresh}>Refresh</Button>
      </Stack>
    );
  }

  const run = detail?.run;
  const blocked = run && (run.status === 'blocked' || run.status === 'failed');
  const projectKey = run?.projectKey || runs[0].projectKey || '';
  const epicKey = run?.epicKey || issueKey;

  return (
    <Stack space="space.200">
      <Heading size="small">{run?.goal || runs[0].goal}</Heading>
      <StatusLozenge status={run?.status || runs[0].status} />
      {hasChaosActivity(detail?.chaos) ? <Text>{chaosSummary(detail.chaos)}</Text> : null}
      {hasEffectMetrics(detail?.effectMetrics) ? <Text>{effectMetricsSummary(detail.effectMetrics)}</Text> : null}
      <Button onClick={refresh}>Refresh</Button>
      {error ? (
        <SectionMessage appearance="warning" title="The panel could not refresh">
          <Text>{error}</Text>
        </SectionMessage>
      ) : null}
      <Tabs id="conductor-run">
        <TabList>
          <Tab>Run</Tab>
          <Tab>Recall</Tab>
          <Tab>Lessons</Tab>
        </TabList>
        <TabPanel>
          <Stack space="space.200">
            <BlastRadius blast={detail?.blast} />
            {run?.status === 'planning' ? (
              <Stack space="space.100">
                <SectionMessage appearance="warning" title="This plan has not started">
                  <Text>
                    {detail?.blast?.summary
                      ? `${detail.blast.summary}. Approve here to start. The chat does not receive the confirmation token.`
                      : 'Approve here to start. The chat does not receive the confirmation token.'}
                  </Text>
                </SectionMessage>
                <Button appearance="primary" isDisabled={approving} onClick={onApprove}>
                  {approving ? 'Starting' : 'Approve and start'}
                </Button>
              </Stack>
            ) : null}
            {detail?.planCard ? (
              <SectionMessage appearance="information" title="Plan card">
                <Text>{detail.planCard}</Text>
              </SectionMessage>
            ) : null}
            {blocked ? (
              <SectionMessage appearance="error" title="This run is blocked">
                <Text>A step failed or exhausted its retries. Retry the blocked step, or ask Conductor for status.</Text>
              </SectionMessage>
            ) : null}
            {run?.status === 'awaiting-review' ? (
              <SectionMessage appearance="warning" title="Report back, you decide">
                <Text>{run.ledger?.lastDecision?.why || 'The lead paused this run after a wave.'}</Text>
                <Text>Reply on this Epic with conductor continue or conductor stop. Transition the Epic to Done to stop, or to In Progress to continue.</Text>
              </SectionMessage>
            ) : null}
            <Inline space="space.400" alignBlock="start">
              {detail ? <DependencyGraph steps={detail.steps} /> : null}
              <FlightRecorder
                timeline={detail?.timeline || []}
                cursor={cursor}
                onScrub={setCursor}
              />
            </Inline>
            {detail ? <StepTable run={detail} onRetry={retry} retrying={retrying} /> : <Spinner />}
            {(detail?.steps || []).some((step) => subAgentLines(step).length > 0) ? (
              <Stack space="space.100">
                <Heading size="xsmall">Sub-agents</Heading>
                {(detail.steps || []).filter((step) => subAgentLines(step).length > 0).map((step) => (
                  <Stack key={step.stepId || step.idx} space="space.050">
                    {subAgentLines(step).map((line, index) => (
                      <Text key={`${step.stepId || step.idx}-${index}`}>{line}</Text>
                    ))}
                  </Stack>
                ))}
              </Stack>
            ) : null}
            <Heading size="xsmall">Replay and fork</Heading>
            <Text>
              Replay diffs this run against today&apos;s Jira, using lessons that were valid when the run was created. Fork follows dependsOn and does not rewrite the prefix.
            </Text>
            <Button appearance="primary" isDisabled={replaying} onClick={onReplay}>
              {replaying ? 'Replaying' : 'Replay dry-run'}
            </Button>
            {replay?.summary ? (
              <SectionMessage appearance="information" title="Dry-run diff">
                <Text>{replay.summary}</Text>
              </SectionMessage>
            ) : null}
            {(replay?.lessons?.newer || []).length > 0 ? (
              <Text>
                {`Newer lessons that would change the plan: ${replay.lessons.newer.map((lesson) => lesson.lessonId).join(', ')}`}
              </Text>
            ) : null}
            <Inline space="space.100" alignBlock="end">
              <Textfield
                placeholder="Step index"
                value={forkIdx}
                onChange={(value) => setForkIdx(readControlValue(value))}
              />
              <Textfield
                placeholder="New input for step N (optional)"
                value={forkInput}
                onChange={(value) => setForkInput(readControlValue(value))}
              />
              <Button appearance="warning" isDisabled={forking} onClick={onFork}>
                {forking ? 'Forking' : 'Fork'}
              </Button>
            </Inline>
            <Button onClick={onExport}>Export OTLP JSON</Button>
            {trace ? <CodeBlock language="json" text={trace} shouldWrapLongLines /> : null}
            <Heading size="xsmall">Effects</Heading>
            {(detail?.effects || []).length === 0 ? <Text>No effects yet.</Text> : (
              <Stack space="space.050">
                {detail.effects.map((effect) => (
                  <Text key={effect.requestKey}>
                    {`${effect.kind} · ${effect.status}`}
                  </Text>
                ))}
              </Stack>
            )}
            <Heading size="xsmall">Memory</Heading>
            {(detail?.memories || []).length === 0 ? <Text>No memories for this run.</Text> : (
              <Stack space="space.050">
                {detail.memories.map((memory) => (
                  <Text key={memory.memId}>
                    {`${memory.memType}: ${memory.text}`}
                  </Text>
                ))}
              </Stack>
            )}
          </Stack>
        </TabPanel>
        <TabPanel>
          <RecallView
            applied={detail?.appliedMemories || []}
            planCard={detail?.planCard || ''}
            usedMemory={detail?.usedMemory || []}
            usedLessons={detail?.usedLessons || []}
          />
        </TabPanel>
        <TabPanel>
          <LessonsView
            lessons={detail?.lessons || []}
            projectKey={projectKey}
            epicKey={epicKey}
            onOp={operateLesson}
            busy={lessonBusy}
          />
        </TabPanel>
      </Tabs>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
