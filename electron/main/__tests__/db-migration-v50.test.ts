
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { __V50_INTERNAL, applyMigrationV50 } from '../db-migrations/v50-prompts';

const {
  OLD_SPEC_BUILDER_PROMPT,
  NEW_SPEC_BUILDER_PROMPT,
  OLD_SPEC_VALIDATOR_PROMPT,
  NEW_SPEC_VALIDATOR_PROMPT,
  OLD_SECURITY_SKEPTIC_SECURITY_PROMPT,
  NEW_SECURITY_SKEPTIC_SECURITY_PROMPT,
} = __V50_INTERNAL;

describe('db-migration-v50: spec-builder prompt', () => {
  it('OLD prompt menciona BuildPlan workflow', () => {
    expect(OLD_SPEC_BUILDER_PROMPT).toContain('do LionClaw BuildPlan workflow');
    expect(OLD_SPEC_BUILDER_PROMPT).toContain('Gerado automaticamente pelo BuildPlan');
  });

  it('NEW prompt nao menciona BuildPlan workflow', () => {
    expect(NEW_SPEC_BUILDER_PROMPT).not.toContain('BuildPlan');
    expect(NEW_SPEC_BUILDER_PROMPT).toContain('usado pelos pipelines do LionClaw');
    expect(NEW_SPEC_BUILDER_PROMPT).toContain('Gerado automaticamente pelos pipelines do LionClaw');
  });

  it('OLD e NEW preservam o resto do prompt (so trocaram as sentinelas)', () => {
    expect(OLD_SPEC_BUILDER_PROMPT).toContain('## Principios fundamentais');
    expect(NEW_SPEC_BUILDER_PROMPT).toContain('## Principios fundamentais');
    expect(OLD_SPEC_BUILDER_PROMPT).toContain('## Estrutura do SPEC.md');
    expect(NEW_SPEC_BUILDER_PROMPT).toContain('## Estrutura do SPEC.md');
  });
});

describe('db-migration-v50: spec-validator prompt', () => {
  it('OLD prompt menciona BuildPlan workflow', () => {
    expect(OLD_SPEC_VALIDATOR_PROMPT).toContain('do LionClaw BuildPlan workflow');
  });

  it('NEW prompt nao menciona BuildPlan workflow', () => {
    expect(NEW_SPEC_VALIDATOR_PROMPT).not.toContain('BuildPlan');
    expect(NEW_SPEC_VALIDATOR_PROMPT).toContain('usado pelos pipelines do LionClaw');
  });

  it('OLD e NEW preservam o resto do prompt', () => {
    expect(OLD_SPEC_VALIDATOR_PROMPT).toContain('## Tres dimensoes de validacao');
    expect(NEW_SPEC_VALIDATOR_PROMPT).toContain('## Tres dimensoes de validacao');
    expect(OLD_SPEC_VALIDATOR_PROMPT).toContain('[MISS]');
    expect(NEW_SPEC_VALIDATOR_PROMPT).toContain('[MISS]');
  });
});

describe('db-migration-v50: security-skeptic-security prompt', () => {
  it('OLD prompt usa o formato pre-S0.5 (Secao 01: Secrets Scanner etc.)', () => {
    expect(OLD_SECURITY_SKEPTIC_SECURITY_PROMPT).toContain('Secao 01: Secrets Scanner');
    expect(OLD_SECURITY_SKEPTIC_SECURITY_PROMPT).toContain('Secao 02: Auth Auditor');
    expect(OLD_SECURITY_SKEPTIC_SECURITY_PROMPT).toContain('Secao 03: Isolation Inspector');
    expect(OLD_SECURITY_SKEPTIC_SECURITY_PROMPT).toContain('Secao 07: OWASP Scanner');
    expect(OLD_SECURITY_SKEPTIC_SECURITY_PROMPT).toContain(
      'elas sao responsabilidade do outro validador',
    );
  });

  it('NEW prompt usa o formato pos-S0.5 (descricoes funcionais sem nomes de agentes) com PT_BR_BLOCK', () => {
    expect(NEW_SECURITY_SKEPTIC_SECURITY_PROMPT).toContain('Secao 01 (deteccao de credenciais expostas)');
    expect(NEW_SECURITY_SKEPTIC_SECURITY_PROMPT).toContain('Secao 02 (autenticacao e autorizacao)');
    expect(NEW_SECURITY_SKEPTIC_SECURITY_PROMPT).not.toContain('Secao 01: Secrets Scanner');
    expect(NEW_SECURITY_SKEPTIC_SECURITY_PROMPT).toContain('escopo separado deste agente');
    expect(NEW_SECURITY_SKEPTIC_SECURITY_PROMPT).toContain('Responda SEMPRE em portugues do Brasil');
  });
});

describe('db-migration-v50: contrato de preservacao', () => {
  it('OLD e NEW sao strings nao-vazias e diferentes', () => {
    expect(OLD_SPEC_BUILDER_PROMPT.length).toBeGreaterThan(100);
    expect(NEW_SPEC_BUILDER_PROMPT.length).toBeGreaterThan(100);
    expect(OLD_SPEC_BUILDER_PROMPT).not.toBe(NEW_SPEC_BUILDER_PROMPT);

    expect(OLD_SPEC_VALIDATOR_PROMPT.length).toBeGreaterThan(100);
    expect(NEW_SPEC_VALIDATOR_PROMPT.length).toBeGreaterThan(100);
    expect(OLD_SPEC_VALIDATOR_PROMPT).not.toBe(NEW_SPEC_VALIDATOR_PROMPT);

    expect(OLD_SECURITY_SKEPTIC_SECURITY_PROMPT.length).toBeGreaterThan(100);
    expect(NEW_SECURITY_SKEPTIC_SECURITY_PROMPT.length).toBeGreaterThan(100);
    expect(OLD_SECURITY_SKEPTIC_SECURITY_PROMPT).not.toBe(NEW_SECURITY_SKEPTIC_SECURITY_PROMPT);
  });
});


