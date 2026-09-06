import { useMemo } from 'react';
import { BarChart3, Clock, Coins, Wrench } from 'lucide-react';
import type { DynamicWorkflowManifest } from '@/types';
import type { CockpitNodeRun } from '@/types/dynamic-workflow-cockpit';
import { TotalPill } from './WorkflowDeliveryMetrics';
import {
  costConfidence,
  formatCostWithConfidence,
  nodeDisplayName,
  orderByExecution,
  shortNodeId,
} from './DynamicWorkflowNodeTimeline';


export interface CostBucket {
  key: string;
  label: string;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  toolUses: number;
  apiRequests: number;
  nodeCount: number;
  unknownCostCount: number;
  estimatedCostCount: number;
}

export interface CostTopNode {
  nodeId: string;
  displayName: string;
  attempt: number;
  phaseId: string;
  agentId: string | null;
  costUsd: number;
  costUnknown: boolean;
  costEstimated: boolean;
}

export interface CostBreakdown {
  totals: CostBucket;
  byPhase: CostBucket[];
  byRole: CostBucket[];
  topNodes: CostTopNode[];
}

function emptyBucket(key: string, label: string): CostBucket {
  return {
    key,
    label,
    costUsd: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolUses: 0,
    apiRequests: 0,
    nodeCount: 0,
    unknownCostCount: 0,
    estimatedCostCount: 0,
  };
}

function addTo(bucket: CostBucket, nr: CockpitNodeRun, unknown: boolean, estimated: boolean): void {
  bucket.costUsd += nr.costUsd;
  bucket.durationMs += nr.durationMs;
  bucket.inputTokens += nr.inputTokens;
  bucket.outputTokens += nr.outputTokens;
  bucket.toolUses += nr.toolUses;
  bucket.apiRequests += nr.apiRequests;
  bucket.nodeCount += 1;
  if (unknown) bucket.unknownCostCount += 1;
  if (estimated) bucket.estimatedCostCount += 1;
}

export function aggregateCostBreakdown(
  nodeRuns: CockpitNodeRun[],
  manifest: DynamicWorkflowManifest | null = null,
  topN = 5,
): CostBreakdown {
  const phaseName = new Map<string, string>();
  if (manifest) for (const p of manifest.phases) phaseName.set(p.id, p.name || p.id);
  const totals = emptyBucket('total', 'Total');
  const byPhase = new Map<string, CostBucket>();
  const byRole = new Map<string, CostBucket>();
  const byNode = new Map<string, CostTopNode>();

  for (const nr of orderByExecution(nodeRuns)) {
    const confidence = costConfidence(nr.costStatus);
    const unknown = confidence === 'unknown';
    const estimated = confidence === 'estimated';
    addTo(totals, nr, unknown, estimated);

    const pid = nr.phaseId || 'sem-fase';
    let phase = byPhase.get(pid);
    if (!phase) {
      phase = emptyBucket(pid, phaseName.get(pid) ?? pid);
      byPhase.set(pid, phase);
    }
    addTo(phase, nr, unknown, estimated);

    const role = nr.agentId ?? 'sem agente';
    let roleBucket = byRole.get(role);
    if (!roleBucket) {
      roleBucket = emptyBucket(role, role);
      byRole.set(role, roleBucket);
    }
    addTo(roleBucket, nr, unknown, estimated);

    const top = byNode.get(nr.nodeId);
    if (!top) {
      byNode.set(nr.nodeId, {
        nodeId: nr.nodeId,
        displayName: nodeDisplayName(nr),
        attempt: nr.attempt,
        phaseId: pid,
        agentId: nr.agentId,
        costUsd: nr.costUsd,
        costUnknown: unknown,
        costEstimated: estimated,
      });
    } else {
      top.costUsd += nr.costUsd;
      top.costUnknown = top.costUnknown || unknown;
      top.costEstimated = top.costEstimated || estimated;
      if (nr.attempt >= top.attempt) {
        top.attempt = nr.attempt;
        if (!top.agentId && nr.agentId) top.agentId = nr.agentId;
        const name = nodeDisplayName(nr);
        if (name !== shortNodeId(nr.nodeId)) top.displayName = name;
      }
    }
  }

  const topNodes = Array.from(byNode.values())
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, topN);
  return {
    totals,
    byPhase: Array.from(byPhase.values()),
    byRole: Array.from(byRole.values()),
    topNodes,
  };
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

