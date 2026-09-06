import { BarChart3, Clock, Coins, Wrench } from 'lucide-react';
import type { DynamicWorkflowNode, DynamicWorkflowNodeRun } from '@/types';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd <= 0) return '$0.00';
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toFixed(2)}`;
}

function formatDuration(totalMs: number): string {
  const totalSeconds = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

export interface DeliveryMetricsRow {
  key: string;
  label: string;
  isSprint: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  nodeCount: number;
  unknownCostCount: number;
}

export interface DeliveryMetricsTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  nodeCount: number;
  unknownCostCount: number;
  model: string | null;
}

function prettySprintLabel(sprintId: string): string {
  const m = sprintId.match(/(?:^s|sprint[-_]?0*)(\d+)/i);
  if (m) return `Sprint ${parseInt(m[1], 10)}`;
  return sprintId.length > 28 ? `${sprintId.slice(0, 27)}…` : sprintId;
}

export function aggregateMetricsBySprint(
  nodeRuns: DynamicWorkflowNodeRun[],
  nodes: DynamicWorkflowNode[],
): { rows: DeliveryMetricsRow[]; totals: DeliveryMetricsTotals } {
  const nodeToSprint = new Map<string, string | null>();
  for (const n of nodes) nodeToSprint.set(n.nodeId, n.sprintId);

  const rows = new Map<string, DeliveryMetricsRow>();
  const totals: DeliveryMetricsTotals = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: 0,
    toolUses: 0,
    nodeCount: 0,
    unknownCostCount: 0,
    model: null,
  };

  for (const nr of nodeRuns) {
    const sprintId = nodeToSprint.get(nr.nodeId) ?? null;
    const key = sprintId ?? nr.phaseId ?? 'outros';
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        label: sprintId ? prettySprintLabel(sprintId) : (nr.phaseId || 'Outros'),
        isSprint: sprintId != null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: 0,
        toolUses: 0,
        nodeCount: 0,
        unknownCostCount: 0,
      };
      rows.set(key, row);
    }
    const unknownCost = nr.costStatus !== null && nr.costStatus !== 'known';
    row.inputTokens += nr.inputTokens;
    row.outputTokens += nr.outputTokens;
    row.costUsd += nr.costUsd;
    row.durationMs += nr.durationMs;
    row.toolUses += nr.toolUses;
    row.nodeCount += 1;
    if (unknownCost) row.unknownCostCount += 1;

    totals.inputTokens += nr.inputTokens;
    totals.outputTokens += nr.outputTokens;
    totals.costUsd += nr.costUsd;
    totals.durationMs += nr.durationMs;
    totals.toolUses += nr.toolUses;
    totals.nodeCount += 1;
    if (unknownCost) totals.unknownCostCount += 1;
    if (nr.model) totals.model = nr.model;
  }

  return { rows: [...rows.values()], totals };
}

export interface TotalPillProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  highlight?: boolean;
}

export function TotalPill({ icon, label, value, highlight = false }: TotalPillProps) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-zinc-500">
        {icon}
        {label}
      </span>
      <span
        className={`font-mono text-[15px] font-bold ${highlight ? 'text-amber-400' : 'text-zinc-100'}`}
      >
        {value}
      </span>
    </div>
  );
}

export interface WorkflowDeliveryMetricsProps {
  nodeRuns: DynamicWorkflowNodeRun[];
  nodes: DynamicWorkflowNode[];
  totalCostUsd?: number | null;
}

export function WorkflowDeliveryMetrics({
  nodeRuns,
  nodes,
  totalCostUsd,
}: WorkflowDeliveryMetricsProps) {
  const { rows, totals } = aggregateMetricsBySprint(nodeRuns, nodes);
  const costStr = formatCost(totalCostUsd != null && totalCostUsd > 0 ? totalCostUsd : totals.costUsd);

  if (nodeRuns.length === 0) {
    return (
      <div className="flex flex-col gap-1 px-4 py-6 text-center" data-testid="delivery-metrics-empty">
        <BarChart3 size={18} className="mx-auto text-zinc-700" />
        <span className="text-[12px] text-zinc-500">Sem métricas registradas para este run.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4" data-testid="delivery-metrics">
      <div className="flex items-center gap-2">
        <BarChart3 size={14} className="text-amber-400" />
        <span className="text-[12px] font-semibold text-zinc-200">Métricas do run</span>
        {totals.model && (
          <span className="ml-1 rounded bg-zinc-800/70 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
            {totals.model}
          </span>
        )}
      </div>

      {/* Totais do run */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <TotalPill icon={<Clock size={11} />} label="Tempo" value={formatDuration(totals.durationMs)} />
        <TotalPill
          icon={<Coins size={11} />}
          label="Custo"
          value={costStr}
          highlight
        />
        <TotalPill
          icon={<BarChart3 size={11} />}
          label="Tokens"
          value={`${formatTokens(totals.inputTokens)} / ${formatTokens(totals.outputTokens)}`}
        />
        <TotalPill icon={<Wrench size={11} />} label="Tools" value={String(totals.toolUses)} />
      </div>
      {totals.unknownCostCount > 0 && (
        <span className="text-[10px] text-zinc-500">
          {totals.unknownCostCount} node(s) com custo não estimado (total pode estar subavaliado).
        </span>
      )}

      {/* Tabela por sprint/fase */}
      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="bg-zinc-900/60 text-[10px] uppercase tracking-wide text-zinc-500">
              <th className="px-3 py-1.5 font-medium">Etapa</th>
              <th className="px-3 py-1.5 text-right font-medium">Tempo</th>
              <th className="px-3 py-1.5 text-right font-medium">Tokens (in/out)</th>
              <th className="px-3 py-1.5 text-right font-medium">Custo</th>
              <th className="px-3 py-1.5 text-right font-medium">Nodes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                className="border-t border-zinc-800/70 text-[11px] text-zinc-300"
                data-testid={`delivery-metrics-row-${row.key}`}
              >
                <td className="px-3 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${row.isSprint ? 'bg-amber-500' : 'bg-zinc-600'}`}
                    />
                    {row.label}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-zinc-400">
                  {formatDuration(row.durationMs)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-zinc-400">
                  {formatTokens(row.inputTokens)} / {formatTokens(row.outputTokens)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-zinc-200">
                  {formatCost(row.costUsd)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-zinc-500">{row.nodeCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
