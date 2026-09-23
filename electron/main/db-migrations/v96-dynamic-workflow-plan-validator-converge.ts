import type Database from 'better-sqlite3';
import { dynamicWorkflowPlanValidatorCoverage } from '../seed-agents/dynamic-workflow-plan-validator-coverage';
import { dynamicWorkflowPlanValidatorTopology } from '../seed-agents/dynamic-workflow-plan-validator-topology';
import { dynamicWorkflowPlanValidatorCriteria } from '../seed-agents/dynamic-workflow-plan-validator-criteria';

const OLD_MARKER = 'Na duvida entre P1 e P2, use P2.';
const NEW_MARKER = 'regra DURA - leia com atencao';

export function applyMigrationV96(db: Database.Database): void {
  const update = db.prepare(
    `UPDATE agents SET system_prompt = ?
     WHERE id = ?
       AND system_prompt LIKE '%' || ? || '%'
       AND system_prompt NOT LIKE '%' || ? || '%'`,
  );
  for (const seed of [
    dynamicWorkflowPlanValidatorCoverage,
    dynamicWorkflowPlanValidatorTopology,
    dynamicWorkflowPlanValidatorCriteria,
  ]) {
    update.run(seed.systemPrompt, seed.id, OLD_MARKER, NEW_MARKER);
  }
}
