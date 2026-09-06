
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';

import {
  applyMigrationV127,
  __V127_INTERNAL,
} from '../db-migrations/v127-chat-feature-toggles';


interface Harness {
  sqlite: DatabaseSync;
  db: Database.Database;
}

function makeDb(): Harness {
  const sqlite = new DatabaseSync(':memory:', {
    enableForeignKeyConstraints: true,
  });
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      type TEXT DEFAULT 'chat',
      status TEXT DEFAULT 'active',
      title TEXT
    );
  `);
  return { sqlite, db: sqlite as unknown as Database.Database };
}

function seedSessions(sqlite: DatabaseSync): void {
  const insert = sqlite.prepare(
    'INSERT INTO sessions (id, type, status) VALUES (?, ?, ?)',
  );
  insert.run('sess-chat', 'chat', 'active');
  insert.run('sess-manual', 'manual', 'archived');
  insert.run('sess-telegram', 'telegram', 'active');
  insert.run('sess-scheduled', 'scheduled', 'active');
  insert.run('sess-null-type', null, 'active');
}

interface FeatureRow {
  session_id: string;
  pipeline_control_enabled: number;
  dynamic_workflows_enabled: number;
}

function featureRow(sqlite: DatabaseSync, sessionId: string): FeatureRow | undefined {
  return sqlite
    .prepare(
      `SELECT session_id, pipeline_control_enabled, dynamic_workflows_enabled
         FROM chat_session_features WHERE session_id = ?`,
    )
    .get(sessionId) as FeatureRow | undefined;
}


describe('applyMigrationV127 - shape da tabela chat_session_features', () => {
  it('cria a tabela com as 4 colunas da A.2 (PK, NOT NULL DEFAULT 0 nas flags)', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV127(db);

    const columns = sqlite
      .prepare("PRAGMA table_info('chat_session_features')")
      .all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;

    expect(columns.map((c) => c.name)).toEqual([
      'session_id',
      'pipeline_control_enabled',
      'dynamic_workflows_enabled',
      'updated_at',
    ]);

    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get('session_id')?.pk).toBe(1);
    for (const flag of ['pipeline_control_enabled', 'dynamic_workflows_enabled']) {
      expect(byName.get(flag)?.notnull).toBe(1);
      expect(byName.get(flag)?.dflt_value).toBe('0');
      expect(byName.get(flag)?.type).toBe('INTEGER');
    }
  });

  it('FK para sessions(id) com ON DELETE CASCADE', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV127(db);

    const fks = sqlite
      .prepare("PRAGMA foreign_key_list('chat_session_features')")
      .all() as Array<{ table: string; from: string; to: string; on_delete: string }>;

    expect(fks).toHaveLength(1);
    expect(fks[0].table).toBe('sessions');
    expect(fks[0].from).toBe('session_id');
    expect(fks[0].on_delete).toBe('CASCADE');
  });

  it('hard-delete da sessao CASCADEIA a linha de toggles (FK on, como producao)', () => {
    const { sqlite, db } = makeDb();
    seedSessions(sqlite);
    applyMigrationV127(db);

    expect(featureRow(sqlite, 'sess-chat')).toBeDefined();
    sqlite.prepare('DELETE FROM sessions WHERE id = ?').run('sess-chat');
    expect(featureRow(sqlite, 'sess-chat')).toBeUndefined();
  });
});


describe('applyMigrationV127 - backfill', () => {
  it('chat e manual existentes recebem 1/1 (preserva comportamento atual)', () => {
    const { sqlite, db } = makeDb();
    seedSessions(sqlite);
    applyMigrationV127(db);

    for (const id of ['sess-chat', 'sess-manual']) {
      const row = featureRow(sqlite, id);
      expect(row).toBeDefined();
      expect(row?.pipeline_control_enabled).toBe(1);
      expect(row?.dynamic_workflows_enabled).toBe(1);
    }
  });

  it('telegram e scheduled ficam SEM linha', () => {
    const { sqlite, db } = makeDb();
    seedSessions(sqlite);
    applyMigrationV127(db);

    expect(featureRow(sqlite, 'sess-telegram')).toBeUndefined();
    expect(featureRow(sqlite, 'sess-scheduled')).toBeUndefined();
    const total = sqlite
      .prepare('SELECT COUNT(*) AS n FROM chat_session_features')
      .get() as { n: number };
    expect(total.n).toBe(3); // sess-chat + sess-manual + sess-null-type
  });

  it('type NULL legado e tratado como chat (COALESCE, mesmo racional do rebuild V7)', () => {
    const { sqlite, db } = makeDb();
    seedSessions(sqlite);
    applyMigrationV127(db);

    const row = featureRow(sqlite, 'sess-null-type');
    expect(row?.pipeline_control_enabled).toBe(1);
    expect(row?.dynamic_workflows_enabled).toBe(1);
  });

  it('DB sem sessoes: migration roda limpa e tabela nasce vazia', () => {
    const { sqlite, db } = makeDb();
    expect(() => applyMigrationV127(db)).not.toThrow();
    const total = sqlite
      .prepare('SELECT COUNT(*) AS n FROM chat_session_features')
      .get() as { n: number };
    expect(total.n).toBe(0);
  });
});


describe('applyMigrationV127 - idempotencia', () => {
  it('re-rodar nao lanca e nao duplica linhas', () => {
    const { sqlite, db } = makeDb();
    seedSessions(sqlite);
    applyMigrationV127(db);
    expect(() => applyMigrationV127(db)).not.toThrow();

    const total = sqlite
      .prepare('SELECT COUNT(*) AS n FROM chat_session_features')
      .get() as { n: number };
    expect(total.n).toBe(3);
  });

  it('re-rodar NAO sobrescreve valor customizado (INSERT OR IGNORE preserva o usuario)', () => {
    const { sqlite, db } = makeDb();
    seedSessions(sqlite);
    applyMigrationV127(db);

    sqlite
      .prepare(
        `UPDATE chat_session_features
            SET pipeline_control_enabled = 0, dynamic_workflows_enabled = 0
          WHERE session_id = 'sess-chat'`,
      )
      .run();
    applyMigrationV127(db);

    const row = featureRow(sqlite, 'sess-chat');
    expect(row?.pipeline_control_enabled).toBe(0);
    expect(row?.dynamic_workflows_enabled).toBe(0);
  });

  it('sessao criada DEPOIS da migration nao e tocada por re-run (backfill so pega quem nao tem linha... e o ensure ja da 0/0)', () => {
    const { sqlite, db } = makeDb();
    seedSessions(sqlite);
    applyMigrationV127(db);

    sqlite.prepare("INSERT INTO sessions (id, type, status) VALUES ('sess-new', 'chat', 'active')").run();
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO chat_session_features
           (session_id, pipeline_control_enabled, dynamic_workflows_enabled)
         VALUES ('sess-new', 0, 0)`,
      )
      .run();

    applyMigrationV127(db);
    const row = featureRow(sqlite, 'sess-new');
    expect(row?.pipeline_control_enabled).toBe(0);
    expect(row?.dynamic_workflows_enabled).toBe(0);
  });
});


