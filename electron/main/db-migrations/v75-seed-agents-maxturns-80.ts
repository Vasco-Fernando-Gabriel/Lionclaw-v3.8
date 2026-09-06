import type Database from 'better-sqlite3';
import { listSeedAgentIds } from '../seed-agents';

export function applyMigrationV75(db: Database.Database): void {
  const seedIds = listSeedAgentIds();
  const placeholders = seedIds.map(() => '?').join(',');
  db.prepare(
    `UPDATE agents SET max_turns = 80, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`
  ).run(...seedIds);
}
