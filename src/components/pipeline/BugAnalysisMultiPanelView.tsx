import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle, Loader2, XCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useActiveProjectState } from '@/hooks/useActiveProjectState';
import { shortenModel } from '@/utils/model-display';
import type { AuditAgentState } from '@/types/pipeline';

const TOTAL_BUG_ANALYSTS = 3;

interface BugAnalysisMultiPanelViewProps {
  isStreaming: boolean;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem}s`;
}

interface BugAnalystPanelProps {
  agent: AuditAgentState | null;
}

function BugAnalystPanel({ agent }: BugAnalystPanelProps) {
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
          Aguardando analista
        </div>
        <div className="flex-1 flex items-center justify-center text-zinc-700 text-xs italic">slot vazio</div>
      </div>
    );
  }

  const statusIcon = (() => {
    switch (agent.status) {
      case 'completed':
        return <CheckCircle size={12} className="text-green-400 shrink-0" />;
      case 'failed':
        return <XCircle size={12} className="text-red-400 shrink-0" />;
      case 'running':
        return <Loader2 size={12} className="text-amber-400 animate-spin shrink-0" />;
      default:
        return null;
    }
  })();

  return (
    <div className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/40 min-h-0 h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-zinc-800/60 shrink-0">
        <div className="flex items-center gap-2 mb-1">
          {statusIcon}
          <span className="text-xs font-semibold text-zinc-200 truncate flex-1">{agent.name}</span>
          {agent.model && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-900/30 text-red-300 border border-red-800/50 shrink-0">
              {shortenModel(agent.model)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-zinc-500 font-mono">
          {/* O Bug Pipe nao tem conjunto INICIAL de arquivos (nao ha manifest do
              repo-profiler), entao `filesAnalyzed` e sempre 0 e o unico numero
              com semantica e o de arquivos abertos pelo proprio analista. */}
          {agent.runtime === 'codex' ? (
            <span
              className="text-zinc-600"
              title="Metrica de arquivos abertos nao disponivel para runtime Codex (sem tool Read tipado)"
            >
              arquivos: —
            </span>
          ) : (
            <span>{agent.additionalFilesAfterStart} arquivos abertos</span>
          )}
          <span>{agent.toolCallsCount} tool calls</span>
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

export function BugAnalysisMultiPanelView({ isStreaming }: BugAnalysisMultiPanelViewProps) {
  const bugAgents = useActiveProjectState((s) => s.auditAgents) ?? new Map<string, AuditAgentState>();

  const panels: Array<AuditAgentState | null> = useMemo(() => {
    const ordered = Array.from(bugAgents.values()).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const slots: Array<AuditAgentState | null> = [];
    for (let i = 0; i < TOTAL_BUG_ANALYSTS; i += 1) {
      slots.push(ordered[i] ?? null);
    }
    return slots;
  }, [bugAgents]);

  const completedAgents = Array.from(bugAgents.values())
    .filter((a) => a.status === 'completed' || a.status === 'failed')
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Analise Paralela (Fase 2)</span>
        <span className="text-[11px] text-zinc-500 font-mono">
          {completedAgents.length}/{TOTAL_BUG_ANALYSTS} concluidos
        </span>
      </div>

      {/* Top: completed list */}
      {completedAgents.length > 0 && (
        <div className="px-4 py-2 border-b border-zinc-800/60 shrink-0">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-zinc-500 text-left">
                <th className="font-medium pr-3 py-1">Analista</th>
                <th className="font-medium pr-3 py-1">Modelo</th>
                <th className="font-medium pr-3 py-1 text-right">Arquivos</th>
                <th className="font-medium pr-3 py-1 text-right">Tool calls</th>
                <th className="font-medium py-1 text-right">Duracao</th>
              </tr>
            </thead>
            <tbody>
              {completedAgents.map((a) => (
                <tr key={a.agentId} className="text-zinc-400 border-t border-zinc-800/40">
                  <td className="pr-3 py-1 truncate max-w-[180px]">{a.name}</td>
                  <td className="pr-3 py-1 font-mono">{shortenModel(a.model)}</td>
                  <td
                    className="pr-3 py-1 font-mono text-right"
                    title={
                      a.runtime === 'codex'
                        ? 'Metrica de arquivos abertos nao disponivel para runtime Codex (sem tool Read tipado)'
                        : undefined
                    }
                  >
                    {a.runtime === 'codex' ? '—' : a.additionalFilesAfterStart}
                  </td>
                  <td className="pr-3 py-1 font-mono text-right">{a.toolCallsCount}</td>
                  <td className="py-1 font-mono text-right">{formatDuration(a.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 3 painels estaticos */}
      <div className="grid grid-cols-3 gap-3 p-3 flex-1 min-h-0">
        {panels.map((agent, idx) => (
          <BugAnalystPanel key={agent?.agentId ?? `slot-${idx}`} agent={agent} />
        ))}
      </div>

      {/* Footer indicator */}
      {isStreaming && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-zinc-800 shrink-0">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
          </span>
          <span className="text-[11px] text-red-300">Analise em andamento</span>
        </div>
      )}
    </div>
  );
}
