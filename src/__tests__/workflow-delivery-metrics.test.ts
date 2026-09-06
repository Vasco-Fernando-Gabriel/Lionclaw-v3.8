import { describe, it, expect } from 'vitest';
import { aggregateMetricsBySprint, TotalPill } from '@/components/dynamic-workflow/WorkflowDeliveryMetrics';
import { aggregateCostBreakdown } from '@/components/dynamic-workflow/WorkflowCostTab';
import { deriveNodeRunsFromEvents } from '@/stores/dynamic-workflow-store';
import type {
  DynamicWorkflowEvent,
  DynamicWorkflowManifest,
  DynamicWorkflowNode,
  DynamicWorkflowNodeRun,
} from '@/types';
import type { CockpitNodeRun } from '@/types/dynamic-workflow-cockpit';

function nodeRun(over: Partial<DynamicWorkflowNodeRun>): DynamicWorkflowNodeRun {
  return {
    nodeId: 'n',
    phaseId: 'Desenvolvimento',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    durationMs: 0,
    toolUses: 0,
    costStatus: 'known',
    model: null,
    ...over,
  } as DynamicWorkflowNodeRun;
}

function node(nodeId: string, sprintId: string | null, phaseId = 'Desenvolvimento'): DynamicWorkflowNode {
  return { nodeId, sprintId, phaseId } as DynamicWorkflowNode;
}

describe('aggregateMetricsBySprint', () => {
  it('agrupa node_runs por sprint (join nodeId->sprintId) e soma metricas', () => {
    const nodes = [
      node('planner', null, 'Planejamento'),
      node('coder-s0', 's0'),
      node('fix-s0', 's0'),
      node('coder-s1', 's1'),
      node('delivery', null, 'Entrega'),
    ];
    const nodeRuns = [
      nodeRun({ nodeId: 'planner', phaseId: 'Planejamento', inputTokens: 100, outputTokens: 50, costUsd: 1, durationMs: 1000, toolUses: 1, model: 'gpt-5.5' }),
      nodeRun({ nodeId: 'coder-s0', inputTokens: 200, outputTokens: 80, costUsd: 2, durationMs: 2000, toolUses: 3 }),
      nodeRun({ nodeId: 'fix-s0', inputTokens: 50, outputTokens: 20, costUsd: 0.5, durationMs: 500, toolUses: 1 }),
      nodeRun({ nodeId: 'coder-s1', inputTokens: 300, outputTokens: 90, costUsd: 3, durationMs: 3000, toolUses: 2 }),
      nodeRun({ nodeId: 'delivery', phaseId: 'Entrega', inputTokens: 10, outputTokens: 5, costUsd: 0.1, durationMs: 100, toolUses: 0 }),
    ];

    const { rows, totals } = aggregateMetricsBySprint(nodeRuns, nodes);

    expect(rows.map((r) => r.key)).toEqual(['Planejamento', 's0', 's1', 'Entrega']);

    const s0 = rows.find((r) => r.key === 's0')!;
    expect(s0.isSprint).toBe(true);
    expect(s0.label).toBe('Sprint 0');
    expect(s0.nodeCount).toBe(2); // coder-s0 + fix-s0
    expect(s0.costUsd).toBeCloseTo(2.5);
    expect(s0.inputTokens).toBe(250);
    expect(s0.durationMs).toBe(2500);
    expect(s0.toolUses).toBe(4);

    const planning = rows.find((r) => r.key === 'Planejamento')!;
    expect(planning.isSprint).toBe(false);
    expect(planning.label).toBe('Planejamento');

    expect(totals.costUsd).toBeCloseTo(6.6);
    expect(totals.inputTokens).toBe(660);
    expect(totals.nodeCount).toBe(5);
    expect(totals.model).toBe('gpt-5.5');
  });

  it('conta custo nao estimado (costStatus != known) por grupo e no total', () => {
    const nodes = [node('coder-s0', 's0')];
    const nodeRuns = [
      nodeRun({ nodeId: 'coder-s0', costUsd: 0, costStatus: 'unknown' }),
    ];
    const { rows, totals } = aggregateMetricsBySprint(nodeRuns, nodes);
    expect(rows[0].unknownCostCount).toBe(1);
    expect(totals.unknownCostCount).toBe(1);
  });

  it('node sem entrada em nodes cai no phaseId do node_run', () => {
    const nodeRuns = [nodeRun({ nodeId: 'orfao', phaseId: 'Desenvolvimento', costUsd: 1 })];
    const { rows } = aggregateMetricsBySprint(nodeRuns, []);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('Desenvolvimento');
    expect(rows[0].isSprint).toBe(false);
  });

  it('prettifica sprint-01-... para Sprint 1', () => {
    const nodes = [node('c', 'sprint-01-fundacao-monorepo')];
    const nodeRuns = [nodeRun({ nodeId: 'c' })];
    const { rows } = aggregateMetricsBySprint(nodeRuns, nodes);
    expect(rows[0].label).toBe('Sprint 1');
  });

  it('run vazio -> sem rows, totais zerados', () => {
    const { rows, totals } = aggregateMetricsBySprint([], []);
    expect(rows).toHaveLength(0);
    expect(totals.costUsd).toBe(0);
    expect(totals.nodeCount).toBe(0);
  });
});


