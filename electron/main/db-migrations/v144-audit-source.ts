import type Database from 'better-sqlite3';

export function applyMigrationV144(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(audit_log)').all() as { name: string }[];
  if (!columns.some((col) => col.name === 'source')) {
    db.exec('ALTER TABLE audit_log ADD COLUMN source TEXT');
  }
  db.exec("UPDATE audit_log SET source = 'chat' WHERE source IS NULL");
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_source ON audit_log(source)');
}
