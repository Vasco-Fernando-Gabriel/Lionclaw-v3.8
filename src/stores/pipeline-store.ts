import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

const MAX_PROJECT_STATES_IN_MEMORY = 20;
import type {
  PipelineProject,
  PipelineMessage,
  PipelineStreamChunk,
  PipelinePhaseChangedEvent,
  PipelineNotesUpdatedEvent,
  PipelineSprintCompleteEvent,
  PipelineProjectUpdatedEvent,
  PipelineMetricsResult,
  ChatAttachment,
  SecurityAgentStatus,
  SecurityAgentStatusEvent,
  RepoManifest,
  PipelineType,
  DriveState,
  StreamTimelineBlock,
} from '@/types';
import type { AuditAgentState, AuditPanelSlots, PipelineAuditAgentProgressEvent } from '@/types/pipeline';
import { isCoderPhaseForProject, isEvaluatorPhaseForProject, conversationPhasesOf } from '@/types/pipeline';
import { useDriveStore } from './drive-store';
import { useErrorToastStore } from './error-toast-store';
import {
  appendTimelineText,
  appendTimelineTool,
  applyTimelineToolResult,
  failTimeline,
  finishTimeline,
  timelineToolsForPersistence,
} from '@/lib/stream-timeline';



export interface SprintStatus {
  index: number;
  name: string;
  verdict: string;
  coderAgentId?: string;
  evaluatorAgentId?: string;
  sprintJsonId?: string;
  sprintId?: string;
  reportPath?: string;
  rounds?: number;
  metrics?: Record<string, unknown>;
}


export interface LivePhaseMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}


export interface PhaseDocumentInfo {
  path: string;
  label: string;
}


export interface ArtifactCacheEntry {
  type: 'markdown' | 'sprints' | 'architecture';
  content?: string;
  sprints?: unknown[];
  phase?: number;
  markdown?: string | null;
  json?: string | null;
}


export interface OpenDesignLockProblem {
  rule: string;
  item: string;
  hint: string;
}

export interface OpenDesignLockRejection {
  problems: OpenDesignLockProblem[];
  problemCount: number;
  lockReportPath: string;
  rejectedAt: string;
}

export interface PerProjectState {
  currentPhase: number | null;
  phaseStatus: string;
  awaitingUser: boolean;
  agentCompleted: boolean;
  phaseMessages: Record<number, PipelineMessage[]>;
  viewingPhase: number | null;
  streamContent: string;
  streamTimeline: StreamTimelineBlock[];
  openDesignLockRejection: OpenDesignLockRejection | null;
  currentToolCalls: Array<{ tool: string; input: unknown; toolCallId?: string; result?: string; isError?: boolean }>;
  isStreaming: boolean;
  streamTurnStartedAt: number | null;
  coderStream: Array<{ type: string; content?: string; tool?: string }>;
  evaluatorStream: Array<{ type: string; content?: string; tool?: string }>;
  currentRound: number;
  currentAgent: string;
  notesPath: string | null;
  notesContent: string | null;
  sprints: SprintStatus[];
  metrics: PipelineMetricsResult | null;
  phaseMetrics: LivePhaseMetrics | null;
  activeDocument: { path: string; content: string } | null;
  phaseDocuments: Record<number, PhaseDocumentInfo | null>;
  selectedSprintTab: number;
  pipelineSprintIndex: number | null;
  error: string | null;
  securityAgentStatuses: SecurityAgentStatus[];
  repoManifest: RepoManifest | null;
  currentModel: string | null;
  auditAgents: Map<string, AuditAgentState>;
  auditPanelSlots: AuditPanelSlots;
  stalled: boolean;
  drivePaused: boolean;
}


interface PipelineState {
  projects: PipelineProject[];
  activeProjectId: string | null;

  projectStates: Map<string, PerProjectState>;

  _lastTouchedAt: Map<string, number>;

  currentPhase: number | null;
  phaseStatus: string;
  awaitingUser: boolean;
  agentCompleted: boolean;

  phaseMessages: Record<number, PipelineMessage[]>;

  viewingPhase: number | null;

  streamContent: string;
  streamTimeline: StreamTimelineBlock[];
  currentToolCalls: Array<{ tool: string; input: unknown; toolCallId?: string; result?: string; isError?: boolean }>;
  isStreaming: boolean;
  streamTurnStartedAt: number | null;

  coderStream: Array<{ type: string; content?: string; tool?: string }>;
  evaluatorStream: Array<{ type: string; content?: string; tool?: string }>;

  currentRound: number;
  currentAgent: string;

  notesPath: string | null;
  notesContent: string | null;

  sprints: SprintStatus[];

  metrics: PipelineMetricsResult | null;

  phaseMetrics: LivePhaseMetrics | null;

  activeDocument: { path: string; content: string } | null;

  phaseDocuments: Record<number, PhaseDocumentInfo | null>;

  selectedSprintTab: number;

  pipelineSprintIndex: number | null;

  error: string | null;

  securityAgentStatuses: SecurityAgentStatus[];

  repoManifest: RepoManifest | null;

  auditAgents: Map<string, AuditAgentState>;
  auditPanelSlots: AuditPanelSlots;

  stalled: boolean;

  currentModel: string | null;

  artifactCache: Record<string, Record<number, ArtifactCacheEntry | undefined>>;

  sprintHistoryCache: Record<string, Record<number, unknown[] | undefined>>;


  getCurrentMessages: () => PipelineMessage[];


  loadProjects: () => Promise<void>;

  loadMetrics: (projectId: string) => Promise<void>;

  createProject: (data: {
    name: string;
    description: string;
    projectPath: string;
    startPhase: number;
    specPath?: string;
    prdPath?: string;
    pipelineType?: PipelineType;
  }) => Promise<string>;

  loadSecurityAgentStatuses: (projectId: string) => Promise<void>;

  loadAuditAgents: (projectId: string) => Promise<void>;

  handleSecurityAgentStatus: (event: SecurityAgentStatusEvent) => void;

  deleteProject: (projectId: string) => Promise<void>;

  setActiveProject: (projectId: string | null) => void;

  openProject: (projectId: string) => Promise<void>;

  closeProject: () => void;

  startPipeline: (startPhase: number) => Promise<void>;

  sendMessage: (message: string, attachments?: ChatAttachment[]) => Promise<void>;

  approvePhase: (metadata?: Record<string, unknown>) => Promise<void>;

  closeDocument: () => void;

  _handleAgentCompleted: (projectId: string) => void;

  _handleDocumentUpdated: (data: { projectId: string; path: string; content: string }) => void;

  confirmDevelopment: () => Promise<void>;

  abortPipeline: () => Promise<void>;

  pausePipeline: () => Promise<void>;

  resumePipeline: () => Promise<void>;

  retryPhase: () => Promise<void>;


  setViewingPhase: (phase: number | null) => void;

  loadPhaseHistory: (projectId: string, phase: number) => Promise<void>;


  openPhaseDocument: (phase: number) => Promise<void>;


  setSelectedSprintTab: (tab: number) => void;


  resetPhase: (projectId: string, phase: number) => Promise<{ ok: boolean; error?: string }>;

  resetSprint: (projectId: string, sprintIndex: number) => Promise<{ ok: boolean; error?: string }>;

  getResetPreview: (projectId: string, target: { phase?: number; sprintIndex?: number }) => Promise<unknown>;

  loadPhaseArtifact: (projectId: string, phase: number) => Promise<void>;

  loadSprintHistory: (projectId: string, sprintIndex: number) => Promise<void>;


  isConversationPhase: (phase: number | null, pipelineType?: string) => boolean;

  isInTechPhase: (projectId: string) => boolean;

  isInExecutionPhase: (projectId: string) => boolean;


  _createEmptyProjectState: () => PerProjectState;

