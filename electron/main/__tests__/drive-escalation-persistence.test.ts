import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ home: '' }));

vi.mock('../paths', () => ({
  getLionClawHome: () => state.home,
}));

vi.mock('../logger', () => {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
  return { createLogger: () => logger, rootLogger: logger };
});

vi.mock('better-sqlite3', () => {
  class FakeDatabase {
    private readonly sqlite: DatabaseSync;
    private seq = 0;

    constructor(filename: string) {
      this.sqlite = new DatabaseSync(filename);
      this.prepare = this.sqlite.prepare.bind(this.sqlite);
      this.exec = this.sqlite.exec.bind(this.sqlite);
    }

    prepare: DatabaseSync['prepare'];
    exec: DatabaseSync['exec'];

    pragma(source: string): unknown[] {
      return this.sqlite.prepare(`PRAGMA ${source}`).all();
    }

    transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
      return (...args: unknown[]) => {
        const savepoint = `test_tx_${++this.seq}`;
        this.sqlite.exec(`SAVEPOINT ${savepoint}`);
        try {
          const result = fn(...args);
          this.sqlite.exec(`RELEASE ${savepoint}`);
          return result;
        } catch (error) {
          this.sqlite.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
          throw error;
        }
      };
    }

    close(): void {
      this.sqlite.close();
    }
  }
  return { default: FakeDatabase };
});

import { getDb, getDriveState, initDatabase, insertHarnessProject, setDriveState } from '../db';
import { applyMigrationV156 } from '../db-migrations/v156-drive-session-column';

