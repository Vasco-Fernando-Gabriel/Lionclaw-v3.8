
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));

vi.mock('../paths', () => ({ getLionClawHome: () => state.root }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, shell: {} }));

import {
  getDb,
  getPipelineMetrics,
  getRoundDetailsForSprint,
  initDatabase,
  insertHarnessProject,
  insertHarnessRound,
  insertHarnessSprint,
  savePipelinePhaseMetrics,
} from '../db';
import type { HarnessConfig, PipelineType } from '../../../src/types';

beforeAll(() => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-bug-metrics-'));
  initDatabase();
});

afterAll(() => {
  try {
    getDb().close();
  } catch {
  }
  fs.rmSync(state.root, { recursive: true, force: true });
});

const CONFIG: HarnessConfig = {
  maxRoundsPerSprint: 3,
  usePlaywright: false,
  evaluatorAgentId: 'harness-evaluator',
  plannerAgentId: 'harness-planner',
  stack: [],
};

let projectSeq = 0;
function mkProject(pipelineType: PipelineType): string {
  projectSeq += 1;
  return insertHarnessProject({
    name: `p-${pipelineType}-${projectSeq}`,
    projectPath: '/tmp/lionclaw-fixture',
    specPath: '/tmp/lionclaw-fixture/SPEC.md',
    config: CONFIG,
    pipelineType,
  }).id;
}

function seedPhaseRow(
  projectId: string,
  pipelineType: string,
  phaseNumber: number,
  opts: { sprintIndex?: number; durationMs?: number } = {},
): void {
  savePipelinePhaseMetrics({
    projectId,
    phaseNumber,
    phaseName: `Phase ${phaseNumber}`,
    status: 'completed',
    model: `model-${pipelineType}-p${phaseNumber}`,
    durationMs: opts.durationMs ?? 0,
    sprintIndex: opts.sprintIndex ?? 0,
  });
}

function sprintPhaseNumbers(projectId: string): number[] {
  return getPipelineMetrics(projectId)
    .sprintPhases.map((p) => p.phaseNumber)
    .sort((a, b) => a - b);
}


const SITE5_FIXTURE: Record<string, number[]> = {
  development: [10, 11, 13, 14],
  feature: [10, 11, 13, 14],
  security: [10, 11, 13, 14],
  'architecture-review': [10, 11, 13, 14],
  'development-v2': [10, 11, 13, 14, 16, 17],
};

const SITE4_FIXTURE: Record<string, number[]> = {
  development: [13, 14],
  feature: [13, 14],
  security: [10, 11, 13, 14],
  'architecture-review': [10, 11, 13, 14],
  'development-v2': [13, 14, 16, 17],
};


const BASELINE_SITE4: Record<string, { coderModel: string; evaluatorModel: string }> = {
  development: {
    coderModel: 'model-development-p13',
    evaluatorModel: 'model-development-p14',
  },
  feature: {
    coderModel: 'model-feature-p13',
    evaluatorModel: 'model-feature-p14',
  },
  security: {
    coderModel: 'model-security-p10',
    evaluatorModel: 'model-security-p11',
  },
  'architecture-review': {
    coderModel: 'model-architecture-review-p10',
    evaluatorModel: 'model-architecture-review-p11',
  },
  'development-v2': {
    coderModel: 'model-development-v2-p13',
    evaluatorModel: 'model-development-v2-p14',
  },
};

const BASELINE_SITE5: Record<string, number[]> = {
  development: [10, 11, 13, 14],
  feature: [10, 11, 13, 14],
  security: [10, 11, 13, 14],
  'architecture-review': [10, 11, 13, 14],
  'development-v2': [10, 11, 13, 14, 16, 17],
};

const DELTA_SITE5_REMOVED: Record<string, number[]> = {
  development: [10, 11], // Spec Enricher + Planner
  feature: [10, 11], // Spec Enricher + Planner
  security: [], // nenhuma (8/9 nunca entram: e o ponto da correcao)
  'architecture-review': [], // nenhuma
  'development-v2': [10, 11], // Frontend Tecnico + Security
};

const EXISTING_TYPES = [
  'development',
  'feature',
  'security',
  'architecture-review',
  'development-v2',
] as const;


