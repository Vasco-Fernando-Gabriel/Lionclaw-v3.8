import type Database from 'better-sqlite3';

const MINIMAX_TOKEN_PLAN_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['orchestrator_minimax_api_key_ref', ''],
];

export function applyMigrationV71(db: Database.Database): void {
  const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  const insertAll = db.transaction((rows: ReadonlyArray<readonly [string, string]>) => {
    for (const [key, value] of rows) {
      stmt.run(key, value);
    }
  });
  insertAll(MINIMAX_TOKEN_PLAN_DEFAULTS);
}

export const __V71_INTERNAL = {
  MINIMAX_TOKEN_PLAN_DEFAULTS,
};
