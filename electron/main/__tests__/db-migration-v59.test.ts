import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { __V59_INTERNAL, applyMigrationV59 } from '../db-migrations/v59-pipe2-prompts';

const {
  OLD_PIPE2_PRD_COMPLETO_PROMPT,
  NEW_PIPE2_PRD_COMPLETO_PROMPT,
  OLD_PIPE2_TECH_FRONTEND_PROMPT,
  NEW_PIPE2_TECH_FRONTEND_PROMPT,
  OLD_PIPE2_SPEC_BUILDER_PROMPT,
  NEW_PIPE2_SPEC_BUILDER_PROMPT,
  OLD_PIPE2_SPEC_VALIDATOR_PROMPT,
  NEW_PIPE2_SPEC_VALIDATOR_PROMPT,
  OLD_PIPE2_SPEC_ENRICHER_PROMPT,
  NEW_PIPE2_SPEC_ENRICHER_PROMPT,
} = __V59_INTERNAL;

describe('db-migration-v59: OLD prompts are placeholders', () => {
  it('pipe2-prd-completo OLD is placeholder', () => {
    expect(OLD_PIPE2_PRD_COMPLETO_PROMPT).toContain('Prompt placeholder');
    expect(OLD_PIPE2_PRD_COMPLETO_PROMPT).toContain('pipe2-prd-completo');
  });

  it('pipe2-tech-frontend OLD is placeholder', () => {
    expect(OLD_PIPE2_TECH_FRONTEND_PROMPT).toContain('Prompt placeholder');
    expect(OLD_PIPE2_TECH_FRONTEND_PROMPT).toContain('pipe2-tech-frontend');
  });

  it('pipe2-spec-builder OLD is placeholder', () => {
    expect(OLD_PIPE2_SPEC_BUILDER_PROMPT).toContain('Prompt placeholder');
    expect(OLD_PIPE2_SPEC_BUILDER_PROMPT).toContain('pipe2-spec-builder');
  });

  it('pipe2-spec-validator OLD is placeholder', () => {
    expect(OLD_PIPE2_SPEC_VALIDATOR_PROMPT).toContain('Prompt placeholder');
    expect(OLD_PIPE2_SPEC_VALIDATOR_PROMPT).toContain('pipe2-spec-validator');
  });

  it('pipe2-spec-enricher OLD is placeholder', () => {
    expect(OLD_PIPE2_SPEC_ENRICHER_PROMPT).toContain('Prompt placeholder');
    expect(OLD_PIPE2_SPEC_ENRICHER_PROMPT).toContain('pipe2-spec-enricher');
  });
});

