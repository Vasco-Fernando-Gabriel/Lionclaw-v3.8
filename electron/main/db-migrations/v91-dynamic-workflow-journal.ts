import type Database from 'better-sqlite3';

export const V91_JOURNAL_SQL = `
    CREATE TABLE IF NOT EXISTS dynamic_workflow_journal (
      run_id TEXT NOT NULL,
      call_index INTEGER NOT NULL,        -- <- ordem monotonica da chamada (1-based)
      call_path TEXT NOT NULL,            -- <- identidade estrutural da chamada (nodeId/gateId + primitive)
      primitive TEXT NOT NULL,            -- <- 'agent' | 'gate' | 'artifact' | 'checkpoint' | 'materializeSprintPlan'
      node_id TEXT,                       -- <- nodeId quando aplicavel (agent/checkpoint); gateId/artifactId senao
      arg_hash TEXT NOT NULL,             -- <- hash canonico do arg/input da chamada
      schema_ref TEXT,                    -- <- schemaRef canonico (do manifest), null pros writers
      policy_hash TEXT,                   -- <- computeNodeGrantsHash dos grants clampados (pre-exec)
      agent_id TEXT,                      -- <- agentId que executou (identidade)
      model TEXT,                         -- <- modelo resolvido (gravado pos-exec; drift invalida)
      runtime TEXT,                       -- <- runtime resolvido (gravado pos-exec; drift invalida)
      plan_hash TEXT,                     -- <- planHash corrente do run (materializacao)
      workflow_revision TEXT,             -- <- revisao do workflow (manifest_hash da definition; edicao ao vivo)
      output_ref TEXT,                    -- <- referencia do output REAL (nodeId+attempt -> checkpoint file)
      side_effect_key TEXT,               -- <- chave de idempotencia do efeito lateral (materialize/gate/artifact)
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, call_index),
      FOREIGN KEY (run_id) REFERENCES dynamic_workflow_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_dwf_journal_run ON dynamic_workflow_journal(run_id, call_index);
    CREATE INDEX IF NOT EXISTS idx_dwf_journal_run_path ON dynamic_workflow_journal(run_id, call_path);
`;

export function applyMigrationV91(db: Database.Database): void {
  db.exec(V91_JOURNAL_SQL);
}

export const __V91_INTERNAL = {
  TABLES: ['dynamic_workflow_journal'],
  INDEXES: ['idx_dwf_journal_run', 'idx_dwf_journal_run_path'],
};
