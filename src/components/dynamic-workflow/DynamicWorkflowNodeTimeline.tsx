import { useMemo } from 'react';
import { Check, X, Loader2, Minus, Clock, Pencil, Eye, Wrench, Server, RotateCcw, ShieldCheck } from 'lucide-react';
import type {
  DynamicWorkflowManifest,
  DynamicWorkflowNode,
  DynamicWorkflowNodeRun,
  DynamicWorkflowNodeStatus,
} from '@/types';
import type { CockpitNodeRun } from '@/types/dynamic-workflow-cockpit';
import { parseRoundIndex } from './WorkflowProgressBar';

function parseStringArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    return [];
  } catch {
    return [];
  }
}

export interface NodeRunSummary {
  status: DynamicWorkflowNodeStatus | 'pending';
  attempts: number;
  costUsd: number;
  runtime: string | null;
}

export function summarizeNodeRuns(nodeId: string, nodeRuns: DynamicWorkflowNodeRun[]): NodeRunSummary {
  const runs = nodeRuns.filter((nr) => nr.nodeId === nodeId);
  if (runs.length === 0) return { status: 'pending', attempts: 0, costUsd: 0, runtime: null };
  let latest = runs[0];
  let maxAttempt = runs[0].attempt;
  let costUsd = 0;
  for (const nr of runs) {
    if (nr.attempt >= latest.attempt) latest = nr;
    if (nr.attempt > maxAttempt) maxAttempt = nr.attempt;
    costUsd += nr.costUsd;
  }
  return {
    status: latest.status,
    attempts: maxAttempt + 1,
    costUsd,
    runtime: latest.runtime,
  };
}

interface EnforcementInfo {
  label: string;
  title: string;
}

export function enforcementForRuntime(runtime: string | null): EnforcementInfo | null {
  switch (runtime) {
    case 'cloud':
    case 'zai':
    case 'minimax-tp':
      return {
        label: 'canUseTool (in-process)',
        title: 'Permissoes aplicadas in-process pelo guard canUseTool (Claude/Claude-compat SDK).',
      };
    case 'codex':
      return {
        label: 'sandbox do CLI',
        title:
          'O Codex CLI dirige o loop; as permissoes sao aplicadas pelo sandbox do proprio CLI, nao por canUseTool in-process.',
      };
    case 'kimi':
      return {
        label: 'CLI sem sandbox comprovado',
        title: 'O Kimi CLI dirige o loop, mas o workflow bloqueia grants que dependam de sandbox ainda nao comprovado.',
      };
    case 'grok':
      return {
        label: 'guard + sandbox do Grok CLI',
        title:
          'Permissoes do node passam pelo guard do LionClaw; o processo usa home, allowlist de tools e profile dedicados do Grok CLI.',
      };
    case 'local':
    case 'external':
      return {
        label: 'local',
        title: 'Enforcement local (executor do runtime local/external).',
      };
    default:
      return null;
  }
}

export function shortNodeId(nodeId: string): string {
  if (!nodeId.includes(':')) return nodeId;
  const middle = nodeId.split(':').slice(2, -1).join(':');
  return middle.length > 0 ? middle : nodeId;
}

export function nodeDisplayName(nr: Pick<CockpitNodeRun, 'nodeId' | 'agentId' | 'label'>): string {
  if (typeof nr.label === 'string' && nr.label.trim().length > 0) return nr.label;
  if (nr.agentId) return nr.agentId;
  return shortNodeId(nr.nodeId);
}

export interface ExecutionNodeView {
  nodeId: string;
  displayName: string;
  phaseId: string;
  latest: CockpitNodeRun;
  attempts: number;
  status: DynamicWorkflowNodeStatus;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  costUnknown: boolean;
  costEstimated: boolean;
  staticNode: DynamicWorkflowNode | null;
}

export interface ExecutionPhaseGroup {
  phaseId: string;
  name: string;
  nodes: ExecutionNodeView[];
}

