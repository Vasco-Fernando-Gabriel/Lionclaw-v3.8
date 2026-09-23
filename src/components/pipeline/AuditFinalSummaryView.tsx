import { useActiveProjectState } from '@/hooks/useActiveProjectState';
import { shortenModel } from '@/utils/model-display';
import type { AuditAgentState } from '@/types/pipeline';

const TOTAL_AGENTS = 7;

function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem}s`;
}

export function AuditFinalSummaryView() {
  const auditAgents = useActiveProjectState((s) => s.auditAgents) ?? new Map<string, AuditAgentState>();
  const list = Array.from(auditAgents.values()).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

  const totalFiles = list.reduce((acc, a) => acc + a.filesAnalyzed, 0);
  const totalExtras = list
    .filter((a) => a.runtime !== 'codex')
    .reduce((acc, a) => acc + a.additionalFilesAfterStart, 0);
  const allCodex = list.length > 0 && list.every((a) => a.runtime === 'codex');
  const totalFindings = list.reduce((acc, a) => acc + (a.findingsCount ?? 0), 0);
  const totalCost = list.reduce((acc, a) => acc + a.costUsd, 0);
  const totalDuration = list.reduce((acc, a) => acc + a.durationMs, 0);

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-zinc-950">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
          Security Audit (Fase 2) - Resumo
        </span>
        <span className="text-[11px] text-green-400 font-medium">Concluido</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 min-h-0">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-zinc-400 text-left">
              <th className="font-medium pr-4 py-2 border-b border-zinc-800">Agente</th>
              <th className="font-medium pr-4 py-2 border-b border-zinc-800">Modelo</th>
              <th className="font-medium pr-4 py-2 border-b border-zinc-800 text-right">Arquivos</th>
              <th className="font-medium pr-4 py-2 border-b border-zinc-800 text-right">Extras</th>
              <th className="font-medium pr-4 py-2 border-b border-zinc-800 text-right">Findings</th>
              <th className="font-medium pr-4 py-2 border-b border-zinc-800 text-right">Custo</th>
              <th className="font-medium py-2 border-b border-zinc-800 text-right">Duracao</th>
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.agentId} className="text-zinc-300 border-b border-zinc-800/40">
                <td className="pr-4 py-2">
                  <span className="flex items-center gap-2">
                    {a.name}
                    {a.status === 'failed' && (
                      <span className="text-[9px] uppercase tracking-wider bg-red-900/40 text-red-300 px-1 py-0.5 rounded">
                        falhou
                      </span>
                    )}
                  </span>
                </td>
                <td className="pr-4 py-2 font-mono text-zinc-400">{shortenModel(a.model)}</td>
                <td className="pr-4 py-2 font-mono text-right">{a.filesAnalyzed}</td>
                <td
                  className="pr-4 py-2 font-mono text-right"
                  title={
                    a.runtime === 'codex'
                      ? 'Metrica de extras nao disponivel para runtime Codex (sem tool Read tipado)'
                      : undefined
                  }
                >
                  {a.runtime === 'codex' ? '—' : a.additionalFilesAfterStart}
                </td>
                <td className="pr-4 py-2 font-mono text-right">{a.findingsCount ?? 0}</td>
                <td className="pr-4 py-2 font-mono text-right">{formatCost(a.costUsd)}</td>
                <td className="py-2 font-mono text-right">{formatDuration(a.durationMs)}</td>
              </tr>
            ))}
            <tr className="text-zinc-100 font-semibold border-t-2 border-zinc-700 bg-zinc-900/40">
              <td className="pr-4 py-2">TOTAL</td>
              <td className="pr-4 py-2"></td>
              <td className="pr-4 py-2 font-mono text-right">{totalFiles}</td>
              <td
                className="pr-4 py-2 font-mono text-right"
                title={allCodex ? 'Todos os agentes rodaram em Codex; metrica de extras nao se aplica' : undefined}
              >
                {allCodex ? '—' : totalExtras}
              </td>
              <td className="pr-4 py-2 font-mono text-right">{totalFindings}</td>
              <td className="pr-4 py-2 font-mono text-right">{formatCost(totalCost)}</td>
              <td className="py-2 font-mono text-right">{formatDuration(totalDuration)}</td>
            </tr>
          </tbody>
        </table>

        {list.length < TOTAL_AGENTS && (
          <p className="mt-4 text-[11px] text-zinc-500 italic">
            {list.length} de {TOTAL_AGENTS} agentes registrados.
          </p>
        )}
      </div>
    </div>
  );
}
