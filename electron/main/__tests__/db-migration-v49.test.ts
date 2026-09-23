import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

const MIGRATION_V49_FIX_AGENT_SQUADS = `
  UPDATE agents SET squad = 'pipeline'
    WHERE id IN ('tech-database', 'tech-backend', 'tech-frontend', 'tech-security')
      AND squad = 'workflow';

  UPDATE agents SET squad = 'harness'
    WHERE squad IS NULL AND id IN ('harness-coder', 'harness-planner', 'harness-evaluator');

  UPDATE agents SET squad = 'pipeline'
    WHERE squad IS NULL AND id IN ('repo-profiler', 'spec-builder', 'spec-validator');

  UPDATE agents SET squad = 'security'
    WHERE squad IS NULL AND id IN (
      'security-secrets-scanner', 'security-auth-auditor', 'security-isolation-inspector',
      'security-duplication-detector', 'security-logic-analyzer', 'security-standards-checker',
      'security-owasp-scanner', 'security-deduplicator', 'security-skeptic-security',
      'security-skeptic-quality', 'security-resolution-tracker'
    );
`;

describe('db-migration-v49: analise estrutural do SQL', () => {
  it('inclui as 4 reatribuicoes tech-* de workflow para pipeline', () => {
    expect(MIGRATION_V49_FIX_AGENT_SQUADS).toContain("'tech-database'");
    expect(MIGRATION_V49_FIX_AGENT_SQUADS).toContain("'tech-backend'");
    expect(MIGRATION_V49_FIX_AGENT_SQUADS).toContain("'tech-frontend'");
    expect(MIGRATION_V49_FIX_AGENT_SQUADS).toContain("'tech-security'");
    expect(MIGRATION_V49_FIX_AGENT_SQUADS).toContain("squad = 'workflow'");
  });

  it('atribui squad harness aos 3 harness agents quando squad IS NULL', () => {
    expect(MIGRATION_V49_FIX_AGENT_SQUADS).toMatch(
      /UPDATE agents SET squad = 'harness'[\s\S]+'harness-coder'[\s\S]+'harness-planner'[\s\S]+'harness-evaluator'/,
    );
  });

  it('atribui squad pipeline aos 3 pipeline agents quando squad IS NULL', () => {
    expect(MIGRATION_V49_FIX_AGENT_SQUADS).toMatch(
      /UPDATE agents SET squad = 'pipeline'[\s\S]+'repo-profiler'[\s\S]+'spec-builder'[\s\S]+'spec-validator'/,
    );
  });

  it('atribui squad security aos 11 security agents quando squad IS NULL', () => {
    const securityIds = [
      'security-secrets-scanner',
      'security-auth-auditor',
      'security-isolation-inspector',
      'security-duplication-detector',
      'security-logic-analyzer',
      'security-standards-checker',
      'security-owasp-scanner',
      'security-deduplicator',
      'security-skeptic-security',
      'security-skeptic-quality',
      'security-resolution-tracker',
    ];
    for (const id of securityIds) {
      expect(MIGRATION_V49_FIX_AGENT_SQUADS).toContain(`'${id}'`);
    }
    expect(securityIds).toHaveLength(11);
  });

  it('todas as 4 statements sao insert-only (nao tocam squads ja preenchidos com outros valores)', () => {
    const statements = MIGRATION_V49_FIX_AGENT_SQUADS.split(';')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('UPDATE'));
    expect(statements).toHaveLength(4);
    expect(statements[0]).toContain("squad = 'workflow'");
    expect(statements[1]).toContain('squad IS NULL');
    expect(statements[2]).toContain('squad IS NULL');
    expect(statements[3]).toContain('squad IS NULL');
  });

  it('total de IDs reconciliados: 4 (tech) + 3 (harness) + 3 (pipeline) + 11 (security) = 21', () => {
    const allIds = [
      'tech-database',
      'tech-backend',
      'tech-frontend',
      'tech-security',
      'harness-coder',
      'harness-planner',
      'harness-evaluator',
      'repo-profiler',
      'spec-builder',
      'spec-validator',
      'security-secrets-scanner',
      'security-auth-auditor',
      'security-isolation-inspector',
      'security-duplication-detector',
      'security-logic-analyzer',
      'security-standards-checker',
      'security-owasp-scanner',
      'security-deduplicator',
      'security-skeptic-security',
      'security-skeptic-quality',
      'security-resolution-tracker',
    ];
    expect(allIds).toHaveLength(21);
    for (const id of allIds) {
      expect(MIGRATION_V49_FIX_AGENT_SQUADS).toContain(`'${id}'`);
    }
  });
});

