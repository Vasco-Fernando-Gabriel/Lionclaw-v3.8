import { useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  Check,
  X,
  Minus,
  Clock,
  FileText,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Wrench,
  Gavel,
} from 'lucide-react';
import type { GateDecisionSummary } from '@/stores/dynamic-workflow-store';
import type {
  DynamicWorkflowRun,
  DynamicWorkflowNodeRun,
  DynamicWorkflowNode,
  DynamicWorkflowNodeStatus,
  DynamicWorkflowManifest,
  DynamicWorkflowRunStatus,
} from '@/types';
import type { CockpitNodeRun } from '@/types/dynamic-workflow-cockpit';

function isRunDeliveredTerminal(runStatus: DynamicWorkflowRunStatus | null | undefined): boolean {
  return runStatus === 'delivered' || runStatus === 'completed';
}
import { useStreamTimer } from '@/components/chat/useStreamTimer';
import { parseRunStartedAt } from './BackgroundWorkflowIndicator';
import type { WorkflowNodeStreamState } from './WorkflowStreamView';

const WRITE_TOOL_NAMES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function deriveTouchedFiles(nodeStreams: Record<string, WorkflowNodeStreamState>): string[] {
  const set = new Set<string>();
  for (const ns of Object.values(nodeStreams)) {
    for (const tc of ns.toolCalls) {
      const path = tc.detail?.trim();
      if (path && WRITE_TOOL_NAMES.has(tc.toolName)) set.add(path);
    }
  }
  return Array.from(set).sort();
}

export interface RailNodeMetrics {
  status: DynamicWorkflowNodeStatus | 'pending';
  tokens: number;
  toolUses: number;
  durationMs: number;
  costUsd: number;
  liveStartedAtMs: number | null;
}

function parseNodeStartedAt(startedAt: string | null): number | null {
  if (!startedAt) return null;
  const ms = Date.parse(startedAt);
  return Number.isNaN(ms) ? null : ms;
}

export function aggregateNodeMetrics(nodeId: string, nodeRuns: DynamicWorkflowNodeRun[]): RailNodeMetrics {
  const runs = nodeRuns.filter((nr) => nr.nodeId === nodeId);
  if (runs.length === 0) {
    return {
      status: 'pending',
      tokens: 0,
      toolUses: 0,
      durationMs: 0,
      costUsd: 0,
      liveStartedAtMs: null,
    };
  }
  let latest = runs[0];
  const acc: RailNodeMetrics = {
    status: 'pending',
    tokens: 0,
    toolUses: 0,
    durationMs: 0,
    costUsd: 0,
    liveStartedAtMs: null,
  };
  for (const nr of runs) {
    if (nr.attempt >= latest.attempt) latest = nr;
    acc.tokens += nr.inputTokens + nr.outputTokens;
    acc.toolUses += nr.toolUses;
    acc.durationMs += nr.durationMs;
    acc.costUsd += nr.costUsd;
  }
  acc.status = latest.status;
  acc.liveStartedAtMs = latest.status === 'running' ? parseNodeStartedAt(latest.startedAt) : null;
  return acc;
}

export function estimateLiveTokensFromStream(stream: WorkflowNodeStreamState | undefined): number {
  if (!stream) return 0;
  return Math.floor(stream.text.length / 4);
}

export interface RailGroupNode {
  nodeId: string;
  label: string;
  metrics: RailNodeMetrics;
  liveTokens: number;
}

export interface RailGroup {
  id: string;
  label: string;
  status: DynamicWorkflowNodeStatus | 'pending';
  sprintId: string | null;
  nodes: RailGroupNode[];
}

function combineGroupStatus(
  statuses: (DynamicWorkflowNodeStatus | 'pending')[],
): DynamicWorkflowNodeStatus | 'pending' {
  if (statuses.length === 0) return 'pending';
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('failed') || statuses.includes('blocked')) return 'failed';
  if (statuses.includes('interrupted')) return 'running';
  if (statuses.some((s) => s === 'pending')) {
    const anyDone = statuses.some((s) => s === 'completed' || s === 'skipped' || s === 'cancelled');
    return anyDone ? 'running' : 'pending';
  }
  if (statuses.every((s) => s === 'skipped' || s === 'cancelled')) return 'skipped';
  return 'completed';
}

function deliveredGroupStatus(base: DynamicWorkflowNodeStatus | 'pending'): DynamicWorkflowNodeStatus | 'pending' {
  if (base === 'failed' || base === 'blocked' || base === 'running') return base;
  return 'completed';
}

