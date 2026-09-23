import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import {
  ALL_SEED_AGENTS,
  BUG_AGENT_IDS,
  BUG_SEED_AGENTS,
  bugDiscovery,
  bugRootCauseAnalyst,
  bugContextHistorian,
  bugHypothesisRefuter,
  bugSolutionConsolidator,
  bugSpecValidator,
} from '../seed-agents';
import { applyMigrationV143, __V143_INTERNAL } from '../db-migrations/v143-bug-pipeline';
import { LATEST_SCHEMA_VERSION } from '../db-migration-safety';

const BUG_IDS = [
  'bug-discovery',
  'bug-root-cause-analyst',
  'bug-context-historian',
  'bug-hypothesis-refuter',
  'bug-solution-consolidator',
  'bug-spec-validator',
] as const;

const ANALYSTS = [bugRootCauseAnalyst, bugContextHistorian, bugHypothesisRefuter];
const NON_ANALYSTS = [bugDiscovery, bugSolutionConsolidator, bugSpecValidator];

const SHARED_DIR = path.join(__dirname, '..', 'seed-agents', '_shared');

const LENS_ANCHORS: { label: string; ownerId: string; needles: string[] }[] = [
  {
    label: '(a) lente historica',
    ownerId: 'bug-context-historian',
    needles: ['git blame', '## Janela de regressao'],
  },
  {
    label: '(b) lente adversarial',
    ownerId: 'bug-hypothesis-refuter',
    needles: ['## Hipotese nula', 'DERRUBADA | SOBREVIVEU | INCONCLUSIVA'],
  },
  {
    label: '(c) lente de fluxo',
    ownerId: 'bug-root-cause-analyst',
    needles: ['## Cadeia ate a origem', 'Teste de separacao'],
  },
];

const ALL_NEEDLES = LENS_ANCHORS.flatMap((a) => a.needles);

