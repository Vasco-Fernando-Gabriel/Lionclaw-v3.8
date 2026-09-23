import { describe, it, expect } from 'vitest';
import { V83_SQL, __V83_INTERNAL } from '../db-migrations/v83-dynamic-workflows';
import {
  DYNAMIC_WORKFLOW_RUN_STATUSES,
  DYNAMIC_WORKFLOW_NODE_STATUSES,
  DYNAMIC_WORKFLOW_GATE_DECISIONS,
  DYNAMIC_WORKFLOW_MESSAGE_SOURCES,
} from '../../../src/types/dynamic-workflow';

function expectedCheck(column: string, values: readonly string[]): string {
  return `CHECK (${column} IN (${values.map((v) => `'${v}'`).join(', ')}))`;
}

describe('migration v83 dynamic_workflow_* (asserts de string, sem DB)', () => {
  it('cria as 8 tabelas dynamic_workflow_* com IF NOT EXISTS (idempotente)', () => {
    expect(__V83_INTERNAL.TABLES).toHaveLength(8);
    for (const table of __V83_INTERNAL.TABLES) {
      expect(V83_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
    }
  });

  it('NAO reutiliza a tabela legada workflow_runs (SPEC 2.10) nem faz ALTER (containment)', () => {
    expect(V83_SQL).not.toMatch(/(?<!dynamic_)workflow_runs/);
    expect(V83_SQL).not.toContain('ALTER TABLE');
    expect(V83_SQL).not.toContain('DROP TABLE');
  });

  it('CHECK de runs.status e GERADO do union DynamicWorkflowRunStatus (9 valores, 10.2)', () => {
    expect(DYNAMIC_WORKFLOW_RUN_STATUSES).toHaveLength(9);
    expect(V83_SQL).toContain(expectedCheck('status', DYNAMIC_WORKFLOW_RUN_STATUSES));
  });

  it('CHECK de node_runs.status e GERADO do union DynamicWorkflowNodeStatus (8 valores, 10.2)', () => {
    expect(DYNAMIC_WORKFLOW_NODE_STATUSES).toHaveLength(8);
    expect(V83_SQL).toContain(expectedCheck('status', DYNAMIC_WORKFLOW_NODE_STATUSES));
  });

  it('CHECK de gate_decisions.decision inclui override-approved/override-rejected (14.1.1/AC-17)', () => {
    const check = expectedCheck('decision', DYNAMIC_WORKFLOW_GATE_DECISIONS);
    expect(V83_SQL).toContain(check);
    expect(check).toContain(`'override-approved'`);
    expect(check).toContain(`'override-rejected'`);
  });

  it('CHECK de messages.source espelha EXATAMENTE os 6 emissores da 12.1', () => {
    expect([...DYNAMIC_WORKFLOW_MESSAGE_SOURCES]).toEqual([
      'human',
      'orchestrator',
      'workflow-orchestrator-agent',
      'agent',
      'runner',
      'closer',
    ]);
    expect(V83_SQL).toContain(expectedCheck('source', DYNAMIC_WORKFLOW_MESSAGE_SOURCES));
  });

  it('awaiting-user NUNCA entra em CHECK (UIStatus derivado, 10.2/13.3.4)', () => {
    expect(V83_SQL).not.toContain('awaiting-user');
  });

  it('todo indice e criado DEPOIS do CREATE TABLE da tabela que referencia', () => {
    const indexToTable: Record<string, string> = {
      idx_dwf_events_run_seq: 'dynamic_workflow_events',
      idx_dwf_node_runs_run_status: 'dynamic_workflow_node_runs',
      idx_dwf_node_runs_run_node: 'dynamic_workflow_node_runs',
      idx_dwf_runs_status: 'dynamic_workflow_runs',
      idx_dwf_messages_run: 'dynamic_workflow_messages',
      idx_dwf_artifacts_run: 'dynamic_workflow_artifacts',
      idx_dwf_gate_decisions_run: 'dynamic_workflow_gate_decisions',
    };
    expect(Object.keys(indexToTable).sort()).toEqual([...__V83_INTERNAL.INDEXES].sort());
    for (const [indexName, table] of Object.entries(indexToTable)) {
      const indexPos = V83_SQL.indexOf(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${table}(`);
      const tablePos = V83_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
      expect(indexPos, `indice ${indexName} ausente ou fora do padrao`).toBeGreaterThan(-1);
      expect(tablePos, `tabela ${table} ausente`).toBeGreaterThan(-1);
      expect(indexPos, `indice ${indexName} precisa vir DEPOIS do CREATE TABLE ${table}`).toBeGreaterThan(tablePos);
    }
  });

  it('UNIQUEs da 12.1: events(run_id, seq), node_runs(run_id, node_id, attempt), nodes(definition_id, node_id)', () => {
    expect(V83_SQL).toContain('UNIQUE(run_id, seq)');
    expect(V83_SQL).toContain('UNIQUE(run_id, node_id, attempt)');
    expect(V83_SQL).toContain('UNIQUE(definition_id, node_id)');
  });

  it('colunas do grafo da 12.1 presentes em nodes (anti-coluna-orfa R3-F2)', () => {
    for (const column of [
      'produces_json',
      'consumes_json',
      'gate_config_json',
      'retry_policy_json',
      'risk_level',
      'read_set_json',
      'write_set_json',
      'allowed_tools_json',
      'allowed_mcp_json',
      'dependencies_json',
      'schema_ref',
    ]) {
      expect(V83_SQL, `coluna ${column} ausente em dynamic_workflow_nodes`).toContain(column);
    }
  });

  it('node_runs carrega policy por attempt (AC-16) + trio de custo (secao 9/AC-7) + failure_class (10.4)', () => {
    for (const column of [
      'policy_hash',
      'policy_snapshot_json',
      'failure_class',
      'cost_status',
      'token_status',
      'cost_unknown_reason',
      'metrics_metadata_json',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_creation_tokens',
      'cost_usd',
      'model',
      'runtime',
      'provider',
      'duration_ms',
    ]) {
      expect(V83_SQL, `coluna ${column} ausente em dynamic_workflow_node_runs`).toContain(column);
    }
  });

  it('runs carrega lifecycle completo (workspace mode 8.6 + closer 8.8 + cadeia chat-bound)', () => {
    for (const column of [
      'chat_session_id',
      'workspace_mode',
      'base_branch',
      'base_commit_sha',
      'base_worktree_hash',
      'worktree_path',
      'worktree_branch',
      'delivered_at',
      'finalized_at',
      'closer_session_id',
      'closer_status',
      'checkpoint_json',
    ]) {
      expect(V83_SQL, `coluna ${column} ausente em dynamic_workflow_runs`).toContain(column);
    }
  });

  it('definitions carrega a cadeia parent/supersedes do replan (12.1, decisao 22.7)', () => {
    expect(V83_SQL).toContain('parent_definition_id');
    expect(V83_SQL).toContain('supersedes_definition_id');
    expect(V83_SQL).toContain('manifest_json');
    expect(V83_SQL).toContain('manifest_hash');
  });
});
