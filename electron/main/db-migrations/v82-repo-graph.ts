import type Database from 'better-sqlite3';

export function applyMigrationV82(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      canonical_root_path TEXT NOT NULL UNIQUE,
      git_root TEXT,
      provider TEXT NOT NULL DEFAULT 'codegraph',
      graph_path TEXT,
      status TEXT NOT NULL DEFAULT 'absent'
        CHECK (status IN ('absent','building','ready','stale','error')),
      indexed_commit TEXT,
      indexed_worktree_hash TEXT,
      last_indexed_at TEXT,
      stats_json TEXT,
      graph_prompt_suppressed_global INTEGER NOT NULL DEFAULT 0,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS repo_graph_runs (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES local_repositories(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('build','update')),
      status TEXT NOT NULL CHECK (status IN ('running','done','error','cancelled')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      duration_ms INTEGER DEFAULT 0,
      output TEXT,
      error TEXT,
      stats_json TEXT
    );

    CREATE TABLE IF NOT EXISTS session_active_repository (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL REFERENCES local_repositories(id) ON DELETE CASCADE,
      graph_prompt_suppressed INTEGER NOT NULL DEFAULT 0,
      attached_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS repo_graph_turn_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_index INTEGER NOT NULL,
      repository_id TEXT NOT NULL REFERENCES local_repositories(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      runtime TEXT,
      tool_name TEXT,
      used INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      result_count INTEGER DEFAULT 0,
      bytes_returned INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rgtu_session_turn ON repo_graph_turn_usage(session_id, turn_index);
  `);
}

export const __V82_INTERNAL = {
  TABLES: ['local_repositories', 'repo_graph_runs', 'session_active_repository', 'repo_graph_turn_usage'],
  INDEXES: ['idx_rgtu_session_turn'],
};
