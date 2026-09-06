import type Database from 'better-sqlite3';

const COMPACTION_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['orchestrator_compaction_runtime', ''],
  ['orchestrator_compaction_provider', ''],
  ['orchestrator_compaction_model', ''],
];

export function applyMigrationV67(db: Database.Database): void {
  const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  const insertAll = db.transaction((rows: ReadonlyArray<readonly [string, string]>) => {
    for (const [key, value] of rows) {
      stmt.run(key, value);
    }
  });
  insertAll(COMPACTION_DEFAULTS);
}

export const __V67_INTERNAL = {
  COMPACTION_DEFAULTS,
};