describe('db-migration-v59: NEW prompts contain expected content', () => {
  it('pipe2-prd-completo NEW contains design lock content', () => {
    expect(NEW_PIPE2_PRD_COMPLETO_PROMPT).not.toContain('Prompt placeholder');
    expect(NEW_PIPE2_PRD_COMPLETO_PROMPT).toContain('Development Pipeline 2.0');
    expect(NEW_PIPE2_PRD_COMPLETO_PROMPT).toContain('design-contract.json travado');
    expect(NEW_PIPE2_PRD_COMPLETO_PROMPT).toContain('Design Lock');
    expect(NEW_PIPE2_PRD_COMPLETO_PROMPT).toContain('Conflitos resolvidos');
  });

  it('pipe2-tech-frontend NEW contains design enforcement rules', () => {
    expect(NEW_PIPE2_TECH_FRONTEND_PROMPT).not.toContain('Prompt placeholder');
    expect(NEW_PIPE2_TECH_FRONTEND_PROMPT).toContain('Frontend Tecnico do Development Pipeline 2.0');
    expect(NEW_PIPE2_TECH_FRONTEND_PROMPT).toContain('artifact/index.html');
    expect(NEW_PIPE2_TECH_FRONTEND_PROMPT).toContain('criar nova tela');
  });

  it('pipe2-spec-builder NEW contains section 4.8', () => {
    expect(NEW_PIPE2_SPEC_BUILDER_PROMPT).not.toContain('Prompt placeholder');
    expect(NEW_PIPE2_SPEC_BUILDER_PROMPT).toContain('Spec Builder do Development Pipeline 2.0');
    expect(NEW_PIPE2_SPEC_BUILDER_PROMPT).toContain('4.8 Metadados para Planejamento de Sprints UI');
    expect(NEW_PIPE2_SPEC_BUILDER_PROMPT).toContain('DevelopmentV2SprintMetadata');
    expect(NEW_PIPE2_SPEC_BUILDER_PROMPT).toContain('design-contract.json');
  });

  it('pipe2-spec-validator NEW contains design lock validation rules', () => {
    expect(NEW_PIPE2_SPEC_VALIDATOR_PROMPT).not.toContain('Prompt placeholder');
    expect(NEW_PIPE2_SPEC_VALIDATOR_PROMPT).toContain('[MISS]');
    expect(NEW_PIPE2_SPEC_VALIDATOR_PROMPT).toContain('[CONFLICT]');
    expect(NEW_PIPE2_SPEC_VALIDATOR_PROMPT).toContain('design lock');
  });

  it('pipe2-spec-enricher NEW contains design lock restriction', () => {
    expect(NEW_PIPE2_SPEC_ENRICHER_PROMPT).not.toContain('Prompt placeholder');
    expect(NEW_PIPE2_SPEC_ENRICHER_PROMPT).toContain('design lock');
    expect(NEW_PIPE2_SPEC_ENRICHER_PROMPT).toContain('nao pode criar novas telas');
    expect(NEW_PIPE2_SPEC_ENRICHER_PROMPT).toContain('PHASE_COMPLETE');
  });
});