const HARNESS_PROJECTS_DDL = `
  CREATE TABLE harness_projects (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT NOT NULL,
    description TEXT,
    project_path TEXT NOT NULL,
    spec_path TEXT NOT NULL,
    sprints_json_path TEXT,
    status TEXT NOT NULL DEFAULT 'planning'
      CHECK (status IN ('planning', 'reviewing', 'ready', 'running', 'paused', 'done', 'failed')),
    config TEXT NOT NULL DEFAULT '{}',
    current_sprint_index INTEGER DEFAULT -1,
    total_sprints INTEGER DEFAULT 0,
    total_features INTEGER DEFAULT 0,
    pipeline_type TEXT DEFAULT 'development',
    pipeline_docs_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const ESCALATION = 'Posso aplicar a migration destrutiva na fase 12?';

function newProject(name: string): string {
  return insertHarnessProject({
    name,
    projectPath: path.join(state.home, 'repo'),
    specPath: path.join(state.home, 'repo', 'spec.md'),
    config: {
      maxRoundsPerSprint: 1,
      usePlaywright: false,
      evaluatorAgentId: 'harness-evaluator',
      plannerAgentId: 'harness-planner',
      stack: [],
    },
  }).id;
}

function rawConfigDrive(projectId: string): Record<string, unknown> {
  const row = getDb().prepare('SELECT config FROM harness_projects WHERE id = ?').get(projectId) as { config: string };
  return (JSON.parse(row.config) as { drive?: Record<string, unknown> }).drive ?? {};
}

function engage(projectId: string, sessionId: string): void {
  setDriveState(projectId, {
    driver: 'orchestrator',
    status: 'driving',
    handoff: 'none',
    mode: 'semi',
    sessionId,
    requiresHumanPhases: [12],
    startedAt: '2026-09-17T09:00:00.000Z',
  });
}

beforeAll(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-drive-escalation-'));
  initDatabase({
    prepareSafety: () => ({ currentVersion: 0, backupPath: null, markerPath: null }),
    runMigrations: () => {
      const database = getDb();
      database.exec(HARNESS_PROJECTS_DDL);
      applyMigrationV156(database);
    },
    loadSqliteVec: () => {
      throw new Error('sqlite-vec desligado no teste');
    },
    repairVecSchema: () => {},
  });
});

afterAll(() => {
  try {
    getDb().close();
  } catch {
    // banco ja fechado
  }
  try {
    fs.rmSync(state.home, { recursive: true, force: true });
  } catch {
    // limpeza best-effort
  }
});

beforeEach(() => {
  getDb().exec('DELETE FROM harness_projects');
});

describe('setDriveState - lastEscalation persistido', () => {
  it('grava a pergunta escalada no config.drive e devolve no getDriveState', () => {
    const projectId = newProject('grava escalacao');
    engage(projectId, 'sess_1');

    const merged = setDriveState(projectId, {
      status: 'awaiting-human',
      lastEscalation: ESCALATION,
    });

    expect(merged.lastEscalation).toBe(ESCALATION);
    expect(rawConfigDrive(projectId)['lastEscalation']).toBe(ESCALATION);
    expect(getDriveState(projectId)?.lastEscalation).toBe(ESCALATION);
  });

  it('patch de status sem a chave preserva a escalacao gravada', () => {
    const projectId = newProject('preserva em status');
    engage(projectId, 'sess_1');
    setDriveState(projectId, { status: 'awaiting-human', lastEscalation: ESCALATION });

    const merged = setDriveState(projectId, { status: 'driving' });

    expect(merged.lastEscalation).toBe(ESCALATION);
    expect(merged.status).toBe('driving');
    expect(rawConfigDrive(projectId)['lastEscalation']).toBe(ESCALATION);
    expect(getDriveState(projectId)?.lastEscalation).toBe(ESCALATION);
  });

  it('patch de sessionId (re-bind pos-Clear) preserva a escalacao gravada', () => {
    const projectId = newProject('preserva em rebind');
    engage(projectId, 'sess_1');
    setDriveState(projectId, { status: 'awaiting-human', lastEscalation: ESCALATION });

    const merged = setDriveState(projectId, { sessionId: 'sess_2', rebindFrom: 'sess_1' });

    expect(merged.sessionId).toBe('sess_2');
    expect(merged.lastEscalation).toBe(ESCALATION);
    expect(getDriveState(projectId)?.lastEscalation).toBe(ESCALATION);
  });

  it('chave explicita com undefined remove o campo do banco', () => {
    const projectId = newProject('remove escalacao');
    engage(projectId, 'sess_1');
    setDriveState(projectId, { status: 'awaiting-human', lastEscalation: ESCALATION });
    expect(rawConfigDrive(projectId)['lastEscalation']).toBe(ESCALATION);

    setDriveState(projectId, { status: 'driving', lastEscalation: undefined });

    expect('lastEscalation' in rawConfigDrive(projectId)).toBe(false);
    expect(getDriveState(projectId)?.lastEscalation).toBeUndefined();
    expect(getDriveState(projectId)?.status).toBe('driving');
  });

  it('a remocao nao derruba os demais campos aditivos do drive', () => {
    const projectId = newProject('remocao cirurgica');
    engage(projectId, 'sess_1');
    setDriveState(projectId, {
      status: 'awaiting-human',
      lastEscalation: ESCALATION,
      stoppedReason: 'handoff_semi',
    });

    setDriveState(projectId, { lastEscalation: undefined });

    const reread = getDriveState(projectId);
    expect(reread?.lastEscalation).toBeUndefined();
    expect(reread?.stoppedReason).toBe('handoff_semi');
    expect(reread?.startedAt).toBe('2026-09-17T09:00:00.000Z');
    expect(reread?.requiresHumanPhases).toEqual([12]);
    expect(reread?.sessionId).toBe('sess_1');
  });

  it('projeto sem escalacao nunca ganha a chave no banco', () => {
    const projectId = newProject('sem escalacao');
    engage(projectId, 'sess_1');

    setDriveState(projectId, { status: 'awaiting-human' });

    expect('lastEscalation' in rawConfigDrive(projectId)).toBe(false);
    expect(getDriveState(projectId)?.lastEscalation).toBeUndefined();
  });
});
