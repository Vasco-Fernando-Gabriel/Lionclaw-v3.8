import type Database from 'better-sqlite3';
import { architectureDecisionInterviewer } from '../seed-agents';

export function applyMigrationV56(db: Database.Database): void {
  db.prepare(
    `UPDATE agents SET system_prompt = ? WHERE id = 'architecture-decision-interviewer'`,
  ).run(architectureDecisionInterviewer.systemPrompt);
}

export const __V56_INTERNAL = {
  newPrompt: architectureDecisionInterviewer.systemPrompt,
};