describe('__V127_INTERNAL - SQL da migration', () => {
  it('CREATE e IF NOT EXISTS com FK ON DELETE CASCADE; backfill e INSERT OR IGNORE com filtro desktop', () => {
    expect(__V127_INTERNAL.CREATE_CHAT_SESSION_FEATURES).toMatch(
      /CREATE TABLE IF NOT EXISTS chat_session_features/,
    );
    expect(__V127_INTERNAL.CREATE_CHAT_SESSION_FEATURES).toMatch(
      /REFERENCES sessions\(id\) ON DELETE CASCADE/,
    );
    expect(__V127_INTERNAL.BACKFILL_DESKTOP_SESSIONS_LEGACY_ON).toMatch(
      /INSERT OR IGNORE INTO chat_session_features/,
    );
    expect(__V127_INTERNAL.BACKFILL_DESKTOP_SESSIONS_LEGACY_ON).toMatch(
      /COALESCE\(type, 'chat'\) IN \('chat', 'manual'\)/,
    );
    expect(__V127_INTERNAL.BACKFILL_DESKTOP_SESSIONS_LEGACY_ON).not.toMatch(/telegram|scheduled/);
  });
});


describe('guardrail estatico - runner da V127 em db.ts', () => {
  const dbSource = readFileSync(join(__dirname, '..', 'db.ts'), 'utf-8');

  it('importa e aplica a V127 com bump de schema_version', () => {
    expect(dbSource).toContain("from './db-migrations/v127-chat-feature-toggles'");
    expect(dbSource).toContain('if (currentVersion < 127)');
    expect(dbSource).toContain('applyMigrationV127(db)');
    expect(dbSource).toMatch(/INSERT INTO schema_version \(version\) VALUES \(\?\)'\)\.run\(127\)/);
  });
});
