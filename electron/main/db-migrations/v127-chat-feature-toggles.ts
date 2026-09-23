import type Database from 'better-sqlite3';

const CREATE_CHAT_SESSION_FEATURES = `
  CREATE TABLE IF NOT EXISTS chat_session_features (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    pipeline_control_enabled INTEGER NOT NULL DEFAULT 0,
    dynamic_workflows_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

const BACKFILL_DESKTOP_SESSIONS_LEGACY_ON = `
  INSERT OR IGNORE INTO chat_session_features
    (session_id, pipeline_control_enabled, dynamic_workflows_enabled)
  SELECT id, 1, 1
    FROM sessions
   WHERE COALESCE(type, 'chat') IN ('chat', 'manual');
`;

export function applyMigrationV127(db: Database.Database): void {
  db.exec(CREATE_CHAT_SESSION_FEATURES);
  db.exec(BACKFILL_DESKTOP_SESSIONS_LEGACY_ON);
}

export const __V127_INTERNAL = {
  CREATE_CHAT_SESSION_FEATURES,
  BACKFILL_DESKTOP_SESSIONS_LEGACY_ON,
};
