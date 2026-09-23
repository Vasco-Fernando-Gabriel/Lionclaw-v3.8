import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationV149, __V149_INTERNAL } from '../db-migrations/v149-workflow-adjustment-consumed';
import { LATEST_SCHEMA_VERSION } from '../db-migration-safety';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dynamic_workflow_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      node_id TEXT,
      role TEXT NOT NULL,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls_json TEXT,
      agent_id TEXT,
      created_at TEXT NOT NULL
    )
  `);
  return db;
}

function columns(db: Database.Database): string[] {
  return (db.prepare('PRAGMA table_info(dynamic_workflow_messages)').all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

function insertAdjustment(db: Database.Database, runId: string, nodeId: string, content: string): number {
  const r = db
    .prepare(
      `INSERT INTO dynamic_workflow_messages (run_id, node_id, role, source, kind, content, created_at)
       VALUES (?, ?, 'user', 'orchestrator', 'adjustment', ?, datetime('now'))`,
    )
    .run(runId, nodeId, content);
  return Number(r.lastInsertRowid);
}

describe('migration v149 - dynamic_workflow_messages.applied_node_id/consumed_at (SPEC orquestrador-driver D8)', () => {
  it('adiciona as duas colunas (nullable) e os indices do claim/replay', () => {
    const db = makeDb();
    expect(columns(db)).not.toContain('applied_node_id');
    applyMigrationV149(db);
    const cols = columns(db);
    expect(cols).toContain('applied_node_id');
    expect(cols).toContain('consumed_at');
    expect(__V149_INTERNAL.COLUMNS).toEqual(['applied_node_id', 'consumed_at']);
    const idx = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='dynamic_workflow_messages'")
        .all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(idx).toContain('idx_dwf_messages_adjustment_claim');
    expect(idx).toContain('idx_dwf_messages_adjustment_applied');
  });

  it('e idempotente (2a execucao nao lanca nem duplica coluna)', () => {
    const db = makeDb();
    applyMigrationV149(db);
    expect(() => applyMigrationV149(db)).not.toThrow();
    expect(columns(db).filter((c) => c === 'applied_node_id')).toHaveLength(1);
    expect(columns(db).filter((c) => c === 'consumed_at')).toHaveLength(1);
  });

  it('preserva linhas existentes com as colunas novas NULL (elegiveis ao claim como qualquer ajuste)', () => {
    const db = makeDb();
    const id = insertAdjustment(db, 'run-1', 'coder', 'antes da migration');
    applyMigrationV149(db);
    const row = db.prepare('SELECT * FROM dynamic_workflow_messages WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row['content']).toBe('antes da migration');
    expect(row['applied_node_id']).toBeNull();
    expect(row['consumed_at']).toBeNull();
  });

  it('o claim atomico `UPDATE ... WHERE consumed_at IS NULL RETURNING` funciona no schema migrado (exatamente-uma-vez)', () => {
    const db = makeDb();
    applyMigrationV149(db);
    const id = insertAdjustment(db, 'run-1', '*', 'mais validadores');
    const claim = db.prepare(
      `UPDATE dynamic_workflow_messages
          SET applied_node_id = ?, consumed_at = datetime('now')
        WHERE run_id = ? AND kind = 'adjustment' AND node_id = ? AND consumed_at IS NULL
        RETURNING id`,
    );
    const first = claim.all('cc:S1:v0:1', 'run-1', '*') as Array<{ id: number }>;
    const second = claim.all('cc:S1:v1:1', 'run-1', '*') as Array<{ id: number }>;
    expect(first.map((r) => r.id)).toEqual([id]);
    expect(second).toEqual([]);
    const row = db
      .prepare('SELECT applied_node_id, consumed_at FROM dynamic_workflow_messages WHERE id = ?')
      .get(id) as {
      applied_node_id: string;
      consumed_at: string;
    };
    expect(row.applied_node_id).toBe('cc:S1:v0:1');
    expect(typeof row.consumed_at).toBe('string');
  });

  it('LATEST_SCHEMA_VERSION cobre a V149 (o valor exato e travado pelo teste que le o diretorio de migrations)', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(149);
  });
});
