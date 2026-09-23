import { Fragment, useState, useEffect } from 'react';
import { shortenModel } from '@/utils/model-display';
import {
  DollarSign,
  Clock,
  RotateCcw,
  TrendingUp,
  Cpu,
  Activity,
  CheckCircle2,
  XCircle,
  Cloud,
  Server,
  X,
  Shield,
  AlertTriangle,
  FileSearch,
} from 'lucide-react';
import { usePipelineStore } from '@/stores/pipeline-store';
import { useActiveProjectState } from '@/hooks/useActiveProjectState';
import type { PipelinePhaseMetrics, PipelineMetricsResult, SecuritySummary } from '@/types';
import {
  PIPELINE_PHASES,
  SECURITY_PIPELINE_PHASES,
  FEATURE_PIPELINE_PHASES,
  ARCHITECTURE_REVIEW_PIPELINE_PHASES,
  DEVELOPMENT_V2_PIPELINE_PHASES,
  BUG_PIPELINE_PHASES,
  type PipelineType,
  type PhaseDefinition,
} from '@/types/pipeline';

function phasesForPipelineType(pipelineType: PipelineType): PhaseDefinition[] {
  if (pipelineType === 'security') return SECURITY_PIPELINE_PHASES;
  if (pipelineType === 'feature') return FEATURE_PIPELINE_PHASES;
  if (pipelineType === 'architecture-review') return ARCHITECTURE_REVIEW_PIPELINE_PHASES;
  if (pipelineType === 'development-v2') return DEVELOPMENT_V2_PIPELINE_PHASES;
  if (pipelineType === 'bug') return BUG_PIPELINE_PHASES;
  return PIPELINE_PHASES;
}

function loopPhaseNumbers(pipelineType: PipelineType): { coder: number; evaluator: number } {
  const phases = phasesForPipelineType(pipelineType);
  const coder = phases.find((p) => p.agentId === 'harness-coder')?.number ?? 13;
  const evaluator = phases.find((p) => p.agentId === 'harness-evaluator')?.number ?? 14;
  return { coder, evaluator };
}

const PHASE_CSS_VARS = `
  :root {
    --phase-1:  #6366f1;
    --phase-2:  #8b5cf6;
    --phase-3:  #a78bfa;
    --phase-4:  #7c3aed;
    --phase-5:  #0ea5e9;
    --phase-6:  #22c55e;
    --phase-7:  #16a34a;
    --phase-8:  #f59e0b;
    --phase-9:  #d97706;
    --phase-10: #f97316;
    --phase-11: #3b82f6;
    --phase-12: var(--color-purple-400, #c084fc);
    --phase-13: var(--color-sky-400, #38bdf8);
    --phase-14: var(--color-teal-400, #2dd4bf);
  }
`;

const SECURITY_PHASE_CSS_VARS = `
  :root {
    --security-phase-1:  #ef4444;
    --security-phase-2:  #f97316;
    --security-phase-3:  #f59e0b;
    --security-phase-4:  #eab308;
    --security-phase-5:  #84cc16;
    --security-phase-6:  #22c55e;
    --security-phase-7:  #3b82f6;
    --security-phase-8:  #8b5cf6;
    --security-phase-9:  #06b6d4;
    --security-phase-10: #2dd4bf;
  }
`;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.001) return '<$0.001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

const PIPELINE_RUNTIME_LABELS: Record<string, string> = {
  cloud: 'Cloud',
  local: 'Local',
  external: 'Ext',
  codex: 'Codex',
  zai: 'Z.ai',
  'minimax-tp': 'MiniMax',
  kimi: 'Kimi',
  grok: 'Grok',
};

const PIPELINE_RUNTIME_ORDER = ['cloud', 'local', 'external', 'codex', 'zai', 'minimax-tp', 'kimi', 'grok'];

const PIPELINE_PAYG_EQUIVALENT_RUNTIMES = new Set(['minimax-tp', 'kimi', 'grok']);

function orderedRuntimeEntries(costByRuntime: Record<string, number>): Array<[string, number]> {
  const runtimes = Object.keys(costByRuntime);
  return [
    ...PIPELINE_RUNTIME_ORDER.filter((runtime) => Object.hasOwn(costByRuntime, runtime)),
    ...runtimes.filter((runtime) => !PIPELINE_RUNTIME_ORDER.includes(runtime)).sort(),
  ].map((runtime) => [runtime, costByRuntime[runtime] ?? 0]);
}

export function formatRuntimeCost(
  runtime: string,
  cost: number,
  costStatus: 'known' | 'unknown' | 'estimated-partial' = 'known',
): string {
  return formatPipelineTotalCost(cost, PIPELINE_PAYG_EQUIVALENT_RUNTIMES.has(runtime) ? cost : 0, { costStatus });
}

export function formatCostWithMeta(costUsd: number, metadata?: Record<string, unknown>): string {
  const costStatus = (metadata?.costStatus as string | undefined) ?? 'known';
  if (costStatus === 'unknown') return 'Custo nao estimado';
  if (costStatus === 'estimated-partial') return `~${formatCost(costUsd)}`;
  const costEstimationKind = metadata?.costEstimationKind as string | undefined;
  if (costEstimationKind === 'subscription-equivalent-payg') {
    const base = formatCost(costUsd);
    return `~${base} (est. PAYG)`;
  }
  return formatCost(costUsd);
}

export function formatPipelineTotalCost(
  total: number,
  subscriptionEquivalent: number,
  metadata?: Pick<PipelineMetricsResult['totals'], 'costStatus'>,
): string {
  const equivalent = Math.min(total, Math.max(0, subscriptionEquivalent));
  const known =
    equivalent <= 0
      ? formatCost(total)
      : total - equivalent <= 1e-9
        ? `~${formatCost(total)}`
        : `${formatCost(total)} (incl. ~${formatCost(equivalent)})`;
  if (metadata?.costStatus === 'unknown') {
    return total > 0 ? `${known} + nao estim.` : 'Custo nao estimado';
  }
  if (metadata?.costStatus === 'estimated-partial' && equivalent <= 0) {
    return `~${formatCost(total)}`;
  }
  return known;
}

export function formatTokensWithMeta(
  inputTokens: number,
  outputTokens: number,
  metadata?: Record<string, unknown>,
): string {
  const tokenStatus = (metadata?.tokenStatus as string | undefined) ?? 'reported';
  if (tokenStatus === 'not_reported') return 'tokens nao reportados';
  const total = inputTokens + outputTokens;
  return formatTokens(total);
}

