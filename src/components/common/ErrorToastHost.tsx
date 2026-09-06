import { AlertTriangle, X } from 'lucide-react';
import { useErrorToastStore } from '@/stores/error-toast-store';

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
          className="pointer-events-auto rounded-lg border border-red-500/40 bg-zinc-900/95 p-3 shadow-xl"
          data-testid="error-toast"
          data-code={toast.code}
          data-persist={toast.persist ? 'true' : 'false'}
          {...(toast.source ? { 'data-source': toast.source } : {})}
        >
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-400" />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold text-red-300">{toast.title}</div>
              <p className="mt-0.5 break-words text-[11px] text-zinc-300">{toast.body}</p>
              {toast.action && (
                <p className="mt-1 break-words text-[10px] text-zinc-500">{toast.action}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              className="shrink-0 rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              title="Dispensar"
              aria-label="Dispensar erro"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
