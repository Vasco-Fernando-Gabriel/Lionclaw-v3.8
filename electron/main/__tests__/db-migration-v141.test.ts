import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationV141 } from '../db-migrations/v141-chat-parent-runtime-metrics';

describe('migration v141 chat parent runtime metrics', () => {
  it('adiciona defaults compativeis e preserva linhas existentes', () => {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT); INSERT INTO sessions VALUES ('s1', 'preservar')");

    applyMigrationV141(db);
    expect(() => applyMigrationV141(db)).not.toThrow();

    expect(db.prepare("SELECT * FROM sessions WHERE id = 's1'").get()).toEqual(
      expect.objectContaining({
        title: 'preservar',
        parent_cost_by_runtime: '{}',
        parent_cost_status_by_runtime: '{}',
        parent_subscription_equivalent_cost_usd: 0,
      }),
    );
    expect(db.prepare('PRAGMA table_info(sessions)').all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'parent_cost_by_runtime' }),
        expect.objectContaining({ name: 'parent_cost_status_by_runtime' }),
        expect.objectContaining({ name: 'parent_subscription_equivalent_cost_usd' }),
      ]),
    );
  });
});