describe('D21: TotalPill exportada e aggregateCostBreakdown', () => {
  it('TotalPill e um componente exportado (reuso pela aba Custo, HandoffView intacto)', () => {
    expect(typeof TotalPill).toBe('function');
  });

  function cnr(over: Partial<CockpitNodeRun>): CockpitNodeRun {
    return {
      ...nodeRun({ toolUses: 1, apiRequests: 2 } as Partial<DynamicWorkflowNodeRun>),
      attempt: 0,
      agentId: null,
      ...over,
    } as CockpitNodeRun;
  }

  it('totais, por fase (primeira aparicao), por papel e top N por custo com flag de desconhecido', () => {
    const runs: CockpitNodeRun[] = [
      cnr({ nodeId: 'scout', phaseId: 'Docs', agentId: 'dynamic-workflow-scout', costUsd: 0, costStatus: 'unknown' }),
      cnr({ nodeId: 'cc:S1:u1:0', phaseId: 'S1', agentId: 'dynamic-workflow-coder', label: 'u1', costUsd: 0.5, durationMs: 1000, inputTokens: 10, outputTokens: 5 }),
      cnr({ nodeId: 'cc:S1:v1:0', phaseId: 'S1', agentId: 'dynamic-workflow-validator-spec', costUsd: 0.2 }),
      cnr({ nodeId: 'cc:S1:v2:0', phaseId: 'S1', agentId: 'dynamic-workflow-validator-tests', costUsd: 0.3 }),
      cnr({ nodeId: 'cc:S2:u2:0', phaseId: 'S2', agentId: 'dynamic-workflow-coder', costUsd: 0.7 }),
      cnr({ nodeId: 'cc:S2:f1:0', phaseId: 'S2', agentId: 'dynamic-workflow-fixer', costUsd: 0.1 }),
      cnr({ nodeId: 'cc:S2:u2:0', phaseId: 'S2', agentId: 'dynamic-workflow-coder', attempt: 1, costUsd: 0.4 }),
    ];
    const b = aggregateCostBreakdown(runs);
    expect(b.totals.nodeCount).toBe(7);
    expect(b.totals.costUsd).toBeCloseTo(2.2, 5);
    expect(b.totals.unknownCostCount).toBe(1);
    expect(b.totals.toolUses).toBe(7);
    expect(b.totals.apiRequests).toBe(14);
    expect(b.byPhase.map((p) => p.key)).toEqual(['Docs', 'S1', 'S2']);
    expect(b.byPhase[1].costUsd).toBeCloseTo(1.0, 5);
    expect(b.byPhase[2].nodeCount).toBe(3);
    expect(b.byRole.map((r) => r.key)).toEqual([
      'dynamic-workflow-scout',
      'dynamic-workflow-coder',
      'dynamic-workflow-validator-spec',
      'dynamic-workflow-validator-tests',
      'dynamic-workflow-fixer',
    ]);
    expect(b.byRole[1].costUsd).toBeCloseTo(1.6, 5);
    expect(b.topNodes.map((t) => t.nodeId)).toEqual([
      'cc:S2:u2:0',
      'cc:S1:u1:0',
      'cc:S1:v2:0',
      'cc:S1:v1:0',
      'cc:S2:f1:0',
    ]);
    expect(b.topNodes[0].costUsd).toBeCloseTo(1.1, 5);
    expect(b.topNodes[0].attempt).toBe(1);
    expect(b.topNodes[1].displayName).toBe('u1');
    const only = aggregateCostBreakdown([runs[0]]);
    expect(only.topNodes).toHaveLength(1);
    expect(only.topNodes[0]).toMatchObject({ nodeId: 'scout', displayName: 'dynamic-workflow-scout', costUnknown: true });
  });

  it('nome da fase vem do manifest quando existe; papel ausente vira "sem agente"', () => {
    const manifest: DynamicWorkflowManifest = {
      version: 1,
      name: 'wf',
      phases: [{ id: 'S1', name: 'Sprint 1', order: 0 }],
      nodes: [],
      parallelism: { maxConcurrentAgents: 1, parallelWritersAllowed: false },
      gates: [],
      estimate: { minUsd: 0, maxUsd: 0, unknownCostNodes: [] },
    };
    const b = aggregateCostBreakdown([cnr({ nodeId: 'n', phaseId: 'S1', costUsd: 1 })], manifest);
    expect(b.byPhase[0].label).toBe('Sprint 1');
    expect(b.byRole[0].key).toBe('sem agente');
  });

  it('vazio => buckets vazios e totais zerados', () => {
    const b = aggregateCostBreakdown([]);
    expect(b.byPhase).toEqual([]);
    expect(b.byRole).toEqual([]);
    expect(b.topNodes).toEqual([]);
    expect(b.totals.costUsd).toBe(0);
  });

  it('P2: fases e papeis em ordem de PRIMEIRA APARICAO por startedAt, nao alfabetica de nodeId', () => {
    const runs: CockpitNodeRun[] = [
      cnr({ nodeId: 'a-plano', phaseId: 'Plano', agentId: 'planner', costUsd: 0.3, startedAt: '2026-09-02T04:50:00.000Z' }),
      cnr({ nodeId: 'b-tech', phaseId: 'Tech', agentId: 'tech', costUsd: 0.2, startedAt: '2026-09-02T04:45:00.000Z' }),
      cnr({ nodeId: 'c-discovery', phaseId: 'Discovery', agentId: 'scout', costUsd: 0.1, startedAt: '2026-09-02T04:40:00.000Z' }),
    ];
    const b = aggregateCostBreakdown(runs);
    expect(b.byPhase.map((p) => p.key)).toEqual(['Discovery', 'Tech', 'Plano']);
    expect(b.byRole.map((r) => r.key)).toEqual(['scout', 'tech', 'planner']);
    const mixed = aggregateCostBreakdown([cnr({ nodeId: 'z', phaseId: 'Z', costUsd: 0 }), ...runs]);
    expect(mixed.byPhase.map((p) => p.key)).toEqual(['Discovery', 'Tech', 'Plano', 'Z']);
  });

  it('P3: attempt posterior sem label/agentId nao rebaixa o nome do top node (compara com id encurtado)', () => {
    const b = aggregateCostBreakdown([
      cnr({ nodeId: 'cc:S1:u1:0', phaseId: 'S1', agentId: 'dynamic-workflow-coder', label: 'u1', attempt: 0, costUsd: 0.5 }),
      cnr({ nodeId: 'cc:S1:u1:0', phaseId: 'S1', agentId: null, label: null, attempt: 1, costUsd: 0.1 }),
    ]);
    expect(b.topNodes).toHaveLength(1);
    expect(b.topNodes[0]).toMatchObject({ displayName: 'u1', attempt: 1, agentId: 'dynamic-workflow-coder' });
    expect(b.topNodes[0].costUsd).toBeCloseTo(0.6, 5);
  });

  it("P3: 'estimated-partial' conta como piso (~), nao como desconhecido (?)", () => {
    const b = aggregateCostBreakdown([
      cnr({ nodeId: 'a', phaseId: 'S1', costUsd: 0.4, costStatus: 'estimated-partial' }),
      cnr({ nodeId: 'b', phaseId: 'S1', costUsd: 0, costStatus: 'unknown' }),
      cnr({ nodeId: 'c', phaseId: 'S1', costUsd: 0.1, costStatus: 'known' }),
    ]);
    expect(b.totals.estimatedCostCount).toBe(1);
    expect(b.totals.unknownCostCount).toBe(1);
    expect(b.byPhase[0].estimatedCostCount).toBe(1);
    expect(b.topNodes.find((n) => n.nodeId === 'a')).toMatchObject({ costEstimated: true, costUnknown: false });
    expect(b.topNodes.find((n) => n.nodeId === 'b')).toMatchObject({ costEstimated: false, costUnknown: true });
  });

  it('P1 (ponta a ponta): node-started -> node-completed($0.50) -> node-cache-hit REAL mantem o total em $0.50', () => {
    const ev = (seq: number, type: string, payload: object): DynamicWorkflowEvent => ({
      id: seq,
      runId: 'r',
      nodeId: 'cc:S1:u-s1-ac1:0',
      phaseId: 'S1',
      seq,
      type,
      payloadJson: JSON.stringify(payload),
      createdAt: 'now',
    });
    const runs = deriveNodeRunsFromEvents('r', [
      ev(1, 'node-started', { attempt: 1, agentId: 'dynamic-workflow-coder', label: 'u-s1-ac1' }),
      ev(2, 'node-completed', { attempt: 1, costUsd: 0.5, durationMs: 120000, costStatus: 'known', runtime: 'cloud' }),
      ev(3, 'node-cache-hit', {
        inputHash: 'h',
        callIndex: 0,
        replay: 'journal',
        agentId: 'dynamic-workflow-coder',
        access: 'workspace-write',
        label: 'u-s1-ac1',
      }),
    ]);
    const b = aggregateCostBreakdown(runs);
    expect(b.totals.costUsd).toBeCloseTo(0.5, 5);
    expect(b.totals.durationMs).toBe(120000);
    expect(b.totals.unknownCostCount).toBe(0);
    expect(b.totals.nodeCount).toBe(1);
  });
});
