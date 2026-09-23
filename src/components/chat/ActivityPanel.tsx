import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  Wrench,
  Workflow,
  CheckCircle2,
  AlertTriangle,
  Ban,
  Loader2,
  X,
  ChevronRight,
  ChevronDown,
  FileText,
  Terminal,
  Eye,
  Pencil,
} from 'lucide-react';
import { useChatStore, useVisibleThread } from '@/stores/chat-store';
import { usePipelineStore } from '@/stores/pipeline-store';
import { useAppStore } from '@/stores/app-store';
import { SwarmPanel } from '../swarm/SwarmPanel';
import { PipelinesActiveSidebar } from '../common/PipelinesActiveSidebar';
import { WorkflowRunRow } from '../dynamic-workflow/WorkflowRunRow';
import { useDynamicWorkflowStore, type DynamicWorkflowUIStatus } from '@/stores/dynamic-workflow-store';

const WORKFLOW_TERMINAL_UI: ReadonlySet<DynamicWorkflowUIStatus> = new Set<DynamicWorkflowUIStatus>([
  'completed',
  'failed',
  'aborted',
  'interrupted',
]);
import { UsageLimitsCard } from './UsageLimitsCard';
import type { ChatMessage, LiveActivity, LiveActivityKind, LiveActivityStatus } from '@/types';

interface ActivityNode extends LiveActivity {
  children: ActivityNode[];
}

interface TurnBlock {
  turnIndex: number;
  title?: string;
  roots: ActivityNode[];
  startedAt?: string;
  status: LiveActivityStatus;
  totals: { tokens: number; costUsd: number; subagents: number; tools: number };
}

