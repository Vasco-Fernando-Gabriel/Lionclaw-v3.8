import { useEffect } from 'react';
import { Mic, PauseCircle, Power, X } from 'lucide-react';
import { VoiceActivityFeed } from '@/components/chat/VoiceActivityFeed';
import { VoiceOrb, type VoiceOrbVisualState } from '@/components/chat/VoiceOrb';
import { useVoiceConversation, type VoiceConversationState } from '@/hooks/useVoiceConversation';

interface VoiceConversationPanelProps {
  disabled?: boolean;
  onClose: () => void;
  onSendMessage: (message: string) => Promise<void> | void;
  streamingContent: string;
  isStreaming: boolean;
  toolCalls: Array<{
    tool: string;
    input: unknown;
    status: 'running' | 'done' | 'error' | 'stopped';
  }>;
  currentUsage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number } | null;
}

function mapOrbState(state: VoiceConversationState): VoiceOrbVisualState {
  if (state === 'listening' || state === 'recording') return 'listening';
  if (state === 'transcribing' || state === 'thinking') return 'processing';
  if (state === 'speaking') return 'responding';
  return 'idle';
}

export function VoiceConversationPanel({
  disabled,
  onClose,
  onSendMessage,
  streamingContent,
  isStreaming,
  toolCalls,
  currentUsage,
}: VoiceConversationPanelProps) {
  const voice = useVoiceConversation({
    disabled,
    onSendMessage,
    autoStart: true,
  });
  const {
    state,
    amplitude,
    transcript,
    lastError,
    turnElapsedMs,
    maxTurnMs,
    turnWarningMs,
    start,
    stop,
    interrupt,
  } = voice;

  useEffect(() => {
    if (disabled) {
      stop();
    }
  }, [disabled, stop]);

  const canStart = !disabled && ['idle', 'permission-denied', 'error', 'interrupted', 'closed'].includes(state);
  const canInterrupt = state === 'speaking';

  const handleClose = () => {
    stop();
    onClose();
  };

  const handleOrbClick = () => {
    if (canInterrupt) {
      interrupt();
    }
  };

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/95 px-4 py-3">
      <div className="mx-auto max-w-3xl rounded-xl border border-amber-500/20 bg-zinc-900/80 p-3 shadow-[0_0_36px_rgba(245,158,11,0.08)]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex shrink-0 flex-col items-center justify-center gap-2 sm:w-48">
            <VoiceOrb
              state={mapOrbState(state)}
              amplitude={amplitude}
              onClick={canInterrupt ? handleOrbClick : undefined}
              disabled={!canInterrupt}
            />
            <div className="flex items-center gap-2">
              {canStart && (
                <button
                  type="button"
                  onClick={start}
                  disabled={disabled}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Mic size={13} />
                  Iniciar
                </button>
              )}
              {canInterrupt && (
                <button
                  type="button"
                  onClick={interrupt}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white shadow-[0_0_18px_rgba(220,38,38,0.24)] transition-colors hover:bg-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
                  title="Parar fala e voltar a ouvir"
                >
                  <PauseCircle size={13} />
                  Parar fala
                </button>
              )}
              <button
                type="button"
                onClick={handleClose}
                className="grid h-8 w-8 place-items-center rounded-lg bg-zinc-800 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-100"
                title="Fechar modo voz"
              >
                <X size={15} />
              </button>
            </div>
            {disabled && (
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                <Power size={12} />
                Sessao somente leitura
              </div>
            )}
          </div>

          <VoiceActivityFeed
            state={state}
            transcript={transcript}
            streamingContent={streamingContent}
            isStreaming={isStreaming}
            toolCalls={toolCalls}
            currentUsage={currentUsage}
            lastError={lastError}
            turnElapsedMs={turnElapsedMs}
            maxTurnMs={maxTurnMs}
            turnWarningMs={turnWarningMs}
          />
        </div>
      </div>
    </div>
  );
}
