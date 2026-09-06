import type Database from 'better-sqlite3';

export function applyMigrationV84(db: Database.Database): void {
  db.prepare(
    `UPDATE agents
        SET effort = 'high', thinking_budget = 6000
      WHERE id = 'dynamic-workflow-builder'
        AND effort = 'max'
        AND thinking_budget = 16000`,
  ).run();
}
