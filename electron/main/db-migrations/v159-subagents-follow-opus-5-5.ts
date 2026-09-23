import type Database from 'better-sqlite3';

const PREVIOUS_MODEL = 'claude-opus-5';
const NEW_MODEL = 'claude-opus-5-5';

export function applyMigrationV159(db: Database.Database): void {
  const orchestrator = db.prepare(`SELECT value FROM settings WHERE key = 'orchestrator_model'`).get() as
    { value: string } | undefined;
  if (orchestrator?.value !== NEW_MODEL) return;

  db.prepare(
    `UPDATE agents
        SET model = ?
      WHERE runtime = 'cloud'
        AND model = ?`,
  ).run(NEW_MODEL, PREVIOUS_MODEL);
}

export const __V159_INTERNAL = { PREVIOUS_MODEL, NEW_MODEL };