  _setProjectState: (projectId: string, patch: Partial<PerProjectState>) => void;

  _ensureProjectState: (projectId: string) => PerProjectState;

  _hydrateFlatFromMap: (projectId: string) => void;

  _appendStreamText: (projectId: string, text: string) => void;
  _appendStreamTool: (projectId: string, tool: string, input: unknown, toolCallId?: string) => void;
  _applyStreamToolResult: (projectId: string, tool: string, result?: string, isError?: boolean, toolCallId?: string) => void;
  _finalizeAssistantMessage: (projectId: string) => void;
  _appendAgentStream: (projectId: string, agent: string, entry: { type: string; content?: string; tool?: string }) => void;
  _handlePhaseChanged: (event: PipelinePhaseChangedEvent) => void;
  _handleProjectUpdated: (event: PipelineProjectUpdatedEvent) => void;
  _refreshSecuritySummary: (projectId: string) => void;
  _refreshBugOutcome: (projectId: string) => void;
  _handleNotesUpdated: (event: PipelineNotesUpdatedEvent) => void;
  _handleSprintComplete: (event: PipelineSprintCompleteEvent) => void;
  _handleSprintUpdated: (data: { sprintIndex: number; status: string; round: number }) => void;
  _handleSprintRound: (data: { projectId: string; sprintIndex: number; round: number; agent: string }) => void;
  _handleStreamError: (projectId: string, message: string) => void;
  _handleStreamUsage: (projectId: string, usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
  }) => void;
  _invalidateCaches: (projectId: string) => void;

  init: () => () => void;
}


const initialRuntimeState = {
  currentPhase: null as number | null,
  phaseStatus: '',
  awaitingUser: false,
  agentCompleted: false,
  phaseMessages: {} as Record<number, PipelineMessage[]>,
  viewingPhase: null as number | null,
  streamContent: '',
  streamTimeline: [] as StreamTimelineBlock[],
  currentToolCalls: [] as Array<{ tool: string; input: unknown; toolCallId?: string; result?: string; isError?: boolean }>,
  isStreaming: false,
  streamTurnStartedAt: null as number | null,
  coderStream: [] as Array<{ type: string; content?: string; tool?: string }>,
  evaluatorStream: [] as Array<{ type: string; content?: string; tool?: string }>,
  currentRound: 0,
  currentAgent: '',
  notesPath: null as string | null,
  notesContent: null as string | null,
  sprints: [] as SprintStatus[],
  metrics: null as PipelineMetricsResult | null,
  phaseMetrics: null as LivePhaseMetrics | null,
  activeDocument: null as { path: string; content: string } | null,
  phaseDocuments: {} as Record<number, PhaseDocumentInfo | null>,
  selectedSprintTab: 0,
  pipelineSprintIndex: null as number | null,
  error: null as string | null,
  securityAgentStatuses: [] as SecurityAgentStatus[],
  repoManifest: null as RepoManifest | null,
  currentModel: null as string | null,
  auditAgents: new Map<string, AuditAgentState>(),
  auditPanelSlots: [null, null, null] as AuditPanelSlots,
  stalled: false,
  drivePaused: false,
};


function assignAgentToPanel(
  slots: AuditPanelSlots,
  newAgent: string,
  auditAgents: Map<string, AuditAgentState>,
): AuditPanelSlots {
  if (slots.includes(newAgent)) return slots;
  const next: [string | null, string | null, string | null] = [slots[0], slots[1], slots[2]];
  const emptyIdx = next.findIndex(
    (s) => s === null || auditAgents.get(s)?.status === 'completed' || auditAgents.get(s)?.status === 'failed',
  );
  if (emptyIdx >= 0) {
    next[emptyIdx] = newAgent;
    return next as AuditPanelSlots;
  }
  return slots;
}

export { assignAgentToPanel };


export function nextStreamTurnStartedAt(
  cur: Pick<PerProjectState, 'isStreaming' | 'streamTurnStartedAt'> | undefined,
  now: number = Date.now(),
): number {
  return cur?.isStreaming ? (cur.streamTurnStartedAt ?? now) : now;
}


const SECURITY_SUMMARY_REFRESH_DEBOUNCE_MS = 400;
const securitySummaryRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

const BUG_OUTCOME_REFRESH_DEBOUNCE_MS = 400;
const bugOutcomeRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();


