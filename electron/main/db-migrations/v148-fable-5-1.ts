import type Database from 'better-sqlite3';


const PREVIOUS_MODEL = 'claude-fable-5';
const NEW_MODEL = 'claude-fable-5-1';

export function applyMigrationV148(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.prepare(
      `UPDATE settings
          SET value = ?
        WHERE key = 'orchestrator_model'
          AND value = ?`,
    ).run(NEW_MODEL, PREVIOUS_MODEL);

    db.prepare(
      `UPDATE agents
          SET model = ?
        WHERE model = ?`,
    ).run(NEW_MODEL, PREVIOUS_MODEL);
  });
  migrate.immediate();
}

export const __V148_INTERNAL = { PREVIOUS_MODEL, NEW_MODEL };
