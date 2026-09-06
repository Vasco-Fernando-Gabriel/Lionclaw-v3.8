import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationV138 } from '../db-migrations/v138-task-execution-ledger';

function legacyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE task_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      task_id TEXT NOT NULL,
      tool_use_id TEXT,
      agent_id TEXT,
      agent_name TEXT NOT NULL,
      model TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      api_requests INTEGER DEFAULT 0,
      tool_uses INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

describe('migration v138 task execution ledger', () => {
  it('adiciona ancestry/owner/provider sem invalidar linhas legadas', () => {
    const db = legacyDatabase();
    db.prepare(`
      INSERT INTO task_executions (
        session_id, task_id, agent_name, model, description, status
      ) VALUES ('legacy-session', 'legacy-task', 'legacy', 'old', 'old', 'completed')
    `).run();

    applyMigrationV138(db);

    const columns = db.pragma('table_info(task_executions)') as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    for (const name of [
      'execution_id', 'root_execution_id', 'parent_execution_id', 'execution_kind',
      'owner_kind', 'owner_id', 'runtime', 'provider', 'cost_status', 'token_status',
      'cost_unknown_reason', 'metadata',
    ]) expect(names.has(name)).toBe(true);
    expect(db.prepare('SELECT execution_id, owner_kind FROM task_executions').get())
      .toEqual({ execution_id: null, owner_kind: null });
    db.close();
  });

  it('e idempotente e garante execution_id globalmente unico quando presente', () => {
    const db = legacyDatabase();
    applyMigrationV138(db);
    expect(() => applyMigrationV138(db)).not.toThrow();

    const insert = db.prepare(`
      INSERT INTO task_executions (
        task_id, agent_name, model, description, status, execution_id,
        root_execution_id, execution_kind, owner_kind, owner_id
      ) VALUES (?, 'agent', 'model', 'desc', 'running', ?, ?, 'root', 'chat', 'session-1')
    `);
    insert.run('task-1', 'execution-1', 'execution-1');
    expect(() => insert.run('task-2', 'execution-1', 'execution-1')).toThrow();
    db.close();
  });

  it('rejeita enums desconhecidos no novo contrato', () => {
    const db = legacyDatabase();
    applyMigrationV138(db);
    expect(() => db.prepare(`
      INSERT INTO task_executions (
        task_id, agent_name, model, description, status, execution_id,
        root_execution_id, execution_kind, owner_kind, owner_id
      ) VALUES ('task', 'agent', 'model', 'desc', 'running', 'exec', 'exec', 'root', 'other', 'x')
    `).run()).toThrow();
    expect(() => db.prepare(`
      INSERT INTO task_executions (
        task_id, agent_name, model, description, status, execution_id,
        root_execution_id, execution_kind, owner_kind, owner_id
      ) VALUES ('enrich-task', 'agent', 'model', 'desc', 'running', 'enrich-exec', 'enrich-exec', 'root', 'enrich', 'enrich-1')
    `).run()).not.toThrow();
    db.close();
  });

  it('faz rollback atomico se a criacao dos indices falhar', () => {
    const db = legacyDatabase();
    db.exec('CREATE TABLE idx_task_exec_execution_id (value TEXT)');
    expect(() => applyMigrationV138(db)).toThrow();
    const columns = db.pragma('table_info(task_executions)') as Array<{ name: string }>;
    expect(columns.some(({ name }) => name === 'execution_id')).toBe(false);
    db.close();
  });
});
