import { create } from 'zustand';
import type {
  DynamicWorkflowRun,
  DynamicWorkflowRunStatus,
  DynamicWorkflowNode,
  DynamicWorkflowNodeRun,
  DynamicWorkflowNodeStatus,
  DynamicWorkflowEvent,
  DynamicWorkflowArtifact,
  DynamicWorkflowManifest,
  DynamicWorkflowMessage,
  DynamicWorkflowSnapshot,
  DynamicWorkflowStreamChunk,
  DynamicWorkflowIntervention,
  DynamicWorkflowGateDecisionInput,
  DynamicWorkflowEventsQuery,
  PersistedTimelineToolCall,
} from '@/types';
import { COCKPIT_STRUCTURAL_EVENT_TYPES } from '@/types/dynamic-workflow';
import type {
  CockpitNodeRun,
  TouchedFilesFromEvents,
  WriterCommitInfo,
} from '@/types/dynamic-workflow-cockpit';
import type { WorkflowNodeStreamState } from '@/components/dynamic-workflow/WorkflowStreamView';
import {
  appendTimelineText,
  appendTimelineTool,
  finishTimeline,
  timelineFromPersisted,
} from '@/lib/stream-timeline';


export interface CloserThreadMessage {
  id: string;
  role: 'closer' | 'human';
  content: string;
}

export interface MaestroThreadMessage {
  id: string;
  role: 'user' | 'maestro';
  content: string;
  streaming?: boolean;
}

export interface DynamicWorkflowPendingQuestion {
  nodeId: string | null;
  prompt: string;
}

export const NARRATION_FEED_LIMIT = 6;


export type DynamicWorkflowUIStatus =
  | DynamicWorkflowRunStatus
  | 'streaming'
  | 'awaiting-user'
  | 'pausing';

export function deriveWorkflowUIStatus(
  status: DynamicWorkflowRunStatus,
  flags: { isStreaming?: boolean; awaitingUser?: boolean; isPausing?: boolean } = {},
): DynamicWorkflowUIStatus {
  if (status === 'completed' || status === 'aborted' || status === 'failed') {
    return status;
  }
  if (flags.awaitingUser) return 'awaiting-user';
  if (flags.isPausing) return 'pausing';
  if (flags.isStreaming) return 'streaming';
  return status;
}


const NODE_RUN_STATUSES = new Set<DynamicWorkflowNodeStatus>([
  'pending',
  'running',
  'completed',
  'failed',
  'blocked',
  'skipped',
  'interrupted',
  'cancelled',
]);

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function statusFromEventType(type: string): DynamicWorkflowNodeStatus | null {
  switch (type) {
    case 'node-started':
      return 'running';
    case 'node-completed':
    case 'node-cache-hit':
    case 'checkpoint-saved':
      return 'completed';
    case 'node-failed':
      return 'failed';
    default:
      return null;
  }
}

function emptyNodeRun(
  runId: string,
  nodeId: string,
  attempt: number,
  status: DynamicWorkflowNodeStatus,
  phaseId: string,
): CockpitNodeRun {
  return {
    id: `${nodeId}#${attempt}`,
    runId,
    nodeId,
    phaseId,
    type: 'agent',
    agentId: null,
    status,
    attempt,
    inputHash: null,
    policyHash: null,
    policySnapshotJson: '{}',
    inputJson: '{}',
    outputHash: null,
    outputJson: null,
    error: null,
    failureClass: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    costStatus: null,
    tokenStatus: null,
    costUnknownReason: null,
    metricsMetadataJson: '{}',
    model: null,
    runtime: null,
    provider: null,
    toolUses: 0,
    apiRequests: 0,
    durationMs: 0,
    startedAt: null,
    completedAt: null,
    label: null,
    worktreeCommitSha: null,
  };
}

function definedOnly<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function nodeRunPatchFromPayload(p: Record<string, unknown>): Partial<CockpitNodeRun> {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const n = (v: unknown): number | undefined => (isNumber(v) ? v : undefined);
  return definedOnly({
    id: str(p.id),
    type: str(p.type) as DynamicWorkflowNodeRun['type'] | undefined,
    agentId: str(p.agentId),
    inputHash: str(p.inputHash),
    policyHash: str(p.policyHash),
    policySnapshotJson: str(p.policySnapshotJson),
    inputJson: str(p.inputJson),
    outputHash: str(p.outputHash),
    outputJson: str(p.outputJson),
    error: str(p.error),
    failureClass: str(p.failureClass) as DynamicWorkflowNodeRun['failureClass'] | undefined,
    inputTokens: n(p.inputTokens),
    outputTokens: n(p.outputTokens),
    cacheReadTokens: n(p.cacheReadTokens),
    cacheCreationTokens: n(p.cacheCreationTokens),
    costUsd: n(p.costUsd),
    costStatus: str(p.costStatus),
    tokenStatus: str(p.tokenStatus),
    costUnknownReason: str(p.costUnknownReason),
    metricsMetadataJson: str(p.metricsMetadataJson),
    model: str(p.model),
    runtime: str(p.runtime),
    provider: str(p.provider),
    toolUses: n(p.toolUses),
    apiRequests: n(p.apiRequests),
    durationMs: n(p.durationMs),
    startedAt: str(p.startedAt),
    completedAt: str(p.completedAt),
    label: str(p.label),
    worktreeCommitSha: str(p.worktreeCommitSha),
  });
}

