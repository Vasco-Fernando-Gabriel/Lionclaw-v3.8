import type Database from 'better-sqlite3';

const COLUMNS = [
  "parent_cost_by_runtime TEXT NOT NULL DEFAULT '{}'",
  "parent_cost_status_by_runtime TEXT NOT NULL DEFAULT '{}'",
  'parent_subscription_equivalent_cost_usd REAL NOT NULL DEFAULT 0 CHECK (parent_subscription_equivalent_cost_usd >= 0)',
] as const;

export function applyMigrationV141(db: Database.Database): void {
  const migrate = db.transaction(() => {
    for (const definition of COLUMNS) {
      try {
        db.exec(`ALTER TABLE sessions ADD COLUMN ${definition}`);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('duplicate column name')) throw error;
      }
    }
  });
  migrate.immediate();
}

export const __V141_INTERNAL = { COLUMNS };