function outputFormatHeaders(systemPrompt: string): string[] {
  const start = systemPrompt.indexOf('## Formato de saida');
  expect(start).toBeGreaterThan(-1);
  const endMarker = systemPrompt.indexOf('## Regras criticas', start);
  expect(endMarker).toBeGreaterThan(start);
  return systemPrompt
    .slice(start, endMarker)
    .split('\n')
    .filter((line) => line.startsWith('## ') && line.trim() !== '## Formato de saida')
    .map((line) => line.trim());
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE harness_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      model TEXT DEFAULT 'claude-sonnet-4-6',
      allowed_tools TEXT DEFAULT '[]',
      mcp_servers TEXT DEFAULT '[]',
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      effort TEXT DEFAULT 'medium',
      thinking TEXT DEFAULT 'adaptive',
      thinking_budget INTEGER DEFAULT 0,
      max_turns INTEGER DEFAULT 80,
      skills TEXT DEFAULT '[]',
      runtime TEXT DEFAULT 'cloud',
      max_tool_rounds INTEGER DEFAULT 25,
      squad TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

interface AgentRow {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  model: string;
  allowed_tools: string;
  mcp_servers: string;
  squad: string;
  effort: string;
  thinking: string;
  thinking_budget: number;
  max_turns: number;
  max_tool_rounds: number;
  runtime: string;
}

function readBugRows(db: Database.Database): AgentRow[] {
  return db.prepare("SELECT * FROM agents WHERE id LIKE 'bug-%' ORDER BY id").all() as AgentRow[];
}

describe('B-AC2/TB-19 - os 6 seed agents do Bug Pipe no registry', () => {
  it('os 6 ids estao em ALL_SEED_AGENTS, cada um exatamente uma vez', () => {
    const ids = ALL_SEED_AGENTS.map((a) => a.id);
    for (const id of BUG_IDS) {
      expect(ids.filter((x) => x === id)).toHaveLength(1);
    }
  });

  it('BUG_AGENT_IDS e BUG_SEED_AGENTS descrevem os mesmos 6 agentes', () => {
    expect([...BUG_AGENT_IDS]).toEqual([...BUG_IDS]);
    expect(BUG_SEED_AGENTS.map((a) => a.id).sort()).toEqual([...BUG_IDS].sort());
  });

  it.each([...BUG_IDS])('%s: squad pipeline, description/systemPrompt nao-vazios e mcpServers vazio (D23)', (id) => {
    const seed = ALL_SEED_AGENTS.find((a) => a.id === id);
    expect(seed).toBeDefined();
    expect(seed!.squad).toBe('pipeline');
    expect(seed!.description.trim().length).toBeGreaterThan(0);
    expect(seed!.systemPrompt.trim().length).toBeGreaterThan(0);
    expect(seed!.mcpServers).toEqual([]);
    expect(seed!.mcpServers.length).toBe(0);
    expect(seed!.runtime).toBe('cloud');
    expect(seed!.isActive).toBe(true);
  });

  it('os 3 ANALISTAS da fase 2 NAO tem Write/Edit (quem grava e o runner)', () => {
    for (const seed of ANALYSTS) {
      expect(seed.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'Bash']);
      expect(seed.allowedTools).not.toContain('Write');
      expect(seed.allowedTools).not.toContain('Edit');
    }
  });

  it('os 3 agentes conversacionais TEM Write/Edit (escrevem o proprio artefato)', () => {
    for (const seed of NON_ANALYSTS) {
      expect(seed.allowedTools).toContain('Write');
      expect(seed.allowedTools).toContain('Edit');
    }
  });

  it('modelo/effort/thinking batem com a tabela da secao 4.3', () => {
    const expected: Record<string, { model: string; budget: number; turns: number; rounds: number }> = {
      'bug-discovery': { model: 'claude-opus-5-5', budget: 8000, turns: 80, rounds: 25 },
      'bug-root-cause-analyst': { model: 'claude-opus-5-5', budget: 10000, turns: 80, rounds: 30 },
      'bug-context-historian': { model: 'claude-opus-5-5', budget: 10000, turns: 80, rounds: 30 },
      'bug-hypothesis-refuter': { model: 'claude-opus-5-5', budget: 10000, turns: 80, rounds: 30 },
      'bug-solution-consolidator': { model: 'claude-opus-5-5', budget: 8000, turns: 100, rounds: 25 },
      'bug-spec-validator': { model: 'claude-sonnet-4-6', budget: 6000, turns: 80, rounds: 25 },
    };
    for (const seed of BUG_SEED_AGENTS) {
      const want = expected[seed.id];
      expect(want).toBeDefined();
      expect(seed.model).toBe(want!.model);
      expect(seed.effort).toBe('high');
      expect(seed.thinking).toBe('enabled');
      expect(seed.thinkingBudget).toBe(want!.budget);
      expect(seed.maxTurns).toBe(want!.turns);
      expect(seed.maxToolRounds).toBe(want!.rounds);
    }
  });

  it('regra de isolamento (AGENTS.md 14): nenhum prompt cita outro agente pelo nome/id', () => {
    const reused = [
      'spec-builder',
      'harness-planner',
      'harness-coder',
      'harness-evaluator',
      'sprint-validator',
      'spec-enricher',
    ];
    for (const seed of BUG_SEED_AGENTS) {
      const others = BUG_SEED_AGENTS.filter((o) => o.id !== seed.id);
      for (const other of others) {
        expect(seed.systemPrompt).not.toContain(other.id);
        expect(seed.systemPrompt).not.toContain(other.name);
      }
      for (const name of reused) {
        expect(seed.systemPrompt).not.toContain(name);
      }
    }
  });
});

describe('TB-8/B-AC4 - as 3 lentes sao genuinamente distintas (D11)', () => {
  it('SANIDADE: nenhuma ancora existe nos blocos compartilhados de _shared/*', () => {
    const sharedFiles = fs.readdirSync(SHARED_DIR).filter((f) => f.endsWith('.ts'));
    expect(sharedFiles.length).toBeGreaterThan(0);
    for (const file of sharedFiles) {
      const src = fs.readFileSync(path.join(SHARED_DIR, file), 'utf8');
      for (const needle of ALL_NEEDLES) {
        expect(`${file}:${needle}:${src.includes(needle)}`).toBe(`${file}:${needle}:false`);
      }
    }
  });

  it.each(LENS_ANCHORS)('$label: ancoras presentes SO no dono, entre os 3 analistas', (anchor) => {
    for (const needle of anchor.needles) {
      const owners = ANALYSTS.filter((a) => a.systemPrompt.includes(needle)).map((a) => a.id);
      expect(owners).toEqual([anchor.ownerId]);
    }
  });

  it('(d) nenhuma das 3 ancoras aparece em mais de um dos 3 systemPrompts concatenados', () => {
    for (const needle of ALL_NEEDLES) {
      const hits = ANALYSTS.filter((a) => a.systemPrompt.includes(needle));
      expect(hits).toHaveLength(1);
    }
  });

  it('(e) os 3 blocos "## Formato de saida" tem conjuntos de cabecalhos distintos', () => {
    const sets = ANALYSTS.map((a) => outputFormatHeaders(a.systemPrompt));
    for (const headers of sets) {
      expect(headers.length).toBeGreaterThan(3);
    }
    const serialized = sets.map((h) => [...h].sort().join('|'));
    expect(new Set(serialized).size).toBe(3);
    for (let i = 0; i < sets.length; i++) {
      for (let j = 0; j < sets.length; j++) {
        if (i === j) continue;
        const exclusive = sets[i]!.filter((h) => !sets[j]!.includes(h));
        expect(exclusive.length).toBeGreaterThan(0);
      }
    }
  });

  it('assert NEGATIVO: nenhuma ancora aparece nos outros 3 agentes do pipe', () => {
    for (const seed of NON_ANALYSTS) {
      for (const needle of ALL_NEEDLES) {
        expect(`${seed.id}:${needle}:${seed.systemPrompt.includes(needle)}`).toBe(`${seed.id}:${needle}:false`);
      }
    }
  });

  it('a assercao roda sobre o prompt CONCATENADO (blocos compartilhados presentes)', () => {
    for (const seed of BUG_SEED_AGENTS) {
      expect(seed.systemPrompt).toContain('## Regras criticas');
      expect(seed.systemPrompt).toContain('## Restricoes git (apenas leitura)');
      expect(seed.systemPrompt).toContain('## Idioma');
    }
  });
});