export function totalTokensFromInclusiveInput(inputTokens: number, outputTokens: number): number {
  return inputTokens + outputTokens;
}

export function resolveProviderForDisplay(
  metadata: Record<string, unknown> | undefined,
  runtime: string | null,
): string {
  return (metadata?.provider as string | undefined) ?? runtime ?? 'unknown';
}

function isUnknownCostPhase(phase: PipelinePhaseMetrics): boolean {
  return phase.metadata?.costStatus === 'unknown' || (phase.unknownCostCount ?? 0) > 0;
}

function formatAggregatedCost(costUsd: number, hasUnknownCost: boolean): string {
  if (!hasUnknownCost) return formatCost(costUsd);
  if (costUsd > 0) return `${formatCost(costUsd)} + nao estim.`;
  return 'Custo nao estimado';
}

function isSyntheticSecurityAuditWrapperPhase(phase: PipelinePhaseMetrics, pipelineType: PipelineType): boolean {
  return (
    pipelineType === 'security' &&
    phase.phaseNumber === 2 &&
    phase.agentId === 'multi-agent' &&
    phase.metadata?.auditAgent !== true
  );
}

function buildDisplayMetrics(metrics: PipelineMetricsResult, pipelineType: PipelineType): PipelineMetricsResult {
  const phases = metrics.phases.filter((phase) => !isSyntheticSecurityAuditWrapperPhase(phase, pipelineType));
  const sprintPhases = metrics.sprintPhases.filter(
    (phase) => !isSyntheticSecurityAuditWrapperPhase(phase, pipelineType),
  );

  return {
    ...metrics,
    phases,
    sprintPhases,
  };
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, '0')}min`;
  if (seconds === 0) return `${minutes}min`;
  return `${minutes}min ${seconds.toString().padStart(2, '0')}s`;
}

function pct(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, (value / max) * 100);
}

const phaseSortKey = (n: number): number => (n === 91 ? 9.1 : n);
const phaseDisplayLabel = (n: number): string => (n === 91 ? '9.1' : String(n));

type PhaseType = 'conversation' | 'auto' | 'loop';

function classifyPhase(phaseNumber: number, pipelineType: PipelineType): PhaseType {
  if (phaseNumber === 91) return 'auto';
  const phases = phasesForPipelineType(pipelineType);
  const phase = phases.find((p) => p.number === phaseNumber);
  return phase?.type ?? 'auto';
}

function phaseTypeColor(type: PhaseType): string {
  if (type === 'conversation') return 'bg-blue-500';
  if (type === 'auto') return 'bg-green-500';
  return 'bg-amber-500';
}

function phaseTypeBadgeColor(type: PhaseType): string {
  if (type === 'conversation') return 'bg-blue-500/15 text-blue-400';
  if (type === 'auto') return 'bg-green-500/15 text-green-400';
  return 'bg-amber-500/15 text-amber-400';
}

function phaseTypeLabel(type: PhaseType): string {
  if (type === 'conversation') return 'Conversa';
  if (type === 'auto') return 'Auto';
  return 'Loop';
}

function getPhaseDisplayNames(pipelineType: PipelineType): Record<number, string> {
  const phases = phasesForPipelineType(pipelineType);
  return Object.fromEntries(phases.map((p) => [p.number, p.name]));
}

function phaseVarColor(phaseNumber: number, pipelineType: PipelineType): string {
  if (phaseNumber === 91) return 'var(--phase-9)';
  if (pipelineType === 'security') {
    const n = Math.max(1, Math.min(10, phaseNumber));
    return `var(--security-phase-${n})`;
  }
  const n = Math.max(1, Math.min(14, phaseNumber));
  return `var(--phase-${n})`;
}

interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  color?: string;
}

function KpiCard({ icon, label, value, sub, color = 'text-zinc-100' }: KpiCardProps) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-zinc-500">{icon}</span>
        <span className="text-[11px] text-zinc-500 uppercase tracking-wide font-medium">{label}</span>
      </div>
      <span className={`text-2xl font-bold leading-none ${color}`}>{value}</span>
      {sub !== undefined && <span className="text-[11px] text-zinc-600">{sub}</span>}
    </div>
  );
}

interface BarRowProps {
  label: string;
  value: number;
  maxValue: number;
  formattedValue: string;
  barColor: string;
  barCssVar?: string;
  badge?: string;
  badgeColor?: string;
  extra?: string;
  extraColor?: string;
}

function BarRow({
  label,
  value,
  maxValue,
  formattedValue,
  barColor,
  barCssVar,
  badge,
  badgeColor,
  extra,
  extraColor,
}: BarRowProps) {
  const width = pct(value, maxValue);

  return (
    <div className="flex items-center gap-3">
      <div className="w-36 shrink-0 flex items-center gap-1.5">
        <span className="text-xs text-zinc-300 truncate">{label}</span>
        {badge !== undefined && (
          <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium uppercase shrink-0 ${badgeColor ?? ''}`}>
            {badge}
          </span>
        )}
      </div>
      <div className="flex-1 h-5 bg-zinc-800 rounded overflow-hidden">
        <div
          className={
            barCssVar
              ? 'h-5 rounded transition-all duration-500'
              : `h-5 rounded transition-all duration-500 ${barColor}`
          }
          style={{
            width: `${width}%`,
            minWidth: width > 0 ? '4px' : '0',
            ...(barCssVar ? { background: barCssVar } : {}),
          }}
        />
      </div>
      <span className="text-xs text-zinc-400 w-32 text-right shrink-0 font-mono">{formattedValue}</span>
      {extra !== undefined && (
        <span className={`text-[11px] w-14 text-right shrink-0 font-mono ${extraColor ?? 'text-zinc-500'}`}>
          {extra}
        </span>
      )}
    </div>
  );
}

interface KpiSectionProps {
  metrics: PipelineMetricsResult;
  pipelineType: PipelineType;
}

