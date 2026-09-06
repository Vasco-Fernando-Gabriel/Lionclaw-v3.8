import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationV139 } from '../db-migrations/v139-provider-metrics-resume';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE enrich_sessions (id TEXT PRIMARY KEY);
    CREATE TABLE security_agent_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      status TEXT NOT NULL,
      output_file TEXT
    );
  `);
  return db;
}

describe('migration v139 provider metrics and security resume', () => {
  it('adds enrich quality/provenance columns idempotently', () => {
    const db = makeDb();
    applyMigrationV139(db);
    expect(() => applyMigrationV139(db)).not.toThrow();
    const columns = db.prepare('PRAGMA table_info(enrich_sessions)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'validator_cost_status',
      'validator_token_status',
      'validator_cost_source',
      'validator_unknown_cost_count',
      'enricher_cost_status',
      'enricher_token_status',
      'enricher_cost_source',
      'enricher_unknown_cost_count',
    ]));
  });

  it('keeps completed checkpoint and enforces one row per project/agent', () => {
    const db = makeDb();
    db.exec(`
      INSERT INTO security_agent_status(project_id, agent_id, agent_name, status)
        VALUES ('p1', 'a1', 'Agent', 'completed');
      INSERT INTO security_agent_status(project_id, agent_id, agent_name, status)
        VALUES ('p1', 'a1', 'Agent', 'pending');
    `);
    applyMigrationV139(db);
    const rows = db.prepare(
      "SELECT status FROM security_agent_status WHERE project_id='p1' AND agent_id='a1'",
    ).all() as Array<{ status: string }>;
    expect(rows).toEqual([{ status: 'completed' }]);
    expect(() => db.prepare(`
      INSERT INTO security_agent_status(project_id, agent_id, agent_name, status)
      VALUES ('p1', 'a1', 'Agent', 'pending')
    `).run()).toThrow();
  });
});
