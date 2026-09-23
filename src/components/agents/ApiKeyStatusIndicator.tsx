import { Loader2 } from 'lucide-react';

export type ApiKeyStatus = 'unconfigured' | 'saved' | 'testing' | 'ok' | 'error';

interface ApiKeyStatusIndicatorProps {
  status: ApiKeyStatus;
  errorMessage?: string;
  className?: string;
}

const STATUS_CONFIG: Record<
  ApiKeyStatus,
  {
    label: string;
    color: string;
    bgColor: string;
    borderColor: string;
  }
> = {
  unconfigured: {
    label: 'Nao configurada',
    color: '#9CA3AF',
    bgColor: 'bg-gray-500/10',
    borderColor: 'border-gray-500/30',
  },
  saved: {
    label: 'Salva, nao testada',
    color: '#F59E0B',
    bgColor: 'bg-amber-500/10',
    borderColor: 'border-amber-500/30',
  },
  testing: {
    label: 'Testando...',
    color: '#9CA3AF',
    bgColor: 'bg-zinc-700/30',
    borderColor: 'border-zinc-600/30',
  },
  ok: {
    label: 'Conectado',
    color: '#10B981',
    bgColor: 'bg-emerald-500/10',
    borderColor: 'border-emerald-500/30',
  },
  error: {
    label: 'Falhou',
    color: '#EF4444',
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/30',
  },
};

export function ApiKeyStatusIndicator({ status, errorMessage, className = '' }: ApiKeyStatusIndicatorProps) {
  const cfg = STATUS_CONFIG[status];

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <div
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-medium w-fit ${cfg.bgColor} ${cfg.borderColor}`}
        style={{ color: cfg.color }}
      >
        {status === 'testing' ? (
          <Loader2 size={10} className="animate-spin" />
        ) : status === 'unconfigured' ? (
          <span className="inline-block w-2 h-2 rounded-full border" style={{ borderColor: cfg.color }} />
        ) : status === 'saved' ? (
          <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: cfg.color }} />
        ) : status === 'ok' ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 5L4 7L8 3" stroke={cfg.color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M3 3L7 7M7 3L3 7" stroke={cfg.color} strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        )}
        {cfg.label}
      </div>

      {status === 'error' && errorMessage && <p className="text-xs text-red-400 pl-1">{errorMessage}</p>}
    </div>
  );
}
