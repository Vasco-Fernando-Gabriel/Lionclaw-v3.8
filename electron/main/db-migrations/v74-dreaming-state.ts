import type Database from 'better-sqlite3';

export function applyMigrationV74(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dreaming_state (
      id                    INTEGER PRIMARY KEY CHECK (id = 1),
      last_gate_run_at      INTEGER,
      last_turn_run_at      INTEGER,
      turn_count            INTEGER NOT NULL DEFAULT 0,
      total_turn_runs       INTEGER NOT NULL DEFAULT 0,
      total_turn_failsafes  INTEGER NOT NULL DEFAULT 0
    );

    INSERT OR IGNORE INTO dreaming_state (id, turn_count, total_turn_runs, total_turn_failsafes)
      VALUES (1, 0, 0, 0);
  `);

  const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  const insertAll = db.transaction(() => {
    stmt.run('dreaming_turn_based_enabled', 'false');
    stmt.run('dreaming_turn_based_interval', '20');
    stmt.run('dreaming_turn_based_model', '');
  });
  insertAll();
}

export const __V74_INTERNAL = {
  TABLE_NAME: 'dreaming_state',
  SETTINGS: ['dreaming_turn_based_enabled', 'dreaming_turn_based_interval', 'dreaming_turn_based_model'],
};
