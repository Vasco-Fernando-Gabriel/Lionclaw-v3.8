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

import {
  findEngagedDriveBySession,
  getDb,
  getDriveSessionId,
  getDriveState,
  initDatabase,
  insertHarnessProject,
  listHarnessProjectsBySession,
  setDriveState,
} from '../db';
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

function rawSessionColumn(projectId: string): string | null {
  const row = getDb().prepare('SELECT session_id FROM harness_projects WHERE id = ?').get(projectId) as
    { session_id: string | null } | undefined;
  return row?.session_id ?? null;
}

function rawConfigDrive(projectId: string): Record<string, unknown> | undefined {
  const row = getDb().prepare('SELECT config FROM harness_projects WHERE id = ?').get(projectId) as { config: string };
  return (JSON.parse(row.config) as { drive?: Record<string, unknown> }).drive;
}

function engage(projectId: string, sessionId: string, status: 'driving' | 'awaiting-human'): void {
  setDriveState(projectId, {
    driver: 'orchestrator',
    status,
    handoff: 'none',
    mode: 'semi',
    sessionId,
    requiresHumanPhases: [],
    startedAt: new Date().toISOString(),
  });
}

beforeAll(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-drive-session-'));
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

describe('V156 - coluna session_id como fonte da lane', () => {
  it('setDriveState grava a coluna session_id E o espelho em config.drive', () => {
    const projectId = newProject('grava coluna');

    engage(projectId, 'sess_1', 'driving');

    expect(rawSessionColumn(projectId)).toBe('sess_1');
    expect(rawConfigDrive(projectId)?.['sessionId']).toBe('sess_1');
    expect(getDriveSessionId(projectId)).toBe('sess_1');
  });

  it('getDriveState le o sessionId da COLUNA quando ela diverge do JSON', () => {
    const projectId = newProject('coluna vence');
    engage(projectId, 'sess_1', 'driving');

    getDb()
      .prepare(
        `
        UPDATE harness_projects
           SET session_id = 'sess_coluna',
               config = json_set(config, '$.drive.sessionId', 'sess_json')
         WHERE id = ?
      `,
      )
      .run(projectId);

    expect(rawConfigDrive(projectId)?.['sessionId']).toBe('sess_json');
    expect(getDriveState(projectId)?.sessionId).toBe('sess_coluna');
    expect(getDriveSessionId(projectId)).toBe('sess_coluna');
  });

  it('patch sem sessionId nao mexe na coluna e o merge preserva stoppedReason/rebindFrom', () => {
    const projectId = newProject('merge aditivo');
    engage(projectId, 'sess_1', 'driving');
    setDriveState(projectId, { stoppedReason: 'lane_conflict_v156', rebindFrom: 'sess_0' });

    const merged = setDriveState(projectId, { status: 'awaiting-human' });

    expect(merged.stoppedReason).toBe('lane_conflict_v156');
    expect(merged.rebindFrom).toBe('sess_0');
    expect(merged.sessionId).toBe('sess_1');
    expect(rawSessionColumn(projectId)).toBe('sess_1');
  });

  it('getDriveSessionId de projeto inexistente devolve null', () => {
    expect(getDriveSessionId('nao-existe')).toBeNull();
  });
});

describe('V156 - leitores por lane', () => {
  it('listHarnessProjectsBySession isola os projetos de cada lane', () => {
    const a1 = newProject('lane a - 1');
    const a2 = newProject('lane a - 2');
    const b1 = newProject('lane b - 1');
    newProject('sem lane');
    engage(a1, 'sess_a', 'driving');
    engage(a2, 'sess_a', 'awaiting-human');
    engage(b1, 'sess_b', 'driving');

    const laneA = listHarnessProjectsBySession('sess_a').map((project) => project.id);
    const laneB = listHarnessProjectsBySession('sess_b').map((project) => project.id);

    expect(laneA.sort()).toEqual([a1, a2].sort());
    expect(laneB).toEqual([b1]);
    expect(listHarnessProjectsBySession('sess_vazia')).toEqual([]);
  });

  it('findEngagedDriveBySession devolve o unico engajado e ignora parado / lane vazia', () => {
    const engaged = newProject('engajado');
    const stopped = newProject('parado');
    engage(engaged, 'sess_a', 'awaiting-human');
    engage(stopped, 'sess_a', 'driving');
    setDriveState(stopped, { status: 'stopped' });

    expect(findEngagedDriveBySession('sess_a')?.id).toBe(engaged);
    expect(findEngagedDriveBySession('sess_sem_drive')).toBeNull();
    expect(findEngagedDriveBySession('')).toBeNull();
  });

  it('dois engajados na mesma lane: recusa com drive_uniqueness_violated e os ids, nunca o primeiro', () => {
    const first = newProject('engajado 1');
    const second = newProject('engajado 2');
    engage(first, 'sess_dup', 'driving');
    engage(second, 'sess_dup', 'awaiting-human');

    let thrown: unknown = null;
    try {
      findEngagedDriveBySession('sess_dup');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message.startsWith('drive_uniqueness_violated')).toBe(true);
    expect(message).toContain(first);
    expect(message).toContain(second);
  });
});
