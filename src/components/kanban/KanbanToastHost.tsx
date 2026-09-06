import { useKanbanStore } from '@/stores/kanban-store';

const KIND_CLASS: Record<string, string> = {
  warn: 'bg-amber-950/90 border-amber-500/40 text-amber-200',
  ok: 'bg-emerald-950/90 border-emerald-500/40 text-emerald-200',
  error: 'bg-red-950/90 border-red-500/40 text-red-200',
};

export function KanbanToastHost() {
  const toasts = useKanbanStore((s) => s.toasts);
  const dismissToast = useKanbanStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-5 right-5 z-[80] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismissToast(t.id)}
          className={`pointer-events-auto text-left border rounded-xl px-3.5 py-2.5 text-xs max-w-sm shadow-xl shadow-black/50 ${KIND_CLASS[t.kind]}`}
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
