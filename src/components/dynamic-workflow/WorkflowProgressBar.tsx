import { useMemo, useState } from 'react';
import { Check, X, Minus, RotateCcw, Layers, ChevronRight } from 'lucide-react';
import type {
  DynamicWorkflowManifest,
  DynamicWorkflowManifestPhase,
  DynamicWorkflowNode,
  DynamicWorkflowNodeRun,
  DynamicWorkflowNodeStatus,
  DynamicWorkflowRunStatus,
} from '@/types';


export function isRunDeliveredTerminal(
  runStatus: DynamicWorkflowRunStatus | null | undefined,
): boolean {
  return runStatus === 'delivered' || runStatus === 'completed';
}


export function isDeliveryGatePhase(
  phaseId: string,
  nodes: DynamicWorkflowNode[],
): boolean {
  const inPhase = nodes.filter((n) => n.phaseId === phaseId);
  if (inPhase.length === 0) return false;
  return inPhase.every((n) => n.type === 'gate' || n.type === 'artifact');
}

export function selectRenderedPhases(
  phases: DynamicWorkflowManifestPhase[],
  nodes: DynamicWorkflowNode[],
): DynamicWorkflowManifestPhase[] {
  if (phases.length === 0) return phases;
  const last = phases[phases.length - 1];
  if (isDeliveryGatePhase(last.id, nodes)) {
    return phases.slice(0, -1);
  }
  return phases;
}


export type WorkflowPhaseDisplayStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

const ROUND_SUFFIX_RE = /-r(\d+)$/;

export function parseRoundIndex(nodeId: string): number | null {
  const m = ROUND_SUFFIX_RE.exec(nodeId);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

export function isLoopPhase(
  phaseId: string,
  nodeRuns: DynamicWorkflowNodeRun[],
): boolean {
  return nodeRuns.some(
    (nr) => nr.phaseId === phaseId && parseRoundIndex(nr.nodeId) !== null,
  );
}

function combineNodeStatuses(
  statuses: DynamicWorkflowNodeStatus[],
): WorkflowPhaseDisplayStatus {
  if (statuses.length === 0) return 'pending';
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('failed') || statuses.includes('blocked')) return 'failed';
  if (statuses.includes('interrupted')) return 'running';
  if (statuses.includes('pending')) {
    const anyDone = statuses.some(
      (s) => s === 'completed' || s === 'skipped' || s === 'cancelled',
    );
    return anyDone ? 'running' : 'pending';
  }
  if (statuses.every((s) => s === 'skipped' || s === 'cancelled')) return 'skipped';
  return 'completed';
}

export function derivePhaseDisplayStatus(
  phaseId: string,
  nodeRuns: DynamicWorkflowNodeRun[],
  phaseNodes?: DynamicWorkflowNode[],
  opts?: {
    runStatus?: DynamicWorkflowRunStatus | null;
    isFinalPhase?: boolean;
  },
): WorkflowPhaseDisplayStatus {
  const inPhase = nodeRuns.filter((nr) => nr.phaseId === phaseId);

  const deliveredFinal = !!(opts?.isFinalPhase && isRunDeliveredTerminal(opts?.runStatus));
  if (inPhase.length === 0) {
    return deliveredFinal ? 'completed' : 'pending';
  }

  const latestByNode = new Map<string, DynamicWorkflowNodeRun>();
  for (const nr of inPhase) {
    const prev = latestByNode.get(nr.nodeId);
    if (!prev || nr.attempt > prev.attempt) latestByNode.set(nr.nodeId, nr);
  }

  const ran = Array.from(latestByNode.values()).map((nr) => nr.status);

  if (phaseNodes && phaseNodes.length > 0) {
    const anyFinished =
      deliveredFinal ||
      ran.some((s) => s === 'completed' || s === 'skipped' || s === 'cancelled');
    if (anyFinished) {
      for (const node of phaseNodes) {
        if (node.phaseId !== phaseId) continue;
        if (!latestByNode.has(node.nodeId)) {
          ran.push('skipped');
        }
      }
    }
  }

  const combined = combineNodeStatuses(ran);
  if (deliveredFinal && combined !== 'failed') return 'completed';
  return combined;
}