function KpiSection({ metrics, pipelineType }: KpiSectionProps) {
  const { coder: coderNum, evaluator: evalNum } = loopPhaseNumbers(pipelineType);
  const { totals } = metrics;
  const totalTokens = totalTokensFromInclusiveInput(totals.inputTokens, totals.outputTokens);

  const executedPhases = metrics.phases.filter((p) => p.status === 'completed');
  const passRate = metrics.phases.length > 0 ? Math.round((executedPhases.length / metrics.phases.length) * 100) : 0;

  const passColor = passRate >= 70 ? 'text-green-400' : passRate >= 50 ? 'text-yellow-400' : 'text-red-400';

  const costSubParts = orderedRuntimeEntries(metrics.costByRuntime).map(
    ([runtime, cost]) =>
      `${PIPELINE_RUNTIME_LABELS[runtime] ?? runtime}: ${formatRuntimeCost(
        runtime,
        cost,
        metrics.costStatusByRuntime?.[runtime],
      )}`,
  );

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      <KpiCard
        icon={<DollarSign size={14} />}
        label="Custo Total"
        value={formatPipelineTotalCost(totals.costUsd, metrics.subscriptionEquivalentCost, totals)}
        sub={[
          costSubParts.join(' / '),
          metrics.subscriptionEquivalentCost > 0 ? 'Equivalente da API; nao e cobranca da assinatura.' : null,
          (totals.unknownCostCount ?? 0) > 0 ? `${totals.unknownCostCount} execucao(oes) com custo nao estimado` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      />
      <KpiCard icon={<Clock size={14} />} label="Duracao Total" value={formatDuration(totals.durationMs)} />
      <KpiCard
        icon={<RotateCcw size={14} />}
        label="Total Rounds"
        value={String(
          metrics.sprintPhases.filter((p) => p.phaseNumber === coderNum || p.phaseNumber === evalNum).length,
        )}
        sub={`${metrics.sprintPhases.length} execucoes de loop`}
      />
      <KpiCard
        icon={<TrendingUp size={14} />}
        label="Pass Rate"
        value={`${passRate}%`}
        color={passColor}
        sub={`${executedPhases.length}/${metrics.phases.length} fases`}
      />
      <KpiCard
        icon={<Cpu size={14} />}
        label="Total Tokens"
        value={formatTokens(totalTokens)}
        sub={`In: ${formatTokens(totals.inputTokens)} / Out: ${formatTokens(totals.outputTokens)}`}
      />
      <KpiCard
        icon={<Activity size={14} />}
        label="API Requests"
        value={String(totals.apiRequests)}
        sub={`${totals.toolUses} tool uses`}
      />
    </div>
  );
}

interface PhaseBarChartProps {
  phases: PipelinePhaseMetrics[];
  pipelineType: PipelineType;
}

function PhaseBarChart({ phases, pipelineType }: PhaseBarChartProps) {
  const phaseDisplayNames = getPhaseDisplayNames(pipelineType);

  if (phases.length === 0) {
    return <p className="text-xs text-zinc-600 text-center py-6">Nenhuma fase executada ainda.</p>;
  }

  const phaseMap = new Map<number, { costUsd: number; hasUnknownCost: boolean }>();
  for (const p of phases) {
    const existing = phaseMap.get(p.phaseNumber) ?? { costUsd: 0, hasUnknownCost: false };
    phaseMap.set(p.phaseNumber, {
      costUsd: existing.costUsd + p.costUsd,
      hasUnknownCost: existing.hasUnknownCost || isUnknownCostPhase(p),
    });
  }

  const rows = Array.from(phaseMap.entries())
    .sort(([a], [b]) => phaseSortKey(a) - phaseSortKey(b))
    .map(([phaseNumber, data]) => ({
      phaseNumber,
      label: phaseDisplayNames[phaseNumber] ?? `Fase ${phaseNumber}`,
      costUsd: data.costUsd,
      hasUnknownCost: data.hasUnknownCost,
      type: classifyPhase(phaseNumber, pipelineType),
    }));

  const maxCost = Math.max(...rows.map((r) => r.costUsd), 0.0001);

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <BarRow
          key={row.phaseNumber}
          label={`${phaseDisplayLabel(row.phaseNumber)}. ${row.label}`}
          value={row.costUsd}
          maxValue={maxCost}
          formattedValue={formatAggregatedCost(row.costUsd, row.hasUnknownCost)}
          barColor={phaseTypeColor(row.type)}
          barCssVar={phaseVarColor(row.phaseNumber, pipelineType)}
          badge={phaseTypeLabel(row.type)}
          badgeColor={phaseTypeBadgeColor(row.type)}
        />
      ))}

      {/* Legend */}
      <div className="flex items-center gap-4 pt-2 justify-end">
        {(['conversation', 'auto', 'loop'] as PhaseType[]).map((type) => (
          <div key={type} className="flex items-center gap-1.5">
            <div className={`w-2.5 h-2.5 rounded ${phaseTypeColor(type)}`} />
            <span className="text-[10px] text-zinc-500">{phaseTypeLabel(type)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface AgentBarChartProps {
  phases: PipelinePhaseMetrics[];
  agentNames: Record<string, string>;
}

function AgentBarChart({ phases, agentNames }: AgentBarChartProps) {
  const agentMap = new Map<string, { costUsd: number; hasUnknownCost: boolean }>();
  for (const p of phases) {
    const key = p.agentId ?? p.phaseName;
    const existing = agentMap.get(key) ?? { costUsd: 0, hasUnknownCost: false };
    agentMap.set(key, {
      costUsd: existing.costUsd + p.costUsd,
      hasUnknownCost: existing.hasUnknownCost || isUnknownCostPhase(p),
    });
  }

  const rows = Array.from(agentMap.entries())
    .sort(([, a], [, b]) => b.costUsd - a.costUsd)
    .slice(0, 10);

  if (rows.length === 0) {
    return <p className="text-xs text-zinc-600 text-center py-6">Nenhum dado de agente disponivel.</p>;
  }

  const maxCost = Math.max(...rows.map(([, v]) => v.costUsd), 0.0001);

  return (
    <div className="space-y-2">
      {rows.map(([agentId, data]) => (
        <BarRow
          key={agentId}
          label={agentNames[agentId] ?? agentId}
          value={data.costUsd}
          maxValue={maxCost}
          formattedValue={formatAggregatedCost(data.costUsd, data.hasUnknownCost)}
          barColor="bg-amber-500"
        />
      ))}
    </div>
  );
}

interface SecurityAuditBreakdownProps {
  phases: PipelinePhaseMetrics[];
  agentNames: Record<string, string>;
}

function SecurityAuditBreakdown({ phases, agentNames }: SecurityAuditBreakdownProps) {
  const auditRows = phases.filter((p) => p.phaseNumber === 2 && p.metadata?.auditAgent === true);

  if (auditRows.length === 0) {
    return (
      <p className="text-xs text-zinc-600 text-center py-6">Dados de agentes de auditoria nao disponiveis ainda.</p>
    );
  }

  const agentMap = new Map<string, { costUsd: number; findingsCount: number; hasUnknownCost: boolean }>();
  for (const p of auditRows) {
    const key = p.agentId ?? 'desconhecido';
    const existing = agentMap.get(key) ?? { costUsd: 0, findingsCount: 0, hasUnknownCost: false };
    const findings = typeof p.metadata?.findingsCount === 'number' ? p.metadata.findingsCount : 0;
    agentMap.set(key, {
      costUsd: existing.costUsd + p.costUsd,
      findingsCount: existing.findingsCount + findings,
      hasUnknownCost: existing.hasUnknownCost || isUnknownCostPhase(p),
    });
  }

  const rows = Array.from(agentMap.entries()).sort(([, a], [, b]) => b.costUsd - a.costUsd);

  const maxCost = Math.max(...rows.map(([, v]) => v.costUsd), 0.0001);
  const totalCost = rows.reduce((acc, [, v]) => acc + v.costUsd, 0);
  const totalFindings = rows.reduce((acc, [, v]) => acc + v.findingsCount, 0);
  const totalHasUnknownCost = rows.some(([, v]) => v.hasUnknownCost);

  return (
    <div className="space-y-2">
      {rows.map(([agentId, data]) => (
        <BarRow
          key={agentId}
          label={agentNames[agentId] ?? agentId}
          value={data.costUsd}
          maxValue={maxCost}
          formattedValue={formatAggregatedCost(data.costUsd, data.hasUnknownCost)}
          barColor="bg-orange-500"
          barCssVar="var(--security-phase-2)"
          extra={data.findingsCount > 0 ? `(${data.findingsCount})` : ''}
          extraColor="text-red-400"
        />
      ))}

      {/* Footer: total */}
      <div className="flex items-center justify-between pt-3 border-t border-zinc-800 mt-2">
        <span className="text-[11px] text-zinc-500">
          Total:{'  '}
          <span className="text-zinc-300 font-mono font-medium">
            {formatAggregatedCost(totalCost, totalHasUnknownCost)}
          </span>
        </span>
        {totalFindings > 0 && <span className="text-[11px] text-red-400 font-medium">{totalFindings} findings</span>}
      </div>
    </div>
  );
}

interface SprintBarData {
  sprintIndex: number;
  coderCost: number;
  evalCost: number;
  total: number;
  coderModel: string | null;
  evalModel: string | null;
}

function buildSprintBarData(sprintPhases: PipelinePhaseMetrics[], pipelineType: PipelineType): SprintBarData[] {
  const { coder: coderNum, evaluator: evalNum } = loopPhaseNumbers(pipelineType);
  const sprintMap = new Map<number, SprintBarData>();

  for (const p of sprintPhases) {
    const si =
      (p.sprintIndex ?? -1) >= 0
        ? (p.sprintIndex as number)
        : typeof p.metadata?.sprintIndex === 'number'
          ? p.metadata.sprintIndex
          : -1;
    if (si < 0) continue;

    if (!sprintMap.has(si)) {
      sprintMap.set(si, {
        sprintIndex: si,
        coderCost: 0,
        evalCost: 0,
        total: 0,
        coderModel: null,
        evalModel: null,
      });
    }

    const entry = sprintMap.get(si)!;
    if (p.phaseNumber === coderNum) {
      entry.coderCost += p.costUsd;
      entry.coderModel = p.model ?? entry.coderModel;
    } else if (p.phaseNumber === evalNum) {
      entry.evalCost += p.costUsd;
      entry.evalModel = p.model ?? entry.evalModel;
    }
    entry.total += p.costUsd;
  }

  return Array.from(sprintMap.values()).sort((a, b) => a.sprintIndex - b.sprintIndex);
}

interface SprintCostChartProps {
  sprintPhases: PipelinePhaseMetrics[];
  pipelineType: PipelineType;
}

function SprintCostChart({ sprintPhases, pipelineType }: SprintCostChartProps) {
  const rows = buildSprintBarData(sprintPhases, pipelineType);

  if (rows.length === 0) {
    return <p className="text-xs text-zinc-600 text-center py-6">Nenhum sprint executado ainda.</p>;
  }

  const maxTotal = Math.max(...rows.map((r) => r.total), 0.0001);

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const coderW = pct(row.coderCost, maxTotal);
        const evalW = pct(row.evalCost, maxTotal);

        return (
          <div key={row.sprintIndex} className="flex items-center gap-3">
            <span className="text-xs text-zinc-400 w-20 shrink-0">Sprint {row.sprintIndex + 1}</span>
            <div className="flex-1 h-5 bg-zinc-800 rounded overflow-hidden flex">
              {coderW > 0 && (
                <div
                  className="h-5 transition-all duration-500"
                  style={{ width: `${coderW}%`, minWidth: '4px', background: 'var(--phase-13)' }}
                  title={`Coder: ${formatCost(row.coderCost)}`}
                />
              )}
              {evalW > 0 && (
                <div
                  className="h-5 transition-all duration-500"
                  style={{ width: `${evalW}%`, minWidth: '4px', background: 'var(--phase-14)' }}
                  title={`Evaluator: ${formatCost(row.evalCost)}`}
                />
              )}
            </div>
            <span className="text-xs text-zinc-400 w-16 text-right font-mono shrink-0">{formatCost(row.total)}</span>
          </div>
        );
      })}

      {/* Legend */}
      <div className="flex items-center gap-4 pt-1 justify-end">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded" style={{ background: 'var(--phase-13)' }} />
          <span className="text-[10px] text-zinc-500">Coder</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded" style={{ background: 'var(--phase-14)' }} />
          <span className="text-[10px] text-zinc-500">Evaluator</span>
        </div>
      </div>
    </div>
  );
}

