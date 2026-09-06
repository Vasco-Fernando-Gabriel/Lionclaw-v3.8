import type Database from 'better-sqlite3';

export function applyMigrationV57(db: Database.Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_usage_session;
    DROP INDEX IF EXISTS idx_usage_created;
    DROP INDEX IF EXISTS idx_usage_model;
    DROP TABLE IF EXISTS token_usage;
  `);
}