function buildTree(activities: LiveActivity[]): ActivityNode[] {
  const byId = new Map<string, ActivityNode>();
  for (const a of activities) byId.set(a.id, { ...a, children: [] });
  const roots: ActivityNode[] = [];
  for (const a of activities) {
    const node = byId.get(a.id)!;
    const parent = a.parentId ? byId.get(a.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function deriveBlockStatus(items: LiveActivity[]): LiveActivityStatus {
  if (items.some((a) => a.status === 'running')) return 'running';
  if (items.some((a) => a.status === 'stopped')) return 'stopped';
  return 'done';
}

function buildTurnTitles(messages: ChatMessage[]): Map<number, string> {
  const titles = new Map<number, string>();
  let n = 0;
  for (const m of messages) {
    if (m.role !== 'user') continue;
    n += 1;
    const firstLine = (m.content ?? '').trim().split('\n')[0]?.trim();
    if (firstLine) titles.set(n, firstLine);
  }
  return titles;
}

function groupIntoBlocks(activities: LiveActivity[], titles: Map<number, string>): TurnBlock[] {
  const byTurn = new Map<number, LiveActivity[]>();
  for (const a of activities) {
    const t = a.turnIndex ?? 0;
    const arr = byTurn.get(t);
    if (arr) arr.push(a);
    else byTurn.set(t, [a]);
  }
  const blocks: TurnBlock[] = [];
  for (const [turnIndex, items] of byTurn) {
    const roots = buildTree(items);
    const totals = items.reduce(
      (acc, it) => {
        const tin = it.tokens?.input ?? 0;
        const tout = it.tokens?.output ?? 0;
        acc.tokens += tin + tout;
        acc.costUsd += it.costUsd ?? 0;
        if (it.kind === 'subagent') acc.subagents += 1;
        else if (it.kind === 'tool') acc.tools += 1;
        return acc;
      },
      { tokens: 0, costUsd: 0, subagents: 0, tools: 0 },
    );
    const startedAt = items
      .map((it) => it.startedAt)
      .filter((s): s is string => typeof s === 'string')
      .sort()[0];
    blocks.push({
      turnIndex,
      title: titles.get(turnIndex),
      roots,
      startedAt,
      status: deriveBlockStatus(items),
      totals,
    });
  }
  blocks.sort((a, b) => a.turnIndex - b.turnIndex);
  return blocks;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${(tokens / 1_000).toFixed(1)}K`;
  if (tokens >= 1_000) return tokens.toLocaleString();
  return String(tokens);
}

function formatCost(costUsd?: number): string | null {
  if (typeof costUsd !== 'number') return null;
  if (costUsd === 0) return '$0';
  if (costUsd < 0.001) return '<$0.001';
  if (costUsd < 0.01) return `~$${costUsd.toFixed(4)}`;
  return `~$${costUsd.toFixed(3)}`;
}

function formatDuration(ms?: number): string | null {
  if (typeof ms !== 'number' || ms <= 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem}s`;
}

function formatLiveClock(node: LiveActivity, now: number): string | null {
  if (node.status === 'running') {
    if (!node.startedAt) return null;
    const started = Date.parse(node.startedAt);
    if (Number.isNaN(started)) return null;
    return formatDuration(Math.max(0, now - started));
  }
  if (typeof node.durationMs === 'number' && node.durationMs > 0) {
    return formatDuration(node.durationMs);
  }
  if (node.startedAt && node.endedAt) {
    const a = Date.parse(node.startedAt);
    const b = Date.parse(node.endedAt);
    if (!Number.isNaN(a) && !Number.isNaN(b) && b > a) return formatDuration(b - a);
  }
  return null;
}

const STATUS_TEXT: Record<LiveActivityStatus, string> = {
  running: 'Executando',
  done: 'Concluido',
  error: 'Erro',
  stopped: 'Parado',
};

const STATUS_TEXT_CLASS: Record<LiveActivityStatus, string> = {
  running: 'text-amber-400',
  done: 'text-emerald-400',
  error: 'text-red-400',
  stopped: 'text-zinc-500',
};

function KindIcon({ kind, status }: { kind: LiveActivityKind; status: LiveActivityStatus }) {
  const cls = `w-3.5 h-3.5 shrink-0 ${status === 'running' ? 'text-amber-400' : 'text-zinc-500'}`;
  if (kind === 'tool') return <Wrench className={cls} />;
  if (kind === 'pipeline' || kind === 'workflow') return <Workflow className={cls} />;
  return <Bot className={cls} />;
}

function StatusIcon({ status }: { status: LiveActivityStatus }) {
  if (status === 'running') return <Loader2 className="w-3 h-3 shrink-0 text-amber-400 animate-spin" />;
  if (status === 'done') return <CheckCircle2 className="w-3 h-3 shrink-0 text-emerald-400" />;
  if (status === 'error') return <AlertTriangle className="w-3 h-3 shrink-0 text-red-400" />;
  return <Ban className="w-3 h-3 shrink-0 text-zinc-500" />;
}

function ChangeBadge({ changed }: { changed?: boolean }) {
  if (changed === true) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1 py-px text-[9px] font-medium text-amber-400">
        <Pencil className="h-2.5 w-2.5" />
        alterou
      </span>
    );
  }
  if (changed === false) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded bg-zinc-700/40 px-1 py-px text-[9px] font-medium text-zinc-400">
        <Eye className="h-2.5 w-2.5" />
        leu
      </span>
    );
  }
  return null;
}

