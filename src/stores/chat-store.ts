import { create } from 'zustand';
import type {
  ChatMessage,
  ChatSession,
  StreamChunk,
  AskQuestionRequest,
  AskQuestionResponse,
  ConfirmAction,
  ArtifactData,
  ChatAttachment,
  LiveActivity,
  LiveActivityEvent,
  LiveActivityStatus,
  ActivityTurnBlock,
  OpenChatSession,
  ChatSessionUpdatedEvent,
  ChatClearResult,
  CompactionActivePayload,
  SessionOrchestrator,
} from '@/types';
import { useRepoGraphStore } from './repo-graph-store';
import { useChatFeatureTogglesStore } from './chat-feature-toggles-store';
import { useErrorToastStore } from './error-toast-store';
import type { StreamTimelineBlock } from '@/types';
import {
  DEFAULT_CHAT_STALE_LANE_DAYS,
  laneErrorTitle,
  laneLabel,
  normalizeStaleLaneDays,
  pickMostRecentLane,
  resolveNewChatAction,
  type LaneCompactionInfo,
  type LaneCompactionPhase,
} from '@/lib/lanes';
import {
  appendTimelineText,
  appendTimelineTool,
  applyTimelineToolResult,
  failTimeline,
  finishTimeline,
  replaceTimelineText,
  timelineToolsForPersistence,
} from '@/lib/stream-timeline';

export type AssistantTurnEvent = {
  sequence: number;
  sessionId: string | null;
  status: 'completed' | 'empty' | 'error' | 'stopped';
  content: string;
  error?: string;
};

export interface ThreadToolCall {
  id?: string;
  tool: string;
  input: unknown;
  status: 'running' | 'done' | 'error' | 'stopped';
  result?: string;
}

export interface ThreadUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number | null;
  estimated?: boolean;
  costStatus?: 'known' | 'unknown' | 'estimated-partial';
  tokenStatus?: 'reported' | 'not_reported';
  costUnknownReason?: string;
  costEstimationKind?: 'subscription-equivalent-payg';
}

export type ThreadContext = NonNullable<StreamChunk['contextUsage']>;

export interface ThreadError {
  code?: string;
  error?: string;
  sequence: number;
  clearedByDone: boolean;
}

export interface PendingConfirmation {
  sequence: number;
  action: ConfirmAction;
}

export interface PendingAskQuestion {
  sequence: number;
  request: AskQuestionRequest;
}

export interface CompletedAssistantMessage {
  id: number;
  sessionId: string;
  content: string;
  sequence: number;
}

export interface ThreadState {
  messages: ChatMessage[];
  streamingContent: string;
  streamTimeline: StreamTimelineBlock[];
  toolCalls: ThreadToolCall[];
  artifacts: ArtifactData[];
  activities: LiveActivity[];
  activitiesPanelOpen: boolean;
  currentUsage: ThreadUsage | null;
  currentContext: ThreadContext | null;
  orchestrator: SessionOrchestrator | null;
  messageCount: number;
  isStreaming: boolean;
  drivePaused: boolean;
  streamTurnStartedAt: number | null;
  queueRemaining: number;
  isCompacting: boolean;
  compactionPhase: LaneCompactionPhase | null;
  compactionModelLabel: string;
  isDreaming: boolean;
  pendingAskQuestions: PendingAskQuestion[];
  pendingConfirmations: PendingConfirmation[];
  lastError: ThreadError | null;
  submittedUserTurnCount: number;
  assistantTurnCount: number;
  assistantTurnEvents: AssistantTurnEvent[];
  lastAssistantTurnEvent: AssistantTurnEvent | null;
  assistantCompletionCount: number;
  lastCompletedAssistantMessage: CompletedAssistantMessage | null;
  completedAssistantMessages: CompletedAssistantMessage[];
  attachments: ChatAttachment[];
  scrollPinnedToBottom: boolean;
  hydrated: boolean;
}

export type PendingPopup =
  | { kind: 'confirm'; sessionId: string; label: string | null; sequence: number; action: ConfirmAction }
  | { kind: 'ask'; sessionId: string; label: string | null; sequence: number; request: AskQuestionRequest };

type ThreadPatch = Partial<ThreadState> | ((thread: ThreadState) => Partial<ThreadState>);

interface ChatState {
  sessions: ChatSession[];
  telegramSessions: ChatSession[];
  openLanes: OpenChatSession[];
  compactingSessionIds: Set<string>;
  compactions: Record<string, LaneCompactionInfo>;
  staleLaneDays: number;
  newChatDialogOpen: boolean;
  currentSessionId: string | null;
  threads: Record<string, ThreadState>;
  streamingSessionIds: Set<string>;
  voiceModeActive: boolean;
  onboardingAutostartSessionId: string | null;
  drafts: Record<string, string>;

  loadSessions: () => Promise<void>;
  loadOpenLanes: () => Promise<OpenChatSession[]>;
  setDrivePausedForSession: (sessionId: string, paused: boolean) => void;
  applySessionUpdated: (event: ChatSessionUpdatedEvent) => void;
  setStaleLaneDays: (days: unknown) => void;
  selectSession: (id: string) => Promise<void>;
  sendMessage: (
    message: string,
    agentId?: string,
    attachments?: ChatAttachment[],
    targetSessionId?: string,
  ) => Promise<void>;
  stopStreaming: (sessionId?: string) => Promise<void>;
  handleStreamChunk: (chunk: StreamChunk) => void;
  createLane: () => Promise<string | null>;
  startNewSession: () => Promise<void>;
  startNewChat: () => Promise<void>;
  closeNewChatDialog: () => void;
  deleteSession: (id: string) => Promise<void>;
  clearLane: (sessionId: string, opts?: { force?: boolean }) => Promise<ChatClearResult>;
  cancelClear: (sessionId: string) => Promise<void>;
  setLaneOrchestrator: (sessionId: string, selection: SessionOrchestrator) => Promise<boolean>;
  setCompactionActive: (payload: CompactionActivePayload) => void;
  runOnboardingAutostart: (message: string) => Promise<void>;
  resetOnboardingAutostart: () => void;
  enqueueConfirmation: (action: ConfirmAction) => void;
  resolveConfirmation: (id: string, approved: boolean) => Promise<void>;
  enqueueAskQuestion: (request: AskQuestionRequest) => void;
  resolveAskQuestion: (response: AskQuestionResponse) => Promise<void>;
  setVoiceModeActive: (active: boolean) => void;
  setDraft: (sessionId: string, text: string) => void;
  getDraft: (sessionId: string) => string;
  clearDraft: (sessionId: string) => void;
  setThreadAttachments: (
    sessionId: string,
    update: ChatAttachment[] | ((prev: ChatAttachment[]) => ChatAttachment[]),
  ) => void;
  setScrollPinned: (sessionId: string, pinned: boolean) => void;
  reconcileDanglingActivities: (status: LiveActivityStatus, sessionId?: string) => void;
  toggleActivitiesPanel: (open?: boolean, sessionId?: string) => void;
}

const CLIENT_MESSAGE_ID_FLOOR = 1_000_000_000_000;

