
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { __V60_INTERNAL, applyMigrationV60 } from '../db-migrations/v60-fix-model-aliases';

const { ALIAS_TO_MODEL_ID } = __V60_INTERNAL;

const SCHEMA = `
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    system_prompt TEXT NOT NULL DEFAULT '',
    model TEXT DEFAULT 'sonnet',
    allowed_tools TEXT DEFAULT '[]',
    mcp_servers TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

function insertAgent(db: Database.Database, id: string, model: string): void {
  db.prepare(
    `INSERT INTO agents (id, name, description, model) VALUES (?, ?, ?, ?)`,
  ).run(id, id, `desc-${id}`, model);
}

function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(key, value);
}

function getAgentModel(db: Database.Database, id: string): string {
  const row = db.prepare(`SELECT model FROM agents WHERE id = ?`).get(id) as { model: string };
  return row.model;
}

function getSettingValue(db: Database.Database, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

describe('db-migration-v60: contrato de mapeamento', () => {
  it('mapeia opus/sonnet/haiku para os IDs corretos', () => {
    const map = new Map<string, string>(ALIAS_TO_MODEL_ID);
    expect(map.get('opus')).toBe('claude-opus-4-7');
    expect(map.get('sonnet')).toBe('claude-sonnet-4-6');
    expect(map.get('haiku')).toBe('claude-haiku-4-5-20251001');
    expect(ALIAS_TO_MODEL_ID.length).toBe(3);
  });
});

describe('db-migration-v60: applyMigrationV60 (banco antigo simulado)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
  });

  it('atualiza agents.model com aliases para IDs explicitos', () => {
    insertAgent(db, 'agent-opus', 'opus');
    insertAgent(db, 'agent-sonnet', 'sonnet');
    insertAgent(db, 'agent-haiku', 'haiku');

    applyMigrationV60(db);

    expect(getAgentModel(db, 'agent-opus')).toBe('claude-opus-4-7');
    expect(getAgentModel(db, 'agent-sonnet')).toBe('claude-sonnet-4-6');
    expect(getAgentModel(db, 'agent-haiku')).toBe('claude-haiku-4-5-20251001');
  });

  it('preserva valores ja explicitos em agents.model', () => {
    insertAgent(db, 'agent-already-opus', 'claude-opus-4-7');
    insertAgent(db, 'agent-already-sonnet', 'claude-sonnet-4-6');
    insertAgent(db, 'agent-already-haiku', 'claude-haiku-4-5-20251001');
    insertAgent(db, 'agent-custom', 'claude-haiku-4-5-20251001');

    applyMigrationV60(db);

    expect(getAgentModel(db, 'agent-already-opus')).toBe('claude-opus-4-7');
    expect(getAgentModel(db, 'agent-already-sonnet')).toBe('claude-sonnet-4-6');
    expect(getAgentModel(db, 'agent-already-haiku')).toBe('claude-haiku-4-5-20251001');
    expect(getAgentModel(db, 'agent-custom')).toBe('claude-haiku-4-5-20251001');
  });

  it('preserva modelos com nomes nao mapeados', () => {
    insertAgent(db, 'agent-gpt', 'gpt-5.5');
    insertAgent(db, 'agent-qwen', 'qwen3.5:9b-q4_K_M');

    applyMigrationV60(db);

    expect(getAgentModel(db, 'agent-gpt')).toBe('gpt-5.5');
    expect(getAgentModel(db, 'agent-qwen')).toBe('qwen3.5:9b-q4_K_M');
  });

  it('atualiza settings(default_model) com alias para ID explicito', () => {
    setSetting(db, 'default_model', 'sonnet');

    applyMigrationV60(db);

    expect(getSettingValue(db, 'default_model')).toBe('claude-sonnet-4-6');
  });

  it('atualiza settings(default_model) para cada alias', () => {
    for (const [alias, expected] of ALIAS_TO_MODEL_ID) {
      const fresh = new Database(':memory:');
      fresh.exec(SCHEMA);
      setSetting(fresh, 'default_model', alias);
      applyMigrationV60(fresh);
      expect(getSettingValue(fresh, 'default_model')).toBe(expected);
      fresh.close();
    }
  });

  it('preserva default_model ja explicito', () => {
    setSetting(db, 'default_model', 'claude-opus-4-7');

    applyMigrationV60(db);

    expect(getSettingValue(db, 'default_model')).toBe('claude-opus-4-7');
  });

  it('nao afeta outras settings com mesmo valor de alias', () => {
    setSetting(db, 'theme', 'opus');
    setSetting(db, 'default_model', 'opus');

    applyMigrationV60(db);

    expect(getSettingValue(db, 'theme')).toBe('opus');
    expect(getSettingValue(db, 'default_model')).toBe('claude-opus-4-7');
  });

  it('e idempotente: executar 2x produz o mesmo resultado', () => {
    insertAgent(db, 'agent-opus', 'opus');
    insertAgent(db, 'agent-sonnet', 'sonnet');
    insertAgent(db, 'agent-haiku', 'haiku');
    setSetting(db, 'default_model', 'sonnet');

    applyMigrationV60(db);
    applyMigrationV60(db);

    expect(getAgentModel(db, 'agent-opus')).toBe('claude-opus-4-7');
    expect(getAgentModel(db, 'agent-sonnet')).toBe('claude-sonnet-4-6');
    expect(getAgentModel(db, 'agent-haiku')).toBe('claude-haiku-4-5-20251001');
    expect(getSettingValue(db, 'default_model')).toBe('claude-sonnet-4-6');
  });

  it('cenario realista: banco antigo do Pedro com mix de aliases e IDs', () => {
    insertAgent(db, 'researcher', 'sonnet');
    insertAgent(db, 'ops', 'sonnet');
    insertAgent(db, 'harness-planner', 'opus');
    insertAgent(db, 'the-notte', 'haiku');
    insertAgent(db, 'spec-builder', 'claude-sonnet-4-6'); // ja explicito
    setSetting(db, 'default_model', 'sonnet');

    applyMigrationV60(db);

    expect(getAgentModel(db, 'researcher')).toBe('claude-sonnet-4-6');
    expect(getAgentModel(db, 'ops')).toBe('claude-sonnet-4-6');
    expect(getAgentModel(db, 'harness-planner')).toBe('claude-opus-4-7');
    expect(getAgentModel(db, 'the-notte')).toBe('claude-haiku-4-5-20251001');
    expect(getAgentModel(db, 'spec-builder')).toBe('claude-sonnet-4-6');
    expect(getSettingValue(db, 'default_model')).toBe('claude-sonnet-4-6');
  });
});
