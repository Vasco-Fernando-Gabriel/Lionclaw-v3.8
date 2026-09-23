import type Database from 'better-sqlite3';

const VALIDATOR_IDS = [
  'dynamic-workflow-validator-tests',
  'dynamic-workflow-validator-spec',
  'dynamic-workflow-validator-regression',
  'dynamic-workflow-plan-validator-coverage',
  'dynamic-workflow-plan-validator-criteria',
  'dynamic-workflow-plan-validator-topology',
] as const;

const OLD_MODEL = 'claude-sonnet-4-6';
const NEW_MODEL = 'claude-haiku-4-5-20251001';

export function applyMigrationV145(db: Database.Database): void {
  const update = db.prepare('UPDATE agents SET model = ? WHERE id = ? AND model = ?');
  for (const id of VALIDATOR_IDS) {
    update.run(NEW_MODEL, id, OLD_MODEL);
  }
}
