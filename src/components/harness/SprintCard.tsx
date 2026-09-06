import { useState, useEffect } from 'react';
import {
  Circle,
  Loader2,
  CheckCircle2,
  XCircle,
  PauseCircle,
  SkipForward,
  ChevronDown,
  ChevronRight,
  Code2,
  FileText,
  Layers,
} from 'lucide-react';
import type { HarnessSprint, SprintJsonDetail } from '@/types';
import { CriteriaList } from './CriteriaList';

interface SprintCardProps {
  sprint: HarnessSprint;
  projectId: string;
}

const STATUS_CONFIG: Record<
  HarnessSprint['status'],
  { icon: React.ReactNode; badge: string; label: string }
> = {
  pending: {
    icon: <Circle size={14} className="text-zinc-500" />,
    badge: 'bg-zinc-700/60 text-zinc-400',
    label: 'Pendente',
  },
  running: {
    icon: <Loader2 size={14} className="text-blue-400 animate-spin" />,
    badge: 'bg-blue-500/20 text-blue-400',
    label: 'Executando',
  },
  passed: {
    icon: <CheckCircle2 size={14} className="text-green-400" />,
    badge: 'bg-green-500/20 text-green-400',
    label: 'Passou',
  },
  failed: {
    icon: <XCircle size={14} className="text-red-400" />,
    badge: 'bg-red-500/20 text-red-400',
    label: 'Falhou',
  },
  interrupted: {
    icon: <PauseCircle size={14} className="text-yellow-400" />,
    badge: 'bg-yellow-500/20 text-yellow-400',
    label: 'Interrompido',
  },
  skipped: {
    icon: <SkipForward size={14} className="text-zinc-600" />,
    badge: 'bg-zinc-800 text-zinc-600',
    label: 'Pulado',
  },
  rejected: {
    icon: <XCircle size={14} className="text-orange-400" />,
    badge: 'bg-orange-500/20 text-orange-400',
    label: 'Rejeitado',
  },
};

const COMPLEXITY_COLORS = {
  low: 'text-green-400',
  medium: 'text-yellow-400',
  high: 'text-red-400',
};

export function SprintCard({ sprint, projectId }: SprintCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [sprintJson, setSprintJson] = useState<SprintJsonDetail | null>(null);
  const [loadingJson, setLoadingJson] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const config = STATUS_CONFIG[sprint.status];

  useEffect(() => {
    if (expanded && !sprintJson && !loadingJson && !jsonError) {
      setLoadingJson(true);
      window.lionclaw.harness
        .getSprintJson(projectId, sprint.sprintJsonId)
        .then((data) => {
          if (data) {
            setSprintJson(data);
          } else {
            setJsonError('Detalhes do sprint nao encontrados');
          }
        })
        .catch((err) => {
          setJsonError(err instanceof Error ? err.message : 'Erro ao carregar detalhes');
        })
        .finally(() => setLoadingJson(false));
    }
  }, [expanded, sprintJson, loadingJson, jsonError, projectId, sprint.sprintJsonId]);

  const hasExecutionData =
    sprint.status === 'passed' ||
    sprint.status === 'failed' ||
    sprint.status === 'running' ||
    sprint.status === 'interrupted';

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden bg-zinc-900">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/50 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="shrink-0">{config.icon}</span>

        <span className="text-xs text-zinc-500 w-6 shrink-0">#{sprint.sprintIndex + 1}</span>

        <span className="flex-1 text-sm font-medium text-zinc-100 truncate">{sprint.name}</span>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-zinc-500">
            {sprint.roundsUsed}/{sprint.maxRounds} rodadas
          </span>

          <span
            className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${config.badge}`}
          >
            {config.label}
          </span>

          <span className="text-zinc-600">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-zinc-800 p-4 space-y-4">
          {/* Sprint details from JSON */}
          {loadingJson && (
            <div className="flex items-center gap-2 text-zinc-500 text-xs">
              <Loader2 size={12} className="animate-spin" />
              Carregando detalhes...
            </div>
          )}

          {jsonError && (
            <p className="text-xs text-red-400">{jsonError}</p>
          )}

          {sprintJson && (
            <>
              {/* Description */}
              <p className="text-sm text-zinc-400">{sprintJson.description}</p>

              {/* Meta row */}
              <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
                <span className="flex items-center gap-1">
                  <Code2 size={12} />
                  Coder: <span className="text-zinc-300">{sprint.coderAgentId ?? sprintJson.coder_agent_id}</span>
                </span>
                <span className="flex items-center gap-1">
                  <Layers size={12} />
                  Complexidade: <span className={COMPLEXITY_COLORS[sprintJson.complexity]}>{sprintJson.complexity}</span>
                </span>
                <span>Rounds estimados: {sprintJson.estimated_rounds}</span>
                {sprintJson.stack.length > 0 && (
                  <span>Stack: {sprintJson.stack.join(', ')}</span>
                )}
              </div>

              {/* Dependencies */}
              {sprintJson.dependencies.length > 0 && (
                <div className="text-xs text-zinc-500">
                  Dependencias: {sprintJson.dependencies.join(', ')}
                </div>
              )}

              {/* Features */}
              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-zinc-300 uppercase tracking-wide flex items-center gap-1.5">
                  <FileText size={12} />
                  Features ({sprintJson.features.length})
                </h4>
                {sprintJson.features.map((feature) => (
                  <div key={feature.id} className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 space-y-2">
                    <div>
                      <span className="text-xs text-zinc-500 font-mono mr-2">{feature.id}</span>
                      <span className="text-sm text-zinc-200 font-medium">{feature.name}</span>
                    </div>
                    <p className="text-xs text-zinc-400">{feature.description}</p>
                    <div className="space-y-1">
                      <span className="text-[10px] text-zinc-500 uppercase font-semibold">Criterios de aceite:</span>
                      <ul className="space-y-0.5">
                        {feature.acceptance_criteria.map((criterion, idx) => (
                          <li key={idx} className="text-xs text-zinc-400 flex items-start gap-1.5">
                            <span className="text-zinc-600 mt-0.5 shrink-0">-</span>
                            {criterion}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ))}
              </div>

              {/* Hints */}
              {sprintJson.hints && (sprintJson.hints.architecture_notes || sprintJson.hints.existing_files.length > 0) && (
                <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 space-y-1">
                  <span className="text-[10px] text-zinc-500 uppercase font-semibold">Hints para o Coder</span>
                  {sprintJson.hints.architecture_notes && (
                    <p className="text-xs text-zinc-400">{sprintJson.hints.architecture_notes}</p>
                  )}
                  {sprintJson.hints.existing_files.length > 0 && (
                    <p className="text-xs text-zinc-500">
                      Arquivos: <span className="text-zinc-400 font-mono">{sprintJson.hints.existing_files.join(', ')}</span>
                    </p>
                  )}
                  {sprintJson.hints.key_interfaces.length > 0 && (
                    <p className="text-xs text-zinc-500">
                      Interfaces: <span className="text-zinc-400 font-mono">{sprintJson.hints.key_interfaces.join(', ')}</span>
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {/* Execution criteria (for completed/running sprints) */}
          {hasExecutionData && (
            <CriteriaList projectId={projectId} sprintId={sprint.id} />
          )}
        </div>
      )}
    </div>
  );
}
