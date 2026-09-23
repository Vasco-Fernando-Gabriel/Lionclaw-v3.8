import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';

let memoryDb: DatabaseSync;

vi.mock('../../../db', () => ({
  getDb: () => memoryDb as unknown as Database.Database,
}));

import { getCachedSummary, saveCachedSummary } from '../db';

const SESSION_ID = 'sess-timeline-cache';
const COVERS_UNTIL = 42;

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE lion_session_summaries (
      session_id              TEXT    NOT NULL,
      covers_until_message_id INTEGER NOT NULL,
      mode                    TEXT    NOT NULL DEFAULT 'text' CHECK (mode IN ('text','tools')),
      selection_hash          TEXT    NOT NULL DEFAULT '',
      summary_text            TEXT    NOT NULL,
      model_used              TEXT    NOT NULL,
      provider_used           TEXT    NOT NULL,
      input_tokens            INTEGER,
      output_tokens           INTEGER,
      created_at              INTEGER NOT NULL,
      PRIMARY KEY (session_id, covers_until_message_id, mode, selection_hash)
    );
  `);
  return db;
}

beforeEach(() => {
  memoryDb = makeDb();
});

describe('cache de resumos por (sessao, fronteira, mode, selection_hash)', () => {
  it('cada chave devolve o proprio resumo na mesma fronteira', () => {
    saveCachedSummary(SESSION_ID, COVERS_UNTIL, 'text', '', 'resumo text', 'qwen', 'ollama', {
      inputTokens: 10,
      outputTokens: 5,
    });
    saveCachedSummary(SESSION_ID, COVERS_UNTIL, 'tools', 'hash-a', 'resumo tools A', 'qwen', 'ollama', {});
    saveCachedSummary(SESSION_ID, COVERS_UNTIL, 'tools', 'hash-b', 'resumo tools B', 'qwen', 'ollama', {});

    expect(getCachedSummary(SESSION_ID, COVERS_UNTIL, 'text', '')?.summary_text).toBe('resumo text');
    expect(getCachedSummary(SESSION_ID, COVERS_UNTIL, 'tools', 'hash-a')?.summary_text).toBe('resumo tools A');
    expect(getCachedSummary(SESSION_ID, COVERS_UNTIL, 'tools', 'hash-b')?.summary_text).toBe('resumo tools B');

    const rows = memoryDb
      .prepare('SELECT mode, selection_hash FROM lion_session_summaries ORDER BY mode, selection_hash')
      .all() as Array<{ mode: string; selection_hash: string }>;
    expect(rows).toEqual([
      { mode: 'text', selection_hash: '' },
      { mode: 'tools', selection_hash: 'hash-a' },
      { mode: 'tools', selection_hash: 'hash-b' },
    ]);
  });

  it('hash diferente na mesma fronteira e cache miss; mesma chave sobrescreve sem duplicar', () => {
    saveCachedSummary(SESSION_ID, COVERS_UNTIL, 'tools', 'hash-a', 'primeiro', 'qwen', 'ollama', {});

    expect(getCachedSummary(SESSION_ID, COVERS_UNTIL, 'tools', 'hash-z')).toBeNull();
    expect(getCachedSummary(SESSION_ID, COVERS_UNTIL, 'text', '')).toBeNull();
    expect(getCachedSummary('outra-sessao', COVERS_UNTIL, 'tools', 'hash-a')).toBeNull();

    saveCachedSummary(SESSION_ID, COVERS_UNTIL, 'tools', 'hash-a', 'segundo', 'qwen', 'ollama', {});

    expect(getCachedSummary(SESSION_ID, COVERS_UNTIL, 'tools', 'hash-a')?.summary_text).toBe('segundo');
    const count = memoryDb.prepare('SELECT COUNT(*) AS n FROM lion_session_summaries').get() as { n: number };
    expect(count.n).toBe(1);
  });
});
