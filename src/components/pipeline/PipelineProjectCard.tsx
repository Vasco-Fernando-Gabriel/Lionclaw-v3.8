import { useState } from 'react';
import { Trash2, Loader2, CheckCircle2, XCircle, Circle, Minus } from 'lucide-react';
import type { PipelineProject, PipelineType, SecuritySummary, PhaseDefinition } from '@/types/pipeline';
import {
  PIPELINE_PHASES,
  SECURITY_PIPELINE_PHASES,
  FEATURE_PIPELINE_PHASES,
  ARCHITECTURE_REVIEW_PIPELINE_PHASES,
  DEVELOPMENT_V2_PIPELINE_PHASES,
  BUG_PIPELINE_PHASES,
  readBugOutcome,
} from '@/types/pipeline';
import { usePipelineStore } from '@/stores/pipeline-store';
import { HandoffButton } from '@/components/common/HandoffButton';

const PIPELINE_TYPE_BADGE: Record<PipelineType, { label: string; color: string }> = {
  development: { label: 'DEV', color: 'bg-blue-500/15 text-blue-300 border border-blue-500/30' },
  'development-v2': { label: 'DEV 2.0', color: 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30' },
  security: { label: 'SEC', color: 'bg-red-500/15 text-red-300 border border-red-500/30' },
  feature: { label: 'FEAT', color: 'bg-purple-500/15 text-purple-300 border border-purple-500/30' },
  'architecture-review': { label: 'ARCH', color: 'bg-amber-500/15 text-amber-300 border border-amber-500/30' },
  bug: { label: 'Bug', color: 'bg-rose-500/15 text-rose-300 border border-rose-500/30' },
};

const PHASES_BY_TYPE: Record<PipelineType, PhaseDefinition[]> = {
  development: PIPELINE_PHASES,
  'development-v2': DEVELOPMENT_V2_PIPELINE_PHASES,
  security: SECURITY_PIPELINE_PHASES,
  feature: FEATURE_PIPELINE_PHASES,
  'architecture-review': ARCHITECTURE_REVIEW_PIPELINE_PHASES,
  bug: BUG_PIPELINE_PHASES,
};

function phasesForType(pipelineType: string | undefined): PhaseDefinition[] {
  return PHASES_BY_TYPE[(pipelineType ?? 'development') as PipelineType] ?? PIPELINE_PHASES;
}

function getPhaseName(phaseNumber: number, phases: PhaseDefinition[]): string {
  return phases.find((p) => p.number === phaseNumber)?.name ?? `Fase ${phaseNumber}`;
}

type PipelineStatus = 'running' | 'paused' | 'done' | 'failed' | 'idle' | 'aborted' | 'interrupted';

const STATUS_COLORS: Record<PipelineStatus, string> = {
  running: 'bg-blue-500/20 text-blue-400',
  paused: 'bg-yellow-500/20 text-yellow-400',
  done: 'bg-green-500/20 text-green-400',
  failed: 'bg-red-500/20 text-red-400',
  idle: 'bg-zinc-500/20 text-zinc-400',
  aborted: 'bg-orange-500/20 text-orange-400',
  interrupted: 'bg-purple-500/20 text-purple-400',
};

const STATUS_LABELS: Record<PipelineStatus, string> = {
  running: 'Executando',
  paused: 'Pausado',
  done: 'Concluido',
  failed: 'Falhou',
  idle: 'Pendente',
  aborted: 'Abortado',
  interrupted: 'Interrompido',
};

function resolveStatus(status: string): PipelineStatus {
  switch (status) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'aborted':
      return 'aborted';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'idle';
  }
}

interface PhaseIndicatorProps {
  phase: number;
  currentPhase: number | null;
  projectStatus: PipelineStatus;
  startPhase: number;
  phases: PhaseDefinition[];
}

function PhaseIndicator({ phase, currentPhase, projectStatus, startPhase, phases }: PhaseIndicatorProps) {
  const isSkipped = phase < startPhase;
  const isCompleted = !isSkipped && currentPhase !== null && phase < currentPhase;
  const isActive = phase === currentPhase;
  const isFailed = isActive && projectStatus === 'failed';
  const isDone = projectStatus === 'done';

  const title = getPhaseName(phase, phases);

  if (isSkipped) {
    return (
      <span title={`${title} (pulada)`} className="text-zinc-600">
        <Minus size={10} />
      </span>
    );
  }

  if (isDone || isCompleted) {
    return (
      <span title={`${title} (concluida)`} className="text-green-500">
        <CheckCircle2 size={10} />
      </span>
    );
  }

  if (isFailed) {
    return (
      <span title={`${title} (falhou)`} className="text-red-500">
        <XCircle size={10} />
      </span>
    );
  }

  if (isActive) {
    return (
      <span title={`${title} (em execucao)`} className="text-orange-400">
        <Loader2 size={10} className="animate-spin" />
      </span>
    );
  }

  return (
    <span title={`${title} (pendente)`} className="text-zinc-700">
      <Circle size={10} />
    </span>
  );
}

