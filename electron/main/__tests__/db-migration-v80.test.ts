
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyMigrationV80, __V80_INTERNAL } from '../db-migrations/v80-harness-sprints-dedup-unique';


interface MockRun {
  events: string[];
  execCalls: string[];
  transactionCalls: number;
}

function runWithMockDb(execImpl?: (sql: string) => void): MockRun {
  const events: string[] = [];
  const execCalls: string[] = [];
  let transactionCalls = 0;

  const mockDb = {
    exec: vi.fn().mockImplementation((sql: string) => {
      events.push('exec');
      execCalls.push(sql);
      if (execImpl) execImpl(sql);
    }),
    transaction: vi.fn().mockImplementation((fn: () => void) => {
      transactionCalls += 1;
      return () => {
        events.push('tx-start');
        fn();
        events.push('tx-end');
      };
    }),
  } as unknown as import('better-sqlite3').Database;

  applyMigrationV80(mockDb);
  return { events, execCalls, transactionCalls };
}


describe('applyMigrationV80 - structural', () => {
  it('exports applyMigrationV80 as a function', () => {
    expect(typeof applyMigrationV80).toBe('function');
  });

  it('exposes the unique index name in __V80_INTERNAL', () => {
    expect(__V80_INTERNAL.INDEX_NAME).toBe('idx_harness_sprints_project_sprint');
  });
});


describe('applyMigrationV80 - transacao propria', () => {
  it('creates exactly one db.transaction and runs it', () => {
    const { transactionCalls, events } = runWithMockDb();
    expect(transactionCalls).toBe(1);
    expect(events[0]).toBe('tx-start');
    expect(events[events.length - 1]).toBe('tx-end');
  });

  it('executes ALL statements inside the transaction (5 execs)', () => {
    const { events, execCalls } = runWithMockDb();
    expect(execCalls).toHaveLength(5);
    expect(events).toEqual(['tx-start', 'exec', 'exec', 'exec', 'exec', 'exec', 'tx-end']);
  });
});


describe('applyMigrationV80 - SQL content e ordem', () => {
  it('statement 1: deleta rounds dos sprints perdedores (rn > 1) via window function', () => {
    const { execCalls } = runWithMockDb();
    const sql = execCalls[0];
    expect(sql).toMatch(/DELETE FROM harness_rounds/i);
    expect(sql).toMatch(/ROW_NUMBER\(\) OVER/i);
    expect(sql).toMatch(/PARTITION BY project_id, sprint_index/i);
    expect(sql).toMatch(/ORDER BY created_at DESC, rowid DESC/i);
    expect(sql).toMatch(/rn > 1/);
  });

  it('statement 2: deleta sprints perdedores mantendo rn = 1 (rowid NOT IN)', () => {
    const { execCalls } = runWithMockDb();
    const sql = execCalls[1];
    expect(sql).toMatch(/DELETE FROM harness_sprints WHERE rowid NOT IN/i);
    expect(sql).toMatch(/ROW_NUMBER\(\) OVER/i);
    expect(sql).toMatch(/PARTITION BY project_id, sprint_index/i);
    expect(sql).toMatch(/ORDER BY created_at DESC, rowid DESC/i);
    expect(sql).toMatch(/rn = 1/);
  });

  it('dedup NAO usa DELETE com EXISTS auto-referente (semantica fragil)', () => {
    const { execCalls } = runWithMockDb();
    expect(execCalls[0]).not.toMatch(/EXISTS/i);
    expect(execCalls[1]).not.toMatch(/EXISTS/i);
  });

  it('statement 3: corte de cauda dos rounds com guard total_sprints > 0', () => {
    const { execCalls } = runWithMockDb();
    const sql = execCalls[2];
    expect(sql).toMatch(/DELETE FROM harness_rounds/i);
    expect(sql).toMatch(/JOIN harness_projects p ON p\.id = s\.project_id/i);
    expect(sql).toMatch(/p\.total_sprints > 0/);
    expect(sql).toMatch(/s\.sprint_index >= p\.total_sprints/);
  });

  it('statement 4: corte de cauda dos sprints com o mesmo guard', () => {
    const { execCalls } = runWithMockDb();
    const sql = execCalls[3];
    expect(sql).toMatch(/DELETE FROM harness_sprints WHERE id IN/i);
    expect(sql).toMatch(/p\.total_sprints > 0/);
    expect(sql).toMatch(/s\.sprint_index >= p\.total_sprints/);
  });

  it('rounds sao deletados ANTES dos sprints nos dois passos (FK sem cascade)', () => {
    const { execCalls } = runWithMockDb();
    expect(execCalls[0]).toMatch(/harness_rounds/i);
    expect(execCalls[1]).toMatch(/DELETE FROM harness_sprints/i);
    expect(execCalls[2]).toMatch(/harness_rounds/i);
    expect(execCalls[3]).toMatch(/DELETE FROM harness_sprints/i);
  });

  it('statement 5 (ultimo): CREATE UNIQUE INDEX IF NOT EXISTS apos o dedup', () => {
    const { execCalls } = runWithMockDb();
    const sql = execCalls[4];
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_sprints_project_sprint/i);
    expect(sql).toMatch(/ON harness_sprints\(project_id, sprint_index\)/i);
    for (let i = 0; i < 4; i++) {
      expect(execCalls[i]).not.toMatch(/CREATE UNIQUE INDEX/i);
    }
  });
});


