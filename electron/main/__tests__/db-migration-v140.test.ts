import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationV140 } from '../db-migrations/v140-chat-metrics-quality';

describe('migration v140 chat metrics quality', () => {
  it('adds persistent parent quality columns idempotently', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    applyMigrationV140(db);
    expect(() => applyMigrationV140(db)).not.toThrow();
    const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['cost_status', 'token_status', 'unknown_cost_count', 'cost_unknown_reasons']),
    );
    db.prepare("INSERT INTO sessions(id) VALUES ('s1')").run();
    expect(db.prepare("SELECT * FROM sessions WHERE id = 's1'").get()).toEqual(
      expect.objectContaining({
        cost_status: 'known',
        token_status: 'reported',
        unknown_cost_count: 0,
        cost_unknown_reasons: '[]',
      }),
    );
  });
});
