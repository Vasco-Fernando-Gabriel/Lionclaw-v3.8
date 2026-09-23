import { useState } from 'react';
import { Send, Pause, Square, CornerDownLeft, Clock } from 'lucide-react';

export interface ComposerFeedItem {
  id: string;
  kind: 'event' | 'human';
  text: string;
  nodeId?: string | null;
  at?: string;
}

export interface InterventionComposerProps {
  runId: string;
  nodeInFlight: boolean;
  currentNodeId?: string | null;
  canPause: boolean;
  onSend: (text: string) => Promise<{ ok: true } | { error: string }>;
  onPause: () => void;
  onAbort: () => void;
  readOnly?: boolean;
}

export function InterventionComposer({
  runId: _runId,
  nodeInFlight,
  currentNodeId,
  canPause,
  onSend,
  onPause,
  onAbort,
  readOnly = false,
}: InterventionComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSend = async (): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending || readOnly) return;
    setSending(true);
    setLocalError(null);
    const result = await onSend(trimmed);
    setSending(false);
    if ('error' in result) {
      setLocalError(result.error);
      return;
    }
    setText('');
  };

  return (
    <div className="flex flex-col border-t border-zinc-800 bg-zinc-950/80 shrink-0">
      {/* Aviso de semantica do envio (13.3.4.1). So aparece quando ha texto sendo
          composto: e o momento em que o usuario precisa saber que o envio sera
          ENFILEIRADO para o node em voo (e evita poluir a tela quando o composer
          esta ocioso). O nodeId alvo so e renderizado aqui, nesse instante. */}
      {!readOnly && nodeInFlight && text.trim().length > 0 && (
        <div
          className="flex items-center gap-1.5 border-t border-zinc-800/60 px-4 py-1 text-[10px] text-zinc-500"
          data-testid="composer-queued-hint"
        >
          <Clock size={10} className="text-amber-400/70" />
          <span>
            Node em execucao: o envio sera{' '}
            <span className="text-amber-300">agendado para {currentNodeId ?? 'o proximo node'}</span>. Para afetar a
            tentativa em voo, use Pausar/Abortar.
          </span>
        </div>
      )}

      {localError && (
        <div className="border-t border-red-500/20 bg-red-500/10 px-4 py-1 text-[10px] text-red-300">{localError}</div>
      )}

      {/* Linha do input + acoes */}
      {/* Rotulo: deixa claro o que o composer FAZ (intervencao no workflow vivo). */}
      {!readOnly && (
        <div className="flex items-center gap-1.5 border-t border-zinc-800/60 px-4 pt-1.5 text-[10px] text-zinc-500">
          <CornerDownLeft size={10} className="shrink-0 text-amber-400/60" />
          <span>
            Intervir: sua mensagem vira um ajuste para o proximo node (ou conversa com o closer na fase final). Nao
            interrompe o node em execucao.
          </span>
        </div>
      )}
      <div className="flex items-end gap-2 px-4 pb-2 pt-1">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          disabled={readOnly || sending}
          rows={1}
          placeholder={
            readOnly
              ? 'Run encerrado (somente leitura).'
              : nodeInFlight
                ? 'Intervir: ajuste enfileirado pro proximo node (Enter envia)...'
                : 'Intervir: instrucao pro node alvo (Enter envia)...'
          }
          className="min-h-[34px] max-h-24 flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:border-amber-500/40 focus:outline-none disabled:opacity-50"
          data-testid="composer-input"
        />
        {canPause && !readOnly && (
          <button
            type="button"
            onClick={onPause}
            title="Pausar a tentativa em voo (vira interrupted + WIP commit)"
            className="flex h-[34px] items-center gap-1 rounded-lg border border-zinc-700 px-2 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800"
            data-testid="composer-pause"
          >
            <Pause size={12} />
          </button>
        )}
        {!readOnly && (
          <button
            type="button"
            onClick={onAbort}
            title="Abortar o run (a branch fica viva por default)"
            className="flex h-[34px] items-center gap-1 rounded-lg border border-zinc-700 px-2 text-[11px] text-zinc-400 transition-colors hover:bg-red-500/10 hover:text-red-400"
            data-testid="composer-abort"
          >
            <Square size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={readOnly || sending || text.trim().length === 0}
          className="flex h-[34px] items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/15 disabled:opacity-40"
          data-testid="composer-send"
        >
          <Send size={12} />
          Enviar
        </button>
      </div>
    </div>
  );
}
