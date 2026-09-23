import type Database from 'better-sqlite3';
import { architectureTargetTriage } from '../seed-agents';

export function applyMigrationV54(db: Database.Database): void {
  db.prepare(`UPDATE agents SET system_prompt = ? WHERE id = 'architecture-target-triage'`).run(
    architectureTargetTriage.systemPrompt,
  );
}

export const __V54_INTERNAL = {
  newPrompt: architectureTargetTriage.systemPrompt,
};