export interface AggregatedPhaseMetrics {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  attempts: number;
  hasUnknownCost: boolean;
}

export function aggregatePhaseMetrics(
  phaseId: string,
  nodeRuns: DynamicWorkflowNodeRun[],
): AggregatedPhaseMetrics {
  const acc: AggregatedPhaseMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: 0,
    attempts: 0,
    hasUnknownCost: false,
  };
  for (const nr of nodeRuns) {
    if (nr.phaseId !== phaseId) continue;
    acc.inputTokens += nr.inputTokens;
    acc.outputTokens += nr.outputTokens;
    acc.costUsd += nr.costUsd;
    acc.durationMs += nr.durationMs;
    acc.attempts += 1;
    if (nr.costStatus !== null && nr.costStatus !== 'known') {
      acc.hasUnknownCost = true;
    }
  }
  return acc;
}

export type WorkflowRoundDisplayStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed';

export interface WorkflowRoundInfo {
  index: number;
  status: WorkflowRoundDisplayStatus;
  nodeIds: string[];
}

export function deriveRoundsFromNodeRuns(
  nodeRuns: DynamicWorkflowNodeRun[],
): WorkflowRoundInfo[] {
  const byRound = new Map<number, DynamicWorkflowNodeRun[]>();
  for (const nr of nodeRuns) {
    const idx = parseRoundIndex(nr.nodeId);
    if (idx === null) continue;
    const list = byRound.get(idx) ?? [];
    list.push(nr);
    byRound.set(idx, list);
  }

  const rounds: WorkflowRoundInfo[] = [];
  for (const [index, runs] of Array.from(byRound.entries()).sort(
    (a, b) => a[0] - b[0],
  )) {
    const latestByNode = new Map<string, DynamicWorkflowNodeRun>();
    for (const nr of runs) {
      const prev = latestByNode.get(nr.nodeId);
      if (!prev || nr.attempt > prev.attempt) latestByNode.set(nr.nodeId, nr);
    }
    const statuses = Array.from(latestByNode.values()).map((nr) => nr.status);
    const combined = combineNodeStatuses(statuses);
    const status: WorkflowRoundDisplayStatus =
      combined === 'failed'
        ? 'failed'
        : combined === 'running'
          ? 'running'
          : combined === 'pending'
            ? 'pending'
            : 'passed';
    rounds.push({
      index,
      status,
      nodeIds: Array.from(latestByNode.keys()).sort(),
    });
  }
  return rounds;
}


export type WorkflowSprintDisplayStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed';

export interface WorkflowSprintRoundInfo {
  index: number;
  status: WorkflowRoundDisplayStatus;
  nodeIds: string[];
}

export interface WorkflowSprintGroup {
  sprintId: string;
  status: WorkflowSprintDisplayStatus;
  rounds: WorkflowSprintRoundInfo[];
  nodeIds: string[];
}

function combineSprintStatus(
  statuses: DynamicWorkflowNodeStatus[],
): WorkflowSprintDisplayStatus {
  const combined = combineNodeStatuses(statuses);
  if (combined === 'failed') return 'failed';
  if (combined === 'running') return 'running';
  if (combined === 'pending') return 'pending';
  return 'passed';
}