function SubagentRow({ node, now }: { node: ActivityNode; now: number }) {
  const tin = node.tokens?.input ?? 0;
  const tout = node.tokens?.output ?? 0;
  const hasTokens = tin > 0 || tout > 0;
  const cost = formatCost(node.costUsd);
  const clock = formatLiveClock(node, now);
  const toolUses = typeof node.toolUses === 'number' ? node.toolUses : null;

  return (
    <div className="rounded border border-zinc-800/70 bg-zinc-900/30 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <KindIcon kind={node.kind} status={node.status} />
        <span className={`truncate text-xs ${node.status === 'running' ? 'text-zinc-200' : 'text-zinc-300'}`}>
          {node.label}
        </span>
        <span className={`ml-auto shrink-0 text-[10px] font-medium ${STATUS_TEXT_CLASS[node.status]}`}>
          {STATUS_TEXT[node.status]}
        </span>
        <StatusIcon status={node.status} />
      </div>
      {node.description && (
        <div className="mt-0.5 truncate pl-5 text-[10px] text-zinc-500" title={node.description}>
          {node.description}
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 font-mono text-[10px] text-zinc-600">
        {clock && <span className={node.status === 'running' ? 'text-amber-400/80' : ''}>{clock}</span>}
        {toolUses !== null && (
          <span>
            {toolUses}
            <span className="text-zinc-700"> tools</span>
          </span>
        )}
        {hasTokens && (
          <span>
            {formatTokenCount(tin)}
            <span className="text-zinc-700">in</span> {formatTokenCount(tout)}
            <span className="text-zinc-700">out</span>
          </span>
        )}
        {cost !== null && <span>{cost}</span>}
      </div>
      {node.summary && (
        <div className="mt-0.5 line-clamp-2 pl-5 text-[10px] leading-snug text-zinc-500" title={node.summary}>
          {node.summary}
        </div>
      )}
      {node.children.length > 0 && (
        <div className="mt-1 space-y-1 border-l border-zinc-800 pl-2">
          {node.children.map((child) =>
            child.kind === 'tool' ? (
              <ToolRow key={child.id} node={child} now={now} />
            ) : (
              <SubagentRow key={child.id} node={child} now={now} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ToolRow({ node, now }: { node: ActivityNode; now: number }) {
  const clock = formatLiveClock(node, now);
  const detail = node.file ?? node.command ?? null;
  const isCommand = !node.file && !!node.command;

  return (
    <div className="px-0.5 py-0.5">
      <div className="flex items-center gap-1.5">
        {isCommand ? (
          <Terminal className={`w-3 h-3 shrink-0 ${node.status === 'running' ? 'text-amber-400' : 'text-zinc-500'}`} />
        ) : node.file ? (
          <FileText className={`w-3 h-3 shrink-0 ${node.status === 'running' ? 'text-amber-400' : 'text-zinc-500'}`} />
        ) : (
          <KindIcon kind={node.kind} status={node.status} />
        )}
        <span className={`truncate text-[11px] ${node.status === 'running' ? 'text-zinc-300' : 'text-zinc-400'}`}>
          {node.label}
        </span>
        <ChangeBadge changed={node.changed} />
        <StatusIcon status={node.status} />
      </div>
      {detail && (
        <div className="truncate pl-4.5 font-mono text-[10px] text-zinc-600" title={detail}>
          {detail}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-2 pl-4.5 font-mono text-[10px] text-zinc-600">
        {typeof node.exitCode === 'number' && (
          <span className={node.exitCode === 0 ? 'text-zinc-600' : 'text-red-400'}>exit {node.exitCode}</span>
        )}
        {clock && <span className={node.status === 'running' ? 'text-amber-400/80' : ''}>{clock}</span>}
      </div>
      {node.children.length > 0 && (
        <div className="mt-1 space-y-1 border-l border-zinc-800 pl-2">
          {node.children.map((child) =>
            child.kind === 'tool' ? (
              <ToolRow key={child.id} node={child} now={now} />
            ) : (
              <SubagentRow key={child.id} node={child} now={now} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

const PIPELINE_STATUS_TEXT: Record<LiveActivityStatus, string> = {
  running: 'Trabalhando',
  done: 'Concluido',
  error: 'Erro',
  stopped: 'Parado',
};

function PipelinePhaseRow({ node, now }: { node: ActivityNode; now: number }) {
  const clock = formatLiveClock(node, now);
  const clickable = Boolean(node.projectId);

  const navigate = (): void => {
    if (!node.projectId) return;
    usePipelineStore.getState().setActiveProject(node.projectId);
    useAppStore.getState().setPage('pipeline');
  };

  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? navigate : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') navigate();
            }
          : undefined
      }
      title={clickable ? 'Abrir pipeline' : undefined}
      className={`rounded border px-2 py-1.5 ${
        node.status === 'running' ? 'border-amber-500/30 bg-amber-500/5' : 'border-zinc-700/60 bg-zinc-900/60'
      }${clickable ? ' cursor-pointer transition-colors hover:bg-zinc-800/60' : ''}`}
    >
      <div className="flex items-center gap-1.5">
        <KindIcon kind={node.kind} status={node.status} />
        <span
          className={`truncate text-xs font-medium ${node.status === 'running' ? 'text-zinc-200' : 'text-zinc-300'}`}
        >
          {node.label}
        </span>
        <span className={`ml-auto shrink-0 text-[10px] font-medium ${STATUS_TEXT_CLASS[node.status]}`}>
          {PIPELINE_STATUS_TEXT[node.status]}
        </span>
        <StatusIcon status={node.status} />
      </div>
      {clock && (
        <div className="mt-1 flex items-center pl-5 font-mono text-[10px] text-zinc-600">
          <span className={node.status === 'running' ? 'text-amber-400/80' : ''}>{clock}</span>
        </div>
      )}
      {node.summary && (
        <div className="mt-0.5 line-clamp-2 pl-5 text-[10px] leading-snug text-zinc-500" title={node.summary}>
          {node.summary}
        </div>
      )}
    </div>
  );
}

function RootNode({ node, now }: { node: ActivityNode; now: number }) {
  if (node.kind === 'workflow') return <WorkflowRunRow node={node} now={now} />;
  if (node.kind === 'pipeline') return <PipelinePhaseRow node={node} now={now} />;
  if (node.kind === 'tool') return <ToolRow node={node} now={now} />;
  return <SubagentRow node={node} now={now} />;
}

function BlockTotals({ totals }: { totals: TurnBlock['totals'] }) {
  const cost = formatCost(totals.costUsd);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-zinc-600">
      {totals.subagents > 0 && (
        <span>
          {totals.subagents}
          <span className="text-zinc-700"> sub</span>
        </span>
      )}
      {totals.tools > 0 && (
        <span>
          {totals.tools}
          <span className="text-zinc-700"> tools</span>
        </span>
      )}
      {totals.tokens > 0 && <span>{formatTokenCount(totals.tokens)} tok</span>}
      {cost !== null && totals.costUsd > 0 && <span>{cost}</span>}
    </div>
  );
}

function TurnBlockView({ block, now, hiddenIds }: { block: TurnBlock; now: number; hiddenIds?: ReadonlySet<string> }) {
  const [open, setOpen] = useState(block.status === 'running');
  const visibleRoots = hiddenIds ? block.roots.filter((n) => !hiddenIds.has(n.id)) : block.roots;
  const hiddenCount = block.roots.length - visibleRoots.length;

  return (
    <div className="border-b border-zinc-800/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-1.5 px-2 py-2 text-left transition-colors hover:bg-zinc-900/50"
      >
        <span className="mt-0.5 shrink-0 text-zinc-600">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-zinc-300" title={block.title}>
              {block.title || `Turno ${block.turnIndex}`}
            </span>
            <span className={`ml-auto shrink-0 text-[10px] font-medium ${STATUS_TEXT_CLASS[block.status]}`}>
              {STATUS_TEXT[block.status]}
            </span>
            <StatusIcon status={block.status} />
          </div>
          <div className="mt-0.5">
            <BlockTotals totals={block.totals} />
          </div>
        </div>
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pb-2">
          {visibleRoots.length === 0 ? (
            <div className="px-1 text-[10px] text-zinc-600">
              {hiddenCount > 0 ? 'Workflow fixado no topo do painel.' : 'Sem chamadas neste turno.'}
            </div>
          ) : (
            visibleRoots.map((node) => <RootNode key={node.id} node={node} now={now} />)
          )}
        </div>
      )}
    </div>
  );
}

export function ActivityPanel() {
  const { activities, messages, activitiesPanelOpen: open } = useVisibleThread();
  const toggle = useChatStore((s) => s.toggleActivitiesPanel);

  const running = useMemo(() => activities.some((a) => a.status === 'running'), [activities]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const titles = useMemo(() => buildTurnTitles(messages), [messages]);
  const blocks = useMemo(() => groupIntoBlocks(activities, titles), [activities, titles]);

  const workflowRuns = useDynamicWorkflowStore((s) => s.runs);
  const getWorkflowUIStatus = useDynamicWorkflowStore((s) => s.getUIStatus);
  const pinnedWorkflows = useMemo(() => {
    const seen = new Set<string>();
    const out: ActivityNode[] = [];
    for (const block of blocks) {
      for (const node of block.roots) {
        if (node.kind !== 'workflow' || !node.projectId) continue;
        if (!workflowRuns.some((r) => r.id === node.projectId)) continue;
        if (WORKFLOW_TERMINAL_UI.has(getWorkflowUIStatus(node.projectId))) continue;
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        out.push(node);
      }
    }
    return out;
  }, [blocks, workflowRuns, getWorkflowUIStatus]);
  const pinnedIds = useMemo(() => new Set(pinnedWorkflows.map((n) => n.id)), [pinnedWorkflows]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 80) {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [blocks, running]);

  if (!open) {
    return (
      <>
        {/* Desktop: trilho fino inline. */}
        <button
          type="button"
          onClick={() => toggle(true)}
          title="Mostrar atividade"
          className="group relative hidden w-9 shrink-0 flex-col items-center border-l border-zinc-800 bg-zinc-950/60 py-3 transition-colors hover:bg-zinc-900 md:flex"
        >
          <Activity
            className={`w-4 h-4 transition-colors ${running ? 'text-amber-400' : 'text-zinc-500 group-hover:text-zinc-300'}`}
          />
          {running && <span className="absolute right-1.5 top-2 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />}
        </button>
        {/* Mobile: botao flutuante (overlay), nao ocupa coluna. */}
        <button
          type="button"
          onClick={() => toggle(true)}
          title="Mostrar atividade"
          className="fixed bottom-20 right-3 z-30 flex h-10 w-10 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900/90 shadow-lg transition-colors hover:bg-zinc-800 md:hidden"
        >
          <Activity className={`w-4 h-4 ${running ? 'text-amber-400' : 'text-zinc-400'}`} />
          {running && (
            <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
          )}
        </button>
      </>
    );
  }

  return (
    <>
      {/* Backdrop so em telas pequenas (drawer/overlay). Em desktop fica oculto. */}
      <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => toggle(false)} />
      <aside className="flex w-72 shrink-0 flex-col border-l border-zinc-800 bg-zinc-950 max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:w-80 max-md:shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-3 py-2">
          <div className="flex items-center gap-2">
            <Activity className={`w-3.5 h-3.5 ${running ? 'text-amber-400' : 'text-zinc-500'}`} />
            <span className="text-xs font-medium text-zinc-300">Atividade</span>
            {running && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />}
          </div>
          <button
            type="button"
            onClick={() => toggle(false)}
            title="Ocultar"
            className="text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {/* Limites das assinaturas (port do lioncode) pinned no topo, colapsado
            por default. So assinaturas CONECTADAS aparecem (filtro no main). */}
        <div className="shrink-0 border-b border-zinc-800">
          <UsageLimitsCard />
        </div>
        <div className="max-h-[60%] min-h-0 shrink-0 overflow-y-auto empty:hidden">
          {/* Workflow dinamico em execucao FIXO abaixo de Limites (pedido do dono):
              fora do scroll dos turnos enquanto o run estiver vivo. */}
          {pinnedWorkflows.length > 0 && (
            <div
              className="max-h-[45vh] shrink-0 space-y-1.5 overflow-y-auto border-b border-zinc-800 px-2 py-2"
              data-testid="workflow-pinned"
            >
              {pinnedWorkflows.map((node) => (
                <RootNode key={node.id} node={node} now={now} />
              ))}
            </div>
          )}
          {/* Pipelines ativos pinned no topo do painel de Atividade (pedido do dono:
              aqui, nao na sidebar esquerda). Fora do scroll dos turnos = sempre
              visivel enquanto o pipe roda. empty:hidden esconde o wrapper quando o
              componente renderiza null (sem pipeline ativo). */}
          <div className="shrink-0 border-b border-zinc-800 empty:hidden">
            <PipelinesActiveSidebar />
          </div>
          <div className="shrink-0 border-b border-zinc-800 empty:hidden">
            <SwarmPanel />
          </div>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {blocks.length === 0 ? (
            <div className="flex h-full items-center justify-center px-4 text-center">
              <span className="text-[11px] text-zinc-600">Nada por aqui ainda nesta conversa.</span>
            </div>
          ) : (
            blocks.map((block) => <TurnBlockView key={block.turnIndex} block={block} now={now} hiddenIds={pinnedIds} />)
          )}
        </div>
      </aside>
    </>
  );
}