function effectiveGroupStatuses(
  statuses: (DynamicWorkflowNodeStatus | 'pending')[],
  forceSkip = false,
): (DynamicWorkflowNodeStatus | 'pending')[] {
  const anyFinished = forceSkip || statuses.some((s) => s === 'completed' || s === 'skipped' || s === 'cancelled');
  if (!anyFinished) return statuses;
  return statuses.map((s) => (s === 'pending' ? 'skipped' : s));
}

export function syntheticNodesFromRuns(nodeRuns: CockpitNodeRun[]): DynamicWorkflowNode[] {
  const byId = new Map<string, DynamicWorkflowNode>();
  for (const nr of nodeRuns) {
    const existing = byId.get(nr.nodeId);
    if (existing) {
      if (!existing.agentId && nr.agentId) existing.agentId = nr.agentId;
      if (!existing.label && nr.label) existing.label = nr.label;
      continue;
    }
    byId.set(nr.nodeId, {
      id: `synthetic:${nr.nodeId}`,
      definitionId: '',
      nodeId: nr.nodeId,
      phaseId: nr.phaseId || 'sem-fase',
      sprintId: null,
      roundIndex: null,
      type: nr.type,
      agentId: nr.agentId,
      label: nr.label ?? null,
      access: null,
      readSetJson: '[]',
      writeSetJson: '[]',
      isolation: null,
      allowedToolsJson: '[]',
      allowedMcpJson: '[]',
      policyHash: null,
      timeoutMs: null,
      costCeilingUsd: null,
      dependenciesJson: '[]',
      retryPolicyJson: '{}',
      gateConfigJson: '{}',
      riskLevel: null,
      schemaRef: null,
      producesJson: '[]',
      consumesJson: '[]',
    });
  }
  return Array.from(byId.values());
}

export function deriveRailGroups(
  staticNodes: DynamicWorkflowNode[],
  nodeRuns: CockpitNodeRun[],
  manifest: DynamicWorkflowManifest | null,
  nodeStreams: Record<string, WorkflowNodeStreamState> = {},
  runStatus: DynamicWorkflowRunStatus | null = null,
): RailGroup[] {
  const nodes = staticNodes.length === 0 ? syntheticNodesFromRuns(nodeRuns) : staticNodes;
  const deliveredTerminal = isRunDeliveredTerminal(runStatus);
  const phaseOrder: string[] = [];
  const phaseName = new Map<string, string>();
  if (manifest) {
    for (const p of [...manifest.phases].sort((a, b) => a.order - b.order)) {
      phaseOrder.push(p.id);
      phaseName.set(p.id, p.name || p.id);
    }
  }
  for (const n of nodes) {
    const pid = n.phaseId || 'sem-fase';
    if (!phaseName.has(pid)) {
      phaseName.set(pid, pid.replace(/[-_]/g, ' '));
    }
    if (!phaseOrder.includes(pid)) phaseOrder.push(pid);
  }

  const metricsFor = (nodeId: string): RailNodeMetrics => aggregateNodeMetrics(nodeId, nodeRuns);
  const toGroupNode = (n: DynamicWorkflowNode, collapsePending = false): RailGroupNode => {
    const rawMetrics = metricsFor(n.nodeId);
    const metrics: RailNodeMetrics =
      collapsePending && rawMetrics.status === 'pending' ? { ...rawMetrics, status: 'skipped' } : rawMetrics;
    const liveTokens = metrics.status === 'running' ? estimateLiveTokensFromStream(nodeStreams[n.nodeId]) : 0;
    return {
      nodeId: n.nodeId,
      label: n.agentId ?? n.label ?? n.nodeId,
      metrics,
      liveTokens,
    };
  };

  const finalPhaseId = phaseOrder.length > 0 ? phaseOrder[phaseOrder.length - 1] : null;

  const shownNodes = nodes.filter((n) => n.type === 'gate' || metricsFor(n.nodeId).status !== 'pending');

  const groups: RailGroup[] = [];
  for (const pid of phaseOrder) {
    const inPhase = shownNodes.filter((n) => (n.phaseId || 'sem-fase') === pid);
    if (inPhase.length === 0) continue;
    const pname = phaseName.get(pid) ?? pid;
    const collapseDelivered = deliveredTerminal && pid === finalPhaseId;

    const sprintIds: string[] = [];
    const bySprint = new Map<string, DynamicWorkflowNode[]>();
    const noSprint: DynamicWorkflowNode[] = [];
    for (const n of inPhase) {
      if (n.sprintId) {
        if (!bySprint.has(n.sprintId)) {
          bySprint.set(n.sprintId, []);
          sprintIds.push(n.sprintId);
        }
        bySprint.get(n.sprintId)!.push(n);
      } else {
        noSprint.push(n);
      }
    }

    if (noSprint.length > 0) {
      const gnodes = noSprint.map((n) => toGroupNode(n, collapseDelivered));
      const rawStatuses = gnodes.map((g) => g.metrics.status);
      const baseStatus = combineGroupStatus(effectiveGroupStatuses(rawStatuses, collapseDelivered));
      groups.push({
        id: `phase:${pid}`,
        label: pname,
        status: collapseDelivered ? deliveredGroupStatus(baseStatus) : baseStatus,
        sprintId: null,
        nodes: gnodes,
      });
    }
    for (const sid of sprintIds) {
      const gnodes = (bySprint.get(sid) ?? []).map((n) => toGroupNode(n, collapseDelivered));
      const rawStatuses = gnodes.map((g) => g.metrics.status);
      const baseStatus = combineGroupStatus(effectiveGroupStatuses(rawStatuses, collapseDelivered));
      groups.push({
        id: `phase:${pid}:sprint:${sid}`,
        label: `${pname} / ${sid}`,
        status: collapseDelivered ? deliveredGroupStatus(baseStatus) : baseStatus,
        sprintId: sid,
        nodes: gnodes,
      });
    }
  }
  return groups;
}

