import type Database from 'better-sqlite3';
import { architectureMapper } from '../seed-agents';

export function applyMigrationV55(db: Database.Database): void {
  db.prepare(
    `UPDATE agents SET system_prompt = ? WHERE id = 'architecture-mapper'`,
  ).run(architectureMapper.systemPrompt);
}

export const __V55_INTERNAL = {
  newPrompt: architectureMapper.systemPrompt,
};