export function deriveSprintGroups(
  nodes: DynamicWorkflowNode[],
  nodeRuns: DynamicWorkflowNodeRun[],
  runStatus?: DynamicWorkflowRunStatus | null,
): WorkflowSprintGroup[] {
  const deliveredTerminal = isRunDeliveredTerminal(runStatus);
  const sprintOrder: string[] = [];
  const bySprint = new Map<
    string,
    Map<number, { nodeIds: Set<string> }>
  >();
  for (const node of nodes) {
    if (!node.sprintId) continue;
    const round = typeof node.roundIndex === 'number' ? node.roundIndex : 0;
    if (!bySprint.has(node.sprintId)) {
      bySprint.set(node.sprintId, new Map());
      sprintOrder.push(node.sprintId);
    }
    const rounds = bySprint.get(node.sprintId)!;
    if (!rounds.has(round)) rounds.set(round, { nodeIds: new Set() });
    rounds.get(round)!.nodeIds.add(node.nodeId);
  }
  if (sprintOrder.length === 0) return [];

  const latestByNode = new Map<string, DynamicWorkflowNodeRun>();
  for (const nr of nodeRuns) {
    const prev = latestByNode.get(nr.nodeId);
    if (!prev || nr.attempt > prev.attempt) latestByNode.set(nr.nodeId, nr);
  }

  const statusesFor = (
    nodeIds: Set<string>,
    sprintHasFinished: boolean,
  ): DynamicWorkflowNodeStatus[] => {
    const out: DynamicWorkflowNodeStatus[] = [];
    for (const id of nodeIds) {
      const nr = latestByNode.get(id);
      if (nr) {
        out.push(nr.status);
      } else if (sprintHasFinished) {
        out.push('skipped');
      }
    }
    return out;
  };

  const groups: WorkflowSprintGroup[] = [];
  for (const sprintId of sprintOrder) {
    const roundsMap = bySprint.get(sprintId)!;

    const allNodeIdsForCheck = new Set<string>();
    for (const { nodeIds } of roundsMap.values()) {
      for (const id of nodeIds) allNodeIdsForCheck.add(id);
    }
    const sprintHasFinished =
      deliveredTerminal ||
      Array.from(allNodeIdsForCheck).some((id) => {
        const nr = latestByNode.get(id);
        return nr && (nr.status === 'completed' || nr.status === 'skipped' || nr.status === 'cancelled');
      });

    const rounds: WorkflowSprintRoundInfo[] = [];
    const allNodeIds = new Set<string>();
    for (const [index, { nodeIds }] of Array.from(roundsMap.entries()).sort(
      (a, b) => a[0] - b[0],
    )) {
      for (const id of nodeIds) allNodeIds.add(id);
      const combined = combineNodeStatuses(statusesFor(nodeIds, sprintHasFinished));
      const status: WorkflowRoundDisplayStatus =
        combined === 'failed'
          ? 'failed'
          : combined === 'running'
            ? 'running'
            : combined === 'pending'
              ? 'pending'
              : 'passed';
      rounds.push({ index, status, nodeIds: Array.from(nodeIds).sort() });
    }
    groups.push({
      sprintId,
      status: combineSprintStatus(statusesFor(allNodeIds, sprintHasFinished)),
      rounds,
      nodeIds: Array.from(allNodeIds).sort(),
    });
  }
  return groups;
}


export interface WorkflowSprintChip {
  index: number;
  total: number;
  roundLabel: string | null;
  sprintId: string;
  status: WorkflowSprintDisplayStatus;
}

export function deriveCurrentSprintChip(
  nodes: DynamicWorkflowNode[],
  nodeRuns: DynamicWorkflowNodeRun[],
): WorkflowSprintChip | null {
  const groups = deriveSprintGroups(nodes, nodeRuns);
  if (groups.length === 0) return null;

  const total = groups.length;
  let currentIdx = groups.findIndex((g) => g.status === 'running');
  if (currentIdx === -1) {
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      if (groups[i].status === 'passed' || groups[i].status === 'failed') {
        currentIdx = i;
        break;
      }
    }
  }
  if (currentIdx === -1) currentIdx = 0;
  const group = groups[currentIdx];

  let round = group.rounds.find((r) => r.status === 'running') ?? null;
  if (!round) {
    for (let i = group.rounds.length - 1; i >= 0; i -= 1) {
      if (group.rounds[i].status !== 'pending') {
        round = group.rounds[i];
        break;
      }
    }
  }
  if (!round && group.rounds.length > 0) round = group.rounds[0];

  return {
    index: currentIdx + 1,
    total,
    roundLabel: round ? `R${round.index + 1}` : null,
    sprintId: group.sprintId,
    status: group.status,
  };
}


const STATUS_NUM_COLOR: Record<WorkflowPhaseDisplayStatus, string> = {
  pending: 'text-zinc-600',
  running: 'text-orange-300',
  completed: 'text-green-400',
  failed: 'text-red-400',
  skipped: 'text-zinc-500',
};

