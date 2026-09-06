
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';

import {
  applyMigrationV130,
  __V130_INTERNAL,
} from '../db-migrations/v130-contexto-vivo-piso';

function makeSessionsDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      compacted_up_to_message_id INTEGER,
      rolling_summary TEXT,
      pending_seed TEXT,
      active_context_tokens_est INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function columnNames(db: DatabaseSync): string[] {
  return (db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

describe('contexto-vivo §6 — migration V130 (colunas do PISO forte em sessions)', () => {
  it('adiciona as 2 colunas nullable; sessoes existentes ficam NULL (caminhos byte-identicos)', () => {
    const db = makeSessionsDb();
    db.exec("INSERT INTO sessions (id) VALUES ('pre-existente')");

    applyMigrationV130(db as unknown as Database.Database);

    const cols = columnNames(db);
    for (const col of __V130_INTERNAL.COLUMN_NAMES) {
      expect(cols).toContain(col);
    }
    const row = db
      .prepare('SELECT agentic_context_tokens_est, thread_reset_message_id FROM sessions WHERE id = ?')
      .get('pre-existente') as Record<string, unknown>;
    expect(row.agentic_context_tokens_est).toBeNull();
    expect(row.thread_reset_message_id).toBeNull();
  });

  it('idempotente: re-aplicar e no-op (engole SO "duplicate column name")', () => {
    const db = makeSessionsDb();
    applyMigrationV130(db as unknown as Database.Database);
    expect(() => applyMigrationV130(db as unknown as Database.Database)).not.toThrow();
    const cols = columnNames(db);
    expect(cols.filter((c) => c === 'agentic_context_tokens_est').length).toBe(1);
    expect(cols.filter((c) => c === 'thread_reset_message_id').length).toBe(1);
  });

  it('erro que NAO e duplicate column name propaga (nunca engolido)', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => applyMigrationV130(db as unknown as Database.Database)).toThrow(/no such table/);
  });

  it('semantica do UPDATE do acumulador (mesmo SQL do setter): fence na MESMA escrita e opcional', () => {
    const db = makeSessionsDb();
    applyMigrationV130(db as unknown as Database.Database);
    db.exec("INSERT INTO sessions (id) VALUES ('s1')");

    db.prepare(
      "UPDATE sessions SET agentic_context_tokens_est = ?, thread_reset_message_id = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(48210, 77, 's1');
    let row = db
      .prepare('SELECT agentic_context_tokens_est, thread_reset_message_id FROM sessions WHERE id = ?')
      .get('s1') as Record<string, unknown>;
    expect(row.agentic_context_tokens_est).toBe(48210);
    expect(row.thread_reset_message_id).toBe(77);

    db.prepare(
      "UPDATE sessions SET agentic_context_tokens_est = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(50999, 's1');
    row = db
      .prepare('SELECT agentic_context_tokens_est, thread_reset_message_id FROM sessions WHERE id = ?')
      .get('s1') as Record<string, unknown>;
    expect(row.agentic_context_tokens_est).toBe(50999);
    expect(row.thread_reset_message_id).toBe(77);
  });
});
