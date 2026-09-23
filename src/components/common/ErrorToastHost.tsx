import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { useErrorToastStore, type ToastTone } from '@/stores/error-toast-store';

const TONE_BORDER: Record<ToastTone, string> = {
  info: 'border-sky-500/40',
  error: 'border-red-500/40',
  warning: 'border-amber-500/40',
  success: 'border-green-500/40',
};

const TONE_ICON: Record<ToastTone, string> = {
  info: 'text-sky-400',
  error: 'text-red-400',
  warning: 'text-amber-400',
  success: 'text-green-400',
};

const TONE_TITLE: Record<ToastTone, string> = {
  info: 'text-sky-300',
  error: 'text-red-300',
  warning: 'text-amber-300',
  success: 'text-green-300',
};

export function ErrorToastHost() {
  const toasts = useErrorToastStore((s) => s.toasts);
  const dismissToast = useErrorToastStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
      data-testid="error-toast-host"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto rounded-lg border bg-zinc-900/95 p-3 shadow-xl ${TONE_BORDER[toast.tone]}`}
          data-testid="error-toast"
          data-tone={toast.tone}
          data-code={toast.code}
          data-persist={toast.persist ? 'true' : 'false'}
          {...(toast.source ? { 'data-source': toast.source } : {})}
        >
          <div className="flex items-start gap-2">
            {toast.tone === 'success' ? (
              <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-green-400" />
            ) : toast.tone === 'info' ? (
              <Info size={14} className="mt-0.5 shrink-0 text-sky-400" />
            ) : (
              <AlertTriangle size={14} className={`mt-0.5 shrink-0 ${TONE_ICON[toast.tone]}`} />
            )}
            <div className="min-w-0 flex-1">
              <div className={`text-[12px] font-semibold ${TONE_TITLE[toast.tone]}`}>{toast.title}</div>
              <p className="mt-0.5 break-words whitespace-pre-line text-[11px] text-zinc-300">{toast.body}</p>
              {toast.action && <p className="mt-1 break-words text-[10px] text-zinc-500">{toast.action}</p>}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              className="shrink-0 rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              title="Dispensar"
              aria-label="Dispensar aviso"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
