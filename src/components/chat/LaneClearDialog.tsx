import { Archive, X } from 'lucide-react';
import type { OpenChatSession } from '@/types';
import { formatModelLabel } from '@/utils/model-display';
import { LANE_UI_STATE_REASON, laneUiState, type LaneCompactionInfo, type LaneUiState } from '@/lib/lanes';

interface LaneClearDialogProps {
  lanes: readonly OpenChatSession[];
  compactions: Readonly<Record<string, LaneCompactionInfo | undefined>>;
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}

const STATE_TONE: Record<LaneUiState, string> = {
  disponivel: 'bg-green-500/15 text-green-400',
  vazia: 'bg-zinc-700/60 text-zinc-400',
  ocupada: 'bg-amber-500/15 text-amber-400',
  'em Clear': 'bg-amber-500/15 text-amber-400',
  'drive ativo': 'bg-sky-500/15 text-sky-400',
  'Clear interrompido': 'bg-red-500/15 text-red-400',
};

export function laneRuntimeLabel(lane: Pick<OpenChatSession, 'orchestrator'>): string {
  const orchestrator = lane.orchestrator;
  if (!orchestrator) return 'orquestrador nao configurado';
  return `${orchestrator.runtime} / ${formatModelLabel(orchestrator.model)}`;
}

export function LaneClearDialog({ lanes, compactions, onSelect, onCancel }: LaneClearDialogProps) {
  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
      data-testid="lane-clear-dialog"
    >
      <div className="w-full max-w-md mx-4 rounded-xl border border-amber-500/50 bg-amber-500/5 p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-zinc-800 flex items-center justify-center">
            <Archive size={20} className="text-amber-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Qual lane recebe o Clear?</h3>
            <p className="text-xs text-zinc-500">
              Todas as lanes estao abertas. O Clear salva a conversa em memoria e abre uma nova no mesmo badge.
            </p>
          </div>
        </div>

        <div className="space-y-2 mb-4">
          {lanes.map((lane) => {
            const state = laneUiState(lane, compactions[lane.id]);
            const selectable = state === 'disponivel';
            const reason = selectable
              ? undefined
              : lane.drive
                ? `Pipeline "${lane.drive.name}" com drive ativo: pare o drive antes de dar Clear.`
                : LANE_UI_STATE_REASON[state];
            return (
              <button
                key={lane.id}
                type="button"
                onClick={() => selectable && onSelect(lane.id)}
                disabled={!selectable}
                title={reason}
                data-testid={`lane-clear-option-${lane.laneBadge}`}
                data-state={state}
                className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                  selectable
                    ? 'border-zinc-700 bg-zinc-900/60 hover:border-amber-500/50 hover:bg-zinc-800'
                    : 'border-zinc-800 bg-zinc-900/30 opacity-60 cursor-not-allowed'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-semibold shrink-0">
                    Lane {lane.laneBadge}
                  </span>
                  <span className="text-sm text-zinc-200 truncate flex-1">{lane.title || 'Nova conversa'}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${STATE_TONE[state]}`}>
                    {state}
                    {lane.drive ? ` - dirige "${lane.drive.name}"` : ''}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
                  <span className="font-mono truncate">{laneRuntimeLabel(lane)}</span>
                  <span>{lane.messageCount} mensagens</span>
                </div>
                {reason && <p className="mt-1 text-[11px] text-zinc-500">{reason}</p>}
              </button>
            );
          })}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-sm transition-colors"
          >
            <X size={16} />
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
