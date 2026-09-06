import { AlertTriangle, AudioLines, CircleDot, Loader2, Mic, Radio, Wrench } from 'lucide-react';
import type { VoiceConversationState } from '@/hooks/useVoiceConversation';
import { translateLlmError } from '@/utils/translate-llm-error';

interface VoiceActivityFeedProps {
  state: VoiceConversationState;
  transcript: string;
  streamingContent: string;
  isStreaming: boolean;
  toolCalls: Array<{
    tool: string;
    input: unknown;
    status: 'running' | 'done' | 'error' | 'stopped';
  }>;
  currentUsage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number } | null;
  lastError: string | null;
  turnElapsedMs: number;
  maxTurnMs: number;
  turnWarningMs: number;
}

const STATUS_LABELS: Record<VoiceConversationState, string> = {
  closed: 'Fechado',
  idle: 'Pronto para ouvir',
  'permission-pending': 'Solicitando microfone',
  'permission-denied': 'Microfone bloqueado',
  listening: 'Ouvindo',
  recording: 'Capturando sua fala',
  transcribing: 'Transcrevendo',
  thinking: 'Agente pensando',
  speaking: 'Resposta em voz',
  interrupted: 'Fala interrompida',
  error: 'Erro',
};

const DETAIL_LABELS: Record<VoiceConversationState, string> = {
  closed: 'Painel fechado',
  idle: 'Aguardando o proximo turno',
  'permission-pending': 'O sistema vai pedir acesso ao microfone',
  'permission-denied': 'Ative o microfone nas permissoes do sistema',
  listening: 'Fale quando quiser iniciar um turno',
  recording: 'Pode pausar naturalmente entre frases',
  transcribing: 'Convertendo audio em texto',
  thinking: 'Aguardando a resposta do agente',
  speaking: 'Fale por cima ou use Parar fala',
  interrupted: 'Retornando para escuta',
  error: 'O modo voz vai tentar se recuperar',
};

function previewText(text: string, limit = 360): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trim()}...`;
}

export function VoiceActivityFeed({
  state,
  transcript,
  streamingContent,
  isStreaming,
  toolCalls,
  currentUsage,
  lastError,
  turnElapsedMs,
  maxTurnMs,
  turnWarningMs,
}: VoiceActivityFeedProps) {
  const activeTool = isStreaming && toolCalls.some((toolCall) => toolCall.status === 'running');
  const status = activeTool ? 'Usando ferramenta' : STATUS_LABELS[state];
  const responsePreview = previewText(streamingContent);
  const turnProgress = maxTurnMs > 0 ? Math.min(turnElapsedMs / maxTurnMs, 1) : 0;
  const showTurnProgress = state === 'recording' && turnElapsedMs > 0;
  const isTurnNearLimit = turnElapsedMs >= turnWarningMs;

  return (
    <div className="min-w-0 flex-1 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/20">
            {state === 'listening' || state === 'recording' ? <Mic size={15} /> : null}
            {state === 'thinking' || state === 'transcribing' ? <Loader2 size={15} className="animate-spin" /> : null}
            {state === 'speaking' ? <AudioLines size={15} /> : null}
            {!['listening', 'recording', 'thinking', 'transcribing', 'speaking'].includes(state) ? <CircleDot size={15} /> : null}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-100">{status}</p>
            <p className="truncate text-[11px] text-zinc-500">
              {DETAIL_LABELS[state]}
            </p>
          </div>
        </div>
        {currentUsage && (
          <div className="shrink-0 rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[10px] text-zinc-500">
            {currentUsage.inputTokens.toLocaleString('pt-BR')} in / {currentUsage.outputTokens.toLocaleString('pt-BR')} out
          </div>
        )}
      </div>

      {lastError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-300" />
          <span>{translateLlmError({ error: lastError }).body}</span>
        </div>
      )}

      {showTurnProgress && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[10px] text-zinc-500">
            <span>{isTurnNearLimit ? 'Finalizando em breve' : 'Tempo do turno'}</span>
            <span>{Math.ceil((maxTurnMs - turnElapsedMs) / 1000)}s restantes</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div
              className={`h-full rounded-full transition-[width,background-color] ${
                isTurnNearLimit ? 'bg-red-500' : 'bg-amber-500'
              }`}
              style={{ width: `${Math.max(4, turnProgress * 100)}%` }}
            />
          </div>
        </div>
      )}

      <div className="grid gap-3 border-t border-zinc-800/80 pt-3 sm:grid-cols-2">
        <div className="min-h-14">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
            <Radio size={11} />
            Transcricao
          </div>
          <p className="line-clamp-3 text-xs leading-relaxed text-zinc-300">
            {transcript || 'Sua fala aparece aqui depois da captura.'}
          </p>
        </div>

        <div className="min-h-14">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
            <AudioLines size={11} />
            Resposta
          </div>
          <p className="line-clamp-3 text-xs leading-relaxed text-zinc-300">
            {responsePreview || (isStreaming ? 'Aguardando primeira resposta...' : 'O preview do agente aparece durante o streaming.')}
          </p>
        </div>
      </div>

      <div className="border-t border-zinc-800/80 pt-3">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
          <Wrench size={11} />
          Ferramentas
        </div>
        {toolCalls.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {toolCalls.slice(-6).map((toolCall, index) => (
              <span
                key={`${toolCall.tool}-${index}`}
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200"
              >
                {isStreaming && toolCall.status === 'running' ? (
                  <Loader2 size={11} className="shrink-0 animate-spin" />
                ) : toolCall.status === 'error' ? (
                  <AlertTriangle size={11} className="shrink-0 text-red-300" />
                ) : (
                  <Wrench size={11} className="shrink-0" />
                )}
                <span className="truncate font-mono">{toolCall.tool}</span>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-zinc-500">Nenhuma ferramenta usada neste turno.</p>
        )}
      </div>
    </div>
  );
}