export function createThreadState(over: Partial<ThreadState> = {}): ThreadState {
  return {
    messages: [],
    streamingContent: '',
    streamTimeline: [],
    toolCalls: [],
    artifacts: [],
    activities: [],
    activitiesPanelOpen: true,
    currentUsage: null,
    currentContext: null,
    orchestrator: null,
    messageCount: 0,
    isStreaming: false,
    drivePaused: false,
    streamTurnStartedAt: null,
    queueRemaining: 0,
    isCompacting: false,
    compactionPhase: null,
    compactionModelLabel: '',
    isDreaming: false,
    pendingAskQuestions: [],
    pendingConfirmations: [],
    lastError: null,
    submittedUserTurnCount: 0,
    assistantTurnCount: 0,
    assistantTurnEvents: [],
    lastAssistantTurnEvent: null,
    assistantCompletionCount: 0,
    lastCompletedAssistantMessage: null,
    completedAssistantMessages: [],
    attachments: [],
    scrollPinnedToBottom: true,
    hydrated: false,
    ...over,
  };
}

export const EMPTY_THREAD: ThreadState = createThreadState();

export function selectThread(state: Pick<ChatState, 'threads'>, sessionId: string | null | undefined): ThreadState {
  if (!sessionId) return EMPTY_THREAD;
  return state.threads[sessionId] ?? EMPTY_THREAD;
}

export function selectVisibleThread(state: Pick<ChatState, 'threads' | 'currentSessionId'>): ThreadState {
  return selectThread(state, state.currentSessionId);
}

export function useVisibleThread(): ThreadState {
  return useChatStore(selectVisibleThread);
}

export function useThread(sessionId: string | null | undefined): ThreadState {
  return useChatStore((state) => selectThread(state, sessionId));
}

export const NO_LANE_BUCKET = '__sem_lane__';
export const NO_LANE_POPUP_LABEL = 'Origem sem lane';

function popupLabel(
  state: Pick<ChatState, 'openLanes'>,
  sessionId: string,
  payload: { title?: string; laneBadge?: number | null },
): string | null {
  if (sessionId === NO_LANE_BUCKET) return NO_LANE_POPUP_LABEL;
  const lane = state.openLanes.find((l) => l.id === sessionId);
  if (typeof payload.laneBadge === 'number') {
    return laneLabel({ laneBadge: payload.laneBadge, title: payload.title ?? lane?.title ?? '' });
  }
  if (lane) return laneLabel(lane);
  return payload.title ? `Outra conversa: ${payload.title}` : null;
}

let popupCache: {
  threads: Record<string, ThreadState>;
  openLanes: OpenChatSession[];
  result: PendingPopup | null;
} | null = null;

export function selectNextPopup(state: Pick<ChatState, 'threads' | 'openLanes'>): PendingPopup | null {
  if (popupCache && popupCache.threads === state.threads && popupCache.openLanes === state.openLanes) {
    return popupCache.result;
  }
  const result = computeNextPopup(state);
  popupCache = { threads: state.threads, openLanes: state.openLanes, result };
  return result;
}

function computeNextPopup(state: Pick<ChatState, 'threads' | 'openLanes'>): PendingPopup | null {
  let best: PendingPopup | null = null;
  for (const [sessionId, thread] of Object.entries(state.threads)) {
    for (const item of thread.pendingConfirmations) {
      if (best === null || item.sequence < best.sequence) {
        best = {
          kind: 'confirm',
          sessionId,
          label: popupLabel(state, sessionId, item.action),
          sequence: item.sequence,
          action: item.action,
        };
      }
    }
    for (const item of thread.pendingAskQuestions) {
      if (best === null || item.sequence < best.sequence) {
        best = {
          kind: 'ask',
          sessionId,
          label: popupLabel(state, sessionId, item.request),
          sequence: item.sequence,
          request: item.request,
        };
      }
    }
  }
  return best;
}

export function isDesktopSession(session: ChatSession): boolean {
  return (
    (session.type === 'chat' || session.type === 'manual') &&
    !session.taskId &&
    !session.title?.startsWith('[Scheduler]') &&
    !session.id.startsWith('dw-drive-')
  );
}

export function selectLaneBusy(state: Pick<ChatState, 'threads' | 'openLanes'>, sessionId: string): boolean {
  const thread = state.threads[sessionId];
  if (thread) return thread.isStreaming;
  const lane = state.openLanes.find((l) => l.id === sessionId);
  return lane?.state === 'streaming' || lane?.state === 'queued';
}

export function isOpenWithoutLane(session: ChatSession | undefined): boolean {
  return (
    session !== undefined && session.status === 'active' && isDesktopSession(session) && session.laneBadge === null
  );
}

function sameOrchestrator(a: SessionOrchestrator | null, b: SessionOrchestrator | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.runtime === b.runtime && a.provider === b.provider && a.model === b.model && a.effort === b.effort;
}

function threadMetaFor(
  state: Pick<ChatState, 'openLanes' | 'sessions' | 'telegramSessions'>,
  sessionId: string,
): { orchestrator: SessionOrchestrator | null; messageCount: number } | null {
  const lane = state.openLanes.find((l) => l.id === sessionId);
  if (lane) return { orchestrator: lane.orchestrator, messageCount: lane.messageCount };
  const session =
    state.sessions.find((s) => s.id === sessionId) ?? state.telegramSessions.find((s) => s.id === sessionId);
  if (!session) return null;
  return { orchestrator: session.orchestrator ?? null, messageCount: session.messageCount ?? 0 };
}

function withThreadMeta(
  state: Pick<ChatState, 'threads' | 'openLanes' | 'sessions' | 'telegramSessions'>,
): Record<string, ThreadState> {
  let out = state.threads;
  let changed = false;
  for (const [id, thread] of Object.entries(state.threads)) {
    const meta = threadMetaFor(state, id);
    if (!meta) continue;
    if (sameOrchestrator(meta.orchestrator, thread.orchestrator) && meta.messageCount === thread.messageCount) continue;
    if (!changed) {
      out = { ...state.threads };
      changed = true;
    }
    out[id] = { ...thread, orchestrator: meta.orchestrator, messageCount: meta.messageCount };
  }
  return out;
}

function streamingIdsOf(threads: Record<string, ThreadState>): Set<string> {
  const ids = new Set<string>();
  for (const [id, thread] of Object.entries(threads)) {
    if (thread.isStreaming) ids.add(id);
  }
  return ids;
}

function withCompaction(
  state: Pick<ChatState, 'compactingSessionIds' | 'compactions' | 'threads'>,
  sessionId: string,
  info: LaneCompactionInfo | null,
): Pick<ChatState, 'compactingSessionIds' | 'compactions' | 'threads'> {
  const compactingSessionIds = new Set(state.compactingSessionIds);
  const compactions = { ...state.compactions };
  if (info) {
    compactingSessionIds.add(sessionId);
    compactions[sessionId] = info;
  } else {
    compactingSessionIds.delete(sessionId);
    delete compactions[sessionId];
  }
  const thread = state.threads[sessionId];
  const threads = thread
    ? {
        ...state.threads,
        [sessionId]: {
          ...thread,
          isCompacting: info !== null,
          compactionPhase: info?.phase ?? null,
          compactionModelLabel: info?.modelLabel ?? '',
        },
      }
    : state.threads;
  return { compactingSessionIds, compactions, threads };
}