export function nodeRunFromEventPayload(runId: string, payload: unknown): CockpitNodeRun | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.nodeId !== 'string' || !isNumber(p.attempt)) return null;
  if (typeof p.status !== 'string' || !NODE_RUN_STATUSES.has(p.status as DynamicWorkflowNodeStatus)) {
    return null;
  }
  const phaseId = typeof p.phaseId === 'string' ? p.phaseId : '';
  return {
    ...emptyNodeRun(runId, p.nodeId, p.attempt, p.status as DynamicWorkflowNodeStatus, phaseId),
    ...nodeRunPatchFromPayload(p),
  };
}

const CACHE_HIT_PATCH_KEYS = ['agentId', 'label'] as const;

export function deriveNodeRunsFromEvents(
  runId: string,
  events: DynamicWorkflowEvent[],
): CockpitNodeRun[] {
  const byKey = new Map<string, CockpitNodeRun>();
  const lastAttemptByNode = new Map<string, number>();
  for (const ev of events) {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = ev.payloadJson ? JSON.parse(ev.payloadJson) : null;
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
    } catch {
    }
    const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId : ev.nodeId;
    if (typeof nodeId !== 'string') continue;
    const rawStatus =
      typeof payload.status === 'string' ? payload.status : statusFromEventType(ev.type);
    if (rawStatus === null || !NODE_RUN_STATUSES.has(rawStatus as DynamicWorkflowNodeStatus)) {
      continue;
    }
    const status = rawStatus as DynamicWorkflowNodeStatus;
    const attempt = isNumber(payload.attempt)
      ? payload.attempt
      : (lastAttemptByNode.get(nodeId) ?? 1);
    lastAttemptByNode.set(nodeId, attempt);
    const phaseId = typeof payload.phaseId === 'string' ? payload.phaseId : (ev.phaseId ?? '');

    const key = `${nodeId}#${attempt}`;
    const prev = byKey.get(key);
    let patch = nodeRunPatchFromPayload(payload);
    if (ev.type === 'node-cache-hit') {
      if (prev) {
        const identity: Partial<CockpitNodeRun> = {};
        for (const k of CACHE_HIT_PATCH_KEYS) identity[k] = patch[k];
        patch = definedOnly(identity);
      } else if (patch.costStatus === undefined) {
        patch.costStatus = 'unknown';
      }
    }
    const base = prev ?? emptyNodeRun(runId, nodeId, attempt, status, phaseId);
    byKey.set(key, {
      ...base,
      ...patch,
      status,
      phaseId: phaseId || base.phaseId,
    });
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.nodeId === b.nodeId ? a.attempt - b.attempt : a.nodeId.localeCompare(b.nodeId),
  );
}

export function deriveTouchedFilesFromEvents(
  events: DynamicWorkflowEvent[],
): TouchedFilesFromEvents {
  const files = new Set<string>();
  const writers: WriterCommitInfo[] = [];
  let hidden = 0;
  let truncated = false;
  for (const ev of events) {
    if (ev.type !== 'node-completed' || !ev.nodeId) continue;
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = ev.payloadJson ? JSON.parse(ev.payloadJson) : null;
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
    } catch {
      payload = null;
    }
    if (!payload) continue;
    const list = Array.isArray(payload.touchedFiles)
      ? payload.touchedFiles.filter((f): f is string => typeof f === 'string' && f.length > 0)
      : null;
    const sha = typeof payload.worktreeCommitSha === 'string' ? payload.worktreeCommitSha : null;
    if (list === null && sha === null) continue;
    for (const f of list ?? []) files.add(f);
    const listed = list?.length ?? 0;
    if (isNumber(payload.touchedFilesTotal)) hidden += Math.max(0, payload.touchedFilesTotal - listed);
    if (payload.touchedFilesTruncated === true) truncated = true;
    writers.push({
      nodeId: ev.nodeId,
      phaseId: ev.phaseId ?? null,
      attempt: isNumber(payload.attempt) ? payload.attempt : 0,
      label: typeof payload.label === 'string' ? payload.label : null,
      agentId: typeof payload.agentId === 'string' ? payload.agentId : null,
      worktreeCommitSha: sha,
      touchedFiles: list ?? [],
    });
  }
  return { files: Array.from(files).sort(), hidden, truncated, writers };
}

export const STRUCTURAL_EVENTS_PAGE_SIZE = 1000;

export async function fetchAllStructuralEvents(
  getEvents: (runId: string, opts?: DynamicWorkflowEventsQuery) => Promise<DynamicWorkflowEvent[]>,
  runId: string,
  maxSeq: number,
): Promise<DynamicWorkflowEvent[]> {
  const pages: DynamicWorkflowEvent[][] = [];
  let beforeSeq = maxSeq + 1;
  for (;;) {
    const page = await getEvents(runId, {
      types: [...COCKPIT_STRUCTURAL_EVENT_TYPES],
      beforeSeq,
      limit: STRUCTURAL_EVENTS_PAGE_SIZE,
    });
    const list = Array.isArray(page) ? page : [];
    if (list.length === 0) break;
    const firstSeq = list[0].seq;
    const lastSeq = list[list.length - 1].seq;
    if (!Number.isFinite(firstSeq) || !Number.isFinite(lastSeq) || lastSeq >= beforeSeq) break;
    pages.unshift(list);
    if (list.length < STRUCTURAL_EVENTS_PAGE_SIZE) break;
    beforeSeq = firstSeq;
  }
  return pages.flat();
}


export function deriveManifestFromNodes(
  nodes: DynamicWorkflowNode[],
): DynamicWorkflowManifest | null {
  if (nodes.length === 0) return null;
  const seen = new Set<string>();
  const phases: DynamicWorkflowManifest['phases'] = [];
  for (const n of nodes) {
    const pid = n.phaseId || 'sem-fase';
    if (seen.has(pid)) continue;
    seen.add(pid);
    phases.push({
      id: pid,
      name: pid.replace(/[-_]/g, ' '),
      order: phases.length,
    });
  }
  return {
    version: 1,
    name: 'workflow',
    phases,
    nodes: [],
    parallelism: { maxConcurrentAgents: 1, parallelWritersAllowed: false },
    gates: [],
    estimate: { minUsd: 0, maxUsd: 0, unknownCostNodes: [] },
  };
}


