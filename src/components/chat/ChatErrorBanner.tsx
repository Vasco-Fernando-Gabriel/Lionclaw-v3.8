import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { translateLlmError, type TranslatedLlmError } from '@/utils/translate-llm-error';

const AUTO_DISMISS_MS = 8000;

export function ChatErrorBanner() {
  const [error, setError] = useState<TranslatedLlmError | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const unsub = window.lionclaw.chat.onStream((chunk) => {
      if (chunk.type === 'error') {
        const translated = translateLlmError({ code: chunk.code, error: chunk.error });
        clearTimer();
        setError(translated);
        if (!translated.persist) {
          timerRef.current = setTimeout(() => setError(null), AUTO_DISMISS_MS);
        }
      } else if (chunk.type === 'done') {
        setError((prev) => (prev && !prev.persist ? null : prev));
      }
    });

    return () => {
      unsub();
      clearTimer();
    };
  }, []);

  if (!error) return null;

  return (
    <div
      className="mx-4 mt-2 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5"
      data-testid="chat-error-banner"
      data-code={error.code}
      data-persist={error.persist ? 'true' : 'false'}
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-400" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-red-300">{error.title}</div>
        <p className="break-words text-xs text-red-300/90">{error.body}</p>
        {error.action && <p className="mt-0.5 break-words text-[11px] text-zinc-500">{error.action}</p>}
      </div>
      <button
        type="button"
        onClick={() => setError(null)}
        className="shrink-0 rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
        title="Dispensar"
        aria-label="Dispensar erro"
      >
        <X size={12} />
      </button>
    </div>
  );
}
