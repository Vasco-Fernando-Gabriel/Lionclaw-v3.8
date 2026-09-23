import type Database from 'better-sqlite3';
import {
  DYNAMIC_WORKFLOW_RUN_STATUSES,
  DYNAMIC_WORKFLOW_NODE_STATUSES,
  DYNAMIC_WORKFLOW_GATE_DECISIONS,
  DYNAMIC_WORKFLOW_MESSAGE_SOURCES,
} from '../../../src/types/dynamic-workflow';

function checkIn(column: string, values: readonly string[]): string {
  return `CHECK (${column} IN (${values.map((v) => `'${v}'`).join(', ')}))`;
}

export const V83_SQL = `
    CREATE TABLE IF NOT EXISTS dynamic_workflow_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      definition_version INTEGER NOT NULL DEFAULT 1,
      parent_definition_id TEXT,
      supersedes_definition_id TEXT,
      source_type TEXT NOT NULL,
      project_path TEXT NOT NULL,
      spec_path TEXT,
      spec_sha256 TEXT,
      workflow_js_path TEXT NOT NULL,
      manifest_path TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      context_bundle_path TEXT,
      builder_agent_id TEXT,
      builder_model TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dynamic_workflow_runs (
      id TEXT PRIMARY KEY,
      definition_id TEXT NOT NULL REFERENCES dynamic_workflow_definitions(id) ON DELETE CASCADE,
      chat_session_id TEXT,
      status TEXT NOT NULL ${checkIn('status', DYNAMIC_WORKFLOW_RUN_STATUSES)},
      current_phase_id TEXT,
      current_node_id TEXT,
      workspace_mode TEXT, -- 'run-worktree' | 'fresh-project' (decidido no preflight, 8.6)
      base_branch TEXT,
      base_commit_sha TEXT,
      base_worktree_hash TEXT,
      worktree_path TEXT,
      worktree_branch TEXT,
      delivered_at TEXT,
      finalized_at TEXT,
      closer_session_id TEXT,
      closer_status TEXT, -- 'idle' | 'active' | 'closed'
      input_json TEXT NOT NULL DEFAULT '{}',
      output_json TEXT,
      checkpoint_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      total_cost_usd REAL DEFAULT 0,
      total_duration_ms INTEGER DEFAULT 0,
      created_by TEXT NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS dynamic_workflow_nodes (
      id TEXT PRIMARY KEY,
      definition_id TEXT NOT NULL REFERENCES dynamic_workflow_definitions(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      phase_id TEXT NOT NULL,
      type TEXT NOT NULL,
      agent_id TEXT,
      label TEXT,
      access TEXT,
      read_set_json TEXT NOT NULL DEFAULT '[]',
      write_set_json TEXT NOT NULL DEFAULT '[]',
      isolation TEXT,
      allowed_tools_json TEXT NOT NULL DEFAULT '[]',
      allowed_mcp_json TEXT NOT NULL DEFAULT '[]',
      policy_hash TEXT, -- hash dos GRANTS estaticos do manifest (a policy EFETIVA fica por attempt em node_runs)
      timeout_ms INTEGER,
      cost_ceiling_usd REAL,
      dependencies_json TEXT NOT NULL DEFAULT '[]',
      retry_policy_json TEXT NOT NULL DEFAULT '{}',
      gate_config_json TEXT NOT NULL DEFAULT '{}',
      risk_level TEXT,
      schema_ref TEXT,
      produces_json TEXT NOT NULL DEFAULT '[]',
      consumes_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE(definition_id, node_id)
    );

    CREATE TABLE IF NOT EXISTS dynamic_workflow_node_runs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES dynamic_workflow_runs(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      phase_id TEXT NOT NULL,
      type TEXT NOT NULL,
      agent_id TEXT,
      status TEXT NOT NULL ${checkIn('status', DYNAMIC_WORKFLOW_NODE_STATUSES)},
      attempt INTEGER NOT NULL DEFAULT 1,
      input_hash TEXT,
      policy_hash TEXT, -- hash da policy EFETIVA aplicada NESTA attempt
      policy_snapshot_json TEXT NOT NULL DEFAULT '{}', -- WorkflowNodeExecutionPolicy completa (AC-16)
      input_json TEXT NOT NULL DEFAULT '{}',
      output_hash TEXT,
      output_json TEXT,
      error TEXT,
      failure_class TEXT, -- provider-limit | provider-auth | provider-error | timeout | schema | logic (ver 10.4)
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      cost_status TEXT,
      token_status TEXT,
      cost_unknown_reason TEXT,
      metrics_metadata_json TEXT NOT NULL DEFAULT '{}',
      model TEXT,
      runtime TEXT,
      provider TEXT,
      tool_uses INTEGER DEFAULT 0,
      api_requests INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(run_id, node_id, attempt)
    );

    CREATE TABLE IF NOT EXISTS dynamic_workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES dynamic_workflow_runs(id) ON DELETE CASCADE,
      node_id TEXT,
      phase_id TEXT,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(run_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_dwf_events_run_seq ON dynamic_workflow_events(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_dwf_node_runs_run_status ON dynamic_workflow_node_runs(run_id, status);
    CREATE INDEX IF NOT EXISTS idx_dwf_node_runs_run_node ON dynamic_workflow_node_runs(run_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_dwf_runs_status ON dynamic_workflow_runs(status);

    CREATE TABLE IF NOT EXISTS dynamic_workflow_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES dynamic_workflow_runs(id) ON DELETE CASCADE,
      node_id TEXT,
      role TEXT NOT NULL,
      source TEXT NOT NULL ${checkIn('source', DYNAMIC_WORKFLOW_MESSAGE_SOURCES)},
      kind TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tool_calls_json TEXT,
      agent_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dynamic_workflow_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES dynamic_workflow_runs(id) ON DELETE CASCADE,
      node_id TEXT,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dynamic_workflow_gate_decisions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES dynamic_workflow_runs(id) ON DELETE CASCADE,
      gate_id TEXT NOT NULL,
      node_id TEXT,
      mode TEXT NOT NULL,
      decision TEXT NOT NULL ${checkIn('decision', DYNAMIC_WORKFLOW_GATE_DECISIONS)},
      decided_by TEXT NOT NULL,
      reason TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    -- Indices de tabelas criadas acima (NUNCA antes do CREATE TABLE correspondente)
    CREATE INDEX IF NOT EXISTS idx_dwf_messages_run ON dynamic_workflow_messages(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_dwf_artifacts_run ON dynamic_workflow_artifacts(run_id);
    CREATE INDEX IF NOT EXISTS idx_dwf_gate_decisions_run ON dynamic_workflow_gate_decisions(run_id, gate_id);
`;

export function applyMigrationV83(db: Database.Database): void {
  db.exec(V83_SQL);
}

export const __V83_INTERNAL = {
  TABLES: [
    'dynamic_workflow_definitions',
    'dynamic_workflow_runs',
    'dynamic_workflow_nodes',
    'dynamic_workflow_node_runs',
    'dynamic_workflow_events',
    'dynamic_workflow_messages',
    'dynamic_workflow_artifacts',
    'dynamic_workflow_gate_decisions',
  ],
  INDEXES: [
    'idx_dwf_events_run_seq',
    'idx_dwf_node_runs_run_status',
    'idx_dwf_node_runs_run_node',
    'idx_dwf_runs_status',
    'idx_dwf_messages_run',
    'idx_dwf_artifacts_run',
    'idx_dwf_gate_decisions_run',
  ],
  checkIn,
};