interface PhaseTableProps {
  phases: PipelinePhaseMetrics[];
  agentNames: Record<string, string>;
  pipelineType: PipelineType;
}

function PhaseRow({
  phase,
  label,
  rowBg,
  indent,
  agentNames,
  pipelineType,
}: {
  phase: PipelinePhaseMetrics;
  label: string;
  rowBg: string;
  indent?: boolean;
  agentNames?: Record<string, string>;
  pipelineType: PipelineType;
}) {
  const type = classifyPhase(phase.phaseNumber, pipelineType);
  const isPass =
    phase.status === 'done' || phase.status === 'approved' || phase.status === 'passed' || phase.status === 'completed';
  const isFail = phase.status === 'failed' || phase.status === 'rejected';

  return (
    <tr className={rowBg}>
      <td
        className={`px-4 py-2 font-medium ${indent ? 'pl-8' : ''}`}
        style={{ color: phaseVarColor(phase.phaseNumber, pipelineType) }}
      >
        {label}
      </td>
      <td className="px-4 py-2 text-zinc-400 max-w-[180px] truncate" title={phase.agentId ?? undefined}>
        {phase.agentId ? (agentNames?.[phase.agentId] ?? phase.agentId) : '-'}
      </td>
      <td className="px-4 py-2 text-center">
        <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium uppercase ${phaseTypeBadgeColor(type)}`}>
          {phaseTypeLabel(type)}
        </span>
      </td>
      <td className="px-4 py-2 text-zinc-400 text-xs font-mono max-w-[140px] truncate">
        {phase.model ? (
          <span
            className="cursor-default"
            title={[
              `Modelo: ${phase.model}`,
              phase.agentId ? `Agent: ${agentNames?.[phase.agentId] ?? phase.agentId}` : null,
              phase.runtime ? `Runtime: ${phase.runtime}` : null,
              `Provider: ${resolveProviderForDisplay(phase.metadata, phase.runtime)}`,
              phase.metadata?.tokenStatus ? `Tokens: ${String(phase.metadata.tokenStatus)}` : null,
              phase.metadata?.costStatus ? `Custo: ${String(phase.metadata.costStatus)}` : null,
              phase.metadata?.costEstimationKind === 'subscription-equivalent-payg'
                ? 'Custo: estimativa equivalente pay-as-you-go.\nToken Plan desconta da quota primeiro.'
                : null,
            ]
              .filter(Boolean)
              .join('\n')}
          >
            {shortenModel(phase.model)}
          </span>
        ) : (
          '-'
        )}
      </td>
      <td className="px-4 py-2 text-zinc-300 text-right font-mono">
        {formatCostWithMeta(phase.costUsd, phase.metadata)}
      </td>
      <td className="px-4 py-2 text-zinc-400 text-right">
        {formatTokensWithMeta(phase.inputTokens, phase.outputTokens, phase.metadata)}
      </td>
      <td className="px-4 py-2 text-zinc-400 text-right">{formatDuration(phase.durationMs)}</td>
      <td className="px-4 py-2 text-center">
        {isPass ? (
          <span className="flex items-center justify-center gap-1 text-green-400">
            <CheckCircle2 size={11} />
            <span className="text-[10px]">OK</span>
          </span>
        ) : isFail ? (
          <span className="flex items-center justify-center gap-1 text-red-400">
            <XCircle size={11} />
            <span className="text-[10px]">Falhou</span>
          </span>
        ) : (
          <span className="text-[10px] text-zinc-600 uppercase">{phase.status}</span>
        )}
      </td>
    </tr>
  );
}

function PhaseTable({ phases, agentNames, pipelineType }: PhaseTableProps) {
  const phaseDisplayNames = getPhaseDisplayNames(pipelineType);

  const { coder: coderPhaseNum, evaluator: evalPhaseNum } = loopPhaseNumbers(pipelineType);

  const preparationPhases = phases
    .filter((p) => p.phaseNumber < coderPhaseNum || p.phaseNumber === 91)
    .sort((a, b) => phaseSortKey(a.phaseNumber) - phaseSortKey(b.phaseNumber));
  const sprintPhases = phases.filter((p) => p.phaseNumber === coderPhaseNum || p.phaseNumber === evalPhaseNum);

  const sprintMap = new Map<number, { coder: PipelinePhaseMetrics[]; evaluator: PipelinePhaseMetrics[] }>();
  for (const p of sprintPhases) {
    const si =
      (p.sprintIndex ?? -1) >= 0
        ? (p.sprintIndex as number)
        : typeof p.metadata?.sprintIndex === 'number'
          ? p.metadata.sprintIndex
          : -1;
    if (si < 0) continue;
    if (!sprintMap.has(si)) sprintMap.set(si, { coder: [], evaluator: [] });
    const group = sprintMap.get(si)!;
    if (p.phaseNumber === coderPhaseNum) group.coder.push(p);
    else if (p.phaseNumber === evalPhaseNum) group.evaluator.push(p);
  }

  const sortedSprints = Array.from(sprintMap.entries()).sort(([a], [b]) => a - b);

  let rowIndex = 0;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-zinc-800 text-zinc-400 text-left">
            <th className="px-4 py-2 font-medium">Fase</th>
            <th className="px-4 py-2 font-medium">Agente</th>
            <th className="px-4 py-2 font-medium text-center">Tipo</th>
            <th className="px-4 py-2 font-medium">Modelo</th>
            <th className="px-4 py-2 font-medium text-right">Custo</th>
            <th className="px-4 py-2 font-medium text-right">Tokens</th>
            <th className="px-4 py-2 font-medium text-right">Duracao</th>
            <th className="px-4 py-2 font-medium text-center">Resultado</th>
          </tr>
        </thead>
        <tbody>
          {/* Non-sprint phases: render normally */}
          {preparationPhases.map((phase) => {
            const bg = rowIndex % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-800/30';
            rowIndex++;
            return (
              <PhaseRow
                key={`prep-${phase.phaseNumber}-${phase.id}`}
                phase={phase}
                label={`${phaseDisplayLabel(phase.phaseNumber)}. ${phaseDisplayNames[phase.phaseNumber] ?? phase.phaseName}`}
                rowBg={bg}
                agentNames={agentNames}
                pipelineType={pipelineType}
              />
            );
          })}

          {/* Sprint phases: grouped under sprint headers */}
          {sortedSprints.map(([si, group]) => {
            const sprintName =
              (group.coder[0]?.metadata?.sprintName as string) ||
              (group.evaluator[0]?.metadata?.sprintName as string) ||
              `Sprint ${si + 1}`;
            const sprintTotal = [...group.coder, ...group.evaluator].reduce((acc, p) => acc + p.costUsd, 0);

            return (
              <Fragment key={`sprint-${si}`}>
                {/* Sprint header row */}
                <tr className="bg-zinc-800/70 border-t border-zinc-700">
                  <td colSpan={4} className="px-4 py-2 font-semibold text-amber-400 text-xs">
                    Sprint {si + 1}: {sprintName}
                  </td>
                  <td className="px-4 py-2 text-amber-400 text-right font-mono font-semibold text-xs">
                    {formatCost(sprintTotal)}
                  </td>
                  <td colSpan={3} />
                </tr>

                {/* Coder rows for this sprint */}
                {group.coder.map((phase) => {
                  const bg = rowIndex % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-800/30';
                  rowIndex++;
                  return (
                    <PhaseRow
                      key={`coder-${si}-${phase.id}`}
                      phase={phase}
                      label="Coder"
                      rowBg={bg}
                      indent
                      agentNames={agentNames}
                      pipelineType={pipelineType}
                    />
                  );
                })}

                {/* Evaluator rows for this sprint */}
                {group.evaluator.map((phase) => {
                  const bg = rowIndex % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-800/30';
                  rowIndex++;
                  return (
                    <PhaseRow
                      key={`eval-${si}-${phase.id}`}
                      phase={phase}
                      label="Evaluator"
                      rowBg={bg}
                      indent
                      agentNames={agentNames}
                      pipelineType={pipelineType}
                    />
                  );
                })}
              </Fragment>
            );
          })}

          {phases.length === 0 && (
            <tr>
              <td colSpan={8} className="px-4 py-8 text-center text-zinc-600">
                Nenhuma fase executada ainda.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface SprintTableProps {
  sprintPhases: PipelinePhaseMetrics[];
  pipelineType: PipelineType;
}

function SprintDetailTable({ sprintPhases, pipelineType }: SprintTableProps) {
  const { coder: coderNum } = loopPhaseNumbers(pipelineType);
  const rows = buildSprintBarData(sprintPhases, pipelineType);

  const sprintExtras = new Map<number, { tokens: number; durationMs: number; verdict: string }>();

  for (const p of sprintPhases) {
    const si =
      (p.sprintIndex ?? -1) >= 0
        ? (p.sprintIndex as number)
        : typeof p.metadata?.sprintIndex === 'number'
          ? p.metadata.sprintIndex
          : -1;
    if (si < 0) continue;
    const existing = sprintExtras.get(si) ?? {
      tokens: 0,
      durationMs: 0,
      verdict: p.status,
    };
    existing.tokens += p.inputTokens + p.outputTokens;
    existing.durationMs += p.durationMs;
    sprintExtras.set(si, existing);
  }

  if (rows.length === 0) {
    return <p className="text-xs text-zinc-600 text-center py-6">Nenhum sprint executado ainda.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-zinc-800 text-zinc-400 text-left">
            <th className="px-4 py-2 font-medium">Sprint</th>
            <th className="px-4 py-2 font-medium text-right">Rounds</th>
            <th className="px-4 py-2 font-medium text-right">Coder $</th>
            <th className="px-4 py-2 font-medium text-right">Evaluator $</th>
            <th className="px-4 py-2 font-medium text-right">Total</th>
            <th className="px-4 py-2 font-medium text-right">Tokens</th>
            <th className="px-4 py-2 font-medium text-right">Duracao</th>
            <th className="px-4 py-2 font-medium text-center">Resultado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const extras = sprintExtras.get(row.sprintIndex);
            const coderRounds = sprintPhases.filter(
              (p) =>
                p.phaseNumber === coderNum &&
                ((p.sprintIndex ?? -1) >= 0
                  ? p.sprintIndex === row.sprintIndex
                  : typeof p.metadata?.sprintIndex === 'number'
                    ? p.metadata.sprintIndex === row.sprintIndex
                    : false),
            ).length;
            const rowBg = idx % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-800/30';

            const verdictStatus = extras?.verdict ?? '';
            const isPass = verdictStatus === 'done' || verdictStatus === 'approved' || verdictStatus === 'passed';
            const isFail = verdictStatus === 'failed' || verdictStatus === 'rejected';

            return (
              <tr key={row.sprintIndex} className={rowBg}>
                <td className="px-4 py-2 text-zinc-200 font-medium">Sprint {row.sprintIndex + 1}</td>
                <td className="px-4 py-2 text-zinc-400 text-right">{coderRounds}</td>
                <td className="px-4 py-2 text-right font-mono">
                  <div className="flex flex-col items-end gap-0.5">
                    <span style={{ color: 'var(--phase-13)' }}>{formatCost(row.coderCost)}</span>
                    {row.coderModel && (
                      <span className="text-[9px] font-medium text-green-400 normal-case">
                        {shortenModel(row.coderModel)}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2 text-right font-mono">
                  <div className="flex flex-col items-end gap-0.5">
                    <span style={{ color: 'var(--phase-14)' }}>{formatCost(row.evalCost)}</span>
                    {row.evalModel && (
                      <span className="text-[9px] font-medium text-green-400 normal-case">
                        {shortenModel(row.evalModel)}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2 text-zinc-200 text-right font-mono font-medium">{formatCost(row.total)}</td>
                <td className="px-4 py-2 text-zinc-400 text-right">{formatTokens(extras?.tokens ?? 0)}</td>
                <td className="px-4 py-2 text-zinc-400 text-right">{formatDuration(extras?.durationMs ?? 0)}</td>
                <td className="px-4 py-2 text-center">
                  {isPass ? (
                    <span className="flex items-center justify-center gap-1 text-green-400">
                      <CheckCircle2 size={11} />
                      <span className="text-[10px]">Passou</span>
                    </span>
                  ) : isFail ? (
                    <span className="flex items-center justify-center gap-1 text-red-400">
                      <XCircle size={11} />
                      <span className="text-[10px]">Falhou</span>
                    </span>
                  ) : (
                    <span className="text-[10px] text-zinc-600 uppercase">{verdictStatus || '-'}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface RuntimeCostSectionProps {
  costByRuntime: Record<string, number>;
  costStatusByRuntime?: Record<string, 'known' | 'unknown' | 'estimated-partial'>;
  phases: PipelinePhaseMetrics[];
}

function RuntimeCostSection({ costByRuntime, costStatusByRuntime, phases }: RuntimeCostSectionProps) {
  const entries = orderedRuntimeEntries(costByRuntime);
  if (!entries.some(([runtime]) => runtime !== 'cloud')) return null;

  const grandTotal = entries.reduce((sum, [, cost]) => sum + cost, 0);
  const runtimeTokens = new Map<string, number>();
  const runtimesWithPhases = new Set<string>();
  for (const phase of phases) {
    const runtime = phase.runtime ?? 'cloud';
    runtimesWithPhases.add(runtime);
    runtimeTokens.set(runtime, (runtimeTokens.get(runtime) ?? 0) + phase.inputTokens + phase.outputTokens);
  }
  const barColors: Record<string, string> = {
    cloud: 'bg-blue-500',
    local: 'bg-green-500',
    external: 'bg-orange-500',
    codex: 'bg-purple-500',
    zai: 'bg-cyan-500',
    'minimax-tp': 'bg-pink-500',
    kimi: 'bg-lime-500',
    grok: 'bg-red-500',
  };
  const localCost = costByRuntime['local'] ?? 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
      <h3 className="text-xs text-zinc-400 uppercase tracking-wide font-semibold flex items-center gap-2">
        <Server size={13} />
        Custo por Runtime
      </h3>

      <div
        className={`grid gap-4 ${entries.length >= 4 ? 'grid-cols-2 lg:grid-cols-4' : entries.length >= 2 ? 'grid-cols-2' : 'grid-cols-1'}`}
      >
        {entries.map(([runtime, cost]) => {
          const Icon = runtime === 'cloud' ? Cloud : Server;
          const hasPhase = runtimesWithPhases.has(runtime);
          return (
            <div key={runtime} className="space-y-2">
              <div className="flex items-center gap-2">
                <Icon size={13} className="text-zinc-400" />
                <span className="text-xs text-zinc-300">{PIPELINE_RUNTIME_LABELS[runtime] ?? runtime}</span>
              </div>
              <div className="h-2 bg-zinc-800 rounded overflow-hidden">
                <div
                  className={`h-2 rounded transition-all duration-500 ${barColors[runtime] ?? 'bg-zinc-500'}`}
                  style={{ width: `${pct(cost, grandTotal)}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-zinc-400 font-mono">
                  {formatRuntimeCost(runtime, cost, costStatusByRuntime?.[runtime])}
                </span>
                <span className="text-zinc-600">
                  {hasPhase ? `${formatTokens(runtimeTokens.get(runtime) ?? 0)} tokens` : 'inclui subagentes'}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {localCost > 0 && (
        <p className="text-[11px] text-zinc-600">
          Economizado com modelos locais: <span className="text-green-400 font-medium">{formatCost(localCost)}</span> (
          {pct(localCost, grandTotal).toFixed(0)}% do custo equivalente)
        </p>
      )}
      {entries.some(([runtime]) => PIPELINE_PAYG_EQUIVALENT_RUNTIMES.has(runtime)) && (
        <p className="text-[11px] text-zinc-600">
          Valores com ~ sao equivalentes da API; nao sao cobranca da assinatura.
        </p>
      )}
    </div>
  );
}