describe('TB-25a — security: fases 8/9 fora de sprintPhases', () => {
  it('projeto security com linhas 8, 9, 10 e 11 classifica so 10 e 11', () => {
    const projectId = mkProject('security');
    for (const n of [8, 9, 10, 11]) seedPhaseRow(projectId, 'security', n);
    expect(sprintPhaseNumbers(projectId)).toEqual([10, 11]);
  });

  it('projeto architecture-review: idem (8 = Planner, 9 = Sprint Validator)', () => {
    const projectId = mkProject('architecture-review');
    for (const n of [8, 9, 10, 11]) seedPhaseRow(projectId, 'architecture-review', n);
    expect(sprintPhaseNumbers(projectId)).toEqual([10, 11]);
  });

  it('projeto bug: as fases 8/9 SAO as fases de sprint (contraprova)', () => {
    const projectId = mkProject('bug');
    for (const n of [1, 2, 3, 8, 9]) seedPhaseRow(projectId, 'bug', n);
    expect(sprintPhaseNumbers(projectId)).toEqual([8, 9]);
  });
});


describe('TB-25b — sprintPhases por tipo: so o delta da secao 4.11', () => {
  for (const type of EXISTING_TYPES) {
    it(`${type}: baseline flat menos o delta declarado`, () => {
      const projectId = mkProject(type);
      for (const n of SITE5_FIXTURE[type]) seedPhaseRow(projectId, type, n);
      const expected = BASELINE_SITE5[type].filter(
        (n) => !DELTA_SITE5_REMOVED[type].includes(n),
      );
      expect(sprintPhaseNumbers(projectId)).toEqual(expected);
    });
  }
});


describe('TB-25c — linha agregada fora de reportablePhases', () => {
  function insertLegacyAggregateRow(projectId: string, durationMs: number): void {
    getDb()
      .prepare(
        `INSERT INTO pipeline_phase_metrics
           (project_id, phase_number, phase_name, agent_id, status, duration_ms, sprint_index, metadata)
         VALUES (?, 2, 'Security Audit', 'multi-agent', 'completed', ?, -1, '{}')`,
      )
      .run(projectId, durationMs);
  }

  it('security LEGADO (metadata SEM aggregateOnly) continua excluido do relatorio', () => {
    const projectId = mkProject('security');
    insertLegacyAggregateRow(projectId, 9000);
    for (let order = 1; order <= 7; order++) {
      savePipelinePhaseMetrics({
        projectId,
        phaseNumber: 2,
        phaseName: 'Security Audit',
        agentId: `security-agent-${order}`,
        status: 'completed',
        durationMs: 1000,
        metadata: { auditAgent: true },
        sprintIndex: order,
      });
    }
    const m = getPipelineMetrics(projectId);
    const aggregate = m.phases.filter(
      (p) => p.agentId === 'multi-agent' && p.sprintIndex === -1,
    );
    expect(aggregate).toEqual([]);
    expect(m.phases.filter((p) => p.phaseNumber === 2)).toHaveLength(7);
    expect(m.totals.durationMs).toBe(7000);
  });

  it('security NOVO (metadata COM aggregateOnly) tambem fica fora', () => {
    const projectId = mkProject('security');
    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: 2,
      phaseName: 'Security Audit',
      agentId: 'multi-agent',
      status: 'completed',
      durationMs: 9000,
      metadata: { aggregateOnly: true },
    });
    const m = getPipelineMetrics(projectId);
    expect(m.phases).toEqual([]);
    expect(m.totals.durationMs).toBe(0);
  });

  it('linha por agente com auditAgent=true NUNCA e tratada como agregada', () => {
    const projectId = mkProject('security');
    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: 2,
      phaseName: 'Security Audit',
      agentId: 'multi-agent',
      status: 'completed',
      durationMs: 1234,
      metadata: { auditAgent: true, aggregateOnly: true },
    });
    const m = getPipelineMetrics(projectId);
    expect(m.phases).toHaveLength(1);
    expect(m.totals.durationMs).toBe(1234);
  });

  it('linha agregada de OUTRO tipo sem a flag NAO e excluida (o ramo legado e so do security)', () => {
    const projectId = mkProject('development');
    getDb()
      .prepare(
        `INSERT INTO pipeline_phase_metrics
           (project_id, phase_number, phase_name, agent_id, status, duration_ms, sprint_index, metadata)
         VALUES (?, 2, 'Phase 2', 'multi-agent', 'completed', 500, -1, '{}')`,
      )
      .run(projectId);
    const m = getPipelineMetrics(projectId);
    expect(m.phases).toHaveLength(1);
    expect(m.totals.durationMs).toBe(500);
  });
});