describe('applyMigrationV80 - mock DB (erros)', () => {
  it('does not throw on a clean mock db', () => {
    expect(() => runWithMockDb()).not.toThrow();
  });

  it('propagates unexpected errors from db.exec', () => {
    expect(() =>
      runWithMockDb(() => {
        throw new Error('disk I/O error');
      }),
    ).toThrow('disk I/O error');
  });
});


const MAIN_DIR = join(__dirname, '..');

function readMainSource(relPath: string): string {
  return readFileSync(join(MAIN_DIR, relPath), 'utf8');
}

describe('applyMigrationV80 - integracao no runner de db.ts (AC-5, guardrail estatico)', () => {
  const dbSrc = readMainSource('db.ts');

  it('db.ts importa applyMigrationV80 do arquivo da migration', () => {
    expect(dbSrc).toContain(
      "import { applyMigrationV80 } from './db-migrations/v80-harness-sprints-dedup-unique'",
    );
  });

  it('runMigrations tem o bloco if (currentVersion < 80)', () => {
    expect(dbSrc).toContain('if (currentVersion < 80) {');
  });

  it('o bloco V80 chama applyMigrationV80, insere em schema_version e loga', () => {
    const start = dbSrc.indexOf('if (currentVersion < 80) {');
    expect(start).toBeGreaterThan(-1);
    const block = dbSrc.slice(start, start + 400);
    expect(block).toContain('applyMigrationV80(db)');
    expect(block).toContain("db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(80)");
    expect(block).toMatch(/Applied migration v80/);
  });
});


describe('Parte A - persist idempotente (AC-2/AC-3, guardrail estatico)', () => {
  it('db.ts: replaceHarnessSprintsForProject usa db.transaction com ordem rounds -> sprints -> insert', () => {
    const dbSrc = readMainSource('db.ts');
    const fnStart = dbSrc.indexOf('export function replaceHarnessSprintsForProject');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = dbSrc.indexOf('export function', fnStart + 1);
    const body = dbSrc.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

    expect(body).toContain('db.transaction');

    const iRounds = body.indexOf('DELETE FROM harness_rounds');
    const iSprints = body.indexOf('DELETE FROM harness_sprints');
    const iInsert = body.indexOf('INSERT INTO harness_sprints');
    expect(iRounds).toBeGreaterThan(-1);
    expect(iSprints).toBeGreaterThan(iRounds);
    expect(iInsert).toBeGreaterThan(iSprints);
  });

  it('harness-planner.ts: saveSprintsJson usa o replace idempotente (sem loop append)', () => {
    const plannerSrc = readMainSource('harness-planner.ts');
    expect(plannerSrc).toContain('replaceHarnessSprintsForProject(');
    expect(plannerSrc).not.toContain('insertHarnessSprint');
  });

  it('harness-engine.ts: regenerate sem pre-delete de sprints/rounds (B1)', () => {
    const engineSrc = readMainSource('harness-engine.ts');
    expect(engineSrc).not.toMatch(/DELETE FROM harness_rounds/);
    expect(engineSrc).not.toMatch(/DELETE FROM harness_sprints/);
  });
});
