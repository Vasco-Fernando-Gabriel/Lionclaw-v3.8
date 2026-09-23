// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DynamicWorkflowRunView,
  deriveGateViews,
  findPendingOpenedAtMs,
} from '@/components/dynamic-workflow/DynamicWorkflowRunView';
import {
  deriveRecoveryView,
  RecoveryBanner,
  type RecoveryBannerProps,
} from '@/components/dynamic-workflow/RecoveryBanner';
import { useDynamicWorkflowStore } from '@/stores/dynamic-workflow-store';
import { useAppStore } from '@/stores/app-store';
import {
  deriveNodeRunsFromEvents,
  nodeRunFromEventPayload,
  deriveManifestFromNodes,
} from '@/stores/dynamic-workflow-store';
import {
  derivePhaseDisplayStatus,
  deriveRoundsFromNodeRuns,
  deriveSprintGroups,
  deriveCurrentSprintChip,
  isLoopPhase,
  parseRoundIndex,
  aggregatePhaseMetrics,
  tooltipAlign,
  isRunDeliveredTerminal,
  isDeliveryGatePhase,
  selectRenderedPhases,
} from '@/components/dynamic-workflow/WorkflowProgressBar';
import { aggregateRunMetrics } from '@/components/dynamic-workflow/WorkflowMetricsFooter';
import { selectStreamLayout, type WorkflowNodeStreamState } from '@/components/dynamic-workflow/WorkflowStreamView';
import {
  summarizeNodeRuns,
  enforcementForRuntime,
  deriveExecutionGroups,
  formatCostWithConfidence,
  nodeDisplayName,
  shortNodeId,
} from '@/components/dynamic-workflow/DynamicWorkflowNodeTimeline';
import { WorkflowOutputsTab } from '@/components/dynamic-workflow/WorkflowOutputsTab';
import type { TouchedFilesFromEvents } from '@/types/dynamic-workflow-cockpit';
import type { CockpitNodeRun } from '@/types/dynamic-workflow-cockpit';
import {
  deriveTouchedFiles,
  aggregateNodeMetrics,
  deriveRailGroups,
  estimateLiveTokensFromStream,
  deriveSprintState,
} from '@/components/dynamic-workflow/WorkflowCockpitRail';
import type {
  DynamicWorkflowNodeRun,
  DynamicWorkflowNode,
  DynamicWorkflowRun,
  DynamicWorkflowNodeStatus,
  DynamicWorkflowEvent,
  DynamicWorkflowManifestPhase,
} from '@/types';

const handoffMock = vi.hoisted(() => ({
  handoffToOrchestrator: vi.fn(),
}));
vi.mock('@/lib/handoff-to-orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handoff-to-orchestrator')>();
  return {
    ...actual,
    handoffToOrchestrator: handoffMock.handoffToOrchestrator,
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeNodeRun(
  nodeId: string,
  phaseId: string,
  status: DynamicWorkflowNodeStatus,
  patch: Partial<DynamicWorkflowNodeRun> = {},
): DynamicWorkflowNodeRun {
  return {
    id: `${nodeId}#${patch.attempt ?? 0}`,
    runId: 'run-1',
    nodeId,
    phaseId,
    type: 'agent',
    agentId: null,
    status,
    attempt: 0,
    inputHash: null,
    policyHash: null,
    policySnapshotJson: '{}',
    inputJson: '{}',
    outputHash: null,
    outputJson: null,
    error: null,
    failureClass: null,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.01,
    costStatus: 'known',
    tokenStatus: null,
    costUnknownReason: null,
    metricsMetadataJson: '{}',
    model: 'claude-sonnet',
    runtime: 'cloud',
    provider: 'anthropic',
    toolUses: 1,
    apiRequests: 1,
    durationMs: 1000,
    startedAt: null,
    completedAt: null,
    ...patch,
  };
}

function makeNode(nodeId: string, phaseId: string, patch: Partial<DynamicWorkflowNode> = {}): DynamicWorkflowNode {
  return {
    id: `def-node-${nodeId}`,
    definitionId: 'def-1',
    nodeId,
    phaseId,
    sprintId: null,
    roundIndex: null,
    type: 'agent',
    agentId: 'dynamic-workflow-coder',
    label: null,
    access: 'read-only',
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
    ...patch,
  };
}

function makeRun(patch: Partial<DynamicWorkflowRun> = {}): DynamicWorkflowRun {
  return {
    id: 'run-1',
    definitionId: 'def-1',
    chatSessionId: null,
    status: 'running',
    currentPhaseId: 'validate',
    currentNodeId: 'validator-spec-r1',
    workspaceMode: 'run-worktree',
    baseBranch: 'main',
    baseCommitSha: 'abc1234567',
    baseWorktreeHash: null,
    worktreePath: '/tmp/run-1',
    worktreeBranch: 'dynworkflow/run-1',
    deliveredAt: null,
    finalizedAt: null,
    closerSessionId: null,
    closerStatus: null,
    inputJson: '{}',
    outputJson: null,
    checkpointJson: '{}',
    error: null,
    totalCostUsd: 0.42,
    totalDurationMs: 12000,
    createdBy: 'manual',
    startedAt: '2026-06-12T10:00:00.000Z',
    updatedAt: '2026-06-12T10:05:00.000Z',
    completedAt: null,
    ...patch,
  };
}

describe('derivacao fase/rodada a partir de node_runs (SPEC 13.7.6)', () => {
  it('parseRoundIndex extrai o sufixo -rN, ou null', () => {
    expect(parseRoundIndex('validator-spec-r0')).toBe(0);
    expect(parseRoundIndex('fix-r2')).toBe(2);
    expect(parseRoundIndex('scout')).toBeNull();
    expect(parseRoundIndex('coder')).toBeNull();
  });

  it('derivePhaseDisplayStatus: completa quando todos os nodes da fase terminam', () => {
    const runs = [makeNodeRun('scout', 'map', 'completed')];
    expect(derivePhaseDisplayStatus('map', runs)).toBe('completed');
    expect(derivePhaseDisplayStatus('implement', runs)).toBe('pending');
  });

  it('derivePhaseDisplayStatus usa SO a ultima attempt de cada node', () => {
    const runs = [
      makeNodeRun('coder', 'implement', 'failed', { attempt: 0 }),
      makeNodeRun('coder', 'implement', 'completed', { attempt: 1 }),
    ];
    expect(derivePhaseDisplayStatus('implement', runs)).toBe('completed');
  });

  it('isLoopPhase detecta fase de loop pelo sufixo -rN dos node_runs (nao por nome)', () => {
    const runs = [makeNodeRun('validator-spec-r0', 'validate', 'completed'), makeNodeRun('scout', 'map', 'completed')];
    expect(isLoopPhase('validate', runs)).toBe(true);
    expect(isLoopPhase('map', runs)).toBe(false);
  });

  it('REGRESSAO do badge de loop (SPEC 13.7.2): Fix volta para Validar -> Validar running', () => {
    const runs = [
      makeNodeRun('validator-spec-r0', 'validate', 'completed'),
      makeNodeRun('validator-tests-r0', 'validate', 'completed'),
      makeNodeRun('fix-r0', 'fix', 'completed'),
      makeNodeRun('validator-spec-r1', 'validate', 'running'),
      makeNodeRun('validator-tests-r1', 'validate', 'pending'),
    ];
    expect(derivePhaseDisplayStatus('validate', runs)).toBe('running');
    expect(derivePhaseDisplayStatus('fix', runs)).toBe('completed');
  });

  it('deriveRoundsFromNodeRuns agrupa por sufixo -rN e resolve status por rodada', () => {
    const runs = [
      makeNodeRun('validator-spec-r0', 'validate', 'completed'),
      makeNodeRun('validator-tests-r0', 'validate', 'completed'),
      makeNodeRun('fix-r0', 'fix', 'completed'),
      makeNodeRun('validator-spec-r1', 'validate', 'running'),
      makeNodeRun('fix-r1', 'fix', 'pending'),
    ];
    const rounds = deriveRoundsFromNodeRuns(runs);
    expect(rounds.map((r) => r.index)).toEqual([0, 1]);
    expect(rounds[0].status).toBe('passed');
    expect(rounds[1].status).toBe('running');
    expect(rounds[0].nodeIds).toContain('validator-spec-r0');
    expect(rounds[0].nodeIds).toContain('fix-r0');
  });

  it('deriveRoundsFromNodeRuns: rodada com node failed vira failed', () => {
    const runs = [
      makeNodeRun('validator-spec-r0', 'validate', 'failed'),
      makeNodeRun('validator-tests-r0', 'validate', 'completed'),
    ];
    const rounds = deriveRoundsFromNodeRuns(runs);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].status).toBe('failed');
  });

  it('sem node_runs de loop, nao ha rodadas', () => {
    const runs = [makeNodeRun('scout', 'map', 'completed')];
    expect(deriveRoundsFromNodeRuns(runs)).toEqual([]);
  });

  it('aggregatePhaseMetrics soma TODAS as attempts da fase (SPEC 13.7.4)', () => {
    const runs = [
      makeNodeRun('validator-spec-r0', 'validate', 'completed', { costUsd: 0.02 }),
      makeNodeRun('validator-spec-r1', 'validate', 'completed', { costUsd: 0.03 }),
    ];
    const agg = aggregatePhaseMetrics('validate', runs);
    expect(agg.attempts).toBe(2);
    expect(agg.costUsd).toBeCloseTo(0.05, 5);
    expect(agg.inputTokens).toBe(200);
  });

  it('aggregateRunMetrics agrega por node/attempt e conta custo desconhecido', () => {
    const runs = [
      makeNodeRun('scout', 'map', 'completed', { costUsd: 0.01 }),
      makeNodeRun('coder', 'impl', 'completed', {
        costUsd: 0,
        costStatus: 'unknown',
      }),
    ];
    const totals = aggregateRunMetrics(runs);
    expect(totals.inputTokens).toBe(200);
    expect(totals.unknownCostCount).toBe(1);
  });

  it('summarizeNodeRuns conta tentativas e usa o status da ultima', () => {
    const runs = [
      makeNodeRun('coder', 'impl', 'failed', { attempt: 0 }),
      makeNodeRun('coder', 'impl', 'completed', { attempt: 1 }),
    ];
    const s = summarizeNodeRuns('coder', runs);
    expect(s.attempts).toBe(2);
    expect(s.status).toBe('completed');
  });

  it('summarizeNodeRuns surface o runtime da ULTIMA attempt (fonte do enforcement)', () => {
    const runs = [
      makeNodeRun('coder', 'impl', 'failed', { attempt: 0, runtime: 'cloud' }),
      makeNodeRun('coder', 'impl', 'completed', { attempt: 1, runtime: 'codex' }),
    ];
    expect(summarizeNodeRuns('coder', runs).runtime).toBe('codex');
    expect(summarizeNodeRuns('inexistente', runs).runtime).toBeNull();
  });
});

describe('enforcementForRuntime (mecanismo de enforcement por node)', () => {
  it('cloud / zai / minimax-tp -> canUseTool in-process', () => {
    for (const rt of ['cloud', 'zai', 'minimax-tp']) {
      const e = enforcementForRuntime(rt);
      expect(e?.label).toBe('canUseTool (in-process)');
      expect(e?.title).toMatch(/canUseTool/);
    }
  });

  it('codex -> sandbox do CLI', () => {
    const e = enforcementForRuntime('codex');
    expect(e?.label).toBe('sandbox do CLI');
    expect(e?.title).toMatch(/sandbox/i);
  });

  it('kimi -> CLI sem sandbox comprovado', () => {
    const e = enforcementForRuntime('kimi');
    expect(e?.label).toBe('CLI sem sandbox comprovado');
    expect(e?.title).toMatch(/bloqueia|sandbox/i);
  });

  it('grok -> guard + sandbox/profile do Grok CLI', () => {
    const e = enforcementForRuntime('grok');
    expect(e?.label).toBe('guard + sandbox do Grok CLI');
    expect(e?.title).toMatch(/guard.*Grok CLI/i);
  });

  it('local / external -> local', () => {
    expect(enforcementForRuntime('local')?.label).toBe('local');
    expect(enforcementForRuntime('external')?.label).toBe('local');
  });

  it('null ou runtime desconhecido -> sem badge (nada de rotulo enganoso)', () => {
    expect(enforcementForRuntime(null)).toBeNull();
    expect(enforcementForRuntime('marciano')).toBeNull();
  });
});

