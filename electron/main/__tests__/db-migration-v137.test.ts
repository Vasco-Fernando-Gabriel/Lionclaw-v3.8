import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { applyMigrationV137 } from '../db-migrations/v137-grok-agent-runtime';

function mockDb(options?: {
  fail?: boolean;
  violationsBefore?: unknown[];
  violationsAfter?: unknown[];
}) {
  const exec = vi.fn((_sql: string) => {
    if (options?.fail) throw new Error('injected migration failure');
  });
  const pragma = vi.fn()
    .mockReturnValueOnce(options?.violationsBefore ?? [])
    .mockReturnValue(options?.violationsAfter ?? []);
  const immediate = vi.fn((fn: () => void) => fn());
  const transaction = vi.fn((fn: () => void) => ({ immediate: () => immediate(fn) }));
  return {
    db: { exec, pragma, transaction } as unknown as import('better-sqlite3').Database,
    exec,
    immediate,
  };
}

describe('migration v137 Grok runtime', () => {
  it('migra SQLite real, preserva agentes/FKs/eixos e aceita Grok', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
        system_prompt TEXT DEFAULT '', model TEXT DEFAULT 'claude-sonnet-4-6',
        allowed_tools TEXT DEFAULT '[]', mcp_servers TEXT DEFAULT '[]',
        is_active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0,
        effort TEXT DEFAULT 'medium', thinking TEXT DEFAULT 'adaptive',
        thinking_budget INTEGER, max_turns INTEGER, skills TEXT DEFAULT '[]',
        kb_enabled INTEGER NOT NULL DEFAULT 1,
        runtime TEXT DEFAULT 'cloud' CHECK (runtime IN ('cloud','local','external','codex','zai','minimax-tp','kimi')),
        local_config TEXT, external_config TEXT, codex_config TEXT,
        local_mode TEXT DEFAULT 'simple', max_tool_rounds INTEGER DEFAULT 5,
        squad TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        access TEXT DEFAULT 'read-only', allow_bash INTEGER DEFAULT 0,
        allowed_commands TEXT DEFAULT '[]', allow_network INTEGER DEFAULT 0
      );
      CREATE TABLE agent_links (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        value TEXT NOT NULL
      );
      CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY);
      CREATE TABLE task_runs (
        id INTEGER PRIMARY KEY,
        task_id TEXT REFERENCES scheduled_tasks(id)
      );
      INSERT INTO agents (
        id, name, description, system_prompt, model, allowed_tools, mcp_servers,
        is_active, sort_order, effort, thinking, thinking_budget, max_turns,
        skills, kb_enabled, runtime, local_config, external_config, codex_config,
        local_mode, max_tool_rounds, squad, access, allow_bash,
        allowed_commands, allow_network
      ) VALUES (
        'custom', 'Custom', 'desc', 'prompt', 'kimi-k2.5', '["Read"]', '["kb"]',
        1, 9, 'max', 'enabled', 1234, 77, '["skill"]', 0, 'kimi',
        '{"local":true}', '{"external":true}', '{"codex":true}', 'agentic',
        12, 'quality', 'write', 1, '["npm test"]', 1
      );
      INSERT INTO agent_links (agent_id, value) VALUES ('custom', 'preserve');
    `);

    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO task_runs (id, task_id) VALUES (16, 'removed-task')").run();
    applyMigrationV137(db);
    db.pragma('foreign_keys = ON');

    expect(db.prepare(`
      SELECT id, model, effort, thinking_budget, runtime, access, allow_bash,
        allowed_commands, allow_network, max_tool_rounds, squad
      FROM agents WHERE id = 'custom'
    `).get()).toEqual({
      id: 'custom',
      model: 'kimi-k2.5',
      effort: 'max',
      thinking_budget: 1234,
      runtime: 'kimi',
      access: 'write',
      allow_bash: 1,
      allowed_commands: '["npm test"]',
      allow_network: 1,
      max_tool_rounds: 12,
      squad: 'quality',
    });
    expect(db.prepare('SELECT * FROM agent_links').get()).toEqual({ agent_id: 'custom', value: 'preserve' });
    expect(db.pragma('foreign_key_check')).toEqual([
      { table: 'task_runs', rowid: 16, parent: 'scheduled_tasks', fkid: 0 },
    ]);
    expect(() => db.prepare("INSERT INTO agents (id, name, runtime) VALUES ('grok', 'Grok', 'grok')").run())
      .not.toThrow();
    expect(db.prepare(`SELECT key, value FROM settings ORDER BY key`).all()).toEqual([
      { key: 'grok_max_concurrency', value: '3' },
      { key: 'orchestrator_grok_effort', value: 'high' },
      { key: 'orchestrator_kimi_effort', value: 'max' },
    ]);
    db.close();
  });

  it('propagates an injected failure from inside the transaction', () => {
    const { db } = mockDb({ fail: true });
    expect(() => applyMigrationV137(db)).toThrow('injected migration failure');
  });

  it('preserva violacoes legadas sem atribui-las a migration', () => {
    const legacy = { table: 'task_runs', rowid: 16, parent: 'scheduled_tasks', fkid: 1 };
    const { db } = mockDb({
      violationsBefore: [legacy],
      violationsAfter: [legacy],
    });
    expect(() => applyMigrationV137(db)).not.toThrow();
  });

  it('rejects new foreign-key violations before the transaction commits', () => {
    const legacy = { table: 'task_runs', rowid: 16, parent: 'scheduled_tasks', fkid: 1 };
    const introduced = { table: 'agent_links', rowid: 1, parent: 'agents', fkid: 0 };
    const { db } = mockDb({
      violationsBefore: [legacy],
      violationsAfter: [legacy, introduced],
    });
    expect(() => applyMigrationV137(db)).toThrow('foreign key');
  });
});
