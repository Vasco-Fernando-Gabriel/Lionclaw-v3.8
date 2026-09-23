import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationV148 } from '../db-migrations/v148-fable-5-1';
import { CLAUDE_MODELS } from '../../../src/constants/claude-models';
import { MODEL_PRICING } from '../pricing';
import { getContextWindow } from '../agent-runtime/model-context-windows';

function makeDb(orchestratorModel?: string, agentModels: string[] = []): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY, model TEXT)');
  if (orchestratorModel !== undefined) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('orchestrator_model', orchestratorModel);
  }
  agentModels.forEach((model, i) => {
    db.prepare('INSERT INTO agents (id, model) VALUES (?, ?)').run(`agent-${i}`, model);
  });
  return db;
}

function readOrchestrator(db: Database.Database): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'orchestrator_model'").get() as
    { value: string } | undefined;
  return row?.value;
}

function readAgentModels(db: Database.Database): string[] {
  return (db.prepare('SELECT model FROM agents ORDER BY id').all() as { model: string }[]).map((r) => r.model);
}

describe('migration v148 - Claude Fable 5.1 substitui Fable 5', () => {
  it('promove o orquestrador que estava em claude-fable-5', () => {
    const db = makeDb('claude-fable-5');
    applyMigrationV148(db);
    expect(readOrchestrator(db)).toBe('claude-fable-5-1');
  });

  it('o id promovido existe no catalogo, no pricing e na tabela de contexto (sem drift)', () => {
    const db = makeDb('claude-fable-5');
    applyMigrationV148(db);
    const promoted = readOrchestrator(db) as string;
    expect(CLAUDE_MODELS.some((m) => m.id === promoted)).toBe(true);
    expect(MODEL_PRICING[promoted]).toEqual({ input: 10.0, output: 50.0, cacheRead: 0.25, cacheCreation: 12.5 });
    expect(getContextWindow(promoted)).toBe(1_000_000);
    expect(CLAUDE_MODELS.some((m) => m.id === 'claude-fable-5')).toBe(false);
  });

  it('promove agentes (subagents) em claude-fable-5 e preserva os demais', () => {
    const db = makeDb(undefined, ['claude-fable-5', 'claude-opus-5', 'gpt-5.6-sol', 'claude-fable-5']);
    applyMigrationV148(db);
    expect(readAgentModels(db)).toEqual(['claude-fable-5-1', 'claude-opus-5', 'gpt-5.6-sol', 'claude-fable-5-1']);
  });

  it('PRESERVA orquestrador em outro modelo (Claude ou nao)', () => {
    for (const chosen of ['claude-opus-5', 'claude-sonnet-5', 'gpt-5.6-sol', 'grok-4.6', 'qwen3.6:32b']) {
      const db = makeDb(chosen);
      applyMigrationV148(db);
      expect(readOrchestrator(db)).toBe(chosen);
    }
  });

  it('e idempotente', () => {
    const db = makeDb('claude-fable-5', ['claude-fable-5']);
    applyMigrationV148(db);
    expect(() => applyMigrationV148(db)).not.toThrow();
    expect(readOrchestrator(db)).toBe('claude-fable-5-1');
    expect(readAgentModels(db)).toEqual(['claude-fable-5-1']);
  });

  it('nao cria linha quando o usuario nunca escolheu modelo', () => {
    const db = makeDb();
    applyMigrationV148(db);
    expect(readOrchestrator(db)).toBeUndefined();
  });
});
