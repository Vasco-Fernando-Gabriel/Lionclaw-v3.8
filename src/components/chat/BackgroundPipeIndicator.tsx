import { useEffect, useMemo } from 'react';
import { Loader2, Pause } from 'lucide-react';
import { useDriveStore } from '@/stores/drive-store';
import { usePipelineStore } from '@/stores/pipeline-store';
import { useAppStore } from '@/stores/app-store';
import { useStreamTimer } from '@/components/chat/useStreamTimer';
import type { DriveState } from '@/types';


export interface ActiveDriveEntry {
  projectId: string;
  drive: DriveState;
}

export function parseStartedAt(startedAt: string | undefined): number | null {
  if (!startedAt) return null;
  const ms = Date.parse(startedAt);
  return Number.isNaN(ms) ? null : ms;
}

export function selectActiveDrives(
  drives: Map<string, DriveState | null>,
): ActiveDriveEntry[] {
  const entries: ActiveDriveEntry[] = [];
  for (const [projectId, drive] of drives) {
    if (
      drive &&
      drive.driver === 'orchestrator' &&
      (drive.status === 'driving' || drive.status === 'awaiting-human')
    ) {
      entries.push({ projectId, drive });
    }
  }
  entries.sort(
    (a, b) =>
      (parseStartedAt(b.drive.startedAt) ?? 0) -
      (parseStartedAt(a.drive.startedAt) ?? 0),
  );
  return entries;
}

export function BackgroundPipeIndicator() {
  const drives = useDriveStore((s) => s.drives);
  const loadDrive = useDriveStore((s) => s.loadDrive);
  const projects = usePipelineStore((s) => s.projects);
  const projectStates = usePipelineStore((s) => s.projectStates);
  const setActiveProject = usePipelineStore((s) => s.setActiveProject);
  const setPage = useAppStore((s) => s.setPage);

  const candidateIdsKey = useMemo(
    () =>
      projects
        .filter((p) => p.status === 'running' || p.status === 'paused')
        .map((p) => p.id)
        .join(','),
    [projects],
  );
  useEffect(() => {
    if (!candidateIdsKey) return;
    const known = useDriveStore.getState().drives;
    for (const id of candidateIdsKey.split(',')) {
      if (!known.has(id)) void loadDrive(id);
    }
  }, [candidateIdsKey, loadDrive]);

  const activeDrives = useMemo(() => selectActiveDrives(drives), [drives]);
  const top: ActiveDriveEntry | null = activeDrives[0] ?? null;

  const startedAtMs = top ? parseStartedAt(top.drive.startedAt) : null;
  const elapsed = useStreamTimer(top !== null && startedAtMs !== null, startedAtMs);

  if (!top) return null;

  const project = projects.find((p) => p.id === top.projectId);
  const name = project?.name ?? top.projectId;
  const phase =
    projectStates.get(top.projectId)?.currentPhase ?? project?.currentPhase ?? null;
  const awaiting = top.drive.status === 'awaiting-human';
  const label = phase !== null ? `${name} - Fase ${phase}` : name;
  const extraCount = activeDrives.length - 1;

  return (
    <button
      type="button"
      data-testid="background-pipe-indicator"
      onClick={() => {
        setActiveProject(top.projectId);
        setPage('pipeline');
      }}
      title={
        awaiting
          ? `O orquestrador aguarda voce em "${name}". Clique para abrir o pipeline.`
          : `O orquestrador esta dirigindo "${name}". Clique para abrir o pipeline.`
      }
      className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400 hover:bg-amber-500/20 transition-colors min-w-0"
    >
      {awaiting ? (
        <Pause size={10} className="shrink-0" aria-hidden="true" />
      ) : (
        <Loader2 size={10} className="animate-spin shrink-0" aria-hidden="true" />
      )}
      <span className="truncate max-w-[200px]">
        {label}
        {awaiting ? ' - aguardando voce' : ''}
      </span>
      {elapsed ? (
        <span className="font-mono tabular-nums shrink-0">{elapsed}</span>
      ) : null}
      {extraCount > 0 ? (
        <span
          className="shrink-0 rounded-full bg-amber-500/20 px-1 leading-none"
          title={`Mais ${extraCount} drive(s) ativo(s)`}
        >
          +{extraCount}
        </span>
      ) : null}
    </button>
  );
}
