import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyMigrationV81, __V81_INTERNAL } from '../db-migrations/v81-activity-log-project-id';

interface MockRun {
  execCalls: string[];
}

function runWithMockDb(execImpl?: (sql: string) => void): MockRun {
  const execCalls: string[] = [];

  const mockDb = {
    exec: vi.fn().mockImplementation((sql: string) => {
      execCalls.push(sql);
      if (execImpl) execImpl(sql);
    }),
  } as unknown as import('better-sqlite3').Database;

  applyMigrationV81(mockDb);
  return { execCalls };
}

describe('applyMigrationV81 - structural', () => {
  it('exports applyMigrationV81 as a function', () => {
    expect(typeof applyMigrationV81).toBe('function');
  });

  it('exposes table/column names in __V81_INTERNAL', () => {
    expect(__V81_INTERNAL.TABLE_NAME).toBe('activity_log');
    expect(__V81_INTERNAL.COLUMN_NAME).toBe('project_id');
  });
});

describe('applyMigrationV81 - SQL content', () => {
  it('executes exactly one ALTER TABLE adding project_id TEXT to activity_log', () => {
    const { execCalls } = runWithMockDb();
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toMatch(/ALTER TABLE activity_log ADD COLUMN project_id TEXT/i);
  });

  it('column is nullable (no NOT NULL / no DEFAULT) - aditivo, pre-V81 degrada sem clique', () => {
    const { execCalls } = runWithMockDb();
    expect(execCalls[0]).not.toMatch(/NOT NULL/i);
    expect(execCalls[0]).not.toMatch(/DEFAULT/i);
  });
});

describe('applyMigrationV81 - idempotencia e erros', () => {
  it('does not throw on a clean mock db', () => {
    expect(() => runWithMockDb()).not.toThrow();
  });

  it('is idempotent: swallows "duplicate column name" when re-applied', () => {
    expect(() =>
      runWithMockDb(() => {
        throw new Error('duplicate column name: project_id');
      }),
    ).not.toThrow();
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

describe('applyMigrationV81 - integracao no runner de db.ts (W7, guardrail estatico)', () => {
  const dbSrc = readMainSource('db.ts');

  it('db.ts importa applyMigrationV81 do arquivo da migration', () => {
    expect(dbSrc).toContain("import { applyMigrationV81 } from './db-migrations/v81-activity-log-project-id'");
  });

  it('runMigrations tem o bloco if (currentVersion < 81)', () => {
    expect(dbSrc).toContain('if (currentVersion < 81) {');
  });

  it('o bloco V81 chama applyMigrationV81, insere em schema_version e loga', () => {
    const start = dbSrc.indexOf('if (currentVersion < 81) {');
    expect(start).toBeGreaterThan(-1);
    const block = dbSrc.slice(start, start + 400);
    expect(block).toContain('applyMigrationV81(db)');
    expect(block).toContain("db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(81)");
    expect(block).toMatch(/Applied migration v81/);
  });
});

describe('I2 - cadeia projectId em db.ts (guardrail estatico)', () => {
  const dbSrc = readMainSource('db.ts');

  it('upsertActivityLog grava project_id (INSERT + COALESCE no merge + param ev.projectId)', () => {
    const fnStart = dbSrc.indexOf('export function upsertActivityLog');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = dbSrc.indexOf('function mapActivityRow', fnStart + 1);
    const body = dbSrc.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

    expect(body).toContain('project_id');
    expect(body).toContain('@project_id');
    expect(body).toContain('project_id = COALESCE(excluded.project_id, activity_log.project_id)');
    expect(body).toContain('project_id: ev.projectId ?? null');
  });

  it('mapActivityRow mapeia project_id -> projectId (blocos rehidratados clicaveis)', () => {
    const fnStart = dbSrc.indexOf('function mapActivityRow');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = dbSrc.indexOf('export function getActivityBlocks', fnStart + 1);
    const body = dbSrc.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

    expect(body).toMatch(/projectId:\s*\(row\['project_id'\] as string \| null\) \?\? undefined/);
  });

  it('getActivityBlocks devolve via SELECT * + mapActivityRow (sem projecao que dropa a coluna)', () => {
    const fnStart = dbSrc.indexOf('export function getActivityBlocks');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = dbSrc.indexOf('export function', fnStart + 1);
    const body = dbSrc.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

    expect(body).toMatch(/SELECT \* FROM activity_log/);
    expect(body).toContain('mapActivityRow');
  });
});
