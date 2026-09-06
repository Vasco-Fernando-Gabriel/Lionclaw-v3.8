
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';


const MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK = `
  CREATE TABLE harness_projects_v48 (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT NOT NULL,
    description TEXT,
    project_path TEXT NOT NULL,
    spec_path TEXT NOT NULL,
    sprints_json_path TEXT,
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK (status IN (
        'idle', 'planning', 'reviewing', 'ready',
        'running', 'paused', 'done', 'failed',
        'aborted', 'interrupted'
      )),
    config TEXT NOT NULL DEFAULT '{}',
    current_sprint_index INTEGER DEFAULT -1,
    total_sprints INTEGER DEFAULT 0,
    total_features INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    planner_input_tokens INTEGER DEFAULT 0,
    planner_output_tokens INTEGER DEFAULT 0,
    planner_cache_tokens INTEGER DEFAULT 0,
    planner_cost_usd REAL DEFAULT 0,
    planner_duration_ms INTEGER DEFAULT 0,
    pipeline_start_phase INTEGER DEFAULT NULL,
    pipeline_current_phase INTEGER DEFAULT NULL,
    discovery_notes_path TEXT DEFAULT NULL,
    prd_path TEXT DEFAULT NULL,
    pipeline_sprint_index INTEGER DEFAULT 0,
    pipeline_discovery_block INTEGER DEFAULT 1,
    pipeline_type TEXT NOT NULL DEFAULT 'development',
    security_summary_json TEXT DEFAULT NULL,
    pipeline_docs_id TEXT DEFAULT NULL
  );

  INSERT INTO harness_projects_v48
    SELECT
      id, name, description, project_path, spec_path, sprints_json_path,
      status, config, current_sprint_index, total_sprints, total_features,
      created_at, updated_at,
      planner_input_tokens, planner_output_tokens, planner_cache_tokens,
      planner_cost_usd, planner_duration_ms,
      pipeline_start_phase, pipeline_current_phase,
      discovery_notes_path, prd_path,
      pipeline_sprint_index, pipeline_discovery_block,
      pipeline_type, security_summary_json, pipeline_docs_id
    FROM harness_projects;

  DROP TABLE harness_projects;
  ALTER TABLE harness_projects_v48 RENAME TO harness_projects;

  CREATE INDEX IF NOT EXISTS idx_harness_projects_status ON harness_projects(status);
  CREATE INDEX IF NOT EXISTS idx_harness_projects_pipeline_type ON harness_projects(pipeline_type);
`;

const SCHEMA_PRE_V48 = `
  CREATE TABLE harness_projects (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT NOT NULL,
    description TEXT,
    project_path TEXT NOT NULL,
    spec_path TEXT NOT NULL,
    sprints_json_path TEXT,
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK (status IN ('idle', 'planning', 'reviewing', 'ready', 'running', 'paused', 'done', 'failed')),
    config TEXT NOT NULL DEFAULT '{}',
    current_sprint_index INTEGER DEFAULT -1,
    total_sprints INTEGER DEFAULT 0,
    total_features INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    planner_input_tokens INTEGER DEFAULT 0,
    planner_output_tokens INTEGER DEFAULT 0,
    planner_cache_tokens INTEGER DEFAULT 0,
    planner_cost_usd REAL DEFAULT 0,
    planner_duration_ms INTEGER DEFAULT 0,
    pipeline_start_phase INTEGER DEFAULT NULL,
    pipeline_current_phase INTEGER DEFAULT NULL,
    discovery_notes_path TEXT DEFAULT NULL,
    prd_path TEXT DEFAULT NULL,
    pipeline_sprint_index INTEGER DEFAULT 0,
    pipeline_discovery_block INTEGER DEFAULT 1,
    pipeline_type TEXT NOT NULL DEFAULT 'development',
    security_summary_json TEXT DEFAULT NULL,
    pipeline_docs_id TEXT DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_harness_projects_status ON harness_projects(status);
  CREATE INDEX IF NOT EXISTS idx_harness_projects_pipeline_type ON harness_projects(pipeline_type);
`;

function applyV48(db: Database.Database): void {
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}


