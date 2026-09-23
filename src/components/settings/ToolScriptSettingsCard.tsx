import { AlertTriangle } from 'lucide-react';
import type { AppSettings } from '@/types';

export function ToolScriptSettingsCard({
  settings,
  onPatch,
}: {
  settings: AppSettings;
  onPatch: (patch: Partial<AppSettings>) => void;
}) {
  const available = settings.toolScriptAvailable ?? false;
  const enabled = settings.toolScriptEnabled ?? true;
  const effectiveOn = available && enabled;
  const unavailableReason = settings.toolScriptAvailabilityReason ?? 'python3 nao encontrado';

  return (
    <div className="flex flex-col gap-2 bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-zinc-200">Tool Script (Python)</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            Permite ao agente rodar um script Python que chama as tools do app via RPC, devolvendo so o stdout ao
            contexto. Desligado: a ferramenta de script fica ausente em todos os runtimes.
          </p>
        </div>
        <button
          onClick={() => {
            if (!available) return;
            onPatch({ toolScriptEnabled: !enabled });
          }}
          disabled={!available}
          title={!available ? unavailableReason : undefined}
          aria-label="Alternar Tool Script"
          className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
            effectiveOn ? 'bg-amber-600' : 'bg-zinc-700'
          } ${!available ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
              effectiveOn ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {!available && (
        <p className="flex items-start gap-1.5 text-xs text-amber-400">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          Indisponivel: {unavailableReason}
        </p>
      )}

      {available && enabled && (
        <p className="text-[10px] text-zinc-600">
          Limites: timeout {Math.round((settings.toolScriptTimeoutMs ?? 300000) / 60000)}min, stdout{' '}
          {Math.round((settings.toolScriptMaxStdoutBytes ?? 50000) / 1000)}KB, stderr{' '}
          {Math.round((settings.toolScriptMaxStderrBytes ?? 10000) / 1000)}KB, max{' '}
          {settings.toolScriptMaxToolCalls ?? 50} tool calls. Tools:{' '}
          {(settings.toolScriptTools ?? []).join(', ') || 'padrao'}
        </p>
      )}
    </div>
  );
}
