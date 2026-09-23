import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ALL_SESSIONS_SQL } from '../sessions-query';

function seed(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      task_id TEXT NULL,
      title TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const insert = db.prepare(
    'INSERT INTO sessions (id, type, status, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run('lane-a', 'chat', 'active', null, 'Lane A', '2026-09-08T09:00:00Z', '2026-09-08T09:00:00Z');
  insert.run('dw-drive-run1', 'chat', 'active', null, 'Drive run1', '2026-09-08T10:00:00Z', '2026-09-08T10:00:00Z');
  insert.run('tg-1', 'telegram', 'active', null, 'Telegram', '2026-09-08T08:00:00Z', '2026-09-08T08:00:00Z');
  insert.run('sched', 'chat', 'active', null, '[Scheduler] job', '2026-09-08T07:00:00Z', '2026-09-08T07:00:00Z');
  insert.run('trashed', 'chat', 'trashed', null, 'Lixo', '2026-09-08T06:00:00Z', '2026-09-08T06:00:00Z');
  return db;
}

describe('P2-1 (glossario): getAllSessions exclui sessoes dw-drive-*', () => {
  it('a sessao de drive de workflow nunca aparece na lista da sidebar', () => {
    const db = seed();
    const rows = db.prepare(ALL_SESSIONS_SQL).all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['lane-a', 'tg-1']);
    db.close();
  });
});
