import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle, Loader2, XCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useActiveProjectState } from '@/hooks/useActiveProjectState';
import { shortenModel } from '@/utils/model-display';
import type { AuditAgentState } from '@/types/pipeline';

const TOTAL_AGENTS = 7;

interface AuditMultiPanelViewProps {
  isStreaming: boolean;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem}s`;
}

interface AgentPanelProps {
  agent: AuditAgentState | null;
}

function AgentPanel({ agent }: AgentPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [debouncedContent, setDebouncedContent] = useState('');

  useEffect(() => {
    if (!agent) return;
    const timer = setTimeout(() => {
      setDebouncedContent(agent.streamContent);
    }, 100);
    return () => clearTimeout(timer);
  }, [agent?.streamContent, agent]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [debouncedContent]);

  const markdownEl = useMemo(
    () => <ReactMarkdown remarkPlugins={[remarkGfm]}>{debouncedContent}</ReactMarkdown>,
    [debouncedContent],
  );

  if (!agent) {
    return (
      <div className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/30 min-h-0 h-full">
        <div className="px-3 py-2 border-b border-zinc-800/60 text-xs text-zinc-600 italic shrink-0">
          Aguardando agente
        </div>
        <div className="flex-1 flex items-center justify-center text-zinc-700 text-xs italic">
          slot vazio
        </div>
      </div>
    );
  }

  const statusIcon = (() => {
    switch (agent.status) {
      case 'completed': return <CheckCircle size={12} className="text-green-400 shrink-0" />;
      case 'failed': return <XCircle size={12} className="text-red-400 shrink-0" />;
      case 'running': return <Loader2 size={12} className="text-amber-400 animate-spin shrink-0" />;
      default: return null;
    }
  })();

  return (
    <div className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/40 min-h-0 h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-zinc-800/60 shrink-0">
        <div className="flex items-center gap-2 mb-1">
          {statusIcon}
          <span className="text-xs font-semibold text-zinc-200 truncate flex-1">
            {agent.name}
          </span>
          {agent.model && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-300 border border-amber-800/50 shrink-0">
              {shortenModel(agent.model)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-zinc-500 font-mono">
          <span>{agent.filesAnalyzed} arquivos</span>
          {agent.runtime === 'codex' ? (
            <span
              className="text-zinc-600"
              title="Metrica de extras nao disponivel para runtime Codex (sem tool Read tipado)"
            >
              extras: —
            </span>
          ) : (
            agent.additionalFilesAfterStart > 0 && (
              <span className="text-amber-400">+{agent.additionalFilesAfterStart} extras</span>
            )
          )}
        </div>
      </div>
      {/* Stream body */}
      <div className="flex-1 overflow-y-auto px-3 py-2 min-h-0">
        {debouncedContent ? (
          <div className="prose prose-invert prose-xs max-w-none text-[11px] text-zinc-300 leading-relaxed">
            {markdownEl}
            <div ref={bottomRef} />
          </div>
        ) : (
          <p className="text-[11px] text-zinc-600 italic">
            {agent.status === 'running' ? 'Iniciando...' : 'Sem output ainda.'}
          </p>
        )}
      </div>
    </div>
  );
}

export function AuditMultiPanelView({ isStreaming }: AuditMultiPanelViewProps) {
  const auditAgents = useActiveProjectState(s => s.auditAgents) ?? new Map<string, AuditAgentState>();
  const auditPanelSlots = useActiveProjectState(s => s.auditPanelSlots) ?? [null, null, null];

  const completedAgents = Array.from(auditAgents.values())
    .filter(a => a.status === 'completed' || a.status === 'failed')
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
          Security Audit (Fase 2)
        </span>
        <span className="text-[11px] text-zinc-500 font-mono">
          {completedAgents.length}/{TOTAL_AGENTS} concluidos
        </span>
      </div>

      {/* Top: completed list */}
      {completedAgents.length > 0 && (
        <div className="px-4 py-2 border-b border-zinc-800/60 shrink-0">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-zinc-500 text-left">
                <th className="font-medium pr-3 py-1">Agente</th>
                <th className="font-medium pr-3 py-1">Modelo</th>
                <th className="font-medium pr-3 py-1 text-right">Arquivos</th>
                <th className="font-medium pr-3 py-1 text-right">Extras</th>
                <th className="font-medium pr-3 py-1 text-right">Findings</th>
                <th className="font-medium py-1 text-right">Duracao</th>
              </tr>
            </thead>
            <tbody>
              {completedAgents.map(a => (
                <tr key={a.agentId} className="text-zinc-400 border-t border-zinc-800/40">
                  <td className="pr-3 py-1 truncate max-w-[140px]">{a.name}</td>
                  <td className="pr-3 py-1 font-mono">{shortenModel(a.model)}</td>
                  <td className="pr-3 py-1 font-mono text-right">{a.filesAnalyzed}</td>
                  <td
                    className="pr-3 py-1 font-mono text-right"
                    title={a.runtime === 'codex' ? 'Metrica de extras nao disponivel para runtime Codex (sem tool Read tipado)' : undefined}
                  >
                    {a.runtime === 'codex' ? '—' : a.additionalFilesAfterStart}
                  </td>
                  <td className="pr-3 py-1 font-mono text-right">{a.findingsCount ?? 0}</td>
                  <td className="py-1 font-mono text-right">{formatDuration(a.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 3 panels grid */}
      <div className="grid grid-cols-3 gap-3 p-3 flex-1 min-h-0">
        {auditPanelSlots.map((slotId, idx) => {
          const agent = slotId ? auditAgents.get(slotId) ?? null : null;
          return <AgentPanel key={idx} agent={agent} />;
        })}
      </div>

      {/* Footer indicator */}
      {isStreaming && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-zinc-800 shrink-0">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
          </span>
          <span className="text-[11px] text-amber-300">Auditoria em andamento</span>
        </div>
      )}
    </div>
  );
}
