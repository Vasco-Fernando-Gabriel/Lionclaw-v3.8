import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  ArrowLeft,
  Loader2,
  AlertCircle,
  PlayCircle,
  PauseCircle,
  BarChart2,
  MessageSquare,
  GitBranch,
  Clock,
  DollarSign,
  RotateCcw,
  X,
  Folder,
} from 'lucide-react';
import { usePipelineStore } from '@/stores/pipeline-store';
import { useActiveProjectState } from '@/hooks/useActiveProjectState';
import { shortenModel } from '@/utils/model-display';
import { PIPELINE_PHASES, SECURITY_PIPELINE_PHASES, FEATURE_PIPELINE_PHASES, ARCHITECTURE_REVIEW_PIPELINE_PHASES, DEVELOPMENT_V2_PIPELINE_PHASES, BUG_PIPELINE_PHASES, autoPhasesOf, loopPhasesOf, conversationPhasesOf, readBugOutcome } from '@/types/pipeline';
import type { PhaseDefinition } from '@/types/pipeline';
import type { PipelinePhaseType } from '@/types';
import OpenDesignStudioPage from '@/pages/OpenDesignStudioPage';
import { useOpenDesignStore } from '@/stores/open-design-store';
import { LockedDesignViewer } from '@/components/open-design/LockedDesignViewer';
import { PipelineProjectList } from '@/components/pipeline/PipelineProjectList';
import { PipelineProgressBar } from '@/components/pipeline/PipelineProgressBar';
import { NewPipelineModal } from '@/components/pipeline/NewPipelineModal';
import { PipelineChatView } from '@/components/pipeline/PipelineChatView';
import { PipelineStreamView } from '@/components/pipeline/PipelineStreamView';
import { PhaseActionButtons } from '@/components/pipeline/PhaseActionButtons';
import { PipelineMetricsFooter } from '@/components/pipeline/PipelineMetricsFooter';
import { SprintExecutionView } from '@/components/pipeline/SprintExecutionView';
import { PipelineMetricsReport } from '@/components/pipeline/PipelineMetricsReport';
import { DocumentPreview } from '@/components/pipeline/DocumentPreview';
import { SprintListBar } from '@/components/pipeline/SprintListBar';
import { PhaseHistoryView } from '@/components/pipeline/PhaseHistoryView';
import { ResetConfirmDialog } from '@/components/pipeline/ResetConfirmDialog';
import { AgentThinking } from '@/components/chat/AgentThinking';
import { RepoProfilerView } from '@/components/pipeline/RepoProfilerView';
import { AuditMultiPanelView } from '@/components/pipeline/AuditMultiPanelView';
import { AuditFinalSummaryView } from '@/components/pipeline/AuditFinalSummaryView';
import { BugAnalysisMultiPanelView } from '@/components/pipeline/BugAnalysisMultiPanelView';
import { BugAnalysisSummaryView } from '@/components/pipeline/BugAnalysisSummaryView';
import { RepoGraphConsentDialog } from '@/components/chat/RepoGraphConsentDialog';
import { useRepoGraphStore } from '@/stores/repo-graph-store';
import type { LocalRepositoryRecord } from '@/types/repo-graph';
import { CodexWindowsHealthBanner } from '@/components/pipeline/CodexWindowsHealthBanner';
import { CodexWindowsPrepDialog } from '@/components/pipeline/CodexWindowsPrepDialog';
import { useCodexWindowsPrep } from '@/hooks/useCodexWindowsPrep';
import { ArchitectureReviewArtifactView } from '@/components/pipeline/ArchitectureReviewArtifactView';
import { DriveControls } from '@/components/pipeline/DriveControls';


type ResetTarget =
  | { phase: number; phaseName: string }
  | { sprintIndex: number; sprintTitle: string };


function getPhaseName(phaseNumber: number, phases: readonly PhaseDefinition[] = PIPELINE_PHASES): string {
  return phases.find((p) => p.number === phaseNumber)?.name ?? `Fase ${phaseNumber}`;
}

function getPhaseType(phaseNumber: number, phases: readonly PhaseDefinition[] = PIPELINE_PHASES): PipelinePhaseType {
  return phases.find((p) => p.number === phaseNumber)?.type ?? 'auto';
}


type ViewMode = 'chat' | 'sprints' | 'metrics';

interface ViewTabProps {
  mode: ViewMode;
  active: ViewMode;
  label: string;
  icon: React.ReactNode;
  onClick: (mode: ViewMode) => void;
  disabled?: boolean;
}

