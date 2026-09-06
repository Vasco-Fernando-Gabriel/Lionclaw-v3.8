import type Database from 'better-sqlite3';
import { pipe2SpecBuilder } from '../seed-agents/pipe2-spec-builder';
import { pipe2DesignPlanValidator } from '../seed-agents/pipe2-design-plan-validator';
import { pipe2DesignPlanner } from '../seed-agents/pipe2-design-planner';

export function applyMigrationV136(db: Database.Database): void {
  const seeds = [pipe2SpecBuilder, pipe2DesignPlanValidator, pipe2DesignPlanner];
  const updateDescription = db.prepare(
    'UPDATE agents SET description = ? WHERE id = ? AND description = ?',
  );
  const updatePrompt = db.prepare(
    'UPDATE agents SET system_prompt = ? WHERE id = ? AND system_prompt = ?',
  );
  for (const seed of seeds) {
    const oldDescription = seed.description.replaceAll('LionDesign', 'Open Design');
    const oldPrompt = seed.systemPrompt.replaceAll('LionDesign', 'Open Design');
    if (oldDescription !== seed.description) {
      updateDescription.run(seed.description, seed.id, oldDescription);
    }
    if (oldPrompt !== seed.systemPrompt) {
      updatePrompt.run(seed.systemPrompt, seed.id, oldPrompt);
    }
  }
}
