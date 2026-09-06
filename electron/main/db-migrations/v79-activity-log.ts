import type Database from 'better-sqlite3';

export function applyMigrationV79(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_index INTEGER NOT NULL,
      activity_id TEXT NOT NULL,
      parent_id TEXT,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      agent_id TEXT,
      model TEXT,
      status TEXT NOT NULL,
      summary TEXT,
      file TEXT,
      command TEXT,
      files_changed TEXT,
      changed INTEGER,
      exit_code INTEGER,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      tool_uses INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      started_at TEXT,
      ended_at TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, turn_index, activity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_activity_log_session ON activity_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_turn ON activity_log(session_id, turn_index);
  `);
}

export const __V79_INTERNAL = {
  TABLE_NAME: 'activity_log',
  INDEXES: ['idx_activity_log_session', 'idx_activity_log_turn'],
};