export interface RailSprintState {
  branch: string | null;
  mergeLabel: string;
}

export function deriveSprintState(
  run: DynamicWorkflowRun | null,
  sprintId: string,
  groupStatus: DynamicWorkflowNodeStatus | 'pending',
): RailSprintState {
  const runBranch = run?.worktreeBranch ?? null;
  const branch = runBranch ? `${runBranch}/${sprintId}` : null;
  const mergeLabel =
    groupStatus === 'completed'
      ? 'pronta para merge'
      : groupStatus === 'running'
        ? 'em desenvolvimento'
        : groupStatus === 'failed'
          ? 'travada (precisa de ajuste)'
          : groupStatus === 'skipped'
            ? 'sem branch (so leitura)'
            : 'na fila';
  return { branch, mergeLabel };
}

function formatCost(usd: number): string {
  return usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '--';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${Math.floor(ms / 60000)}m`;
}

function RailStatusIcon({ status }: { status: DynamicWorkflowNodeStatus | 'pending' }) {
  switch (status) {
    case 'completed':
      return <Check size={11} strokeWidth={3} className="text-green-400 shrink-0" />;
    case 'running':
      return <Loader2 size={11} className="text-amber-400 animate-spin shrink-0" />;
    case 'failed':
    case 'blocked':
      return <X size={11} strokeWidth={3} className="text-red-400 shrink-0" />;
    case 'interrupted':
      return <Clock size={11} className="text-amber-300 shrink-0" />;
    case 'skipped':
    case 'cancelled':
      return <Minus size={11} className="text-zinc-500 shrink-0" />;
    default:
      return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ border: '1.5px dashed #52525b' }} />;
  }
}

export interface WorkflowCockpitRailProps {
  run: DynamicWorkflowRun | null;
  nodeRuns: CockpitNodeRun[];
  nodes: DynamicWorkflowNode[];
  manifest: DynamicWorkflowManifest | null;
  isStreaming: boolean;
  narration?: React.ReactNode;
  gateDecisions?: GateDecisionSummary[];
  touchedFiles?: string[];
  nodeStreams?: Record<string, WorkflowNodeStreamState>;
}

export function WorkflowCockpitRail({
  run,
  nodeRuns,
  nodes,
  manifest,
  isStreaming,
  narration,
  gateDecisions = [],
  touchedFiles = [],
  nodeStreams = {},
}: WorkflowCockpitRailProps) {
  const startedAtMs = parseRunStartedAt(run?.startedAt);
  const liveElapsed = useStreamTimer(isStreaming && startedAtMs != null, startedAtMs);

  const totalCost = run?.totalCostUsd ?? 0;
  const inTokens = nodeRuns.reduce((a, nr) => a + nr.inputTokens, 0);
  const outTokens = nodeRuns.reduce((a, nr) => a + nr.outputTokens, 0);

  const phase = run?.currentPhaseId ?? null;

  const groups = useMemo(
    () => deriveRailGroups(nodes, nodeRuns, manifest, nodeStreams, run?.status ?? null),
    [nodes, nodeRuns, manifest, nodeStreams, run?.status],
  );
  const agentCount = useMemo(
    () => (nodes.length > 0 ? nodes.length : new Set(nodeRuns.map((nr) => nr.nodeId)).size),
    [nodes, nodeRuns],
  );

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (id: string): void => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  return (
    <aside className="flex h-full w-full min-h-0 flex-col overflow-y-auto bg-zinc-950/40">
      {/* Topo do rail: fase + custo + tempo + tokens (sec 5.3). */}
      <div className="border-b border-zinc-800 px-3 py-2.5">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">Fase</div>
        <div className="mt-0.5 flex items-center gap-1.5">
          {isStreaming && <Loader2 size={12} className="animate-spin text-amber-400" />}
          {/* SM-15: a fase e um rotulo (nome de etapa), nao ID/hash -> fonte sans. */}
          <span className="text-xs text-zinc-200">{phase ?? '-'}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px border-b border-zinc-800 bg-zinc-800/40">
        <div className="bg-zinc-950/60 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">Custo</div>
          <div className="mt-0.5 font-mono text-xs text-amber-300">{formatCost(totalCost)}</div>
        </div>
        <div className="bg-zinc-950/60 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">Tempo</div>
          <div className="mt-0.5 font-mono text-xs text-zinc-300 tabular-nums">
            {isStreaming && startedAtMs != null ? liveElapsed : '--'}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 border-b border-zinc-800 px-3 py-2 text-[10px] text-zinc-500">
        <span>
          in <span className="font-mono text-zinc-300">{formatTokens(inTokens)}</span>
        </span>
        <span>
          out <span className="font-mono text-zinc-300">{formatTokens(outTokens)}</span>
        </span>
      </div>

      {/* Narrador IA: "o que esta acontecendo" */}
      {narration !== undefined && (
        <div className="border-b border-zinc-800 px-3 py-2.5">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">O que esta acontecendo</div>
          <div className="text-[11px] leading-relaxed text-zinc-300">{narration}</div>
        </div>
      )}

      {/* E6.1: deliberacao do driver - decisao por gate (orchestrator/human),
          espelhada do DB. O usuario ve quem decidiu o que sem ir ao chat principal. */}
      {gateDecisions.length > 0 && (
        <div className="border-b border-zinc-800 px-3 py-2.5" data-testid="cockpit-gate-decisions">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
            <Gavel size={11} className="text-zinc-500" />
            Decisoes de gate
          </div>
          <div className="flex flex-col gap-1">
            {gateDecisions.map((dec) => (
              <GateDecisionLine key={dec.id} decision={dec} />
            ))}
          </div>
        </div>
      )}

      {/* Agentes AGRUPADOS POR FASE (sec 5.3), colapsavel. */}
      <div className="px-2 py-2">
        <div className="mb-1 px-1 text-[10px] uppercase tracking-wide text-zinc-500">Agentes ({agentCount})</div>
        {groups.length === 0 ? (
          <p className="px-1 text-[12px] text-zinc-400" data-testid="rail-agents-empty">
            Sem agentes ainda.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {groups.map((group) => {
              const isCollapsed = collapsed[group.id] === true;
              return (
                <div
                  key={group.id}
                  className="rounded-md border border-zinc-800/80 bg-zinc-950/40"
                  data-testid={`rail-group-${group.id}`}
                >
                  <button
                    type="button"
                    onClick={() => toggle(group.id)}
                    className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
                  >
                    {isCollapsed ? (
                      <ChevronRight size={12} className="shrink-0 text-zinc-500" />
                    ) : (
                      <ChevronDown size={12} className="shrink-0 text-zinc-500" />
                    )}
                    <RailStatusIcon status={group.status} />
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-zinc-300">{group.label}</span>
                    <span className="shrink-0 font-mono text-[10px] text-zinc-500">{group.nodes.length}</span>
                  </button>

                  {!isCollapsed && (
                    <div className="border-t border-zinc-800/60 px-1.5 py-1">
                      {/* Estado por sprint (branch + merge) dentro do grupo. */}
                      {group.sprintId && (
                        <SprintStateLine state={deriveSprintState(run, group.sprintId, group.status)} />
                      )}
                      <div className="flex flex-col gap-0.5">
                        {group.nodes.map((node) => (
                          <RailAgentLine key={node.nodeId} node={node} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Arquivos alterados (derivados dos tool_call de escrita). */}
      {touchedFiles.length > 0 && (
        <div className="border-t border-zinc-800 px-3 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
            Arquivos alterados ({touchedFiles.length})
          </div>
          <div className="flex flex-col gap-0.5">
            {touchedFiles.map((file) => (
              <div
                key={file}
                className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[10px] hover:bg-zinc-900"
                title={file}
              >
                <FileText size={10} className="shrink-0 text-amber-400/70" />
                <span dir="rtl" className="min-w-0 flex-1 truncate text-left font-mono text-zinc-400">
                  {file}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function useLiveElapsedMs(startedAtMs: number | null): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (startedAtMs === null) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAtMs]);
  if (startedAtMs === null) return 0;
  return Math.max(0, nowMs - startedAtMs);
}

function RailAgentLine({ node }: { node: RailGroupNode }) {
  const m = node.metrics;
  const isRunning = m.status === 'running';
  const liveElapsedMs = useLiveElapsedMs(isRunning ? m.liveStartedAtMs : null);
  const showLiveClock = isRunning && m.liveStartedAtMs !== null;
  const liveTokens = isRunning && m.tokens === 0 ? node.liveTokens : 0;
  return (
    <div
      className="flex items-center gap-1.5 rounded px-1 py-1 text-[11px] hover:bg-zinc-900"
      data-testid={`rail-agent-${node.nodeId}`}
    >
      <RailStatusIcon status={m.status} />
      {/* SM-15: o NOME do agente vai na fonte de escrita do app (sans); mono fica
          so para numero/ID/path/hash (os contadores a direita). */}
      <span className="min-w-0 flex-1 truncate text-zinc-300">{node.label}</span>
      <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-zinc-600">
        {/* SM-14: tokens AO VIVO. Real (concluido) > estimativa viva (rodando). */}
        {m.tokens > 0 ? (
          <span title="tokens">{formatTokens(m.tokens)}</span>
        ) : (
          liveTokens > 0 && (
            <span className="text-amber-400/70" title="tokens (estimativa ao vivo)">
              ~{formatTokens(liveTokens)}
            </span>
          )
        )}
        {m.toolUses > 0 && (
          <span className="inline-flex items-center gap-0.5" title="ferramentas">
            <Wrench size={8} />
            {m.toolUses}
          </span>
        )}
        {/* SM-14: reloginho ANDANDO (rodando) vs duracao final (concluido). */}
        {showLiveClock ? (
          <span
            className="text-amber-400/70 tabular-nums"
            title="tempo decorrido (ao vivo)"
            data-testid={`rail-agent-clock-${node.nodeId}`}
          >
            {formatDuration(liveElapsedMs)}
          </span>
        ) : (
          m.durationMs > 0 && <span title="tempo">{formatDuration(m.durationMs)}</span>
        )}
        {m.costUsd > 0 && (
          <span className="text-zinc-500" title="custo">
            {formatCost(m.costUsd)}
          </span>
        )}
      </div>
    </div>
  );
}

function GateDecisionLine({ decision }: { decision: GateDecisionSummary }) {
  const approved = decision.decision === 'approved' || decision.decision === 'approve';
  const rejected = decision.decision === 'rejected' || decision.decision === 'reject';
  const decisionColor = approved ? 'text-green-400' : rejected ? 'text-red-400' : 'text-zinc-300';
  return (
    <div
      className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[10px] hover:bg-zinc-900"
      data-testid={`cockpit-gate-decision-${decision.gateId}`}
      title={`${decision.gateId}: ${decision.decision}${decision.decidedBy ? ` (${decision.decidedBy})` : ''}`}
    >
      {approved ? (
        <Check size={10} strokeWidth={3} className="shrink-0 text-green-400" />
      ) : rejected ? (
        <X size={10} strokeWidth={3} className="shrink-0 text-red-400" />
      ) : (
        <Gavel size={10} className="shrink-0 text-zinc-500" />
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-zinc-400">{decision.gateId}</span>
      <span className={`shrink-0 ${decisionColor}`}>{decision.decision}</span>
      {decision.decidedBy && <span className="shrink-0 font-mono text-[10px] text-zinc-600">{decision.decidedBy}</span>}
    </div>
  );
}

function SprintStateLine({ state }: { state: RailSprintState }) {
  return (
    <div
      className="mb-1 flex flex-col gap-0.5 rounded bg-zinc-900/40 px-1.5 py-1 text-[10px] text-zinc-500"
      data-testid="rail-sprint-state"
    >
      {state.branch && (
        <div className="flex items-center gap-1" title={state.branch}>
          <GitBranch size={9} className="shrink-0 text-zinc-500" />
          <span className="min-w-0 truncate font-mono text-zinc-400">{state.branch}</span>
        </div>
      )}
      <div className="flex items-center gap-1">
        <span className="text-zinc-500">merge:</span>
        <span className="text-zinc-400">{state.mergeLabel}</span>
      </div>
    </div>
  );
}
