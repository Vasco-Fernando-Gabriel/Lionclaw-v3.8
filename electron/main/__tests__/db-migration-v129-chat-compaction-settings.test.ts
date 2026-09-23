import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';

import { applyMigrationV129, __V129_INTERNAL } from '../db-migrations/v129-chat-compaction-settings';
import {
  DEFAULT_CHAT_COMPACTION_TARGET_TOKENS,
  CHAT_COMPACTION_TARGET_TOKENS_SETTING_KEY,
  DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT,
  CHAT_COMPACTION_TRIGGER_PERCENT_SETTING_KEY,
} from '../chat-compaction-defaults';

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
  const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

describe('AC-A12: applyMigrationV129 - seed dos settings da compactacao do chat', () => {
  it('AC-A12: cria chat_compaction_target_tokens=50000 (D2) e threshold_percent=80 (D1)', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV129(db);

    expect(settingValue(sqlite, CHAT_COMPACTION_TARGET_TOKENS_SETTING_KEY)).toBe('50000');
    expect(settingValue(sqlite, CHAT_COMPACTION_TRIGGER_PERCENT_SETTING_KEY)).toBe('80');
    expect(settingValue(sqlite, CHAT_COMPACTION_TARGET_TOKENS_SETTING_KEY)).toBe(
      String(DEFAULT_CHAT_COMPACTION_TARGET_TOKENS),
    );
    expect(settingValue(sqlite, CHAT_COMPACTION_TRIGGER_PERCENT_SETTING_KEY)).toBe(
      String(DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT),
    );
  });

  it('AC-A12: nao toca chaves alheias da tabela settings', () => {
    const { sqlite, db } = makeDb();
    sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('orchestrator_model', 'claude-sonnet-4-5');
    applyMigrationV129(db);

    expect(settingValue(sqlite, 'orchestrator_model')).toBe('claude-sonnet-4-5');
    const total = sqlite.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number };
    expect(total.n).toBe(3);
  });
});

describe('AC-A12: applyMigrationV129 - idempotencia', () => {
  it('AC-A12: re-rodar e no-op (mesmos 2 settings, sem duplicata, sem erro)', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV129(db);
    expect(() => applyMigrationV129(db)).not.toThrow();

    const total = sqlite.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number };
    expect(total.n).toBe(2);
  });

  it('AC-A12: NUNCA sobrescreve customizacao do usuario (slider ja mexido fica)', () => {
    const { sqlite, db } = makeDb();
    sqlite
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run(CHAT_COMPACTION_TRIGGER_PERCENT_SETTING_KEY, '65');

    applyMigrationV129(db);

    expect(settingValue(sqlite, CHAT_COMPACTION_TRIGGER_PERCENT_SETTING_KEY)).toBe('65');
    expect(settingValue(sqlite, CHAT_COMPACTION_TARGET_TOKENS_SETTING_KEY)).toBe('50000');
  });
});

describe('AC-A12: V129 - integracao estatica com db.ts', () => {
  const dbSource = readFileSync(join(__dirname, '..', 'db.ts'), 'utf8');

  it('AC-A12: db.ts importa a applyMigrationV129 do arquivo v129-chat-compaction-settings', () => {
    expect(dbSource).toMatch(/import \{ applyMigrationV129 \} from '\.\/db-migrations\/v129-chat-compaction-settings'/);
  });

  it('AC-A12: db.ts aplica a V129 no runner (if < 129 + INSERT schema_version 129)', () => {
    expect(dbSource).toMatch(/if \(currentVersion < 129\) \{/);
    expect(dbSource).toMatch(/applyMigrationV129\(db\);/);
    expect(dbSource).toMatch(/INSERT INTO schema_version \(version\) VALUES \(\?\)'\)\.run\(129\)/);
  });

  it('AC-A12: re-export __V129_INTERNAL cobre as 2 chaves', () => {
    const keys = __V129_INTERNAL.CHAT_COMPACTION_SETTING_SEEDS.map(([key]) => key);
    expect(keys).toEqual([CHAT_COMPACTION_TARGET_TOKENS_SETTING_KEY, CHAT_COMPACTION_TRIGGER_PERCENT_SETTING_KEY]);
  });

  it('AC-A12 (R10 p/ settings): ipc/settings.ts leu o default da MESMA fonte unica (fresh installs)', () => {
    const settingsSource = readFileSync(join(__dirname, '..', 'ipc', 'settings.ts'), 'utf8');
    expect(settingsSource).toContain('DEFAULT_CHAT_COMPACTION_TARGET_TOKENS');
    expect(settingsSource).toContain('DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT');
    expect(settingsSource).toContain('CHAT_COMPACTION_TARGET_TOKENS_SETTING_KEY');
  });
});
