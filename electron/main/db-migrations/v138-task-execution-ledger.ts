import type Database from 'better-sqlite3';

const COLUMNS = [
  'execution_id TEXT',
  'root_execution_id TEXT',
  'parent_execution_id TEXT',
  "execution_kind TEXT CHECK (execution_kind IS NULL OR execution_kind IN ('root', 'subagent', 'native-task'))",
  "owner_kind TEXT CHECK (owner_kind IS NULL OR owner_kind IN ('chat', 'pipeline', 'harness', 'workflow', 'enrich'))",
  'owner_id TEXT',
  'runtime TEXT',
  'provider TEXT',
  "cost_status TEXT CHECK (cost_status IS NULL OR cost_status IN ('known', 'unknown', 'estimated-partial'))",
  "token_status TEXT CHECK (token_status IS NULL OR token_status IN ('reported', 'not_reported'))",
  'cost_unknown_reason TEXT',
  'metadata TEXT',
] as const;

export function applyMigrationV138(db: Database.Database): void {
  const migrate = db.transaction(() => {
    for (const definition of COLUMNS) {
      try {
        db.exec(`ALTER TABLE task_executions ADD COLUMN ${definition}`);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('duplicate column name')) throw error;
      }
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_exec_execution_id
        ON task_executions(execution_id) WHERE execution_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_task_exec_root ON task_executions(root_execution_id);
      CREATE INDEX IF NOT EXISTS idx_task_exec_parent ON task_executions(parent_execution_id);
      CREATE INDEX IF NOT EXISTS idx_task_exec_owner ON task_executions(owner_kind, owner_id);
    `);
  });
  migrate.immediate();
}

export const __V138_INTERNAL = { COLUMNS };
