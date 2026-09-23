import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  ensureHarnessProjectStatusCheckExpanded,
  getHarnessProjectsCreateSql,
  harnessProjectStatusCheckSupportsTerminalStates,
} from '../db';

const DB_TS_PATH = path.resolve(__dirname, '..', 'db.ts');
const DB_TS_CONTENT = fs.readFileSync(DB_TS_PATH, 'utf-8');

const CREATE_TABLE_V47_SCHEMA = `CREATE TABLE harness_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN (
      'idle', 'planning', 'reviewing', 'ready',
      'running', 'paused', 'done', 'failed'
    ))
)`;

const CREATE_TABLE_V48_EXPANDED_SCHEMA = `CREATE TABLE harness_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN (
      'idle', 'planning', 'reviewing', 'ready',
      'running', 'paused', 'done', 'failed',
      'aborted', 'interrupted'
    ))
)`;

function checkSupportsTerminalStates(sql: string | null): boolean {
  if (!sql) return false;
  return sql.includes("'aborted'") && sql.includes("'interrupted'");
}

describe('P1.6 helpers: existencia e assinatura em db.ts', () => {
  it('getHarnessProjectsCreateSql esta declarado em db.ts', () => {
    expect(DB_TS_CONTENT).toMatch(
      /function getHarnessProjectsCreateSql\(\s*database:\s*Database\.Database\s*\)\s*:\s*string\s*\|\s*null/,
    );
  });

  it('getHarnessProjectsCreateSql consulta sqlite_master por harness_projects', () => {
    expect(DB_TS_CONTENT).toContain("SELECT sql FROM sqlite_master WHERE type='table' AND name='harness_projects'");
  });

  it('harnessProjectStatusCheckSupportsTerminalStates esta declarado em db.ts', () => {
    expect(DB_TS_CONTENT).toMatch(
      /function harnessProjectStatusCheckSupportsTerminalStates\(\s*database:\s*Database\.Database\s*\)\s*:\s*boolean/,
    );
  });

  it('harnessProjectStatusCheckSupportsTerminalStates checa por aborted E interrupted', () => {
    const fnMatch = DB_TS_CONTENT.match(/function harnessProjectStatusCheckSupportsTerminalStates[\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];
    expect(fnBody).toContain(`"'aborted'"`);
    expect(fnBody).toContain(`"'interrupted'"`);
  });

  it('ensureHarnessProjectStatusCheckExpanded esta declarado em db.ts', () => {
    expect(DB_TS_CONTENT).toMatch(
      /function ensureHarnessProjectStatusCheckExpanded\(\s*database:\s*Database\.Database\s*\)\s*:\s*void/,
    );
  });

  it('ensureHarnessProjectStatusCheckExpanded faz early-return se ja suporta terminal states', () => {
    const fnMatch = DB_TS_CONTENT.match(/function ensureHarnessProjectStatusCheckExpanded[\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];
    expect(fnBody).toMatch(/if \(harnessProjectStatusCheckSupportsTerminalStates\(database\)\) return/);
  });

  it('ensureHarnessProjectStatusCheckExpanded faz early-return se a tabela nao existir', () => {
    const fnMatch = DB_TS_CONTENT.match(/function ensureHarnessProjectStatusCheckExpanded[\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];
    expect(fnBody).toMatch(/if \(getHarnessProjectsCreateSql\(database\) === null\) return/);
  });

  it('ensureHarnessProjectStatusCheckExpanded executa MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK', () => {
    const fnMatch = DB_TS_CONTENT.match(/function ensureHarnessProjectStatusCheckExpanded[\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];
    expect(fnBody).toContain('MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK');
    expect(fnBody).toContain('database.exec(MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK)');
  });

  it('ensureHarnessProjectStatusCheckExpanded usa FK off / on com try-finally', () => {
    const fnMatch = DB_TS_CONTENT.match(/function ensureHarnessProjectStatusCheckExpanded[\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];
    expect(fnBody).toContain("database.pragma('foreign_keys = OFF')");
    expect(fnBody).toContain("database.pragma('foreign_keys = ON')");
    expect(fnBody).toMatch(/finally\s*\{[\s\S]*foreign_keys = ON/);
  });

  it('ensureHarnessProjectStatusCheckExpanded NAO mexe em schema_version', () => {
    const fnMatch = DB_TS_CONTENT.match(/function ensureHarnessProjectStatusCheckExpanded[\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];
    expect(fnBody).not.toContain('schema_version');
  });
});

describe('P1.6: integracao no fluxo de runMigrations', () => {
  it('runMigrations chama ensureHarnessProjectStatusCheckExpanded antes do bumpa V48', () => {
    expect(DB_TS_CONTENT).toMatch(
      /ensureHarnessProjectStatusCheckExpanded\(db\);[\s\S]{0,300}if \(currentVersion < 48\)/,
    );
  });

  it('bumpa de schema_version V48 continua condicional em currentVersion < 48', () => {
    expect(DB_TS_CONTENT).toMatch(
      /if \(currentVersion < 48\) \{[\s\S]*?INSERT INTO schema_version \(version\) VALUES \(\?\)'\)\.run\(48\);/,
    );
  });

  it('bloco antigo (FK off + exec MIGRATION_V48 + FK on direto no if) foi removido', () => {
    const blockMatch = DB_TS_CONTENT.match(/if \(currentVersion < 48\) \{([\s\S]*?)\n  \}/);
    expect(blockMatch).not.toBeNull();
    const blockBody = blockMatch![1];
    expect(blockBody).not.toContain('MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK');
    expect(blockBody).not.toContain('foreign_keys = OFF');
    expect(blockBody).not.toContain('foreign_keys = ON');
  });
});

describe('harnessProjectStatusCheckSupportsTerminalStates: logica via mirror', () => {
  it('retorna false quando tabela nao existe (sql == null)', () => {
    expect(checkSupportsTerminalStates(null)).toBe(false);
  });

  it('retorna false quando CHECK nao tem aborted', () => {
    const sqlSemAborted = `CREATE TABLE harness_projects (
      status TEXT NOT NULL DEFAULT 'idle'
        CHECK (status IN ('idle', 'running', 'interrupted'))
    )`;
    expect(checkSupportsTerminalStates(sqlSemAborted)).toBe(false);
  });

  it('retorna false quando CHECK nao tem interrupted', () => {
    const sqlSemInterrupted = `CREATE TABLE harness_projects (
      status TEXT NOT NULL DEFAULT 'idle'
        CHECK (status IN ('idle', 'running', 'aborted'))
    )`;
    expect(checkSupportsTerminalStates(sqlSemInterrupted)).toBe(false);
  });

  it('retorna false em schema V47 (sem nenhum dos dois)', () => {
    expect(checkSupportsTerminalStates(CREATE_TABLE_V47_SCHEMA)).toBe(false);
  });

  it('retorna true quando CHECK tem ambos aborted e interrupted', () => {
    expect(checkSupportsTerminalStates(CREATE_TABLE_V48_EXPANDED_SCHEMA)).toBe(true);
  });

  it('retorna true mesmo se a ordem dos status for outra', () => {
    const reordered = `CREATE TABLE harness_projects (
      status TEXT NOT NULL DEFAULT 'idle'
        CHECK (status IN ('aborted', 'idle', 'interrupted', 'running'))
    )`;
    expect(checkSupportsTerminalStates(reordered)).toBe(true);
  });
});

describe('P1.6 cenarios (a, b, c, d): contrato de transicoes', () => {
  it('cenario a: schema V47 (CHECK sem aborted/interrupted) -> aplicar migration', () => {
    const sqlPre = CREATE_TABLE_V47_SCHEMA;
    expect(checkSupportsTerminalStates(sqlPre)).toBe(false);
    expect(sqlPre).not.toContain("'aborted'");
    expect(sqlPre).not.toContain("'interrupted'");

    const sqlPos = CREATE_TABLE_V48_EXPANDED_SCHEMA;
    expect(checkSupportsTerminalStates(sqlPos)).toBe(true);
  });

  it('cenario b: CHECK ja expandido (upgrade externo) -> no-op', () => {
    const sqlPre = CREATE_TABLE_V48_EXPANDED_SCHEMA;
    expect(checkSupportsTerminalStates(sqlPre)).toBe(true);
    const sqlPos = sqlPre;
    expect(sqlPos).toBe(sqlPre);
  });

  it('cenario c: schema_version>=48 (drift) mas CHECK sem aborted/interrupted -> aplicar migration', () => {
    const sqlPre = CREATE_TABLE_V47_SCHEMA;
    expect(checkSupportsTerminalStates(sqlPre)).toBe(false);

    const sqlPos = CREATE_TABLE_V48_EXPANDED_SCHEMA;
    expect(checkSupportsTerminalStates(sqlPos)).toBe(true);
    const fnMatch = DB_TS_CONTENT.match(/function ensureHarnessProjectStatusCheckExpanded[\s\S]*?\n\}/);
    expect(fnMatch![0]).not.toContain('schema_version');
  });

  it('cenario d: schema_version>=48 + CHECK correto -> no-op total', () => {
    const sqlPre = CREATE_TABLE_V48_EXPANDED_SCHEMA;
    expect(checkSupportsTerminalStates(sqlPre)).toBe(true);
    const sqlPos = sqlPre;
    expect(sqlPos).toBe(sqlPre);
  });
});

describe('P1.6: MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK NAO foi alterada', () => {
  it('a const MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK ainda existe em db.ts', () => {
    expect(DB_TS_CONTENT).toContain('const MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK = `');
  });

  it('a const ainda inclui aborted e interrupted no CHECK', () => {
    const constMatch = DB_TS_CONTENT.match(/const MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK = `([\s\S]*?)`;/);
    expect(constMatch).not.toBeNull();
    const sql = constMatch![1];
    expect(sql).toContain("'aborted'");
    expect(sql).toContain("'interrupted'");
  });

  it('a const ainda recria os indices status e pipeline_type', () => {
    const constMatch = DB_TS_CONTENT.match(/const MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK = `([\s\S]*?)`;/);
    expect(constMatch).not.toBeNull();
    const sql = constMatch![1];
    expect(sql).toContain('idx_harness_projects_status');
    expect(sql).toContain('idx_harness_projects_pipeline_type');
  });
});

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
`;

const SCHEMA_V48_EXPANDED = `
  CREATE TABLE harness_projects (
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
`;

function setupSchemaVersion(db: Database.Database, version: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
}

describe('ensureHarnessProjectStatusCheckExpanded: execucao em banco in-memory', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('cenario a: DB antigo (schema_version<48) + CHECK sem aborted/interrupted aplica migration', () => {
    db.exec(SCHEMA_PRE_V48);
    setupSchemaVersion(db, 47);

    const insert = db.prepare(
      `INSERT INTO harness_projects (name, project_path, spec_path, status) VALUES (?, ?, ?, ?)`,
    );
    insert.run('p1', '/tmp/p1', '/tmp/p1/SPEC.md', 'idle');
    insert.run('p2', '/tmp/p2', '/tmp/p2/SPEC.md', 'running');

    expect(harnessProjectStatusCheckSupportsTerminalStates(db)).toBe(false);

    ensureHarnessProjectStatusCheckExpanded(db);

    expect(harnessProjectStatusCheckSupportsTerminalStates(db)).toBe(true);
    const sql = getHarnessProjectsCreateSql(db);
    expect(sql).toContain("'aborted'");
    expect(sql).toContain("'interrupted'");

    expect(() => {
      insert.run('p3', '/tmp/p3', '/tmp/p3/SPEC.md', 'aborted');
    }).not.toThrow();
    expect(() => {
      insert.run('p4', '/tmp/p4', '/tmp/p4/SPEC.md', 'interrupted');
    }).not.toThrow();

    const count = (db.prepare('SELECT COUNT(*) AS c FROM harness_projects').get() as { c: number }).c;
    expect(count).toBe(4);
    const p1 = db.prepare(`SELECT status FROM harness_projects WHERE name='p1'`).get() as { status: string };
    expect(p1.status).toBe('idle');
  });

  it('cenario b: DB antigo (schema_version<48) + CHECK ja expandido (upgrade externo) eh no-op', () => {
    db.exec(SCHEMA_V48_EXPANDED);
    setupSchemaVersion(db, 47);

    const sqlBefore = getHarnessProjectsCreateSql(db);
    expect(harnessProjectStatusCheckSupportsTerminalStates(db)).toBe(true);

    ensureHarnessProjectStatusCheckExpanded(db);

    const sqlAfter = getHarnessProjectsCreateSql(db);
    expect(sqlAfter).toBe(sqlBefore);
  });

  it('cenario c: DB schema_version>=48 mas CHECK sem aborted/interrupted aplica migration (drift)', () => {
    db.exec(SCHEMA_PRE_V48);
    setupSchemaVersion(db, 49);

    expect(harnessProjectStatusCheckSupportsTerminalStates(db)).toBe(false);
    const versionBefore = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    expect(versionBefore).toBe(49);

    ensureHarnessProjectStatusCheckExpanded(db);

    expect(harnessProjectStatusCheckSupportsTerminalStates(db)).toBe(true);
    const versionAfter = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    expect(versionAfter).toBe(49);

    expect(() => {
      db.prepare(`INSERT INTO harness_projects (name, project_path, spec_path, status) VALUES (?, ?, ?, ?)`).run(
        'p1',
        '/tmp/p1',
        '/tmp/p1/SPEC.md',
        'aborted',
      );
    }).not.toThrow();
  });

  it('cenario d: DB schema_version>=48 + CHECK correto eh no-op', () => {
    db.exec(SCHEMA_V48_EXPANDED);
    setupSchemaVersion(db, 49);

    const sqlBefore = getHarnessProjectsCreateSql(db);
    ensureHarnessProjectStatusCheckExpanded(db);
    const sqlAfter = getHarnessProjectsCreateSql(db);
    expect(sqlAfter).toBe(sqlBefore);
  });

  it('helper eh seguro chamar quando tabela harness_projects ainda nao existe', () => {
    expect(getHarnessProjectsCreateSql(db)).toBeNull();
    expect(() => {
      ensureHarnessProjectStatusCheckExpanded(db);
    }).not.toThrow();
    expect(getHarnessProjectsCreateSql(db)).toBeNull();
  });

  it('helper restaura foreign_keys ON mesmo se MIGRATION_V48 lancar erro', () => {
    db.exec(`
      CREATE TABLE harness_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle', 'planning', 'done'))
      );
    `);

    expect(harnessProjectStatusCheckSupportsTerminalStates(db)).toBe(false);

    expect(() => {
      ensureHarnessProjectStatusCheckExpanded(db);
    }).toThrow();

    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });
});
