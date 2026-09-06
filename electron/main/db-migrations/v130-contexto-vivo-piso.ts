import type Database from 'better-sqlite3';

export function applyMigrationV130(db: Database.Database): void {
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

  addColumn('ALTER TABLE sessions ADD COLUMN agentic_context_tokens_est INTEGER');
  addColumn('ALTER TABLE sessions ADD COLUMN thread_reset_message_id INTEGER');
}

export const __V130_INTERNAL = {
  TABLE_NAME: 'sessions',
  COLUMN_NAMES: ['agentic_context_tokens_est', 'thread_reset_message_id'],
};
