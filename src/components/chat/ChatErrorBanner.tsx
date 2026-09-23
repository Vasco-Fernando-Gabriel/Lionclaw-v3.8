import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { translateLlmError, type TranslatedLlmError } from '@/utils/translate-llm-error';
import { useVisibleThread } from '@/stores/chat-store';

const AUTO_DISMISS_MS = 8000;

export function ChatErrorBanner() {
  const lastError = useVisibleThread().lastError;
  const [dismissedSequence, setDismissedSequence] = useState<number | null>(null);
  const [expiredSequence, setExpiredSequence] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const translated = useMemo<TranslatedLlmError | null>(
    () => (lastError ? translateLlmError({ code: lastError.code, error: lastError.error }) : null),
    [lastError],
  );

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!lastError || !translated || translated.persist) return;
    const sequence = lastError.sequence;
    timerRef.current = setTimeout(() => setExpiredSequence(sequence), AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [lastError, translated]);

  if (!lastError || !translated) return null;
  if (dismissedSequence === lastError.sequence) return null;
  if (!translated.persist && (expiredSequence === lastError.sequence || lastError.clearedByDone)) return null;

  return (
    <div
      className="mx-4 mt-2 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5"
      data-testid="chat-error-banner"
      data-code={translated.code}
      data-persist={translated.persist ? 'true' : 'false'}
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-400" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-red-300">{translated.title}</div>
        <p className="break-words text-xs text-red-300/90">{translated.body}</p>
        {translated.action && <p className="mt-0.5 break-words text-[11px] text-zinc-500">{translated.action}</p>}
      </div>
      <button
        type="button"
        onClick={() => setDismissedSequence(lastError.sequence)}
        className="shrink-0 rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
        title="Dispensar"
        aria-label="Dispensar erro"
      >
        <X size={12} />
      </button>
    </div>
  );
}