describe('db-migration-v48: analise estrutural do SQL', () => {
  it('CHECK constraint inclui os 8 status pre-V48', () => {
    const preV48 = ['idle', 'planning', 'reviewing', 'ready', 'running', 'paused', 'done', 'failed'];
    for (const status of preV48) {
      expect(MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK).toContain(`'${status}'`);
    }
  });

  it('CHECK constraint inclui os 2 status novos: aborted e interrupted', () => {
    expect(MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK).toContain("'aborted'");
    expect(MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK).toContain("'interrupted'");
  });

  it('CHECK constraint aceita exatamente 10 status', () => {
    const match = MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK.match(
      /CHECK \(status IN \(([\s\S]*?)\)\)/,
    );
    expect(match).not.toBeNull();
    const statuses = match![1]
      .split(',')
      .map((s) => s.trim().replace(/['\s]/g, ''))
      .filter((s) => s.length > 0);
    expect(statuses).toHaveLength(10);
    expect(statuses.sort()).toEqual([
      'aborted',
      'done',
      'failed',
      'idle',
      'interrupted',
      'paused',
      'planning',
      'ready',
      'reviewing',
      'running',
    ]);
  });

  it('cria tabela harness_projects_v48 e faz rename para harness_projects', () => {
    expect(MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK).toContain('CREATE TABLE harness_projects_v48');
    expect(MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK).toContain(
      'ALTER TABLE harness_projects_v48 RENAME TO harness_projects',
    );
  });

  it('faz DROP da tabela antiga antes do rename (ordem correta)', () => {
    const dropIndex = MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK.indexOf('DROP TABLE harness_projects');
    const renameIndex = MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK.indexOf(
      'ALTER TABLE harness_projects_v48 RENAME TO harness_projects',
    );
    expect(dropIndex).toBeGreaterThan(0);
    expect(renameIndex).toBeGreaterThan(dropIndex);
  });

  it('preserva TODAS as 27 colunas atuais (V37 base + V41 + V42 + V45) no SELECT', () => {
    const requiredCols = [
      'id', 'name', 'description', 'project_path', 'spec_path', 'sprints_json_path',
      'status', 'config', 'current_sprint_index', 'total_sprints', 'total_features',
      'created_at', 'updated_at',
      'planner_input_tokens', 'planner_output_tokens', 'planner_cache_tokens',
      'planner_cost_usd', 'planner_duration_ms',
      'pipeline_start_phase', 'pipeline_current_phase',
      'discovery_notes_path', 'prd_path',
      'pipeline_sprint_index', 'pipeline_discovery_block',
      'pipeline_type',
      'security_summary_json',
      'pipeline_docs_id',
    ];
    for (const col of requiredCols) {
      expect(MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK).toContain(col);
    }
    expect(requiredCols).toHaveLength(27);
  });

  it('SELECT lista 27 colunas distintas (preservacao 1:1)', () => {
    const selectMatch = MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK.match(
      /INSERT INTO harness_projects_v48[\s\S]*?SELECT([\s\S]*?)FROM harness_projects;/,
    );
    expect(selectMatch).not.toBeNull();
    const cols = selectMatch![1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(cols).toHaveLength(27);
  });

  it('recria indice idx_harness_projects_status', () => {
    expect(MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK).toContain(
      'CREATE INDEX IF NOT EXISTS idx_harness_projects_status ON harness_projects(status)',
    );
  });

  it('recria indice idx_harness_projects_pipeline_type', () => {
    expect(MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK).toContain(
      'CREATE INDEX IF NOT EXISTS idx_harness_projects_pipeline_type ON harness_projects(pipeline_type)',
    );
  });

  it('default do status continua sendo idle (preservacao de comportamento)', () => {
    expect(MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK).toMatch(
      /status TEXT NOT NULL DEFAULT 'idle'/,
    );
  });

  it('default de pipeline_type continua sendo development (preservacao)', () => {
    expect(MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK).toContain(
      "pipeline_type TEXT NOT NULL DEFAULT 'development'",
    );
  });
});


describe('db-migration-v48: execucao em banco in-memory', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_PRE_V48);
  });

  it('preserva o numero total de projetos pre-existentes apos migration', () => {
    const stmt = db.prepare(
      `INSERT INTO harness_projects (name, project_path, spec_path, status) VALUES (?, ?, ?, ?)`,
    );
    stmt.run('p1', '/tmp/p1', '/tmp/p1/SPEC.md', 'idle');
    stmt.run('p2', '/tmp/p2', '/tmp/p2/SPEC.md', 'planning');
    stmt.run('p3', '/tmp/p3', '/tmp/p3/SPEC.md', 'done');

    const beforeCount = (db.prepare('SELECT COUNT(*) AS c FROM harness_projects').get() as { c: number }).c;
    expect(beforeCount).toBe(3);

    applyV48(db);

    const afterCount = (db.prepare('SELECT COUNT(*) AS c FROM harness_projects').get() as { c: number }).c;
    expect(afterCount).toBe(3);

    const rows = db
      .prepare(`SELECT name, project_path, spec_path, status FROM harness_projects ORDER BY name`)
      .all() as Array<{ name: string; project_path: string; spec_path: string; status: string }>;
    expect(rows).toEqual([
      { name: 'p1', project_path: '/tmp/p1', spec_path: '/tmp/p1/SPEC.md', status: 'idle' },
      { name: 'p2', project_path: '/tmp/p2', spec_path: '/tmp/p2/SPEC.md', status: 'planning' },
      { name: 'p3', project_path: '/tmp/p3', spec_path: '/tmp/p3/SPEC.md', status: 'done' },
    ]);
  });

  it('aceita inserir projeto com status="aborted" pos-migration', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO harness_projects (name, project_path, spec_path, status) VALUES (?, ?, ?, ?)`,
      ).run('pre', '/tmp/pre', '/tmp/pre/SPEC.md', 'aborted');
    }).toThrow(/CHECK constraint/);

    applyV48(db);

    expect(() => {
      db.prepare(
        `INSERT INTO harness_projects (name, project_path, spec_path, status) VALUES (?, ?, ?, ?)`,
      ).run('post', '/tmp/post', '/tmp/post/SPEC.md', 'aborted');
    }).not.toThrow();

    const row = db
      .prepare(`SELECT status FROM harness_projects WHERE name = 'post'`)
      .get() as { status: string };
    expect(row.status).toBe('aborted');
  });

  it('aceita inserir projeto com status="interrupted" pos-migration', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO harness_projects (name, project_path, spec_path, status) VALUES (?, ?, ?, ?)`,
      ).run('pre', '/tmp/pre', '/tmp/pre/SPEC.md', 'interrupted');
    }).toThrow(/CHECK constraint/);

    applyV48(db);

    expect(() => {
      db.prepare(
        `INSERT INTO harness_projects (name, project_path, spec_path, status) VALUES (?, ?, ?, ?)`,
      ).run('post', '/tmp/post', '/tmp/post/SPEC.md', 'interrupted');
    }).not.toThrow();

    const row = db
      .prepare(`SELECT status FROM harness_projects WHERE name = 'post'`)
      .get() as { status: string };
    expect(row.status).toBe('interrupted');
  });

  it('rejeita status invalido pos-migration (CHECK ainda ativo)', () => {
    applyV48(db);
    expect(() => {
      db.prepare(
        `INSERT INTO harness_projects (name, project_path, spec_path, status) VALUES (?, ?, ?, ?)`,
      ).run('bad', '/tmp/bad', '/tmp/bad/SPEC.md', 'gibberish');
    }).toThrow(/CHECK constraint/);
  });

  it('aceita os 10 status validos pos-V48', () => {
    applyV48(db);
    const valid = [
      'idle', 'planning', 'reviewing', 'ready',
      'running', 'paused', 'done', 'failed',
      'aborted', 'interrupted',
    ];
    const insertStmt = db.prepare(
      `INSERT INTO harness_projects (name, project_path, spec_path, status) VALUES (?, ?, ?, ?)`,
    );
    for (const status of valid) {
      expect(() => {
        insertStmt.run(`p_${status}`, `/tmp/${status}`, `/tmp/${status}/SPEC.md`, status);
      }).not.toThrow();
    }
    const rows = db.prepare(`SELECT status FROM harness_projects`).all() as Array<{ status: string }>;
    expect(rows.map((r) => r.status).sort()).toEqual(valid.slice().sort());
  });

  it('indice idx_harness_projects_pipeline_type existe pos-migration', () => {
    applyV48(db);
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='harness_projects' AND name='idx_harness_projects_pipeline_type'`,
      )
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe('idx_harness_projects_pipeline_type');

    const statusIdx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='harness_projects' AND name='idx_harness_projects_status'`,
      )
      .get() as { name: string } | undefined;
    expect(statusIdx).toBeDefined();
    expect(statusIdx!.name).toBe('idx_harness_projects_status');
  });
});
