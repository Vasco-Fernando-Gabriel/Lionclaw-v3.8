import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationV142 } from '../db-migrations/v142-opus-5-orchestrator-default';
import { CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';

function makeDb(seed?: string): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  if (seed !== undefined) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('orchestrator_model', seed);
  }
  return db;
}

function readModel(db: Database.Database): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'orchestrator_model'").get() as
    { value: string } | undefined;
  return row?.value;
}

describe('migration v142 - Claude Opus 5 como modelo do orquestrador', () => {
  it('promove quem ainda esta no default anterior (claude-opus-4-8)', () => {
    const db = makeDb('claude-opus-4-8');
    applyMigrationV142(db);
    expect(readModel(db)).toBe('claude-opus-5');
  });

  it('o valor promovido bate com CLAUDE_DEFAULT_MODEL (sem drift entre fresh install e upgrade)', () => {
    const db = makeDb('claude-opus-4-8');
    applyMigrationV142(db);
    expect(readModel(db)).toBe(CLAUDE_DEFAULT_MODEL);
  });

  it('PRESERVA escolha deliberada do usuario em outro modelo Claude', () => {
    const db = makeDb('claude-fable-5');
    applyMigrationV142(db);
    expect(readModel(db)).toBe('claude-fable-5');
  });

  it('PRESERVA escolha em runtime nao-Claude (codex/grok/local)', () => {
    for (const chosen of ['gpt-5.6-sol', 'grok-code', 'qwen3.6:32b']) {
      const db = makeDb(chosen);
      applyMigrationV142(db);
      expect(readModel(db)).toBe(chosen);
    }
  });

  it('e idempotente: rodar de novo nao muda nada', () => {
    const db = makeDb('claude-opus-4-8');
    applyMigrationV142(db);
    expect(() => applyMigrationV142(db)).not.toThrow();
    expect(readModel(db)).toBe('claude-opus-5');
  });

  it('nao cria a linha quando o usuario nunca escolheu modelo (fica no default do codigo)', () => {
    const db = makeDb();
    applyMigrationV142(db);
    expect(readModel(db)).toBeUndefined();
  });

  it('nao toca outras chaves de settings', () => {
    const db = makeDb('claude-opus-4-8');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('orchestrator_provider', 'anthropic');
    applyMigrationV142(db);
    const provider = db.prepare("SELECT value FROM settings WHERE key = 'orchestrator_provider'").get() as {
      value: string;
    };
    expect(provider.value).toBe('anthropic');
  });
});
