
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyMigrationV99 } from '../db-migrations/v99-dynamic-workflow-plan-validator-converge2';
import {
  dynamicWorkflowPlanValidatorCoverage,
  DYNAMIC_WORKFLOW_PLAN_VALIDATOR_COVERAGE_ID,
} from '../seed-agents/dynamic-workflow-plan-validator-coverage';
import {
  dynamicWorkflowPlanValidatorTopology,
  DYNAMIC_WORKFLOW_PLAN_VALIDATOR_TOPOLOGY_ID,
} from '../seed-agents/dynamic-workflow-plan-validator-topology';
import {
  dynamicWorkflowPlanValidatorCriteria,
  DYNAMIC_WORKFLOW_PLAN_VALIDATOR_CRITERIA_ID,
} from '../seed-agents/dynamic-workflow-plan-validator-criteria';

const OLD_MARKER = 'regra DURA - leia com atencao';
const NEW_MARKER = 'regra DURISSIMA - calibragem SM5-R3';


interface PreparedCall {
  sql: string;
  args: unknown[];
}

function runWithMockDb(): PreparedCall[] {
  const calls: PreparedCall[] = [];
  const mockDb = {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      run: (...args: unknown[]) => {
        calls.push({ sql, args });
        return { changes: 0, lastInsertRowid: 0 };
      },
      get: () => undefined,
    })),
  } as unknown as import('better-sqlite3').Database;

  applyMigrationV99(mockDb);
  return calls;
}


describe('applyMigrationV99 - estrutural', () => {
  it('exporta applyMigrationV99 como funcao', () => {
    expect(typeof applyMigrationV99).toBe('function');
  });

  it('nao lanca num mock db limpo', () => {
    expect(() => runWithMockDb()).not.toThrow();
  });
});

describe('applyMigrationV99 - UPDATE guardado por seed (preserva customizacao)', () => {
  const calls = runWithMockDb();
  const updates = calls.filter((c) => /^\s*UPDATE agents SET system_prompt/.test(c.sql));

  it('faz exatamente 3 UPDATEs (um por plan-validator)', () => {
    expect(updates.length).toBe(3);
  });

  it('todo UPDATE e guardado: LIKE marca antiga AND NOT LIKE marca nova', () => {
    for (const u of updates) {
      expect(u.sql).toMatch(/system_prompt LIKE '%' \|\| \? \|\| '%'/);
      expect(u.sql).toMatch(/system_prompt NOT LIKE '%' \|\| \? \|\| '%'/);
    }
  });

  it('cada UPDATE carrega systemPrompt + id + markers do seed correto', () => {
    const bySeed = (id: string) => updates.find((u) => u.args[1] === id);

    const cov = bySeed(DYNAMIC_WORKFLOW_PLAN_VALIDATOR_COVERAGE_ID);
    const top = bySeed(DYNAMIC_WORKFLOW_PLAN_VALIDATOR_TOPOLOGY_ID);
    const cri = bySeed(DYNAMIC_WORKFLOW_PLAN_VALIDATOR_CRITERIA_ID);

    for (const [u, seed] of [
      [cov, dynamicWorkflowPlanValidatorCoverage],
      [top, dynamicWorkflowPlanValidatorTopology],
      [cri, dynamicWorkflowPlanValidatorCriteria],
    ] as const) {
      expect(u).toBeDefined();
      expect(u!.args[0]).toBe(seed.systemPrompt);
      expect(u!.args[2]).toBe(OLD_MARKER);
      expect(u!.args[3]).toBe(NEW_MARKER);
    }
  });

  it('NAO ha UPDATE incondicional nem DELETE/INSERT (so UPDATE guardado)', () => {
    for (const c of calls) {
      expect(/DELETE|INSERT/.test(c.sql)).toBe(false);
      expect(c.sql).toMatch(/WHERE/);
    }
  });
});


describe('applyMigrationV99 - markers nos seeds (convergencia da migration)', () => {
  const seeds = [
    dynamicWorkflowPlanValidatorCoverage,
    dynamicWorkflowPlanValidatorTopology,
    dynamicWorkflowPlanValidatorCriteria,
  ];

  it('todo seed novo contem o NEW marker (SM5-R3) e NAO o OLD marker (V96)', () => {
    for (const seed of seeds) {
      expect(seed.systemPrompt).toContain(NEW_MARKER);
      expect(seed.systemPrompt).not.toContain(OLD_MARKER);
    }
  });

  it('o NEW marker do WHERE NOT LIKE casa com o prompt do seed (sem reaplicar em loop)', () => {
    for (const seed of seeds) {
      expect(seed.systemPrompt.includes(NEW_MARKER)).toBe(true);
    }
  });
});

describe('applyMigrationV99 - calibragem de severidade nos prompts', () => {
  const cov = dynamicWorkflowPlanValidatorCoverage.systemPrompt;
  const top = dynamicWorkflowPlanValidatorTopology.systemPrompt;
  const cri = dynamicWorkflowPlanValidatorCriteria.systemPrompt;

  it('os 3 framam "default ZERO P1" e tem teste obrigatorio antes de marcar P1', () => {
    for (const p of [cov, top, cri]) {
      expect(p).toContain('O default e ZERO P1');
      expect(p).toMatch(/Teste obrigatorio antes de marcar QUALQUER P1/);
      expect(p).toMatch(/lista FECHADA, exaustiva/);
    }
  });

  it('cobertura: "poderia cobrir mais"/CI viram P3, nunca P1', () => {
    expect(cov).toMatch(/poderia cobrir mais.*->\s*P3/i);
    expect(cov).toMatch(/inspecao manual.*CI.*->\s*P3/i);
  });

  it('topologia: sizing JAMAIS bloqueia (sempre P2/P3)', () => {
    expect(top).toMatch(/Sizing JAMAIS bloqueia/);
    expect(top).toMatch(/grande\/pequena demais/);
  });

  it('criterios: "mais objetivo"/"sem seletor"/"falta CI" rebaixados (nunca P1)', () => {
    expect(cri).toMatch(/poderia ser MAIS objetivo.*->\s*P2/i);
    expect(cri).toMatch(/Inspecao visual.*->\s*P3/i);
    expect(cri).toMatch(/Falta verificacao automatizada \/ em CI.*->\s*P3/i);
  });
});


const MAIN_DIR = join(__dirname, '..');

function readMainSource(relPath: string): string {
  return readFileSync(join(MAIN_DIR, relPath), 'utf8');
}

describe('applyMigrationV99 - integracao no runner de db.ts (F7, guardrail estatico)', () => {
  const dbSrc = readMainSource('db.ts');

  it('db.ts importa applyMigrationV99 do arquivo da migration', () => {
    expect(dbSrc).toContain(
      "import { applyMigrationV99 } from './db-migrations/v99-dynamic-workflow-plan-validator-converge2'",
    );
  });

  it('runMigrations tem o bloco if (currentVersion < 99) que aplica e versiona', () => {
    const start = dbSrc.indexOf('if (currentVersion < 99) {');
    expect(start).toBeGreaterThan(-1);
    const block = dbSrc.slice(start, start + 700);
    expect(block).toContain('applyMigrationV99(db)');
    expect(block).toContain(
      "db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(99)",
    );
    expect(block).toMatch(/Applied migration v99/);
  });
});