describe('TB-25d — bug: fase 2 contada UMA vez', () => {
  it('a linha bug-analysis-multi sai; as 3 por analista ficam', () => {
    const projectId = mkProject('bug');
    const analysts = ['bug-root-cause-analyst', 'bug-context-historian', 'bug-hypothesis-refuter'];
    analysts.forEach((agentId, idx) => {
      savePipelinePhaseMetrics({
        projectId,
        phaseNumber: 2,
        phaseName: 'Analise Paralela',
        agentId,
        status: 'completed',
        durationMs: 2000,
        metadata: { auditAgent: true, agentSlug: agentId },
        sprintIndex: idx + 1,
      });
    });
    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: 2,
      phaseName: 'Analise Paralela',
      agentId: 'bug-analysis-multi',
      status: 'completed',
      durationMs: 5000,
      metadata: { aggregateOnly: true },
    });

    const m = getPipelineMetrics(projectId);
    expect(m.phases.some((p) => p.agentId === 'bug-analysis-multi')).toBe(false);
    expect(m.phases.filter((p) => p.phaseNumber === 2)).toHaveLength(3);
    expect(m.totals.durationMs).toBe(6000);
  });
});


describe('TB-25f metade 1 — site 4 (getRoundDetailsForSprint): DELTA ZERO nos 5 tipos', () => {
  for (const type of EXISTING_TYPES) {
    it(`${type}: coderModel/evaluatorModel byte-identicos ao baseline flat`, () => {
      const projectId = mkProject(type);
      const sprint = insertHarnessSprint({
        projectId,
        sprintIndex: 0,
        sprintJsonId: 'S1',
        name: 'Sprint 1',
      });
      insertHarnessRound({ sprintId: sprint.id, roundNumber: 1, modelUsed: null });
      for (const n of SITE4_FIXTURE[type]) {
        seedPhaseRow(projectId, type, n, { sprintIndex: 0 });
      }
      const rounds = getRoundDetailsForSprint(projectId, 0);
      expect(rounds).toHaveLength(1);
      expect({
        coderModel: rounds[0].coderModel,
        evaluatorModel: rounds[0].evaluatorModel,
      }).toEqual(BASELINE_SITE4[type]);
    });
  }

  it('CASO DIRIGIDO — security com linha de metrica na FASE 8 nao vira coderModel', () => {
    const projectId = mkProject('security');
    const sprint = insertHarnessSprint({
      projectId,
      sprintIndex: 0,
      sprintJsonId: 'S1',
      name: 'Sprint 1',
    });
    insertHarnessRound({ sprintId: sprint.id, roundNumber: 1, modelUsed: null });
    for (const n of [8, 9, 10, 11, 13, 14]) {
      seedPhaseRow(projectId, 'security', n, { sprintIndex: 0 });
    }
    const rounds = getRoundDetailsForSprint(projectId, 0);
    expect(rounds[0].coderModel).not.toBe('model-security-p8');
    expect(rounds[0].evaluatorModel).not.toBe('model-security-p9');
    expect(rounds[0].coderModel).toBe('model-security-p10');
    expect(rounds[0].evaluatorModel).toBe('model-security-p11');
  });

  it('bug: as fases 8/9 SAO o par coder/evaluator do proprio tipo (contraprova)', () => {
    const projectId = mkProject('bug');
    const sprint = insertHarnessSprint({
      projectId,
      sprintIndex: 0,
      sprintJsonId: 'S1',
      name: 'Sprint 1',
    });
    insertHarnessRound({ sprintId: sprint.id, roundNumber: 1, modelUsed: null });
    for (const n of [8, 9]) seedPhaseRow(projectId, 'bug', n, { sprintIndex: 0 });
    const rounds = getRoundDetailsForSprint(projectId, 0);
    expect(rounds[0].coderModel).toBe('model-bug-p8');
    expect(rounds[0].evaluatorModel).toBe('model-bug-p9');
  });
});

describe('TB-25f metade 2 — site 5 (getPipelineMetrics): identidade MODULO o delta', () => {
  for (const type of EXISTING_TYPES) {
    it(`${type}: sprintPhases = baseline menos ${JSON.stringify(DELTA_SITE5_REMOVED[type])}`, () => {
      const projectId = mkProject(type);
      for (const n of SITE5_FIXTURE[type]) seedPhaseRow(projectId, type, n);
      const after = sprintPhaseNumbers(projectId);
      const baseline = BASELINE_SITE5[type];
      const removed = baseline.filter((n) => !after.includes(n));
      const added = after.filter((n) => !baseline.includes(n));
      expect(removed).toEqual(DELTA_SITE5_REMOVED[type]);
      expect(added).toEqual([]);
    });
  }
});
