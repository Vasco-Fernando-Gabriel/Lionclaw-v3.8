import type Database from 'better-sqlite3';

const VERTEX_ORCHESTRATOR_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['orchestrator_vertex_api_key_ref', ''],
  ['orchestrator_vertex_location', ''],
  ['orchestrator_vertex_project_id', ''],
  ['orchestrator_vertex_auth_mode', 'api-key'],
];

export function applyMigrationV70(db: Database.Database): void {
  const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  const insertAll = db.transaction((rows: ReadonlyArray<readonly [string, string]>) => {
    for (const [key, value] of rows) {
      stmt.run(key, value);
    }
  });
  insertAll(VERTEX_ORCHESTRATOR_DEFAULTS);
}

export const __V70_INTERNAL = {
  VERTEX_ORCHESTRATOR_DEFAULTS,
};
