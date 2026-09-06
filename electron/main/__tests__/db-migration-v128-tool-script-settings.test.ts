
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';

import {
  applyMigrationV128,
  __V128_INTERNAL,
} from '../db-migrations/v128-tool-script-settings';
import {
  TOOL_SCRIPT_DEFAULT_TOOLS,
  TOOL_SCRIPT_DEFAULT_TIMEOUT_MS,
  TOOL_SCRIPT_DEFAULT_MAX_STDOUT_BYTES,
  TOOL_SCRIPT_DEFAULT_MAX_STDERR_BYTES,
  TOOL_SCRIPT_DEFAULT_MAX_TOOL_CALLS,
} from '../tool-script/tool-script-types';


interface Harness {
  sqlite: DatabaseSync;
  db: Database.Database;
}

function makeDb(): Harness {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return { sqlite, db: sqlite as unknown as Database.Database };
}

function settingValue(sqlite: DatabaseSync, key: string): string | undefined {
  const row = sqlite
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}


describe('applyMigrationV128 - seed dos settings tool_script_*', () => {
  it('cria os 6 settings com os defaults da spec', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV128(db);

    expect(settingValue(sqlite, 'tool_script_enabled')).toBe('true');
    expect(settingValue(sqlite, 'tool_script_timeout_ms')).toBe(
      String(TOOL_SCRIPT_DEFAULT_TIMEOUT_MS),
    );
    expect(settingValue(sqlite, 'tool_script_max_stdout_bytes')).toBe(
      String(TOOL_SCRIPT_DEFAULT_MAX_STDOUT_BYTES),
    );
    expect(settingValue(sqlite, 'tool_script_max_stderr_bytes')).toBe(
      String(TOOL_SCRIPT_DEFAULT_MAX_STDERR_BYTES),
    );
    expect(settingValue(sqlite, 'tool_script_max_tool_calls')).toBe(
      String(TOOL_SCRIPT_DEFAULT_MAX_TOOL_CALLS),
    );
  });

  it('tool_script_tools e JSON valido com as 7 tools default', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV128(db);

    const raw = settingValue(sqlite, 'tool_script_tools');
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw as string) as string[];
    expect(parsed).toEqual([...TOOL_SCRIPT_DEFAULT_TOOLS]);
    expect(parsed).toEqual([
      'read_file',
      'write_file',
      'edit',
      'grep',
      'search_files',
      'run_command',
      'mcp_invoke',
    ]);
  });

  it('valores numericos da spec: 300000 / 50000 / 10000 / 50', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV128(db);

    expect(settingValue(sqlite, 'tool_script_timeout_ms')).toBe('300000');
    expect(settingValue(sqlite, 'tool_script_max_stdout_bytes')).toBe('50000');
    expect(settingValue(sqlite, 'tool_script_max_stderr_bytes')).toBe('10000');
    expect(settingValue(sqlite, 'tool_script_max_tool_calls')).toBe('50');
  });

  it('nao toca chaves alheias da tabela settings', () => {
    const { sqlite, db } = makeDb();
    sqlite
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('mcp_prompt_mode', 'index');
    applyMigrationV128(db);

    expect(settingValue(sqlite, 'mcp_prompt_mode')).toBe('index');
    const total = sqlite
      .prepare('SELECT COUNT(*) AS n FROM settings')
      .get() as { n: number };
    expect(total.n).toBe(7);
  });
});


describe('applyMigrationV128 - idempotencia', () => {
  it('re-rodar e no-op (mesmos 6 settings, sem duplicata, sem erro)', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV128(db);
    expect(() => applyMigrationV128(db)).not.toThrow();

    const total = sqlite
      .prepare('SELECT COUNT(*) AS n FROM settings')
      .get() as { n: number };
    expect(total.n).toBe(6);
  });

  it('NUNCA sobrescreve customizacao do usuario', () => {
    const { sqlite, db } = makeDb();
    sqlite
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('tool_script_enabled', 'false');
    sqlite
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('tool_script_max_tool_calls', '10');

    applyMigrationV128(db);

    expect(settingValue(sqlite, 'tool_script_enabled')).toBe('false');
    expect(settingValue(sqlite, 'tool_script_max_tool_calls')).toBe('10');
    expect(settingValue(sqlite, 'tool_script_timeout_ms')).toBe('300000');
  });
});


describe('V128 - integracao estatica com db.ts', () => {
  const dbSource = readFileSync(join(__dirname, '..', 'db.ts'), 'utf8');

  it('db.ts importa a applyMigrationV128 do arquivo v128-tool-script-settings', () => {
    expect(dbSource).toMatch(
      /import \{ applyMigrationV128 \} from '\.\/db-migrations\/v128-tool-script-settings'/,
    );
  });

  it('db.ts aplica a V128 no runner (if < 128 + INSERT schema_version 128)', () => {
    expect(dbSource).toMatch(/if \(currentVersion < 128\) \{/);
    expect(dbSource).toMatch(/applyMigrationV128\(db\);/);
    expect(dbSource).toMatch(
      /INSERT INTO schema_version \(version\) VALUES \(\?\)'\)\.run\(128\)/,
    );
  });

  it('re-export __V128_INTERNAL cobre as 6 chaves (uma linha por setting)', () => {
    const keys = __V128_INTERNAL.TOOL_SCRIPT_SETTING_SEEDS.map(([key]) => key);
    expect(keys).toEqual([
      'tool_script_enabled',
      'tool_script_tools',
      'tool_script_timeout_ms',
      'tool_script_max_stdout_bytes',
      'tool_script_max_stderr_bytes',
      'tool_script_max_tool_calls',
    ]);
  });
});
