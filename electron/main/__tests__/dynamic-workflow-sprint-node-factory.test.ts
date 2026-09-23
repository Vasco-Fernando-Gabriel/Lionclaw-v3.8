import { describe, it, expect } from 'vitest';
import { buildDevSprintNodes } from '../dynamic-workflows/sprint-node-factory';
import {
  createWorkflowHostApi,
  WorkflowHostFatalError,
  type HostApiCrud,
  type HostApiDeps,
  type HostApiRunContext,
} from '../dynamic-workflows/workflow-host-api';
import type {
  DynamicWorkflowManifest,
  DynamicWorkflowNodeCreateInput,
  DynamicWorkflowSprintPlan,
  DynamicWorkflowSprintUpsertInput,
  PlannedSprint,
} from '../dynamic-workflows/types';
import { DYNAMIC_WORKFLOW_SPRINT_PLANNER_ID } from '../seed-agents/dynamic-workflow-sprint-planner';
import { DYNAMIC_WORKFLOW_CODER_ID } from '../seed-agents/dynamic-workflow-coder';
import { DYNAMIC_WORKFLOW_VALIDATOR_SPEC_ID } from '../seed-agents/dynamic-workflow-validator-spec';
import { DYNAMIC_WORKFLOW_VALIDATOR_REGRESSION_ID } from '../seed-agents/dynamic-workflow-validator-regression';
import { DYNAMIC_WORKFLOW_VALIDATOR_TESTS_ID } from '../seed-agents/dynamic-workflow-validator-tests';
import { DYNAMIC_WORKFLOW_REFUTER_ID } from '../seed-agents/dynamic-workflow-refuter';
import {
  devCoderNodeId,
  devFixNodeId,
  devFixerNodeId,
  devRedevFixerNodeId,
  devRefuterNodeId,
  devSprintId,
  devValidatorGroupId,
  devValidatorNodeId,
  devRoundValidatorNodeIds,
  DEV_DEFAULT_FIXER_AGENT_ID,
  DEV_DEFAULT_VALIDATOR_AGENT_IDS,
} from '../dynamic-workflows/dev-loop-ids';

const SPECIALIST_CODER = DYNAMIC_WORKFLOW_CODER_ID;

function fixtureSprint(index: number, writeSetHint: string[]): PlannedSprint {
  return {
    id: devSprintId(index),
    index,
    name: `Sprint ${index}`,
    description: `entregar a parte ${index}`,
    stack: ['typescript'],
    coderAgentId: SPECIALIST_CODER,
    validatorAgentIds: [
      DYNAMIC_WORKFLOW_VALIDATOR_SPEC_ID,
      DYNAMIC_WORKFLOW_VALIDATOR_REGRESSION_ID,
      DYNAMIC_WORKFLOW_VALIDATOR_TESTS_ID,
    ],
    features: [{ id: `f${index}`, name: `feature ${index}`, acceptanceCriteria: ['tsc verde'] }],
    writeSetHint,
    dependencies: index > 0 ? [devSprintId(index - 1)] : [],
    maxRounds: 3,
  };
}

function fixturePlan(): DynamicWorkflowSprintPlan {
  return {
    planVersion: 1,
    planHash: 'hash-v1',
    sprints: [fixtureSprint(0, ['src/a/**']), fixtureSprint(1, [])],
  };
}

const MAX_DEV_ROUNDS = 3;
let idSeq = 0;
const genId = (prefix: string): string => `${prefix}_${idSeq++}`;