describe('TB-30 - R10: os 6 seeds existem no .ts E na V143', () => {
  it('a V143 insere exatamente os 6 ids do registry', () => {
    const db = makeDb();
    applyMigrationV143(db);
    const rows = readBugRows(db);
    expect(rows.map((r) => r.id)).toEqual([...BUG_IDS].sort());
    db.close();
  });

  it('o systemPrompt inserido e IDENTICO ao do .ts (a migration importa o seed)', () => {
    const db = makeDb();
    applyMigrationV143(db);
    const rows = readBugRows(db);
    for (const seed of BUG_SEED_AGENTS) {
      const row = rows.find((r) => r.id === seed.id);
      expect(row).toBeDefined();
      expect(row!.system_prompt).toBe(seed.systemPrompt);
      expect(row!.description).toBe(seed.description);
      expect(row!.name).toBe(seed.name);
      expect(row!.model).toBe(seed.model);
      expect(row!.squad).toBe('pipeline');
      expect(row!.mcp_servers).toBe('[]');
      expect(row!.allowed_tools).toBe(JSON.stringify(seed.allowedTools));
      expect(row!.effort).toBe(seed.effort);
      expect(row!.thinking).toBe(seed.thinking);
      expect(row!.thinking_budget).toBe(seed.thinkingBudget);
      expect(row!.max_turns).toBe(seed.maxTurns);
      expect(row!.max_tool_rounds).toBe(seed.maxToolRounds);
      expect(row!.runtime).toBe(seed.runtime);
    }
    db.close();
  });

  it('a lista da migration e a MESMA referencia do registry (sem copia paralela)', () => {
    const migrationSeeds = [...__V143_INTERNAL.BUG_PIPELINE_SEEDS];
    expect(migrationSeeds).toHaveLength(6);
    for (const seed of migrationSeeds) {
      expect(BUG_SEED_AGENTS).toContain(seed);
    }
  });
});

