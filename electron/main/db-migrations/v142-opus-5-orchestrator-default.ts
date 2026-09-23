import type Database from 'better-sqlite3';

const PREVIOUS_DEFAULT_MODEL = 'claude-opus-4-8';
const NEW_DEFAULT_MODEL = 'claude-opus-5';

export function applyMigrationV142(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.prepare(
      `UPDATE settings
          SET value = ?
        WHERE key = 'orchestrator_model'
          AND value = ?`,
    ).run(NEW_DEFAULT_MODEL, PREVIOUS_DEFAULT_MODEL);
  });
  migrate.immediate();
}

export const __V142_INTERNAL = { PREVIOUS_DEFAULT_MODEL, NEW_DEFAULT_MODEL };