describe('deriveSprintGroups (sec 9.5, sem regex)', () => {
  it('agrupa por sprintId EXPLICITO depois roundIndex (nao colapsa s0-r0/s1-r0)', () => {
    const nodes = [
      makeNode('coder-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
      makeNode('fix-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
      makeNode('coder-s1-r0', 'Desenvolvimento', { sprintId: 's1', roundIndex: 0 }),
      makeNode('fix-s1-r0', 'Desenvolvimento', { sprintId: 's1', roundIndex: 0 }),
      makeNode('planner-r0', 'Planejamento'),
    ];
    const runs = [
      makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'completed'),
      makeNodeRun('fix-s0-r0', 'Desenvolvimento', 'completed'),
      makeNodeRun('coder-s1-r0', 'Desenvolvimento', 'running'),
    ];
    const groups = deriveSprintGroups(nodes, runs);
    expect(groups.map((g) => g.sprintId)).toEqual(['s0', 's1']);
    expect(groups[0].status).toBe('passed');
    expect(groups[1].status).toBe('running');
    expect(groups[0].rounds.map((r) => r.index)).toEqual([0]);
    expect(groups[0].rounds[0].nodeIds).toContain('coder-s0-r0');
    expect(groups[1].rounds[0].nodeIds).toContain('coder-s1-r0');
    for (const g of groups) {
      expect(g.nodeIds).not.toContain('planner-r0');
    }
  });

  it('agrupa multiplas rodadas DENTRO de uma sprint pelo roundIndex explicito', () => {
    const nodes = [
      makeNode('coder-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
      makeNode('coder-s0-r1', 'Desenvolvimento', { sprintId: 's0', roundIndex: 1 }),
    ];
    const runs = [
      makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'completed'),
      makeNodeRun('coder-s0-r1', 'Desenvolvimento', 'failed'),
    ];
    const groups = deriveSprintGroups(nodes, runs);
    expect(groups).toHaveLength(1);
    expect(groups[0].rounds.map((r) => r.index)).toEqual([0, 1]);
    expect(groups[0].rounds[0].status).toBe('passed');
    expect(groups[0].rounds[1].status).toBe('failed');
    expect(groups[0].status).toBe('failed');
  });

  it('sem metadata de sprint retorna []', () => {
    const nodes = [makeNode('validator-spec-r0', 'validate'), makeNode('fix-r0', 'fix')];
    const runs = [makeNodeRun('validator-spec-r0', 'validate', 'completed')];
    expect(deriveSprintGroups(nodes, runs)).toEqual([]);
  });

  it('node sem roundIndex (legado) cai na rodada 0 da sua sprint', () => {
    const nodes = [makeNode('coder-s0', 'Desenvolvimento', { sprintId: 's0', roundIndex: null })];
    const runs = [makeNodeRun('coder-s0', 'Desenvolvimento', 'running')];
    const groups = deriveSprintGroups(nodes, runs);
    expect(groups).toHaveLength(1);
    expect(groups[0].rounds.map((r) => r.index)).toEqual([0]);
    expect(groups[0].status).toBe('running');
  });
});

describe('deriveCurrentSprintChip (F6 sec 5.2)', () => {
  it('aponta a sprint em curso e a rodada running (Sprint 2/2 - R1)', () => {
    const nodes = [
      makeNode('coder-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
      makeNode('coder-s1-r0', 'Desenvolvimento', { sprintId: 's1', roundIndex: 0 }),
    ];
    const runs = [
      makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'completed'),
      makeNodeRun('coder-s1-r0', 'Desenvolvimento', 'running'),
    ];
    const chip = deriveCurrentSprintChip(nodes, runs);
    expect(chip).not.toBeNull();
    expect(chip?.index).toBe(2);
    expect(chip?.total).toBe(2);
    expect(chip?.roundLabel).toBe('R1');
    expect(chip?.sprintId).toBe('s1');
    expect(chip?.status).toBe('running');
  });

  it('sem sprint em curso, aponta a ultima com rodada iniciada', () => {
    const nodes = [
      makeNode('coder-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
      makeNode('coder-s1-r0', 'Desenvolvimento', { sprintId: 's1', roundIndex: 0 }),
    ];
    const runs = [makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'completed')];
    const chip = deriveCurrentSprintChip(nodes, runs);
    expect(chip?.index).toBe(1);
    expect(chip?.status).toBe('passed');
  });

  it('sem sprints retorna null (run sem fase de loop = sem chip)', () => {
    const nodes = [makeNode('scout', 'map')];
    expect(deriveCurrentSprintChip(nodes, [makeNodeRun('scout', 'map', 'completed')])).toBeNull();
  });
});

describe('tooltipAlign (SM-13: clamp do balao nas bordas)', () => {
  it('uma fase so centraliza', () => {
    expect(tooltipAlign(0, 1)).toBe('center');
  });
  it('primeira fase ancora a esquerda, ultima a direita', () => {
    expect(tooltipAlign(0, 6)).toBe('left');
    expect(tooltipAlign(5, 6)).toBe('right');
  });
  it('fases do miolo centralizam', () => {
    expect(tooltipAlign(3, 8)).toBe('center');
  });
  it('fases proximas das bordas (quartis) ancoram pro lado certo', () => {
    expect(tooltipAlign(1, 8)).toBe('left');
    expect(tooltipAlign(6, 8)).toBe('right');
  });
  it('barra de 2 fases: cada uma ancora numa borda', () => {
    expect(tooltipAlign(0, 2)).toBe('left');
    expect(tooltipAlign(1, 2)).toBe('right');
  });
});

describe('rail agrupado por fase (F6 sec 5.3)', () => {
  it('aggregateNodeMetrics soma tokens/tools/tempo/custo e usa o status da ultima', () => {
    const runs = [
      makeNodeRun('coder', 'impl', 'failed', {
        attempt: 0,
        toolUses: 2,
        durationMs: 500,
        costUsd: 0.01,
        inputTokens: 100,
        outputTokens: 50,
      }),
      makeNodeRun('coder', 'impl', 'completed', {
        attempt: 1,
        toolUses: 3,
        durationMs: 700,
        costUsd: 0.02,
        inputTokens: 200,
        outputTokens: 100,
      }),
    ];
    const m = aggregateNodeMetrics('coder', runs);
    expect(m.status).toBe('completed');
    expect(m.tokens).toBe(450);
    expect(m.toolUses).toBe(5);
    expect(m.durationMs).toBe(1200);
    expect(m.costUsd).toBeCloseTo(0.03, 5);
  });

  it('node sem run vira pending com metricas zeradas', () => {
    const m = aggregateNodeMetrics('ghost', []);
    expect(m).toEqual({
      status: 'pending',
      tokens: 0,
      toolUses: 0,
      durationMs: 0,
      costUsd: 0,
      liveStartedAtMs: null,
    });
  });

  it('agrupa por fase (ordem do manifest) e sub-agrupa o dev por sprint', () => {
    const nodes = [
      makeNode('planner', 'Planejamento'),
      makeNode('coder-s0', 'Desenvolvimento', { sprintId: 's0' }),
      makeNode('fix-s0', 'Desenvolvimento', { sprintId: 's0' }),
      makeNode('coder-s1', 'Desenvolvimento', { sprintId: 's1' }),
    ];
    const manifest = deriveManifestFromNodes(nodes);
    const runs = [
      makeNodeRun('planner', 'Planejamento', 'completed'),
      makeNodeRun('coder-s0', 'Desenvolvimento', 'completed'),
      makeNodeRun('fix-s0', 'Desenvolvimento', 'completed'),
      makeNodeRun('coder-s1', 'Desenvolvimento', 'running'),
    ];
    const groups = deriveRailGroups(nodes, runs, manifest);
    expect(groups.map((g) => g.id)).toEqual([
      'phase:Planejamento',
      'phase:Desenvolvimento:sprint:s0',
      'phase:Desenvolvimento:sprint:s1',
    ]);
    expect(groups[0].sprintId).toBeNull();
    expect(groups[1].sprintId).toBe('s0');
    expect(groups[1].status).toBe('completed');
    expect(groups[2].status).toBe('running');
    expect(groups[1].nodes.map((n) => n.nodeId)).toContain('coder-s0');
  });

  it('deriveSprintState deriva branch deterministica + leitura de merge', () => {
    const run = makeRun({ worktreeBranch: 'dynworkflow/run-1' });
    expect(deriveSprintState(run, 's0', 'completed')).toEqual({
      branch: 'dynworkflow/run-1/s0',
      mergeLabel: 'pronta para merge',
    });
    expect(deriveSprintState(run, 's1', 'running').mergeLabel).toBe('em desenvolvimento');
    expect(deriveSprintState(null, 's0', 'pending').branch).toBeNull();
  });

  it('SM-14: liveStartedAtMs so vem da attempt running (null fora dela)', () => {
    const running = aggregateNodeMetrics('coder', [
      makeNodeRun('coder', 'impl', 'running', {
        attempt: 0,
        startedAt: '2026-06-12T10:00:00.000Z',
      }),
    ]);
    expect(running.liveStartedAtMs).toBe(Date.parse('2026-06-12T10:00:00.000Z'));

    const done = aggregateNodeMetrics('coder', [
      makeNodeRun('coder', 'impl', 'completed', {
        attempt: 0,
        startedAt: '2026-06-12T10:00:00.000Z',
      }),
    ]);
    expect(done.liveStartedAtMs).toBeNull();

    const noStart = aggregateNodeMetrics('coder', [
      makeNodeRun('coder', 'impl', 'running', { attempt: 0, startedAt: null }),
    ]);
    expect(noStart.liveStartedAtMs).toBeNull();
  });

  it('SM-14: estimateLiveTokensFromStream estima ~chars/4 do texto acumulado', () => {
    expect(estimateLiveTokensFromStream(undefined)).toBe(0);
    expect(
      estimateLiveTokensFromStream({
        nodeId: 'coder',
        label: 'coder',
        status: 'running',
        text: 'x'.repeat(40),
        toolCalls: [],
        timeline: [],
        isStreaming: true,
      }),
    ).toBe(10);
  });

  it('SM-14: deriveRailGroups so estima liveTokens para node RUNNING', () => {
    const nodes = [makeNode('coder', 'impl'), makeNode('val', 'validate')];
    const runs = [
      makeNodeRun('coder', 'impl', 'running', {
        attempt: 0,
        inputTokens: 0,
        outputTokens: 0,
        startedAt: '2026-06-12T10:00:00.000Z',
      }),
      makeNodeRun('val', 'validate', 'completed', { attempt: 0 }),
    ];
    const streams: Record<string, WorkflowNodeStreamState> = {
      coder: {
        nodeId: 'coder',
        label: 'coder',
        status: 'running',
        text: 'a'.repeat(80),
        toolCalls: [],
        timeline: [],
        isStreaming: true,
      },
      val: {
        nodeId: 'val',
        label: 'val',
        status: 'completed',
        text: 'b'.repeat(80),
        toolCalls: [],
        timeline: [],
        isStreaming: false,
      },
    };
    const groups = deriveRailGroups(nodes, runs, null, streams);
    const flat = groups.flatMap((g) => g.nodes);
    const coder = flat.find((n) => n.nodeId === 'coder');
    const val = flat.find((n) => n.nodeId === 'val');
    expect(coder?.liveTokens).toBe(20);
    expect(val?.liveTokens).toBe(0);
  });
});

describe('deriveNodeRunsFromEvents (eventos -> node_runs)', () => {
  it('extrai node_run de payload valido e ignora payload sem forma', () => {
    const ok = nodeRunFromEventPayload('run-1', {
      nodeId: 'scout',
      attempt: 0,
      status: 'running',
      phaseId: 'map',
    });
    expect(ok).not.toBeNull();
    expect(ok?.nodeId).toBe('scout');
    expect(nodeRunFromEventPayload('run-1', { foo: 'bar' })).toBeNull();
    expect(nodeRunFromEventPayload('run-1', { nodeId: 'x', attempt: 'no', status: 'running' })).toBeNull();
    expect(nodeRunFromEventPayload('run-1', { nodeId: 'x', attempt: 0, status: 'bogus' })).toBeNull();
  });

  it('reduz eventos para o ULTIMO node_run por nodeId+attempt', () => {
    const events = [
      {
        id: 1,
        runId: 'run-1',
        nodeId: 'scout',
        phaseId: 'map',
        seq: 1,
        type: 'node-started',
        payloadJson: JSON.stringify({ nodeId: 'scout', attempt: 0, status: 'running', phaseId: 'map' }),
        createdAt: '',
      },
      {
        id: 2,
        runId: 'run-1',
        nodeId: 'scout',
        phaseId: 'map',
        seq: 2,
        type: 'node-finished',
        payloadJson: JSON.stringify({
          nodeId: 'scout',
          attempt: 0,
          status: 'completed',
          phaseId: 'map',
          costUsd: 0.02,
        }),
        createdAt: '',
      },
      {
        id: 3,
        runId: 'run-1',
        nodeId: null,
        phaseId: null,
        seq: 3,
        type: 'gate-pending',
        payloadJson: JSON.stringify({ gate: 'final' }),
        createdAt: '',
      },
    ];
    const runs = deriveNodeRunsFromEvents('run-1', events);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].costUsd).toBeCloseTo(0.02, 5);
  });
});

describe('selectStreamLayout (SPEC 13.5 / AC-8)', () => {
  function streamState(nodeId: string, isStreaming: boolean): WorkflowNodeStreamState {
    return { nodeId, label: nodeId, status: 'running', text: 't', toolCalls: [], timeline: [], isStreaming };
  }

  it('2+ nodes do grupo paralelo -> modo parallel', () => {
    const nodes = [streamState('validator-spec-r0', true), streamState('validator-tests-r0', true)];
    const layout = selectStreamLayout(nodes, ['validator-spec-r0', 'validator-tests-r0']);
    expect(layout.mode).toBe('parallel');
    if (layout.mode === 'parallel') expect(layout.nodes).toHaveLength(2);
  });

  it('grupo com 1 node -> modo single (pega o streaming ativo)', () => {
    const nodes = [streamState('coder', false), streamState('validator-spec-r0', true)];
    const layout = selectStreamLayout(nodes, ['validator-spec-r0']);
    expect(layout.mode).toBe('single');
    if (layout.mode === 'single') expect(layout.node?.nodeId).toBe('validator-spec-r0');
  });

  it('sem nodes -> single com node null', () => {
    const layout = selectStreamLayout([], []);
    expect(layout.mode).toBe('single');
    if (layout.mode === 'single') expect(layout.node).toBeNull();
  });
});

