import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Gauge } from 'lucide-react';
import type { ProviderUsageLimits, ProviderUsageWindow } from '@/types';

const REFRESH_INTERVAL_MS = 5 * 60_000;

function renewLabel(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `renova ${time}`;
  const day = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  return `renova ${day}, ${time}`;
}

function barColor(usedPercent: number): string {
  if (usedPercent >= 90) return 'bg-rose-400/80';
  if (usedPercent >= 70) return 'bg-amber-500';
  return 'bg-amber-600/80';
}

function WindowRow({ window: w }: { window: ProviderUsageWindow }) {
  const renew = renewLabel(w.resetsAt);
  return (
    <div className="py-0.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-zinc-300">{w.label}</span>
        <span className="text-amber-400 font-medium">
          {Math.round(w.usedPercent)}% <span className="text-zinc-500 font-normal">usado</span>
        </span>
      </div>
      <div className="mt-1 h-1 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor(w.usedPercent)}`}
          style={{ width: `${Math.max(2, w.usedPercent)}%` }}
        />
      </div>
      {renew && <div className="mt-0.5 text-[10px] text-zinc-500">{renew}</div>}
    </div>
  );
}

function ProviderCard({ limits }: { limits: ProviderUsageLimits }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] font-bold uppercase tracking-wider text-zinc-200">
          {limits.provider}
          {limits.planType && (
            <span className="ml-1.5 font-medium normal-case tracking-normal text-zinc-500">{limits.planType}</span>
          )}
        </span>
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
      </div>
      <div className="mt-1 space-y-1">
        {limits.windows.map((w) => (
          <WindowRow key={w.id} window={w} />
        ))}
      </div>
    </div>
  );
}

export function UsageLimitsCard() {
  const [open, setOpen] = useState(true);
  const [providers, setProviders] = useState<ProviderUsageLimits[] | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await window.lionclaw.usage.providerLimits();
      setProviders(response.providers);
    } catch {}
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    const timer = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [open, load]);

  return (
    <div className="px-2 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-zinc-900"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={12} className="text-zinc-600" />
        ) : (
          <ChevronRight size={12} className="text-zinc-600" />
        )}
        <Gauge size={13} className="text-amber-500" />
        <span className="text-xs font-medium text-zinc-300">Limites</span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {providers === null ? (
            <div className="px-1 text-[11px] text-zinc-500">Consultando assinaturas...</div>
          ) : providers.length === 0 ? (
            <div className="px-1 text-[11px] text-zinc-500">Nenhuma assinatura conectada.</div>
          ) : (
            providers.map((p) => <ProviderCard key={p.provider} limits={p} />)
          )}
        </div>
      )}
    </div>
  );
}
