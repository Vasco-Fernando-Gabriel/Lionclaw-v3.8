import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrationV157, __V157_INTERNAL } from '../db-migrations/v157-opus-5-5-orchestrator-default';
import { applyMigrationV158, __V158_INTERNAL } from '../db-migrations/v158-gpt6-sol-codex-default';
import { applyMigrationV159, __V159_INTERNAL } from '../db-migrations/v159-subagents-follow-opus-5-5';
import { LATEST_SCHEMA_VERSION } from '../db-migration-safety';
import { CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';
import { CODEX_DEFAULT_MODEL } from '../../../src/constants/codex-models';
import { aiEngineer } from '../seed-agents/ai-engineer';
import { bugRootCauseAnalyst } from '../seed-agents/bug-root-cause-analyst';
import { dynamicWorkflowCoderCodex } from '../seed-agents/dynamic-workflow-coder-codex';

type V157Db = Parameters<typeof applyMigrationV157>[0];
type V158Db = Parameters<typeof applyMigrationV158>[0];
type V159Db = Parameters<typeof applyMigrationV159>[0];

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, model TEXT, runtime TEXT, codex_config TEXT)`);
  return db;
}

function insertAgent(
  db: DatabaseSync,
  id: string,
  model: string,
  runtime = 'cloud',
  codexConfig: string | null = null,
) {
  db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?)').run(id, model, runtime, codexConfig);
}

function modelOf(db: DatabaseSync, id: string): string {
  return (db.prepare('SELECT model FROM agents WHERE id = ?').get(id) as { model: string }).model;
}

function orchestratorModel(db: DatabaseSync): string | undefined {
  return (
    db.prepare(`SELECT value FROM settings WHERE key = 'orchestrator_model'`).get() as { value: string } | undefined
  )?.value;
}

describe('migration v157 - Claude Opus 5.5 como default do orquestrador e dos seeds Opus', () => {
  it('promove quem ainda esta no default anterior (claude-opus-5); o valor bate com CLAUDE_DEFAULT_MODEL', () => {
    const db = makeDb();
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('orchestrator_model', 'claude-opus-5');
    applyMigrationV157(db as unknown as V157Db);
    expect(orchestratorModel(db)).toBe('claude-opus-5-5');
    expect(__V157_INTERNAL.NEW_DEFAULT_MODEL).toBe(CLAUDE_DEFAULT_MODEL);
  });

  it('PRESERVA escolha deliberada em outro modelo (Claude ou nao)', () => {
    const db = makeDb();
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('orchestrator_model', 'claude-sonnet-5');
    applyMigrationV157(db as unknown as V157Db);
    expect(orchestratorModel(db)).toBe('claude-sonnet-5');
  });

  it('seeds Opus 4.8/4.7 no modelo original sobem para Opus 5.5; agente custom e seed alterado pelo usuario ficam', () => {
    const db = makeDb();
    insertAgent(db, 'ai-engineer', 'claude-opus-4-8');
    insertAgent(db, 'bug-root-cause-analyst', 'claude-opus-4-7');
    insertAgent(db, 'code-reviewer', 'claude-sonnet-5');
    insertAgent(db, 'meu-agente', 'claude-opus-4-8');
    insertAgent(db, 'typescript-pro', 'claude-opus-4-8', 'codex', JSON.stringify({ model: 'gpt-6-astra' }));
    applyMigrationV157(db as unknown as V157Db);
    expect(modelOf(db, 'ai-engineer')).toBe('claude-opus-5-5');
    expect(modelOf(db, 'bug-root-cause-analyst')).toBe('claude-opus-5-5');
    expect(modelOf(db, 'code-reviewer')).toBe('claude-sonnet-5');
    expect(modelOf(db, 'meu-agente')).toBe('claude-opus-4-8');
    expect(modelOf(db, 'typescript-pro')).toBe('claude-opus-4-8');
  });

  it('o resultado da migration bate com o que uma instalacao nova recebe dos seeds', () => {
    expect(aiEngineer.model).toBe(__V157_INTERNAL.NEW_DEFAULT_MODEL);
    expect(bugRootCauseAnalyst.model).toBe(__V157_INTERNAL.NEW_DEFAULT_MODEL);
    expect(__V157_INTERNAL.SEED_AGENT_IDS).toContain(aiEngineer.id);
    expect(__V157_INTERNAL.SEED_AGENT_IDS).toContain(bugRootCauseAnalyst.id);
  });

  it('e idempotente', () => {
    const db = makeDb();
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('orchestrator_model', 'claude-opus-5');
    insertAgent(db, 'ai-engineer', 'claude-opus-4-8');
    applyMigrationV157(db as unknown as V157Db);
    applyMigrationV157(db as unknown as V157Db);
    expect(orchestratorModel(db)).toBe('claude-opus-5-5');
    expect(modelOf(db, 'ai-engineer')).toBe('claude-opus-5-5');
  });
});

describe('migration v158 - GPT-6 Sol como default do codex', () => {
  const SEED_ID = 'dynamic-workflow-coder-codex';

  it('seed no default antigo (gpt-6-astra): muda model e codex_config.$.model; resto preservado', () => {
    const db = makeDb();
    insertAgent(
      db,
      SEED_ID,
      'gpt-6-astra',
      'codex',
      JSON.stringify({ model: 'gpt-6-astra', sandbox: 'workspace-write', x: 1 }),
    );
    applyMigrationV158(db as unknown as V158Db);
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(SEED_ID) as { model: string; codex_config: string };
    expect(row.model).toBe('gpt-6-sol');
    expect(JSON.parse(row.codex_config)).toEqual({ model: 'gpt-6-sol', sandbox: 'workspace-write', x: 1 });
  });

  it('modelo customizado no seed: intocado', () => {
    const db = makeDb();
    insertAgent(db, SEED_ID, 'gpt-6-luna', 'codex', JSON.stringify({ model: 'gpt-6-luna' }));
    applyMigrationV158(db as unknown as V158Db);
    expect(modelOf(db, SEED_ID)).toBe('gpt-6-luna');
  });

  it('o resultado bate com o seed e com CODEX_DEFAULT_MODEL', () => {
    expect(__V158_INTERNAL.NEW_MODEL).toBe(CODEX_DEFAULT_MODEL);
    expect(dynamicWorkflowCoderCodex.model).toBe(__V158_INTERNAL.NEW_MODEL);
    expect(dynamicWorkflowCoderCodex.codexConfig?.model).toBe(__V158_INTERNAL.NEW_MODEL);
  });

  it('LATEST_SCHEMA_VERSION cobre as duas migrations', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(159);
  });
});

describe('migration v159 - sub-agentes seguem o orquestrador para o Opus 5.5', () => {
  it('orquestrador no Opus 5.5: agentes cloud em claude-opus-5 sobem; outros modelos e runtimes ficam', () => {
    const db = makeDb();
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('orchestrator_model', 'claude-opus-5-5');
    insertAgent(db, 'ai-engineer', 'claude-opus-5');
    insertAgent(db, 'bug-discovery', 'claude-opus-5');
    insertAgent(db, 'coder', 'claude-sonnet-4-6');
    insertAgent(db, 'dynamic-workflow-coder-codex', 'gpt-6-sol', 'codex', JSON.stringify({ model: 'gpt-6-sol' }));
    applyMigrationV159(db as unknown as V159Db);
    expect(modelOf(db, 'ai-engineer')).toBe('claude-opus-5-5');
    expect(modelOf(db, 'bug-discovery')).toBe('claude-opus-5-5');
    expect(modelOf(db, 'coder')).toBe('claude-sonnet-4-6');
    expect(modelOf(db, 'dynamic-workflow-coder-codex')).toBe('gpt-6-sol');
  });

  it('orquestrador em outro modelo ou runtime: nao toca em nada', () => {
    for (const orchestrator of ['claude-sonnet-5', 'gpt-6-sol', 'claude-opus-5']) {
      const db = makeDb();
      db.prepare('INSERT INTO settings VALUES (?, ?)').run('orchestrator_model', orchestrator);
      insertAgent(db, 'ai-engineer', 'claude-opus-5');
      applyMigrationV159(db as unknown as V159Db);
      expect(modelOf(db, 'ai-engineer'), orchestrator).toBe('claude-opus-5');
    }
  });

  it('sem orchestrator_model gravado: nao toca em nada', () => {
    const db = makeDb();
    insertAgent(db, 'ai-engineer', 'claude-opus-5');
    applyMigrationV159(db as unknown as V159Db);
    expect(modelOf(db, 'ai-engineer')).toBe('claude-opus-5');
  });

  it('V157 seguida de V159 num DB que estava no default: orquestrador e sub-agentes terminam no Opus 5.5', () => {
    const db = makeDb();
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('orchestrator_model', 'claude-opus-5');
    insertAgent(db, 'ai-engineer', 'claude-opus-5');
    applyMigrationV157(db as unknown as V157Db);
    applyMigrationV159(db as unknown as V159Db);
    expect(orchestratorModel(db)).toBe('claude-opus-5-5');
    expect(modelOf(db, 'ai-engineer')).toBe('claude-opus-5-5');
    expect(__V159_INTERNAL.NEW_MODEL).toBe(CLAUDE_DEFAULT_MODEL);
  });
});