interface DynamicWorkflowState {
  runs: DynamicWorkflowRun[];
  isLoading: boolean;
  error: string | null;

  selectedRunId: string | null;
  selectedRun: DynamicWorkflowRun | null;
  nodes: DynamicWorkflowNode[];
  events: DynamicWorkflowEvent[];
  structuralEvents: DynamicWorkflowEvent[];
  artifacts: DynamicWorkflowArtifact[];
  snapshot: DynamicWorkflowSnapshot | null;
  nodeRuns: CockpitNodeRun[];
  manifest: DynamicWorkflowManifest | null;
  nodeStreams: Record<string, WorkflowNodeStreamState>;
  selectedRoundIndex: number | null;
  closerThread: CloserThreadMessage[];
  maestroThread: MaestroThreadMessage[];
  pendingQuestion: DynamicWorkflowPendingQuestion | null;

  streamingRunIds: Set<string>;
  awaitingUserRunIds: Set<string>;
  pausingRunIds: Set<string>;


  getUIStatus: (runId: string) => DynamicWorkflowUIStatus;


  loadRuns: () => Promise<void>;

  openRun: (runId: string) => Promise<void>;

  closeRun: () => void;

  selectRound: (index: number | null) => void;

  start: (runId: string) => Promise<void>;
  pause: (runId: string) => Promise<void>;
  resume: (runId: string) => Promise<void>;
  scheduleResume: (runId: string, delayMs?: number) => Promise<void>;
  abort: (runId: string) => Promise<void>;

  reopenRun: (runId: string) => Promise<void>;

  deleteWorkflow: (runId: string) => Promise<{ ok: true } | { error: string }>;

  approveGate: (
    runId: string,
    gateId: string,
    decision: DynamicWorkflowGateDecisionInput,
  ) => Promise<string | null>;

  intervene: (
    runId: string,
    intervention: DynamicWorkflowIntervention,
  ) => Promise<void>;


  sendMessage: (runId: string, message: string) => Promise<{ ok: true } | { error: string }>;

  requestReplan: (
    runId: string,
    request: Parameters<typeof window.lionclaw.dynamicWorkflow.requestReplan>[1],
  ) => Promise<{ ok: true; definitionId?: string } | { error: string }>;

  resolveWithCloser: (runId: string, reason: string) => Promise<{ ok: true } | { error: string }>;

  sendCloserMessage: (runId: string, message: string) => Promise<{ ok: true } | { error: string }>;

  finalizeWorkflow: (runId: string) => Promise<{ ok: true } | { error: string }>;


  switchAgent: (
    runId: string,
    nodeId: string,
    newAgentId: string,
    reason: string,
  ) => Promise<{ ok: true } | { error: string }>;

  resetNodeRound: (
    runId: string,
    nodeId: string,
    reason: string,
  ) => Promise<{ ok: true; definitionId?: string } | { error: string }>;

  scheduledResumeAt: Record<string, string>;

  stalledByRun: Record<string, { message: string; at: string }>;

  narrationByRun: Record<string, string[]>;

  persistedNarrationByRun: Record<string, string[]>;

  gateDecisionsByRun: Record<string, GateDecisionSummary[]>;

  closerBusyRunIds: Set<string>;

  maestroBusyRunIds: Set<string>;

  init: () => () => void;

  _handleStreamChunk: (chunk: DynamicWorkflowStreamChunk) => void;

  _scheduleRunnerReload: (runId: string) => void;
}

function withAdded(set: Set<string>, id: string): Set<string> {
  if (set.has(id)) return set;
  const next = new Set(set);
  next.add(id);
  return next;
}

function withRemoved(set: Set<string>, id: string): Set<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

export function accumulateNodeStream(
  streams: Record<string, WorkflowNodeStreamState>,
  chunk: DynamicWorkflowStreamChunk,
): Record<string, WorkflowNodeStreamState> {
  const nodeId = chunk.nodeId;
  if (!nodeId) return streams;
  const prev: WorkflowNodeStreamState =
    streams[nodeId] ??
    {
      nodeId,
      label: nodeId,
      status: 'running',
      text: '',
      toolCalls: [],
      timeline: [],
      isStreaming: true,
    };
  const next: WorkflowNodeStreamState = {
    ...prev,
    status: 'running',
    isStreaming: true,
  };
  if (chunk.type === 'text' && chunk.content) {
    next.text = prev.text + chunk.content;
    next.timeline = appendTimelineText(prev.timeline, chunk.content);
  } else if (chunk.type === 'tool_call' && chunk.toolName) {
    next.toolCalls = [
      ...prev.toolCalls,
      { toolName: chunk.toolName, detail: chunk.content },
    ];
    next.timeline = appendTimelineTool(prev.timeline, {
      tool: chunk.toolName,
      input: chunk.content,
    });
  }
  return { ...streams, [nodeId]: next };
}