interface ProgressBarProps {
  currentPhase: number | null;
  projectStatus: PipelineStatus;
  startPhase: number;
  totalPhases: number;
}

function ProgressBar({ currentPhase, projectStatus, startPhase, totalPhases }: ProgressBarProps) {
  if (projectStatus === 'done') {
    return (
      <div className="h-1 rounded-full bg-zinc-800 overflow-hidden mt-2">
        <div className="h-full bg-green-500 rounded-full" style={{ width: '100%' }} />
      </div>
    );
  }

  if (currentPhase === null) {
    return (
      <div className="h-1 rounded-full bg-zinc-800 overflow-hidden mt-2">
        <div className="h-full bg-zinc-700 rounded-full" style={{ width: '0%' }} />
      </div>
    );
  }

  const nonSkipped = totalPhases - startPhase + 1;
  const completed = Math.max(0, currentPhase - startPhase);
  const pct = nonSkipped > 0 ? Math.round((completed / nonSkipped) * 100) : 0;

  const barColor =
    projectStatus === 'failed' ? 'bg-red-500' : projectStatus === 'paused' ? 'bg-yellow-500' : 'bg-amber-500';

  return (
    <div className="h-1 rounded-full bg-zinc-800 overflow-hidden mt-2">
      <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

interface DeleteDialogProps {
  projectName: string;
  onCancel: () => void;
  onConfirm: () => void;
  isDeleting: boolean;
}

function DeleteDialog({ projectName, onCancel, onConfirm, isDeleting }: DeleteDialogProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-sm mx-4 shadow-2xl p-5">
        <h3 className="text-sm font-bold text-zinc-100 mb-2">Deletar pipeline</h3>
        <p className="text-xs text-zinc-400 mb-5 leading-relaxed">
          Deletar pipeline <span className="font-semibold text-zinc-200">{projectName}</span>? Dados, metricas e
          historico serao perdidos permanentemente.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={isDeleting}
            className="px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={isDeleting}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors disabled:opacity-40"
          >
            {isDeleting ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Deletando...
              </>
            ) : (
              'Deletar'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PipelineProjectCardProps {
  project: PipelineProject;
  onSelect: (projectId: string) => void;
}

export function PipelineProjectCard({ project, onSelect }: PipelineProjectCardProps) {
  const { deleteProject } = usePipelineStore();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const pipelineStatus = resolveStatus(project.status);
  const currentPhase = project.currentPhase ?? null;

  const phases = phasesForType(project.pipelineType);
  const totalPhases = phases.length > 0 ? phases[phases.length - 1].number : phases.length;

  const meta = (project.metadata ?? {}) as Record<string, unknown>;
  const startPhase = typeof meta.startPhase === 'number' ? meta.startPhase : 1;
  const totalSprints = typeof meta.totalSprints === 'number' ? meta.totalSprints : null;
  const totalFeatures = typeof meta.totalFeatures === 'number' ? meta.totalFeatures : null;
  const totalCost = typeof meta.totalCost === 'number' ? meta.totalCost : null;
  const currentSprintIndex = typeof meta.currentSprintIndex === 'number' ? meta.currentSprintIndex : null;
  const totalSprintsCount = typeof meta.totalSprintsCount === 'number' ? meta.totalSprintsCount : null;

  const bugOutcome = readBugOutcome(project);

  let phaseLabel: string | null = null;
  if (currentPhase !== null) {
    const phaseName = getPhaseName(currentPhase, phases);
    const currentDef = phases.find((p) => p.number === currentPhase);
    if (currentDef?.type === 'loop' && currentSprintIndex !== null && totalSprintsCount !== null) {
      phaseLabel = `Fase ${currentPhase} - ${phaseName} (Sprint ${currentSprintIndex + 1}/${totalSprintsCount})`;
    } else {
      phaseLabel = `Fase ${currentPhase} - ${phaseName}`;
    }
  }

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteDialog(true);
  };

  const handleConfirmDelete = async () => {
    setIsDeleting(true);
    await deleteProject(project.id);
    setIsDeleting(false);
    setShowDeleteDialog(false);
  };

  return (
    <>
      <div
        onClick={() => onSelect(project.id)}
        className="w-full text-left p-4 bg-zinc-900 border border-zinc-800 rounded-xl hover:border-zinc-700 hover:bg-zinc-900/80 transition-all group cursor-pointer"
      >
        {/* Top row: name + pipeline type badge + status badge + delete */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <h3 className="text-sm font-bold text-zinc-100 truncate group-hover:text-white transition-colors min-w-0">
              {project.name}
            </h3>
            {/* Pipeline type badge — defaults to 'development' for legacy rows without pipelineType set. */}
            {(() => {
              const type = (project.pipelineType ?? 'development') as PipelineType;
              const cfg = PIPELINE_TYPE_BADGE[type];
              if (!cfg) return null;
              return (
                <span
                  title={`Pipeline: ${type}`}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold tracking-wide shrink-0 ${cfg.color}`}
                >
                  {cfg.label}
                </span>
              );
            })()}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${STATUS_COLORS[pipelineStatus]}`}
            >
              {STATUS_LABELS[pipelineStatus]}
            </span>
            <button
              onClick={handleDelete}
              className="p-1 rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100"
              title="Deletar pipeline"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        {/* Current phase */}
        {phaseLabel !== null && <p className="text-xs text-zinc-500 mt-1">{phaseLabel}</p>}

        {/* Mini pipeline bar: one inline indicator per phase of this pipeline type */}
        <div className="flex items-center gap-0.5 mt-2.5">
          {phases.map((p) => (
            <PhaseIndicator
              key={p.number}
              phase={p.number}
              currentPhase={currentPhase}
              projectStatus={pipelineStatus}
              startPhase={startPhase}
              phases={phases}
            />
          ))}
        </div>

        {/* Summary metrics */}
        <div className="flex items-center gap-4 mt-2.5 text-[11px] text-zinc-500">
          {totalSprints !== null && (
            <span>
              Sprints{' '}
              <span className="text-zinc-400 font-medium">
                {currentSprintIndex !== null ? currentSprintIndex + 1 : 0}/{totalSprints}
              </span>
            </span>
          )}
          {totalFeatures !== null && (
            <span>
              Features <span className="text-zinc-400 font-medium">{totalFeatures}</span>
            </span>
          )}
          {totalCost !== null && (
            <span>
              Custo <span className="text-zinc-400 font-medium">${totalCost.toFixed(4)}</span>
            </span>
          )}
          {/* Security pipeline: findings badge */}
          {project.pipelineType === 'security' &&
            meta.securitySummary !== undefined &&
            meta.securitySummary !== null &&
            (() => {
              const ss = meta.securitySummary as SecuritySummary;
              const total = ss.totalFindings ?? 0;
              const confirmed = ss.confirmedFindings;
              const headline = typeof confirmed === 'number' && confirmed > 0 ? confirmed : total;
              return <span className="text-[10px] text-red-400 font-medium">{headline} findings</span>;
            })()}
          {/* Bug Pipe: badge do DESFECHO. Sem ele, um pipe encerrado sem
              correcao fica visualmente identico a um que entregou a correcao
              (os dois terminam com status 'done' — D16, sem status novo no DB). */}
          {bugOutcome === 'no-bug' && (
            <span className="text-[10px] text-zinc-400 font-medium">Encerrado sem correcao</span>
          )}
          {bugOutcome === 'fix' && <span className="text-[10px] text-green-400 font-medium">Correcao aprovada</span>}
          {totalSprints === null && totalFeatures === null && totalCost === null && phaseLabel === null && (
            <span className="text-zinc-600 text-[11px]">Sem execucao iniciada</span>
          )}
        </div>

        {/* Progress bar */}
        <ProgressBar
          currentPhase={currentPhase}
          projectStatus={pipelineStatus}
          startPhase={startPhase}
          totalPhases={totalPhases}
        />

        {/* CTA de handoff no rodape do card, so em pipeline concluido com pasta + tipo */}
        {pipelineStatus === 'done' && project.projectPath && project.pipelineType && (
          <div className="mt-3">
            <HandoffButton
              data-testid="handoff-to-orchestrator"
              request={{
                source: 'pipeline',
                pipelineType: project.pipelineType,
                projectId: project.id,
                projectName: project.name,
                projectPath: project.projectPath,
                specPath: project.specPath,
                ...(bugOutcome !== null ? { bugOutcome } : {}),
              }}
            />
          </div>
        )}
      </div>

      {/* Delete confirm dialog */}
      {showDeleteDialog && (
        <DeleteDialog
          projectName={project.name}
          onCancel={() => setShowDeleteDialog(false)}
          onConfirm={() => {
            void handleConfirmDelete();
          }}
          isDeleting={isDeleting}
        />
      )}
    </>
  );
}
