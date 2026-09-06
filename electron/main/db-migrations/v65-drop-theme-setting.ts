import type Database from 'better-sqlite3';

export function applyMigrationV65(db: Database.Database): void {
  db.prepare("DELETE FROM settings WHERE key = 'theme'").run();
}
