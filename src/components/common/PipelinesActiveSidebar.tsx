import { useEffect } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { laneLabel } from '@/lib/lanes';
import { Loader2, Square } from 'lucide-react';
import { usePipelineStore } from '@/stores/pipeline-store';
import { useAppStore } from '@/stores/app-store';
import { useDriveStore } from '@/stores/drive-store';
import { DriveModeToggle } from './DriveModeToggle';
import { getPhasesForProject } from '@/types/pipeline';
import { getPhaseLabel, isActiveSidebarEntry } from './sidebar-utils';

function getDotColor(isStreaming: boolean, error: string | null, phaseStatus: string): string {
  if (error) return 'text-red-400';
  if (isStreaming) return 'text-green-400';
  if (phaseStatus === 'paused' || phaseStatus === 'interrupted') return 'text-yellow-400';
  return 'text-zinc-400';
}

export function PipelinesActiveSidebar() {
  const openLanes = useChatStore((s) => s.openLanes);
  const loadOpenLanes = useChatStore((s) => s.loadOpenLanes);
  useEffect(() => {
    void loadOpenLanes();
  }, [loadOpenLanes]);
  const projectStates = usePipelineStore((s) => s.projectStates);
  const projects = usePipelineStore((s) => s.projects);
  const setActiveProject = usePipelineStore((s) => s.setActiveProject);
  const setPage = useAppStore((s) => s.setPage);
  const drives = useDriveStore((s) => s.drives);
  const drivePending = useDriveStore((s) => s.pending);
  const loadDrive = useDriveStore((s) => s.loadDrive);
  const stopDrive = useDriveStore((s) => s.stop);
  const setDriveMode = useDriveStore((s) => s.setMode);

  const activeEntries = [...projectStates.entries()].filter(([, ps]) => isActiveSidebarEntry(ps) || ps.drivePaused);

  const activeIdsKey = activeEntries.map(([id]) => id).join(',');
  useEffect(() => {
    if (!activeIdsKey) return;
    for (const id of activeIdsKey.split(',')) void loadDrive(id);
  }, [activeIdsKey, loadDrive]);

  if (activeEntries.length === 0) return null;

  const streamingCount = activeEntries.filter(([, ps]) => ps.isStreaming).length;

  return (
    <div className="px-2 py-2">
      <p className="text-[10px] uppercase text-zinc-600 font-medium px-3 py-1 tracking-wider">Pipelines ativos</p>

      {streamingCount >= 5 && (
        <div className="mx-1 mb-1.5 px-2 py-1.5 rounded bg-amber-500/10 border border-amber-500/20">
          <span className="text-[11px] text-amber-400">
            Voce tem {streamingCount} pipelines rodando, atencao com quota da API.
          </span>
        </div>
      )}

      {/* Acima de 3 ativos, a regiao ganha scroll interno para nao engolir a sidebar (I3) */}
      <div className={`space-y-0.5 ${activeEntries.length > 3 ? 'max-h-40 overflow-y-auto' : ''}`}>
        {activeEntries.map(([projectId, ps]) => {
          const project = projects.find((p) => p.id === projectId);
          const name = project?.name ?? projectId;
          const dotColor = ps.drivePaused ? 'text-yellow-400' : getDotColor(ps.isStreaming, ps.error, ps.phaseStatus);
          const phases = project ? getPhasesForProject(project) : [];
          const phaseLabel = ps.drivePaused
            ? 'pausado, aguardando voce'
            : getPhaseLabel(ps.currentPhase, ps.phaseStatus, phases);
          const isRunning = !ps.drivePaused && (ps.isStreaming || ps.phaseStatus === 'running');
          const drive = drives.get(projectId) ?? null;
          const isCoordinating =
            drive?.driver === 'orchestrator' && (drive.status === 'driving' || drive.status === 'awaiting-human');

          const lane = isCoordinating ? openLanes.find((l) => l.id === drive.sessionId) : undefined;

          return (
            <div
              key={projectId}
              role="button"
              tabIndex={0}
              onClick={() => {
                setActiveProject(projectId);
                setPage('pipeline');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  setActiveProject(projectId);
                  setPage('pipeline');
                }
              }}
              className="w-full flex flex-col gap-0.5 px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200 transition-colors text-left cursor-pointer"
              title={`${name} (${phaseLabel})`}
            >
              <span className="w-full flex items-center gap-2">
                <span className={`shrink-0 leading-none ${dotColor}`} aria-hidden="true">
                  &#9679;
                </span>
                <span className="flex-1 min-w-0 truncate font-medium">{name}</span>
                {lane && (
                  <span data-testid="drive-lane-badge" title={laneLabel(lane)} className="text-[10px] text-amber-400">
                    L{lane.laneBadge}
                  </span>
                )}
                {isCoordinating && (
                  <span className="shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <DriveModeToggle
                      size="sm"
                      mode={drive.mode}
                      disabled={drivePending.has(projectId)}
                      onChange={(m) => void setDriveMode(projectId, m)}
                    />
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void stopDrive(projectId);
                      }}
                      disabled={drivePending.has(projectId)}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:bg-zinc-800 hover:border-zinc-600 transition-colors disabled:opacity-40"
                      title="Parar o orquestrador neste pipeline (ele deixa de conduzir; o pipeline continua aguardando voce)"
                    >
                      <Square size={9} />
                      Parar
                    </button>
                  </span>
                )}
              </span>
              <span className="w-full flex items-center gap-1.5 pl-4">
                {isRunning && <Loader2 size={11} className="animate-spin text-amber-500 shrink-0" aria-hidden="true" />}
                <span className="min-w-0 truncate text-[10px] text-zinc-500">{phaseLabel}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
