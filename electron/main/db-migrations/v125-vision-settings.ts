import type Database from 'better-sqlite3';
import { VISION_DEFAULT } from '../../../src/constants/vision-models';

const VISION_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['vision_provider', VISION_DEFAULT.provider],
  ['vision_model', VISION_DEFAULT.id],
];

export function applyMigrationV125(db: Database.Database): void {
  const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  const insertAll = db.transaction((rows: ReadonlyArray<readonly [string, string]>) => {
    for (const [key, value] of rows) {
      stmt.run(key, value);
    }
  });
  insertAll(VISION_DEFAULTS);
}

export const __V125_INTERNAL = {
  VISION_DEFAULTS,
};
