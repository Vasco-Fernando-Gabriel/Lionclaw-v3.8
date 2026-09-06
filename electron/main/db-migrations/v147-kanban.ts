import type Database from 'better-sqlite3';

export function applyMigrationV147(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_boards (
      id            TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL UNIQUE
                    REFERENCES local_repositories(id) ON DELETE RESTRICT,
      name          TEXT NOT NULL,
      prefix        TEXT NOT NULL UNIQUE,
      next_local_id INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kanban_cards (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id      TEXT NOT NULL REFERENCES kanban_boards(id) ON DELETE CASCADE,
      local_id      INTEGER NOT NULL,
      title         TEXT NOT NULL,
      board_column  TEXT NOT NULL DEFAULT 'Backlog'
                    CHECK (board_column IN
                    ('Backlog','Desenvolvimento','Testes','Done')),
      type          TEXT CHECK (type IN
                    ('Bug','Feature','Débito técnico','Chore')),
      priority      TEXT CHECK (priority IN ('Crítica','Alta','Média','Baixa')),
      complexity    TEXT CHECK (complexity IN ('Baixa','Média','Alta')),
      severity      TEXT CHECK (severity IN ('S1','S2','S3','S4')),
      problem              TEXT,
      acceptance_criteria  TEXT,
      reproduction         TEXT,
      acceptance_tests     TEXT,
      commit_url    TEXT,
      doc_ref       TEXT,
      start_date    TEXT,
      due_date      TEXT,
      body          TEXT,
      archived      INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (board_id, local_id)
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_board
      ON kanban_cards(board_id, board_column);

    CREATE TABLE IF NOT EXISTS kanban_card_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id     INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
      event       TEXT NOT NULL CHECK (event IN
                  ('created','moved','delivered','edited','reopened',
                   'archived','unarchived','attachment-added',
                   'attachment-removed')),
      from_column TEXT,
      to_column   TEXT,
      reason      TEXT,
      actor       TEXT NOT NULL CHECK (actor IN ('user','orchestrator','scheduler')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_events_card
      ON kanban_card_events(card_id, created_at);

    CREATE TABLE IF NOT EXISTS kanban_card_attachments (
      id          TEXT PRIMARY KEY,
      card_id     INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
      filename    TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      mime        TEXT,
      size_bytes  INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