export function deriveNodeStreamsFromMessages(
  messages: readonly DynamicWorkflowMessage[],
  nodeRuns: readonly DynamicWorkflowNodeRun[] = [],
): Record<string, WorkflowNodeStreamState> {
  const latestStatus = new Map<string, DynamicWorkflowNodeStatus>();
  for (const run of nodeRuns) latestStatus.set(run.nodeId, run.status);
  const streams: Record<string, WorkflowNodeStreamState> = {};
  for (const message of messages) {
    if (message.source !== 'agent' || message.kind !== 'node-output' || !message.nodeId) continue;
    let tools: PersistedTimelineToolCall[] = [];
    try {
      const parsed = message.toolCallsJson ? JSON.parse(message.toolCallsJson) : [];
      if (Array.isArray(parsed)) {
        tools = parsed.filter(
          (tool): tool is PersistedTimelineToolCall =>
            tool !== null && typeof tool === 'object' && typeof (tool as { tool?: unknown }).tool === 'string',
        );
      }
    } catch {
      tools = [];
    }
    streams[message.nodeId] = {
      nodeId: message.nodeId,
      label: message.agentId ?? message.nodeId,
      status: latestStatus.get(message.nodeId) ?? 'completed',
      text: message.content,
      toolCalls: tools.map((tool) => ({
        toolName: tool.tool,
        detail: typeof tool.input === 'string' ? tool.input : undefined,
      })),
      timeline: timelineFromPersisted(message.content, tools, `workflow-${message.id}`),
      isStreaming: false,
    };
  }
  return streams;
}

export function extractQuestionPrompt(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    const candidate = p.prompt ?? p.question ?? p.message;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return 'O agente fez uma pergunta e aguarda sua resposta.';
}