function startedMs(nr: CockpitNodeRun): number {
  if (!nr.startedAt) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(nr.startedAt);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

export function orderByExecution(nodeRuns: CockpitNodeRun[]): CockpitNodeRun[] {
  return nodeRuns
    .map((nr, index) => ({ nr, index }))
    .sort((a, b) => {
      const da = startedMs(a.nr);
      const db = startedMs(b.nr);
      if (da !== db) return da < db ? -1 : 1;
      return a.index - b.index;
    })
    .map((x) => x.nr);
}

export type CostConfidence = 'known' | 'estimated' | 'unknown';

export function costConfidence(costStatus: string | null): CostConfidence {
  if (costStatus === null || costStatus === 'known') return 'known';
  if (costStatus === 'estimated-partial') return 'estimated';
  return 'unknown';
}

export function formatCostWithConfidence(
  usd: number,
  unknown: boolean,
  estimated: boolean,
  format: (usd: number) => string,
): string {
  if (unknown) return '?';
  return (estimated ? '~' : '') + format(usd);
}

export function deriveExecutionGroups(
  nodeRuns: CockpitNodeRun[],
  nodes: DynamicWorkflowNode[],
  manifest: DynamicWorkflowManifest | null,
): ExecutionPhaseGroup[] {
  const staticById = new Map<string, DynamicWorkflowNode>();
  for (const n of nodes) staticById.set(n.nodeId, n);
  const phaseName = new Map<string, string>();
  if (manifest) for (const p of manifest.phases) phaseName.set(p.id, p.name || p.id);

  const byNode = new Map<string, ExecutionNodeView>();
  const phaseOrder: string[] = [];
  for (const nr of orderByExecution(nodeRuns)) {
    const pid = nr.phaseId || 'sem-fase';
    if (!phaseOrder.includes(pid)) phaseOrder.push(pid);
    const existing = byNode.get(nr.nodeId);
    const confidence = costConfidence(nr.costStatus);
    const unknown = confidence === 'unknown';
    const estimated = confidence === 'estimated';
    if (!existing) {
      byNode.set(nr.nodeId, {
        nodeId: nr.nodeId,
        displayName: nodeDisplayName(nr),
        phaseId: pid,
        latest: nr,
        attempts: 1,
        status: nr.status,
        costUsd: nr.costUsd,
        inputTokens: nr.inputTokens,
        outputTokens: nr.outputTokens,
        durationMs: nr.durationMs,
        costUnknown: unknown,
        costEstimated: estimated,
        staticNode: staticById.get(nr.nodeId) ?? null,
      });
      continue;
    }
    existing.attempts += 1;
    existing.costUsd += nr.costUsd;
    existing.inputTokens += nr.inputTokens;
    existing.outputTokens += nr.outputTokens;
    existing.durationMs += nr.durationMs;
    existing.costUnknown = existing.costUnknown || unknown;
    existing.costEstimated = existing.costEstimated || estimated;
    if (nr.attempt >= existing.latest.attempt) {
      existing.latest = nr;
      existing.status = nr.status;
      const name = nodeDisplayName(nr);
      if (name !== shortNodeId(nr.nodeId)) existing.displayName = name;
    }
  }

  return phaseOrder.map((pid) => ({
    phaseId: pid,
    name: phaseName.get(pid) ?? pid,
    nodes: Array.from(byNode.values()).filter((n) => n.phaseId === pid),
  }));
}

function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}c`;
  return `$${usd.toFixed(3)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '--';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return sec > 0 ? `${min}m${String(sec).padStart(2, '0')}s` : `${min}m`;
}

function StatusIcon({ status }: { status: NodeRunSummary['status'] }) {
  switch (status) {
    case 'completed':
      return <Check size={12} strokeWidth={3} className="text-green-400" />;
    case 'running':
      return <Loader2 size={12} className="text-amber-400 animate-spin" />;
    case 'failed':
    case 'blocked':
      return <X size={12} strokeWidth={3} className="text-red-400" />;
    case 'interrupted':
      return <Clock size={12} className="text-amber-300" />;
    case 'skipped':
    case 'cancelled':
      return <Minus size={12} className="text-zinc-500" />;
    default:
      return <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ border: '1.5px dashed #52525b' }} />;
  }
}

function statusLabel(status: NodeRunSummary['status']): string {
  switch (status) {
    case 'completed':
      return 'concluido';
    case 'running':
      return 'rodando';
    case 'failed':
      return 'falhou';
    case 'blocked':
      return 'bloqueado';
    case 'interrupted':
      return 'interrompido';
    case 'skipped':
      return 'pulado';
    case 'cancelled':
      return 'cancelado';
    default:
      return 'pendente';
  }
}