export const usePipelineStore = create<PipelineState>()(
  persist(
    (set, get) => ({
  projects: [],
  activeProjectId: null,
  projectStates: new Map<string, PerProjectState>(),
  _lastTouchedAt: new Map<string, number>(),
  artifactCache: {},
  sprintHistoryCache: {},
  ...initialRuntimeState,


  _createEmptyProjectState: (): PerProjectState => ({
    currentPhase: null,
    phaseStatus: '',
    awaitingUser: false,
    agentCompleted: false,
    phaseMessages: {},
    viewingPhase: null,
    streamContent: '',
    streamTimeline: [],
    openDesignLockRejection: null,
    currentToolCalls: [],
    isStreaming: false,
    streamTurnStartedAt: null,
    coderStream: [],
    evaluatorStream: [],
    currentRound: 0,
    currentAgent: '',
    notesPath: null,
    notesContent: null,
    sprints: [],
    metrics: null,
    phaseMetrics: null,
    activeDocument: null,
    phaseDocuments: {},
    selectedSprintTab: 0,
    pipelineSprintIndex: null,
    error: null,
    securityAgentStatuses: [],
    repoManifest: null,
    currentModel: null,
    auditAgents: new Map<string, AuditAgentState>(),
    auditPanelSlots: [null, null, null] as AuditPanelSlots,
    stalled: false,
    drivePaused: false,
  }),

  _setProjectState: (projectId: string, patch: Partial<PerProjectState>) => {
    set((state) => {
      const prev = state.projectStates.get(projectId) ?? get()._createEmptyProjectState();
      const next: PerProjectState = { ...prev, ...patch };
      const newMap = new Map(state.projectStates);
      newMap.set(projectId, next);

      const newTouched = new Map(state._lastTouchedAt);
      newTouched.set(projectId, Date.now());

      if (newMap.size > MAX_PROJECT_STATES_IN_MEMORY) {
        const activeId = state.activeProjectId;
        const candidates = [...newMap.entries()]
          .filter(([id, ps]) => id !== activeId && !ps.isStreaming)
          .sort((a, b) => (newTouched.get(a[0]) ?? 0) - (newTouched.get(b[0]) ?? 0));
        const toRemove = newMap.size - MAX_PROJECT_STATES_IN_MEMORY;
        for (let i = 0; i < toRemove && i < candidates.length; i++) {
          newMap.delete(candidates[i][0]);
          newTouched.delete(candidates[i][0]);
        }
      }

      if (projectId === state.activeProjectId) {
        return { projectStates: newMap, _lastTouchedAt: newTouched, ...patch } as Partial<PipelineState> & { projectStates: Map<string, PerProjectState>; _lastTouchedAt: Map<string, number> };
      }
      return { projectStates: newMap, _lastTouchedAt: newTouched };
    });
  },

  _ensureProjectState: (projectId: string): PerProjectState => {
    const existing = get().projectStates.get(projectId);
    if (existing !== undefined) return existing;
    const empty = get()._createEmptyProjectState();
    set((state) => {
      const newMap = new Map(state.projectStates);
      newMap.set(projectId, empty);
      return { projectStates: newMap };
    });
    return empty;
  },

  _hydrateFlatFromMap: (projectId: string): void => {
    const entry = get().projectStates.get(projectId);
    if (!entry) return;
    set({
      currentPhase: entry.currentPhase,
      phaseStatus: entry.phaseStatus,
      awaitingUser: entry.awaitingUser,
      agentCompleted: entry.agentCompleted,
      phaseMessages: entry.phaseMessages,
      viewingPhase: entry.viewingPhase,
      streamContent: entry.streamContent,
      streamTimeline: entry.streamTimeline,
      currentToolCalls: entry.currentToolCalls,
      isStreaming: entry.isStreaming,
      streamTurnStartedAt: entry.streamTurnStartedAt,
      coderStream: entry.coderStream,
      evaluatorStream: entry.evaluatorStream,
      currentRound: entry.currentRound,
      currentAgent: entry.currentAgent,
      notesPath: entry.notesPath,
      notesContent: entry.notesContent,
      sprints: entry.sprints,
      metrics: entry.metrics,
      phaseMetrics: entry.phaseMetrics,
      activeDocument: entry.activeDocument,
      phaseDocuments: entry.phaseDocuments,
      selectedSprintTab: entry.selectedSprintTab,
      pipelineSprintIndex: entry.pipelineSprintIndex,
      error: entry.error,
      securityAgentStatuses: entry.securityAgentStatuses,
      repoManifest: entry.repoManifest,
      currentModel: entry.currentModel,
      auditAgents: entry.auditAgents,
      auditPanelSlots: entry.auditPanelSlots,
      stalled: entry.stalled,
    });
  },


  getCurrentMessages: () => {
    const { phaseMessages, viewingPhase, currentPhase } = get();
    const phase = viewingPhase ?? currentPhase;
    if (phase === null) return [];
    return phaseMessages[phase] ?? [];
  },


  loadProjects: async () => {
    try {
      const projects = await window.lionclaw.pipeline.listProjects();
      set({ projects });
      for (const p of projects) {
        if (p.status !== 'running' && p.status !== 'paused') continue;
        const cur = get().projectStates.get(p.id);
        if (cur && (cur.isStreaming || cur.phaseStatus !== 'idle')) continue;
        get()._setProjectState(p.id, {
          currentPhase: p.currentPhase ?? cur?.currentPhase ?? null,
          phaseStatus: p.status,
          awaitingUser: p.awaitingUser ?? cur?.awaitingUser ?? false,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  loadMetrics: async (projectId: string) => {
    try {
      const result = await window.lionclaw.pipeline.getMetrics(projectId);
      if ('error' in result) {
        get()._setProjectState(projectId, { error: result.error });
      } else {
        get()._setProjectState(projectId, { metrics: result });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      get()._setProjectState(projectId, { error: message });
    }
  },


  createProject: async (data) => {
    const result = await window.lionclaw.pipeline.createProject({
      name: data.name,
      description: data.description,
      projectPath: data.projectPath,
      startPhase: data.startPhase,
      specPath: data.specPath,
      prdPath: data.prdPath,
      pipelineType: data.pipelineType,
    });
    if ('error' in result) {
      throw new Error(`Falha ao criar projeto: ${result.error}`);
    }
    await get().loadProjects();
    return result.id;
  },

  loadSecurityAgentStatuses: async (projectId: string) => {
    try {
      const result = await window.lionclaw.pipeline.getSecurityAgentStatus(projectId);
      if (Array.isArray(result)) {
        get()._setProjectState(projectId, {
          securityAgentStatuses: result as SecurityAgentStatus[],
        });
      }
    } catch {
    }
  },

  loadAuditAgents: async (projectId: string) => {
    try {
      const result = await window.lionclaw.pipeline.getAuditAgentsState(projectId);
      if ('error' in result) {
        console.warn('[pipeline-store] loadAuditAgents error:', result.error);
        useErrorToastStore
          .getState()
          .pushError({ error: result.error }, { title: 'Falha ao carregar agentes de auditoria', source: 'pipeline' });
        return;
      }
      const agentsList = result.agents;
      const existingMap = get().projectStates.get(projectId)?.auditAgents ?? new Map<string, AuditAgentState>();
      const map = new Map<string, AuditAgentState>();
      for (const a of agentsList) {
        const startedAtMs = a.startedAt ? Date.parse(a.startedAt) : undefined;
        const completedAtMs = a.completedAt ? Date.parse(a.completedAt) : undefined;
        const slug = a.agentSlug ?? (a.agentId.replace(/^security-/, '').split('-')[0] ?? a.agentId);
        const prior = existingMap.get(a.agentId);
        map.set(a.agentId, {
          agentId: a.agentId,
          slug,
          name: a.agentName,
          model: a.model,
          runtime: (a.runtime as AuditAgentState['runtime']) ?? prior?.runtime ?? null,
          status: a.status as AuditAgentState['status'],
          streamContent: prior?.streamContent ?? '',
          toolCalls: prior?.toolCalls ?? [],
          filesAnalyzed: a.filesAnalyzed ?? prior?.filesAnalyzed ?? 0,
          additionalFilesAfterStart: a.additionalFilesAfterStart ?? prior?.additionalFilesAfterStart ?? 0,
          toolCallsCount: a.toolCallsCount,
          costUsd: a.costUsd,
          durationMs: a.durationMs,
          findingsCount: a.findingsCount,
          startedAt: startedAtMs,
          completedAt: completedAtMs,
        });
      }
      const cur = get().projectStates.get(projectId);
      get()._setProjectState(projectId, {
        auditAgents: map,
        auditPanelSlots: cur?.auditPanelSlots ?? ([null, null, null] as AuditPanelSlots),
      });
    } catch (err) {
      console.error('[pipeline-store] loadAuditAgents failed:', err);
      useErrorToastStore
        .getState()
        .pushError({ error: String(err) }, { title: 'Falha ao carregar agentes de auditoria', source: 'pipeline' });
    }
  },

  handleSecurityAgentStatus: (event: SecurityAgentStatusEvent) => {
    const cur = get().projectStates.get(event.projectId) ?? get()._createEmptyProjectState();
    const existing = cur.securityAgentStatuses.findIndex((a) => a.agentId === event.agentId);
    const updated: SecurityAgentStatus = {
      agentId: event.agentId,
      agentName: event.agentName,
      status: event.status,
      findingsCount: event.findingsCount ?? 0,
      error: event.error,
    };
    let updatedStatuses: SecurityAgentStatus[];
    if (existing !== -1) {
      updatedStatuses = [...cur.securityAgentStatuses];
      updatedStatuses[existing] = { ...updatedStatuses[existing], ...updated };
    } else {
      updatedStatuses = [...cur.securityAgentStatuses, updated];
    }
    get()._setProjectState(event.projectId, { securityAgentStatuses: updatedStatuses });
  },

  deleteProject: async (projectId: string) => {
    try {
      const result = await window.lionclaw.pipeline.deleteProject(projectId);
      if ('error' in result) {
        set({ error: result.error });
        return;
      }
      useDriveStore.getState()._apply(projectId, null);
      set((state) => {
        const newStates = new Map(state.projectStates);
        newStates.delete(projectId);
        const newTouched = new Map(state._lastTouchedAt);
        newTouched.delete(projectId);
        return {
          projects: state.projects.filter((p) => p.id !== projectId),
          projectStates: newStates,
          _lastTouchedAt: newTouched,
          ...(state.activeProjectId === projectId
            ? { activeProjectId: null, ...initialRuntimeState }
            : {}),
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },


  setActiveProject: (projectId) => {
    if (projectId === null) {
      set({ activeProjectId: null, ...initialRuntimeState });
      return;
    }
    const existing = get().projectStates.get(projectId);
    if (!existing) {
      get()._ensureProjectState(projectId);
    }
    set({ activeProjectId: projectId });
    get()._hydrateFlatFromMap(projectId);
    if (!existing || (existing.currentPhase === null && existing.phaseStatus === '')) {
      void get().openProject(projectId);
    }
  },

  openProject: async (projectId: string) => {
    get()._ensureProjectState(projectId);
    set({ activeProjectId: projectId });
    get()._hydrateFlatFromMap(projectId);
    try {
      const result = await window.lionclaw.pipeline.getProject(projectId);
      if ('error' in result) {
        get()._setProjectState(projectId, { error: result.error });
        return;
      }

      const sprintsHydrated = Array.isArray(result.sprints) && result.sprints.length > 0
        ? result.sprints.map((s: { index: number; name: string; status?: string; coderAgentId?: string; evaluatorAgentId?: string; sprintJsonId?: string; sprintId?: string; rounds?: number; metrics?: Record<string, unknown> }) => ({
            index: s.index,
            name: s.name,
            verdict: s.status ?? '',
            coderAgentId: s.coderAgentId,
            evaluatorAgentId: s.evaluatorAgentId,
            sprintJsonId: s.sprintJsonId,
            sprintId: s.sprintId,
            rounds: s.rounds,
            metrics: s.metrics,
          }))
        : [];

      const clearStaleStream =
        result.status !== 'running'
          ? {
              isStreaming: false,
              streamContent: '',
              streamTimeline: [],
              currentToolCalls: [],
              streamTurnStartedAt: null,
            }
          : {};
      get()._setProjectState(projectId, {
        currentPhase: result.currentPhase,
        phaseStatus: result.status,
        awaitingUser: result.awaitingUser ?? false,
        agentCompleted: false,
        ...clearStaleStream,
        ...(sprintsHydrated.length > 0 ? { sprints: sprintsHydrated } : {}),
      });

      if (result.currentPhase !== null) {
        try {
          const msgs = await window.lionclaw.pipeline.getPhaseMessages(projectId, result.currentPhase);
          if (Array.isArray(msgs) && msgs.length > 0) {
            const cur = get().projectStates.get(projectId) ?? get()._createEmptyProjectState();
            const phase = result.currentPhase as number;
            const existingMsgs: PipelineMessage[] = cur.phaseMessages[phase] ?? [];
            const dedupeKey = (m: PipelineMessage) => `${m.role}::${m.content.slice(0, 50)}`;
            const existingKeys = new Set(existingMsgs.map(dedupeKey));
            const newMsgs = (msgs as PipelineMessage[]).filter((m) => !existingKeys.has(dedupeKey(m)));
            const merged = [...existingMsgs, ...newMsgs];
            get()._setProjectState(projectId, {
              phaseMessages: {
                ...cur.phaseMessages,
                [phase]: merged,
              },
            });
          }
        } catch {
        }
      }

      if (result.pipelineType === 'security') {
        try {
          const manifest = await window.lionclaw.pipeline.readManifest(projectId);
          if (manifest) {
            get()._setProjectState(projectId, { repoManifest: manifest as RepoManifest });
          }
        } catch {
        }
        void get().loadAuditAgents(projectId);
      }

      if (result.pipelineType === 'bug') {
        void get().loadAuditAgents(projectId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      get()._setProjectState(projectId, { error: message });
    }
  },

  closeProject: () => {
    set({
      activeProjectId: null,
      ...initialRuntimeState,
    });
  },


  startPipeline: async (startPhase: number) => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set({ error: null });
    try {
      const result = await window.lionclaw.pipeline.start(activeProjectId, startPhase);
      if ('error' in result) {
        set({ error: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  sendMessage: async (message: string, attachments?: ChatAttachment[]) => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    const userMsg: PipelineMessage = {
      role: 'user',
      content: message,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    const cur = get().projectStates.get(activeProjectId);
    const phase = cur?.currentPhase ?? null;
    const streamTurnStartedAt = nextStreamTurnStartedAt(cur);
    if (phase === null) {
      get()._setProjectState(activeProjectId, { isStreaming: true, streamTurnStartedAt, error: null });
    } else {
      const existing = cur?.phaseMessages[phase] ?? [];
      get()._setProjectState(activeProjectId, {
        phaseMessages: {
          ...(cur?.phaseMessages ?? {}),
          [phase]: [...existing, userMsg],
        },
        isStreaming: true,
        streamTurnStartedAt,
        error: null,
      });
    }
    try {
      const result = await window.lionclaw.pipeline.send(activeProjectId, message, attachments);
      if ('error' in result) {
        get()._setProjectState(activeProjectId, { error: result.error, isStreaming: false, streamTurnStartedAt: null });
      }
    } catch (err) {
      const message_ = err instanceof Error ? err.message : String(err);
      get()._setProjectState(activeProjectId, { error: message_, isStreaming: false, streamTurnStartedAt: null });
    }
  },

  approvePhase: async (metadata?: Record<string, unknown>) => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set({ error: null });
    try {
      const result = await window.lionclaw.pipeline.approve(activeProjectId, metadata);
      if ('error' in result) {
        set({ error: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  confirmDevelopment: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set({ error: null });
    try {
      const result = await window.lionclaw.pipeline.confirmDevelopment(activeProjectId);
      if ('error' in result) {
        set({ error: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  abortPipeline: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set({ error: null });
    try {
      const result = await window.lionclaw.pipeline.abort(activeProjectId);
      if ('error' in result) {
        set({ error: result.error });
      } else {
        set({ ...initialRuntimeState });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  pausePipeline: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set({ error: null });
    try {
      const result = await window.lionclaw.pipeline.pause(activeProjectId);
      if ('error' in result) {
        set({ error: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  resumePipeline: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set({ error: null });
    try {
      const result = await window.lionclaw.pipeline.resume(activeProjectId);
      if ('error' in result) {
        set({ error: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  retryPhase: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set({ error: null });
    try {
      const result = await window.lionclaw.pipeline.retry(activeProjectId);
      if ('error' in result) {
        set({ error: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },


  setViewingPhase: (phase: number | null) => {
    const { activeProjectId } = get();
    if (activeProjectId) {
      get()._setProjectState(activeProjectId, { viewingPhase: phase });
    } else {
      set({ viewingPhase: phase });
    }
  },

  loadPhaseHistory: async (projectId: string, phase: number) => {
    try {
      const msgs = await window.lionclaw.pipeline.getPhaseMessages(projectId, phase);
      if (Array.isArray(msgs)) {
        const cur = get().projectStates.get(projectId);
        get()._setProjectState(projectId, {
          phaseMessages: {
            ...(cur?.phaseMessages ?? {}),
            [phase]: msgs as PipelineMessage[],
          },
        });
      }
    } catch {
    }
  },


  openPhaseDocument: async (phase: number) => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    const projectState = get().projectStates.get(activeProjectId);
    const phaseDocuments = projectState?.phaseDocuments ?? get().phaseDocuments;
    const docInfo = phaseDocuments[phase];
    if (!docInfo) return;
    try {
      const result = await window.lionclaw.pipeline.readPhaseDocument(activeProjectId, phase);
      if ('error' in result) {
        get()._setProjectState(activeProjectId, { error: result.error });
        return;
      }
      get()._setProjectState(activeProjectId, {
        activeDocument: { path: result.path, content: result.content },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      get()._setProjectState(activeProjectId, { error: message });
    }
  },


  setSelectedSprintTab: (tab: number) => {
    const { activeProjectId } = get();
    if (activeProjectId) {
      get()._setProjectState(activeProjectId, { selectedSprintTab: tab });
    } else {
      set({ selectedSprintTab: tab });
    }
  },


  resetPhase: async (projectId: string, phase: number) => {
    try {
      const result = await window.lionclaw.pipeline.resetPhase(projectId, phase) as { ok: boolean; error?: string };
      if (result.ok) {
        get()._invalidateCaches(projectId);
        await get().openProject(projectId);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      return { ok: false, error: message };
    }
  },

  resetSprint: async (projectId: string, sprintIndex: number) => {
    try {
      const result = await window.lionclaw.pipeline.resetSprint(projectId, sprintIndex) as { ok: boolean; error?: string };
      if (result.ok) {
        get()._invalidateCaches(projectId);
        await get().openProject(projectId);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      return { ok: false, error: message };
    }
  },

  getResetPreview: async (projectId: string, target: { phase?: number; sprintIndex?: number }) => {
    try {
      return await window.lionclaw.pipeline.getResetPreview(projectId, target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      return null;
    }
  },

  loadPhaseArtifact: async (projectId: string, phase: number) => {
    const cached = get().artifactCache[projectId]?.[phase];
    if (cached !== undefined) return;
    try {
      const result = await window.lionclaw.pipeline.readPhaseArtifact(projectId, phase);
      if (!result || 'error' in result) return;
      set((state) => ({
        artifactCache: {
          ...state.artifactCache,
          [projectId]: {
            ...(state.artifactCache[projectId] ?? {}),
            [phase]: result as ArtifactCacheEntry,
          },
        },
      }));
    } catch {
    }
  },

  loadSprintHistory: async (projectId: string, sprintIndex: number) => {
    const cached = get().sprintHistoryCache[projectId]?.[sprintIndex];
    if (cached !== undefined && cached.length > 0) return;
    try {
      const result = await window.lionclaw.pipeline.getSprintHistory(projectId, sprintIndex) as unknown[] | { error: string } | null;
      if (!result || 'error' in result) return;
      set((state) => ({
        sprintHistoryCache: {
          ...state.sprintHistoryCache,
          [projectId]: {
            ...(state.sprintHistoryCache[projectId] ?? {}),
            [sprintIndex]: result as unknown[],
          },
        },
      }));
    } catch {
    }
  },


  isConversationPhase: (phase: number | null, pipelineType?: string) => {
    if (phase === null) return false;
    return conversationPhasesOf(pipelineType).has(phase);
  },

  isInTechPhase: (projectId: string) => {
    const { activeProjectId, currentPhase } = get();
    if (activeProjectId !== projectId || currentPhase === null) return false;
    return currentPhase >= 5 && currentPhase <= 8;
  },

  isInExecutionPhase: (projectId: string) => {
    const { activeProjectId, currentPhase } = get();
    if (activeProjectId !== projectId || currentPhase === null) return false;
    return currentPhase >= 11 && currentPhase <= 14;
  },


  _invalidateCaches: (projectId: string) => {
    set((state) => {
      const newArtifactCache = { ...state.artifactCache };
      delete newArtifactCache[projectId];
      const newSprintHistoryCache = { ...state.sprintHistoryCache };
      delete newSprintHistoryCache[projectId];
      return { artifactCache: newArtifactCache, sprintHistoryCache: newSprintHistoryCache };
    });
  },


  _appendStreamText: (projectId: string, text: string) => {
    const cur = get().projectStates.get(projectId) ?? get()._createEmptyProjectState();
    get()._setProjectState(projectId, {
      streamContent: cur.streamContent + text,
      streamTimeline: appendTimelineText(cur.streamTimeline, text),
      isStreaming: true,
      streamTurnStartedAt: nextStreamTurnStartedAt(cur),
    });
  },

  _appendStreamTool: (projectId: string, tool: string, input: unknown, toolCallId?: string) => {
    const cur = get().projectStates.get(projectId) ?? get()._createEmptyProjectState();
    get()._setProjectState(projectId, {
      currentToolCalls: [...cur.currentToolCalls, { tool, input, toolCallId }],
      streamTimeline: appendTimelineTool(cur.streamTimeline, { tool, input, toolCallId }),
    });
  },

  _applyStreamToolResult: (projectId, tool, result, isError, toolCallId) => {
    const cur = get().projectStates.get(projectId) ?? get()._createEmptyProjectState();
    let index = toolCallId
      ? cur.currentToolCalls.findIndex((call) => call.toolCallId === toolCallId)
      : -1;
    if (index < 0 && !toolCallId) {
      const candidates = cur.currentToolCalls
        .map((call, candidate) => ({ call, candidate }))
        .filter(({ call }) => call.tool === tool && call.result === undefined);
      if (candidates.length === 1) index = candidates[0].candidate;
    }
    const currentToolCalls = [...cur.currentToolCalls];
    if (index >= 0) currentToolCalls[index] = { ...currentToolCalls[index], result, isError };
    get()._setProjectState(projectId, {
      currentToolCalls,
      streamTimeline: applyTimelineToolResult(cur.streamTimeline, {
        tool,
        toolCallId,
        result,
        isError,
      }),
    });
  },

  _appendAgentStream: (projectId: string, agent: string, entry: { type: string; content?: string; tool?: string }) => {
    const cur = get().projectStates.get(projectId) ?? get()._createEmptyProjectState();
    const streamTurnStartedAt = nextStreamTurnStartedAt(cur);
    if (agent === 'evaluator') {
      get()._setProjectState(projectId, {
        evaluatorStream: [...cur.evaluatorStream, entry],
        isStreaming: true,
        streamTurnStartedAt,
      });
    } else {
      get()._setProjectState(projectId, {
        coderStream: [...cur.coderStream, entry],
        isStreaming: true,
        streamTurnStartedAt,
      });
    }
  },

  _finalizeAssistantMessage: (projectId: string) => {
    const cur = get().projectStates.get(projectId) ?? get()._createEmptyProjectState();
    if (!cur.streamContent && cur.streamTimeline.length === 0) {
      get()._setProjectState(projectId, { isStreaming: false, streamTurnStartedAt: null });
      return;
    }
    const terminalTimeline = finishTimeline(cur.streamTimeline, { toolWithoutResult: 'done' });
    const msg: PipelineMessage = {
      role: 'assistant',
      content: cur.streamContent,
      toolCalls: terminalTimeline.some((block) => block.kind === 'tool')
        ? timelineToolsForPersistence(terminalTimeline)
        : undefined,
    };
    const phase = cur.currentPhase;
    if (phase === null) {
      get()._setProjectState(projectId, {
        streamContent: '',
        streamTimeline: [],
        currentToolCalls: [],
        isStreaming: false,
        streamTurnStartedAt: null,
      });
      return;
    }
    const existing = cur.phaseMessages[phase] ?? [];
    get()._setProjectState(projectId, {
      phaseMessages: {
        ...cur.phaseMessages,
        [phase]: [...existing, msg],
      },
      streamContent: '',
      streamTimeline: [],
      currentToolCalls: [],
      isStreaming: false,
      streamTurnStartedAt: null,
    });
  },

  _handlePhaseChanged: (event: PipelinePhaseChangedEvent) => {
    get()._finalizeAssistantMessage(event.projectId);

    const cur = get().projectStates.get(event.projectId) ?? get()._createEmptyProjectState();
    const isPhaseTransition = event.phase !== cur.currentPhase;
    const phaseEventPipelineType = get().projects.find((p) => p.id === event.projectId)?.pipelineType;

    const meta = event.metadata ?? {};
    let nextLockRejection = cur.openDesignLockRejection;
    if (meta['openDesignLockRejected'] === true) {
      const rawProblems = Array.isArray(meta['problems']) ? meta['problems'] : [];
      const problems: OpenDesignLockProblem[] = rawProblems
        .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
        .map((p) => ({
          rule: typeof p['rule'] === 'string' ? p['rule'] : '?',
          item: typeof p['item'] === 'string' ? p['item'] : '',
          hint: typeof p['hint'] === 'string' ? p['hint'] : '',
        }));
      nextLockRejection = {
        problems,
        problemCount: typeof meta['problemCount'] === 'number' ? meta['problemCount'] : problems.length,
        lockReportPath: typeof meta['lockReportPath'] === 'string' ? meta['lockReportPath'] : '',
        rejectedAt: new Date().toISOString(),
      };
    } else if (isPhaseTransition && event.phase !== 5) {
      nextLockRejection = null;
    }

    get()._setProjectState(event.projectId, {
      currentPhase: event.phase,
      phaseStatus: event.status,
      awaitingUser: event.awaitingUser,
      agentCompleted: false,
      phaseMetrics: isPhaseTransition ? null : cur.phaseMetrics,
      activeDocument: isPhaseTransition ? null : cur.activeDocument,
      coderStream:
        isPhaseTransition && isCoderPhaseForProject(phaseEventPipelineType, event.phase)
          ? []
          : cur.coderStream,
      evaluatorStream:
        isPhaseTransition && isCoderPhaseForProject(phaseEventPipelineType, event.phase)
          ? []
          : cur.evaluatorStream,
      currentRound: isPhaseTransition ? 0 : cur.currentRound,
      currentAgent: isPhaseTransition ? '' : cur.currentAgent,
      phaseMessages: (isPhaseTransition && event.phase !== null && !(event.phase in cur.phaseMessages))
        ? { ...cur.phaseMessages, [event.phase]: [] }
        : cur.phaseMessages,
      viewingPhase: isPhaseTransition ? null : cur.viewingPhase,
      pipelineSprintIndex: event.phase === null
        ? null
        : typeof event.metadata?.sprintIndex === 'number'
          ? event.metadata.sprintIndex
          : cur.pipelineSprintIndex,
      currentModel: event.currentModel !== undefined ? event.currentModel : cur.currentModel,
      openDesignLockRejection: nextLockRejection,
    });

    if (event.phase === null) {
      const terminalStatus: PipelineProject['status'] =
        event.status === 'completed' || event.status === 'pipeline-completed'
          ? 'done'
          : event.status === 'interrupted'
            ? 'interrupted'
            : event.status === 'aborted'
              ? 'aborted'
              : event.status === 'failed'
                ? 'failed'
                : 'done';
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === event.projectId
            ? { ...p, status: terminalStatus, currentPhase: null }
            : p
        ),
      }));
    }

    if (get().projects.find((p) => p.id === event.projectId)?.pipelineType === 'security') {
      get()._refreshSecuritySummary(event.projectId);
    }

    if (get().projects.find((p) => p.id === event.projectId)?.pipelineType === 'bug') {
      get()._refreshBugOutcome(event.projectId);
    }
  },

  _handleProjectUpdated: (event: PipelineProjectUpdatedEvent) => {
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.id !== event.projectId) return p;
        const next: PipelineProject = { ...p };
        if (event.patch.status !== undefined) {
          next.status = event.patch.status;
        }
        if (event.patch.currentPhase !== undefined) {
          next.currentPhase = event.patch.currentPhase;
        }
        return next;
      }),
    }));

    if (get().projects.find((p) => p.id === event.projectId)?.pipelineType === 'security') {
      get()._refreshSecuritySummary(event.projectId);
    }

    if (get().projects.find((p) => p.id === event.projectId)?.pipelineType === 'bug') {
      get()._refreshBugOutcome(event.projectId);
    }
  },

  _refreshSecuritySummary: (projectId: string) => {
    const existing = get().projects.find((p) => p.id === projectId);
    if (!existing || existing.pipelineType !== 'security') return;

    const prevTimer = securitySummaryRefreshTimers.get(projectId);
    if (prevTimer !== undefined) clearTimeout(prevTimer);

    const timer = setTimeout(() => {
      securitySummaryRefreshTimers.delete(projectId);
      const stillThere = get().projects.find((p) => p.id === projectId);
      if (!stillThere || stillThere.pipelineType !== 'security') return;

      void window.lionclaw.pipeline
        .getProject(projectId)
        .then((result) => {
          if ('error' in result) return;
          const target = get().projects.find((p) => p.id === projectId);
          if (!target || target.pipelineType !== 'security') return;
          set((state) => ({
            projects: state.projects.map((p) =>
              p.id === projectId
                ? {
                    ...p,
                    metadata: {
                      ...(p.metadata ?? {}),
                      securitySummary: result.metadata?.securitySummary,
                    },
                  }
                : p,
            ),
          }));
        })
        .catch(() => {
        });
    }, SECURITY_SUMMARY_REFRESH_DEBOUNCE_MS);

    securitySummaryRefreshTimers.set(projectId, timer);
  },

  _refreshBugOutcome: (projectId: string) => {
    const existing = get().projects.find((p) => p.id === projectId);
    if (!existing || existing.pipelineType !== 'bug') return;

    const prevTimer = bugOutcomeRefreshTimers.get(projectId);
    if (prevTimer !== undefined) clearTimeout(prevTimer);

    const timer = setTimeout(() => {
      bugOutcomeRefreshTimers.delete(projectId);
      const stillThere = get().projects.find((p) => p.id === projectId);
      if (!stillThere || stillThere.pipelineType !== 'bug') return;

      void window.lionclaw.pipeline
        .getProject(projectId)
        .then((result) => {
          if ('error' in result) return;
          const target = get().projects.find((p) => p.id === projectId);
          if (!target || target.pipelineType !== 'bug') return;
          set((state) => ({
            projects: state.projects.map((p) =>
              p.id === projectId
                ? {
                    ...p,
                    metadata: {
                      ...(p.metadata ?? {}),
                      bugOutcome: result.metadata?.bugOutcome,
                    },
                  }
                : p,
            ),
          }));
        })
        .catch(() => {
        });
    }, BUG_OUTCOME_REFRESH_DEBOUNCE_MS);

    bugOutcomeRefreshTimers.set(projectId, timer);
  },

  _handleNotesUpdated: (event: PipelineNotesUpdatedEvent) => {
    get()._setProjectState(event.projectId, {
      notesPath: event.path,
      notesContent: event.content,
    });
  },

  _handleSprintComplete: (event: PipelineSprintCompleteEvent) => {
    const cur = get().projectStates.get(event.projectId) ?? get()._createEmptyProjectState();
    const existing = cur.sprints.findIndex((s) => s.index === event.sprintIndex);
    const completedStatus: SprintStatus = {
      ...(existing !== -1 ? cur.sprints[existing] : {}),
      index: event.sprintIndex,
      name: event.sprintName,
      verdict: event.verdict,
      reportPath: event.reportPath,
      rounds: event.rounds,
      metrics: event.metrics,
    };
    let updatedSprints: SprintStatus[];
    if (existing !== -1) {
      updatedSprints = [...cur.sprints];
      updatedSprints[existing] = completedStatus;
    } else {
      updatedSprints = [...cur.sprints, completedStatus];
    }
    get()._setProjectState(event.projectId, { sprints: updatedSprints });
  },

  _handleSprintUpdated: (data: { sprintIndex: number; status: string; round: number }) => {
    set((state) => {
      const existing = state.sprints.findIndex((s) => s.index === data.sprintIndex);

      const prevRounds = existing !== -1 ? (state.sprints[existing].rounds ?? 0) : 0;
      const isNewRound = data.round > prevRounds && data.round > 0;

      const streamUpdates = isNewRound
        ? {
            coderStream: [
              ...state.coderStream,
              { type: 'separator' as const, content: `--- Round ${data.round} ---` },
            ],
            evaluatorStream: [] as Array<{ type: string; content?: string; tool?: string }>,
            streamContent: '',
            streamTimeline: [],
          }
        : {};

      const newSelectedTab = data.sprintIndex;

      if (existing !== -1) {
        const updated = [...state.sprints];
        updated[existing] = {
          ...updated[existing],
          verdict: data.status,
          rounds: data.round,
        };
        return { sprints: updated, selectedSprintTab: newSelectedTab, ...streamUpdates };
      }
      return {
        sprints: [
          ...state.sprints,
          {
            index: data.sprintIndex,
            name: `Sprint ${data.sprintIndex + 1}`,
            verdict: data.status,
            rounds: data.round,
          },
        ],
        selectedSprintTab: newSelectedTab,
        ...streamUpdates,
      };
    });
  },

  _handleSprintRound: (data: { projectId: string; sprintIndex: number; round: number; agent: string }) => {
    get()._setProjectState(data.projectId, { currentRound: data.round, currentAgent: data.agent });
  },

  _handleStreamError: (projectId: string, message: string) => {
    const cur = get().projectStates.get(projectId) ?? get()._createEmptyProjectState();
    get()._setProjectState(projectId, {
      error: message,
      isStreaming: false,
      streamTimeline: failTimeline(cur.streamTimeline),
      streamTurnStartedAt: null,
    });
  },

  _handleAgentCompleted: (projectId: string) => {
    get()._setProjectState(projectId, { agentCompleted: true });
  },

  closeDocument: () => {
    const activeProjectId = get().activeProjectId;
    if (!activeProjectId) {
      set({ activeDocument: null });
      return;
    }
    get()._setProjectState(activeProjectId, { activeDocument: null });
  },

  _handleDocumentUpdated: (data: { projectId: string; path: string; content: string }) => {
    const cur = get().projectStates.get(data.projectId) ?? get()._createEmptyProjectState();
    const phase = cur.currentPhase;
    const updatedPhaseDocuments = phase !== null
      ? {
          ...cur.phaseDocuments,
          [phase]: { path: data.path, label: _getPhaseDocLabel(phase, data.path) },
        }
      : cur.phaseDocuments;
    get()._setProjectState(data.projectId, {
      activeDocument: { path: data.path, content: data.content },
      phaseDocuments: updatedPhaseDocuments,
    });
  },

  _handleStreamUsage: (projectId: string, usage) => {
    const cur = get().projectStates.get(projectId) ?? get()._createEmptyProjectState();
    const prev = cur.phaseMetrics ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
    };
    get()._setProjectState(projectId, {
      phaseMetrics: {
        inputTokens: prev.inputTokens + usage.inputTokens,
        outputTokens: prev.outputTokens + usage.outputTokens,
        cacheReadTokens: prev.cacheReadTokens + (usage.cacheReadTokens ?? 0),
        cacheCreationTokens: prev.cacheCreationTokens + (usage.cacheCreationTokens ?? 0),
        costUsd: prev.costUsd + (usage.costUsd ?? 0),
      },
    });
  },


  init: () => {

    void get().loadProjects();

    const unsubStream = window.lionclaw.pipeline.onStream((chunk: PipelineStreamChunk) => {
      const eventProjectId = chunk.projectId ?? null;
      if (!eventProjectId) {
        console.warn('[pipeline-store] onStream event without projectId ignored', { type: chunk.type });
        return;
      }
      const store = usePipelineStore.getState();
      switch (chunk.type) {
        case 'thinking':
          get()._setProjectState(eventProjectId, {
            isStreaming: true,
            streamTurnStartedAt: nextStreamTurnStartedAt(get().projectStates.get(eventProjectId)),
          });
          break;
        case 'text': {
          if (chunk.auditAgentId) {
            const cur = get().projectStates.get(eventProjectId) ?? get()._createEmptyProjectState();
            const agentId = chunk.auditAgentId;
            const existing = cur.auditAgents.get(agentId);
            if (existing) {
              const next = new Map(cur.auditAgents);
              next.set(agentId, {
                ...existing,
                streamContent: existing.streamContent + chunk.content,
              });
              get()._setProjectState(eventProjectId, { auditAgents: next });
            }
            break;
          }
          const cur = get().projectStates.get(eventProjectId);
          const chunkPhase = chunk.phase ?? cur?.currentPhase ?? null;
          const chunkPipelineType = get().projects.find((p) => p.id === eventProjectId)?.pipelineType;
          const isCoderPhase = isCoderPhaseForProject(chunkPipelineType, chunkPhase);
          const isEvaluatorPhase = isEvaluatorPhaseForProject(chunkPipelineType, chunkPhase);
          if (isCoderPhase || isEvaluatorPhase) {
            const agent = isEvaluatorPhase ? 'evaluator' : 'coder';
            store._appendAgentStream(eventProjectId, agent, { type: 'text', content: chunk.content });
          }
          store._appendStreamText(eventProjectId, chunk.content);
          break;
        }
        case 'tool_call': {
          if (chunk.auditAgentId) {
            const cur = get().projectStates.get(eventProjectId) ?? get()._createEmptyProjectState();
            const agentId = chunk.auditAgentId;
            const existing = cur.auditAgents.get(agentId);
            if (existing) {
              const next = new Map(cur.auditAgents);
              next.set(agentId, {
                ...existing,
                toolCalls: [...existing.toolCalls, { tool: chunk.tool, input: chunk.input ?? null }],
              });
              get()._setProjectState(eventProjectId, { auditAgents: next });
            }
            break;
          }
          const cur = get().projectStates.get(eventProjectId);
          const chunkPhase = chunk.phase ?? cur?.currentPhase ?? null;
          const chunkPipelineType = get().projects.find((p) => p.id === eventProjectId)?.pipelineType;
          const isCoderPhase = isCoderPhaseForProject(chunkPipelineType, chunkPhase);
          const isEvaluatorPhase = isEvaluatorPhaseForProject(chunkPipelineType, chunkPhase);
          if (isCoderPhase || isEvaluatorPhase) {
            const agent = isEvaluatorPhase ? 'evaluator' : 'coder';
            store._appendAgentStream(eventProjectId, agent, { type: 'tool_use', tool: chunk.tool });
          }
          store._appendStreamTool(eventProjectId, chunk.tool, chunk.input ?? null, chunk.toolCallId);
          break;
        }
        case 'tool_result': {
          store._applyStreamToolResult(
            eventProjectId,
            chunk.tool,
            chunk.content,
            chunk.isError,
            chunk.toolCallId,
          );
          break;
        }
        case 'done':
          store._finalizeAssistantMessage(eventProjectId);
          break;
        case 'error':
          store._handleStreamError(eventProjectId, chunk.message);
          break;
        case 'usage':
          store._handleStreamUsage(eventProjectId, {
            inputTokens: chunk.inputTokens,
            outputTokens: chunk.outputTokens,
            cacheReadTokens: chunk.cacheReadTokens,
            cacheCreationTokens: chunk.cacheCreationTokens,
            costUsd: chunk.costUsd,
          });
          break;
        default:
          break;
      }
    });

    const unsubPhase = window.lionclaw.pipeline.onPhaseChanged((event: PipelinePhaseChangedEvent) => {
      const eventProjectId = event.projectId ?? null;
      if (!eventProjectId) {
        console.warn('[pipeline-store] onPhaseChanged event without projectId ignored');
        return;
      }
      usePipelineStore.getState()._handlePhaseChanged(event);
    });

    const unsubProjectUpdated = window.lionclaw.pipeline.onProjectUpdated(
      (event: PipelineProjectUpdatedEvent) => {
        const eventProjectId = event.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onProjectUpdated event without projectId ignored');
          return;
        }
        usePipelineStore.getState()._handleProjectUpdated(event);
      },
    );

    const unsubNotes = window.lionclaw.pipeline.onNotesUpdated((event: PipelineNotesUpdatedEvent) => {
      const eventProjectId = event.projectId ?? null;
      if (!eventProjectId) {
        console.warn('[pipeline-store] onNotesUpdated event without projectId ignored');
        return;
      }
      usePipelineStore.getState()._handleNotesUpdated(event);
    });

    const unsubMessagesUpdated = window.lionclaw.pipeline.onMessagesUpdated(
      (data: { projectId: string; phase: number }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId || typeof data.phase !== 'number') {
          console.warn('[pipeline-store] onMessagesUpdated event without projectId/phase ignored');
          return;
        }
        const state = usePipelineStore.getState();
        const isRelevant =
          state.activeProjectId === eventProjectId || state.projectStates.has(eventProjectId);
        if (!isRelevant) return;
        void state.loadPhaseHistory(eventProjectId, data.phase);
      },
    );

    const unsubSprint = window.lionclaw.pipeline.onSprintComplete((event: PipelineSprintCompleteEvent) => {
      const eventProjectId = event.projectId ?? null;
      if (!eventProjectId) {
        console.warn('[pipeline-store] onSprintComplete event without projectId ignored');
        return;
      }
      usePipelineStore.getState()._handleSprintComplete(event);
    });

    const unsubSprintUpdated = window.lionclaw.pipeline.onSprintUpdated(
      (data: { sprintIndex: number; status: string; round: number }) => {
        usePipelineStore.getState()._handleSprintUpdated(data);
      },
    );

    const unsubAgentCompleted = window.lionclaw.pipeline.onAgentCompleted(
      (data: { projectId: string }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onAgentCompleted event without projectId ignored');
          return;
        }
        usePipelineStore.getState()._handleAgentCompleted(data.projectId);
      },
    );

    const unsubDocumentUpdated = window.lionclaw.pipeline.onDocumentUpdated(
      (data: { projectId: string; path: string; content: string }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onDocumentUpdated event without projectId ignored');
          return;
        }
        usePipelineStore.getState()._handleDocumentUpdated(data);
      },
    );

    const unsubSprintsLoaded = window.lionclaw.pipeline.onSprintsLoaded(
      (data: {
        projectId: string;
        sprints: Array<{
          index: number;
          name: string;
          status: string;
          coderAgentId?: string;
          evaluatorAgentId?: string;
          sprintJsonId?: string;
          sprintId?: string;
        }>;
      }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onSprintsLoaded event without projectId ignored');
          return;
        }
        get()._setProjectState(eventProjectId, {
          sprints: data.sprints.map((s) => ({
            index: s.index,
            name: s.name,
            verdict: s.status ?? '',
            coderAgentId: s.coderAgentId,
            evaluatorAgentId: s.evaluatorAgentId,
            sprintJsonId: s.sprintJsonId,
            sprintId: s.sprintId,
          })),
        });
      },
    );

    const unsubSprintRound = window.lionclaw.pipeline.onSprintRound(
      (data: { projectId: string; sprintIndex: number; round: number; agent: string }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onSprintRound event without projectId ignored');
          return;
        }
        usePipelineStore.getState()._handleSprintRound(data);
      },
    );

    const unsubResetComplete = window.lionclaw.pipeline.onResetComplete(
      (data: { projectId: string; phase?: number; sprintIndex?: number }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onResetComplete event without projectId ignored');
          return;
        }
        usePipelineStore.getState()._invalidateCaches(data.projectId);
        void usePipelineStore.getState().openProject(data.projectId);
      },
    );

    const unsubSecurityAgentStatus = window.lionclaw.pipeline.onSecurityAgentStatus(
      (event: SecurityAgentStatusEvent) => {
        const eventProjectId = event.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onSecurityAgentStatus event without projectId ignored');
          return;
        }
        usePipelineStore.getState().handleSecurityAgentStatus(event);
      },
    );

    const unsubResolutionTrackerComplete = window.lionclaw.pipeline.onResolutionTrackerComplete(
      (data: { projectId: string }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onResolutionTrackerComplete event without projectId ignored');
          return;
        }
      },
    );

    const unsubManifest = window.lionclaw.pipeline.onManifest(
      (data: { projectId: string; manifest: unknown }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onManifest event without projectId ignored');
          return;
        }
        get()._setProjectState(eventProjectId, { repoManifest: data.manifest as RepoManifest });
      },
    );

    const unsubAuditProgress = window.lionclaw.pipeline.onAuditAgentProgress(
      (event: PipelineAuditAgentProgressEvent) => {
        const eventProjectId = event.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onAuditAgentProgress event without projectId ignored');
          return;
        }
        const cur = get().projectStates.get(eventProjectId) ?? get()._createEmptyProjectState();
        const existing = cur.auditAgents.get(event.agentId);
        const now = Date.now();

        const updated: AuditAgentState = {
          agentId: event.agentId,
          slug: event.slug,
          name: event.agentName ?? existing?.name ?? event.slug,
          model: event.model ?? existing?.model ?? null,
          runtime: event.runtime ?? existing?.runtime ?? null,
          status: event.status,
          streamContent: existing?.streamContent ?? '',
          toolCalls: existing?.toolCalls ?? [],
          filesAnalyzed: event.filesAnalyzed,
          additionalFilesAfterStart: event.additionalFilesAfterStart,
          toolCallsCount: event.toolCallsCount,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
          findingsCount: event.findingsCount,
          startedAt: existing?.startedAt ?? (event.status === 'running' ? now : undefined),
          completedAt:
            event.status === 'completed' || event.status === 'failed'
              ? now
              : existing?.completedAt,
        };

        const nextMap = new Map(cur.auditAgents);
        nextMap.set(event.agentId, updated);

        let nextSlots = cur.auditPanelSlots;
        if (event.status === 'running') {
          nextSlots = assignAgentToPanel(cur.auditPanelSlots, event.agentId, nextMap);
        }

        get()._setProjectState(eventProjectId, {
          auditAgents: nextMap,
          auditPanelSlots: nextSlots,
        });
      },
    );

    const unsubStalled = window.lionclaw.pipeline.onStalled(
      (data: { projectId: string; phase: number; agentId: string; lastChunkAt: number; secondsSinceLastChunk: number }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onStalled event without projectId ignored');
          return;
        }
        console.warn('[pipeline-store] pipeline:stalled received', data);
        get()._setProjectState(eventProjectId, { stalled: true });
      },
    );

    const unsubDriveState = window.lionclaw.drive.onStateChanged(
      ({ projectId, drive }: { projectId: string; drive: DriveState | null }) => {
        if (!projectId) return;
        const status = drive?.status;
        if (status === 'awaiting-human') {
          get()._setProjectState(projectId, {
            isStreaming: false,
            streamTurnStartedAt: null,
            drivePaused: true,
          });
        } else if (status === 'stopped') {
          get()._setProjectState(projectId, {
            isStreaming: false,
            streamTurnStartedAt: null,
            drivePaused: false,
          });
        } else if (status === 'driving') {
          get()._setProjectState(projectId, { drivePaused: false });
        }
      },
    );

    return () => {
      unsubStream();
      unsubPhase();
      unsubProjectUpdated();
      unsubNotes();
      unsubMessagesUpdated();
      unsubSprint();
      unsubSprintUpdated();
      unsubAgentCompleted();
      unsubDocumentUpdated();
      unsubSprintsLoaded();
      unsubSprintRound();
      unsubResetComplete();
      unsubSecurityAgentStatus();
      unsubResolutionTrackerComplete();
      unsubManifest();
      unsubAuditProgress();
      unsubStalled();
      unsubDriveState();
    };
  },
  }),
  {
    name: 'lionclaw-pipeline',
    storage: createJSONStorage(() => localStorage),
    partialize: (state) => ({
      activeProjectId: state.activeProjectId,
    }),
  },
));


const PHASE_DOC_LABELS: Record<number, string> = {
  1:  'Ver Discovery Notes',
  2:  'Ver User Stories',
  3:  'Ver User Stories',
  4:  'Ver PRD',
  5:  'Ver PRD',
  6:  'Ver SPEC',
  7:  'Ver SPEC',
  8:  'Ver SPEC',
  9:  'Ver Spec',
  10: 'Ver Spec',
  11: 'Ver Sprints',
  12: 'Ver Sprints',
  13: 'Ver Sprints',
  14: 'Ver Sprints',
};

function _getPhaseDocLabel(phase: number, filePath?: string): string {
  if (filePath?.endsWith('/open-design-prompt.md')) return 'Ver Prompt LionDesign';
  return PHASE_DOC_LABELS[phase] ?? `Ver Documento (Fase ${phase})`;
}
