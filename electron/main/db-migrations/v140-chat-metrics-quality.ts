import type Database from 'better-sqlite3';

const COLUMNS = [
  "cost_status TEXT NOT NULL DEFAULT 'known' CHECK (cost_status IN ('known', 'unknown', 'estimated-partial'))",
  "token_status TEXT NOT NULL DEFAULT 'reported' CHECK (token_status IN ('reported', 'not_reported'))",
  'unknown_cost_count INTEGER NOT NULL DEFAULT 0',
  "cost_unknown_reasons TEXT NOT NULL DEFAULT '[]'",
] as const;

export function applyMigrationV140(db: Database.Database): void {
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

export const __V140_INTERNAL = { COLUMNS };