function ExecutionNodeCard({ view, phaseName }: { view: ExecutionNodeView; phaseName: string }) {
  const node = view.staticNode;
  const writeSet = parseStringArray(node?.writeSetJson);
  const tools = parseStringArray(node?.allowedToolsJson);
  const mcp = parseStringArray(node?.allowedMcpJson);
  const isWriter =
    node?.access === 'workspace-write' || writeSet.length > 0 || typeof view.latest.worktreeCommitSha === 'string';
  const roundIdx = parseRoundIndex(view.nodeId);
  const enforcement = enforcementForRuntime(view.latest.runtime);
  const failed = view.status === 'failed' || view.status === 'blocked';

  return (
    <div
      className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
      data-testid={`execution-node-${view.nodeId}`}
      title={view.nodeId}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <StatusIcon status={view.status} />
            {/* Nome do node (label/papel) em sans; o id completo fica no title. */}
            <span className="truncate text-[12px] font-medium text-zinc-200">{view.displayName}</span>
            <span className="shrink-0 rounded bg-zinc-800/80 px-1 py-px text-[10px] text-zinc-400">{phaseName}</span>
            {roundIdx !== null && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-300/80">
                <RotateCcw size={8} />r{roundIdx + 1}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-400">
            <span>{statusLabel(view.status)}</span>
            <span className="font-mono text-zinc-500">#{view.latest.attempt}</span>
            {view.attempts > 1 && <span className="font-mono text-zinc-500">{view.attempts} tentativas</span>}
            {view.latest.agentId && view.displayName !== view.latest.agentId && (
              <span className="text-zinc-500">{view.latest.agentId}</span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-zinc-500">
            <span title="duracao">{formatDuration(view.durationMs)}</span>
            <span
              title={
                view.costUnknown
                  ? `custo nao confiavel: ${view.latest.costStatus}`
                  : view.costEstimated
                    ? 'custo aproximado (piso)'
                    : 'custo'
              }
              className={view.costUnknown ? 'text-amber-300/80' : 'text-zinc-300'}
            >
              {formatCostWithConfidence(view.costUsd, view.costUnknown, view.costEstimated, formatCost)}
            </span>
            <span title="tokens in/out">
              {formatTokens(view.inputTokens)}
              <span className="text-zinc-600">/</span>
              {formatTokens(view.outputTokens)}
            </span>
          </div>
          {failed && view.latest.error && (
            <p className="mt-1 break-words text-[11px] text-red-300/90">
              {view.latest.failureClass ? `[${view.latest.failureClass}] ` : ''}
              {view.latest.error}
            </p>
          )}
        </div>
        {/* Acesso: writer (Pencil amber) vs read-only (Eye zinc). */}
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium shrink-0 ${
            isWriter
              ? 'text-amber-300 border-amber-500/40 bg-amber-500/10'
              : 'text-zinc-400 border-zinc-700 bg-zinc-800/60'
          }`}
          title={isWriter ? 'Escreve no workspace do run' : 'Somente leitura'}
        >
          {isWriter ? <Pencil size={9} /> : <Eye size={9} />}
          {isWriter ? 'escreve' : 'le'}
        </span>
      </div>

      {/* Mecanismo de enforcement ATIVO por node (derivado do runtime real). */}
      {enforcement && (
        <div className="mt-1.5">
          <span
            className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400"
            title={enforcement.title}
          >
            <ShieldCheck size={9} className="text-zinc-500" />
            {enforcement.label}
          </span>
        </div>
      )}

      {/* Grants do node estatico, quando existe (SPEC 13.3). */}
      {(writeSet.length > 0 || tools.length > 0 || mcp.length > 0) && (
        <div className="mt-1.5 flex flex-col gap-1">
          {writeSet.length > 0 && (
            <div className="flex items-start gap-1.5 text-[11px]">
              <Pencil size={10} className="text-zinc-500 shrink-0 mt-0.5" />
              <span className="font-mono text-zinc-500 break-all">{writeSet.join('  ')}</span>
            </div>
          )}
          {tools.length > 0 && (
            <div className="flex items-start gap-1.5 text-[11px]">
              <Wrench size={10} className="text-zinc-500 shrink-0 mt-0.5" />
              <span className="font-mono text-zinc-500 break-words">{tools.join(', ')}</span>
            </div>
          )}
          {mcp.length > 0 && (
            <div className="flex items-start gap-1.5 text-[11px]">
              <Server size={10} className="text-zinc-500 shrink-0 mt-0.5" />
              <span className="font-mono text-zinc-500 break-words">{mcp.join(', ')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export interface DynamicWorkflowNodeTimelineProps {
  manifest: DynamicWorkflowManifest | null;
  nodes: DynamicWorkflowNode[];
  nodeRuns: CockpitNodeRun[];
  filterNodeIds?: string[] | null;
}

export function DynamicWorkflowNodeTimeline({
  manifest,
  nodes,
  nodeRuns,
  filterNodeIds = null,
}: DynamicWorkflowNodeTimelineProps) {
  const visibleRuns = useMemo(() => {
    if (!filterNodeIds || filterNodeIds.length === 0) return nodeRuns;
    const allow = new Set(filterNodeIds);
    return nodeRuns.filter((nr) => allow.has(nr.nodeId));
  }, [nodeRuns, filterNodeIds]);

  const groups = useMemo(() => deriveExecutionGroups(visibleRuns, nodes, manifest), [visibleRuns, nodes, manifest]);

  if (nodeRuns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-zinc-400" data-testid="execution-empty">
        Nenhum node executou ainda
      </div>
    );
  }

  if (visibleRuns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-zinc-400">Nenhum node nesta rodada.</div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto" data-testid="execution-groups">
      {groups.map((group) => (
        <div key={group.phaseId} data-testid={`execution-phase-${group.phaseId}`}>
          <p className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-zinc-400 font-medium">
            <span className="truncate" title={group.phaseId}>
              {group.name}
            </span>
            <span className="font-mono text-[10px] text-zinc-500">{group.nodes.length}</span>
          </p>
          <div className="flex flex-col gap-2">
            {group.nodes.map((view) => (
              <ExecutionNodeCard key={view.nodeId} view={view} phaseName={group.name} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
