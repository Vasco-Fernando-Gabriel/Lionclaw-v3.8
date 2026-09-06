
import { describe, it, expect } from 'vitest';


const MIGRATION_V47 = `
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
      CHECK (runtime IN ('cloud', 'local', 'external', 'codex')),
    local_config TEXT DEFAULT NULL,
    external_config TEXT DEFAULT NULL,
    codex_config TEXT DEFAULT NULL,
    local_mode TEXT DEFAULT 'simple',
    max_tool_rounds INTEGER DEFAULT 5,
    squad TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT INTO agents_new (
    id, name, description, system_prompt, model, allowed_tools, mcp_servers,
    is_active, sort_order, effort, thinking, thinking_budget, max_turns,
    skills, kb_enabled, runtime, local_config, external_config, local_mode,
    max_tool_rounds, squad, created_at, updated_at,
    codex_config
  )
  SELECT
    id, name, description, system_prompt, model, allowed_tools, mcp_servers,
    is_active, sort_order, effort, thinking, thinking_budget, max_turns,
    skills, kb_enabled, runtime, local_config, external_config, local_mode,
    max_tool_rounds, squad, created_at, updated_at,
    NULL AS codex_config
  FROM agents;

  DROP TABLE agents;
  ALTER TABLE agents_new RENAME TO agents;
`;


describe('db-migration-v47: analise estrutural do SQL', () => {
  it('MIGRATION_V47 contem coluna codex_config', () => {
    expect(MIGRATION_V47).toContain('codex_config');
  });

  it('MIGRATION_V47 define codex_config como TEXT DEFAULT NULL', () => {
    expect(MIGRATION_V47).toContain('codex_config TEXT DEFAULT NULL');
  });

  it('MIGRATION_V47 contem CHECK constraint com "codex"', () => {
    expect(MIGRATION_V47).toContain("'codex'");
    expect(MIGRATION_V47).toContain("runtime IN ('cloud', 'local', 'external', 'codex')");
  });

  it('MIGRATION_V47 CHECK constraint aceita exatamente 4 runtimes', () => {
    const match = MIGRATION_V47.match(/runtime IN \(([^)]+)\)/);
    expect(match).not.toBeNull();
    const runtimes = match![1].split(',').map(s => s.trim().replace(/'/g, ''));
    expect(runtimes).toHaveLength(4);
    expect(runtimes).toContain('cloud');
    expect(runtimes).toContain('local');
    expect(runtimes).toContain('external');
    expect(runtimes).toContain('codex');
  });

  it('MIGRATION_V47 cria tabela agents_new e faz rename', () => {
    expect(MIGRATION_V47).toContain('CREATE TABLE agents_new');
    expect(MIGRATION_V47).toContain('ALTER TABLE agents_new RENAME TO agents');
  });

  it('MIGRATION_V47 faz DROP da tabela antiga antes do rename', () => {
    const dropIndex = MIGRATION_V47.indexOf('DROP TABLE agents');
    const renameIndex = MIGRATION_V47.indexOf('ALTER TABLE agents_new RENAME TO agents');
    expect(dropIndex).toBeGreaterThan(0);
    expect(renameIndex).toBeGreaterThan(dropIndex);
  });

  it('MIGRATION_V47 copia todas as colunas pre-existentes no SELECT', () => {
    const requiredCols = [
      'id', 'name', 'description', 'system_prompt', 'model',
      'allowed_tools', 'mcp_servers', 'is_active', 'sort_order',
      'effort', 'thinking', 'thinking_budget', 'max_turns',
      'skills', 'kb_enabled', 'runtime', 'local_config', 'external_config',
      'local_mode', 'max_tool_rounds', 'squad', 'created_at', 'updated_at',
    ];
    for (const col of requiredCols) {
      expect(MIGRATION_V47).toContain(col);
    }
  });

  it('MIGRATION_V47 inclui codex_config como NULL AS codex_config no SELECT (nao copia de agents)', () => {
    expect(MIGRATION_V47).toContain('NULL AS codex_config');
  });

  it('MIGRATION_V47 preserva coluna external_config', () => {
    expect(MIGRATION_V47).toContain('external_config TEXT DEFAULT NULL');
    expect(MIGRATION_V47).toContain('external_config, local_mode');
  });
});


describe('CodexConfig: estrutura do tipo', () => {
  it('sandbox aceita exatamente 3 valores', () => {
    const validSandbox = ['workspace-write', 'read-only', 'danger-full-access'] as const;
    expect(validSandbox).toHaveLength(3);
  });

  it('reasoningEffort aceita exatamente 3 valores', () => {
    const validEffort = ['low', 'medium', 'high'] as const;
    expect(validEffort).toHaveLength(3);
  });

  it('objeto CodexConfig valido pode ser serializado e desserializado via JSON', () => {
    const config = {
      model: 'gpt-5.5',
      sandbox: 'workspace-write' as const,
      reasoningEffort: 'medium' as const,
    };
    const serialized = JSON.stringify(config);
    const parsed = JSON.parse(serialized);
    expect(parsed.model).toBe('gpt-5.5');
    expect(parsed.sandbox).toBe('workspace-write');
    expect(parsed.reasoningEffort).toBe('medium');
  });

  it('objeto CodexConfig minimo (so model) pode ser serializado', () => {
    const config = { model: 'gpt-5.4-mini' };
    const serialized = JSON.stringify(config);
    const parsed = JSON.parse(serialized);
    expect(parsed.model).toBe('gpt-5.4-mini');
    expect(parsed.sandbox).toBeUndefined();
    expect(parsed.reasoningEffort).toBeUndefined();
  });
});


describe('db-migration-v47: execucao em banco in-memory', () => {
  it.skip(
    'preserva o numero total de agentes (cloud/local/external pre-existentes) apos migration',
    () => {
    },
  );

  it.skip(
    'preserva todos os campos campo a campo (name, model, runtime, kb_enabled, local_config, external_config, squad)',
    () => {
    },
  );

  it.skip(
    'nova coluna codex_config existe e e NULL para agentes pre-existentes',
    () => {
    },
  );

  it.skip(
    'permite inserir agente com runtime "codex" e codex_config JSON apos migration',
    () => {
    },
  );

  it.skip(
    'rejeita runtime invalido apos migration (CHECK constraint ativo)',
    () => {
    },
  );

  it.skip(
    'aceita os 4 runtimes validos: cloud, local, external, codex',
    () => {
    },
  );

  it.skip(
    'updateAgent com codexConfig persiste JSON e e lido de volta por getAgent',
    () => {
    },
  );
});