function PhaseStatusIcon({ status }: { status: WorkflowPhaseDisplayStatus }) {
  if (status === 'completed') {
    return <Check size={10} strokeWidth={3} className="text-green-400" />;
  }
  if (status === 'running') {
    return (
      <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-orange-400 border-t-transparent animate-spin" />
    );
  }
  if (status === 'failed') {
    return <X size={10} strokeWidth={3} className="text-red-400" />;
  }
  if (status === 'skipped') {
    return <Minus size={10} strokeWidth={2} className="text-zinc-500" />;
  }
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-full"
      style={{ border: '1.5px dashed #52525b' }}
    />
  );
}

function PhaseConnector({ completed }: { completed: boolean }) {
  return (
    <div
      className={`h-0.5 flex-1 mx-0.5 rounded transition-colors ${
        completed ? 'bg-green-600' : 'bg-zinc-800'
      }`}
    />
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}c`;
  return `$${usd.toFixed(3)}`;
}

function phaseAbbrev(phase: DynamicWorkflowManifestPhase): string {
  const src = (phase.name || phase.id).replace(/[^a-zA-Z0-9]/g, '');
  return src.slice(0, 3).toUpperCase() || phase.id.slice(0, 3).toUpperCase();
}

interface PhaseTooltipProps {
  phase: DynamicWorkflowManifestPhase;
  metrics: AggregatedPhaseMetrics;
  status: WorkflowPhaseDisplayStatus;
  loop: boolean;
  activeRound: number | null;
  totalRounds: number;
  align: 'left' | 'center' | 'right';
}

export function tooltipAlign(index: number, total: number): 'left' | 'center' | 'right' {
  if (total <= 1) return 'center';
  if (index === 0) return 'left';
  if (index === total - 1) return 'right';
  if (index <= Math.floor(total * 0.25)) return 'left';
  if (index >= Math.ceil(total * 0.75)) return 'right';
  return 'center';
}

const TOOLTIP_POSITION: Record<'left' | 'center' | 'right', string> = {
  center: 'left-1/2 -translate-x-1/2',
  left: 'left-0',
  right: 'right-0',
};

function PhaseTooltip({
  phase,
  metrics,
  status,
  loop,
  activeRound,
  totalRounds,
  align,
}: PhaseTooltipProps) {
  return (
    <div
      className={`absolute bottom-full mb-2 z-50 pointer-events-none ${TOOLTIP_POSITION[align]}`}
      data-testid={`phase-tooltip-${align}`}
    >
      {/* SM-13: max-w + wrap (sem whitespace-nowrap) para o balao caber e nao
          vazar fora da barra; min-w garante legibilidade das linhas curtas. */}
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-300 break-words shadow-xl min-w-[10rem] max-w-[16rem]">
        <p className="font-semibold text-zinc-100 mb-1">{phase.name}</p>
        {loop && (
          <p className="text-amber-300/80 mb-1 text-[11px]">
            {activeRound !== null
              ? `loop rodada ${activeRound + 1}/${totalRounds}`
              : `loop (${totalRounds} rodadas)`}
          </p>
        )}
        {metrics.attempts > 0 ? (
          <div className="space-y-0.5 text-[11px]">
            <div className="flex gap-3">
              <span className="text-zinc-500">Custo:</span>
              <span className="text-zinc-300">
                {formatCost(metrics.costUsd)}
                {metrics.hasUnknownCost ? ' (parcial)' : ''}
              </span>
            </div>
            <div className="flex gap-3">
              <span className="text-zinc-500">Duracao:</span>
              <span className="text-zinc-300">{formatMs(metrics.durationMs)}</span>
            </div>
            <div className="flex gap-3">
              <span className="text-zinc-500">Tokens in:</span>
              <span className="text-zinc-300">
                {metrics.inputTokens.toLocaleString()}
              </span>
            </div>
            <div className="flex gap-3">
              <span className="text-zinc-500">Tokens out:</span>
              <span className="text-zinc-300">
                {metrics.outputTokens.toLocaleString()}
              </span>
            </div>
            <div className="flex gap-3">
              <span className="text-zinc-500">Tentativas:</span>
              <span className="text-zinc-300">{metrics.attempts}</span>
            </div>
          </div>
        ) : (
          <p className="text-zinc-600 text-[11px]">
            {status === 'pending' ? 'Ainda nao executado' : 'Sem metricas'}
          </p>
        )}
      </div>
      {/* SM-13: a seta aponta para o badge. Center fica no meio; left/right ficam
          junto a borda ancorada (onde o badge esta), nao mais sempre no centro. */}
      <div
        className={
          align === 'left'
            ? 'flex justify-start pl-3'
            : align === 'right'
              ? 'flex justify-end pr-3'
              : 'flex justify-center'
        }
      >
        <div className="w-2 h-2 bg-zinc-900 border-r border-b border-zinc-700 rotate-45 -mt-1" />
      </div>
    </div>
  );
}


export interface WorkflowProgressBarProps {
  manifest: DynamicWorkflowManifest | null;
  nodeRuns: DynamicWorkflowNodeRun[];
  nodes?: DynamicWorkflowNode[];
  currentPhaseId?: string | null;
  runStatus?: DynamicWorkflowRunStatus | null;
  onPhaseClick?: (phaseId: string) => void;
  onSprintDrillDown?: (sprintId: string) => void;
}

export function WorkflowProgressBar({
  manifest,
  nodeRuns,
  nodes = [],
  currentPhaseId = null,
  runStatus = null,
  onPhaseClick,
  onSprintDrillDown,
}: WorkflowProgressBarProps) {
  const [hovered, setHovered] = useState<string | null>(null);

  const allPhases = useMemo(
    () => (manifest ? [...manifest.phases].sort((a, b) => a.order - b.order) : []),
    [manifest],
  );

  const phases = useMemo(
    () => selectRenderedPhases(allPhases, nodes),
    [allPhases, nodes],
  );
  const rounds = useMemo(() => deriveRoundsFromNodeRuns(nodeRuns), [nodeRuns]);
  const totalRounds = rounds.length;
  const activeRoundIndex = useMemo(() => {
    const running = rounds.find((r) => r.status === 'running');
    return running ? running.index : null;
  }, [rounds]);

  const sprintChip = useMemo(
    () => deriveCurrentSprintChip(nodes, nodeRuns),
    [nodes, nodeRuns],
  );

  if (phases.length === 0) {
    return (
      <div className="border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 shrink-0">
        <p className="text-[10px] font-mono text-zinc-600">
          topologia indisponivel (manifest ausente)
        </p>
      </div>
    );
  }

  return (
    <div className="border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 shrink-0">
      {/* F6 (sec 5.2): chip "Sprint atual" no topo, substituindo o grid de sprints.
          So aparece quando ha sprints (run com fase de loop); drill-down opcional. */}
      {sprintChip && (
        <div className="mb-2 flex items-center">
          <SprintChip chip={sprintChip} onDrillDown={onSprintDrillDown} />
        </div>
      )}

      {/* Sem labels de fase em uppercase (pedido do dono): a barra mostra so os nos
          PLA -> DES (numero + abreviacao), compacta. A Entrega NAO aparece na barra
          (e um gate, refletido no fim do run). A cadeia fica compacta (max-w-md,
          alinhada a esquerda) em vez de esticar a tela toda. */}
      <div className="flex items-center max-w-md">
        {phases.map((phase, idx) => {
          const isLast = idx === phases.length - 1;
          const phaseNodes = nodes.filter((n) => n.phaseId === phase.id);
          const status = derivePhaseDisplayStatus(phase.id, nodeRuns, phaseNodes, {
            runStatus,
            isFinalPhase: false,
          });
          const metrics = aggregatePhaseMetrics(phase.id, nodeRuns);
          const loop = isLoopPhase(phase.id, nodeRuns);
          const isHovered = hovered === phase.id;
          const isCurrent = currentPhaseId === phase.id;
          const clickable = metrics.attempts > 0;

          const thisDone = status === 'completed' || status === 'skipped';
          const nextPhase = phases[idx + 1];
          const nextDone = nextPhase
            ? (() => {
                const nextNodes = nodes.filter((n) => n.phaseId === nextPhase.id);
                const ns = derivePhaseDisplayStatus(nextPhase.id, nodeRuns, nextNodes, {
                  runStatus,
                  isFinalPhase: false,
                });
                return ns === 'completed' || ns === 'skipped';
              })()
            : false;

          return (
            <div key={phase.id} className="flex items-center flex-1 min-w-0">
              <div
                className="relative flex flex-col items-center shrink-0"
                onMouseEnter={() => setHovered(phase.id)}
                onMouseLeave={() => setHovered(null)}
              >
                <div
                  className={`
                    flex flex-col items-center gap-0 transition-all duration-200
                    ${clickable ? 'cursor-pointer hover:opacity-75' : 'cursor-default'}
                    ${isCurrent ? 'ring-1 ring-amber-400/60 rounded px-0.5' : ''}
                  `}
                  onClick={() => {
                    if (clickable && onPhaseClick) onPhaseClick(phase.id);
                  }}
                  role={clickable ? 'button' : undefined}
                  style={{ minWidth: 30 }}
                >
                  <span
                    className={`text-[11px] font-bold leading-none ${STATUS_NUM_COLOR[status]}`}
                  >
                    {idx + 1}
                  </span>
                  <span
                    className={`text-[10px] font-medium leading-none mt-0.5 ${STATUS_NUM_COLOR[status]}`}
                  >
                    {phaseAbbrev(phase)}
                  </span>
                  <div className="mt-1 flex items-center justify-center h-3 gap-0.5">
                    {/* Marcador de loop (SPEC 13.7.1): RotateCcw + sufixo rN. */}
                    {loop && (
                      <span
                        className="inline-flex items-center"
                        data-testid={`loop-marker-${phase.id}`}
                      >
                        <RotateCcw
                          size={9}
                          className={
                            status === 'running'
                              ? 'text-amber-400'
                              : STATUS_NUM_COLOR[status]
                          }
                        />
                        {activeRoundIndex !== null && status === 'running' && (
                          <span className="text-[8px] font-mono text-amber-300 ml-0.5">
                            r{activeRoundIndex + 1}
                          </span>
                        )}
                      </span>
                    )}
                    {!loop && <PhaseStatusIcon status={status} />}
                  </div>
                </div>

                {isHovered && (
                  <PhaseTooltip
                    phase={phase}
                    metrics={metrics}
                    status={status}
                    loop={loop}
                    activeRound={activeRoundIndex}
                    totalRounds={totalRounds}
                    align={tooltipAlign(idx, phases.length)}
                  />
                )}
              </div>

              {!isLast && <PhaseConnector completed={thisDone && nextDone} />}
            </div>
          );
        })}

      </div>
    </div>
  );
}


const SPRINT_CHIP_COLOR: Record<WorkflowSprintDisplayStatus, string> = {
  pending: 'border-zinc-700 bg-zinc-900 text-zinc-400',
  running: 'border-amber-500/50 bg-amber-500/10 text-amber-300',
  passed: 'border-green-700/50 bg-green-600/10 text-green-300',
  failed: 'border-red-500/50 bg-red-500/10 text-red-300',
};

function SprintChip({
  chip,
  onDrillDown,
}: {
  chip: WorkflowSprintChip;
  onDrillDown?: (sprintId: string) => void;
}) {
  const label = `Sprint ${chip.index}/${chip.total}${chip.roundLabel ? ` - ${chip.roundLabel}` : ''}`;
  const className = `flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium ${SPRINT_CHIP_COLOR[chip.status]}`;
  if (onDrillDown) {
    return (
      <button
        type="button"
        onClick={() => onDrillDown(chip.sprintId)}
        className={`${className} cursor-pointer transition-colors hover:brightness-125`}
        title={`Sprint atual: ${chip.sprintId} (${chip.status}). Abrir detalhe da sprint.`}
        data-testid="sprint-chip"
      >
        <Layers size={11} className="shrink-0" />
        <span>{label}</span>
        <ChevronRight size={11} className="shrink-0 opacity-70" />
      </button>
    );
  }
  return (
    <span
      className={className}
      title={`Sprint atual: ${chip.sprintId} (${chip.status})`}
      data-testid="sprint-chip"
    >
      <Layers size={11} className="shrink-0" />
      <span>{label}</span>
    </span>
  );
}
