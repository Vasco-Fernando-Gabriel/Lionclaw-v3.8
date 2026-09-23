import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
}));

vi.mock('../logger', () => ({
  createLogger: () => loggerMock,
  rootLogger: loggerMock,
}));

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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

interface DriveFixture {
  driver?: 'orchestrator' | 'human';
  status?: 'driving' | 'awaiting-human' | 'stopped';
  sessionId?: string;
  startedAt?: string;
}

function makeDb(): Database.Database {
  const sqlite = new DatabaseSync(':memory:');
  let seq = 0;
  const db = {
    prepare: sqlite.prepare.bind(sqlite),
    exec: sqlite.exec.bind(sqlite),
    pragma: (source: string) => sqlite.prepare(`PRAGMA ${source}`).all(),
    transaction:
      <T>(fn: () => T) =>
      () => {
        const savepoint = `test_tx_${++seq}`;
        sqlite.exec(`SAVEPOINT ${savepoint}`);
        try {
          const result = fn();
          sqlite.exec(`RELEASE ${savepoint}`);
          return result;
        } catch (error) {
          sqlite.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
          throw error;
        }
      },
  } as unknown as Database.Database;
  db.exec(HARNESS_PROJECTS_DDL);
  return db;
}

function insertProject(
  db: Database.Database,
  id: string,
  drive: DriveFixture | null,
  updatedAt = '2026-01-01 00:00:00',
): void {
  const config = drive ? { drive } : {};
  db.prepare(
    `
    INSERT INTO harness_projects (id, name, project_path, spec_path, config, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(id, `projeto ${id}`, `/tmp/${id}`, `/tmp/${id}/spec.md`, JSON.stringify(config), updatedAt);
}

function readProject(db: Database.Database, id: string): { session_id: string | null; config: string } {
  return db.prepare('SELECT session_id, config FROM harness_projects WHERE id = ?').get(id) as {
    session_id: string | null;
    config: string;
  };
}

function driveOf(db: Database.Database, id: string): DriveFixture & { stoppedReason?: string } {
  return JSON.parse(readProject(db, id).config).drive;
}

describe('migration V156 - harness_projects.session_id', () => {
  beforeEach(() => {
    loggerMock.warn.mockClear();
  });

  it('adiciona a coluna session_id e o indice, e e idempotente na re-execucao', () => {
    const db = makeDb();
    applyMigrationV156(db);
    applyMigrationV156(db);

    const columns = db.pragma('table_info(harness_projects)') as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const sessionColumn = columns.find((column) => column.name === 'session_id');
    expect(sessionColumn).toBeDefined();
    expect(sessionColumn?.type).toBe('TEXT');
    expect(sessionColumn?.notnull).toBe(0);

    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_harness_projects_session_id');
    expect(index).toBeDefined();
  });

  it('backfill: projeto com config.drive.sessionId recebe session_id na coluna', () => {
    const db = makeDb();
    insertProject(db, 'p_backfill', {
      driver: 'orchestrator',
      status: 'driving',
      sessionId: 'sess_1',
      startedAt: '2026-01-05T10:00:00.000Z',
    });

    applyMigrationV156(db);

    expect(readProject(db, 'p_backfill').session_id).toBe('sess_1');
  });

  it('projeto sem drive fica com session_id NULL', () => {
    const db = makeDb();
    insertProject(db, 'p_sem_drive', null);

    applyMigrationV156(db);

    expect(readProject(db, 'p_sem_drive').session_id).toBeNull();
  });

  it('saneamento: entre dois engajados na mesma sessao, o startedAt mais recente segue e o outro vira stopped lane_conflict_v156', () => {
    const db = makeDb();
    insertProject(db, 'p_antigo', {
      driver: 'orchestrator',
      status: 'driving',
      sessionId: 'sess_dup',
      startedAt: '2026-01-05T10:00:00.000Z',
    });
    insertProject(db, 'p_recente', {
      driver: 'orchestrator',
      status: 'awaiting-human',
      sessionId: 'sess_dup',
      startedAt: '2026-01-06T10:00:00.000Z',
    });

    applyMigrationV156(db);

    expect(driveOf(db, 'p_recente').status).toBe('awaiting-human');
    expect(driveOf(db, 'p_recente').stoppedReason).toBeUndefined();
    expect(driveOf(db, 'p_antigo').status).toBe('stopped');
    expect(driveOf(db, 'p_antigo').stoppedReason).toBe('lane_conflict_v156');
    expect(readProject(db, 'p_antigo').session_id).toBe('sess_dup');
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn.mock.calls[0][0]).toMatchObject({
      sessionId: 'sess_dup',
      keptProjectId: 'p_recente',
      stoppedProjectIds: ['p_antigo'],
    });
  });

  it('saneamento: startedAt ausente perde o desempate e updated_at desempata o resto', () => {
    const db = makeDb();
    insertProject(
      db,
      'p_sem_started',
      { driver: 'orchestrator', status: 'driving', sessionId: 'sess_dup' },
      '2026-01-09 00:00:00',
    );
    insertProject(
      db,
      'p_com_started',
      {
        driver: 'orchestrator',
        status: 'driving',
        sessionId: 'sess_dup',
        startedAt: '2026-01-02T10:00:00.000Z',
      },
      '2026-01-02 00:00:00',
    );

    applyMigrationV156(db);

    expect(driveOf(db, 'p_com_started').status).toBe('driving');
    expect(driveOf(db, 'p_sem_started').status).toBe('stopped');
    expect(driveOf(db, 'p_sem_started').stoppedReason).toBe('lane_conflict_v156');
  });

  it('nao mexe em projeto parado nem em projeto de outra sessao', () => {
    const db = makeDb();
    insertProject(db, 'p_engajado', {
      driver: 'orchestrator',
      status: 'driving',
      sessionId: 'sess_a',
      startedAt: '2026-01-01T10:00:00.000Z',
    });
    insertProject(db, 'p_parado', {
      driver: 'orchestrator',
      status: 'stopped',
      sessionId: 'sess_a',
      startedAt: '2026-01-09T10:00:00.000Z',
    });
    insertProject(db, 'p_outra_lane', {
      driver: 'orchestrator',
      status: 'driving',
      sessionId: 'sess_b',
      startedAt: '2026-01-09T10:00:00.000Z',
    });

    applyMigrationV156(db);

    expect(driveOf(db, 'p_engajado').status).toBe('driving');
    expect(driveOf(db, 'p_outra_lane').status).toBe('driving');
    expect(driveOf(db, 'p_parado').stoppedReason).toBeUndefined();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});