function laneLabelFor(lanes: readonly OpenChatSession[], sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const lane = lanes.find((l) => l.id === sessionId);
  return lane ? laneLabel(lane) : null;
}

export function selectLaneOrchestrator(
  state: Pick<ChatState, 'openLanes' | 'sessions'>,
  sessionId: string | null,
): SessionOrchestrator | null {
  if (!sessionId) return null;
  const lane = state.openLanes.find((l) => l.id === sessionId);
  if (lane) return lane.orchestrator;
  return state.sessions.find((s) => s.id === sessionId)?.orchestrator ?? null;
}

function pushLaneError(code: string | undefined, error: string | undefined, fallbackTitle: string): void {
  useErrorToastStore
    .getState()
    .pushError(
      { code: code ?? null, error: error ?? null },
      { title: laneErrorTitle(code, fallbackTitle), source: 'chat' },
    );
}

function formatClearWarnings(result: Extract<ChatClearResult, { ok: true }>): string {
  return result.warnings.map((w) => `${w.step}: ${w.detail}`).join('\n');
}

let clientMessageSequence = 0;

function nextClientMessageId(): number {
  clientMessageSequence = (clientMessageSequence + 1) % 1000;
  return Date.now() * 1000 + clientMessageSequence;
}

let popupSequence = 0;
let errorSequence = 0;

export const STREAM_SESSION_MISSING_CODE = 'stream_session_missing';
const STREAM_SESSION_MISSING_TOAST_INTERVAL_MS = 60_000;
let lastStreamSessionMissingToastAt = -Infinity;

export function _resetStreamSessionMissingThrottleForTests(): void {
  lastStreamSessionMissingToastAt = -Infinity;
}

function reportStreamChunkWithoutSession(chunk: StreamChunk, now: number = Date.now()): void {
  console.error('chat:stream chunk sem sessionId descartado', chunk.type, chunk.code ?? chunk.error ?? '');
  if (now - lastStreamSessionMissingToastAt < STREAM_SESSION_MISSING_TOAST_INTERVAL_MS) return;
  lastStreamSessionMissingToastAt = now;
  useErrorToastStore
    .getState()
    .pushError({ code: STREAM_SESSION_MISSING_CODE, error: `chunk "${chunk.type}" descartado` }, { source: 'chat' });
}

export function mergeHydratedMessages(server: ChatMessage[], local: ChatMessage[]): ChatMessage[] {
  const serverIds = new Set(server.map((m) => m.id));
  const candidates = local.filter((m) => m.id >= CLIENT_MESSAGE_ID_FLOOR && !serverIds.has(m.id));
  if (candidates.length === 0) return server;
  const tailStart = Math.max(0, server.length - candidates.length);
  const matched = new Set<number>();
  const kept: ChatMessage[] = [];
  for (const candidate of candidates) {
    let found = -1;
    for (let i = tailStart; i < server.length; i += 1) {
      if (matched.has(i)) continue;
      const remote = server[i];
      if (remote.role === candidate.role && remote.content === candidate.content) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      matched.add(found);
      continue;
    }
    kept.push(candidate);
  }
  return kept.length === 0 ? server : [...server, ...kept];
}

function reconcileRunning(activities: LiveActivity[], status: LiveActivityStatus): LiveActivity[] {
  let changed = false;
  const next = activities.map((a) => {
    if (a.status !== 'running') return a;
    changed = true;
    return { ...a, status, endedAt: a.endedAt ?? new Date().toISOString() };
  });
  return changed ? next : activities;
}

export function upsertActivity(activities: LiveActivity[], ev: LiveActivityEvent): LiveActivity[] {
  const status: LiveActivityStatus = ev.status ?? (ev.phase === 'end' ? 'done' : 'running');
  const idx = activities.findIndex((a) => a.id === ev.id);
  if (idx === -1) {
    return [
      ...activities,
      {
        id: ev.id,
        parentId: ev.parentId,
        kind: ev.kind,
        label: ev.label,
        status,
        agentId: ev.agentId,
        toolName: ev.toolName,
        tokens: ev.tokens,
        costUsd: ev.costUsd,
        durationMs: ev.durationMs,
        summary: ev.summary,
        startedAt: ev.startedAt,
        endedAt: ev.endedAt,
        turnIndex: ev.turnIndex,
        description: ev.description,
        file: ev.file,
        command: ev.command,
        filesChanged: ev.filesChanged,
        changed: ev.changed,
        exitCode: ev.exitCode,
        toolUses: ev.toolUses,
        projectId: ev.projectId,
      },
    ];
  }
  const existing = activities[idx];
  const merged: LiveActivity = {
    ...existing,
    parentId: ev.parentId ?? existing.parentId,
    label: ev.label || existing.label,
    status,
    agentId: ev.agentId ?? existing.agentId,
    toolName: ev.toolName ?? existing.toolName,
    tokens: ev.tokens ?? existing.tokens,
    costUsd: ev.costUsd ?? existing.costUsd,
    durationMs: ev.durationMs ?? existing.durationMs,
    summary: ev.summary ?? existing.summary,
    startedAt: existing.startedAt ?? ev.startedAt,
    endedAt: ev.endedAt ?? existing.endedAt,
    turnIndex: ev.turnIndex ?? existing.turnIndex,
    description: ev.description ?? existing.description,
    file: ev.file ?? existing.file,
    command: ev.command ?? existing.command,
    filesChanged: ev.filesChanged ?? existing.filesChanged,
    changed: ev.changed ?? existing.changed,
    exitCode: ev.exitCode ?? existing.exitCode,
    toolUses: ev.toolUses ?? existing.toolUses,
    projectId: ev.projectId ?? existing.projectId,
  };
  const next = activities.slice();
  next[idx] = merged;
  return next;
}

export function flattenBlocksToActivities(blocks: ActivityTurnBlock[]): LiveActivity[] {
  const out: LiveActivity[] = [];
  for (const block of blocks) {
    for (const item of block.items) {
      const status: LiveActivityStatus = item.status === 'running' ? 'stopped' : item.status;
      const withTurn = item.turnIndex === undefined ? { ...item, turnIndex: block.turnIndex } : { ...item };
      out.push({ ...withTurn, status });
    }
  }
  return out;
}

export function deriveTurnStartedAt(activities: LiveActivity[]): number | null {
  let min: number | null = null;
  for (const a of activities) {
    if (a.status !== 'running' || !a.startedAt) continue;
    const t = Date.parse(a.startedAt);
    if (Number.isNaN(t)) continue;
    if (min === null || t < min) min = t;
  }
  return min;
}

