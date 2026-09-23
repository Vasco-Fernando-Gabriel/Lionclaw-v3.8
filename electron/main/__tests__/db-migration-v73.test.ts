import { describe, it, expect, vi } from 'vitest';

import { applyMigrationV73 } from '../db-migrations/v73-minimax-tp-agent-runtime';

describe('applyMigrationV73 - structural', () => {
  it('exports applyMigrationV73 as a function', () => {
    expect(typeof applyMigrationV73).toBe('function');
  });
});

describe('applyMigrationV73 - SQL content', () => {
  function captureSql(): string {
    let capturedSql = '';
    const mockExec = vi.fn().mockImplementation((sql: string) => {
      capturedSql = sql;
    });
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;
    applyMigrationV73(mockDb);
    return capturedSql;
  }

  it('CHECK constraint includes minimax-tp', () => {
    const sql = captureSql();
    expect(sql).toContain("'minimax-tp'");
    expect(sql).toMatch(/CHECK\s*\(runtime IN \('cloud', 'local', 'external', 'codex', 'zai', 'minimax-tp'\)\)/);
  });

  it('CHECK constraint still includes all previous runtimes', () => {
    const sql = captureSql();
    expect(sql).toContain("'cloud'");
    expect(sql).toContain("'local'");
    expect(sql).toContain("'external'");
    expect(sql).toContain("'codex'");
    expect(sql).toContain("'zai'");
  });

  it('creates agents_new table', () => {
    const sql = captureSql();
    expect(sql).toMatch(/CREATE TABLE agents_new/i);
  });

  it('copies all columns via INSERT ... SELECT', () => {
    const sql = captureSql();
    expect(sql).toMatch(/INSERT INTO agents_new/i);
    expect(sql).toMatch(/SELECT/i);
    expect(sql).toMatch(/FROM agents/i);
    const expectedCols = [
      'id',
      'name',
      'description',
      'system_prompt',
      'model',
      'allowed_tools',
      'mcp_servers',
      'is_active',
      'sort_order',
      'effort',
      'thinking',
      'thinking_budget',
      'max_turns',
      'skills',
      'kb_enabled',
      'runtime',
      'local_config',
      'external_config',
      'codex_config',
      'local_mode',
      'max_tool_rounds',
      'squad',
      'created_at',
      'updated_at',
    ];
    for (const col of expectedCols) {
      expect(sql).toContain(col);
    }
  });

  it('drops old agents table', () => {
    const sql = captureSql();
    expect(sql).toMatch(/DROP TABLE agents/i);
  });

  it('renames agents_new to agents', () => {
    const sql = captureSql();
    expect(sql).toMatch(/ALTER TABLE agents_new RENAME TO agents/i);
  });

  it('executes exactly one db.exec call', () => {
    const mockExec = vi.fn();
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;
    applyMigrationV73(mockDb);
    expect(mockExec).toHaveBeenCalledTimes(1);
  });
});

describe('applyMigrationV73 - mock DB (normal execution)', () => {
  it('does not throw on a clean mock db', () => {
    const mockExec = vi.fn();
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;
    expect(() => applyMigrationV73(mockDb)).not.toThrow();
  });

  it('propagates unexpected errors from db.exec', () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;
    expect(() => applyMigrationV73(mockDb)).toThrow('disk I/O error');
  });
});
