import type Database from 'better-sqlite3';
import { DYNAMIC_WORKFLOW_SPRINT_STATUSES } from '../../../src/types/dynamic-workflow';

function checkIn(column: string, values: readonly string[]): string {
  return `CHECK (${column} IN (${values.map((v) => `'${v}'`).join(', ')}))`;
}

export const V87_SPRINTS_SQL = `
    CREATE TABLE IF NOT EXISTS dynamic_workflow_sprints (
      run_id TEXT NOT NULL,
      sprint_id TEXT NOT NULL,            -- <- PlannedSprint.id
      plan_version INTEGER NOT NULL,      -- <- DynamicWorkflowSprintPlan.planVersion
      plan_hash TEXT NOT NULL,            -- <- planHash da versao que materializou (integridade/idempotencia)
      sprint_index INTEGER NOT NULL,      -- <- PlannedSprint.index
      name TEXT NOT NULL,
      coder_agent_id TEXT,                -- <- coderAgentId
      validator_agent_ids_json TEXT,      -- <- validatorAgentIds[]
      features_json TEXT,                 -- <- features[]
      write_set_hint_json TEXT,           -- <- writeSetHint[]
      dependencies_json TEXT,             -- <- dependencies[]
      max_rounds INTEGER,                 -- <- maxRounds
      status TEXT NOT NULL DEFAULT 'pending'
        ${checkIn('status', DYNAMIC_WORKFLOW_SPRINT_STATUSES)},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, sprint_id),
      FOREIGN KEY (run_id) REFERENCES dynamic_workflow_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_dyn_wf_sprints_run ON dynamic_workflow_sprints(run_id);
`;

export function applyMigrationV87(db: Database.Database): void {
  db.exec(V87_SPRINTS_SQL);

  try {
    db.exec('ALTER TABLE dynamic_workflow_nodes ADD COLUMN sprint_id TEXT');
  } catch {}
  try {
    db.exec('ALTER TABLE dynamic_workflow_nodes ADD COLUMN round_index INTEGER');
  } catch {}
}

export const __V87_INTERNAL = {
  TABLES: ['dynamic_workflow_sprints'],
  INDEXES: ['idx_dyn_wf_sprints_run'],
  ADDED_COLUMNS: ['sprint_id', 'round_index'],
  checkIn,
};