describe('buildDevSprintNodes: contrato de ids do C1', () => {
  it('expande coder/validadores/fix por sprint+rodada com os ids EXATOS do C1', () => {
    const plan = fixturePlan();
    const { sprintNodeIds } = buildDevSprintNodes(plan, { maxDevRounds: MAX_DEV_ROUNDS }, genId);

    expect(sprintNodeIds.map((s) => s.sprintId)).toEqual(['s0', 's1']);

    for (const sprint of plan.sprints) {
      const expected: string[] = [];
      const vCount = sprint.validatorAgentIds.length;
      for (let r = 0; r < MAX_DEV_ROUNDS; r++) {
        expected.push(devCoderNodeId(sprint.index, r));
        for (const v of devRoundValidatorNodeIds(sprint.index, r, vCount)) expected.push(v);
        expected.push(devRefuterNodeId(sprint.index, r));
        expected.push(devFixNodeId(sprint.index, r));
      }
      const got = sprintNodeIds.find((s) => s.sprintId === devSprintId(sprint.index));
      expect(got?.nodeIds).toEqual(expected);
    }
  });

  it('manifestNodes carregam sprintId/roundIndex explicitos (sem regex, sec 9.5)', () => {
    const { manifestNodes } = buildDevSprintNodes(fixturePlan(), { maxDevRounds: 2 }, genId);
    for (const node of manifestNodes) {
      expect(node.sprintId).toMatch(/^s\d+$/);
      expect(typeof node.roundIndex).toBe('number');
    }
    const s0r0Coder = manifestNodes.find((n) => n.id === devCoderNodeId(0, 0));
    const s0r1Coder = manifestNodes.find((n) => n.id === devCoderNodeId(0, 1));
    expect(s0r0Coder?.roundIndex).toBe(0);
    expect(s0r1Coder?.roundIndex).toBe(1);
  });

  it('coder/fix sao writers (TETO compativel com o .js); validadores read-only', () => {
    const { manifestNodes } = buildDevSprintNodes(fixturePlan(), { maxDevRounds: 1 }, genId);
    const coder = manifestNodes.find((n) => n.id === devCoderNodeId(0, 0))!;
    expect(coder.access).toBe('workspace-write');
    expect(coder.isolation).toBe('run-workspace');
    expect(coder.allowBash).toBe(true);
    expect(coder.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
    expect(coder.allowedCommands).toEqual(['npm run typecheck', 'npm run test', 'npm install', 'npm ci']);
    expect(coder.allowNetwork).toBe(true);
    expect(coder.agentId).toBe(SPECIALIST_CODER);
    expect(coder.schemaRef).toBeUndefined();

    const fix = manifestNodes.find((n) => n.id === devFixNodeId(0, 0))!;
    expect(fix.access).toBe('workspace-write');
    expect(fix.agentId).toBe(SPECIALIST_CODER);
    expect(fix.schemaRef).toBeUndefined();
    expect(fix.allowedCommands).toEqual(['npm run typecheck', 'npm run test', 'npm install', 'npm ci']);
    expect(fix.allowNetwork).toBe(true);

    const s0 = fixturePlan().sprints[0];
    s0.validatorAgentIds.forEach((validatorAgentId, vi) => {
      const v = manifestNodes.find((n) => n.id === devValidatorNodeId(vi, 0, 0))!;
      expect(v.access).toBe('read-only');
      expect(v.agentId).toBe(validatorAgentId);
      expect(v.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
      expect(v.allowBash).toBeUndefined();
      expect(v.allowNetwork).toBeUndefined();
      expect(v.allowedCommands).toBeUndefined();
      expect(v.schemaRef).toBe('schemas/validator.schema.json');
    });

    const group = manifestNodes.find((n) => n.id === devValidatorGroupId(0, 0))!;
    expect(group.type).toBe('parallel');
  });

  it('F2-S7: o no refuter e read-only, agentId FIXO dynamic-workflow-refuter, declara schemaRef de refute', () => {
    const { manifestNodes } = buildDevSprintNodes(fixturePlan(), { maxDevRounds: 1 }, genId);
    const refuter = manifestNodes.find((n) => n.id === devRefuterNodeId(0, 0))!;
    expect(refuter).toBeTruthy();
    expect(refuter.type).toBe('agent');
    expect(refuter.access).toBe('read-only');
    expect(refuter.agentId).toBe(DYNAMIC_WORKFLOW_REFUTER_ID);
    expect(refuter.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    expect(refuter.allowBash).toBeUndefined();
    expect(refuter.allowNetwork).toBeUndefined();
    expect(refuter.allowedCommands).toBeUndefined();
    expect(refuter.schemaRef).toBe('schemas/refute.schema.json');
    expect(refuter.sprintId).toBe(devSprintId(0));
    expect(refuter.roundIndex).toBe(0);
  });

  it('writeSet = writeSetHint do plano + globs de teste sempre permitidos (writer SEM writeSet reprovaria, 7.4)', () => {
    const { manifestNodes } = buildDevSprintNodes(fixturePlan(), { maxDevRounds: 1 }, genId);
    const s0coder = manifestNodes.find((n) => n.id === devCoderNodeId(0, 0))!;
    expect(s0coder.writeSet).toEqual([
      'src/a/**',
      'tests/**',
      'test/**',
      '**/tests/**',
      '**/test/**',
      '**/__tests__/**',
      '**/*.test.*',
      '**/*.spec.*',
    ]);
    const s1coder = manifestNodes.find((n) => n.id === devCoderNodeId(1, 0))!;
    expect(s1coder.writeSet).toEqual(['**']);
  });

  it('FASE 4b-D3: honra sprint.validatorAgentIds - 1 validador node por agente, agentId casa, id por indice', () => {
    const custom: PlannedSprint = {
      ...fixtureSprint(0, ['src/**']),
      validatorAgentIds: ['agente-validador-A', 'agente-validador-B'],
    };
    const plan: DynamicWorkflowSprintPlan = {
      planVersion: 1,
      planHash: 'hash-custom',
      sprints: [custom],
    };
    const { manifestNodes, sprintNodeIds } = buildDevSprintNodes(plan, { maxDevRounds: 1 }, genId);

    expect(manifestNodes.find((n) => n.id === devValidatorNodeId(0, 0, 0))?.agentId).toBe('agente-validador-A');
    expect(manifestNodes.find((n) => n.id === devValidatorNodeId(1, 0, 0))?.agentId).toBe('agente-validador-B');
    expect(manifestNodes.some((n) => n.id === devValidatorNodeId(2, 0, 0))).toBe(false);

    const s0 = sprintNodeIds.find((s) => s.sprintId === devSprintId(0))!;
    expect(s0.nodeIds).toEqual([
      devCoderNodeId(0, 0),
      devValidatorNodeId(0, 0, 0),
      devValidatorNodeId(1, 0, 0),
      devRefuterNodeId(0, 0),
      devFixNodeId(0, 0),
    ]);
  });

  it('FASE 4b-D3: validatorAgentIds vazio cai no default dos 3 de codigo (defensivo)', () => {
    const empty: PlannedSprint = {
      ...fixtureSprint(0, ['src/**']),
      validatorAgentIds: [],
    };
    const plan: DynamicWorkflowSprintPlan = {
      planVersion: 1,
      planHash: 'hash-empty',
      sprints: [empty],
    };
    const { manifestNodes } = buildDevSprintNodes(plan, { maxDevRounds: 1 }, genId);
    DEV_DEFAULT_VALIDATOR_AGENT_IDS.forEach((agentId, vi) => {
      expect(manifestNodes.find((n) => n.id === devValidatorNodeId(vi, 0, 0))?.agentId).toBe(agentId);
    });
    expect(manifestNodes.some((n) => n.id === devValidatorNodeId(DEV_DEFAULT_VALIDATOR_AGENT_IDS.length, 0, 0))).toBe(
      false,
    );
  });

  it('createInputs: 1 por node, definitionId placeholder (a CRUD do runner sobrescreve)', () => {
    const { manifestNodes, createInputs } = buildDevSprintNodes(fixturePlan(), { maxDevRounds: MAX_DEV_ROUNDS }, genId);
    expect(createInputs.length).toBe(manifestNodes.length);
    for (const ci of createInputs) {
      expect(ci.definitionId).toBe('');
      expect(ci.nodeId.length).toBeGreaterThan(0);
    }
    const coderInput = createInputs.find((c) => c.nodeId === devCoderNodeId(0, 0))!;
    expect(coderInput.access).toBe('workspace-write');
    expect(coderInput.schemaRef).toBeNull();
  });

  it('DETERMINISTICO: mesma entrada -> mesma saida (modulo o id de row opaco)', () => {
    const a = buildDevSprintNodes(fixturePlan(), { maxDevRounds: 2 }, (p) => `${p}_X`);
    const b = buildDevSprintNodes(fixturePlan(), { maxDevRounds: 2 }, (p) => `${p}_X`);
    expect(a.manifestNodes).toEqual(b.manifestNodes);
    expect(a.sprintNodeIds).toEqual(b.sprintNodeIds);
  });

  it('FIX-F2b: cada sprint pre-expande ate o SEU maxRounds (abaixo do teto global)', () => {
    const plan: DynamicWorkflowSprintPlan = {
      planVersion: 1,
      planHash: 'hash-f2b',
      sprints: [
        { ...fixtureSprint(0, ['src/a/**']), maxRounds: 1 },
        { ...fixtureSprint(1, ['src/b/**']), maxRounds: 3 },
      ],
    };
    const { manifestNodes, sprintNodeIds } = buildDevSprintNodes(plan, { maxDevRounds: 3 }, genId);

    expect(manifestNodes.some((n) => n.id === devCoderNodeId(0, 0))).toBe(true);
    expect(manifestNodes.some((n) => n.id === devCoderNodeId(0, 1))).toBe(false);
    expect(manifestNodes.some((n) => n.id === devFixNodeId(0, 1))).toBe(false);

    expect(manifestNodes.some((n) => n.id === devCoderNodeId(1, 2))).toBe(true);
    expect(manifestNodes.some((n) => n.id === devFixNodeId(1, 2))).toBe(true);

    const vCount = plan.sprints[0].validatorAgentIds.length;
    const idsPerRound = 1 + vCount + 1 + 1;
    const s0 = sprintNodeIds.find((s) => s.sprintId === devSprintId(0))!;
    const s1 = sprintNodeIds.find((s) => s.sprintId === devSprintId(1))!;
    expect(s0.nodeIds.length).toBe(idsPerRound * 1);
    expect(s1.nodeIds.length).toBe(idsPerRound * 3);
  });

  it('FIX-F2b: sprint.maxRounds ACIMA do teto global e clampado (nunca chama node fora do manifest)', () => {
    const plan: DynamicWorkflowSprintPlan = {
      planVersion: 1,
      planHash: 'hash-clamp',
      sprints: [{ ...fixtureSprint(0, ['src/**']), maxRounds: 10 }],
    };
    const { manifestNodes } = buildDevSprintNodes(plan, { maxDevRounds: 2 }, genId);
    expect(manifestNodes.some((n) => n.id === devCoderNodeId(0, 1))).toBe(true);
    expect(manifestNodes.some((n) => n.id === devCoderNodeId(0, 2))).toBe(false);
  });
});

describe('buildDevSprintNodes: fresh fixer (fechamento S6)', () => {
  it('materializa fixer-s{S}-r{R} por sprint+rodada com o fixer dedicado e grants de writer', () => {
    const { manifestNodes } = buildDevSprintNodes(
      fixturePlan(),
      { maxDevRounds: 2, fixerAgentId: DEV_DEFAULT_FIXER_AGENT_ID },
      genId,
    );
    for (const sprintIndex of [0, 1]) {
      for (let r = 0; r < 2; r++) {
        const fixer = manifestNodes.find((n) => n.id === devFixerNodeId(sprintIndex, r))!;
        expect(fixer).toBeTruthy();
        expect(fixer.type).toBe('agent');
        expect(fixer.agentId).toBe(DEV_DEFAULT_FIXER_AGENT_ID);
        expect(fixer.sprintId).toBe(devSprintId(sprintIndex));
        expect(fixer.roundIndex).toBe(r);
        expect(fixer.access).toBe('workspace-write');
        expect(fixer.isolation).toBe('run-workspace');
        expect(fixer.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
        expect(fixer.allowedCommands).toEqual(['npm run typecheck', 'npm run test', 'npm install', 'npm ci']);
        expect(fixer.allowBash).toBe(true);
        expect(fixer.allowNetwork).toBe(true);
        expect(fixer.schemaRef).toBeUndefined();
        const fix = manifestNodes.find((n) => n.id === devFixNodeId(sprintIndex, r))!;
        expect(fixer.writeSet).toEqual(fix.writeSet);
        expect(fixer.timeoutMs).toBe(fix.timeoutMs);
      }
    }
  });

  it('config.fixerAgentId ausente (undefined) usa o default do dominio (checagem pulada)', () => {
    const { manifestNodes } = buildDevSprintNodes(fixturePlan(), { maxDevRounds: 1 }, genId);
    const fixer = manifestNodes.find((n) => n.id === devFixerNodeId(0, 0))!;
    expect(fixer.agentId).toBe(DEV_DEFAULT_FIXER_AGENT_ID);
  });

  it('fail-safe: config.fixerAgentId === null (fixer fora do catalogo) cai pro coder da sprint', () => {
    const { manifestNodes } = buildDevSprintNodes(fixturePlan(), { maxDevRounds: 1, fixerAgentId: null }, genId);
    const fixer = manifestNodes.find((n) => n.id === devFixerNodeId(0, 0))!;
    expect(fixer.agentId).toBe(SPECIALIST_CODER);
  });

  it('pre-expande o fixer tambem nas rodadas de RE-DEV (fixer-s{S}-redev{N}-r{R}), fora de sprintNodeIds', () => {
    const { manifestNodes, sprintNodeIds } = buildDevSprintNodes(
      fixturePlan(),
      { maxDevRounds: 2, fixerAgentId: DEV_DEFAULT_FIXER_AGENT_ID },
      genId,
    );
    expect(manifestNodes.some((n) => n.id === devRedevFixerNodeId(0, 1, 0))).toBe(true);
    expect(manifestNodes.some((n) => n.id === devRedevFixerNodeId(0, 2, 1))).toBe(true);
    for (const s of sprintNodeIds) {
      expect(s.nodeIds.some((id) => id.startsWith('fixer-'))).toBe(false);
    }
  });

  it('DETERMINISTICO com o fixer: mesma entrada -> mesma saida (modulo o id de row opaco)', () => {
    const a = buildDevSprintNodes(
      fixturePlan(),
      { maxDevRounds: 2, fixerAgentId: DEV_DEFAULT_FIXER_AGENT_ID },
      (p) => `${p}_X`,
    );
    const b = buildDevSprintNodes(
      fixturePlan(),
      { maxDevRounds: 2, fixerAgentId: DEV_DEFAULT_FIXER_AGENT_ID },
      (p) => `${p}_X`,
    );
    expect(a.manifestNodes).toEqual(b.manifestNodes);
    expect(a.sprintNodeIds).toEqual(b.sprintNodeIds);
  });
});

function planningManifest(): DynamicWorkflowManifest {
  return {
    version: 1,
    name: 'wf-mat-test',
    phases: [
      { id: 'Planejamento', name: 'Planejamento', order: 0 },
      { id: 'Desenvolvimento', name: 'Desenvolvimento', order: 1 },
      { id: 'Entrega', name: 'Entrega', order: 2 },
    ],
    nodes: [
      {
        id: 'planner-r0',
        type: 'agent',
        phaseId: 'Planejamento',
        agentId: DYNAMIC_WORKFLOW_SPRINT_PLANNER_ID,
        access: 'read-only',
        allowedTools: ['Read', 'Glob', 'Grep'],
        canResume: true,
        produces: ['sprint-plan-r0'],
        consumes: ['spec'],
      },
    ],
    parallelism: { maxConcurrentAgents: 3, parallelWritersAllowed: false },
    gates: [],
    estimate: { minUsd: 0, maxUsd: 60, unknownCostNodes: [] },
  };
}

interface MatHarness {
  deps: HostApiDeps;
  createdNodes: DynamicWorkflowNodeCreateInput[];
  persistedSprints: DynamicWorkflowSprintUpsertInput[];
  definitionPatches: Array<Record<string, unknown>>;
  events: string[];
}

function makeMatHarness(): MatHarness {
  const createdNodes: DynamicWorkflowNodeCreateInput[] = [];
  const persistedSprints: DynamicWorkflowSprintUpsertInput[] = [];
  const definitionPatches: Array<Record<string, unknown>> = [];
  const events: string[] = [];

  const crud: HostApiCrud = {
    upsertNodeRun: () => {
      throw new Error('nao usado neste teste');
    },
    updateNodeRun: () => undefined,
    insertEvent: () => ({}) as never,
    insertGateDecision: () => ({}) as never,
    registerArtifact: () => ({}) as never,
    getRunCheckpoint: () => '{}',
    persistRunCheckpoint: () => undefined,
    addRunCost: () => undefined,
    patchRun: () => undefined,
    createNodes: (_definitionId, nodes) => {
      for (const n of nodes) createdNodes.push(n);
    },
    updateDefinition: (_definitionId, patch) => definitionPatches.push({ ...patch }),
    persistSprints: (sprints) => {
      for (const s of sprints) persistedSprints.push(s);
    },
  };

  return {
    deps: {
      crud,
      gateGate: { awaitDecision: () => new Promise(() => {}) },
      emit: (input) => events.push(input.type),
      generateId: genId,
      now: () => '2026-06-13T00:00:00.000Z',
    },
    createdNodes,
    persistedSprints,
    definitionPatches,
    events,
  };
}

function makeMatCtx(over?: Partial<HostApiRunContext>): HostApiRunContext {
  return {
    runId: 'run-mat',
    manifest: planningManifest(),
    workspaceRoot: '/tmp/ws',
    runDir: '/tmp/ws/.lionclaw/workflows/run-mat',
    definitionId: 'def-1',
    projectPath: '/tmp/ws',
    sprintPlanConfig: { maxDevRounds: MAX_DEV_ROUNDS },
    catalogAgentIds: [
      DYNAMIC_WORKFLOW_SPRINT_PLANNER_ID,
      SPECIALIST_CODER,
      DYNAMIC_WORKFLOW_VALIDATOR_SPEC_ID,
      DYNAMIC_WORKFLOW_VALIDATOR_REGRESSION_ID,
      DYNAMIC_WORKFLOW_VALIDATOR_TESTS_ID,
      DYNAMIC_WORKFLOW_REFUTER_ID,
    ],
    schemaFileNames: [
      'sprint-plan.schema.json',
      'plan-findings.schema.json',
      'impl.schema.json',
      'validator.schema.json',
      'refute.schema.json',
    ],
    buildSprintNodes: (plan, cfg) => buildDevSprintNodes(plan, cfg, genId),
    abortSignal: new AbortController().signal,
    ...over,
  };
}

describe('materializeSprintPlan + buildDevSprintNodes (integracao)', () => {
  it('materializa o grafo de DEV, valida LIMPO como pacote runtime e persiste', async () => {
    const harness = makeMatHarness();
    const ctx = makeMatCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);

    const out = (await api.materializeSprintPlan(fixturePlan())) as {
      sprints: Array<{ sprintId: string; nodeIds: string[] }>;
      planVersion: number;
    };

    expect(out.planVersion).toBe(1);
    expect(out.sprints.map((s) => s.sprintId)).toEqual(['s0', 's1']);

    const idsInManifest = new Set(ctx.manifest.nodes.map((n) => n.id));
    expect(idsInManifest.has(devCoderNodeId(0, 0))).toBe(true);
    expect(idsInManifest.has(devFixNodeId(1, MAX_DEV_ROUNDS - 1))).toBe(true);

    expect(harness.createdNodes.length).toBeGreaterThan(0);
    expect(harness.persistedSprints.map((s) => s.sprintId)).toEqual(['s0', 's1']);
    expect(harness.definitionPatches.length).toBe(1);
    expect(harness.events).toContain('sprint-plan-materialized');
  });

  it('IDEMPOTENTE no resume: mesma versao+hash = no-op (nao re-cria nodes)', async () => {
    const harness = makeMatHarness();
    const ctx = makeMatCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);

    await api.materializeSprintPlan(fixturePlan());
    const nodesAfterFirst = harness.createdNodes.length;
    const out2 = (await api.materializeSprintPlan(fixturePlan())) as {
      sprints: Array<{ sprintId: string }>;
    };

    expect(harness.createdNodes.length).toBe(nodesAfterFirst);
    expect(out2.sprints.map((s) => s.sprintId)).toEqual(['s0', 's1']);
  });

  it('mesma planVersion com planHash DIFERENTE = FATAL (inconsistencia, sec 5.1)', async () => {
    const harness = makeMatHarness();
    const ctx = makeMatCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);

    await api.materializeSprintPlan(fixturePlan());
    const tampered: DynamicWorkflowSprintPlan = { ...fixturePlan(), planHash: 'hash-OUTRO' };
    await expect(api.materializeSprintPlan(tampered)).rejects.toBeInstanceOf(WorkflowHostFatalError);
  });

  it('agentId fora do catalogo no plano -> REMAPEIA pro coder fallback (SM-25, regra maxima: NAO crasha)', async () => {
    const harness = makeMatHarness();
    const ctx = makeMatCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);

    const badPlan: DynamicWorkflowSprintPlan = {
      planVersion: 1,
      planHash: 'hash-bad',
      sprints: [{ ...fixtureSprint(0, ['src/**']), coderAgentId: 'agente-fantasma' }],
    };
    await expect(api.materializeSprintPlan(badPlan)).resolves.toBeTruthy();
    expect(harness.createdNodes.length).toBeGreaterThan(0);
    expect(harness.createdNodes.some((n) => n.agentId === 'agente-fantasma')).toBe(false);
    expect(harness.createdNodes.some((n) => n.agentId === DYNAMIC_WORKFLOW_CODER_ID)).toBe(true);
  });
});