function ViewTab({ mode, active, label, icon, onClick, disabled = false }: ViewTabProps) {
  const isActive = mode === active;
  return (
    <button
      onClick={() => onClick(mode)}
      disabled={disabled}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        isActive
          ? 'bg-amber-600 text-white'
          : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}


interface HistoricalPhaseViewProps {
  phaseNumber: number;
  projectId: string;
  phases: readonly PhaseDefinition[];
  onClose: () => void;
  onRequestReset: (phaseNumber: number) => void;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}c`;
  return `$${usd.toFixed(3)}`;
}

function HistoricalPhaseView({ phaseNumber, projectId, phases, onClose, onRequestReset }: HistoricalPhaseViewProps) {
  const metrics = useActiveProjectState(s => s.metrics) ?? null;
  const loadPhaseHistory = usePipelineStore(s => s.loadPhaseHistory);
  const projects = usePipelineStore(s => s.projects);
  const [loading, setLoading] = useState(true);

  const phaseName = getPhaseName(phaseNumber, phases);
  const phaseType = getPhaseType(phaseNumber, phases);
  const phaseMetrics = metrics?.phases.find((p) => p.phaseNumber === phaseNumber);
  const isConversation = phaseType === 'conversation';
  const historyProject = projects.find((p) => p.id === projectId);
  const projectPath = historyProject?.projectPath;

  const artifactAutoPhases = useMemo(() => {
    const auto = autoPhasesOf(historyProject?.pipelineType);
    return new Set<number>(phases.filter((p) => auto.has(p.number) && p.resetable).map((p) => p.number));
  }, [phases, historyProject?.pipelineType]);

  useEffect(() => {
    setLoading(true);
    usePipelineStore.setState({ viewingPhase: phaseNumber });
    loadPhaseHistory(projectId, phaseNumber)
      .finally(() => setLoading(false));
    return () => {
      usePipelineStore.setState({ viewingPhase: null });
    };
  }, [projectId, phaseNumber, loadPhaseHistory]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800 bg-zinc-950/60 shrink-0">
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          title="Fechar historico"
        >
          <X size={16} />
        </button>

        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-zinc-100">
            Fase {phaseNumber} - {phaseName} (concluida)
          </h1>
        </div>

        {phaseMetrics?.model && (
          <span
            className="hidden md:flex items-center gap-1 text-[11px] text-green-400 bg-green-500/10 border border-green-500/30 px-2 py-0.5 rounded font-mono shrink-0 max-w-[200px]"
            title={phaseMetrics.model}
          >
            <span className="truncate">{shortenModel(phaseMetrics.model)}</span>
          </span>
        )}

        {projectPath && (
          <span
            className="hidden md:flex items-center gap-1 text-[11px] text-zinc-500 shrink-0 max-w-[280px]"
            title={projectPath}
          >
            <Folder size={11} className="shrink-0" />
            <span className="truncate font-mono">{projectPath}</span>
          </span>
        )}

        {phaseMetrics && (
          <div className="flex items-center gap-3 text-xs text-zinc-500 shrink-0">
            <span className="flex items-center gap-1">
              <Clock size={11} />
              {formatMs(phaseMetrics.durationMs)}
            </span>
            <span className="flex items-center gap-1">
              <DollarSign size={11} />
              {formatCost(phaseMetrics.costUsd)}
            </span>
          </div>
        )}

        <button
          onClick={() => onRequestReset(phaseNumber)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 transition-colors shrink-0"
        >
          <RotateCcw size={12} />
          Resetar Fase
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center flex-1 text-zinc-600 text-sm gap-2">
          <Loader2 size={14} className="animate-spin" />
          Carregando historico...
        </div>
      ) : isConversation ? (
        <PipelineChatView
          showInput={false}
          readOnly={true}
        />
      ) : artifactAutoPhases.has(phaseNumber) ? (
        <PhaseHistoryView
          phase={phaseNumber as import('@/types').PipelinePhaseNumber}
          projectId={projectId}
        />
      ) : (
        <PipelineStreamView
          phaseName={`${phaseName} (concluida)`}
        />
      )}

    </div>
  );
}


interface ActivePipelineViewProps {
  projectId: string;
}

function ActivePipelineView({ projectId }: ActivePipelineViewProps) {
  const projects = usePipelineStore(s => s.projects);
  const closeProject = usePipelineStore(s => s.closeProject);
  const sidecarRunning = useOpenDesignStore((s) => s.sidecarStatus?.running ?? false);
  const pausePipeline = usePipelineStore(s => s.pausePipeline);
  const resumePipeline = usePipelineStore(s => s.resumePipeline);
  const loadMetrics = usePipelineStore(s => s.loadMetrics);
  const closeDocument = usePipelineStore(s => s.closeDocument);
  const loadSecurityAgentStatuses = usePipelineStore(s => s.loadSecurityAgentStatuses);
  const loadPhaseHistory = usePipelineStore(s => s.loadPhaseHistory);

  const currentPhase = useActiveProjectState(s => s.currentPhase) ?? null;
  const phaseStatus = useActiveProjectState(s => s.phaseStatus) ?? '';
  const rawStatus = phaseStatus;
  const awaitingUser = useActiveProjectState(s => s.awaitingUser) ?? false;
  const isStreaming = useActiveProjectState(s => s.isStreaming) ?? false;
  const error = useActiveProjectState(s => s.error) ?? null;
  const metrics = useActiveProjectState(s => s.metrics) ?? null;
  const sprints = useActiveProjectState(s => s.sprints) ?? [];
  const pipelineSprintIndex = useActiveProjectState(s => s.pipelineSprintIndex) ?? null;
  const activeDocument = useActiveProjectState(s => s.activeDocument) ?? null;
  const streamContent = useActiveProjectState(s => s.streamContent) ?? '';
  const repoManifest = useActiveProjectState(s => s.repoManifest) ?? null;
  const currentModel = useActiveProjectState(s => s.currentModel) ?? null;
  const auditAgents = useActiveProjectState(s => s.auditAgents) ?? new Map();

  const project = projects.find((p) => p.id === projectId);

  const pipelineType = project?.pipelineType ?? 'development';
  const phases = pipelineType === 'security'
    ? SECURITY_PIPELINE_PHASES
    : pipelineType === 'architecture-review'
      ? ARCHITECTURE_REVIEW_PIPELINE_PHASES
      : pipelineType === 'feature'
        ? FEATURE_PIPELINE_PHASES
        : pipelineType === 'development-v2'
          ? DEVELOPMENT_V2_PIPELINE_PHASES
          : pipelineType === 'bug'
            ? BUG_PIPELINE_PHASES
            : PIPELINE_PHASES;


  const SPRINT_EXECUTION_PHASES = useMemo(
    () => loopPhasesOf(pipelineType),
    [pipelineType],
  );

  const ARTIFACT_AUTO_PHASES = useMemo(() => {
    const auto = autoPhasesOf(pipelineType);
    return new Set<number>(phases.filter((p) => auto.has(p.number) && p.resetable).map((p) => p.number));
  }, [phases, pipelineType]);

  const CONVERSATION_PHASES_SET = useMemo(
    () => conversationPhasesOf(pipelineType),
    [pipelineType],
  );

  const terminalProgressPhase = useMemo(
    () => phases.reduce((max, phase) => Math.max(max, phase.number), 0) + 1,
    [phases],
  );

  const bugOutcome = readBugOutcome(project);
  const closedWithoutFix = bugOutcome === 'no-bug';

  const BUG_CLOSED_WITHOUT_FIX_PROGRESS_PHASE = 3;

  const progressCurrentPhase =
    currentPhase ??
    (project?.status === 'done'
      ? closedWithoutFix
        ? BUG_CLOSED_WITHOUT_FIX_PROGRESS_PHASE
        : terminalProgressPhase
      : null);

  const [actionLoading, setActionLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('chat');
  const [viewingPhase, setViewingPhase] = useState<number | null>(null);
  const [resetTarget, setResetTarget] = useState<ResetTarget | null>(null);

  const [graphPromptDismissed, setGraphPromptDismissed] = useState(false);
  const [graphRepo, setGraphRepo] = useState<LocalRepositoryRecord | null>(null);
  const [graphFileCount, setGraphFileCount] = useState<number | undefined>(undefined);
  const consentOpen = useRepoGraphStore((s) => s.consentOpen);
  const setConsentOpen = useRepoGraphStore((s) => s.setConsentOpen);
  const repoGraphBuild = useRepoGraphStore((s) => s.build);
  const repoGraphSetGlobalPromptSuppressed = useRepoGraphStore((s) => s.setGlobalPromptSuppressed);

  useEffect(() => {
    if (pipelineType !== 'bug' || currentPhase !== 1 || graphPromptDismissed) return;
    const repoPath = project?.projectPath;
    if (!repoPath) return;
    let cancelled = false;
    void (async () => {
      const repo = await window.lionclaw.repoGraph.addRepository(repoPath);
      if (cancelled || 'error' in repo) return;
      const status = await window.lionclaw.repoGraph.status(repo.id);
      if (cancelled || 'error' in status) return;
      const repoStatus = status.repository.status;
      if (repoStatus === 'ready' || repoStatus === 'stale' || repoStatus === 'building') return;
      setGraphRepo(status.repository);
      setGraphFileCount(status.detect.stats?.files);
      setConsentOpen(true);
    })();
    return () => { cancelled = true; };
  }, [pipelineType, currentPhase, project?.projectPath, graphPromptDismissed, setConsentOpen]);

  const handleGraphConsentCreate = useCallback(() => {
    if (graphRepo) void repoGraphBuild(graphRepo.id, null);
    setConsentOpen(false);
    setGraphPromptDismissed(true);
  }, [graphRepo, repoGraphBuild, setConsentOpen]);

  const handleGraphConsentNotNow = useCallback(() => {
    setConsentOpen(false);
    setGraphPromptDismissed(true);
  }, [setConsentOpen]);

  const handleGraphConsentNeverAsk = useCallback(() => {
    if (graphRepo) void repoGraphSetGlobalPromptSuppressed(graphRepo.id, true);
    setConsentOpen(false);
    setGraphPromptDismissed(true);
  }, [graphRepo, repoGraphSetGlobalPromptSuppressed, setConsentOpen]);

  const isStudioOpen = useOpenDesignStore((s) => s.isStudioOpen);
  const openStudio = useOpenDesignStore((s) => s.openStudio);
  useEffect(() => {
    if (pipelineType === 'development-v2' && currentPhase === 5) {
      openStudio(projectId);
    }
  }, [pipelineType, currentPhase, projectId, openStudio]);

  const openProject = usePipelineStore(s => s.openProject);
  useEffect(() => {
    if (currentPhase === null) {
      void openProject(projectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, openProject]);

  const codexPrep = useCodexWindowsPrep();
  useEffect(() => {
    if (project?.projectPath) {
      void codexPrep.checkProject(project.projectPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.projectPath]);

  useEffect(() => {
    loadMetrics(projectId);
  }, [projectId, loadMetrics, currentPhase]);

  useEffect(() => {
    if (currentPhase === null || isStreaming) return;
    if (!CONVERSATION_PHASES_SET.has(currentPhase)) return;
    const existing = usePipelineStore.getState().phaseMessages[currentPhase];
    if (existing && existing.length > 0) return;
    void loadPhaseHistory(projectId, currentPhase);
  }, [projectId, currentPhase, isStreaming, CONVERSATION_PHASES_SET, loadPhaseHistory]);

  useEffect(() => {
    if (project?.pipelineType === 'security' && currentPhase === 2) {
      void loadSecurityAgentStatuses(projectId);
    }
  }, [project?.pipelineType, currentPhase, projectId, loadSecurityAgentStatuses]);

  useEffect(() => {
    if (currentPhase !== null && SPRINT_EXECUTION_PHASES.has(currentPhase)) {
      if (viewMode === 'chat') {
        setViewMode('sprints');
      }
    }
  }, [currentPhase, viewMode, SPRINT_EXECUTION_PHASES]);

  useEffect(() => {
    setViewingPhase(null);
  }, [currentPhase]);

  useEffect(() => {
    if (pipelineType === 'development-v2' && currentPhase === 5 && viewingPhase === 5) {
      setViewingPhase(null);
    }
  }, [pipelineType, currentPhase, viewingPhase]);

  const handlePause = useCallback(async () => {
    setActionLoading(true);
    await pausePipeline();
    setActionLoading(false);
  }, [pausePipeline]);

  const handleResume = useCallback(async () => {
    setActionLoading(true);
    await resumePipeline();
    setActionLoading(false);
  }, [resumePipeline]);

  const handleBack = useCallback(() => {
    closeProject();
  }, [closeProject]);

  const handlePhaseClick = useCallback((phaseNumber: number) => {
    if (SPRINT_EXECUTION_PHASES.has(phaseNumber)) {
      setViewMode('sprints');
      return;
    }
    if (
      phaseNumber === 5 &&
      pipelineType === 'development-v2' &&
      currentPhase === 5
    ) {
      openStudio(projectId);
      return;
    }
    const phaseM = metrics?.phases.find((p) => p.phaseNumber === phaseNumber);
    const isCompleted = phaseM?.status === 'completed';
    const isPast = progressCurrentPhase !== null && phaseNumber < progressCurrentPhase;
    if (isCompleted || isPast) {
      setViewingPhase(phaseNumber);
    }
  }, [metrics, progressCurrentPhase, currentPhase, SPRINT_EXECUTION_PHASES, pipelineType, projectId, openStudio]);

  const handleSprintSelect = useCallback((sprintIndex: number) => {
    setViewMode('sprints');
    usePipelineStore.getState().setSelectedSprintTab(sprintIndex);
  }, []);

  const handlePhaseResetRequest = useCallback((phaseNumber: number) => {
    const phaseDef = phases.find((p) => p.number === phaseNumber);
    if (!phaseDef) return;
    setResetTarget({ phase: phaseNumber, phaseName: phaseDef.name });
  }, [phases]);

  const handleSprintResetRequest = useCallback((sprintIndex: number) => {
    const sprint = usePipelineStore.getState().sprints.find((s) => s.index === sprintIndex);
    const sprintTitle = sprint?.name ?? `Sprint ${sprintIndex + 1}`;
    setResetTarget({ sprintIndex, sprintTitle });
  }, []);

  const phaseName =
    currentPhase !== null
      ? getPhaseName(currentPhase, phases)
      : null;

  type PipelineUIState =
    | 'done'
    | 'failed'
    | 'aborted'
    | 'interrupted'
    | 'streaming'
    | 'awaiting-input'
    | 'paused'
    | 'idle';

  const uiState: PipelineUIState = useMemo(() => {
    if (project?.status === 'done') return 'done';
    if (project?.status === 'failed') return 'failed';
    if (project?.status === 'aborted') return 'aborted';
    if (project?.status === 'interrupted') return 'interrupted';
    if (isStreaming) return 'streaming';
    if (awaitingUser) return 'awaiting-input';
    if (project?.status === 'paused') return 'paused';
    return 'idle';
  }, [project?.status, isStreaming, awaitingUser]);

  const isPaused = uiState === 'paused';
  const isDone = uiState === 'done';
  const isFailed = uiState === 'failed' || uiState === 'aborted' || uiState === 'interrupted';

  const pausedByMaxLoops =
    rawStatus === 'paused_max_loops' || rawStatus === 'max_loops';

  const isConversationPhase = currentPhase !== null && CONVERSATION_PHASES_SET.has(currentPhase);
  const isResumableConversation = uiState === 'interrupted' && isConversationPhase;
  const showChatInput = (!awaitingUser || isConversationPhase) && !isDone && (!isFailed || isResumableConversation);

  const inSprintPhase = currentPhase !== null && SPRINT_EXECUTION_PHASES.has(currentPhase);

  const totalSprints = sprints.length > 0 ? sprints.length : 1;

  if (pipelineType === 'development-v2' && currentPhase === 5 && isStudioOpen) {
    return <OpenDesignStudioPage projectId={projectId} />;
  }

  if (
    viewingPhase === 5 &&
    pipelineType === 'development-v2' &&
    currentPhase !== 5
  ) {
    return (
      <div className="flex flex-col h-full">
        <ResetConfirmDialog
          open={resetTarget !== null}
          target={resetTarget}
          projectId={projectId}
          onClose={() => setResetTarget(null)}
          onConfirmed={() => setResetTarget(null)}
        />
        <PipelineProgressBar
          phases={phases}
          currentPhase={progressCurrentPhase}
          phaseStatus={phaseStatus}
          phaseMetrics={metrics?.phases}
          onPhaseClick={handlePhaseClick}
          onRequestReset={handlePhaseResetRequest}
          sidecarRunning={sidecarRunning}
        />
        <div className="h-9 shrink-0 flex items-center gap-3 px-4 border-b border-zinc-800 bg-zinc-950/80">
          <button
            type="button"
            onClick={() => setViewingPhase(null)}
            className="text-[11px] text-zinc-400 hover:text-zinc-200 underline"
          >
            Voltar ao vivo
          </button>
          <div className="w-px h-3 bg-zinc-700" />
          <span className="text-[11px] text-zinc-400">Visualizando design — Fase 5</span>
        </div>
        <LockedDesignViewer projectId={projectId} />
      </div>
    );
  }

  if (viewingPhase !== null) {
    return (
      <div className="flex flex-col h-full">
        {/* Reset dialog */}
        <ResetConfirmDialog
          open={resetTarget !== null}
          target={resetTarget}
          projectId={projectId}
          onClose={() => setResetTarget(null)}
          onConfirmed={() => setResetTarget(null)}
        />
        {/* Progress bar stays visible for navigation context */}
        <PipelineProgressBar
          phases={phases}
          currentPhase={progressCurrentPhase}
          phaseStatus={phaseStatus}
          phaseMetrics={metrics?.phases}
          onPhaseClick={handlePhaseClick}
          onRequestReset={handlePhaseResetRequest}
          sidecarRunning={sidecarRunning}
        />
        <SprintListBar
          sprints={sprints}
          currentSprintIndex={pipelineSprintIndex}
          onSelectSprint={handleSprintSelect}
          onRequestReset={handleSprintResetRequest}
        />
        <HistoricalPhaseView
          phaseNumber={viewingPhase}
          projectId={projectId}
          phases={phases}
          onClose={() => setViewingPhase(null)}
          onRequestReset={handlePhaseResetRequest}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* SPEC-codex-windows-fix.md Camada 3: warnings via canal IPC proprio (NUNCA via stream do agente) */}
      <CodexWindowsHealthBanner
        onOpenHealthCheck={(payload) => {
          codexPrep.openFromWarning(payload.repoRoot, payload.issues);
        }}
      />

      {/* SPEC-codex-windows-fix.md Camada 2: dialog de opt-in pra prep Windows */}
      {codexPrep.checkResult?.needs && (
        <CodexWindowsPrepDialog
          check={codexPrep.checkResult}
          onClose={codexPrep.dismiss}
          onDone={codexPrep.handleDialogDone}
        />
      )}

      {/* Reset confirmation dialog */}
      <ResetConfirmDialog
        open={resetTarget !== null}
        target={resetTarget}
        projectId={projectId}
        onClose={() => setResetTarget(null)}
        onConfirmed={() => setResetTarget(null)}
      />

      {/* Progress bar */}
      <PipelineProgressBar
        phases={phases}
        currentPhase={progressCurrentPhase}
        phaseStatus={phaseStatus}
        phaseMetrics={metrics?.phases}
        onPhaseClick={handlePhaseClick}
        onRequestReset={handlePhaseResetRequest}
        sidecarRunning={sidecarRunning}
      />

      {/* Sprint list bar */}
      <SprintListBar
        sprints={sprints}
        currentSprintIndex={pipelineSprintIndex}
        onSelectSprint={handleSprintSelect}
        onRequestReset={handleSprintResetRequest}
      />

      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800 bg-zinc-950/60 shrink-0">
        <button
          onClick={handleBack}
          className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          title="Voltar a lista"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-zinc-100 truncate">
            {project?.name ?? projectId}
          </h1>
          <p className="text-[11px] text-zinc-500">
            {phaseName !== null
              ? `Fase ${currentPhase}: ${phaseName}`
              : isDone
              ? closedWithoutFix
                ? 'Encerrado sem correcao'
                : 'Pipeline concluido'
              : 'Aguardando inicio...'}
          </p>
        </div>

        {/* View mode tabs */}
        <div className="flex items-center gap-1 shrink-0">
          <ViewTab
            mode="chat"
            active={viewMode}
            label="Chat"
            icon={<MessageSquare size={12} />}
            onClick={setViewMode}
          />
          <ViewTab
            mode="sprints"
            active={viewMode}
            label="Sprints"
            icon={<GitBranch size={12} />}
            onClick={setViewMode}
            disabled={!inSprintPhase && sprints.length === 0}
          />
          <ViewTab
            mode="metrics"
            active={viewMode}
            label="Metricas"
            icon={<BarChart2 size={12} />}
            onClick={setViewMode}
          />
        </div>

        {/* Driver do orquestrador (SPEC S8): badge "dirigindo" + autonomia +
            Assumir/Retomar/Parar. Renderiza null quando nao ha drive de
            orquestrador neste projeto. */}
        <DriveControls projectId={projectId} />

        {/* Status indicator — mutually exclusive by construction.
          |------------------|----------------------|----------------------|
          | uiState          | Badge                | Button               |
          |------------------|----------------------|----------------------|
          | streaming        | Processando (amber)  | Pausar               |
          | awaiting-input   | (none)               | (none — chat+Aprovar)|
          | paused           | Pausado (yellow)     | Retomar              |
          | done             | (none — header copy) | (none)               |
          | failed           | (none)               | (none)               |
          | idle             | (none)               | (none)               |
          |------------------|----------------------|----------------------|
          BUG-21: switch on a single `uiState` so the badges cannot double up.
        */}
        {currentModel && (
          <span
            className="hidden md:flex items-center gap-1 text-[11px] text-green-400 bg-green-500/10 border border-green-500/30 px-2 py-0.5 rounded font-mono shrink-0 max-w-[200px]"
            title={currentModel}
          >
            <span className="truncate">{shortenModel(currentModel)}</span>
          </span>
        )}

        {project?.projectPath && (
          <span
            className="hidden md:flex items-center gap-1 text-[11px] text-zinc-500 shrink-0 max-w-[280px]"
            title={project.projectPath}
          >
            <Folder size={11} className="shrink-0" />
            <span className="truncate font-mono">{project.projectPath}</span>
          </span>
        )}

        {uiState === 'streaming' && (
          <div className="flex items-center gap-1.5 text-xs text-amber-400 shrink-0">
            <Loader2 size={13} className="animate-spin" />
            <span>Processando</span>
          </div>
        )}
        {uiState === 'paused' && (
          <div className="flex items-center gap-1.5 text-xs text-yellow-400 shrink-0">
            <div className="w-2 h-2 rounded-full bg-yellow-500" />
            <span>Pausado</span>
          </div>
        )}

        <div className="flex items-center gap-1 shrink-0">
          {uiState === 'paused' && (
            <button
              onClick={() => void handleResume()}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-green-400 border border-green-500/30 rounded-lg hover:bg-green-500/10 transition-colors disabled:opacity-40"
              title="Retoma reiniciando a fase atual"
            >
              <PlayCircle size={13} />
              Retomar
            </button>
          )}
          {uiState === 'streaming' && (
            <button
              onClick={() => void handlePause()}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-yellow-400 border border-yellow-500/30 rounded-lg hover:bg-yellow-500/10 transition-colors disabled:opacity-40"
              title="Pausar pipeline (aborta o agente atual)"
            >
              <PauseCircle size={13} />
              Pausar
            </button>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mt-2 px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2 shrink-0">
          <AlertCircle size={14} className="text-red-400 shrink-0" />
          <span className="text-xs text-red-300">{error}</span>
        </div>
      )}

      {/* Main content area -- switches by viewMode */}
      {viewMode === 'metrics' ? (
        <div className="flex-1 overflow-y-auto px-4 py-5">
          <div className="max-w-5xl mx-auto">
            <PipelineMetricsReport projectId={projectId} />
          </div>
        </div>
      ) : viewMode === 'sprints' ? (
        <div className="flex-1 overflow-y-auto px-4 py-5">
          <div className="max-w-4xl mx-auto">
            <SprintExecutionView
              totalSprints={totalSprints}
              maxRounds={5}
              projectId={projectId}
            />
          </div>
        </div>
      ) : pipelineType === 'architecture-review' && currentPhase !== null && currentPhase >= 1 && currentPhase <= 4 ? (
        <ArchitectureReviewSplitView
          projectId={projectId}
          phase={currentPhase}
          showChatInput={showChatInput}
          isPaused={isPaused}
          selectedCandidateId={project?.metadata && typeof project.metadata['architectureReview'] === 'object' && project.metadata['architectureReview'] !== null
            ? (project.metadata['architectureReview'] as Record<string, unknown>)['selectedCandidateId'] as string | null | undefined
            : null}
        />
      ) : pipelineType === 'security' && currentPhase === 1 ? (
        <RepoProfilerView
          manifest={repoManifest}
          isStreaming={isStreaming}
          streamContent={streamContent}
          projectId={projectId}
        />
      ) : pipelineType === 'security' && currentPhase === 2 ? (
        (() => {
          const TOTAL_AUDIT = 7;
          const allDone = auditAgents.size >= TOTAL_AUDIT && Array.from(auditAgents.values())
            .every(a => a.status === 'completed' || a.status === 'failed');
          return allDone
            ? <AuditFinalSummaryView />
            : <AuditMultiPanelView isStreaming={isStreaming} />;
        })()
      ) : pipelineType === 'bug' && currentPhase === 2 ? (
        (() => {
          const TOTAL_BUG_ANALYSTS = 3;
          const allDone = auditAgents.size >= TOTAL_BUG_ANALYSTS && Array.from(auditAgents.values())
            .every(a => a.status === 'completed' || a.status === 'failed');
          return allDone
            ? <BugAnalysisSummaryView />
            : <BugAnalysisMultiPanelView isStreaming={isStreaming} />;
        })()
      ) : activeDocument !== null ? (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <div className="flex-1 min-w-0 h-full overflow-hidden">
            <PipelineChatView
              showInput={showChatInput}
              isPaused={isPaused}
            />
          </div>
          <div className="w-[45%] min-w-0 shrink-0 h-full overflow-hidden">
            <DocumentPreview
              path={activeDocument.path}
              content={activeDocument.content}
              onClose={closeDocument}
            />
          </div>
        </div>
      ) : (
        <>
          {currentPhase !== null && ARTIFACT_AUTO_PHASES.has(currentPhase) && isStreaming && (
            <div className="flex flex-col items-center justify-center gap-4 py-12">
              <AgentThinking />
              <p className="text-muted-foreground text-sm">
                {getPhaseName(currentPhase, phases)} em andamento...
              </p>
            </div>
          )}
          <PipelineChatView
            showInput={showChatInput}
            isPaused={isPaused}
          />
        </>
      )}

      {/* Contextual action buttons (Decidido, Aprovar, Rejeitar, etc.) */}
      {viewMode !== 'metrics' && (
        <PhaseActionButtons
          currentPhase={currentPhase}
          pausedByMaxLoops={pausedByMaxLoops}
        />
      )}

      {/* Metrics footer */}
      <PipelineMetricsFooter onExpandMetrics={() => setViewMode('metrics')} />

      {/* Bug Pipe fase 1: consentimento do build do grafo (SPEC 4.8.1 item 3).
          Copia ESTRUTURAL da montagem do ChatPage (:1077-1085); o componente
          em si e o mesmo, sem nenhuma alteracao (B-AC12). */}
      {consentOpen && graphRepo && pipelineType === 'bug' && (
        <RepoGraphConsentDialog
          repository={graphRepo}
          fileCount={graphFileCount}
          onCreate={handleGraphConsentCreate}
          onNotNow={handleGraphConsentNotNow}
          onNeverAsk={handleGraphConsentNeverAsk}
        />
      )}
    </div>
  );
}


function ArchitectureReviewSplitView({
  projectId,
  phase,
  showChatInput,
  isPaused,
  selectedCandidateId,
}: {
  projectId: string;
  phase: number;
  showChatInput: boolean;
  isPaused: boolean;
  selectedCandidateId?: string | null;
}) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [json, setJson] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const approvePhase = usePipelineStore((s) => s.approvePhase);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.lionclaw.pipeline.readPhaseArtifact(projectId, phase);
        if (cancelled) return;
        if (result && typeof result === 'object' && 'type' in result && result.type === 'architecture') {
          const r = result as { type: 'architecture'; phase: number; markdown: string | null; json: string | null };
          setMarkdown(r.markdown);
          setJson(r.json);
        } else if (result && typeof result === 'object' && 'type' in result && result.type === 'markdown') {
          setMarkdown((result as { type: 'markdown'; content: string }).content);
          setJson(null);
        }
      } catch {
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, phase]);

  useEffect(() => {
    const off = window.lionclaw.pipeline.onDocumentUpdated((evt) => {
      if (evt.projectId !== projectId) return;
      void (async () => {
        const result = await window.lionclaw.pipeline.readPhaseArtifact(projectId, phase);
        if (result && typeof result === 'object' && 'type' in result && result.type === 'architecture') {
          const r = result as { type: 'architecture'; phase: number; markdown: string | null; json: string | null };
          setMarkdown(r.markdown);
          setJson(r.json);
        }
      })();
    });
    return () => { off?.(); };
  }, [projectId, phase]);

  const handleSelectCandidate = async (candidateId: string) => {
    console.log('[architecture-review] selecting candidate', candidateId);
    setApproveError(null);
    setApproving(true);
    try {
      await approvePhase({ selectedCandidateId: candidateId });
      const storeError = usePipelineStore.getState().error;
      if (storeError) {
        console.error('[architecture-review] approve failed:', storeError);
        setApproveError(storeError);
      } else {
        console.log('[architecture-review] approve OK');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[architecture-review] approve threw:', msg);
      setApproveError(msg);
    } finally {
      setApproving(false);
    }
  };

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <div className="flex-1 min-w-0 h-full overflow-hidden">
        <PipelineChatView showInput={showChatInput} isPaused={isPaused} />
      </div>
      <div className="w-[45%] min-w-0 shrink-0 h-full overflow-y-auto bg-zinc-950 border-l border-zinc-800">
        {approveError && (
          <div className="m-3 p-3 bg-red-950/40 border border-red-800 rounded text-xs text-red-200">
            <div className="font-semibold mb-1">Falha ao aprovar candidato:</div>
            <div className="font-mono break-all">{approveError}</div>
            <button
              onClick={() => setApproveError(null)}
              className="mt-2 px-2 py-1 text-[10px] bg-red-900 hover:bg-red-800 rounded"
            >
              fechar
            </button>
          </div>
        )}
        {approving && (
          <div className="m-3 p-3 bg-blue-950/40 border border-blue-800 rounded text-xs text-blue-200">
            Aprovando candidato...
          </div>
        )}
        <ArchitectureReviewArtifactView
          phase={phase}
          markdownContent={markdown}
          jsonContent={json}
          onSelectCandidate={phase === 2 ? handleSelectCandidate : undefined}
          selectedCandidateId={selectedCandidateId}
        />
      </div>
    </div>
  );
}


export default function PipelinePage() {
  const {
    projects,
    activeProjectId,
    loadProjects,
    openProject,
  } = usePipelineStore();

  const [showNewModal, setShowNewModal] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);

  const codexPrep = useCodexWindowsPrep();


  useEffect(() => {
    setIsLoadingProjects(true);
    loadProjects().finally(() => setIsLoadingProjects(false));
  }, [loadProjects]);

  const handleSelect = useCallback(async (projectId: string) => {
    await openProject(projectId);
  }, [openProject]);

  if (activeProjectId) {
    return <ActivePipelineView projectId={activeProjectId} />;
  }

  return (
    <>
      <PipelineProjectList
        projects={projects}
        isLoading={isLoadingProjects}
        onSelect={(id) => { void handleSelect(id); }}
        onNewPipeline={() => setShowNewModal(true)}
      />
      {showNewModal && (
        <NewPipelineModal
          onClose={() => setShowNewModal(false)}
          onCreated={async (projectId, startPhase) => {
            setShowNewModal(false);

            const created = usePipelineStore.getState().projects.find((p) => p.id === projectId);
            const finishUp = async (): Promise<void> => {
              await openProject(projectId);
              await usePipelineStore.getState().startPipeline(startPhase);
            };

            if (!created?.projectPath) {
              void finishUp();
              return;
            }

            void codexPrep.ensureCheckedThen(created.projectPath, finishUp);
          }}
        />
      )}

      {/* SPEC P1.1: dialog de prep aparece se ensureCheckedThen detectar issues.
          Renderizado ANTES de openProject acontecer — outer component ainda visivel. */}
      {codexPrep.checkResult?.needs && (
        <CodexWindowsPrepDialog
          check={codexPrep.checkResult}
          onClose={codexPrep.dismiss}
          onDone={codexPrep.handleDialogDone}
        />
      )}
    </>
  );
}
