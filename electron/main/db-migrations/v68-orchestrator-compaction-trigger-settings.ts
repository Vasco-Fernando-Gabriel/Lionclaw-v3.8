import type Database from 'better-sqlite3';

const COMPACTION_TRIGGER_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['orchestrator_context_window_tokens', ''],
  ['orchestrator_compaction_threshold_percent', '70'],
];

export function applyMigrationV68(db: Database.Database): void {
  const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  const insertAll = db.transaction((rows: ReadonlyArray<readonly [string, string]>) => {
    for (const [key, value] of rows) {
      stmt.run(key, value);
    }
  });
  insertAll(COMPACTION_TRIGGER_DEFAULTS);
}

export const __V68_INTERNAL = {
  COMPACTION_TRIGGER_DEFAULTS,
};