interface SecurityFindingsSummaryProps {
  securitySummary: SecuritySummary;
}

function SecurityFindingsSummary({ securitySummary }: SecurityFindingsSummaryProps) {
  const { totalFindings, bySeverity, removedByValidator, confirmedFindings, resolved, partiallyResolved, unresolved } =
    securitySummary;

  const total = totalFindings ?? 0;
  const confirmed = confirmedFindings ?? 0;
  const removed = removedByValidator ?? 0;

  const severities: Array<{
    key: keyof NonNullable<SecuritySummary['bySeverity']>;
    label: string;
    barColor: string;
    textColor: string;
  }> = [
    { key: 'critical', label: 'CRITICO', barColor: 'bg-red-600', textColor: 'text-red-400' },
    { key: 'high', label: 'ALTO', barColor: 'bg-orange-500', textColor: 'text-orange-400' },
    { key: 'medium', label: 'MEDIO', barColor: 'bg-yellow-500', textColor: 'text-yellow-400' },
    { key: 'low', label: 'BAIXO', barColor: 'bg-blue-500', textColor: 'text-blue-400' },
  ];

  const maxSeverity = Math.max(...severities.map((s) => bySeverity?.[s.key] ?? 0), 1);

  const hasResolution = resolved !== undefined || partiallyResolved !== undefined || unresolved !== undefined;
  const resolvedCount = resolved ?? 0;
  const resolutionPct = confirmed > 0 ? Math.round((resolvedCount / confirmed) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Findings por severidade */}
      {bySeverity !== undefined ? (
        <div className="space-y-2">
          {severities.map(({ key, label, barColor, textColor }) => {
            const count = bySeverity[key] ?? 0;
            if (count === 0) return null;
            return (
              <div key={key} className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded shrink-0 ${barColor}`} />
                <span className={`text-[11px] font-semibold w-16 shrink-0 ${textColor}`}>{label}</span>
                <div className="flex-1 h-4 bg-zinc-800 rounded overflow-hidden">
                  <div
                    className={`h-4 rounded transition-all duration-500 ${barColor}`}
                    style={{
                      width: `${pct(count, maxSeverity)}%`,
                      minWidth: count > 0 ? '4px' : '0',
                    }}
                  />
                </div>
                <span className="text-xs text-zinc-300 w-14 text-right shrink-0 font-mono">
                  {count} finding{count !== 1 ? 's' : ''}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-zinc-600 text-center py-2">Dados por severidade nao disponiveis ainda.</p>
      )}

      {/* Totais */}
      <div className="pt-3 border-t border-zinc-800 space-y-1.5">
        <div className="flex justify-between text-[11px]">
          <span className="text-zinc-500">Total de findings</span>
          <span className="text-zinc-200 font-mono font-medium">{total}</span>
        </div>
        {removed > 0 && (
          <div className="flex justify-between text-[11px]">
            <span className="text-zinc-500">Removidos pelo Validador (falsos positivos)</span>
            <span className="text-zinc-400 font-mono">{removed}</span>
          </div>
        )}
        {confirmed > 0 && (
          <div className="flex justify-between text-[11px]">
            <span className="text-zinc-500">Confirmados</span>
            <span className="text-zinc-300 font-mono">{confirmed}</span>
          </div>
        )}
      </div>

      {/* Resolucao */}
      {hasResolution ? (
        <div className="pt-3 border-t border-zinc-800 space-y-1.5">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wide font-semibold mb-2">Resolucao pelo Coder</p>
          <div className="flex justify-between text-[11px]">
            <span className="text-zinc-500">Resolvidos</span>
            <span className="text-green-400 font-mono font-medium">
              {resolvedCount}/{confirmed} ({resolutionPct}%)
            </span>
          </div>
          {partiallyResolved !== undefined && partiallyResolved > 0 && (
            <div className="flex justify-between text-[11px]">
              <span className="text-zinc-500">Parcialmente resolvidos</span>
              <span className="text-yellow-400 font-mono">{partiallyResolved}</span>
            </div>
          )}
          {unresolved !== undefined && unresolved > 0 && (
            <div className="flex justify-between text-[11px]">
              <span className="text-zinc-500">Nao resolvidos</span>
              <span className="text-red-400 font-mono">{unresolved}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="pt-3 border-t border-zinc-800">
          <p className="text-[11px] text-zinc-600 flex items-center gap-1.5">
            <AlertTriangle size={11} className="shrink-0" />
            Resolucao: Pendente (Resolution Tracker ainda nao executou)
          </p>
        </div>
      )}
    </div>
  );
}

interface SectionProps {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

function Section({ title, subtitle, icon, children }: SectionProps) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-zinc-800">
        <h3 className="text-xs text-zinc-400 uppercase tracking-wide font-semibold flex items-center gap-2">
          {icon}
          {title}
        </h3>
        {subtitle && <p className="text-[10px] text-zinc-600 mt-0.5">{subtitle}</p>}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

interface PipelineMetricsReportProps {
  projectId: string;
  onClose?: () => void;
}

export function PipelineMetricsReport({ projectId, onClose }: PipelineMetricsReportProps) {
  const metrics = useActiveProjectState((s) => s.metrics) ?? null;
  const projects = usePipelineStore((s) => s.projects);

  const [smokeTestExists, setSmokeTestExists] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.lionclaw.pipeline
      .getSmokeTestPath(projectId)
      .then((result) => {
        if (!cancelled) setSmokeTestExists(result.exists);
      })
      .catch(() => {
        /* silencioso */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const project = projects.find((p) => p.id === projectId);
  const pipelineType: PipelineType = project?.pipelineType ?? 'development';
  const isSecurity = pipelineType === 'security';

  const rawSummary = (project?.metadata as Record<string, unknown> | undefined)?.securitySummary;
  const securitySummary =
    rawSummary !== null && typeof rawSummary === 'object' ? (rawSummary as SecuritySummary) : null;

  if (metrics === null) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        {onClose && (
          <div className="flex w-full justify-end mb-4">
            <button
              onClick={onClose}
              className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors"
              aria-label="Fechar"
            >
              <X size={16} />
            </button>
          </div>
        )}
        <Activity size={28} className="text-zinc-700 mb-3" />
        <p className="text-sm text-zinc-500">Nenhuma metrica disponivel ainda.</p>
        <p className="text-xs text-zinc-600 mt-1">Execute o pipeline para ver o relatorio completo.</p>
      </div>
    );
  }

  const displayMetrics = buildDisplayMetrics(metrics, pipelineType);

  return (
    <>
      {/* Inject CSS variables */}
      <style>{PHASE_CSS_VARS}</style>
      {isSecurity && <style>{SECURITY_PHASE_CSS_VARS}</style>}

      <div className="space-y-6">
        {/* Header + export + close */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-200">Relatorio de Metricas</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Resumo completo do pipeline: custo, tokens, tempo e resultado por fase.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {smokeTestExists && (
              <button
                onClick={() => {
                  window.lionclaw.pipeline
                    .openSmokeTest(projectId)
                    .then((result) => {
                      if ('error' in result) console.error('pipeline:open-smoke-test:', result.error);
                    })
                    .catch((err: unknown) => console.error('pipeline:open-smoke-test:', err));
                }}
                className="flex items-center gap-1.5 px-2 py-1 text-xs text-zinc-300 border border-zinc-700 hover:border-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors"
                title="Abrir relatorio de smoke test no Finder"
              >
                <FileSearch size={13} />
                Ver Smoke Test
              </button>
            )}
            {onClose && (
              <button
                onClick={onClose}
                className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors"
                aria-label="Fechar"
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>

        {/* Section 1: KPI Cards */}
        <KpiSection metrics={displayMetrics} pipelineType={pipelineType} />

        {/* Section 2: Cost per phase */}
        <Section
          title="Custo por Etapa"
          subtitle={
            pipelineType === 'security'
              ? 'Quanto custou cada etapa do pipeline de seguranca (Scan, Validacao, Spec, Execucao)'
              : pipelineType === 'architecture-review'
                ? 'Quanto custou cada etapa do architecture review (Map, Triage, Diagnostico, Decisao, Spec, Plan, Code, Eval)'
                : pipelineType === 'feature'
                  ? 'Quanto custou cada etapa do pipeline de feature (Discovery, PRD, Tech, Spec, Planner, Coder, Evaluator)'
                  : 'Quanto custou cada etapa do pipeline (Discovery, PRD, Spec, Planner, Coder, Evaluator, etc.)'
          }
        >
          <PhaseBarChart phases={displayMetrics.phases} pipelineType={pipelineType} />
        </Section>

        {/* Section 3b: Security Audit Breakdown (exclusive to security pipeline) */}
        {isSecurity && (
          <Section
            title="Custo por Agente de Auditoria (Fase 2)"
            subtitle="Quanto cada agente especializado gastou no scan de seguranca"
            icon={<Shield size={13} />}
          >
            <SecurityAuditBreakdown phases={displayMetrics.phases} agentNames={displayMetrics.agentNames ?? {}} />
          </Section>
        )}

        {/* Section 3: Agent distribution */}
        <Section
          title="Custo por Agente"
          subtitle="Quanto cada agente individual gastou (ex: sprints diferentes podem usar agentes diferentes)"
        >
          <AgentBarChart phases={displayMetrics.phases} agentNames={displayMetrics.agentNames ?? {}} />
        </Section>

        {/* Section 4: Sprint cost breakdown */}
        {displayMetrics.sprintPhases.length > 0 && (
          <Section title="Custo por Sprint (Coder / Evaluator / Reviewer)">
            <SprintCostChart sprintPhases={displayMetrics.sprintPhases} pipelineType={pipelineType} />
          </Section>
        )}

        {/* Section 5: Detailed phase table */}
        <Section title="Detalhes por Fase">
          <PhaseTable
            phases={displayMetrics.phases}
            agentNames={displayMetrics.agentNames ?? {}}
            pipelineType={pipelineType}
          />
        </Section>

        {/* Section 6: Detailed sprint table */}
        {displayMetrics.sprintPhases.length > 0 && (
          <Section title="Detalhes por Sprint">
            <SprintDetailTable sprintPhases={displayMetrics.sprintPhases} pipelineType={pipelineType} />
          </Section>
        )}

        {/* Section 7: Custo por Runtime (conditional — shown when any non-cloud runtime is present) */}
        {Object.keys(displayMetrics.costByRuntime).some((runtime) => runtime !== 'cloud') && (
          <RuntimeCostSection
            costByRuntime={displayMetrics.costByRuntime}
            costStatusByRuntime={displayMetrics.costStatusByRuntime}
            phases={displayMetrics.phases}
          />
        )}

        {/* Section 8: Security Findings Summary (exclusive to security pipeline) */}
        {isSecurity && securitySummary !== null && (
          <Section
            title="Resumo de Findings"
            subtitle="Resultado consolidado do scan de seguranca"
            icon={<Shield size={13} />}
          >
            <SecurityFindingsSummary securitySummary={securitySummary} />
          </Section>
        )}
      </div>
    </>
  );
}
