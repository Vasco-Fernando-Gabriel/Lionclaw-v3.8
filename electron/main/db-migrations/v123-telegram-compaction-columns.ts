import type Database from 'better-sqlite3';

export function applyMigrationV123(db: Database.Database): void {
  const addColumn = (sql: string): void => {
    try {
      db.exec(sql);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!msg.includes('duplicate column name')) {
        throw err;
      }
    }
  };

  addColumn('ALTER TABLE sessions ADD COLUMN compacted_up_to_message_id INTEGER');
  addColumn('ALTER TABLE sessions ADD COLUMN rolling_summary TEXT');
  addColumn('ALTER TABLE sessions ADD COLUMN pending_seed TEXT');
  addColumn('ALTER TABLE sessions ADD COLUMN active_context_tokens_est INTEGER');
}

export const __V123_INTERNAL = {
  TABLE_NAME: 'sessions',
  COLUMN_NAMES: ['compacted_up_to_message_id', 'rolling_summary', 'pending_seed', 'active_context_tokens_est'],
};
