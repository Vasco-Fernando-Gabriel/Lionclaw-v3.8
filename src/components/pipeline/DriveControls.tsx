import { useEffect, useState } from 'react';
import { Hand, PlayCircle, Square } from 'lucide-react';
import { useDriveStore } from '@/stores/drive-store';
import { useChatStore } from '@/stores/chat-store';
import { useErrorToastStore } from '@/stores/error-toast-store';
import { laneErrorTitle, laneLabel } from '@/lib/lanes';
import type { OpenChatSession } from '@/types';

interface DriveLaneSelectProps {
  lanes: readonly OpenChatSession[];
  value: string;
  onChange: (sessionId: string) => void;
  disabled?: boolean;
  currentProjectId?: string;
}

export function DriveLaneSelect({ lanes, value, onChange, disabled, currentProjectId }: DriveLaneSelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || lanes.length === 0}
      aria-label="Lane que dirige o pipeline"
      data-testid="drive-lane-select"
      title={
        lanes.length === 0 ? 'Abra um chat para escolher a lane' : 'Lane (conversa aberta) que vai dirigir o pipeline'
      }
      className="max-w-[180px] truncate bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1 text-[11px] text-zinc-300 outline-none focus:border-amber-500/50 disabled:opacity-40"
    >
      {lanes.length === 0 && <option value="">abra um chat</option>}
      {lanes
        .slice()
        .sort((a, b) => a.laneBadge - b.laneBadge)
        .map((lane) => (
          <option key={lane.id} value={lane.id} disabled={!laneSelectable(lane, currentProjectId)}>
            {laneLabel(lane)}
            {lane.state === 'clearing' || lane.state === 'interrupted'
              ? ' - em Clear'
              : lane.drive && lane.drive.projectId !== currentProjectId
                ? ` - ocupada: dirige "${lane.drive.name}"`
                : ''}
          </option>
        ))}
    </select>
  );
}

function laneSelectable(lane: OpenChatSession, projectId?: string): boolean {
  return (
    lane.state !== 'clearing' && lane.state !== 'interrupted' && (!lane.drive || lane.drive.projectId === projectId)
  );
}

export function useDriveLaneChoice(
  persistedSessionId?: string,
): [string, (id: string) => void, readonly OpenChatSession[]] {
  const openLanes = useChatStore((s) => s.openLanes);
  const visibleSessionId = useChatStore((s) => s.currentSessionId);
  const [chosen, setChosen] = useState<string>('');
  const chosenIsOpen = openLanes.some((lane) => lane.id === chosen);
  const fallback =
    openLanes.find((lane) => lane.id === persistedSessionId) ??
    openLanes.find((lane) => lane.id === visibleSessionId) ??
    openLanes[0];
  return [chosenIsOpen ? chosen : (fallback?.id ?? ''), setChosen, openLanes];
}

export function DriveControls({ projectId }: { projectId: string }) {
  const drive = useDriveStore((s) => s.drives.get(projectId) ?? null);
  const isPending = useDriveStore((s) => s.pending.has(projectId));
  const loadDrive = useDriveStore((s) => s.loadDrive);
  const assumir = useDriveStore((s) => s.assumir);
  const stop = useDriveStore((s) => s.stop);
  const resume = useDriveStore((s) => s.resume);
  const [laneId, setLaneId, lanes] = useDriveLaneChoice(drive?.sessionId);

  useEffect(() => {
    void loadDrive(projectId);
    void useChatStore.getState().loadOpenLanes();
  }, [projectId, loadDrive]);

  if (!drive || drive.driver !== 'orchestrator') return null;

  const canResume = drive.status === 'awaiting-human' || drive.status === 'stopped';
  const persistedLaneOpen = Boolean(drive.sessionId && lanes.some((lane) => lane.id === drive.sessionId));
  const hasSelectableLane = lanes.some((lane) => laneSelectable(lane, projectId));
  const selectedLane = lanes.find((lane) => lane.id === laneId);

  const handleResume = async () => {
    const result = await resume(projectId, laneId);
    const toast = useErrorToastStore.getState();
    if ('error' in result) {
      toast.pushError(
        { code: result.code ?? null, error: result.error },
        { title: laneErrorTitle(result.code, 'Nao foi possivel retomar o drive'), source: 'pipeline' },
      );
      return;
    }
    if (result.sessionId && result.sessionId !== laneId) {
      const lane = lanes.find((l) => l.id === result.sessionId);
      toast.pushNotice('Drive retomado na lane persistida', {
        tone: 'warning',
        body: lane
          ? `O drive continua na ${laneLabel(lane)} (lane que o abriu e segue aberta), nao na escolhida.`
          : `O drive continua na conversa ${result.sessionId}, nao na lane escolhida.`,
        source: 'pipeline',
      });
    }
  };

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {lanes.length > 0 && (
        <DriveLaneSelect
          lanes={lanes}
          value={laneId}
          onChange={setLaneId}
          disabled={isPending}
          currentProjectId={projectId}
        />
      )}
      {canResume && (
        <>
          <button
            onClick={() => void handleResume()}
            disabled={isPending || !selectedLane || !laneSelectable(selectedLane, projectId)}
            data-testid="drive-resume-button"
            className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-green-400 border border-green-500/30 rounded-lg hover:bg-green-500/10 transition-colors disabled:opacity-40"
            title={
              lanes.length > 0 && !hasSelectableLane
                ? `as ${lanes.length} lanes ja dirigem pipelines`
                : !laneId
                  ? 'Abra um chat para retomar o drive'
                  : persistedLaneOpen
                    ? 'Retoma a conducao do orquestrador na lane que abriu o drive'
                    : 'Retoma a conducao do orquestrador na lane escolhida'
            }
          >
            <PlayCircle size={12} />
            Retomar
          </button>
        </>
      )}

      {drive.status === 'driving' && (
        <button
          onClick={() => void stop(projectId)}
          disabled={isPending}
          className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-zinc-300 border border-zinc-700 rounded-lg hover:bg-zinc-800 transition-colors disabled:opacity-40"
          title="Para o drive (o orquestrador deixa de conduzir, mas voce nao assume o volante)"
        >
          <Square size={12} />
          Parar
        </button>
      )}

      <button
        onClick={() => void assumir(projectId)}
        disabled={isPending}
        className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-amber-400 border border-amber-500/30 rounded-lg hover:bg-amber-500/10 transition-colors disabled:opacity-40"
        title="Desliga o orquestrador deste pipeline em definitivo. Voce ja pode aprovar/responder direto a qualquer momento; Assumir e so para ele parar de conduzir."
      >
        <Hand size={12} />
        Assumir
      </button>
    </div>
  );
}