function stoppedTurnEvents(thread: ThreadState, sessionId: string): Partial<ThreadState> {
  if (thread.assistantTurnCount >= thread.submittedUserTurnCount) return {};
  const stoppedEvents: AssistantTurnEvent[] = [];
  for (let sequence = thread.assistantTurnCount + 1; sequence <= thread.submittedUserTurnCount; sequence += 1) {
    stoppedEvents.push({ sequence, sessionId, status: 'stopped', content: '' });
  }
  const lastEvent = stoppedEvents[stoppedEvents.length - 1] || thread.lastAssistantTurnEvent;
  return {
    assistantTurnCount: thread.submittedUserTurnCount,
    lastAssistantTurnEvent: lastEvent,
    assistantTurnEvents: [...thread.assistantTurnEvents, ...stoppedEvents].slice(-20),
  };
}

async function hydrateThreadData(sessionId: string): Promise<{
  messages: ChatMessage[];
  contextUsage: ThreadContext | null;
  activities: LiveActivity[];
}> {
  const [messages, contextUsage] = await Promise.all([
    window.lionclaw.chat.getMessages(sessionId),
    window.lionclaw.chat.getContextUsage(sessionId).catch(() => null),
  ]);
  let activities: LiveActivity[] = [];
  try {
    activities = flattenBlocksToActivities(await window.lionclaw.activity.getBlocks(sessionId));
  } catch {
    activities = [];
  }
  return { messages, contextUsage, activities };
}

