import type Database from 'better-sqlite3';

export function applyMigrationV66(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lion_session_summaries (
      session_id              TEXT    NOT NULL,
      summary_text            TEXT    NOT NULL,
      covers_until_message_id INTEGER NOT NULL,
      model_used              TEXT    NOT NULL,
      provider_used           TEXT    NOT NULL,
      input_tokens            INTEGER,
      output_tokens           INTEGER,
      created_at              INTEGER NOT NULL,
      PRIMARY KEY (session_id, covers_until_message_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
}