export function extractScheduledResumeAt(payload: unknown): string | null {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    const candidate = p.nextAttemptAt ?? p.scheduledResumeAt;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

export function extractStallMessage(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    const candidate = p.message ?? p.reason;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return 'O node parou de progredir e o watchdog pausou o run.';
}

export function appendNarrationLine(
  feed: string[] | undefined,
  line: string,
  limit = NARRATION_FEED_LIMIT,
): string[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return feed ?? [];
  const next = [...(feed ?? []), trimmed];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function appendMaestroNarratorDelta(
  thread: MaestroThreadMessage[],
  delta: string,
): MaestroThreadMessage[] {
  if (!delta) return thread;
  const last = thread[thread.length - 1];
  if (last && last.role === 'maestro' && last.streaming) {
    const grown: MaestroThreadMessage = {
      ...last,
      content: last.content + delta,
    };
    return [...thread.slice(0, -1), grown];
  }
  return [
    ...thread,
    {
      id: `maestro-${Date.now()}-${thread.length}`,
      role: 'maestro',
      content: delta,
      streaming: true,
    },
  ];
}

export function sealMaestroStreamingBubble(
  thread: MaestroThreadMessage[],
): MaestroThreadMessage[] {
  const last = thread[thread.length - 1];
  if (!last || last.role !== 'maestro' || !last.streaming) return thread;
  return [...thread.slice(0, -1), { ...last, streaming: false }];
}

export function appendMaestroMilestoneNarration(
  thread: MaestroThreadMessage[],
  text: string,
): MaestroThreadMessage[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return thread;
  const sealed = sealMaestroStreamingBubble(thread);
  return [
    ...sealed,
    {
      id: `maestro-mark-${Date.now()}-${sealed.length}`,
      role: 'maestro',
      content: trimmed,
      streaming: false,
    },
  ];
}

export function deriveMaestroThreadFromMessages(
  messages: DynamicWorkflowMessage[],
): MaestroThreadMessage[] {
  const out: MaestroThreadMessage[] = [];
  for (const m of messages) {
    if (m.kind === 'maestro-chat' && m.role === 'user') {
      out.push({ id: `db-${m.id}`, role: 'user', content: m.content });
    } else if (m.kind === 'maestro-reply') {
      out.push({ id: `db-${m.id}`, role: 'maestro', content: m.content });
    } else if (m.kind === 'narrator' && m.source === 'workflow-orchestrator-agent') {
      out.push({ id: `db-${m.id}`, role: 'maestro', content: m.content });
    }
  }
  return out;
}

export function deriveNarrationLinesFromMessages(
  messages: DynamicWorkflowMessage[],
): string[] {
  const lines: string[] = [];
  for (const m of deriveMaestroThreadFromMessages(messages)) {
    if (m.role !== 'maestro') continue;
    const trimmed = m.content.trim();
    if (trimmed) lines.push(trimmed);
  }
  return lines.length > NARRATION_FEED_LIMIT
    ? lines.slice(lines.length - NARRATION_FEED_LIMIT)
    : lines;
}

export interface GateDecisionSummary {
  id: string;
  gateId: string;
  decision: string;
  decidedBy: string | null;
  at: string;
}

export function deriveGateDecisionsFromEvents(
  events: DynamicWorkflowEvent[],
): GateDecisionSummary[] {
  const out: GateDecisionSummary[] = [];
  for (const ev of events) {
    if (
      ev.type !== 'gate-approved' &&
      ev.type !== 'gate-rejected' &&
      ev.type !== 'gate-decision-received'
    ) {
      continue;
    }
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = ev.payloadJson ? JSON.parse(ev.payloadJson) : {};
      if (parsed && typeof parsed === 'object') {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = {};
    }
    const gateId =
      typeof payload.gateId === 'string' && payload.gateId ? payload.gateId : 'gate';
    const rawDecision =
      typeof payload.decision === 'string' && payload.decision
        ? payload.decision
        : ev.type === 'gate-approved'
          ? 'approved'
          : ev.type === 'gate-rejected'
            ? 'rejected'
            : 'decidido';
    const decidedBy =
      typeof payload.decidedBy === 'string' && payload.decidedBy
        ? payload.decidedBy
        : typeof payload.approvedBy === 'string' && payload.approvedBy
          ? payload.approvedBy
          : null;
    out.push({
      id: `gate-dec-${ev.seq}`,
      gateId,
      decision: rawDecision,
      decidedBy,
      at: ev.createdAt,
    });
  }
  return out;
}

export function deriveCloserThreadFromMessages(
  messages: DynamicWorkflowMessage[],
): CloserThreadMessage[] {
  const out: CloserThreadMessage[] = [];
  for (const m of messages) {
    if (m.source === 'closer') {
      out.push({ id: `db-${m.id}`, role: 'closer', content: m.content });
    } else if (m.source === 'human' && m.kind === 'text') {
      out.push({ id: `db-${m.id}`, role: 'human', content: m.content });
    }
  }
  return out;
}

export function reconcileMaestroThread(
  current: MaestroThreadMessage[],
  fromDb: MaestroThreadMessage[],
): MaestroThreadMessage[] {
  const dbLastUser = [...fromDb].reverse().find((m) => m.role === 'user');
  const liveTail: MaestroThreadMessage[] = [];
  for (let i = current.length - 1; i >= 0; i -= 1) {
    const m = current[i];
    if (m.role === 'maestro' && m.streaming) {
      liveTail.unshift(m);
      continue;
    }
    if (m.role === 'user') {
      if (!dbLastUser || dbLastUser.content !== m.content) {
        liveTail.unshift(m);
        continue;
      }
    }
    break;
  }
  if (liveTail.length === 0) return fromDb;
  return [...fromDb, ...liveTail];
}

export function reconcileCloserThread(
  current: CloserThreadMessage[],
  fromDb: CloserThreadMessage[],
): CloserThreadMessage[] {
  const dbLastHuman = [...fromDb].reverse().find((m) => m.role === 'human');
  const liveTail: CloserThreadMessage[] = [];
  for (let i = current.length - 1; i >= 0; i -= 1) {
    const m = current[i];
    if (m.role === 'human' && (!dbLastHuman || dbLastHuman.content !== m.content)) {
      liveTail.unshift(m);
      continue;
    }
    break;
  }
  if (liveTail.length === 0) return fromDb;
  return [...fromDb, ...liveTail];
}

function freezeNodeStreams(
  streams: Record<string, WorkflowNodeStreamState>,
): Record<string, WorkflowNodeStreamState> {
  const entries = Object.entries(streams);
  if (entries.length === 0) return streams;
  const next: Record<string, WorkflowNodeStreamState> = {};
  for (const [k, v] of entries) {
    next[k] = v.isStreaming
      ? {
          ...v,
          isStreaming: false,
          timeline: finishTimeline(v.timeline, { toolWithoutResult: 'done' }),
        }
      : v;
  }
  return next;
}

let _wfStreamCleanup: (() => void) | null = null;
let _wfStreamRefCount = 0;


const RUNNER_RELOAD_DEBOUNCE_MS = 120;
const _runnerReloadTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function _cancelRunnerReloadTimers(): void {
  for (const t of _runnerReloadTimers.values()) clearTimeout(t);
  _runnerReloadTimers.clear();
}

export const useDynamicWorkflowStore = create<DynamicWorkflowState>((set, get) => ({
  runs: [],
  isLoading: false,
  error: null,
  selectedRunId: null,
  selectedRun: null,
  nodes: [],
  events: [],
  structuralEvents: [],
  artifacts: [],
  snapshot: null,
  nodeRuns: [],
  manifest: null,
  nodeStreams: {},
  selectedRoundIndex: null,
  closerThread: [],
  maestroThread: [],
  pendingQuestion: null,
  scheduledResumeAt: {},
  stalledByRun: {},
  narrationByRun: {},
  persistedNarrationByRun: {},
  gateDecisionsByRun: {},
  closerBusyRunIds: new Set<string>(),
  maestroBusyRunIds: new Set<string>(),
  streamingRunIds: new Set<string>(),
  awaitingUserRunIds: new Set<string>(),
  pausingRunIds: new Set<string>(),


  getUIStatus: (runId: string): DynamicWorkflowUIStatus => {
    const { runs, selectedRun, streamingRunIds, awaitingUserRunIds, pausingRunIds } = get();
    const run =
      selectedRun?.id === runId
        ? selectedRun
        : runs.find((r) => r.id === runId) ?? null;
    if (!run) return 'created';
    return deriveWorkflowUIStatus(run.status, {
      isStreaming: streamingRunIds.has(runId),
      awaitingUser: awaitingUserRunIds.has(runId),
      isPausing: pausingRunIds.has(runId),
    });
  },


  loadRuns: async () => {
    set({ isLoading: true, error: null });
    try {
      const runs = await window.lionclaw.dynamicWorkflow.listRuns();
      set({ runs, isLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message, isLoading: false });
    }
  },

  openRun: async (runId: string) => {
    const switching = get().selectedRunId !== runId;
    set({
      selectedRunId: runId,
      error: null,
      ...(switching
        ? {
            nodeStreams: {},
            selectedRoundIndex: null,
            artifacts: [],
            snapshot: null,
            nodeRuns: [],
            structuralEvents: [],
            manifest: null,
            closerThread: [],
            maestroThread: [],
            pendingQuestion: null,
            closerBusyRunIds: withRemoved(get().closerBusyRunIds, runId),
            maestroBusyRunIds: withRemoved(get().maestroBusyRunIds, runId),
          }
        : {}),
    });
    try {
      const [run, nodes, events, artifacts, snapshotResult, messages] =
        await Promise.all([
          window.lionclaw.dynamicWorkflow.getRun(runId),
          window.lionclaw.dynamicWorkflow.getNodes(runId),
          window.lionclaw.dynamicWorkflow.getEvents(runId),
          window.lionclaw.dynamicWorkflow.getArtifacts(runId),
          window.lionclaw.dynamicWorkflow.getSnapshot(runId),
          window.lionclaw.dynamicWorkflow.getMessages(runId),
        ]);
      if (get().selectedRunId !== runId) return;
      const eventList = Array.isArray(events) ? events : [];
      const maxSeq = eventList.reduce((acc, ev) => (ev.seq > acc ? ev.seq : acc), 0);
      const structuralList =
        eventList.length > 0
          ? await fetchAllStructuralEvents(
              (id, opts) => window.lionclaw.dynamicWorkflow.getEvents(id, opts),
              runId,
              maxSeq,
            )
          : [];
      if (get().selectedRunId !== runId) return;
      const nodeList = Array.isArray(nodes) ? nodes : [];
      const messageList = Array.isArray(messages) ? messages : [];
      const snapshot =
        snapshotResult && !('error' in snapshotResult) ? snapshotResult : null;
      const dbMaestro = deriveMaestroThreadFromMessages(messageList);
      const dbCloser = deriveCloserThreadFromMessages(messageList);
      const dbNarration = deriveNarrationLinesFromMessages(messageList);
      const dbGateDecisions = deriveGateDecisionsFromEvents(structuralList);
      const derivedNodeRuns = deriveNodeRunsFromEvents(runId, structuralList);
      const persistedNodeStreams = deriveNodeStreamsFromMessages(messageList, derivedNodeRuns);
      const liveNodeStreams = get().nodeStreams;
      const mergedNodeStreams = { ...persistedNodeStreams, ...liveNodeStreams };
      for (const [nodeId, stream] of Object.entries(mergedNodeStreams)) {
        const currentStatus = [...derivedNodeRuns].reverse().find((nodeRun) => nodeRun.nodeId === nodeId)?.status;
        if (currentStatus) mergedNodeStreams[nodeId] = { ...stream, status: currentStatus };
      }
      set({
        selectedRun: run,
        nodes: nodeList,
        events: eventList,
        structuralEvents: structuralList,
        artifacts: Array.isArray(artifacts) ? artifacts : [],
        snapshot,
        nodeRuns: derivedNodeRuns,
        nodeStreams: mergedNodeStreams,
        manifest: deriveManifestFromNodes(nodeList),
        maestroThread: reconcileMaestroThread(get().maestroThread, dbMaestro),
        closerThread: reconcileCloserThread(get().closerThread, dbCloser),
        persistedNarrationByRun: {
          ...get().persistedNarrationByRun,
          [runId]: dbNarration,
        },
        gateDecisionsByRun: {
          ...get().gateDecisionsByRun,
          [runId]: dbGateDecisions,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  closeRun: () => {
    set({
      selectedRunId: null,
      selectedRun: null,
      nodes: [],
      events: [],
      structuralEvents: [],
      artifacts: [],
      snapshot: null,
      nodeRuns: [],
      manifest: null,
      nodeStreams: {},
      selectedRoundIndex: null,
      closerThread: [],
      maestroThread: [],
      pendingQuestion: null,
    });
  },

  selectRound: (index: number | null) => {
    set({ selectedRoundIndex: index });
  },


  start: async (runId: string) => {
    set({ error: null });
    try {
      const result = await window.lionclaw.dynamicWorkflow.start(runId);
      if ('error' in result) {
        set({ error: result.error });
      } else {
        await get().loadRuns();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  pause: async (runId: string) => {
    set({ error: null });
    try {
      const result = await window.lionclaw.dynamicWorkflow.pause(runId);
      if ('error' in result) {
        set({ error: result.error });
      } else {
        await get().loadRuns();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  resume: async (runId: string) => {
    set({ error: null });
    try {
      const result = await window.lionclaw.dynamicWorkflow.resume(runId);
      if ('error' in result) {
        set({ error: result.error });
      } else {
        await get().loadRuns();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  scheduleResume: async (runId: string, delayMs?: number) => {
    set({ error: null });
    const effectiveDelayMs = typeof delayMs === 'number' && delayMs > 0 ? delayMs : 5 * 60 * 1000;
    try {
      const result = await window.lionclaw.dynamicWorkflow.resume(runId, {
        delayMs: effectiveDelayMs,
      });
      if ('error' in result) {
        set({ error: result.error });
      } else {
        await get().loadRuns();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  abort: async (runId: string) => {
    set({ error: null });
    try {
      const result = await window.lionclaw.dynamicWorkflow.abort(runId);
      if ('error' in result) {
        set({ error: result.error });
      } else {
        await get().loadRuns();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  reopenRun: async (runId: string) => {
    set({ error: null });
    try {
      const result = await window.lionclaw.dynamicWorkflow.reopen(runId);
      if ('error' in result) {
        set({ error: result.error });
      } else {
        await get().loadRuns();
        if (get().selectedRunId === runId) {
          await get().openRun(runId);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  deleteWorkflow: async (runId: string) => {
    set({ error: null });
    try {
      const result = await window.lionclaw.dynamicWorkflow.deleteRun(runId);
      if ('error' in result) {
        set({ error: result.error });
        return result;
      }
      if (get().selectedRunId === runId) {
        get().closeRun();
      }
      await get().loadRuns();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      return { error: message };
    }
  },

  approveGate: async (
    runId: string,
    gateId: string,
    decision: DynamicWorkflowGateDecisionInput,
  ) => {
    set({ error: null });
    try {
      const res = await window.lionclaw.dynamicWorkflow.approveGate(
        runId,
        gateId,
        decision,
      );
      if (res && 'error' in res) {
        set({ error: res.error });
        return res.error;
      }
      set((state) => ({ awaitingUserRunIds: withRemoved(state.awaitingUserRunIds, runId) }));
      await get().loadRuns();
      if (get().selectedRunId === runId) {
        await get().openRun(runId);
      }
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      return message;
    }
  },

  intervene: async (runId: string, intervention: DynamicWorkflowIntervention) => {
    set({ error: null });
    try {
      const result = await window.lionclaw.dynamicWorkflow.intervene(
        runId,
        intervention,
      );
      if ('error' in result) {
        set({ error: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },


  sendMessage: async (runId: string, message: string) => {
    set({ error: null });
    try {
      const result = await window.lionclaw.dynamicWorkflow.sendMessage(runId, message);
      if ('error' in result) {
        set({ error: result.error });
        return result;
      }
      return result;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      set({ error: m });
      return { error: m };
    }
  },

  requestReplan: async (runId, request) => {
    set({ error: null });
    try {
      const result = await window.lionclaw.dynamicWorkflow.requestReplan(runId, request);
      if ('error' in result) {
        set({ error: result.error });
        return result;
      }
      await get().loadRuns();
      return result;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      set({ error: m });
      return { error: m };
    }
  },

  resolveWithCloser: async (runId: string, reason: string) => {
    set({ error: null });
    set((state) => ({ closerBusyRunIds: withAdded(state.closerBusyRunIds, runId) }));
    try {
      const result = await window.lionclaw.dynamicWorkflow.resolveWithCloser(runId, reason);
      if ('error' in result) {
        set((state) => ({
          error: result.error,
          closerBusyRunIds: withRemoved(state.closerBusyRunIds, runId),
        }));
        return result;
      }
      return result;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      set((state) => ({
        error: m,
        closerBusyRunIds: withRemoved(state.closerBusyRunIds, runId),
      }));
      return { error: m };
    }
  },

  sendCloserMessage: async (runId: string, message: string) => {
    set({ error: null });
    set((state) => ({
      closerThread: [
        ...state.closerThread,
        { id: `human-${Date.now()}-${state.closerThread.length}`, role: 'human', content: message },
      ],
      closerBusyRunIds: withAdded(state.closerBusyRunIds, runId),
    }));
    try {
      const result = await window.lionclaw.dynamicWorkflow.sendCloserMessage(runId, message);
      if ('error' in result) {
        set((state) => ({
          error: result.error,
          closerBusyRunIds: withRemoved(state.closerBusyRunIds, runId),
        }));
        return result;
      }
      return result;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      set((state) => ({
        error: m,
        closerBusyRunIds: withRemoved(state.closerBusyRunIds, runId),
      }));
      return { error: m };
    }
  },

  finalizeWorkflow: async (runId: string) => {
    set({ error: null });
    try {
      const result = await window.lionclaw.dynamicWorkflow.finalizeWorkflow(runId);
      if ('error' in result) {
        set({ error: result.error });
        return result;
      }
      await get().loadRuns();
      if (get().selectedRunId === runId) {
        await get().openRun(runId);
      }
      return result;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      set({ error: m });
      return { error: m };
    }
  },


  switchAgent: async (runId, nodeId, newAgentId, reason) => {
    set({ error: null });
    try {
      const result = await window.lionclaw.dynamicWorkflow.intervene(runId, {
        type: 'switch-agent',
        nodeId,
        newAgentId,
        reason,
      });
      if ('error' in result) {
        set({ error: result.error });
        return result;
      }
      await get().loadRuns();
      return result;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      set({ error: m });
      return { error: m };
    }
  },

  resetNodeRound: async (runId, nodeId, reason) => {
    set({ error: null });
    try {
      const result = await window.lionclaw.dynamicWorkflow.requestReplan(runId, {
        scope: 'node',
        reason,
        nodeId,
      });
      if ('error' in result) {
        set({ error: result.error });
        return result;
      }
      await get().loadRuns();
      return result;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      set({ error: m });
      return { error: m };
    }
  },


  init: () => {
    _wfStreamRefCount += 1;
    if (!_wfStreamCleanup) {
      _wfStreamCleanup = window.lionclaw.dynamicWorkflow.onEvent((chunk) => {
        get()._handleStreamChunk(chunk);
      });
    }
    return () => {
      _wfStreamRefCount -= 1;
      if (_wfStreamRefCount <= 0 && _wfStreamCleanup) {
        _wfStreamCleanup();
        _wfStreamCleanup = null;
        _wfStreamRefCount = 0;
      }
    };
  },

  _handleStreamChunk: (chunk: DynamicWorkflowStreamChunk) => {
    const { runId } = chunk;
    if (!runId) return;

    if (chunk.type === 'done' && chunk.kind === 'node' && chunk.nodeId) {
      set((state) => {
        const current = state.nodeStreams[chunk.nodeId!];
        if (!current) return {};
        const nodeStreams = {
          ...state.nodeStreams,
          [chunk.nodeId!]: {
            ...current,
            status: 'completed' as const,
            isStreaming: false,
            timeline: finishTimeline(current.timeline, { toolWithoutResult: 'done' }),
          },
        };
        const stillStreaming = Object.values(nodeStreams).some((stream) => stream.isStreaming);
        return {
          nodeStreams,
          streamingRunIds: stillStreaming
            ? state.streamingRunIds
            : withRemoved(state.streamingRunIds, runId),
        };
      });
      return;
    }

    if (chunk.type === 'done') {
      set((state) => ({
        streamingRunIds: withRemoved(state.streamingRunIds, runId),
        closerBusyRunIds: withRemoved(state.closerBusyRunIds, runId),
        maestroBusyRunIds: withRemoved(state.maestroBusyRunIds, runId),
        ...(state.selectedRunId === runId
          ? { nodeStreams: freezeNodeStreams(state.nodeStreams) }
          : {}),
      }));
      return;
    }

    if (chunk.kind === 'node' && (chunk.type === 'text' || chunk.type === 'tool_call')) {
      set((state) => {
        const patch: Partial<DynamicWorkflowState> = {
          streamingRunIds: withAdded(state.streamingRunIds, runId),
        };
        if (state.selectedRunId === runId && chunk.nodeId) {
          patch.nodeStreams = accumulateNodeStream(state.nodeStreams, chunk);
        }
        return patch;
      });
    }

    if (chunk.kind === 'closer' && chunk.type === 'text' && chunk.content) {
      const content = chunk.content;
      set((state) => {
        const closerBusyRunIds = withRemoved(state.closerBusyRunIds, runId);
        if (state.selectedRunId !== runId) return { closerBusyRunIds };
        return {
          closerBusyRunIds,
          closerThread: [
            ...state.closerThread,
            { id: `closer-${Date.now()}-${state.closerThread.length}`, role: 'closer', content },
          ],
        };
      });
    }

    if (chunk.kind === 'narrator' && chunk.type === 'text' && chunk.content) {
      const content = chunk.content;
      const isMilestone = chunk.final === true;
      set((state) => {
        const maestroBusyRunIds = withRemoved(state.maestroBusyRunIds, runId);
        if (state.selectedRunId !== runId) return { maestroBusyRunIds };
        return {
          maestroBusyRunIds,
          narrationByRun: {
            ...state.narrationByRun,
            [runId]: appendNarrationLine(state.narrationByRun[runId], content),
          },
          maestroThread: isMilestone
            ? appendMaestroMilestoneNarration(state.maestroThread, content)
            : appendMaestroNarratorDelta(state.maestroThread, content),
        };
      });
    }

    if (chunk.kind === 'runner' && chunk.type === 'event') {
      const et = chunk.eventType ?? '';
      const schedAt = extractScheduledResumeAt(chunk.payload);
      if (
        schedAt &&
        (et === 'node-retry-scheduled' || et === 'resume-scheduled' || et === 'resume-rearmed')
      ) {
        set((state) => ({ scheduledResumeAt: { ...state.scheduledResumeAt, [runId]: schedAt } }));
      } else if (
        et === 'scheduled-resume-fired' ||
        et === 'run-started' ||
        et === 'run-aborted' ||
        et === 'run-delivered'
      ) {
        set((state) => {
          if (!(runId in state.scheduledResumeAt)) return {};
          const next = { ...state.scheduledResumeAt };
          delete next[runId];
          return { scheduledResumeAt: next };
        });
      }
      if (et === 'pause-requested') {
        set((state) => ({ pausingRunIds: withAdded(state.pausingRunIds, runId) }));
      } else if (
        et === 'run-paused' ||
        et === 'run-aborted' ||
        et === 'run-delivered' ||
        et === 'run-finished' ||
        et === 'run-started' ||
        et === 'resume-requested'
      ) {
        set((state) => ({
          pausingRunIds: withRemoved(state.pausingRunIds, runId),
        }));
      }
      if (et === 'node-stalled') {
        set((state) => ({
          stalledByRun: {
            ...state.stalledByRun,
            [runId]: { message: extractStallMessage(chunk.payload), at: chunk.payload && typeof chunk.payload === 'object' && typeof (chunk.payload as Record<string, unknown>).at === 'string' ? (chunk.payload as Record<string, string>).at : new Date().toISOString() },
          },
        }));
      } else if (
        et === 'run-started' ||
        et === 'resume-requested' ||
        et === 'scheduled-resume-fired' ||
        et === 'node-started' ||
        et === 'run-aborted' ||
        et === 'run-delivered'
      ) {
        set((state) => {
          if (!(runId in state.stalledByRun)) return {};
          const next = { ...state.stalledByRun };
          delete next[runId];
          return { stalledByRun: next };
        });
      }
      const opensDecision =
        et.includes('pending') ||
        et.includes('gate-awaiting') ||
        et.includes('awaiting-decision') ||
        et.includes('blocked');
      const closesDecision =
        et.includes('resolved') ||
        et.includes('gate-decided') ||
        et.includes('decision-made') ||
        et.includes('resumed') ||
        et.includes('approved') ||
        et.includes('rejected') ||
        et === 'run-started' ||
        et === 'resume-requested' ||
        et === 'scheduled-resume-fired' ||
        et === 'run-delivered' ||
        et === 'run-finished' ||
        et === 'run-aborted';
      const isQuestion = et.includes('question');
      if (opensDecision) {
        set((state) => ({
          awaitingUserRunIds: withAdded(state.awaitingUserRunIds, runId),
          ...(isQuestion && state.selectedRunId === runId
            ? {
                pendingQuestion: {
                  nodeId: chunk.nodeId ?? null,
                  prompt: extractQuestionPrompt(chunk.payload),
                },
              }
            : {}),
        }));
      } else if (closesDecision) {
        set((state) => ({
          awaitingUserRunIds: withRemoved(state.awaitingUserRunIds, runId),
          ...(isQuestion && state.selectedRunId === runId
            ? { pendingQuestion: null }
            : {}),
        }));
      }
      get()._scheduleRunnerReload(runId);
    }
  },

  _scheduleRunnerReload: (runId: string) => {
    const existing = _runnerReloadTimers.get(runId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      _runnerReloadTimers.delete(runId);
      void get().loadRuns();
      if (get().selectedRunId === runId) {
        void get().openRun(runId);
      }
    }, RUNNER_RELOAD_DEBOUNCE_MS);
    _runnerReloadTimers.set(runId, timer);
  },
}));
