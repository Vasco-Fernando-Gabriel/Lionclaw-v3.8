
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrationV150 } from '../db-migrations/v150-gpt6-astra-codex-default';
import { LATEST_SCHEMA_VERSION } from '../db-migration-safety';
import { CODEX_DEFAULT_MODEL } from '../../../src/constants/codex-models';

type MigrationDb = Parameters<typeof applyMigrationV150>[0];

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, model TEXT, codex_config TEXT)`);
  return db;
}

function migrate(db: DatabaseSync): void {
  applyMigrationV150(db as unknown as MigrationDb);
}

const SEED_ID = 'dynamic-workflow-coder-codex';
const PREVIOUS = 'gpt-5.6-sol';
const NEW = 'gpt-6-astra';

function readSeed(db: DatabaseSync, id: string = SEED_ID): { model: string; codex_config: string } {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as {
    model: string;
    codex_config: string;
  };
}

describe('migration v150 (GPT-6 Astra como default do codex)', () => {
  it('seed no default antigo: muda SO model e codex_config.$.model; sandbox/effort/chaves extras preservados', () => {
    const db = makeDb();
    db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run(
      SEED_ID,
      PREVIOUS,
      JSON.stringify({
        model: PREVIOUS,
        sandbox: 'workspace-write',
        reasoningEffort: 'medium',
        chaveFutura: 'preservada',
      }),
    );
    migrate(db);
    const row = readSeed(db);
    expect(row.model).toBe(NEW);
    expect(JSON.parse(row.codex_config)).toEqual({
      model: NEW,
      sandbox: 'workspace-write',
      reasoningEffort: 'medium',
      chaveFutura: 'preservada',
    });
  });

  it('modelo CUSTOMIZADO (nao e o default antigo): linha intocada', () => {
    const db = makeDb();
    const customCfg = JSON.stringify({ model: 'gpt-5.6-luna', sandbox: 'read-only' });
    db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run(SEED_ID, 'gpt-5.6-luna', customCfg);
    migrate(db);
    const row = readSeed(db);
    expect(row.model).toBe('gpt-5.6-luna');
    expect(row.codex_config).toBe(customCfg);
  });

  it('codexConfig customizado com model divergente da coluna: intocado (guarda dupla)', () => {
    const db = makeDb();
    const cfg = JSON.stringify({ model: 'gpt-5.5', sandbox: 'workspace-write' });
    db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run(SEED_ID, PREVIOUS, cfg);
    migrate(db);
    const row = readSeed(db);
    expect(row.model).toBe(PREVIOUS);
    expect(row.codex_config).toBe(cfg);
  });

  it('codex_config INVALIDO (json_valid falso): linha intocada', () => {
    const db = makeDb();
    db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run(SEED_ID, PREVIOUS, '{corrompido');
    migrate(db);
    const row = readSeed(db);
    expect(row.model).toBe(PREVIOUS);
    expect(row.codex_config).toBe('{corrompido');
  });

  it('idempotente: re-rodar nao muda nada', () => {
    const db = makeDb();
    db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run(
      SEED_ID,
      PREVIOUS,
      JSON.stringify({ model: PREVIOUS, sandbox: 'workspace-write' }),
    );
    migrate(db);
    const first = readSeed(db);
    migrate(db);
    expect(readSeed(db)).toEqual(first);
  });

  it('outros agents (id diferente) nunca sao tocados', () => {
    const db = makeDb();
    db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run(
      'outro-agente',
      PREVIOUS,
      JSON.stringify({ model: PREVIOUS }),
    );
    migrate(db);
    const row = readSeed(db, 'outro-agente');
    expect(row.model).toBe(PREVIOUS);
  });

  it('R10: o novo default do catalogo e o alvo da migration, e a constante de schema cobre a V150', () => {
    expect(CODEX_DEFAULT_MODEL).toBe(NEW);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(150);
  });
});
