
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyMigrationV82, __V82_INTERNAL } from '../db-migrations/v82-repo-graph';


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

  applyMigrationV82(mockDb);
  return { execCalls };
}

function allSql(): string {
  return runWithMockDb().execCalls.join('\n');
}


describe('applyMigrationV82 - structural', () => {
  it('exports applyMigrationV82 as a function', () => {
    expect(typeof applyMigrationV82).toBe('function');
  });

  it('exposes the 4 table names + index in __V82_INTERNAL', () => {
    expect(__V82_INTERNAL.TABLES).toEqual([
      'local_repositories',
      'repo_graph_runs',
      'session_active_repository',
      'repo_graph_turn_usage',
    ]);
    expect(__V82_INTERNAL.INDEXES).toEqual(['idx_rgtu_session_turn']);
  });
});


describe('applyMigrationV82 - SQL content', () => {
  const sql = allSql();

  it('creates the 4 tables (IF NOT EXISTS) and the turn-usage index', () => {
    for (const table of __V82_INTERNAL.TABLES) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    }
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_rgtu_session_turn ON repo_graph_turn_usage\(session_id, turn_index\)/,
    );
  });

  it('local_repositories: canonical_root_path UNIQUE + CHECK de status + supressao global', () => {
    expect(sql).toContain('canonical_root_path TEXT NOT NULL UNIQUE');
    expect(sql).toContain("CHECK (status IN ('absent','building','ready','stale','error'))");
    expect(sql).toContain('graph_prompt_suppressed_global INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('indexed_worktree_hash TEXT');
  });

  it('repo_graph_runs.session_id e NULLABLE com ON DELETE SET NULL (rev5)', () => {
    expect(sql).toContain('session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL');
    expect(sql).not.toContain('session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE SET NULL');
  });

  it('repo_graph_runs: CHECKs de kind e status', () => {
    expect(sql).toContain("CHECK (kind IN ('build','update'))");
    expect(sql).toContain("CHECK (status IN ('running','done','error','cancelled'))");
    expect(sql).toContain(
      'repository_id TEXT NOT NULL REFERENCES local_repositories(id) ON DELETE CASCADE',
    );
  });

  it('session_active_repository: PK por sessao + cascade nas 2 FKs (clear de sessao remove attach, secao 14)', () => {
    expect(sql).toContain(
      'session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE',
    );
    expect(sql).toContain('graph_prompt_suppressed INTEGER NOT NULL DEFAULT 0');
  });

  it('repo_graph_turn_usage: session_id e turn_index NOT NULL (Z3: build fora de turno NAO entra aqui)', () => {
    expect(sql).toContain('session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE');
    expect(sql).toContain('turn_index INTEGER NOT NULL');
    expect(sql).toContain('used INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('bytes_returned INTEGER DEFAULT 0');
  });
});


describe('applyMigrationV82 - idempotencia e erros', () => {
  it('does not throw on a clean mock db', () => {
    expect(() => runWithMockDb()).not.toThrow();
  });

  it('todo CREATE usa IF NOT EXISTS (re-aplicar e no-op, sem catch de duplicado)', () => {
    const sql = allSql();
    const creates = sql.match(/CREATE (TABLE|INDEX)/g) ?? [];
    const createsIfNotExists = sql.match(/CREATE (TABLE|INDEX) IF NOT EXISTS/g) ?? [];
    expect(creates.length).toBe(5); // 4 tabelas + 1 indice
    expect(createsIfNotExists.length).toBe(5);
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

describe('applyMigrationV82 - integracao no runner de db.ts (F7, guardrail estatico)', () => {
  const dbSrc = readMainSource('db.ts');

  it('db.ts importa applyMigrationV82 do arquivo da migration', () => {
    expect(dbSrc).toContain(
      "import { applyMigrationV82 } from './db-migrations/v82-repo-graph'",
    );
  });

  it('runMigrations tem o bloco if (currentVersion < 82)', () => {
    expect(dbSrc).toContain('if (currentVersion < 82) {');
  });

  it('o bloco V82 chama applyMigrationV82, insere em schema_version e loga', () => {
    const start = dbSrc.indexOf('if (currentVersion < 82) {');
    expect(start).toBeGreaterThan(-1);
    const block = dbSrc.slice(start, start + 400);
    expect(block).toContain('applyMigrationV82(db)');
    expect(block).toContain("db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(82)");
    expect(block).toMatch(/Applied migration v82/);
  });
});


describe('V82 - CRUD repo-graph em db.ts (guardrail estatico)', () => {
  const dbSrc = readMainSource('db.ts');

  it('db.ts exporta o CRUD de local_repositories', () => {
    expect(dbSrc).toContain('export function upsertLocalRepository');
    expect(dbSrc).toContain('export function getLocalRepository');
    expect(dbSrc).toContain('export function getLocalRepositoryByCanonicalPath');
    expect(dbSrc).toContain('export function listLocalRepositories');
    expect(dbSrc).toContain('export function removeLocalRepository');
    expect(dbSrc).toContain('export function updateLocalRepositoryGraphState');
    expect(dbSrc).toContain('export function setRepoGraphPromptSuppressedGlobal');
  });

  it('db.ts exporta o CRUD de repo_graph_runs', () => {
    expect(dbSrc).toContain('export function insertRepoGraphRun');
    expect(dbSrc).toContain('export function updateRepoGraphRun');
    expect(dbSrc).toContain('export function getRepoGraphRun');
    expect(dbSrc).toContain('export function getLatestRepoGraphRun');
  });

  it('db.ts exporta attach/detach/get + flags de session_active_repository', () => {
    expect(dbSrc).toContain('export function attachSessionRepository');
    expect(dbSrc).toContain('export function detachSessionRepository');
    expect(dbSrc).toContain('export function getSessionActiveRepository');
    expect(dbSrc).toContain('export function setSessionGraphPromptSuppressed');
  });

  it('db.ts exporta insert/query de repo_graph_turn_usage', () => {
    expect(dbSrc).toContain('export function insertRepoGraphTurnUsage');
    expect(dbSrc).toContain('export function getRepoGraphTurnUsage');
  });

  it('nenhum SQL de repo-graph fora de db.ts/db-migrations (engine recebe CRUD por injecao)', () => {
    const engineSrc = readMainSource('repo-graph/engine.ts');
    const providerSrc = readMainSource('repo-graph/provider-codegraph.ts');
    for (const src of [engineSrc, providerSrc]) {
      expect(src).not.toMatch(/INSERT INTO|UPDATE local_repositories|DELETE FROM|SELECT \* FROM/);
    }
  });
});
