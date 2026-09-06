import type Database from 'better-sqlite3';

export function applyMigrationV81(db: Database.Database): void {
  try {
    db.exec('ALTER TABLE activity_log ADD COLUMN project_id TEXT');
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (!msg.includes('duplicate column name')) {
      throw err;
    }
  }
}

export const __V81_INTERNAL = {
  TABLE_NAME: 'activity_log',
  COLUMN_NAME: 'project_id',
};
