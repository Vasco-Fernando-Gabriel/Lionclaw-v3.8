import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrationV134 } from '../db-migrations/v134-gpt56-codex-default';

type MigrationDb = Parameters<typeof applyMigrationV134>[0];

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, model TEXT, codex_config TEXT)`);
  return db;
}

function migrate(db: DatabaseSync): void {
  applyMigrationV134(db as unknown as MigrationDb);
}

const SEED_ID = 'dynamic-workflow-coder-codex';

describe('migration v134 (spec-gpt56 AC-12)', () => {
  it('seed no default antigo: muda SO model e codex_config.$.model; sandbox/effort/chaves extras preservados', () => {
    const db = makeDb();
    db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run(
      SEED_ID,
      'gpt-5.5',
      JSON.stringify({
        model: 'gpt-5.5',
        sandbox: 'workspace-write',
        reasoningEffort: 'medium',
        chaveFutura: 'preservada',
      }),
    );
    migrate(db);
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(SEED_ID) as {
      model: string;
      codex_config: string;
    };
    expect(row.model).toBe('gpt-5.6-sol');
    expect(JSON.parse(row.codex_config)).toEqual({
      model: 'gpt-5.6-sol',
      sandbox: 'workspace-write',
      reasoningEffort: 'medium',
      chaveFutura: 'preservada',
    });
  });

  it('modelo CUSTOMIZADO (nao e o default antigo): linha intocada', () => {
    const db = makeDb();
    const customCfg = JSON.stringify({ model: 'gpt-5.4', sandbox: 'read-only' });
    db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run(SEED_ID, 'gpt-5.4', customCfg);
    migrate(db);
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(SEED_ID) as {
      model: string;
      codex_config: string;
    };
    expect(row.model).toBe('gpt-5.4');
    expect(row.codex_config).toBe(customCfg);
  });

  it('codexConfig customizado com model divergente da coluna: intocado (guarda dupla)', () => {
    const db = makeDb();
    const cfg = JSON.stringify({ model: 'gpt-5.3-codex', sandbox: 'workspace-write' });
    db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run(SEED_ID, 'gpt-5.5', cfg);
    migrate(db);
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(SEED_ID) as {
      model: string;
      codex_config: string;
    };
    expect(row.model).toBe('gpt-5.5');
    expect(row.codex_config).toBe(cfg);
  });

  it('codex_config INVALIDO (json_valid falso): linha intocada', () => {
    const db = makeDb();
    db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run(SEED_ID, 'gpt-5.5', '{corrompido');
    migrate(db);
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(SEED_ID) as {
      model: string;
      codex_config: string;
    };
    expect(row.model).toBe('gpt-5.5');
    expect(row.codex_config).toBe('{corrompido');
  });

  it('idempotente: re-rodar nao muda nada', () => {
    const db = makeDb();
    db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run(
      SEED_ID,
      'gpt-5.5',
      JSON.stringify({ model: 'gpt-5.5', sandbox: 'workspace-write' }),
    );
    migrate(db);
    const first = db.prepare('SELECT * FROM agents WHERE id = ?').get(SEED_ID);
    migrate(db);
    const second = db.prepare('SELECT * FROM agents WHERE id = ?').get(SEED_ID);
    expect(second).toEqual(first);
  });

  it('outros agents (id diferente) nunca sao tocados', () => {
    const db = makeDb();
    db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run(
      'outro-agente',
      'gpt-5.5',
      JSON.stringify({ model: 'gpt-5.5' }),
    );
    migrate(db);
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get('outro-agente') as {
      model: string;
    };
    expect(row.model).toBe('gpt-5.5');
  });
});
