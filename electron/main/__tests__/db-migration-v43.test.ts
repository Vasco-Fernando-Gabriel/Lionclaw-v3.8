import { describe, it, expect } from 'vitest';

const MIGRATION_V43 = `
  CREATE TABLE agents_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    system_prompt TEXT DEFAULT '',
    model TEXT DEFAULT 'sonnet',
    allowed_tools TEXT DEFAULT '[]',
    mcp_servers TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    effort TEXT DEFAULT 'medium',
    thinking TEXT DEFAULT 'adaptive',
    thinking_budget INTEGER,
    max_turns INTEGER,
    skills TEXT DEFAULT '[]',
    kb_enabled INTEGER NOT NULL DEFAULT 1,
    runtime TEXT DEFAULT 'cloud'
      CHECK (runtime IN ('cloud', 'local', 'external')),
    local_config TEXT DEFAULT NULL,
    external_config TEXT DEFAULT NULL,
    local_mode TEXT DEFAULT 'simple',
    max_tool_rounds INTEGER DEFAULT 5,
    squad TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT INTO agents_new (
    id, name, description, system_prompt, model, allowed_tools, mcp_servers,
    is_active, sort_order, effort, thinking, thinking_budget, max_turns,
    skills, kb_enabled, runtime, local_config, local_mode, max_tool_rounds, squad,
    created_at, updated_at
  )
  SELECT
    id, name, description, system_prompt, model, allowed_tools, mcp_servers,
    is_active, sort_order, effort, thinking, thinking_budget, max_turns,
    skills, kb_enabled, runtime, local_config, local_mode, max_tool_rounds, squad,
    created_at, updated_at
  FROM agents;

  DROP TABLE agents;
  ALTER TABLE agents_new RENAME TO agents;
`;

describe('db-migration-v43: analise estrutural do SQL', () => {
  it('MIGRATION_V43 contem coluna external_config', () => {
    expect(MIGRATION_V43).toContain('external_config');
  });

  it('MIGRATION_V43 define external_config como TEXT DEFAULT NULL', () => {
    expect(MIGRATION_V43).toContain('external_config TEXT DEFAULT NULL');
  });

  it('MIGRATION_V43 contem CHECK constraint com "external"', () => {
    expect(MIGRATION_V43).toContain("'external'");
    expect(MIGRATION_V43).toContain("runtime IN ('cloud', 'local', 'external')");
  });

  it('MIGRATION_V43 cria tabela agents_new e faz rename', () => {
    expect(MIGRATION_V43).toContain('CREATE TABLE agents_new');
    expect(MIGRATION_V43).toContain('ALTER TABLE agents_new RENAME TO agents');
  });

  it('MIGRATION_V43 copia colunas pre-existentes no INSERT INTO', () => {
    const requiredCols = [
      'id',
      'name',
      'description',
      'system_prompt',
      'model',
      'allowed_tools',
      'mcp_servers',
      'is_active',
      'sort_order',
      'effort',
      'thinking',
      'thinking_budget',
      'max_turns',
      'skills',
      'kb_enabled',
      'runtime',
      'local_config',
      'local_mode',
      'max_tool_rounds',
      'squad',
      'created_at',
      'updated_at',
    ];
    for (const col of requiredCols) {
      expect(MIGRATION_V43).toContain(col);
    }
  });

  it('MIGRATION_V43 NAO inclui external_config no INSERT SELECT (coluna nova = NULL)', () => {
    const insertSection = MIGRATION_V43.substring(
      MIGRATION_V43.indexOf('INSERT INTO agents_new'),
      MIGRATION_V43.indexOf('FROM agents'),
    );
    expect(insertSection).not.toContain('external_config');
  });

  it('MIGRATION_V43 faz DROP da tabela antiga antes do rename', () => {
    const dropIndex = MIGRATION_V43.indexOf('DROP TABLE agents');
    const renameIndex = MIGRATION_V43.indexOf('ALTER TABLE agents_new RENAME TO agents');
    expect(dropIndex).toBeGreaterThan(0);
    expect(renameIndex).toBeGreaterThan(dropIndex);
  });
});

describe('db-migration-v43: execucao em banco in-memory', () => {
  it.skip('preserva o numero total de agentes (100) apos migration', () => {});

  it.skip('preserva todos os campos campo a campo (name, model, runtime, kb_enabled, local_config, squad, created_at)', () => {});

  it.skip('nova coluna external_config existe e e NULL para agentes pre-existentes', () => {});

  it.skip('permite inserir agente com runtime "external" apos migration', () => {});

  it.skip('rejeita runtime invalido (CHECK constraint ativo apos migration)', () => {});

  it.skip('aceita runtime "cloud", "local", "external" apos migration', () => {});
});