function formatDuration(totalMs: number): string {
  if (totalMs <= 0) return '--';
  const totalSeconds = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

function percentOf(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.max(2, Math.round((value / max) * 100));
}


export interface WorkflowCostTabProps {
  nodeRuns: CockpitNodeRun[];
  manifest: DynamicWorkflowManifest | null;
  totalCostUsd: number;
  totalDurationMs?: number;
}

export function WorkflowCostTab({
  nodeRuns,
  manifest,
  totalCostUsd,
  totalDurationMs = 0,
}: WorkflowCostTabProps) {
  const breakdown = useMemo(() => aggregateCostBreakdown(nodeRuns, manifest), [nodeRuns, manifest]);

  if (nodeRuns.length === 0) {
    return (
      <div
        className="flex flex-1 items-center justify-center text-[12px] text-zinc-400"
        data-testid="cost-empty"
      >
        Sem metricas de custo por node ainda.
      </div>
    );
  }

  const { totals, byPhase, byRole, topNodes } = breakdown;
  const costShown = totalCostUsd > 0 ? totalCostUsd : totals.costUsd;
  const durationShown = totalDurationMs > 0 ? totalDurationMs : totals.durationMs;
  const maxPhaseCost = byPhase.reduce((acc, b) => (b.costUsd > acc ? b.costUsd : acc), 0);
  const maxRoleCost = byRole.reduce((acc, b) => (b.costUsd > acc ? b.costUsd : acc), 0);

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto" data-testid="cost-tab">
      {/* Totais do run */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <TotalPill
          icon={<Coins size={11} />}
          label="Custo"
          value={formatCostWithConfidence(costShown, false, totals.estimatedCostCount > 0, formatCost)}
          highlight
        />
        <TotalPill icon={<Clock size={11} />} label="Tempo" value={formatDuration(durationShown)} />
        <TotalPill
          icon={<BarChart3 size={11} />}
          label="Tokens in / out"
          value={`${formatTokens(totals.inputTokens)} / ${formatTokens(totals.outputTokens)}`}
        />
        <TotalPill
          icon={<Wrench size={11} />}
          label="Tools / requests"
          value={`${totals.toolUses} / ${totals.apiRequests}`}
        />
      </div>
      {totals.unknownCostCount > 0 && (
        <div
          className="flex items-center gap-2 text-[11px] text-zinc-400"
          data-testid="cost-unknown-badge"
        >
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-amber-500/40 bg-amber-500/10 px-1 font-mono text-[10px] font-bold text-amber-300">
            ?
          </span>
          <span>
            {totals.unknownCostCount} node(s) com custo desconhecido; o total pode estar subavaliado.
          </span>
        </div>
      )}

      {/* Por fase, com barra de proporcao */}
      <section data-testid="cost-by-phase">
        <SectionTitle>Por fase</SectionTitle>
        <div className="flex flex-col gap-1.5">
          {byPhase.map((b) => (
            <BucketCard key={b.key} bucket={b} maxCost={maxPhaseCost} testId={`cost-phase-${b.key}`} />
          ))}
        </div>
      </section>

      {/* Por papel (agentId) */}
      <section data-testid="cost-by-role">
        <SectionTitle>Por papel</SectionTitle>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {byRole.map((b) => (
            <BucketCard key={b.key} bucket={b} maxCost={maxRoleCost} testId={`cost-role-${b.key}`} />
          ))}
        </div>
      </section>

      {/* Top nodes por custo */}
      <section data-testid="cost-section-top">
        <SectionTitle>Top {topNodes.length} nodes por custo</SectionTitle>
        <div className="overflow-hidden rounded-lg border border-zinc-800">
          {topNodes.map((n, i) => (
            <div
              key={n.nodeId}
              className={`flex items-center gap-2 px-3 py-1.5 text-[11px] ${i > 0 ? 'border-t border-zinc-800/70' : ''}`}
              title={n.nodeId}
              data-testid={`cost-top-${n.nodeId}`}
            >
              <span className="w-4 shrink-0 font-mono text-[10px] text-zinc-500">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">
                <span className="text-zinc-200">{n.displayName}</span>
                {n.displayName !== n.nodeId && (
                  <span className="ml-1.5 font-mono text-[11px] text-zinc-500">{n.nodeId}</span>
                )}
                <span className="ml-1 font-mono text-[11px] text-zinc-500">#{n.attempt}</span>
              </span>
              <span className="shrink-0 text-[10px] text-zinc-500">{n.phaseId}</span>
              <span
                className={`shrink-0 font-mono ${n.costUnknown ? 'text-amber-300' : 'text-zinc-200'}`}
                title={
                  n.costUnknown ? 'custo nao confiavel' : n.costEstimated ? 'custo aproximado (piso)' : undefined
                }
              >
                {formatCostWithConfidence(n.costUsd, n.costUnknown, n.costEstimated, formatCost)}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1.5 text-[11px] uppercase tracking-wider text-zinc-400 font-medium">
      {children}
    </p>
  );
}

function BucketCard({
  bucket,
  maxCost,
  testId,
}: {
  bucket: CostBucket;
  maxCost: number;
  testId: string;
}) {
  const pct = percentOf(bucket.costUsd, maxCost);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2" data-testid={testId}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-200" title={bucket.key}>
          {bucket.label}
        </span>
        {bucket.unknownCostCount > 0 && (
          <span
            className="shrink-0 font-mono text-[10px] font-bold text-amber-300"
            title={`${bucket.unknownCostCount} node(s) com custo desconhecido`}
          >
            ?
          </span>
        )}
        <span
          className="shrink-0 font-mono text-[12px] text-amber-400"
          title={bucket.estimatedCostCount > 0 ? 'custo aproximado (piso)' : undefined}
        >
          {formatCostWithConfidence(bucket.costUsd, false, bucket.estimatedCostCount > 0, formatCost)}
        </span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded bg-zinc-800">
        <div className="h-full rounded bg-amber-500/70" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-zinc-500">
        <span title="tempo">{formatDuration(bucket.durationMs)}</span>
        <span title="tokens in/out">
          {formatTokens(bucket.inputTokens)}
          <span className="text-zinc-600">/</span>
          {formatTokens(bucket.outputTokens)}
        </span>
        <span title="tools">
          {bucket.toolUses}
          <span className="text-zinc-700"> tools</span>
        </span>
        <span title="nodes">
          {bucket.nodeCount}
          <span className="text-zinc-700"> {bucket.nodeCount === 1 ? 'node' : 'nodes'}</span>
        </span>
      </div>
    </div>
  );
}
