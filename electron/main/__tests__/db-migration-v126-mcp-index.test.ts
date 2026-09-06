
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyMigrationV126, __V126_INTERNAL } from '../db-migrations/v126-mcp-index';


interface MockDbHarness {
  mockDb: import('better-sqlite3').Database;
  execs: string[];
  preparedSql: string[];
  seedRuns: unknown[][];
}

function makeMockDb(existingColumns: Record<string, string[]>): MockDbHarness {
  const execs: string[] = [];
  const preparedSql: string[] = [];
  const seedRuns: unknown[][] = [];

  const mockDb = {
    exec: vi.fn().mockImplementation((sql: string) => {
      execs.push(sql);
    }),
    prepare: vi.fn().mockImplementation((sql: string) => {
      preparedSql.push(sql);
      if (sql.startsWith('PRAGMA table_info')) {
        const table = /PRAGMA table_info\('([^']+)'\)/.exec(sql)?.[1] ?? '';
        const cols = existingColumns[table] ?? [];
        return {
          all: () =>
            cols.map((name, cid) => ({
              cid,
              name,
              type: 'TEXT',
              notnull: 0,
              dflt_value: null,
              pk: 0,
            })),
        };
      }
      return {
        run: (...args: unknown[]) => {
          seedRuns.push(args);
        },
      };
    }),
  } as unknown as import('better-sqlite3').Database;

  return { mockDb, execs, preparedSql, seedRuns };
}

const PRE_V126_COLUMNS: Record<string, string[]> = {
  mcp_tool_registry: ['mcp_id', 'tool_name', 'description'],
  mcp_servers: ['id', 'name', 'command', 'args', 'env_keys', 'is_active', 'visible_to'],
};

const POST_V126_COLUMNS: Record<string, string[]> = {
  mcp_tool_registry: ['mcp_id', 'tool_name', 'description', 'input_schema', 'last_discovered_at'],
  mcp_servers: ['id', 'name', 'command', 'args', 'env_keys', 'is_active', 'visible_to', 'index_mode'],
};

describe('applyMigrationV126 - colunas', () => {
  it('adiciona exatamente as 3 colunas da SPEC 1 (2 no registry + index_mode no servers)', () => {
    const { mockDb, execs } = makeMockDb(PRE_V126_COLUMNS);
    applyMigrationV126(mockDb);

    expect(execs).toHaveLength(3);
    expect(execs[0]).toBe('ALTER TABLE mcp_tool_registry ADD COLUMN input_schema TEXT');
    expect(execs[1]).toBe('ALTER TABLE mcp_tool_registry ADD COLUMN last_discovered_at TEXT');
    expect(execs[2]).toBe("ALTER TABLE mcp_servers ADD COLUMN index_mode TEXT NOT NULL DEFAULT 'tools'");
  });

  it('NAO re-adiciona description (coluna existe desde a V16)', () => {
    const { mockDb, execs } = makeMockDb(PRE_V126_COLUMNS);
    applyMigrationV126(mockDb);

    for (const sql of execs) {
      expect(sql).not.toMatch(/ADD COLUMN description/i);
    }
  });

  it('index_mode nasce NOT NULL DEFAULT tools (linhas existentes cobertas no ALTER)', () => {
    const { mockDb, execs } = makeMockDb(PRE_V126_COLUMNS);
    applyMigrationV126(mockDb);

    const indexModeSql = execs.find((sql) => sql.includes('index_mode'));
    expect(indexModeSql).toMatch(/NOT NULL DEFAULT 'tools'/);
  });

  it('__V126_INTERNAL espelha tabelas/colunas e o seed', () => {
    expect(__V126_INTERNAL.NEW_COLUMNS.map((c) => `${c.table}.${c.column}`)).toEqual([
      'mcp_tool_registry.input_schema',
      'mcp_tool_registry.last_discovered_at',
      'mcp_servers.index_mode',
    ]);
    expect(__V126_INTERNAL.MCP_PROMPT_MODE_SEED).toEqual(['mcp_prompt_mode', 'index']);
  });
});

describe('applyMigrationV126 - idempotencia via PRAGMA table_info', () => {
  it('coluna ja presente => zero ALTER TABLE (re-rodar e no-op estrutural)', () => {
    const { mockDb, execs, preparedSql } = makeMockDb(POST_V126_COLUMNS);
    applyMigrationV126(mockDb);

    expect(execs).toHaveLength(0);
    expect(preparedSql.filter((s) => s.startsWith('PRAGMA table_info'))).toHaveLength(3);
  });

  it('re-execucao dupla nao lanca e nao duplica ALTERs', () => {
    const { mockDb, execs } = makeMockDb(POST_V126_COLUMNS);
    expect(() => {
      applyMigrationV126(mockDb);
      applyMigrationV126(mockDb);
    }).not.toThrow();
    expect(execs).toHaveLength(0);
  });

  it('aplicacao parcial anterior: so a coluna faltante e adicionada', () => {
    const { mockDb, execs } = makeMockDb({
      mcp_tool_registry: ['mcp_id', 'tool_name', 'description', 'input_schema'],
      mcp_servers: PRE_V126_COLUMNS['mcp_servers'],
    });
    applyMigrationV126(mockDb);

    expect(execs).toEqual([
      'ALTER TABLE mcp_tool_registry ADD COLUMN last_discovered_at TEXT',
      "ALTER TABLE mcp_servers ADD COLUMN index_mode TEXT NOT NULL DEFAULT 'tools'",
    ]);
  });
});

describe('applyMigrationV126 - seed mcp_prompt_mode', () => {
  it("semeia settings('mcp_prompt_mode', 'index') via INSERT OR IGNORE", () => {
    const { mockDb, preparedSql, seedRuns } = makeMockDb(PRE_V126_COLUMNS);
    applyMigrationV126(mockDb);

    const seedSql = preparedSql.find((s) => s.includes('settings'));
    expect(seedSql).toMatch(/INSERT\s+OR\s+IGNORE\s+INTO\s+settings/i);
    expect(seedRuns).toContainEqual(['mcp_prompt_mode', 'index']);
  });

  it('seed roda mesmo com colunas ja presentes (INSERT OR IGNORE preserva customizacao)', () => {
    const { mockDb, seedRuns } = makeMockDb(POST_V126_COLUMNS);
    applyMigrationV126(mockDb);
    applyMigrationV126(mockDb);

    expect(seedRuns).toHaveLength(2);
    for (const args of seedRuns) {
      expect(args).toEqual(['mcp_prompt_mode', 'index']);
    }
  });
});


describe('guardrail estatico - runner da V126 em db.ts', () => {
  const dbSource = readFileSync(join(__dirname, '..', 'db.ts'), 'utf-8');

  it('importa e aplica a V126 com bump de schema_version', () => {
    expect(dbSource).toContain("from './db-migrations/v126-mcp-index'");
    expect(dbSource).toContain('if (currentVersion < 126)');
    expect(dbSource).toContain('applyMigrationV126(db)');
    expect(dbSource).toMatch(/INSERT INTO schema_version \(version\) VALUES \(\?\)'\)\.run\(126\)/);
  });
});