export const useChatStore = create<ChatState>((set, get) => {
  let openLanesRequest = 0;
  const pendingTextByThread = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> | null }>();

  const patchThread = (sessionId: string, patch: ThreadPatch): void => {
    set((state) => {
      const current = state.threads[sessionId] ?? createThreadState(threadMetaFor(state, sessionId) ?? {});
      const delta = typeof patch === 'function' ? patch(current) : patch;
      const nextThread = { ...current, ...delta };
      const threads = { ...state.threads, [sessionId]: nextThread };
      const streamingChanged = nextThread.isStreaming !== current.isStreaming || !state.threads[sessionId];
      return streamingChanged ? { threads, streamingSessionIds: streamingIdsOf(threads) } : { threads };
    });
  };

  const dropThread = (sessionId: string): void => {
    const pending = pendingTextByThread.get(sessionId);
    if (pending?.timer !== null && pending?.timer !== undefined) clearTimeout(pending.timer);
    pendingTextByThread.delete(sessionId);
    set((state) => {
      if (!state.threads[sessionId]) return state;
      const { [sessionId]: _, ...threads } = state.threads;
      return { threads, streamingSessionIds: streamingIdsOf(threads) };
    });
  };

  const flushPendingText = (sessionId: string): void => {
    const pending = pendingTextByThread.get(sessionId);
    if (!pending) return;
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (!pending.text) return;
    const content = pending.text;
    pending.text = '';
    patchThread(sessionId, (thread) => ({
      streamingContent: thread.streamingContent + content,
      streamTimeline: appendTimelineText(thread.streamTimeline, content),
      streamTurnStartedAt: thread.isStreaming ? (thread.streamTurnStartedAt ?? Date.now()) : thread.streamTurnStartedAt,
    }));
  };

  const enqueueText = (sessionId: string, content: string): void => {
    let pending = pendingTextByThread.get(sessionId);
    if (!pending) {
      pending = { text: '', timer: null };
      pendingTextByThread.set(sessionId, pending);
    }
    pending.text += content;
    if (pending.timer === null) {
      pending.timer = setTimeout(() => flushPendingText(sessionId), 32);
    }
  };

  const hydrateThread = async (sessionId: string): Promise<void> => {
    const data = await hydrateThreadData(sessionId);
    patchThread(sessionId, (thread) => {
      const activities =
        data.activities.length > 0 || thread.activities.length === 0 ? data.activities : thread.activities;
      return {
        messages: mergeHydratedMessages(data.messages, thread.messages),
        activities,
        currentContext: data.contextUsage,
        streamTurnStartedAt: thread.streamTurnStartedAt ?? deriveTurnStartedAt(activities),
        hydrated: true,
      };
    });
  };

  const removePopup = (predicate: (thread: ThreadState) => Partial<ThreadState> | null): void => {
    set((state) => {
      let threads = state.threads;
      let changed = false;
      for (const [id, thread] of Object.entries(state.threads)) {
        const delta = predicate(thread);
        if (!delta) continue;
        if (!changed) {
          threads = { ...state.threads };
          changed = true;
        }
        threads[id] = { ...thread, ...delta };
      }
      return changed ? { threads } : state;
    });
  };

  return {
    sessions: [],
    telegramSessions: [],
    openLanes: [],
    compactingSessionIds: new Set<string>(),
    compactions: {},
    staleLaneDays: DEFAULT_CHAT_STALE_LANE_DAYS,
    newChatDialogOpen: false,
    currentSessionId: null,
    threads: {},
    streamingSessionIds: new Set<string>(),
    voiceModeActive: false,
    onboardingAutostartSessionId: null,
    drafts: {},

    loadSessions: async () => {
      const [allSessions, openLanes] = await Promise.all([window.lionclaw.chat.getSessions(), get().loadOpenLanes()]);
      const desktopSessions = allSessions.filter(isDesktopSession);
      const telegramSessions = allSessions.filter((s) => s.type === 'telegram' && s.status === 'active').slice(0, 1);
      set((state) => ({
        sessions: desktopSessions,
        telegramSessions,
        threads: withThreadMeta({ ...state, sessions: desktopSessions, telegramSessions }),
      }));
      const { currentSessionId } = get();
      if (currentSessionId) return;
      const preferred = pickMostRecentLane(openLanes);
      if (preferred) await get().selectSession(preferred.id);
    },

    setDrivePausedForSession: (sessionId, paused) => {
      if (get().threads[sessionId]) patchThread(sessionId, { drivePaused: paused });
    },

    loadOpenLanes: async () => {
      const request = ++openLanesRequest;
      let failure: string;
      try {
        const lanes = await window.lionclaw.chat.listOpenSessions();
        if (request !== openLanesRequest) return get().openLanes;
        if (Array.isArray(lanes)) {
          set((state) => ({ openLanes: lanes, threads: withThreadMeta({ ...state, openLanes: lanes }) }));
          return lanes;
        }
        failure = lanes.error;
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      if (request !== openLanesRequest) return get().openLanes;
      console.error('listOpenSessions failed:', failure);
      useErrorToastStore
        .getState()
        .pushError({ error: failure }, { title: `Nao foi possivel carregar as lanes: ${failure}`, source: 'chat' });
      return get().openLanes;
    },

    applySessionUpdated: (event) => {
      const { openLanes } = get();
      const idx = openLanes.findIndex((lane) => lane.id === event.sessionId);
      if (event.laneBadge === null) {
        if (idx >= 0) set({ openLanes: openLanes.filter((lane) => lane.id !== event.sessionId) });
      } else if (idx >= 0) {
        const next = openLanes.slice();
        next[idx] = {
          ...next[idx],
          laneBadge: event.laneBadge,
          orchestrator: event.orchestrator,
          messageCount: event.messageCount,
          state: event.state,
        };
        set({ openLanes: next });
      } else {
        void get().loadOpenLanes();
      }
      set((state) => {
        const sessions = state.sessions.map((s) =>
          s.id === event.sessionId
            ? {
                ...s,
                laneBadge: event.laneBadge,
                orchestrator: event.orchestrator,
                messageCount: event.messageCount,
                state: event.state,
              }
            : s,
        );
        const thread = state.threads[event.sessionId];
        const threads = thread
          ? {
              ...state.threads,
              [event.sessionId]: { ...thread, orchestrator: event.orchestrator, messageCount: event.messageCount },
            }
          : state.threads;
        return { sessions, threads };
      });
    },

    setStaleLaneDays: (days) => set({ staleLaneDays: normalizeStaleLaneDays(days) }),

    selectSession: async (id: string) => {
      const { currentSessionId } = get();
      if (id === currentSessionId) return;
      set({ currentSessionId: id });
      const existing = get().threads[id];
      if (!existing) patchThread(id, {});
      if (existing?.hydrated) return;
      await hydrateThread(id);
    },

    sendMessage: async (message, agentId, attachments, targetSessionId) => {
      const { sessions } = get();
      let currentSessionId: string | null = targetSessionId ?? get().currentSessionId;

      if (currentSessionId) {
        const session =
          sessions.find((s) => s.id === currentSessionId) ??
          get().telegramSessions.find((s) => s.id === currentSessionId);
        if (session && (session.status !== 'active' || session.type === 'telegram')) return;
        if (isOpenWithoutLane(session)) {
          pushLaneError('lane_required', 'De Clear nesta conversa ou escolha uma lane.', 'Conversa aberta sem lane');
          return;
        }
      }

      if (currentSessionId === null) {
        const lanes = await get().loadOpenLanes();
        const fallback = pickMostRecentLane(lanes);
        if (fallback) {
          await get().selectSession(fallback.id);
          currentSessionId = fallback.id;
        } else {
          const created = await get().createLane();
          if (!created) return;
          currentSessionId = created;
        }
      }
      if (currentSessionId === null) return;
      const laneSessionId: string = currentSessionId;
      const wasStreaming = selectThread(get(), laneSessionId).isStreaming;

      const userMsg: ChatMessage = {
        id: nextClientMessageId(),
        sessionId: laneSessionId,
        role: 'user',
        content: message,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        createdAt: new Date().toISOString(),
      };

      if (wasStreaming) {
        patchThread(laneSessionId, (thread) => ({
          messages: [...thread.messages, userMsg],
          submittedUserTurnCount: thread.submittedUserTurnCount + 1,
          queueRemaining: thread.queueRemaining + 1,
        }));
      } else {
        patchThread(laneSessionId, (thread) => ({
          messages: [...thread.messages, userMsg],
          streamingContent: '',
          streamTimeline: [],
          isStreaming: true,
          toolCalls: [],
          currentUsage: null,
          submittedUserTurnCount: thread.submittedUserTurnCount + 1,
          streamTurnStartedAt: Date.now(),
          scrollPinnedToBottom: true,
        }));
        useRepoGraphStore.getState().resetTurnFlags(laneSessionId);
      }

      const togglesStore = useChatFeatureTogglesStore.getState();
      togglesStore.recordSend({ sessionId: laneSessionId, message, agentId, attachments });
      const featureToggles = togglesStore.snapshotForSend(laneSessionId);
      const laneOrchestrator = selectLaneOrchestrator(get(), laneSessionId);

      const ack = await window.lionclaw.chat.send(message, {
        sessionId: laneSessionId,
        agentId,
        ...(laneOrchestrator ? { model: laneOrchestrator.model } : {}),
        ...(laneOrchestrator?.effort ? { effort: laneOrchestrator.effort } : {}),
        attachments,
        featureToggles,
      });
      if (ack && ack.accepted === false) {
        if (wasStreaming) {
          patchThread(laneSessionId, (thread) => ({ queueRemaining: Math.max(0, thread.queueRemaining - 1) }));
        } else {
          patchThread(laneSessionId, { isStreaming: false, streamTurnStartedAt: null });
        }
        if (ack.code || ack.error) {
          pushLaneError(ack.code, ack.error, 'Mensagem recusada');
        }
      }
    },

    stopStreaming: async (sessionId) => {
      const target = sessionId ?? get().currentSessionId;
      if (!target) return;
      flushPendingText(target);
      await window.lionclaw.chat.stop(target);
      patchThread(target, (thread) => ({
        isStreaming: false,
        streamTurnStartedAt: null,
        queueRemaining: 0,
        activities: reconcileRunning(thread.activities, 'stopped'),
        ...stoppedTurnEvents(thread, target),
      }));
    },

    handleStreamChunk: (chunk: StreamChunk) => {
      const { currentSessionId } = get();

      if (chunk.type === 'onboarding_completed') {
        import('./auth-store').then(({ useAuthStore }) => {
          useAuthStore.getState().checkOnboarding();
        });
        return;
      }

      const sessionId =
        chunk.sessionId ?? (chunk.type === 'session' || chunk.type === 'done' ? chunk.content || undefined : undefined);
      if (!sessionId) {
        reportStreamChunkWithoutSession(chunk);
        return;
      }
      const visible = sessionId === currentSessionId;

      if (chunk.type !== 'text') flushPendingText(sessionId);

      switch (chunk.type) {
        case 'text': {
          const thread = get().threads[sessionId];
          if (thread?.isStreaming && thread.streamTurnStartedAt === null) {
            patchThread(sessionId, { streamTurnStartedAt: Date.now() });
          }
          enqueueText(sessionId, chunk.content ?? '');
          break;
        }

        case 'tool_call':
          patchThread(sessionId, (thread) => ({
            toolCalls: [
              ...thread.toolCalls,
              {
                id: chunk.toolCallId,
                tool: chunk.tool!,
                input: chunk.input,
                status: 'running',
              },
            ],
            streamTimeline: appendTimelineTool(thread.streamTimeline, {
              tool: chunk.tool!,
              input: chunk.input,
              toolCallId: chunk.toolCallId,
            }),
            streamTurnStartedAt: thread.isStreaming
              ? (thread.streamTurnStartedAt ?? Date.now())
              : thread.streamTurnStartedAt,
          }));
          break;

        case 'tool_result':
          patchThread(sessionId, (thread) => {
            let index = chunk.toolCallId ? thread.toolCalls.findIndex((call) => call.id === chunk.toolCallId) : -1;
            if (index < 0) {
              for (let candidate = thread.toolCalls.length - 1; candidate >= 0; candidate -= 1) {
                const call = thread.toolCalls[candidate];
                if (call.status === 'running' && call.tool === chunk.tool) {
                  index = candidate;
                  break;
                }
              }
            }
            if (index < 0) return {};
            const toolCalls = [...thread.toolCalls];
            toolCalls[index] = {
              ...toolCalls[index],
              status: chunk.isError ? 'error' : 'done',
              result: chunk.result,
              ...(chunk.input !== undefined ? { input: chunk.input } : {}),
            };
            return {
              toolCalls,
              streamTimeline: applyTimelineToolResult(thread.streamTimeline, {
                tool: chunk.tool,
                toolCallId: chunk.toolCallId,
                result: chunk.result,
                isError: chunk.isError,
              }),
            };
          });
          break;

        case 'artifact':
          if (chunk.artifact) {
            patchThread(sessionId, (thread) => ({ artifacts: [...thread.artifacts, chunk.artifact!] }));
          }
          break;

        case 'context_usage':
          if (chunk.contextUsage) {
            patchThread(sessionId, { currentContext: chunk.contextUsage });
          }
          break;

        case 'usage':
          if (chunk.usage) {
            patchThread(sessionId, { currentUsage: chunk.usage });
            const authoritative = Boolean(
              chunk.usage.runtime &&
              chunk.usage.provider &&
              chunk.usage.model &&
              chunk.usage.costStatus &&
              chunk.usage.tokenStatus,
            );
            if (authoritative) break;
            const usageLane = selectLaneOrchestrator(get(), sessionId);
            if (!usageLane) break;
            void window.lionclaw.settings
              .get()
              .then((settings) => {
                return window.lionclaw.pricing.calculate({
                  runtime: usageLane.runtime,
                  provider: usageLane.provider,
                  model: usageLane.model,
                  presetId: settings.orchestratorOpenAiCompatPreset,
                  inputTokens: chunk.usage!.inputTokens,
                  outputTokens: chunk.usage!.outputTokens,
                  cacheReadTokens: chunk.usage!.cacheReadTokens,
                  cacheCreationTokens: chunk.usage!.cacheCreationTokens,
                });
              })
              .then((result) => {
                patchThread(sessionId, (thread) => ({
                  currentUsage: thread.currentUsage ? { ...thread.currentUsage, costUsd: result.costUsd } : null,
                }));
              })
              .catch(() => {});
          }
          break;

        case 'session': {
          const hadThread = Boolean(get().threads[sessionId]);
          patchThread(sessionId, (thread) => ({
            isStreaming: true,
            queueRemaining: Math.max(0, thread.queueRemaining - 1),
          }));
          const isOpenLane = get().openLanes.some((lane) => lane.id === sessionId);
          if (currentSessionId === null && isOpenLane) set({ currentSessionId: sessionId });
          if (!isOpenLane && !sessionId.startsWith('dw-drive-')) {
            void get().loadOpenLanes();
          }
          if (!hadThread || get().threads[sessionId]?.activities.length === 0) {
            window.lionclaw.activity
              .getBlocks(sessionId)
              .then((blocks) => {
                const hydrated = flattenBlocksToActivities(blocks);
                patchThread(sessionId, (thread) => {
                  const nextActivities =
                    hydrated.length > 0 || thread.activities.length === 0 ? hydrated : thread.activities;
                  return {
                    activities: nextActivities,
                    streamTurnStartedAt: thread.streamTurnStartedAt ?? deriveTurnStartedAt(nextActivities),
                  };
                });
              })
              .catch(() => {});
          } else {
            patchThread(sessionId, (thread) => ({
              streamTurnStartedAt: thread.streamTurnStartedAt ?? deriveTurnStartedAt(thread.activities),
            }));
          }
          get().loadSessions();
          break;
        }

        case 'done': {
          const queueRemaining = chunk.queueRemaining || 0;
          Promise.resolve().then(() => {
            const thread = get().threads[sessionId];
            if (!thread) return;
            const { streamingContent, artifacts, streamTimeline } = thread;
            const terminalTimeline = finishTimeline(streamTimeline, { toolWithoutResult: 'done' });
            const keepStreaming = queueRemaining > 0;
            const clearedError =
              thread.lastError && !thread.lastError.clearedByDone
                ? { ...thread.lastError, clearedByDone: true }
                : thread.lastError;

            if (streamingContent || artifacts.length > 0) {
              const assistantMsg: ChatMessage = {
                id: nextClientMessageId(),
                sessionId,
                role: 'assistant',
                content: streamingContent,
                metadata: {
                  toolCalls:
                    terminalTimeline.length > 0
                      ? timelineToolsForPersistence(terminalTimeline).map((tc) => ({
                          ...tc,
                          input: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
                          durationMs: tc.durationMs ?? 0,
                        }))
                      : undefined,
                  artifacts: artifacts.length > 0 ? [...artifacts] : undefined,
                },
                createdAt: new Date().toISOString(),
              };
              patchThread(sessionId, (t) => {
                const hasPendingTurn = t.assistantTurnCount < t.submittedUserTurnCount;
                const turnSequence = hasPendingTurn ? t.assistantTurnCount + 1 : t.assistantTurnCount;
                const turnEvent: AssistantTurnEvent | null = hasPendingTurn
                  ? {
                      sequence: turnSequence,
                      sessionId,
                      status: streamingContent ? 'completed' : 'empty',
                      content: assistantMsg.content,
                    }
                  : null;
                const nextState: Partial<ThreadState> = {
                  messages: [...t.messages, assistantMsg],
                  streamingContent: '',
                  streamTimeline: [],
                  isStreaming: keepStreaming,
                  drivePaused: false,
                  toolCalls: [],
                  artifacts: [],
                  streamTurnStartedAt: null,
                  queueRemaining,
                  lastError: clearedError,
                  assistantTurnCount: turnSequence,
                  assistantTurnEvents: turnEvent
                    ? [...t.assistantTurnEvents, turnEvent].slice(-20)
                    : t.assistantTurnEvents,
                  lastAssistantTurnEvent: turnEvent || t.lastAssistantTurnEvent,
                };

                if (!streamingContent) return nextState;

                const textSequence = t.assistantCompletionCount + 1;
                const completedAssistantMessage: CompletedAssistantMessage = {
                  id: assistantMsg.id,
                  sessionId,
                  content: assistantMsg.content,
                  sequence: textSequence,
                };
                return {
                  ...nextState,
                  assistantCompletionCount: textSequence,
                  lastCompletedAssistantMessage: completedAssistantMessage,
                  completedAssistantMessages: [...t.completedAssistantMessages, completedAssistantMessage].slice(-20),
                };
              });

              if (streamingContent.length > 0 && get().currentSessionId === sessionId) {
                const { voiceModeActive } = get();
                window.lionclaw.settings.get().then((settings) => {
                  if (!voiceModeActive && settings.voiceResponseEnabled && streamingContent.length < 5000) {
                    const cleanText = streamingContent
                      .replace(/```[\s\S]*?```/g, '')
                      .replace(/`[^`]+`/g, '')
                      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                      .replace(/[#*_~>]/g, '')
                      .replace(/\n{2,}/g, '. ')
                      .replace(/\n/g, ' ')
                      .trim();

                    if (cleanText.length > 10) {
                      window.lionclaw.voice
                        .speak(cleanText, settings.voiceId)
                        .then((result) => {
                          const mimeType = result.format === 'opus' ? 'audio/ogg' : 'audio/mpeg';
                          const audio = new Audio(`data:${mimeType};base64,${result.base64}`);
                          audio.play().catch(() => {});
                        })
                        .catch((err) => console.error('Auto-TTS failed:', err));
                    }
                  }
                });
              }
            } else {
              patchThread(sessionId, (t) => {
                const base: Partial<ThreadState> = {
                  isStreaming: keepStreaming,
                  drivePaused: false,
                  artifacts: [],
                  toolCalls: [],
                  streamTimeline: [],
                  streamTurnStartedAt: null,
                  queueRemaining,
                  lastError: clearedError,
                };
                if (t.assistantTurnCount >= t.submittedUserTurnCount) return base;
                const sequence = t.assistantTurnCount + 1;
                const event: AssistantTurnEvent = { sequence, sessionId, status: 'empty', content: '' };
                return {
                  ...base,
                  assistantTurnCount: sequence,
                  assistantTurnEvents: [...t.assistantTurnEvents, event].slice(-20),
                  lastAssistantTurnEvent: event,
                };
              });
            }
            if (!keepStreaming) get().reconcileDanglingActivities('stopped', sessionId);
            get().loadSessions();
          });
          break;
        }

        case 'replace_content':
          patchThread(sessionId, (thread) => ({
            streamingContent: chunk.content || '',
            streamTimeline: replaceTimelineText(thread.streamTimeline, chunk.content || ''),
          }));
          break;

        case 'ask_question': {
          if (chunk.askRequest) {
            const questionMsg: ChatMessage = {
              id: nextClientMessageId(),
              sessionId,
              role: 'assistant',
              content: '',
              messageType: 'ask_question',
              metadata: { askQuestions: chunk.askRequest.questions },
              createdAt: new Date().toISOString(),
            };
            patchThread(sessionId, (thread) => ({ messages: [...thread.messages, questionMsg] }));
            get().enqueueAskQuestion({ ...chunk.askRequest, sessionId: chunk.askRequest.sessionId ?? sessionId });
          }
          break;
        }

        case 'error': {
          useChatFeatureTogglesStore.getState().handleCapabilityError(sessionId, chunk.code, chunk.error);
          if (!visible) {
            const label = laneLabelFor(get().openLanes, sessionId) ?? 'Outra lane';
            useErrorToastStore
              .getState()
              .pushError(
                { code: chunk.code ?? null, error: chunk.error ?? null },
                { title: `${label}: erro no turno`, source: 'chat' },
              );
          }
          errorSequence += 1;
          const lastError: ThreadError = {
            code: chunk.code,
            error: chunk.error,
            sequence: errorSequence,
            clearedByDone: false,
          };
          patchThread(sessionId, (thread) => {
            const base: Partial<ThreadState> = {
              isStreaming: false,
              streamingContent: '',
              toolCalls: thread.toolCalls.map((call) =>
                call.status === 'running' ? { ...call, status: 'error' as const } : call,
              ),
              streamTimeline: failTimeline(thread.streamTimeline),
              artifacts: [],
              streamTurnStartedAt: null,
              lastError,
              activities: reconcileRunning(thread.activities, 'error'),
            };
            if (thread.assistantTurnCount >= thread.submittedUserTurnCount) return base;
            const sequence = thread.assistantTurnCount + 1;
            const event: AssistantTurnEvent = {
              sequence,
              sessionId,
              status: 'error',
              content: '',
              error: chunk.error || 'Erro desconhecido',
            };
            return {
              ...base,
              assistantTurnCount: sequence,
              assistantTurnEvents: [...thread.assistantTurnEvents, event].slice(-20),
              lastAssistantTurnEvent: event,
            };
          });
          break;
        }

        case 'compacting':
          set((state) =>
            withCompaction(
              state,
              sessionId,
              chunk.isCompacting ? { phase: 'running', modelLabel: '', source: 'sdk' } : null,
            ),
          );
          break;

        case 'dreaming_status':
          patchThread(sessionId, { isDreaming: chunk.isDreaming ?? false });
          break;

        case 'activity': {
          const ev = chunk.activity;
          if (!ev) break;
          patchThread(sessionId, (thread) => ({
            activities: upsertActivity(thread.activities, ev),
            activitiesPanelOpen: ev.phase === 'start' ? true : thread.activitiesPanelOpen,
            streamTurnStartedAt: thread.isStreaming
              ? (thread.streamTurnStartedAt ?? Date.now())
              : thread.streamTurnStartedAt,
          }));
          break;
        }

        case 'assistant_pushed': {
          const pushed = chunk.message;
          if (!pushed) break;
          patchThread(sessionId, (thread) => ({ messages: [...thread.messages, pushed] }));
          break;
        }

        case 'drive_paused':
          get().setDrivePausedForSession(sessionId, true);
          break;

        case 'repo_graph': {
          const rg = chunk.repoGraph;
          if (!rg) break;
          const repoGraphStore = useRepoGraphStore.getState();
          const rgSession = rg.sessionId || sessionId;
          if (rg.source === 'runtime-limited') {
            repoGraphStore.markRuntimeLimited(rgSession);
          } else if (rg.used) {
            repoGraphStore.markUsedInTurn(rgSession);
          }
          break;
        }

        case 'confirm_request':
          if (chunk.confirmAction) {
            get().enqueueConfirmation({
              ...chunk.confirmAction,
              sessionId: chunk.confirmAction.sessionId ?? sessionId,
            });
          }
          break;
      }
    },

    createLane: async () => {
      try {
        const result = await window.lionclaw.chat.createSession();
        if ('error' in result) {
          pushLaneError(result.code, result.error, 'Nao foi possivel abrir a conversa');
          return null;
        }
        const lane = result.session;
        set((state) => ({
          openLanes: state.openLanes.some((l) => l.id === lane.id)
            ? state.openLanes.map((l) => (l.id === lane.id ? lane : l))
            : [...state.openLanes, lane],
          currentSessionId: lane.id,
          threads: {
            ...state.threads,
            [lane.id]: createThreadState({
              orchestrator: lane.orchestrator,
              messageCount: lane.messageCount,
              hydrated: true,
            }),
          },
        }));
        await get().loadSessions();
        return lane.id;
      } catch (err) {
        pushLaneError(undefined, String(err), 'Nao foi possivel abrir a conversa');
        return null;
      }
    },

    startNewSession: async () => {
      await get().createLane();
    },

    startNewChat: async () => {
      const lanes = await get().loadOpenLanes();
      const action = resolveNewChatAction(lanes, get().compactions);
      switch (action.kind) {
        case 'create':
          await get().createLane();
          return;
        case 'select':
          await get().selectSession(action.sessionId);
          return;
        case 'choose':
          set({ newChatDialogOpen: true });
          return;
        case 'disabled':
          useErrorToastStore
            .getState()
            .pushNotice('Novo Chat indisponivel', { tone: 'warning', body: action.reason, source: 'chat' });
          return;
      }
    },

    closeNewChatDialog: () => set({ newChatDialogOpen: false }),

    deleteSession: async (id: string) => {
      const result = await window.lionclaw.chat.deleteSession(id);
      if (result.success) {
        if (get().currentSessionId === id) set({ currentSessionId: null });
        dropThread(id);
        get().loadSessions();
      } else {
        console.error('deleteSession failed:', result.error);
        useErrorToastStore
          .getState()
          .pushError({ error: result.error }, { title: 'Falha ao apagar a conversa', source: 'chat' });
      }
    },

    setLaneOrchestrator: async (sessionId, selection) => {
      let result: Awaited<ReturnType<typeof window.lionclaw.chat.setSessionOrchestrator>>;
      try {
        result = await window.lionclaw.chat.setSessionOrchestrator(sessionId, selection);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err), code: 'invalid_selection' };
      }
      if ('error' in result) {
        pushLaneError(result.code, result.error, 'Nao foi possivel trocar o orquestrador');
        void get().loadOpenLanes();
        return false;
      }
      const orchestrator = result.orchestrator;
      set((state) => {
        const thread = state.threads[sessionId];
        return {
          openLanes: state.openLanes.map((lane) => (lane.id === sessionId ? { ...lane, orchestrator } : lane)),
          sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, orchestrator } : s)),
          threads: thread ? { ...state.threads, [sessionId]: { ...thread, orchestrator } } : state.threads,
        };
      });
      return true;
    },

    clearLane: async (sessionId, opts) => {
      set({ newChatDialogOpen: false });
      const label = laneLabelFor(get().openLanes, sessionId) ?? 'Conversa';
      let result: ChatClearResult;
      try {
        result = await window.lionclaw.chat.clear(sessionId, opts);
      } catch (err) {
        result = { ok: false, code: 'clear_failed', error: String(err) };
      }

      if (!result.ok) {
        pushLaneError(result.code, result.error, `${label}: Clear falhou`);
        set((state) => withCompaction(state, sessionId, null));
        await get().loadSessions();
        return result;
      }

      const wasVisible = get().currentSessionId === sessionId;
      set((state) => withCompaction(state, sessionId, null));
      if (wasVisible) set({ currentSessionId: null });
      dropThread(sessionId);
      if (wasVisible && result.newSessionId) {
        await get().selectSession(result.newSessionId);
      }
      await get().loadSessions();

      const toast = useErrorToastStore.getState();
      if (result.warnings.length > 0) {
        toast.pushNotice(`${label}: Clear concluido com avisos`, {
          tone: 'warning',
          body: formatClearWarnings(result),
          source: 'chat',
          persist: true,
        });
      } else {
        toast.pushNotice(`${label}: Clear concluido`, {
          tone: 'success',
          body: result.newSessionId
            ? 'Memoria salva. A lane recebeu uma conversa nova.'
            : 'Memoria salva. A conversa foi arquivada.',
          source: 'chat',
        });
      }
      if (result.pausedDriveProjectIds.length > 0) {
        toast.pushNotice('Drive pausado', {
          tone: 'warning',
          body: 'O drive do pipeline foi pausado pelo Clear; retome pela pagina Pipeline.',
          source: 'chat',
        });
      }
      return result;
    },

    cancelClear: async (sessionId) => {
      try {
        const result = await window.lionclaw.chat.clearCancel(sessionId);
        if (!result.ok) {
          pushLaneError(result.code, result.error, 'Nao foi possivel cancelar o Clear');
          return;
        }
        set((state) => withCompaction(state, sessionId, null));
      } catch (err) {
        pushLaneError(undefined, String(err), 'Nao foi possivel cancelar o Clear');
      }
    },

    setCompactionActive: (payload) => {
      const sessionId = payload.sessionId ?? get().currentSessionId;
      if (!sessionId) return;
      if (payload.isActive) {
        set((state) =>
          withCompaction(state, sessionId, {
            phase: payload.phase ?? 'running',
            modelLabel: payload.modelLabel ?? '',
            source: 'lionclaw',
          }),
        );
      } else {
        set((state) => withCompaction(state, sessionId, null));
      }
    },

    runOnboardingAutostart: async (message) => {
      if (get().onboardingAutostartSessionId !== null) return;
      set({ onboardingAutostartSessionId: get().currentSessionId ?? '' });
      try {
        await get().sendMessage(message);
        set({ onboardingAutostartSessionId: get().currentSessionId ?? '' });
      } catch (err) {
        console.error('onboarding autostart failed:', err);
        set({ onboardingAutostartSessionId: null });
      }
    },

    resetOnboardingAutostart: () => set({ onboardingAutostartSessionId: null }),

    enqueueConfirmation: (action) => {
      const sessionId = action.sessionId ?? NO_LANE_BUCKET;
      if (!action.sessionId)
        console.error('chat:confirm-request sem sessionId; popup vai para o balde sem lane', action.id);
      const already = Object.values(get().threads).some((thread) =>
        thread.pendingConfirmations.some((item) => item.action.id === action.id),
      );
      if (already) return;
      popupSequence += 1;
      const sequence = popupSequence;
      patchThread(sessionId, (thread) => ({
        pendingConfirmations: [...thread.pendingConfirmations, { sequence, action }],
      }));
    },

    resolveConfirmation: async (id, approved) => {
      await window.lionclaw.chat.confirmResponse(id, approved);
      removePopup((thread) =>
        thread.pendingConfirmations.some((item) => item.action.id === id)
          ? { pendingConfirmations: thread.pendingConfirmations.filter((item) => item.action.id !== id) }
          : null,
      );
    },

    enqueueAskQuestion: (request) => {
      const sessionId = request.sessionId ?? NO_LANE_BUCKET;
      if (!request.sessionId)
        console.error('chat:ask-question sem sessionId; popup vai para o balde sem lane', request.id);
      const already = Object.values(get().threads).some((thread) =>
        thread.pendingAskQuestions.some((item) => item.request.id === request.id),
      );
      if (already) return;
      popupSequence += 1;
      const sequence = popupSequence;
      patchThread(sessionId, (thread) => ({
        pendingAskQuestions: [...thread.pendingAskQuestions, { sequence, request }],
      }));
    },

    resolveAskQuestion: async (response) => {
      await window.lionclaw.chat.askResponse(response);
      removePopup((thread) =>
        thread.pendingAskQuestions.some((item) => item.request.id === response.id)
          ? { pendingAskQuestions: thread.pendingAskQuestions.filter((item) => item.request.id !== response.id) }
          : null,
      );
    },

    setVoiceModeActive: (active) => set({ voiceModeActive: active }),

    setDraft: (sessionId: string, text: string) => {
      set((state) => ({
        drafts: { ...state.drafts, [sessionId]: text },
      }));
    },

    getDraft: (sessionId: string) => {
      return get().drafts[sessionId] || '';
    },

    clearDraft: (sessionId: string) => {
      set((state) => {
        const { [sessionId]: _, ...rest } = state.drafts;
        return { drafts: rest };
      });
    },

    setThreadAttachments: (sessionId, update) => {
      patchThread(sessionId, (thread) => ({
        attachments: typeof update === 'function' ? update(thread.attachments) : update,
      }));
    },

    setScrollPinned: (sessionId, pinned) => {
      const thread = get().threads[sessionId];
      if (thread && thread.scrollPinnedToBottom === pinned) return;
      patchThread(sessionId, { scrollPinnedToBottom: pinned });
    },

    reconcileDanglingActivities: (status, sessionId) => {
      const target = sessionId ?? get().currentSessionId;
      if (!target) return;
      patchThread(target, (thread) => ({ activities: reconcileRunning(thread.activities, status) }));
    },

    toggleActivitiesPanel: (open, sessionId) => {
      const target = sessionId ?? get().currentSessionId;
      if (!target) return;
      patchThread(target, (thread) => ({ activitiesPanelOpen: open ?? !thread.activitiesPanelOpen }));
    },
  };
});