describe('db-migration-v59: contrato OLD != NEW', () => {
  const pairs = [
    ['prd-completo', OLD_PIPE2_PRD_COMPLETO_PROMPT, NEW_PIPE2_PRD_COMPLETO_PROMPT],
    ['tech-frontend', OLD_PIPE2_TECH_FRONTEND_PROMPT, NEW_PIPE2_TECH_FRONTEND_PROMPT],
    ['spec-builder', OLD_PIPE2_SPEC_BUILDER_PROMPT, NEW_PIPE2_SPEC_BUILDER_PROMPT],
    ['spec-validator', OLD_PIPE2_SPEC_VALIDATOR_PROMPT, NEW_PIPE2_SPEC_VALIDATOR_PROMPT],
    ['spec-enricher', OLD_PIPE2_SPEC_ENRICHER_PROMPT, NEW_PIPE2_SPEC_ENRICHER_PROMPT],
  ] as const;

  for (const [name, old, newp] of pairs) {
    it(`${name}: OLD e NEW sao diferentes e nao-vazios`, () => {
      expect(old.length).toBeGreaterThan(50);
      expect(newp.length).toBeGreaterThan(100);
      expect(old).not.toBe(newp);
    });
  }
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
  db.prepare(`INSERT INTO agents (id, name, description, system_prompt) VALUES (?, ?, ?, ?)`).run(
    id,
    id,
    `desc-${id}`,
    system_prompt,
  );
}

const AGENT_IDS = [
  'pipe2-prd-completo',
  'pipe2-tech-frontend',
  'pipe2-spec-builder',
  'pipe2-spec-validator',
  'pipe2-spec-enricher',
] as const;

const OLD_PROMPTS: Record<string, string> = {
  'pipe2-prd-completo': OLD_PIPE2_PRD_COMPLETO_PROMPT,
  'pipe2-tech-frontend': OLD_PIPE2_TECH_FRONTEND_PROMPT,
  'pipe2-spec-builder': OLD_PIPE2_SPEC_BUILDER_PROMPT,
  'pipe2-spec-validator': OLD_PIPE2_SPEC_VALIDATOR_PROMPT,
  'pipe2-spec-enricher': OLD_PIPE2_SPEC_ENRICHER_PROMPT,
};

const NEW_PROMPTS: Record<string, string> = {
  'pipe2-prd-completo': NEW_PIPE2_PRD_COMPLETO_PROMPT,
  'pipe2-tech-frontend': NEW_PIPE2_TECH_FRONTEND_PROMPT,
  'pipe2-spec-builder': NEW_PIPE2_SPEC_BUILDER_PROMPT,
  'pipe2-spec-validator': NEW_PIPE2_SPEC_VALIDATOR_PROMPT,
  'pipe2-spec-enricher': NEW_PIPE2_SPEC_ENRICHER_PROMPT,
};

describe('db-migration-v59: applyMigrationV59 (banco in-memory)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_AGENTS);
  });

  for (const agentId of AGENT_IDS) {
    it(`aplica NEW prompt quando system_prompt = OLD (${agentId})`, () => {
      insertAgent(db, agentId, OLD_PROMPTS[agentId]!);
      applyMigrationV59(db);
      const row = db.prepare(`SELECT system_prompt FROM agents WHERE id = ?`).get(agentId) as { system_prompt: string };
      expect(row.system_prompt).toBe(NEW_PROMPTS[agentId]);
    });
  }

  it('preserva customizacao do usuario em todos os 5 agentes', () => {
    const CUSTOM = 'meu prompt customizado pelo usuario';
    for (const id of AGENT_IDS) {
      insertAgent(db, id, CUSTOM);
    }
    applyMigrationV59(db);
    for (const id of AGENT_IDS) {
      const row = db.prepare(`SELECT system_prompt FROM agents WHERE id = ?`).get(id) as { system_prompt: string };
      expect(row.system_prompt).toBe(CUSTOM);
    }
  });

  it('atualiza apenas os agentes com OLD prompt, preserva outros', () => {
    insertAgent(db, 'pipe2-prd-completo', OLD_PIPE2_PRD_COMPLETO_PROMPT);
    insertAgent(db, 'pipe2-tech-frontend', 'custom-frontend-prompt');
    insertAgent(db, 'pipe2-spec-builder', OLD_PIPE2_SPEC_BUILDER_PROMPT);
    insertAgent(db, 'pipe2-spec-validator', 'custom-validator-prompt');

    applyMigrationV59(db);

    const prdCompleto = db.prepare(`SELECT system_prompt FROM agents WHERE id='pipe2-prd-completo'`).get() as {
      system_prompt: string;
    };
    expect(prdCompleto.system_prompt).toBe(NEW_PIPE2_PRD_COMPLETO_PROMPT);

    const techFrontend = db.prepare(`SELECT system_prompt FROM agents WHERE id='pipe2-tech-frontend'`).get() as {
      system_prompt: string;
    };
    expect(techFrontend.system_prompt).toBe('custom-frontend-prompt');

    const specBuilder = db.prepare(`SELECT system_prompt FROM agents WHERE id='pipe2-spec-builder'`).get() as {
      system_prompt: string;
    };
    expect(specBuilder.system_prompt).toBe(NEW_PIPE2_SPEC_BUILDER_PROMPT);

    const specValidator = db.prepare(`SELECT system_prompt FROM agents WHERE id='pipe2-spec-validator'`).get() as {
      system_prompt: string;
    };
    expect(specValidator.system_prompt).toBe('custom-validator-prompt');
  });

  it('is idempotent: running twice does not break anything', () => {
    for (const id of AGENT_IDS) {
      insertAgent(db, id, OLD_PROMPTS[id]!);
    }
    applyMigrationV59(db);
    applyMigrationV59(db);
    for (const id of AGENT_IDS) {
      const row = db.prepare(`SELECT system_prompt FROM agents WHERE id = ?`).get(id) as { system_prompt: string };
      expect(row.system_prompt).toBe(NEW_PROMPTS[id]);
    }
  });
});
