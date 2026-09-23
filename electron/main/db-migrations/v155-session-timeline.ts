import type Database from 'better-sqlite3';

export function applyMigrationV155(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_timeline_turns (
      seq_id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id                  TEXT NOT NULL UNIQUE,
      session_id              TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_index              INTEGER NOT NULL,
      anchor_message_id       INTEGER,
      current_user_message_id INTEGER,
      assistant_message_id    INTEGER,
      origin                  TEXT NOT NULL CHECK (origin IN ('turn','retry','system-event','swarm','cron','telegram')),
      runtime                 TEXT NOT NULL CHECK (runtime IN ('lion-sdk','grok','kimi','codex','cursor')),
      fidelity                TEXT NOT NULL CHECK (fidelity IN ('exact','observed')),
      status                  TEXT NOT NULL DEFAULT 'interrupted' CHECK (status IN ('interrupted','complete')),
      cwd                     TEXT,
      text_tokens_est         INTEGER,
      tool_tokens_est         INTEGER,
      created_at              DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_turns_anchor
      ON session_timeline_turns(session_id, anchor_message_id, seq_id);

    CREATE TABLE IF NOT EXISTS session_timeline_events (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id            TEXT NOT NULL REFERENCES session_timeline_turns(run_id) ON DELETE CASCADE,
      session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq               INTEGER NOT NULL,
      kind              TEXT NOT NULL CHECK (kind IN ('user','assistant_step','tool_call','tool_call_args','tool_result','assistant_final')),
      tool_use_id       TEXT,
      tool_name         TEXT,
      content           TEXT NOT NULL,
      tool_calls_json   TEXT,
      reasoning_content TEXT,
      is_error          INTEGER NOT NULL DEFAULT 0,
      original_bytes    INTEGER,
      spill_path        TEXT,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (run_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_events_run
      ON session_timeline_events(run_id, seq);
  `);

  const summaryColumns = db.pragma('table_info(lion_session_summaries)') as Array<{ name: string }>;
  if (summaryColumns.length === 0 || summaryColumns.some((column) => column.name === 'mode')) return;

  const recreateSummaries = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lion_session_summaries_v155 (
        session_id              TEXT    NOT NULL,
        covers_until_message_id INTEGER NOT NULL,
        mode                    TEXT    NOT NULL DEFAULT 'text' CHECK (mode IN ('text','tools')),
        selection_hash          TEXT    NOT NULL DEFAULT '',
        summary_text            TEXT    NOT NULL,
        model_used              TEXT    NOT NULL,
        provider_used           TEXT    NOT NULL,
        input_tokens            INTEGER,
        output_tokens           INTEGER,
        created_at              INTEGER NOT NULL,
        PRIMARY KEY (session_id, covers_until_message_id, mode, selection_hash),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      INSERT OR IGNORE INTO lion_session_summaries_v155
        (session_id, covers_until_message_id, mode, selection_hash, summary_text, model_used,
         provider_used, input_tokens, output_tokens, created_at)
        SELECT session_id, covers_until_message_id, 'text', '', summary_text, model_used,
               provider_used, input_tokens, output_tokens, created_at
        FROM lion_session_summaries;
      DROP TABLE lion_session_summaries;
      ALTER TABLE lion_session_summaries_v155 RENAME TO lion_session_summaries;
    `);
  });
  recreateSummaries();
}