describe('deriveManifestFromNodes (topologia da barra)', () => {
  it('reconstroi fases na ordem da primeira aparicao do phaseId', () => {
    const nodes = [
      makeNode('scout', 'map'),
      makeNode('coder', 'implement'),
      makeNode('validator-spec-r0', 'validate'),
      makeNode('fix-r0', 'fix'),
      makeNode('validator-spec-r1', 'validate'), // repetido -> nao duplica
    ];
    const manifest = deriveManifestFromNodes(nodes);
    expect(manifest?.phases.map((p) => p.id)).toEqual(['map', 'implement', 'validate', 'fix']);
    expect(manifest?.phases.map((p) => p.order)).toEqual([0, 1, 2, 3]);
  });

  it('lista vazia -> null', () => {
    expect(deriveManifestFromNodes([])).toBeNull();
  });
});

describe('DynamicWorkflowRunView render (layout F6)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  function seedStore(): void {
    const nodes = [
      makeNode('scout', 'map'),
      makeNode('coder', 'implement', {
        access: 'workspace-write',
        writeSetJson: JSON.stringify(['src/**']),
        allowedToolsJson: JSON.stringify(['Write', 'Edit']),
      }),
      makeNode('validator-spec-r0', 'validate', {
        allowedMcpJson: JSON.stringify(['knowledge-base']),
      }),
      makeNode('validator-tests-r0', 'validate'),
      makeNode('fix-r0', 'fix', { access: 'workspace-write' }),
      makeNode('validator-spec-r1', 'validate'),
      makeNode('gate-global', 'deliver', { type: 'gate' }),
    ];
    const nodeRuns = [
      makeNodeRun('scout', 'map', 'completed'),
      makeNodeRun('coder', 'implement', 'completed'),
      makeNodeRun('validator-spec-r0', 'validate', 'completed', { attempt: 0 }),
      makeNodeRun('validator-tests-r0', 'validate', 'completed', { attempt: 0 }),
      makeNodeRun('fix-r0', 'fix', 'completed', { attempt: 0 }),
      makeNodeRun('validator-spec-r1', 'validate', 'running', { attempt: 0 }),
      makeNodeRun('validator-tests-r1', 'validate', 'running', { attempt: 0 }),
    ];
    useDynamicWorkflowStore.setState({
      selectedRunId: 'run-1',
      selectedRun: makeRun(),
      nodes,
      nodeRuns,
      manifest: deriveManifestFromNodes(nodes),
      events: [],
      artifacts: [
        {
          id: 'a1',
          runId: 'run-1',
          nodeId: 'coder',
          kind: 'delivery',
          path: '/tmp/run-1/delivery.md',
          sha256: 'deadbeefcafe',
          metadataJson: '{}',
          createdAt: '',
        },
      ],
      snapshot: null,
      nodeStreams: {
        'validator-spec-r1': {
          nodeId: 'validator-spec-r1',
          label: 'validator-spec-r1',
          status: 'running',
          text: 'analisando...',
          toolCalls: [],
          timeline: [],
          isStreaming: true,
        },
        'validator-tests-r1': {
          nodeId: 'validator-tests-r1',
          label: 'validator-tests-r1',
          status: 'running',
          text: 'rodando testes...',
          toolCalls: [],
          timeline: [],
          isStreaming: true,
        },
      },
      selectedRoundIndex: null,
      closerThread: [],
      maestroThread: [],
      maestroBusyRunIds: new Set(),
      closerBusyRunIds: new Set(),
      narrationByRun: {},
      persistedNarrationByRun: {},
      gateDecisionsByRun: {},
      stalledByRun: {},
      streamingRunIds: new Set(['run-1']),
      awaitingUserRunIds: new Set(),
      pendingQuestion: null,
      error: null,
    });
  }

  function mount(): void {
    root = createRoot(container);
    act(() => {
      root?.render(<DynamicWorkflowRunView runId="run-1" />);
    });
  }

  function unmount(): void {
    const r = root;
    if (r) {
      act(() => {
        r.unmount();
      });
      root = null;
    }
  }

  function clickTab(label: string): void {
    const buttons = Array.from(container.querySelectorAll('button'));
    const tab = buttons.find((b) => b.textContent?.trim() === label);
    act(() => {
      tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    if (typeof Element.prototype.scrollIntoView !== 'function') {
      Element.prototype.scrollIntoView = function scrollIntoViewStub(): void {};
    }
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (window as unknown as Record<string, unknown>).lionclaw = {
      dynamicWorkflow: {
        approveGate: vi.fn(async () => ({ ok: true })),
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
      shell: { showInFolder: vi.fn(async () => undefined) },
    };
    seedStore();
  });

  afterEach(() => {
    unmount();
    container.remove();
    consoleErrorSpy.mockRestore();
  });

  it('renderiza o run em loop sem warning de key/hook (cockpit puro, E6.3)', () => {
    mount();
    expect(container.textContent).toContain('validate');
    expect(container.querySelector('[data-testid="run-cockpit"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="maestro-chat"]')).toBeNull();
    expect(container.querySelector('[data-testid="maestro-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-feed"]')).toBeNull();
    expect(container.textContent).toContain('rodando');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('TOPO declutter: barra de fase removida (sem chip de sprint nem grid no topo)', () => {
    const devNodes = [
      makeNode('coder-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
      makeNode('fix-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
      makeNode('coder-s1-r0', 'Desenvolvimento', { sprintId: 's1', roundIndex: 0 }),
    ];
    useDynamicWorkflowStore.setState({
      selectedRunId: 'run-1',
      selectedRun: makeRun({ currentPhaseId: 'Desenvolvimento', currentNodeId: 'coder-s0-r0' }),
      nodes: devNodes,
      nodeRuns: [
        makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'running'),
        makeNodeRun('fix-s0-r0', 'Desenvolvimento', 'pending'),
      ],
      manifest: deriveManifestFromNodes(devNodes),
      events: [],
      artifacts: [],
      snapshot: null,
      nodeStreams: {},
      selectedRoundIndex: null,
      closerThread: [],
      maestroThread: [],
      maestroBusyRunIds: new Set(),
      closerBusyRunIds: new Set(),
      narrationByRun: {},
      stalledByRun: {},
      streamingRunIds: new Set(['run-1']),
      awaitingUserRunIds: new Set(),
      error: null,
    });
    mount();
    expect(container.querySelector('[data-testid="sprint-chip"]')).toBeNull();
    expect(container.querySelector('[data-testid="sprint-group-s0"]')).toBeNull();
    expect(container.querySelector('[data-testid="sprint-group-s1"]')).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('RAIL agrupado por fase: grupos por fase/sprint + estado por sprint', () => {
    const devNodes = [makeNode('planner', 'Planejamento'), makeNode('coder-s0', 'Desenvolvimento', { sprintId: 's0' })];
    useDynamicWorkflowStore.setState({
      selectedRunId: 'run-1',
      selectedRun: makeRun({ currentPhaseId: 'Desenvolvimento', worktreeBranch: 'dynworkflow/run-1' }),
      nodes: devNodes,
      nodeRuns: [
        makeNodeRun('planner', 'Planejamento', 'completed'),
        makeNodeRun('coder-s0', 'Desenvolvimento', 'running'),
      ],
      manifest: deriveManifestFromNodes(devNodes),
      events: [],
      artifacts: [],
      snapshot: null,
      nodeStreams: {},
      selectedRoundIndex: null,
      closerThread: [],
      maestroThread: [],
      maestroBusyRunIds: new Set(),
      closerBusyRunIds: new Set(),
      narrationByRun: {},
      stalledByRun: {},
      streamingRunIds: new Set(['run-1']),
      awaitingUserRunIds: new Set(),
      error: null,
    });
    mount();
    expect(container.querySelector('[data-testid="rail-group-phase:Planejamento"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="rail-group-phase:Desenvolvimento:sprint:s0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="rail-sprint-state"]')).not.toBeNull();
    expect(container.textContent).toContain('dynworkflow/run-1/s0');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('E6.1/T11: cockpit re-hidrata a narracao do DB quando o feed AO VIVO esta vazio', () => {
    useDynamicWorkflowStore.setState({
      narrationByRun: {}, // feed ao vivo vazio (run reaberto)
      persistedNarrationByRun: { 'run-1': ['planejamento concluido (do DB)'] },
    });
    mount();
    expect(container.querySelector('[data-testid="narration-feed"]')).not.toBeNull();
    expect(container.textContent).toContain('planejamento concluido (do DB)');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('E6.1/T11: o feed AO VIVO tem precedencia sobre o persistido quando ha', () => {
    useDynamicWorkflowStore.setState({
      narrationByRun: { 'run-1': ['linha ao vivo'] },
      persistedNarrationByRun: { 'run-1': ['linha do DB'] },
    });
    mount();
    expect(container.textContent).toContain('linha ao vivo');
    expect(container.textContent).not.toContain('linha do DB');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('E6.1: cockpit espelha as decisoes de gate do driver (sem ir ao chat principal)', () => {
    useDynamicWorkflowStore.setState({
      gateDecisionsByRun: {
        'run-1': [
          {
            id: 'gate-dec-2',
            gateId: 'gate-plan-review-orchestrator',
            decision: 'approved',
            decidedBy: 'orchestrator',
            at: '2026-06-12T10:01:00.000Z',
          },
        ],
      },
    });
    mount();
    const block = container.querySelector('[data-testid="cockpit-gate-decisions"]');
    expect(block).not.toBeNull();
    expect(
      container.querySelector('[data-testid="cockpit-gate-decision-gate-plan-review-orchestrator"]'),
    ).not.toBeNull();
    expect(block?.textContent).toContain('orchestrator');
    expect(block?.textContent).toContain('approved');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('E6.2: o banner da pergunta tem REPLY INLINE e a copy nao aponta para o composer', () => {
    useDynamicWorkflowStore.setState({
      pendingQuestion: { nodeId: 'coder', prompt: 'Qual porta usar?' },
    });
    mount();
    const banner = container.querySelector('[data-testid="question-pending-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.querySelector('[data-testid="question-reply-input"]')).not.toBeNull();
    expect(banner?.querySelector('[data-testid="question-reply-send"]')).not.toBeNull();
    expect(banner?.textContent).not.toContain('Responda no campo abaixo');
    expect(banner?.textContent).toContain('Responda aqui mesmo');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('E6.2: enviar o reply inline roteia por send-message SEM o marcador (runner.intervene) e limpa o campo', async () => {
    useDynamicWorkflowStore.setState({
      pendingQuestion: { nodeId: 'coder', prompt: 'Qual porta usar?' },
    });
    mount();
    const input = container.querySelector('[data-testid="question-reply-input"]') as HTMLTextAreaElement;
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, 'use a porta 8080');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const sendBtn = container.querySelector('[data-testid="question-reply-send"]') as HTMLButtonElement;
    await act(async () => {
      sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const ipc = (window as unknown as Record<string, { dynamicWorkflow: { sendMessage: ReturnType<typeof vi.fn> } }>)
      .lionclaw;
    expect(ipc.dynamicWorkflow.sendMessage).toHaveBeenCalledWith('run-1', 'use a porta 8080');
    expect(ipc.dynamicWorkflow.sendMessage).not.toHaveBeenCalledWith('run-1', 'use a porta 8080', [
      '__lionclaw_maestro_chat__',
    ]);
    const inputAfter = container.querySelector('[data-testid="question-reply-input"]') as HTMLTextAreaElement;
    expect(inputAfter.value).toBe('');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('E6.2: reply inline preserva o texto quando o envio falha', async () => {
    useDynamicWorkflowStore.setState({
      pendingQuestion: { nodeId: 'coder', prompt: 'Qual porta usar?' },
    });
    const ipc = (window as unknown as Record<string, { dynamicWorkflow: { sendMessage: ReturnType<typeof vi.fn> } }>)
      .lionclaw;
    ipc.dynamicWorkflow.sendMessage.mockResolvedValueOnce({ error: 'run nao encontrado' });
    mount();
    const input = container.querySelector('[data-testid="question-reply-input"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, 'texto que deve sobreviver');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const sendBtn = container.querySelector('[data-testid="question-reply-send"]') as HTMLButtonElement;
    await act(async () => {
      sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const inputAfter = container.querySelector('[data-testid="question-reply-input"]') as HTMLTextAreaElement;
    expect(inputAfter.value).toBe('texto que deve sobreviver');
    expect(useDynamicWorkflowStore.getState().error).toBe('run nao encontrado');
  });

  it('aba secundaria lazy Custo lista node/attempt e marca custo desconhecido', () => {
    useDynamicWorkflowStore.setState({
      nodeRuns: [makeNodeRun('scout', 'map', 'completed', { costStatus: 'unknown', costUsd: 0 })],
    });
    mount();
    clickTab('Custo');
    expect(container.textContent).toContain('scout');
    expect(container.textContent).toContain('?');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('aba secundaria lazy Linha do tempo monta a timeline de eventos', () => {
    mount();
    expect(container.querySelector('[data-testid="event-timeline"]')).toBeNull();
    clickTab('Linha do tempo');
    expect(container.querySelector('[data-testid="event-timeline"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="timeline-feed"]')).not.toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

describe('deriveGateViews (Inc3, funcao pura)', () => {
  function blockedEv(seq: number, payload: object): DynamicWorkflowEvent {
    return {
      id: seq,
      runId: 'r',
      nodeId: null,
      phaseId: null,
      seq,
      type: 'gate-blocked',
      payloadJson: JSON.stringify(payload),
      createdAt: 'now',
    } as DynamicWorkflowEvent;
  }

  it('mapeia o ULTIMO gate-blocked do gate aberto (todos ok -> sem findings)', () => {
    const events = [
      blockedEv(1, {
        gateId: 'final',
        checks: [{ id: 'typecheck', label: 'Typecheck', ok: false }],
      }),
      blockedEv(2, {
        gateId: 'final',
        checks: [
          { id: 'typecheck', label: 'Typecheck', ok: true, detail: '0 erros' },
          { id: 'tests', label: 'Tests', ok: true },
        ],
      }),
    ];
    const { gateChecks, gateFindings } = deriveGateViews(events, 'final');
    expect(gateChecks).toHaveLength(2);
    expect(gateChecks.every((c) => c.ok)).toBe(true);
    expect(gateFindings).toHaveLength(0);
  });

  it('check ok:false vira check (ok=false) E finding estruturado', () => {
    const events = [
      blockedEv(1, {
        gateId: 'final',
        checks: [
          { id: 'typecheck', label: 'Typecheck', ok: true, detail: '0 erros novos' },
          {
            id: 'tests',
            label: 'Tests',
            ok: false,
            severity: 'P1',
            where: 'foo.test.ts',
            problem: '2 testes vermelhos',
            fix: 'corrija o reducer',
          },
        ],
      }),
    ];
    const { gateChecks, gateFindings } = deriveGateViews(events, 'final');
    expect(gateChecks.find((c) => c.id === 'typecheck')?.ok).toBe(true);
    expect(gateChecks.find((c) => c.id === 'tests')?.ok).toBe(false);
    expect(gateFindings).toHaveLength(1);
    expect(gateFindings[0]).toMatchObject({
      severity: 'P1',
      where: 'foo.test.ts',
      problem: '2 testes vermelhos',
      fix: 'corrija o reducer',
    });
  });

  it('ignora gate-blocked de gate diferente; sem gate-blocked retorna vazio', () => {
    const events = [blockedEv(1, { gateId: 'outro', checks: [{ id: 'x', ok: true }] })];
    expect(deriveGateViews(events, 'final')).toEqual({ gateChecks: [], gateFindings: [] });
    expect(deriveGateViews([], 'final')).toEqual({ gateChecks: [], gateFindings: [] });
  });
});

describe('deriveTouchedFiles (Inc1c, funcao pura)', () => {
  function ns(nodeId: string, toolCalls: { toolName: string; detail?: string }[]): WorkflowNodeStreamState {
    return { nodeId, label: nodeId, status: 'running', text: '', toolCalls, timeline: [], isStreaming: true };
  }

  it('extrai paths dos tool_call de escrita, unicos e ordenados', () => {
    const streams: Record<string, WorkflowNodeStreamState> = {
      a: ns('a', [
        { toolName: 'Write', detail: 'src/b.ts' },
        { toolName: 'Edit', detail: 'src/a.ts' },
        { toolName: 'Read', detail: 'src/z.ts' }, // leitura: ignorado
      ]),
      b: ns('b', [
        { toolName: 'MultiEdit', detail: 'src/a.ts' }, // duplicado: dedup
        { toolName: 'Bash', detail: 'npm test' }, // nao-escrita: ignorado
      ]),
    };
    expect(deriveTouchedFiles(streams)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('ignora tool_call de escrita sem detail e retorna vazio sem streams', () => {
    expect(deriveTouchedFiles({ a: ns('a', [{ toolName: 'Write' }]) })).toEqual([]);
    expect(deriveTouchedFiles({})).toEqual([]);
  });
});

describe('findPendingOpenedAtMs (Inc6, funcao pura)', () => {
  function ev(seq: number, type: string, at: string): DynamicWorkflowEvent {
    return {
      id: seq,
      runId: 'r',
      nodeId: null,
      phaseId: null,
      seq,
      type,
      payloadJson: '{}',
      createdAt: at,
    } as DynamicWorkflowEvent;
  }

  it('retorna o ms do ULTIMO evento que casa o predicado', () => {
    const events = [
      ev(1, 'gate-pending', '2026-06-13T00:00:00.000Z'),
      ev(2, 'node-started', '2026-06-13T00:01:00.000Z'),
      ev(3, 'gate-pending', '2026-06-13T00:02:00.000Z'),
    ];
    const ms = findPendingOpenedAtMs(events, (t) => t.includes('gate') && t.includes('pending'));
    expect(ms).toBe(Date.parse('2026-06-13T00:02:00.000Z'));
  });

  it('sem evento casado retorna null', () => {
    const events = [ev(1, 'node-started', '2026-06-13T00:00:00.000Z')];
    expect(findPendingOpenedAtMs(events, (t) => t.includes('question'))).toBeNull();
  });
});

describe('deriveRecoveryView: stall (Inc5)', () => {
  it('paused COM stall registrado vira cenario stall com o motivo', () => {
    const run = makeRun({ status: 'paused', currentNodeId: 'coder' });
    const view = deriveRecoveryView(run, null, { message: 'sem progresso ha 3min', at: 'now' });
    expect(view.scenario).toBe('stall');
    expect(view.reason).toBe('sem progresso ha 3min');
    expect(view.nodeId).toBe('coder');
  });

  it('paused SEM stall segue none (pausa do usuario nao e friccao)', () => {
    const run = makeRun({ status: 'paused' });
    expect(deriveRecoveryView(run, null, null).scenario).toBe('none');
  });

  it('stall stale e ignorado quando o run ja voltou a running', () => {
    const run = makeRun({ status: 'running' });
    expect(deriveRecoveryView(run, null, { message: 'x', at: 'now' }).scenario).toBe('none');
  });
});

describe('RecoveryBanner: cenario failed e recuperavel (SM-51)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    const r = root;
    if (r) {
      act(() => {
        r.unmount();
      });
      root = null;
    }
    container.remove();
  });

  function mount(props: Partial<RecoveryBannerProps> & { run: DynamicWorkflowRun }): {
    onReopen: ReturnType<typeof vi.fn>;
    onResetNode: ReturnType<typeof vi.fn>;
    onResume: ReturnType<typeof vi.fn>;
  } {
    const onReopen = vi.fn();
    const onResetNode = vi.fn();
    const onResume = vi.fn();
    root = createRoot(container);
    act(() => {
      root?.render(
        <RecoveryBanner
          snapshot={null}
          scheduledResumeAt={null}
          onResume={onResume}
          onReopen={onReopen}
          onScheduleResume={vi.fn()}
          onAbort={vi.fn()}
          onResolveWithCloser={vi.fn()}
          onSwitchAgent={vi.fn()}
          onResetNode={onResetNode}
          {...props}
        />,
      );
    });
    return { onReopen, onResetNode, onResume };
  }

  function buttonByLabel(label: string): HTMLButtonElement | null {
    return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) ?? null;
  }

  it('deriveRecoveryView do failed traz o motivo com Retomar como acao primaria', () => {
    const run = makeRun({ status: 'failed', error: null, currentNodeId: null });
    const view = deriveRecoveryView(run, null, null);
    expect(view.scenario).toBe('failed');
    expect(view.reason.toLowerCase()).toContain('retomar');
  });

  it('pendingDecision provider com failureClass logic vira node-failed (NAO "Limite do provedor")', () => {
    const run = makeRun({
      status: 'blocked',
      currentNodeId: 'coder-s1-r2',
      inputJson: JSON.stringify({
        pendingDecision: {
          type: 'provider',
          failureClass: 'logic',
          nodeId: 'coder-s1-r2',
          prompt: 'Limite do provedor persistiu apos as tentativas automaticas.',
        },
      }),
    });
    const view = deriveRecoveryView(run, null, null);
    expect(view.scenario).toBe('node-failed');
    expect(view.title).toBe('Falha no node');
    expect(view.title).not.toBe('Limite do provedor');
    expect(view.nodeId).toBe('coder-s1-r2');
    expect(view.reason).not.toContain('Limite do provedor');
    expect(view.reason).toContain('logic');
  });

  it('node-failed surfacea o erro REAL do node (nodeError) no reason', () => {
    const run = makeRun({
      status: 'blocked',
      currentNodeId: 'coder-s0-r0',
      inputJson: JSON.stringify({
        pendingDecision: {
          type: 'provider',
          failureClass: 'logic',
          nodeId: 'coder-s0-r0',
          prompt: 'Limite do provedor persistiu apos as tentativas automaticas.',
          nodeError: 'Claude Code process aborted by user',
        },
      }),
    });
    const view = deriveRecoveryView(run, null, null);
    expect(view.scenario).toBe('node-failed');
    expect(view.reason).toContain('Erro do node: Claude Code process aborted by user');
  });

  it('node-failed sem nodeError NAO quebra (reason so com a classe)', () => {
    const run = makeRun({
      status: 'blocked',
      currentNodeId: 'coder-s0-r0',
      inputJson: JSON.stringify({
        pendingDecision: { type: 'provider', failureClass: 'logic', nodeId: 'coder-s0-r0' },
      }),
    });
    const view = deriveRecoveryView(run, null, null);
    expect(view.scenario).toBe('node-failed');
    expect(view.reason).not.toContain('Erro do node:');
  });

  it('pendingDecision provider com failureClass provider-limit REAL segue "Limite do provedor"', () => {
    const run = makeRun({
      status: 'blocked',
      currentNodeId: 'coder-s1-r2',
      inputJson: JSON.stringify({
        pendingDecision: { type: 'provider', failureClass: 'provider-limit', nodeId: 'coder-s1-r2' },
      }),
    });
    const view = deriveRecoveryView(run, null, null);
    expect(view.scenario).toBe('provider-limit');
    expect(view.title).toBe('Limite do provedor');
  });

  it('banner do failed mostra Retomar (reopen) e dispara onReopen', () => {
    const run = makeRun({ status: 'failed', currentNodeId: null });
    const { onReopen } = mount({ run });
    const banner = container.querySelector('[data-testid="recovery-banner"]');
    expect(banner?.getAttribute('data-scenario')).toBe('failed');
    const retomar = buttonByLabel('Retomar');
    expect(retomar).not.toBeNull();
    act(() => {
      retomar?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  it('banner do failed NAO mostra o botao morto "Resetar node/rodada" (mesmo com nodeId)', () => {
    const run = makeRun({ status: 'failed', currentNodeId: 'coder' });
    mount({ run });
    expect(buttonByLabel('Resetar node/rodada')).toBeNull();
    expect(buttonByLabel('Resolver com agente')).not.toBeNull();
    expect(buttonByLabel('Abortar')).not.toBeNull();
  });

  it('interrupted COM nodeId ainda mostra "Resetar node/rodada" (node vivo)', () => {
    const run = makeRun({ status: 'interrupted', currentNodeId: 'coder' });
    const { onResetNode } = mount({ run });
    const reset = buttonByLabel('Resetar node/rodada');
    expect(reset).not.toBeNull();
    act(() => {
      reset?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onResetNode).toHaveBeenCalledWith('coder');
  });
});

describe('RunView liveness render (Inc1 placeholder + Inc7 narrador)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  function mount(): void {
    root = createRoot(container);
    act(() => {
      root?.render(<DynamicWorkflowRunView runId="run-1" />);
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    if (typeof Element.prototype.scrollIntoView !== 'function') {
      Element.prototype.scrollIntoView = function stub(): void {};
    }
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (window as unknown as Record<string, unknown>).lionclaw = {
      dynamicWorkflow: {
        approveGate: vi.fn(async () => ({ ok: true })),
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
      shell: { showInFolder: vi.fn(async () => undefined) },
    };
  });

  afterEach(() => {
    const r = root;
    if (r) {
      act(() => {
        r.unmount();
      });
      root = null;
    }
    container.remove();
    consoleErrorSpy.mockRestore();
  });

  it('Inc1: node running SEM stream mostra placeholder ativo na aba Stream', () => {
    const nodes = [makeNode('coder', 'implement')];
    useDynamicWorkflowStore.setState({
      selectedRunId: 'run-1',
      selectedRun: makeRun({ currentPhaseId: 'implement', currentNodeId: 'coder' }),
      nodes,
      nodeRuns: [makeNodeRun('coder', 'implement', 'running')],
      manifest: deriveManifestFromNodes(nodes),
      events: [],
      artifacts: [],
      snapshot: null,
      nodeStreams: {},
      selectedRoundIndex: null,
      closerThread: [],
      maestroThread: [],
      maestroBusyRunIds: new Set(),
      closerBusyRunIds: new Set(),
      narrationByRun: {},
      stalledByRun: {},
      streamingRunIds: new Set(['run-1']),
      awaitingUserRunIds: new Set(),
      error: null,
    });
    mount();
    const placeholder = container.querySelector('[data-testid="stream-pending-placeholder"]');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.textContent).toContain('aguardando o agente');
    expect(placeholder?.textContent).toContain('coder');
    expect(container.textContent).not.toContain('Sem stream ativo');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('Inc7: narracao do run aparece no painel "O que esta acontecendo" do rail', () => {
    const nodes = [makeNode('coder', 'implement')];
    useDynamicWorkflowStore.setState({
      selectedRunId: 'run-1',
      selectedRun: makeRun({ currentPhaseId: 'implement' }),
      nodes,
      nodeRuns: [makeNodeRun('coder', 'implement', 'running')],
      manifest: deriveManifestFromNodes(nodes),
      events: [],
      artifacts: [],
      snapshot: null,
      nodeStreams: {},
      selectedRoundIndex: null,
      closerThread: [],
      maestroThread: [],
      maestroBusyRunIds: new Set(),
      closerBusyRunIds: new Set(),
      narrationByRun: { 'run-1': ['o coder esta escrevendo o reducer', 'rodando os testes agora'] },
      stalledByRun: {},
      streamingRunIds: new Set(['run-1']),
      awaitingUserRunIds: new Set(),
      error: null,
    });
    mount();
    expect(container.textContent).toContain('O que esta acontecendo');
    const feed = container.querySelector('[data-testid="narration-feed"]');
    expect(feed).not.toBeNull();
    expect(feed?.textContent).toContain('o coder esta escrevendo o reducer');
    expect(feed?.textContent).toContain('rodando os testes agora');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

describe('SM-33: orfaos pre-expandidos nao contaminam status de fase/sprint', () => {
  function makeSprintNodes(sprintIdx: number, maxRounds: number): DynamicWorkflowNode[] {
    const out: DynamicWorkflowNode[] = [];
    for (let r = 0; r < maxRounds; r++) {
      out.push(makeNode(`coder-s${sprintIdx}-r${r}`, 'Desenvolvimento', { sprintId: `s${sprintIdx}`, roundIndex: r }));
      out.push(makeNode(`fix-s${sprintIdx}-r${r}`, 'Desenvolvimento', { sprintId: `s${sprintIdx}`, roundIndex: r }));
    }
    return out;
  }

  it('deriveSprintGroups: sprint convergida no r0 mostra "passed", nao "running"', () => {
    const nodes = makeSprintNodes(0, 3);
    const runs = [
      makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'completed'),
      makeNodeRun('fix-s0-r0', 'Desenvolvimento', 'completed'),
    ];
    const groups = deriveSprintGroups(nodes, runs);
    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe('passed');
    expect(groups[0].rounds[0].status).toBe('passed');
    expect(groups[0].rounds[1].status).toBe('passed');
    expect(groups[0].rounds[2].status).toBe('passed');
    expect(groups[0].status).not.toBe('running');
  });

  it('deriveSprintGroups: sprint em curso (r0 running) continua "running"', () => {
    const nodes = makeSprintNodes(0, 3);
    const runs = [makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'running')];
    const groups = deriveSprintGroups(nodes, runs);
    expect(groups[0].status).toBe('running');
  });

  it('deriveSprintGroups: sprint totalmente pendente (sem node_run) continua "pending"', () => {
    const nodes = makeSprintNodes(0, 3);
    const groups = deriveSprintGroups(nodes, []);
    expect(groups[0].status).toBe('pending');
  });

  it('deriveSprintGroups: 2 sprints - s0 convergida, s1 running', () => {
    const nodes = [
      ...makeSprintNodes(0, 3), // s0 pre-expandida com 3 rodadas
      ...makeSprintNodes(1, 3), // s1 pre-expandida com 3 rodadas
    ];
    const runs = [
      makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'completed'),
      makeNodeRun('fix-s0-r0', 'Desenvolvimento', 'completed'),
      makeNodeRun('coder-s1-r0', 'Desenvolvimento', 'running'),
    ];
    const groups = deriveSprintGroups(nodes, runs);
    expect(groups).toHaveLength(2);
    expect(groups[0].sprintId).toBe('s0');
    expect(groups[0].status).toBe('passed');
    expect(groups[1].sprintId).toBe('s1');
    expect(groups[1].status).toBe('running');
  });

  it('derivePhaseDisplayStatus: fase com orfaos pre-expandidos mostra "completed"', () => {
    const phaseNodes = [
      makeNode('validator-r0', 'validate', { phaseId: 'validate' }),
      makeNode('fix-r0', 'validate', { phaseId: 'validate' }),
      makeNode('validator-r1', 'validate', { phaseId: 'validate' }), // orfao
      makeNode('fix-r1', 'validate', { phaseId: 'validate' }), // orfao
      makeNode('validator-r2', 'validate', { phaseId: 'validate' }), // orfao
      makeNode('fix-r2', 'validate', { phaseId: 'validate' }), // orfao
    ];
    const runs = [makeNodeRun('validator-r0', 'validate', 'completed'), makeNodeRun('fix-r0', 'validate', 'completed')];
    const noNodesStatus = derivePhaseDisplayStatus('validate', runs);
    expect(noNodesStatus).toBe('completed');

    const fixedStatus = derivePhaseDisplayStatus('validate', runs, phaseNodes);
    expect(fixedStatus).toBe('completed');
  });

  it('SM-33 BUG PATH: deriveSprintGroups captura o caso real de orfaos com roundIndex', () => {
    const nodes = [
      makeNode('coder-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
      makeNode('fix-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
      makeNode('coder-s0-r1', 'Desenvolvimento', { sprintId: 's0', roundIndex: 1 }), // orfao
      makeNode('fix-s0-r1', 'Desenvolvimento', { sprintId: 's0', roundIndex: 1 }), // orfao
    ];
    const runs = [
      makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'completed'),
      makeNodeRun('fix-s0-r0', 'Desenvolvimento', 'completed'),
    ];
    const groups = deriveSprintGroups(nodes, runs);
    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe('passed');
    expect(groups[0].status).not.toBe('running');
  });

  it('derivePhaseDisplayStatus: fase em curso (node running) continua "running" com phaseNodes', () => {
    const phaseNodes = [
      makeNode('validator-r0', 'validate', { phaseId: 'validate' }),
      makeNode('fix-r0', 'validate', { phaseId: 'validate' }),
      makeNode('validator-r1', 'validate', { phaseId: 'validate' }),
    ];
    const runs = [makeNodeRun('validator-r0', 'validate', 'running')];
    expect(derivePhaseDisplayStatus('validate', runs, phaseNodes)).toBe('running');
  });

  it('deriveRailGroups: grupo de sprint convergida mostra "completed" no cockpit', () => {
    const nodes = [...makeSprintNodes(0, 3)];
    const manifest = deriveManifestFromNodes(nodes);
    const runs = [
      makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'completed'),
      makeNodeRun('fix-s0-r0', 'Desenvolvimento', 'completed'),
    ];
    const groups = deriveRailGroups(nodes, runs, manifest);
    const sprintGroup = groups.find((g) => g.sprintId === 's0');
    expect(sprintGroup).toBeDefined();
    expect(sprintGroup?.status).toBe('completed');
    expect(sprintGroup?.status).not.toBe('running');
  });

  it('deriveRailGroups: grupo de sprint em curso continua "running"', () => {
    const nodes = makeSprintNodes(0, 3);
    const manifest = deriveManifestFromNodes(nodes);
    const runs = [makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'running')];
    const groups = deriveRailGroups(nodes, runs, manifest);
    const sprintGroup = groups.find((g) => g.sprintId === 's0');
    expect(sprintGroup?.status).toBe('running');
  });
});

describe('SM-44: fase de Entrega + gates orfaos refletem delivered/completed', () => {
  function makeSprintNodes(sprintIdx: number, maxRounds: number): DynamicWorkflowNode[] {
    const out: DynamicWorkflowNode[] = [];
    for (let r = 0; r < maxRounds; r++) {
      out.push(makeNode(`coder-s${sprintIdx}-r${r}`, 'Desenvolvimento', { sprintId: `s${sprintIdx}`, roundIndex: r }));
      out.push(makeNode(`fix-s${sprintIdx}-r${r}`, 'Desenvolvimento', { sprintId: `s${sprintIdx}`, roundIndex: r }));
    }
    return out;
  }

  it('isRunDeliveredTerminal: so delivered/completed sao terminais de entrega', () => {
    expect(isRunDeliveredTerminal('delivered')).toBe(true);
    expect(isRunDeliveredTerminal('completed')).toBe(true);
    expect(isRunDeliveredTerminal('running')).toBe(false);
    expect(isRunDeliveredTerminal('blocked')).toBe(false);
    expect(isRunDeliveredTerminal('aborted')).toBe(false);
    expect(isRunDeliveredTerminal(null)).toBe(false);
    expect(isRunDeliveredTerminal(undefined)).toBe(false);
  });

  it('derivePhaseDisplayStatus: fase de Entrega (so gate, sem node_run) e "pending" sem run.status', () => {
    const phaseNodes = [
      makeNode('gate-delivery-human', 'Entrega', { type: 'gate' }),
      makeNode('gate-delivery-orchestrator', 'Entrega', { type: 'gate' }),
    ];
    expect(derivePhaseDisplayStatus('Entrega', [], phaseNodes)).toBe('pending');
  });

  it('derivePhaseDisplayStatus: fase final de run entregue colapsa para "completed"', () => {
    const phaseNodes = [
      makeNode('gate-delivery-human', 'Entrega', { type: 'gate' }),
      makeNode('gate-delivery-orchestrator', 'Entrega', { type: 'gate' }),
    ];
    expect(
      derivePhaseDisplayStatus('Entrega', [], phaseNodes, {
        runStatus: 'delivered',
        isFinalPhase: true,
      }),
    ).toBe('completed');
    expect(
      derivePhaseDisplayStatus('Entrega', [], phaseNodes, {
        runStatus: 'completed',
        isFinalPhase: true,
      }),
    ).toBe('completed');
  });

  it('derivePhaseDisplayStatus: fase NAO-final de run entregue NAO colapsa', () => {
    const phaseNodes = [makeNode('planner', 'Planejamento')];
    expect(
      derivePhaseDisplayStatus('Planejamento', [], phaseNodes, {
        runStatus: 'delivered',
        isFinalPhase: false,
      }),
    ).toBe('pending');
  });

  it('derivePhaseDisplayStatus: fase final com node_run failed preserva "failed" mesmo entregue', () => {
    const phaseNodes = [makeNode('delivery-report', 'Entrega', { type: 'artifact' })];
    const runs = [makeNodeRun('delivery-report', 'Entrega', 'failed')];
    expect(
      derivePhaseDisplayStatus('Entrega', runs, phaseNodes, {
        runStatus: 'delivered',
        isFinalPhase: true,
      }),
    ).toBe('failed');
  });

  it('deriveSprintGroups: run entregue colapsa orfaos pendentes para "skipped" (sprint "passed")', () => {
    const nodes = makeSprintNodes(0, 3);
    const runs = [
      makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'completed'),
      makeNodeRun('fix-s0-r0', 'Desenvolvimento', 'completed'),
    ];
    const groupsDelivered = deriveSprintGroups(nodes, runs, 'delivered');
    expect(groupsDelivered[0].status).toBe('passed');
    expect(groupsDelivered[0].rounds[1].status).toBe('passed');
    expect(groupsDelivered[0].rounds[2].status).toBe('passed');
  });

  it('deriveSprintGroups: run entregue forca skip de orfao mesmo sem outro node concluido', () => {
    const nodes = makeSprintNodes(0, 2);
    const groupsDelivered = deriveSprintGroups(nodes, [], 'delivered');
    expect(groupsDelivered).toHaveLength(1);
    expect(groupsDelivered[0].status).toBe('passed');
    expect(deriveSprintGroups(nodes, [])[0].status).toBe('pending');
  });

  it('deriveRailGroups: fase de Entrega (so gate) vira "completed" quando o run entregou', () => {
    const nodes = [
      makeNode('planner', 'Planejamento'),
      makeNode('coder-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
      makeNode('gate-delivery-human', 'Entrega', { type: 'gate' }),
      makeNode('gate-delivery-orchestrator', 'Entrega', { type: 'gate' }),
    ];
    const manifest = deriveManifestFromNodes(nodes);
    const runs = [
      makeNodeRun('planner', 'Planejamento', 'completed'),
      makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'completed'),
    ];
    const pendingGroups = deriveRailGroups(nodes, runs, manifest);
    const entregaPending = pendingGroups.find((g) => g.id === 'phase:Entrega');
    expect(entregaPending?.status).toBe('pending');

    const deliveredGroups = deriveRailGroups(nodes, runs, manifest, {}, 'delivered');
    const entregaDone = deliveredGroups.find((g) => g.id === 'phase:Entrega');
    expect(entregaDone?.status).toBe('completed');
    for (const n of entregaDone?.nodes ?? []) {
      expect(n.metrics.status).toBe('skipped');
    }
  });

  it('deriveRailGroups: gate de entrega que NAO disparou aparece "skipped" (orfao permanente)', () => {
    const nodes = [
      makeNode('gate-delivery-human', 'Entrega', { type: 'gate' }),
      makeNode('gate-delivery-orchestrator', 'Entrega', { type: 'gate' }),
    ];
    const manifest = deriveManifestFromNodes(nodes);
    const groups = deriveRailGroups(nodes, [], manifest, {}, 'completed');
    const entrega = groups.find((g) => g.id === 'phase:Entrega');
    expect(entrega?.status).toBe('completed');
    const human = entrega?.nodes.find((n) => n.nodeId === 'gate-delivery-human');
    const orch = entrega?.nodes.find((n) => n.nodeId === 'gate-delivery-orchestrator');
    expect(human?.metrics.status).toBe('skipped');
    expect(orch?.metrics.status).toBe('skipped');
  });

  it('deriveRailGroups: SM-53 - fase NAO-final so-com-orfaos some (nao e mascarada como completed pelo delivered)', () => {
    const nodes = [
      makeNode('planner', 'Planejamento'),
      makeNode('coder-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
      makeNode('gate-delivery-human', 'Entrega', { type: 'gate' }),
    ];
    const manifest = deriveManifestFromNodes(nodes);
    const groups = deriveRailGroups(nodes, [], manifest, {}, 'delivered');
    expect(groups.find((g) => g.id === 'phase:Planejamento')).toBeUndefined();
    expect(groups.some((g) => g.id.startsWith('phase:Desenvolvimento'))).toBe(false);
    const entrega = groups.find((g) => g.id === 'phase:Entrega');
    expect(entrega?.status).toBe('completed');
  });

  it('deriveRailGroups: SM-53 - mostra SO o que rodou/roda; esqueleto pre-expandido (rodadas futuras + redev) some', () => {
    const nodes = [
      makeNode('coder-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
      makeNode('validator-0-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
      makeNode('coder-s0-r1', 'Desenvolvimento', { sprintId: 's0', roundIndex: 1 }),
      makeNode('coder-s0-redev1-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
    ];
    const manifest = deriveManifestFromNodes(nodes);
    const runs = [makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'completed')];
    const groups = deriveRailGroups(nodes, runs, manifest, {}, 'running');
    const sprint = groups.find((g) => g.sprintId === 's0');
    const ids = sprint?.nodes.map((n) => n.nodeId) ?? [];
    expect(ids).toContain('coder-s0-r0');
    expect(ids).not.toContain('coder-s0-r1');
    expect(ids).not.toContain('coder-s0-redev1-r0');
    expect(ids).not.toContain('validator-0-s0-r0');
  });
});

describe('UX-layout reqs 4+8: fase de Entrega vira GATE (header PLAN->DEV)', () => {
  function phase(id: string, order: number): DynamicWorkflowManifestPhase {
    return { id, name: id, order };
  }

  it('isDeliveryGatePhase: fase so com gate/artifact e fase de entrega; com agente nao', () => {
    const nodes = [
      makeNode('gate-delivery-human', 'Entrega', { type: 'gate' }),
      makeNode('gate-delivery-orchestrator', 'Entrega', { type: 'gate' }),
      makeNode('delivery-report', 'Entrega', { type: 'artifact' }),
      makeNode('coder-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0, type: 'agent' }),
    ];
    expect(isDeliveryGatePhase('Entrega', nodes)).toBe(true);
    expect(isDeliveryGatePhase('Desenvolvimento', nodes)).toBe(false);
    expect(isDeliveryGatePhase('Inexistente', nodes)).toBe(false);
  });

  it('selectRenderedPhases corta a ultima fase quando ela e so gate/artifact (PLAN->DEV)', () => {
    const phases = [phase('Planejamento', 0), phase('Desenvolvimento', 1), phase('Entrega', 2)];
    const nodes = [
      makeNode('planner', 'Planejamento'),
      makeNode('coder-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
      makeNode('gate-delivery-human', 'Entrega', { type: 'gate' }),
      makeNode('delivery-report', 'Entrega', { type: 'artifact' }),
    ];
    const rendered = selectRenderedPhases(phases, nodes);
    expect(rendered.map((p) => p.id)).toEqual(['Planejamento', 'Desenvolvimento']);
  });

  it('selectRenderedPhases NAO corta quando a ultima fase carrega trabalho de agente', () => {
    const phases = [phase('Planejamento', 0), phase('Desenvolvimento', 1)];
    const nodes = [
      makeNode('planner', 'Planejamento'),
      makeNode('coder-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0, type: 'agent' }),
    ];
    const rendered = selectRenderedPhases(phases, nodes);
    expect(rendered.map((p) => p.id)).toEqual(['Planejamento', 'Desenvolvimento']);
  });

  it('selectRenderedPhases so corta a ULTIMA (fase de gate no meio fica intacta)', () => {
    const phases = [phase('Planejamento', 0), phase('Gate-meio', 1), phase('Desenvolvimento', 2)];
    const nodes = [
      makeNode('planner', 'Planejamento'),
      makeNode('gate-meio', 'Gate-meio', { type: 'gate' }),
      makeNode('coder-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0, type: 'agent' }),
    ];
    const rendered = selectRenderedPhases(phases, nodes);
    expect(rendered.map((p) => p.id)).toEqual(['Planejamento', 'Gate-meio', 'Desenvolvimento']);
  });
});

describe('UX-layout: barra de fase removida do RunView (render)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  function seedDelivered(runStatus: DynamicWorkflowRun['status']): void {
    const nodes = [
      makeNode('planner', 'Planejamento'),
      makeNode('coder-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
      makeNode('gate-delivery-human', 'Entrega', { type: 'gate' }),
      makeNode('gate-delivery-orchestrator', 'Entrega', { type: 'gate' }),
      makeNode('delivery-report', 'Entrega', { type: 'artifact' }),
    ];
    const nodeRuns = [
      makeNodeRun('planner', 'Planejamento', 'completed'),
      makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'completed'),
    ];
    useDynamicWorkflowStore.setState({
      selectedRunId: 'run-1',
      selectedRun: makeRun({ status: runStatus, currentPhaseId: 'Entrega' }),
      nodes,
      nodeRuns,
      manifest: deriveManifestFromNodes(nodes),
      events: [],
      artifacts: [],
      snapshot: null,
      nodeStreams: {},
      selectedRoundIndex: null,
      closerThread: [],
      maestroThread: [],
      maestroBusyRunIds: new Set(),
      closerBusyRunIds: new Set(),
      narrationByRun: {},
      stalledByRun: {},
      streamingRunIds: new Set(),
      awaitingUserRunIds: new Set(),
      error: null,
    });
  }

  function mount(): void {
    root = createRoot(container);
    act(() => {
      root?.render(<DynamicWorkflowRunView runId="run-1" />);
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    if (typeof Element.prototype.scrollIntoView !== 'function') {
      Element.prototype.scrollIntoView = function scrollIntoViewStub(): void {};
    }
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (window as unknown as Record<string, unknown>).lionclaw = {
      dynamicWorkflow: {
        approveGate: vi.fn(async () => ({ ok: true })),
        sendMessage: vi.fn(async () => ({ ok: true })),
        sendCloserMessage: vi.fn(async () => ({ ok: true })),
        finalize: vi.fn(async () => ({ ok: true })),
      },
      shell: { showInFolder: vi.fn(async () => undefined) },
    };
  });

  afterEach(() => {
    const r = root;
    if (r) {
      act(() => {
        r.unmount();
      });
      root = null;
    }
    container.remove();
    consoleErrorSpy.mockRestore();
  });

  it('run completed: barra de fase removida (sem chip de Entrega); a tela mostra o handoff', () => {
    seedDelivered('completed');
    mount();
    expect(container.querySelector('[data-testid="delivery-gate-chip"]')).toBeNull();
    expect(container.querySelector('[data-testid="workflow-handoff-view"]')).not.toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('run running: barra de fase removida (sem chip de Entrega no topo)', () => {
    seedDelivered('running');
    mount();
    expect(container.querySelector('[data-testid="delivery-gate-chip"]')).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

describe('UX-layout E6.3: cockpit puro ocupa a tela (sem coluna de chat)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  function seed(): void {
    const nodes = [
      makeNode('planner', 'Planejamento'),
      makeNode('coder-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
    ];
    useDynamicWorkflowStore.setState({
      selectedRunId: 'run-1',
      selectedRun: makeRun({ status: 'running', currentPhaseId: 'Desenvolvimento' }),
      nodes,
      nodeRuns: [
        makeNodeRun('planner', 'Planejamento', 'completed'),
        makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'running'),
      ],
      manifest: deriveManifestFromNodes(nodes),
      events: [],
      artifacts: [],
      snapshot: null,
      nodeStreams: {},
      selectedRoundIndex: null,
      closerThread: [],
      maestroThread: [],
      maestroBusyRunIds: new Set(),
      closerBusyRunIds: new Set(),
      narrationByRun: {},
      stalledByRun: {},
      streamingRunIds: new Set(['run-1']),
      awaitingUserRunIds: new Set(),
      error: null,
    });
  }

  function mount(): void {
    root = createRoot(container);
    act(() => {
      root?.render(<DynamicWorkflowRunView runId="run-1" />);
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    if (typeof Element.prototype.scrollIntoView !== 'function') {
      Element.prototype.scrollIntoView = function scrollIntoViewStub(): void {};
    }
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (window as unknown as Record<string, unknown>).lionclaw = {
      dynamicWorkflow: {
        approveGate: vi.fn(async () => ({ ok: true })),
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
      shell: { showInFolder: vi.fn(async () => undefined) },
    };
    seed();
  });

  afterEach(() => {
    const r = root;
    if (r) {
      act(() => {
        r.unmount();
      });
      root = null;
    }
    container.remove();
    consoleErrorSpy.mockRestore();
  });

  it('E6.3: cockpit ocupa a tela; sem toggle de colapso (nada para revelar embaixo)', () => {
    mount();
    expect(container.querySelector('[data-testid="run-cockpit"]')).not.toBeNull();
    expect(container.textContent).toContain('Cockpit');
    expect(container.querySelector('[data-testid="rail-collapse"]')).toBeNull();
    expect(container.querySelector('[data-testid="rail-reopen"]')).toBeNull();
    expect(container.querySelector('[data-testid="maestro-chat"]')).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

describe('HANDOFF: fim do run passa o contexto pro orquestrador (render + efeito)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let finalizeWorkflowMock: ReturnType<typeof vi.fn>;

  function seedClosing(runStatus: DynamicWorkflowRun['status']): void {
    const nodes = [
      makeNode('planner', 'Planejamento'),
      makeNode('coder-s0-r0', 'Desenvolvimento', { sprintId: 's0', roundIndex: 0 }),
      makeNode('gate-delivery-human', 'Entrega', { type: 'gate' }),
      makeNode('delivery-report', 'Entrega', { type: 'artifact' }),
    ];
    finalizeWorkflowMock = vi.fn(async () => ({ ok: true as const }));
    useDynamicWorkflowStore.setState({
      selectedRunId: 'run-1',
      selectedRun: makeRun({
        status: runStatus,
        currentPhaseId: 'Entrega',
        projectPath: '/srv/persistent',
        worktreePath: '/tmp/run-1',
        baseBranch: 'main',
        worktreeBranch: 'dynworkflow/run-1',
      }),
      nodes,
      nodeRuns: [
        makeNodeRun('planner', 'Planejamento', 'completed'),
        makeNodeRun('coder-s0-r0', 'Desenvolvimento', 'completed'),
      ],
      manifest: deriveManifestFromNodes(nodes),
      events: [],
      artifacts: [],
      snapshot: null,
      nodeStreams: {},
      selectedRoundIndex: null,
      closerThread: [{ id: 'c1', role: 'closer', content: 'Entrega pronta. Rode `npm install` e `npm run dev`.' }],
      maestroThread: [],
      maestroBusyRunIds: new Set(),
      closerBusyRunIds: new Set(),
      narrationByRun: {},
      stalledByRun: {},
      streamingRunIds: new Set(),
      awaitingUserRunIds: new Set(),
      error: null,
      finalizeWorkflow: finalizeWorkflowMock,
    } as Partial<ReturnType<typeof useDynamicWorkflowStore.getState>>);
    useAppStore.setState({
      currentPage: 'dynamic-workflow',
      pendingChatByTarget: {},
    } as Partial<ReturnType<typeof useAppStore.getState>>);
  }

  function mount(): void {
    root = createRoot(container);
    act(() => {
      root?.render(<DynamicWorkflowRunView runId="run-1" />);
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    if (typeof Element.prototype.scrollIntoView !== 'function') {
      Element.prototype.scrollIntoView = function stub(): void {};
    }
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    handoffMock.handoffToOrchestrator.mockReset();
    handoffMock.handoffToOrchestrator.mockImplementation(
      async (_req: unknown, beforeHandoff?: () => Promise<{ ok: true } | { error: string }>) => {
        if (beforeHandoff) {
          const r = await beforeHandoff();
          if ('error' in r) return r;
        }
        useAppStore.getState().setPendingChat('prompt-de-handoff', undefined, {
          awaitRepoReady: 'repo-1',
          targetSessionId: 'sess-1',
        });
        useAppStore.getState().setPage('chat');
        return { ok: true as const };
      },
    );
    (window as unknown as Record<string, unknown>).lionclaw = {
      dynamicWorkflow: {
        approveGate: vi.fn(async () => ({ ok: true })),
        sendMessage: vi.fn(async () => ({ ok: true })),
        finalizeWorkflow: vi.fn(async () => ({ ok: true })),
      },
      settings: { get: vi.fn(async () => ({ orchestratorModel: 'claude-opus-4-8' })) },
      shell: { showInFolder: vi.fn(async () => undefined) },
    };
  });

  afterEach(() => {
    const r = root;
    if (r) {
      act(() => r.unmount());
      root = null;
    }
    container.remove();
    consoleErrorSpy.mockRestore();
  });

  it('delivered: monta o handoff (resumo read-only + HandoffButton "Continuar no orquestrador", sem CTA Novo workflow)', () => {
    seedClosing('delivered');
    mount();
    expect(container.querySelector('[data-testid="workflow-handoff-view"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="handoff-summary"]')).not.toBeNull();
    expect(container.textContent).toContain('npm run dev');
    const handoffBtn = container.querySelector('[data-testid="handoff-to-orchestrator"]');
    expect(handoffBtn?.textContent).toContain('Continuar no orquestrador');
    expect(container.querySelector('[data-testid="new-workflow-cta"]')).toBeNull();
    expect(container.querySelector('[data-testid="workflow-end-chat"]')).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('Encerrar: delega ao seam central com request (run.projectPath/run.baseBranch) + beforeHandoff = finalizeWorkflow', async () => {
    seedClosing('delivered');
    mount();
    const btn = container.querySelector('[data-testid="handoff-to-orchestrator"]') as HTMLButtonElement;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(handoffMock.handoffToOrchestrator).toHaveBeenCalledTimes(1);
    const [request, beforeHandoff] = handoffMock.handoffToOrchestrator.mock.calls[0];
    expect(request).toMatchObject({
      source: 'workflow',
      projectId: 'run-1',
      projectPath: '/srv/persistent',
      branch: 'main',
    });
    expect((request as { projectPath?: string }).projectPath).not.toBe('/tmp/run-1');
    expect((request as { branch?: string }).branch).not.toBe('dynworkflow/run-1');
    expect(typeof beforeHandoff).toBe('function');
    expect(finalizeWorkflowMock).toHaveBeenCalledWith('run-1');
    expect(useAppStore.getState().currentPage).toBe('chat');
    expect(useAppStore.getState().pendingChatByTarget['sess-1']?.message).toBe('prompt-de-handoff');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('Encerrar com finalize falho: aborta sem navegar (REGRA MAXIMA; run preservado)', async () => {
    seedClosing('delivered');
    finalizeWorkflowMock.mockResolvedValueOnce({ error: 'falhou ao finalizar' });
    mount();
    const btn = container.querySelector('[data-testid="handoff-to-orchestrator"]') as HTMLButtonElement;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(finalizeWorkflowMock).toHaveBeenCalledWith('run-1');
    expect(useAppStore.getState().currentPage).not.toBe('chat');
    expect(useAppStore.getState().pendingChatByTarget).toEqual({});
  });

  it('completed: handoff em somente leitura (preservado, nao deletado), sem botao de encerrar', () => {
    seedClosing('completed');
    mount();
    expect(container.querySelector('[data-testid="workflow-handoff-view"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="handoff-locked"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="handoff-to-orchestrator"]')).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

function authoredNodeRun(
  nodeId: string,
  phaseId: string,
  status: DynamicWorkflowNodeStatus,
  extra: Partial<CockpitNodeRun> = {},
): CockpitNodeRun {
  return { ...makeNodeRun(nodeId, phaseId, status), ...extra };
}

function structuralEv(
  seq: number,
  type: string,
  nodeId: string | null,
  phaseId: string | null,
  payload: Record<string, unknown>,
  createdAt: string,
): DynamicWorkflowEvent {
  return { id: seq, runId: 'run-1', nodeId, phaseId, seq, type, payloadJson: JSON.stringify(payload), createdAt };
}

function contrastViolations(root: ParentNode): string[] {
  const out: string[] = [];
  root.querySelectorAll('[class*="text-zinc-600"], [class*="text-zinc-700"]').forEach((el) => {
    if (!el.closest('.font-mono')) out.push(`${el.tagName.toLowerCase()}.${el.className}`);
  });
  return out;
}

describe('S4 cockpit em run autorado (nodes: [] + nodeRuns; D20-D26)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  const prevTz = process.env.TZ;

  const CODER_ID = 'cc:Sprint 1:u-s1-ac1:0';
  const VALIDATOR_ID = 'cc:Sprint 1:dynamic-workflow-validator-spec:0';

  const authoredRuns: CockpitNodeRun[] = [
    authoredNodeRun('scout', 'Documentos', 'completed', {
      agentId: 'dynamic-workflow-scout',
      costStatus: 'unknown',
      costUsd: 0,
      startedAt: '2026-09-02T04:30:00.000Z',
    }),
    authoredNodeRun(CODER_ID, 'Sprint 1', 'completed', {
      agentId: 'dynamic-workflow-coder',
      label: 'u-s1-ac1',
      startedAt: '2026-09-02T04:40:00.000Z',
      costUsd: 0.5,
      durationMs: 120_000,
      inputTokens: 20_000,
      outputTokens: 3_000,
      worktreeCommitSha: 'abc1234567890',
    }),
    authoredNodeRun(VALIDATOR_ID, 'Sprint 1', 'running', {
      agentId: 'dynamic-workflow-validator-spec',
      startedAt: '2026-09-02T04:43:00.000Z',
      costUsd: 0.05,
    }),
  ];

  const structural: DynamicWorkflowEvent[] = [
    structuralEv(1, 'run-started', null, null, {}, '2026-09-02 04:29:00'),
    structuralEv(2, 'phase-changed', null, 'Documentos', { phase: 'Documentos' }, '2026-09-02 04:29:30'),
    structuralEv(
      3,
      'node-started',
      'scout',
      'Documentos',
      { attempt: 0, agentId: 'dynamic-workflow-scout' },
      '2026-09-02 04:30:00',
    ),
    structuralEv(
      4,
      'node-completed',
      'scout',
      'Documentos',
      { attempt: 0, agentId: 'dynamic-workflow-scout', costUsd: 0, durationMs: 60000 },
      '2026-09-02 04:31:00',
    ),
    structuralEv(5, 'phase-changed', null, 'Sprint 1', { phase: 'Sprint 1' }, '2026-09-02 04:39:00'),
    structuralEv(
      6,
      'node-started',
      CODER_ID,
      'Sprint 1',
      { attempt: 0, agentId: 'dynamic-workflow-coder', label: 'u-s1-ac1', startedAt: '2026-09-02T04:40:00.000Z' },
      '2026-09-02 04:40:00',
    ),
    structuralEv(
      7,
      'node-completed',
      CODER_ID,
      'Sprint 1',
      {
        attempt: 0,
        agentId: 'dynamic-workflow-coder',
        label: 'u-s1-ac1',
        costUsd: 0.5,
        durationMs: 120000,
        touchedFiles: ['src/a.ts', 'src/b.ts'],
        touchedFilesTotal: 2,
        touchedFilesTruncated: false,
        worktreeCommitSha: 'abc1234567890',
        outputDigest: 'ARQUIVOS TOCADOS: src/a.ts, src/b.ts',
      },
      '2026-09-02 04:42:52',
    ),
    structuralEv(
      8,
      'green-check',
      null,
      'Sprint 1',
      { ok: false, inconclusive: false, redCount: 1 },
      '2026-09-02 04:42:55',
    ),
  ];

  function seed(patch: Partial<ReturnType<typeof useDynamicWorkflowStore.getState>> = {}): void {
    useDynamicWorkflowStore.setState({
      selectedRunId: 'run-1',
      selectedRun: makeRun({ currentPhaseId: 'Sprint 1', currentNodeId: VALIDATOR_ID, totalDurationMs: 300_000 }),
      nodes: [],
      manifest: null,
      nodeRuns: authoredRuns,
      events: structural,
      structuralEvents: structural,
      artifacts: [],
      snapshot: null,
      nodeStreams: {},
      selectedRoundIndex: null,
      closerThread: [],
      maestroThread: [],
      maestroBusyRunIds: new Set(),
      closerBusyRunIds: new Set(),
      narrationByRun: {},
      persistedNarrationByRun: {},
      gateDecisionsByRun: {},
      stalledByRun: {},
      streamingRunIds: new Set(['run-1']),
      awaitingUserRunIds: new Set(),
      pendingQuestion: null,
      error: null,
      ...patch,
    });
  }

  function mount(): void {
    root = createRoot(container);
    act(() => {
      root?.render(<DynamicWorkflowRunView runId="run-1" />);
    });
  }

  function clickTab(label: string): void {
    const buttons = Array.from(container.querySelectorAll('button'));
    const tab = buttons.find((b) => b.textContent?.trim() === label);
    expect(tab, `aba '${label}' existe`).toBeDefined();
    act(() => {
      tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  beforeEach(() => {
    process.env.TZ = 'America/Sao_Paulo';
    container = document.createElement('div');
    document.body.appendChild(container);
    if (typeof Element.prototype.scrollIntoView !== 'function') {
      Element.prototype.scrollIntoView = function stub(): void {};
    }
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (window as unknown as Record<string, unknown>).lionclaw = {
      dynamicWorkflow: {
        approveGate: vi.fn(async () => ({ ok: true })),
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
      shell: { showInFolder: vi.fn(async () => undefined) },
    };
    seed();
  });

  afterEach(() => {
    if (root) {
      const r = root;
      act(() => r.unmount());
      root = null;
    }
    container.remove();
    consoleErrorSpy.mockRestore();
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  });

  it('ordem das abas: Stream, Execucao, Custo, Saidas, Linha do tempo (sem Nodes/Artefatos/Manifest)', () => {
    mount();
    const labels = Array.from(container.querySelectorAll('button'))
      .map((b) => b.textContent?.trim() ?? '')
      .filter((t) =>
        ['Stream', 'Execucao', 'Custo', 'Saidas', 'Linha do tempo', 'Nodes', 'Artefatos', 'Manifest'].includes(t),
      );
    expect(labels).toEqual(['Stream', 'Execucao', 'Custo', 'Saidas', 'Linha do tempo']);
  });

  it('D20: Execucao mostra cards por fase a partir dos nodeRuns (nodes vazio), sem "Sem nodes na definition"', () => {
    mount();
    clickTab('Execucao');
    expect(container.textContent).not.toContain('Sem nodes na definition');
    expect(container.querySelector('[data-testid="execution-groups"]')).not.toBeNull();
    const phases = Array.from(container.querySelectorAll('[data-testid^="execution-phase-"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(phases).toEqual(['execution-phase-Documentos', 'execution-phase-Sprint 1']);
    const coderCard = container.querySelector(`[data-testid="execution-node-${CODER_ID}"]`);
    expect(coderCard).not.toBeNull();
    expect(coderCard?.getAttribute('title')).toBe(CODER_ID);
    expect(coderCard?.textContent).toContain('u-s1-ac1');
    expect(coderCard?.textContent).toContain('#0');
    expect(coderCard?.textContent).toContain('2m');
    const validatorCard = container.querySelector(`[data-testid="execution-node-${VALIDATOR_ID}"]`);
    expect(validatorCard?.textContent).toContain('dynamic-workflow-validator-spec');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('D24: cabecalho Ambiente colapsavel com os 7 campos e Nodes = contagem de nodeRuns', () => {
    mount();
    clickTab('Execucao');
    const header = container.querySelector('[data-testid="execution-environment"]');
    expect(header).not.toBeNull();
    expect(header?.textContent).toContain('Ambiente');
    expect(container.querySelector('[data-testid="execution-environment-fields"]')).toBeNull();
    const toggle = header?.querySelector('button') as HTMLButtonElement;
    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const fields = container.querySelector('[data-testid="execution-environment-fields"]');
    expect(fields).not.toBeNull();
    for (const label of [
      'Definition',
      'Modo de workspace',
      'Branch base',
      'Commit base',
      'Worktree',
      'Ultimo checkpoint',
      'Nodes',
    ]) {
      expect(fields?.textContent).toContain(label);
    }
    expect(fields?.textContent).toContain('def-1');
    expect(fields?.textContent).toContain('run-worktree');
    expect(fields?.textContent).toMatch(/Nodes\s*3/);
  });

  it('D20: Execucao vazia mostra "Nenhum node executou ainda" legivel (zinc-400, >=12px)', () => {
    seed({ nodeRuns: [], structuralEvents: [], events: [] });
    mount();
    clickTab('Execucao');
    const empty = container.querySelector('[data-testid="execution-empty"]');
    expect(empty?.textContent).toContain('Nenhum node executou ainda');
    expect(empty?.className).toContain('text-zinc-400');
    expect(empty?.className).toContain('text-[12px]');
    expect(empty?.className).not.toMatch(/text-zinc-(600|700)/);
  });

  it('D21: Custo tem 4 pills, cards por fase/papel, top nodes e mantem scout + ? visiveis', () => {
    mount();
    clickTab('Custo');
    const tab = container.querySelector('[data-testid="cost-tab"]');
    expect(tab).not.toBeNull();
    const text = tab?.textContent ?? '';
    for (const pill of ['Custo', 'Tempo', 'Tokens in / out', 'Tools / requests']) expect(text).toContain(pill);
    expect(text).toContain('$0.420');
    expect(text).toContain('5m00s');
    expect(container.querySelector('[data-testid="cost-phase-Documentos"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cost-phase-Sprint 1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cost-role-dynamic-workflow-coder"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid^="cost-top-"]').length).toBe(3);
    expect(text).toContain('scout');
    expect(text).toContain('?');
    expect(container.querySelector('[data-testid="cost-unknown-badge"]')).not.toBeNull();
    const top = container.querySelectorAll('[data-testid^="cost-top-"]');
    expect(top[0].getAttribute('title')).toBe(CODER_ID);
    expect(top[0].textContent).toContain('u-s1-ac1');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('D25: Saidas lista arquivos tocados dos eventos, commits por writer e pacote indisponivel sem IPC', () => {
    mount();
    clickTab('Saidas');
    const tab = container.querySelector('[data-testid="outputs-tab"]');
    expect(tab).not.toBeNull();
    const text = tab?.textContent ?? '';
    expect(text).toContain('src/a.ts');
    expect(text).toContain('src/b.ts');
    expect(text).not.toContain('(stream ao vivo)');
    const writer = container.querySelector(`[data-testid="outputs-writer-${CODER_ID}"]`);
    expect(writer?.textContent).toContain('u-s1-ac1');
    expect(writer?.textContent).toContain('abc12345');
    expect(text).toContain('dynworkflow/run-1');
    expect(text).toContain('/tmp/run-1');
    expect(container.querySelector('[data-testid="outputs-bundle-unavailable"]')).not.toBeNull();
    expect(text).toContain('indisponivel nesta versao');
    expect(text).toContain('Artefatos declarados');
  });

  it('D25c: com getRunBundle/openRunDir no preload, Saidas lista o pacote e oferece abrir a pasta', async () => {
    const getRunBundle = vi.fn(async () => [
      { name: 'workflow.js', relativePath: 'workflow.js', sizeBytes: 2048, mtime: '2026-09-02 04:20:00' },
      {
        name: 'events.jsonl',
        relativePath: 'logs/events.jsonl',
        sizeBytes: 1024 * 1024 * 3,
        mtime: '2026-09-02 04:42:52',
      },
    ]);
    const openRunDir = vi.fn(async () => ({ ok: true as const }));
    (
      window as unknown as Record<string, { dynamicWorkflow: Record<string, unknown> }>
    ).lionclaw.dynamicWorkflow.getRunBundle = getRunBundle;
    (
      window as unknown as Record<string, { dynamicWorkflow: Record<string, unknown> }>
    ).lionclaw.dynamicWorkflow.openRunDir = openRunDir;
    mount();
    clickTab('Saidas');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getRunBundle).toHaveBeenCalledWith('run-1');
    const text = container.querySelector('[data-testid="outputs-bundle"]')?.textContent ?? '';
    expect(text).toContain('logs/events.jsonl');
    expect(text).toContain('3.0 MB');
    expect(text).toContain('02/09 01:42');
    const openBtn = container.querySelector('[data-testid="outputs-open-run-dir"]') as HTMLButtonElement;
    expect(openBtn).not.toBeNull();
    await act(async () => {
      openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(openRunDir).toHaveBeenCalledWith('run-1');
  });

  it('D25a: sem evento de writer, Saidas cai no stream vivo (fallback)', () => {
    seed({
      structuralEvents: structural.filter((e) => e.type !== 'node-completed'),
      nodeStreams: {
        [CODER_ID]: {
          nodeId: CODER_ID,
          label: 'u-s1-ac1',
          status: 'running',
          text: '',
          toolCalls: [{ toolName: 'Write', detail: 'src/live.ts', status: 'done' } as never],
          timeline: [],
          isStreaming: true,
        },
      },
    });
    mount();
    clickTab('Saidas');
    const text = container.querySelector('[data-testid="outputs-touched"]')?.textContent ?? '';
    expect(text).toContain('src/live.ts');
    expect(text).toContain('(stream ao vivo)');
  });

  it("D22 (VA-10): Linha do tempo mostra '2026-09-02 04:42:52' como 01:42 em America/Sao_Paulo, com payload, fase e dia", () => {
    mount();
    clickTab('Linha do tempo');
    const feed = container.querySelector('[data-testid="timeline-feed"]');
    expect(container.querySelector('[data-testid="event-timeline"]')).not.toBeNull();
    expect(feed).not.toBeNull();
    const text = feed?.textContent ?? '';
    expect(text).toContain('01:42');
    expect(text).not.toContain('04:42');
    expect(text).toContain('02/09/2026');
    expect(container.querySelectorAll('[data-testid="timeline-phase"]').length).toBeGreaterThanOrEqual(2);
    expect(text).toContain('node-completed');
    expect(text).toContain('node concluiu');
    expect(text).toContain('$0.500');
    expect(text).toContain('2m');
    expect(text).toContain('2 arquivos');
    expect(text).toContain('abc12345');
    expect(text).toContain('ARQUIVOS TOCADOS');
    expect(text).toContain('vermelho (1 check)');
    const attention = container.querySelectorAll('[data-testid="timeline-item"][data-severity="attention"]');
    expect(attention.length).toBeGreaterThanOrEqual(1);
    const nodeSpans = Array.from(container.querySelectorAll('[data-testid="timeline-node"]'));
    const coderSpan = nodeSpans.find((s) => s.getAttribute('title') === CODER_ID);
    expect(coderSpan).toBeDefined();
    expect(coderSpan?.textContent).toBe('[u-s1-ac1 #0]');
    const scoutSpan = nodeSpans.find((s) => s.getAttribute('title') === 'scout');
    expect(scoutSpan?.textContent).toContain('scout');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('D26: nenhum texto principal/empty state em zinc-600/700 nas 4 superficies (zinc-600 so em meta mono)', () => {
    mount();
    for (const tab of ['Execucao', 'Custo', 'Saidas', 'Linha do tempo']) {
      clickTab(tab);
      expect(contrastViolations(container), `aba ${tab}`).toEqual([]);
    }
    seed({ nodeRuns: [], structuralEvents: [], events: [], streamingRunIds: new Set() });
    for (const tab of ['Execucao', 'Custo', 'Saidas', 'Linha do tempo']) {
      clickTab(tab);
      expect(contrastViolations(container), `aba vazia ${tab}`).toEqual([]);
    }
    for (const id of ['execution-empty', 'cost-empty', 'timeline-empty', 'rail-agents-empty']) {
      const el = container.querySelector(`[data-testid="${id}"]`);
      if (!el) continue;
      expect(el.className, id).toContain('text-zinc-400');
      expect(el.className, id).not.toMatch(/text-zinc-(600|700)/);
      expect(el.className, id).toMatch(/text-\[1[2-9]px\]/);
    }
  });

  it('D20: Rail popula agentes por fase a partir dos nodeRuns quando nodes esta vazio', () => {
    mount();
    expect(container.textContent).not.toContain('Sem agentes ainda.');
    expect(container.querySelector('[data-testid="rail-group-phase:Documentos"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="rail-group-phase:Sprint 1"]')).not.toBeNull();
    expect(container.querySelector(`[data-testid="rail-agent-${CODER_ID}"]`)).not.toBeNull();
    expect(container.textContent).toContain('Agentes (3)');
  });
});

describe('S4 funcoes puras: deriveRailGroups fallback, deriveExecutionGroups, nomes curtos, hora SQLite', () => {
  it('deriveRailGroups: fallback ADITIVO so quando nodes.length === 0', () => {
    const runs = [
      makeNodeRun('cc:Docs:scout:0', 'Docs', 'completed', { agentId: 'dynamic-workflow-scout' }),
      makeNodeRun('cc:Sprint 1:u-s1-ac1:0', 'Sprint 1', 'running', { agentId: 'dynamic-workflow-coder' }),
    ];
    const groups = deriveRailGroups([], runs, null);
    expect(groups.map((g) => g.id)).toEqual(['phase:Docs', 'phase:Sprint 1']);
    expect(groups[0].nodes[0].label).toBe('dynamic-workflow-scout');
    expect(groups[1].status).toBe('running');
    const withNodes = deriveRailGroups([makeNode('cc:Docs:scout:0', 'Docs')], runs, null);
    expect(withNodes.map((g) => g.id)).toEqual(['phase:Docs']);
    expect(withNodes[0].nodes.map((n) => n.nodeId)).toEqual(['cc:Docs:scout:0']);
  });

  it('deriveRailGroups: sem nodes e sem nodeRuns => vazio (empty state)', () => {
    expect(deriveRailGroups([], [], null)).toEqual([]);
  });

  it('shortNodeId / nodeDisplayName (D20)', () => {
    expect(shortNodeId('cc:Sprint 1:u-s1-ac1:0')).toBe('u-s1-ac1');
    expect(shortNodeId('cc:Sprint 1:refute-f0:2')).toBe('refute-f0');
    expect(shortNodeId('coder')).toBe('coder');
    expect(shortNodeId('validator-spec-r0')).toBe('validator-spec-r0');
    expect(shortNodeId('a:b')).toBe('a:b');
    expect(nodeDisplayName({ nodeId: 'cc:S:x:0', agentId: 'ag', label: 'lbl' })).toBe('lbl');
    expect(nodeDisplayName({ nodeId: 'cc:S:x:0', agentId: 'ag', label: null })).toBe('ag');
    expect(nodeDisplayName({ nodeId: 'cc:S:x:0', agentId: null })).toBe('x');
    expect(nodeDisplayName({ nodeId: 'coder', agentId: null })).toBe('coder');
  });

  it('deriveExecutionGroups agrega attempts por node e ordena fases por primeira aparicao', () => {
    const runs: CockpitNodeRun[] = [
      { ...makeNodeRun('b', 'F2', 'completed', { attempt: 1, costUsd: 0.2, startedAt: '2026-09-02T04:50:00.000Z' }) },
      { ...makeNodeRun('b', 'F2', 'failed', { attempt: 0, costUsd: 0.1, startedAt: '2026-09-02T04:45:00.000Z' }) },
      { ...makeNodeRun('a', 'F1', 'completed', { attempt: 0, startedAt: '2026-09-02T04:40:00.000Z' }) },
    ];
    const groups = deriveExecutionGroups(runs, [], null);
    expect(groups.map((g) => g.phaseId)).toEqual(['F1', 'F2']);
    const b = groups[1].nodes[0];
    expect(b.attempts).toBe(2);
    expect(b.status).toBe('completed');
    expect(b.costUsd).toBeCloseTo(0.3, 5);
    expect(b.latest.attempt).toBe(1);
  });

  it("P3: 'estimated-partial' vira costEstimated (~), 'unknown' vira costUnknown (?)", () => {
    const groups = deriveExecutionGroups(
      [
        makeNodeRun('a', 'F1', 'completed', { costStatus: 'estimated-partial', costUsd: 0.4 }),
        makeNodeRun('b', 'F1', 'completed', { costStatus: 'unknown', costUsd: 0 }),
        makeNodeRun('c', 'F1', 'completed', { costStatus: null, costUsd: 0.1 }),
      ],
      [],
      null,
    );
    const byId = Object.fromEntries(groups[0].nodes.map((n) => [n.nodeId, n]));
    expect(byId['a']).toMatchObject({ costEstimated: true, costUnknown: false });
    expect(byId['b']).toMatchObject({ costEstimated: false, costUnknown: true });
    expect(byId['c']).toMatchObject({ costEstimated: false, costUnknown: false });
    const fmt = (usd: number) => `$${usd.toFixed(3)}`;
    expect(formatCostWithConfidence(0.4, false, true, fmt)).toBe('~$0.400');
    expect(formatCostWithConfidence(0, true, false, fmt)).toBe('?');
    expect(formatCostWithConfidence(0, true, true, fmt)).toBe('?');
    expect(formatCostWithConfidence(0.1, false, false, fmt)).toBe('$0.100');
  });

  it("findPendingOpenedAtMs le 'YYYY-MM-DD HH:MM:SS' como UTC (D22)", () => {
    const events: DynamicWorkflowEvent[] = [
      {
        id: 1,
        runId: 'r',
        nodeId: null,
        phaseId: null,
        seq: 1,
        type: 'gate-blocked',
        payloadJson: '{}',
        createdAt: '2026-09-02 04:42:52',
      },
    ];
    expect(findPendingOpenedAtMs(events, (t) => t === 'gate-blocked')).toBe(Date.parse('2026-09-02T04:42:52.000Z'));
    const bad: DynamicWorkflowEvent[] = [{ ...events[0], createdAt: 'nao-e-data' }];
    expect(findPendingOpenedAtMs(bad, (t) => t === 'gate-blocked')).toBeNull();
  });
});

describe('WorkflowOutputsTab: contagem de arquivos tocados (dedup + so truncamento real)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (window as unknown as Record<string, unknown>).lionclaw = {
      dynamicWorkflow: {},
      shell: { showInFolder: vi.fn() },
    };
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  function mountTab(touched: TouchedFilesFromEvents) {
    root = createRoot(container);
    act(() => {
      root!.render(
        <WorkflowOutputsTab runId="run-1" run={null} touched={touched} liveTouchedFiles={[]} artifacts={[]} />,
      );
    });
    return container.querySelector('[data-testid="outputs-touched"]')?.textContent ?? '';
  }

  const writer = (nodeId: string, touchedFiles: string[]) => ({
    nodeId,
    phaseId: 'S1',
    attempt: 0,
    label: null,
    agentId: null,
    worktreeCommitSha: 'sha',
    touchedFiles,
  });

  it('3 writers tocando os mesmos 2 arquivos => conta 2, sem aviso de nao listados', () => {
    const files = ['src/a.ts', 'src/b.ts'];
    const text = mountTab({
      files,
      hidden: 0,
      truncated: false,
      writers: [writer('w1', files), writer('w2', files), writer('w3', files)],
    });
    expect(text).toContain('Arquivos tocados2');
    expect(text).not.toContain('nao listado');
    expect(text).not.toContain('truncada');
  });

  it('writer com total 60 e 50 listados => "+10 nao listado(s)"', () => {
    const files = Array.from({ length: 50 }, (_, i) => `src/f${i.toString().padStart(2, '0')}.ts`);
    const text = mountTab({ files, hidden: 10, truncated: true, writers: [writer('w1', files)] });
    expect(text).toContain('Arquivos tocados50+10');
    expect(text).toContain('+10 nao listado(s)');
  });
});
