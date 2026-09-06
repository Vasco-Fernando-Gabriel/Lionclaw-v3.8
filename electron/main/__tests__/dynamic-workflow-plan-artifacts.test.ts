
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderPlanMarkdown, emitPlanArtifacts } from '../dynamic-workflows/workflow-host-api';
import type { WorkflowArtifactsDeps } from '../dynamic-workflows/workflow-artifacts';
import type {
  DynamicWorkflowArtifact,
  DynamicWorkflowArtifactInsertInput,
  DynamicWorkflowSprintPlan,
} from '../dynamic-workflows/types';

let runDir: string;

function makePlan(): DynamicWorkflowSprintPlan {
  return {
    planVersion: 2,
    planHash: 'abc123',
    sprints: [
      {
        id: 's0',
        index: 0,
        name: 'Fundacao',
        description: 'Cria o schema base',
        stack: ['ts', 'sqlite'],
        coderAgentId: 'harness-coder',
        validatorAgentIds: ['v1', 'v2'],
        features: [
          { id: 'f1', name: 'tabela X', acceptanceCriteria: ['existe a tabela', 'tem indice'] },
        ],
        writeSetHint: ['db.ts'],
        dependencies: [],
        maxRounds: 3,
      },
      {
        id: 's1',
        index: 1,
        name: 'UI',
        description: 'Tela nova',
        stack: ['react'],
        coderAgentId: 'harness-coder',
        validatorAgentIds: ['v1'],
        features: [],
        writeSetHint: ['src/ui.tsx'],
        dependencies: ['s0'],
        maxRounds: 4,
      },
    ],
  };
}

function makeDeps(): {
  deps: WorkflowArtifactsDeps;
  registered: DynamicWorkflowArtifactInsertInput[];
} {
  const registered: DynamicWorkflowArtifactInsertInput[] = [];
  let n = 0;
  const deps: WorkflowArtifactsDeps = {
    registerArtifact: (input: DynamicWorkflowArtifactInsertInput): DynamicWorkflowArtifact => {
      registered.push(input);
      return {
        id: input.id,
        runId: input.runId,
        nodeId: input.nodeId ?? null,
        kind: input.kind,
        path: input.path,
        sha256: input.sha256,
        metadataJson: input.metadataJson ?? '{}',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
    },
    generateId: () => `art-${++n}`,
  };
  return { deps, registered };
}

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'dwf-plan-'));
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe('renderPlanMarkdown (plan.md legivel)', () => {
  it('lista versao/hash, sprints, agentes, features e acceptance criteria', () => {
    const md = renderPlanMarkdown(makePlan(), [{ sprintIds: ['s0'] }, { sprintIds: ['s1'] }]);
    expect(md).toContain('# Plano de sprints (versao 2)');
    expect(md).toContain('planHash: abc123');
    expect(md).toContain('## s0 - Fundacao');
    expect(md).toContain('coder: harness-coder');
    expect(md).toContain('validadores: v1, v2');
    expect(md).toContain('depende de: s0'); // s1 depende de s0
    expect(md).toContain('f1: tabela X');
    expect(md).toContain('[ ] existe a tabela');
    expect(md).toContain('sequencial'); // sem batch paralelo
  });

  it('mostra batches paralelos quando ha grupo com mais de 1 sprint', () => {
    const md = renderPlanMarkdown(makePlan(), [{ sprintIds: ['s0', 's1'] }]);
    expect(md).toContain('batches paralelos: [s0, s1]');
  });
});

describe('emitPlanArtifacts (grava no run dir + registra)', () => {
  it('escreve plan.md e sprints.json e registra os dois artefatos', () => {
    const { deps, registered } = makeDeps();
    const plan = makePlan();
    emitPlanArtifacts(deps, {
      runId: 'run-1',
      runDir,
      plan,
      parallelGroups: [{ sprintIds: ['s0'] }, { sprintIds: ['s1'] }],
    });

    const planPath = join(runDir, 'plan.md');
    const sprintsPath = join(runDir, 'sprints.json');
    expect(existsSync(planPath)).toBe(true);
    expect(existsSync(sprintsPath)).toBe(true);

    const planMd = readFileSync(planPath, 'utf8');
    expect(planMd).toContain('# Plano de sprints (versao 2)');

    const sprintsJson = JSON.parse(readFileSync(sprintsPath, 'utf8'));
    expect(sprintsJson.planVersion).toBe(2);
    expect(sprintsJson.planHash).toBe('abc123');
    expect(sprintsJson.sprints).toHaveLength(2);

    expect(registered.map((r) => r.kind).sort()).toEqual(['plan', 'sprints']);
    for (const r of registered) {
      expect(r.runId).toBe('run-1');
      expect(JSON.parse(r.metadataJson ?? '{}').planVersion).toBe(2);
    }
  });

  it('best-effort: erro de registro nao propaga (materialize nao pode cair)', () => {
    const failingDeps: WorkflowArtifactsDeps = {
      registerArtifact: () => {
        throw new Error('db indisponivel');
      },
      generateId: () => 'x',
    };
    expect(() =>
      emitPlanArtifacts(failingDeps, {
        runId: 'run-1',
        runDir,
        plan: makePlan(),
        parallelGroups: [],
      }),
    ).not.toThrow();
  });
});