describe('TB-29 - V143 aplica em DB existente e e idempotente', () => {
  it('LATEST_SCHEMA_VERSION acompanha a maior migration (>= 143, hoje 153)', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(143);
    expect(LATEST_SCHEMA_VERSION).toBe(153);
  });

  it('a V143 esta plugada no runner de db.ts (import + gate + INSERT da versao)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'db.ts'), 'utf8');
    expect(source).toContain("import { applyMigrationV143 } from './db-migrations/v143-bug-pipeline'");
    expect(source).toContain('if (currentVersion < 143) {');
    expect(source).toContain('applyMigrationV143(db);');
    expect(source).toContain("VALUES (?)').run(143)");
  });

  it('aplica em DB EXISTENTE (com agents ja populados) sem lancar', () => {
    const db = makeDb();
    db.prepare('INSERT INTO agents (id, name, description, system_prompt, squad) VALUES (?, ?, ?, ?, ?)').run(
      'harness-coder',
      'Harness Coder',
      'legado',
      'prompt legado',
      'harness',
    );
    expect(() => applyMigrationV143(db)).not.toThrow();
    expect(readBugRows(db)).toHaveLength(6);
    const legacy = db.prepare("SELECT system_prompt FROM agents WHERE id = 'harness-coder'").get() as {
      system_prompt: string;
    };
    expect(legacy.system_prompt).toBe('prompt legado');
    db.close();
  });

  it('INSERT OR IGNORE: customizacao do usuario num id bug-* sobrevive', () => {
    const db = makeDb();
    db.prepare('INSERT INTO agents (id, name, description, system_prompt, squad) VALUES (?, ?, ?, ?, ?)').run(
      'bug-discovery',
      'Meu Discovery',
      'custom',
      'PROMPT CUSTOMIZADO',
      'pipeline',
    );
    applyMigrationV143(db);
    const row = db.prepare("SELECT * FROM agents WHERE id = 'bug-discovery'").get() as AgentRow;
    expect(row.system_prompt).toBe('PROMPT CUSTOMIZADO');
    expect(row.name).toBe('Meu Discovery');
    expect(readBugRows(db)).toHaveLength(6);
    db.close();
  });

  it('e idempotente: rodar de novo nao duplica nem muda nada', () => {
    const db = makeDb();
    applyMigrationV143(db);
    const before = readBugRows(db);
    expect(() => applyMigrationV143(db)).not.toThrow();
    const after = readBugRows(db);
    expect(after).toEqual(before);
    expect(after).toHaveLength(6);
    db.close();
  });

  it('cria bug_analysis_agent_status com as colunas da secao 4.7.1 (a)', () => {
    const db = makeDb();
    applyMigrationV143(db);
    const cols = (db.prepare('PRAGMA table_info(bug_analysis_agent_status)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual([
      'id',
      'project_id',
      'run_id',
      'agent_id',
      'agent_name',
      'agent_slug',
      'status',
      'output_file',
      'started_at',
      'completed_at',
      'error_message',
      'created_at',
    ]);
    expect(cols).not.toContain('findings_count');
    db.close();
  });

  it('cria o index por project_id E o UNIQUE (project_id, run_id, agent_id)', () => {
    const db = makeDb();
    applyMigrationV143(db);
    const indexes = db.prepare('PRAGMA index_list(bug_analysis_agent_status)').all() as {
      name: string;
      unique: number;
    }[];
    const byName = new Map(indexes.map((i) => [i.name, i]));
    expect(byName.has('idx_bug_analysis_agent_status_project')).toBe(true);
    expect(byName.get('idx_bug_analysis_agent_status_project')!.unique).toBe(0);
    const unique = byName.get('idx_bug_analysis_agent_run_agent');
    expect(unique).toBeDefined();
    expect(unique!.unique).toBe(1);
    const uniqueCols = (
      db.prepare("PRAGMA index_info('idx_bug_analysis_agent_run_agent')").all() as { name: string }[]
    ).map((c) => c.name);
    expect(uniqueCols).toEqual(['project_id', 'run_id', 'agent_id']);
    db.close();
  });

  it('o UNIQUE de fato impede acumulo: re-enfileirar os 3 analistas nao duplica', () => {
    const db = makeDb();
    applyMigrationV143(db);
    db.prepare('INSERT INTO harness_projects (id, name) VALUES (?, ?)').run('p1', 'Projeto');
    const insert = db.prepare(`
      INSERT OR IGNORE INTO bug_analysis_agent_status
        (project_id, run_id, agent_id, agent_name, agent_slug)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (let round = 0; round < 2; round++) {
      for (const seed of ANALYSTS) {
        insert.run('p1', 'run-1', seed.id, seed.name, seed.id.replace(/^bug-/, ''));
      }
    }
    const count = db.prepare("SELECT COUNT(*) AS n FROM bug_analysis_agent_status WHERE project_id = 'p1'").get() as {
      n: number;
    };
    expect(count.n).toBe(3);
    for (const seed of ANALYSTS) {
      insert.run('p1', 'run-2', seed.id, seed.name, seed.id.replace(/^bug-/, ''));
    }
    const after = db.prepare("SELECT COUNT(*) AS n FROM bug_analysis_agent_status WHERE project_id = 'p1'").get() as {
      n: number;
    };
    expect(after.n).toBe(6);
    db.close();
  });

  it('a DDL da tabela e IF NOT EXISTS (rerun em DB que ja tem a tabela nao lanca)', () => {
    const db = makeDb();
    applyMigrationV143(db);
    expect(() => applyMigrationV143(db)).not.toThrow();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .all('bug_analysis_agent_status') as { name: string }[];
    expect(tables).toHaveLength(1);
    db.close();
  });
});
