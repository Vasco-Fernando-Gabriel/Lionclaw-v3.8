import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send, LifeBuoy, CheckCircle2, Loader2 } from 'lucide-react';
import type { CloserThreadMessage } from '@/stores/dynamic-workflow-store';

export interface CloserChatViewProps {
  runId: string;
  thread: CloserThreadMessage[];
  status: string;
  isBusy?: boolean;
  onSend: (text: string) => Promise<{ ok: true } | { error: string }>;
  onFinalize: () => Promise<{ ok: true } | { error: string }>;
}

export function CloserChatView({
  runId: _runId,
  thread,
  status,
  isBusy = false,
  onSend,
  onFinalize,
}: CloserChatViewProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const isCompleted = status === 'completed';
  const isDelivered = status === 'delivered';
  const readOnly = isCompleted;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.length]);

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

  const handleFinalize = async (): Promise<void> => {
    if (finalizing) return;
    setFinalizing(true);
    setLocalError(null);
    const result = await onFinalize();
    setFinalizing(false);
    if ('error' in result) {
      setLocalError(result.error);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header da fase de fechamento: titulo + Finalizar Workflow (AC-28) */}
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/60 px-4 py-2 shrink-0">
        <LifeBuoy size={14} className="text-amber-400 shrink-0" />
        <span className="text-[12px] font-semibold text-zinc-200">
          {isCompleted ? 'Workflow finalizado' : 'Fechamento (closer)'}
        </span>
        {isBusy && <Loader2 size={12} className="animate-spin text-amber-400" />}
        <div className="ml-auto flex items-center gap-2">
          {isDelivered && (
            <button
              type="button"
              onClick={() => void handleFinalize()}
              disabled={finalizing}
              className="flex items-center gap-1.5 rounded-lg border border-green-500/40 bg-green-500/10 px-3 py-1 text-[11px] font-medium text-green-300 transition-colors hover:bg-green-500/15 disabled:opacity-40"
              data-testid="finalize-workflow"
            >
              {finalizing ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              Finalizar Workflow
            </button>
          )}
        </div>
      </div>

      {/* Thread do closer */}
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 py-3 min-h-0">
        {thread.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-[11px] text-zinc-600">
            {isCompleted
              ? 'Workflow finalizado. Nenhuma conversa de fechamento.'
              : 'O closer vai apresentar a entrega aqui.'}
          </div>
        ) : (
          thread.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === 'human' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-3 py-2 text-[12px] break-words ${
                  m.role === 'human'
                    ? 'whitespace-pre-wrap border border-amber-500/30 bg-amber-500/10 text-amber-100'
                    : 'chat-markdown border border-zinc-700 bg-zinc-900 text-zinc-200'
                }`}
              >
                {/* SM-18: a fala do closer renderiza MARKDOWN (a do usuario fica em
                    texto cru). */}
                {m.role === 'closer' ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                ) : (
                  m.content
                )}
              </div>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      {localError && (
        <div className="border-t border-red-500/20 bg-red-500/10 px-4 py-1 text-[10px] text-red-300 shrink-0">
          {localError}
        </div>
      )}

      {/* Input da conversa (some quando completed -> somente leitura, 13.8) */}
      {!readOnly && (
        <div className="flex items-end gap-2 border-t border-zinc-800 px-4 py-2 shrink-0">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            disabled={sending}
            rows={1}
            placeholder="Pergunte ao closer, peca um ajuste, ou aprove a entrega..."
            className="min-h-[34px] max-h-24 flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:border-amber-500/40 focus:outline-none disabled:opacity-50"
            data-testid="closer-input"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sending || text.trim().length === 0}
            className="flex h-[34px] items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/15 disabled:opacity-40"
            data-testid="closer-send"
          >
            <Send size={12} />
            Enviar
          </button>
        </div>
      )}
    </div>
  );
}