const SCHEMA_AGENTS = `
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    model TEXT DEFAULT 'sonnet',
    allowed_tools TEXT DEFAULT '[]',
    mcp_servers TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    squad TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

function insertAgent(db: Database.Database, id: string, system_prompt: string): void {
  db.prepare(
    `INSERT INTO agents (id, name, description, system_prompt) VALUES (?, ?, ?, ?)`,
  ).run(id, id, `desc-${id}`, system_prompt);
}

describe('db-migration-v50: applyMigrationV50 (banco in-memory)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_AGENTS);
  });

  it('aplica NEW prompt quando system_prompt = OLD (spec-builder)', () => {
    insertAgent(db, 'spec-builder', __V50_INTERNAL.OLD_SPEC_BUILDER_PROMPT);

    applyMigrationV50(db);

    const row = db
      .prepare(`SELECT system_prompt FROM agents WHERE id='spec-builder'`)
      .get() as { system_prompt: string };
    expect(row.system_prompt).toBe(__V50_INTERNAL.NEW_SPEC_BUILDER_PROMPT);
  });

  it('aplica NEW prompt quando system_prompt = OLD (spec-validator)', () => {
    insertAgent(db, 'spec-validator', __V50_INTERNAL.OLD_SPEC_VALIDATOR_PROMPT);

    applyMigrationV50(db);

    const row = db
      .prepare(`SELECT system_prompt FROM agents WHERE id='spec-validator'`)
      .get() as { system_prompt: string };
    expect(row.system_prompt).toBe(__V50_INTERNAL.NEW_SPEC_VALIDATOR_PROMPT);
  });

  it('aplica NEW prompt quando system_prompt = OLD (security-skeptic-security)', () => {
    insertAgent(
      db,
      'security-skeptic-security',
      __V50_INTERNAL.OLD_SECURITY_SKEPTIC_SECURITY_PROMPT,
    );

    applyMigrationV50(db);

    const row = db
      .prepare(`SELECT system_prompt FROM agents WHERE id='security-skeptic-security'`)
      .get() as { system_prompt: string };
    expect(row.system_prompt).toBe(__V50_INTERNAL.NEW_SECURITY_SKEPTIC_SECURITY_PROMPT);
  });

  it('preserva customizacao do user (system_prompt diferente do OLD nao e tocado)', () => {
    const CUSTOM = 'meu prompt customizado pelo user';
    insertAgent(db, 'spec-builder', CUSTOM);
    insertAgent(db, 'spec-validator', CUSTOM);
    insertAgent(db, 'security-skeptic-security', CUSTOM);

    applyMigrationV50(db);

    const rows = db
      .prepare(
        `SELECT id, system_prompt FROM agents WHERE id IN ('spec-builder','spec-validator','security-skeptic-security') ORDER BY id`,
      )
      .all() as Array<{ id: string; system_prompt: string }>;
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.system_prompt).toBe(CUSTOM);
  });

  it('opera nos 3 IDs (spec-builder, spec-validator, security-skeptic-security) independentemente', () => {
    insertAgent(db, 'spec-builder', __V50_INTERNAL.OLD_SPEC_BUILDER_PROMPT);
    insertAgent(db, 'spec-validator', 'custom-validator');
    insertAgent(db, 'security-skeptic-security', __V50_INTERNAL.OLD_SECURITY_SKEPTIC_SECURITY_PROMPT);

    applyMigrationV50(db);

    const sb = db.prepare(`SELECT system_prompt FROM agents WHERE id='spec-builder'`).get() as { system_prompt: string };
    expect(sb.system_prompt).toBe(__V50_INTERNAL.NEW_SPEC_BUILDER_PROMPT);

    const sv = db.prepare(`SELECT system_prompt FROM agents WHERE id='spec-validator'`).get() as { system_prompt: string };
    expect(sv.system_prompt).toBe('custom-validator');

    const sk = db.prepare(`SELECT system_prompt FROM agents WHERE id='security-skeptic-security'`).get() as { system_prompt: string };
    expect(sk.system_prompt).toBe(__V50_INTERNAL.NEW_SECURITY_SKEPTIC_SECURITY_PROMPT);
  });

  it('aplicar V50 duas vezes eh idempotente (segunda no-op porque WHERE nao casa)', () => {
    insertAgent(db, 'spec-builder', __V50_INTERNAL.OLD_SPEC_BUILDER_PROMPT);

    applyMigrationV50(db);
    const after1 = (db.prepare(`SELECT system_prompt FROM agents WHERE id='spec-builder'`).get() as { system_prompt: string }).system_prompt;
    expect(after1).toBe(__V50_INTERNAL.NEW_SPEC_BUILDER_PROMPT);

    applyMigrationV50(db);
    const after2 = (db.prepare(`SELECT system_prompt FROM agents WHERE id='spec-builder'`).get() as { system_prompt: string }).system_prompt;
    expect(after2).toBe(__V50_INTERNAL.NEW_SPEC_BUILDER_PROMPT);
  });

  it('nao toca em agents nao listados na migration', () => {
    insertAgent(db, 'outro-agente', __V50_INTERNAL.OLD_SPEC_BUILDER_PROMPT);

    applyMigrationV50(db);

    const row = db.prepare(`SELECT system_prompt FROM agents WHERE id='outro-agente'`).get() as { system_prompt: string };
    expect(row.system_prompt).toBe(__V50_INTERNAL.OLD_SPEC_BUILDER_PROMPT);
  });
});
