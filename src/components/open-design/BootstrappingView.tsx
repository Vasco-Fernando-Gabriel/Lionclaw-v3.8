import { AlertTriangle, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import type {
  OpenDesignBootstrapProgressEvent,
  OpenDesignBootstrapStage,
} from '@/types/open-design';

const STEPS: Array<{ id: OpenDesignBootstrapStage; label: string }> = [
  { id: 'run-dir', label: 'Preparando pasta da sessao' },
  { id: 'prompt', label: 'Lendo prompt da fase Design Plan' },
  { id: 'sidecar', label: 'Iniciando sidecar' },
  { id: 'od-config', label: 'Sincronizando agente e modelo' },
  { id: 'od-project', label: 'Criando projeto OD' },
  { id: 'conversation', label: 'Criando conversa' },
  { id: 'prompt-injection', label: 'Injetando prompt inicial' },
  { id: 'prompt-verification', label: 'Confirmando entrega no chat' },
  { id: 'studio', label: 'Abrindo LionDesign' },
];

interface BootstrappingViewProps {
  error: string | null;
  events?: OpenDesignBootstrapProgressEvent[];
}

export function BootstrappingView({ error, events = [] }: BootstrappingViewProps) {
  const latestByStage = new Map<OpenDesignBootstrapStage, OpenDesignBootstrapProgressEvent>();
  for (const event of events) {
    latestByStage.set(event.stage, event);
  }

  const currentEvent =
    [...events].reverse().find((event) => event.status === 'running') ??
    events[events.length - 1] ??
    null;
  const hasError = error !== null || events.some((event) => event.status === 'error');

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-6 py-8">
      <div className="w-full max-w-xl space-y-4">
        <div className="flex items-center gap-3">
          <Loader2 size={22} className="text-amber-400 animate-spin shrink-0" />
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Preparando LionDesign</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              O LionClaw esta entregando ao Studio o prompt produzido na fase Design Plan.
            </p>
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 space-y-2">
          {STEPS.map((step) => {
            const event = latestByStage.get(step.id);
            const status = event?.status ?? 'pending';
            const isRunning = status === 'running';
            const isDone = status === 'done';
            const isWarning = status === 'warning';
            const isError = status === 'error';
            return (
              <div key={step.id} className="flex items-start gap-2.5 text-xs">
                {isDone ? (
                  <CheckCircle2 size={14} className="text-green-400 shrink-0 mt-0.5" />
                ) : isRunning ? (
                  <Loader2 size={14} className="animate-spin text-amber-400 shrink-0 mt-0.5" />
                ) : isWarning || isError ? (
                  <AlertTriangle
                    size={14}
                    className={`${isError ? 'text-red-400' : 'text-amber-400'} shrink-0 mt-0.5`}
                  />
                ) : (
                  <Circle size={14} className="text-zinc-700 shrink-0 mt-0.5" />
                )}
                <div className="min-w-0">
                  <div
                    className={
                      isDone
                        ? 'text-zinc-400'
                        : isRunning
                          ? 'text-zinc-100 font-medium'
                          : isWarning
                            ? 'text-amber-300'
                            : isError
                              ? 'text-red-300'
                              : 'text-zinc-600'
                    }
                  >
                    {event?.label ?? step.label}
                  </div>
                  {event?.detail && (
                    <div className="mt-0.5 text-[11px] leading-4 text-zinc-500 break-words">
                      {event.detail}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {currentEvent?.detail && !hasError && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[11px] text-zinc-500">
            {currentEvent.detail}
          </div>
        )}

        {error && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-300">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