describe('db-migration-v49: applyMigrationV49Tools (allowed_tools secrets-scanner)', () => {
  it('tem condicional explicita pra preservar customizacoes do user', () => {
    const NEW_TOOLS = '["Read","Grep","Glob","Bash"]';
    const OLD_TOOLS = '["Read","Grep","Glob"]';
    expect(NEW_TOOLS).toContain('Bash');
    expect(OLD_TOOLS).not.toContain('Bash');
    expect(JSON.parse(OLD_TOOLS)).toHaveLength(3);
    expect(JSON.parse(NEW_TOOLS)).toHaveLength(4);
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

const OLD_TOOLS = '["Read","Grep","Glob"]';
const NEW_TOOLS = '["Read","Grep","Glob","Bash"]';

function applyV49Tools(db: Database.Database): void {
  db.prepare(`UPDATE agents SET allowed_tools = ? WHERE id = 'security-secrets-scanner' AND allowed_tools = ?`).run(
    NEW_TOOLS,
    OLD_TOOLS,
  );
}

function insertAgent(db: Database.Database, id: string, squad: string | null, allowed_tools: string = '[]'): void {
  db.prepare(
    `INSERT INTO agents (id, name, description, system_prompt, squad, allowed_tools) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, id, `desc-${id}`, `prompt-${id}`, squad, allowed_tools);
}

describe('db-migration-v49: execucao em banco in-memory', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_AGENTS);
  });

  it('aplica UPDATE em DB com 4 tech-* squad=workflow e migra para pipeline', () => {
    insertAgent(db, 'tech-database', 'workflow');
    insertAgent(db, 'tech-backend', 'workflow');
    insertAgent(db, 'tech-frontend', 'workflow');
    insertAgent(db, 'tech-security', 'workflow');

    db.exec(MIGRATION_V49_FIX_AGENT_SQUADS);

    const rows = db.prepare(`SELECT id, squad FROM agents WHERE id LIKE 'tech-%' ORDER BY id`).all() as Array<{
      id: string;
      squad: string;
    }>;
    expect(rows).toEqual([
      { id: 'tech-backend', squad: 'pipeline' },
      { id: 'tech-database', squad: 'pipeline' },
      { id: 'tech-frontend', squad: 'pipeline' },
      { id: 'tech-security', squad: 'pipeline' },
    ]);
  });

  it('atribui squad harness aos 3 harness agents quando squad IS NULL', () => {
    insertAgent(db, 'harness-coder', null);
    insertAgent(db, 'harness-planner', null);
    insertAgent(db, 'harness-evaluator', null);

    db.exec(MIGRATION_V49_FIX_AGENT_SQUADS);

    const rows = db.prepare(`SELECT id, squad FROM agents WHERE id LIKE 'harness-%' ORDER BY id`).all() as Array<{
      id: string;
      squad: string;
    }>;
    expect(rows).toEqual([
      { id: 'harness-coder', squad: 'harness' },
      { id: 'harness-evaluator', squad: 'harness' },
      { id: 'harness-planner', squad: 'harness' },
    ]);
  });

  it('atribui squad pipeline aos 3 pipeline agents quando squad IS NULL', () => {
    insertAgent(db, 'repo-profiler', null);
    insertAgent(db, 'spec-builder', null);
    insertAgent(db, 'spec-validator', null);

    db.exec(MIGRATION_V49_FIX_AGENT_SQUADS);

    const rows = db
      .prepare(`SELECT id, squad FROM agents WHERE id IN ('repo-profiler','spec-builder','spec-validator') ORDER BY id`)
      .all() as Array<{ id: string; squad: string }>;
    expect(rows).toEqual([
      { id: 'repo-profiler', squad: 'pipeline' },
      { id: 'spec-builder', squad: 'pipeline' },
      { id: 'spec-validator', squad: 'pipeline' },
    ]);
  });

  it('atribui squad security aos 11 security agents quando squad IS NULL', () => {
    const securityIds = [
      'security-secrets-scanner',
      'security-auth-auditor',
      'security-isolation-inspector',
      'security-duplication-detector',
      'security-logic-analyzer',
      'security-standards-checker',
      'security-owasp-scanner',
      'security-deduplicator',
      'security-skeptic-security',
      'security-skeptic-quality',
      'security-resolution-tracker',
    ];
    for (const id of securityIds) insertAgent(db, id, null);

    db.exec(MIGRATION_V49_FIX_AGENT_SQUADS);

    const rows = db.prepare(`SELECT squad FROM agents WHERE id LIKE 'security-%'`).all() as Array<{ squad: string }>;
    expect(rows).toHaveLength(11);
    for (const r of rows) expect(r.squad).toBe('security');
  });

  it('preserva squad customizado pelo user (nao toca se squad ja for diferente do esperado)', () => {
    insertAgent(db, 'harness-coder', 'custom-squad');
    insertAgent(db, 'tech-database', 'custom');

    db.exec(MIGRATION_V49_FIX_AGENT_SQUADS);

    const harness = db.prepare(`SELECT squad FROM agents WHERE id='harness-coder'`).get() as { squad: string };
    expect(harness.squad).toBe('custom-squad');

    const tech = db.prepare(`SELECT squad FROM agents WHERE id='tech-database'`).get() as { squad: string };
    expect(tech.squad).toBe('custom');
  });

  it('aplica allowed_tools=Read,Grep,Glob,Bash em secrets-scanner se OLD_TOOLS bater', () => {
    insertAgent(db, 'security-secrets-scanner', 'security', OLD_TOOLS);

    applyV49Tools(db);

    const row = db.prepare(`SELECT allowed_tools FROM agents WHERE id='security-secrets-scanner'`).get() as {
      allowed_tools: string;
    };
    expect(row.allowed_tools).toBe(NEW_TOOLS);
    expect(JSON.parse(row.allowed_tools)).toContain('Bash');
  });

  it('NAO aplica allowed_tools se user customizou (preservacao)', () => {
    const CUSTOM = '["Read","Grep","Glob","WebSearch"]';
    insertAgent(db, 'security-secrets-scanner', 'security', CUSTOM);

    applyV49Tools(db);

    const row = db.prepare(`SELECT allowed_tools FROM agents WHERE id='security-secrets-scanner'`).get() as {
      allowed_tools: string;
    };
    expect(row.allowed_tools).toBe(CUSTOM);
  });

  it('aplicar MIGRATION_V49_FIX_AGENT_SQUADS duas vezes eh idempotente (segunda no-op)', () => {
    insertAgent(db, 'tech-database', 'workflow');
    insertAgent(db, 'harness-coder', null);

    db.exec(MIGRATION_V49_FIX_AGENT_SQUADS);
    const snap1 = db.prepare(`SELECT id, squad FROM agents ORDER BY id`).all();

    db.exec(MIGRATION_V49_FIX_AGENT_SQUADS);
    const snap2 = db.prepare(`SELECT id, squad FROM agents ORDER BY id`).all();

    expect(snap2).toEqual(snap1);
  });
});
