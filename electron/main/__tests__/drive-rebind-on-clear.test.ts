import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveState } from '../../../src/types';

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

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

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

    transaction<T>(fn: (...args: unknown[]) => T): ((...args: unknown[]) => T) & {
      immediate: (...args: unknown[]) => T;
      deferred: (...args: unknown[]) => T;
      exclusive: (...args: unknown[]) => T;
    } {
      const run = (...args: unknown[]): T => {
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
      return Object.assign(run, { immediate: run, deferred: run, exclusive: run });
    }

    close(): void {
      this.sqlite.close();
    }
  }
  return { default: FakeDatabase };
});

const pushes = vi.hoisted(() => ({
  assistant: vi.fn<(sessionId: string, content: string, opts?: unknown) => number>(() => 1),
  paused: vi.fn<(sessionId: string, opts?: unknown) => void>(),
}));
vi.mock('../chat-push', () => ({
  pushAssistantMessage: pushes.assistant,
  pushDrivePaused: pushes.paused,
}));
vi.mock('../activity-log', () => ({ recordActivity: vi.fn() }));
vi.mock('../orchestrator', () => ({ submitMessage: vi.fn() }));
vi.mock('../pipeline-control-core', () => ({
  resolvePendingQuestion: vi.fn(() => 'O agente da fase perguntou algo.'),
  getCachedPhaseChanged: vi.fn(() => null),
}));
vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: vi.fn() }));
vi.mock('../telegram-bridge', () => ({ notifyDriveHandoff: vi.fn() }));

import {
  countSessionMessages,
  getDb,
  getDriveSessionId,
  getDriveState,
  getSession,
  getSessionsWithDreamingStarted,
  initDatabase,
  insertHarnessProject,
  isOpenDesktopConversation,
  rebindDriveSessions,
  replaceLaneSession,
  setDreamingStartedAt,
  setDriveState,
  updateHarnessProjectPipelineMeta,
} from '../db';
import { applyMigrationV156 } from '../db-migrations/v156-drive-session-column';
import { submitMessage } from '../orchestrator';
import { _resetDriveLockForTesting, driveOwnerOfProject } from '../drive-lock';
import { reportDriveTurnComplete } from '../drive-usage-sink';
import { clearingSessions, isSessionClearing } from '../clearing-sessions';
import { createLaneClearer, type ClearLaneDeps, type LaneClearer } from '../chat-clear-core';
import { resetDreamingMutexForTests, acquireDreamingMutex } from '../dreaming-mutex';
import { listActiveDriveProjectIdsForSession } from '../session-drive';
import { PipelineDriveCoordinator } from '../pipeline-drive-coordinator';

const submitMock = vi.mocked(submitMessage);

const SCHEMA_DDL = `
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
    pipeline_start_phase INTEGER DEFAULT NULL,
    pipeline_current_phase INTEGER DEFAULT NULL,
    prd_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    sdk_session_id TEXT,
    subagent TEXT,
    title TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    status TEXT DEFAULT 'active',
    max_tokens INTEGER DEFAULT 0,
    type TEXT DEFAULT 'chat',
    task_id TEXT,
    rolling_summary TEXT,
    compacted_up_to_message_id INTEGER,
    pending_seed TEXT,
    active_context_tokens_est INTEGER,
    agentic_context_tokens_est INTEGER,
    thread_reset_message_id INTEGER,
    cost_status TEXT,
    token_status TEXT,
    unknown_cost_count INTEGER DEFAULT 0,
    cost_unknown_reasons TEXT DEFAULT '[]',
    parent_cost_by_runtime TEXT,
    parent_cost_status_by_runtime TEXT,
    parent_subscription_equivalent_cost_usd REAL DEFAULT 0,
    lane_badge INTEGER,
    orchestrator_runtime TEXT,
    orchestrator_provider TEXT,
    orchestrator_model TEXT,
    orchestrator_effort TEXT,
    sdk_thread_history TEXT NOT NULL DEFAULT '[]',
    dreaming_started_at TEXT,
    dreaming_turn_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    subagent TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE chat_session_features (
    session_id TEXT PRIMARY KEY,
    pipeline_control_enabled INTEGER DEFAULT 0,
    dynamic_workflows_enabled INTEGER DEFAULT 0
  );

  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT
  );

  CREATE TABLE task_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT,
    root_execution_id TEXT,
    owner_kind TEXT,
    owner_id TEXT,
    execution_kind TEXT,
    status TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    api_requests INTEGER DEFAULT 0,
    tool_uses INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    cost_status TEXT,
    token_status TEXT,
    cost_unknown_reason TEXT,
    runtime TEXT,
    provider TEXT,
    model TEXT,
    metadata TEXT
  );
`;

function seedLane(id: string, laneBadge: number | null, messages = 2): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, title, status, type, lane_badge, rolling_summary)
       VALUES (?, ?, 'active', 'chat', ?, 'resumo')`,
    )
    .run(id, `Conversa ${id}`, laneBadge);
  for (let i = 0; i < messages; i++) {
    getDb().prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'user', 'oi')`).run(id);
  }
}

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

function engage(
  projectId: string,
  sessionId: string,
  status: DriveState['status'],
  startedAt = '2026-09-17T09:00:00.000Z',
): void {
  setDriveState(projectId, {
    driver: 'orchestrator',
    status,
    handoff: 'none',
    mode: 'semi',
    sessionId,
    requiresHumanPhases: [],
    startedAt,
  });
  updateHarnessProjectPipelineMeta(projectId, { status: 'running', pipelineCurrentPhase: 3 });
}

function newRunningProject(name: string): string {
  const projectId = newProject(name);
  updateHarnessProjectPipelineMeta(projectId, { status: 'running', pipelineCurrentPhase: 3 });
  return projectId;
}

function rawColumn(projectId: string): string | null {
  const row = getDb().prepare('SELECT session_id FROM harness_projects WHERE id = ?').get(projectId) as
    { session_id: string | null } | undefined;
  return row?.session_id ?? null;
}

function rawConfigDrive(projectId: string): Record<string, unknown> {
  const row = getDb().prepare('SELECT config FROM harness_projects WHERE id = ?').get(projectId) as { config: string };
  return (JSON.parse(row.config) as { drive?: Record<string, unknown> }).drive ?? {};
}

interface RuntimePeek {
  drive: DriveState;
  currentDriveTurnId: string | null;
  pendingRecoveryPush: string | null;
  tickTimer: NodeJS.Timeout | null;
}

function peek(coordinator: PipelineDriveCoordinator, projectId: string): RuntimePeek | undefined {
  return (coordinator as unknown as { states: Map<string, RuntimePeek> }).states.get(projectId);
}

let coordinator: PipelineDriveCoordinator;

function makeClearer(opts: { failCompaction?: boolean } = {}): LaneClearer {
  const deps = {
    getSession,
    countSessionMessages,
    isOpenDesktopConversation,
    setDreamingStartedAt,
    replaceLaneSession,
    getSessionsWithDreamingStarted,
    getExecutionState: () => 'idle' as const,
    isCompacting: () => false,
    listActiveDriveProjectIds: listActiveDriveProjectIdsForSession,
    stopDrive: (projectId: string, reason: string) => coordinator.stopDrive(projectId, reason),
    onLaneClearFinished: (sessionId: string) => coordinator.onLaneClearFinished(sessionId),
    stopSessionQuery: vi.fn(),
    awaitTurnSettled: async () => ({ settled: true as const }),
    readSettleTimeoutMs: () => 1_000,
    acquireDreamingMutex,
    runCompaction: async () => {
      if (opts.failCompaction) throw new Error('COMPACT falhou no teste');
      return { executiveSummary: 'resumo', warnings: [] };
    },
    resolveModelLabel: async () => 'modelo',
    readDefaultOrchestrator: () => null,
    closeCodexSession: vi.fn(),
    emitCompactionActive: vi.fn(),
    emitSessionsUpdated: vi.fn(),
    now: () => new Date('2026-09-17T12:00:00.000Z'),
  } as unknown as ClearLaneDeps;
  return createLaneClearer(deps);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function settleDriveTurn(projectId: string): void {
  const driveTurnId = peek(coordinator, projectId)?.currentDriveTurnId ?? undefined;
  reportDriveTurnComplete(projectId, driveTurnId, 'executed');
}

beforeAll(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-drive-rebind-'));
  initDatabase({
    prepareSafety: () => ({ currentVersion: 0, backupPath: null, markerPath: null }),
    runMigrations: () => {
      const database = getDb();
      database.exec(SCHEMA_DDL);
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
  vi.clearAllMocks();
  const database = getDb();
  database.exec('DELETE FROM harness_projects; DELETE FROM messages; DELETE FROM sessions;');
  clearingSessions.clear();
  _resetDriveLockForTesting();
  resetDreamingMutexForTests();
  coordinator = new PipelineDriveCoordinator(() => null);
  coordinator.start();
});

afterEach(() => {
  coordinator.stop();
});

describe('AC-7 (SPEC 7.1): rebindDriveSessions re-aponta TODOS os projetos da lane', () => {
  it('re-aponta coluna, espelho e rebindFrom de engajado E parado; projeto sem lane nao e tocado', () => {
    seedLane('sess_A', 1);
    const engaged = newProject('engajado');
    const stoppedMonthsAgo = newProject('parado ha meses');
    const orphan = newProject('sem lane');
    engage(engaged, 'sess_A', 'awaiting-human');
    engage(stoppedMonthsAgo, 'sess_A', 'driving');
    setDriveState(stoppedMonthsAgo, { status: 'stopped' });

    const changed = rebindDriveSessions('sess_A', 'sess_A2');

    expect(changed).toBe(2);
    for (const projectId of [engaged, stoppedMonthsAgo]) {
      expect(rawColumn(projectId)).toBe('sess_A2');
      expect(rawConfigDrive(projectId)['sessionId']).toBe('sess_A2');
      expect(rawConfigDrive(projectId)['rebindFrom']).toBe('sess_A');
      expect(getDriveSessionId(projectId)).toBe('sess_A2');
    }
    expect(rawColumn(orphan)).toBeNull();
    expect(getDriveState(orphan)).toBeNull();
  });

  it('lane sem projeto e re-bind para a mesma sessao sao no-op', () => {
    expect(rebindDriveSessions('sess_vazia', 'sess_nova')).toBe(0);
    expect(rebindDriveSessions('sess_A', 'sess_A')).toBe(0);
    expect(rebindDriveSessions('', 'sess_A')).toBe(0);
  });

  it('drive engajado: o LOCK e o rt.drive.sessionId acompanham o re-bind, sem mudar o status', async () => {
    seedLane('sess_A', 1);
    const projectId = newRunningProject('engajado');
    coordinator.startDrive(projectId, 'sess_A', 'semi');
    await flush();
    settleDriveTurn(projectId);
    expect(driveOwnerOfProject(projectId)).toBe('sess_A');

    rebindDriveSessions('sess_A', 'sess_A2');

    expect(driveOwnerOfProject(projectId)).toBe('sess_A2');
    expect(peek(coordinator, projectId)?.drive.sessionId).toBe('sess_A2');
    expect(getDriveState(projectId)?.status).toBe('driving');
  });

  it('turno de drive em voo RECUSA o re-bind e nao migra dono nem runtime', async () => {
    seedLane('sess_A', 1);
    const projectId = newRunningProject('turno em voo');
    coordinator.startDrive(projectId, 'sess_A', 'semi');
    await flush();
    peek(coordinator, projectId)!.currentDriveTurnId = 'drive-turn-em-voo';

    expect(() => rebindDriveSessions('sess_A', 'sess_A2')).toThrowError(/drive_turn_in_flight/);

    expect(rawColumn(projectId)).toBe('sess_A');
    expect(driveOwnerOfProject(projectId)).toBe('sess_A');
    expect(peek(coordinator, projectId)?.drive.sessionId).toBe('sess_A');
  });
});

describe('AC-7 (SPEC 7.1): replaceLaneSession chama o re-bind DENTRO da transacao', () => {
  it('Clear force com drive engajado: conversa nova herda a lane e o drive segue nela', async () => {
    seedLane('sess_A', 1);
    const projectId = newRunningProject('drive do Clear force');
    coordinator.startDrive(projectId, 'sess_A', 'semi');
    await flush();
    expect(listActiveDriveProjectIdsForSession('sess_A')).toEqual([projectId]);

    const result = await makeClearer().clearLaneSession('sess_A', { force: true });

    expect(result).toMatchObject({ ok: true, pausedDriveProjectIds: [projectId] });
    const newSessionId = (result as { newSessionId: string | null }).newSessionId!;
    expect(newSessionId).toBeTruthy();
    expect(getSession('sess_A')?.status).toBe('compacted');
    expect(rawColumn(projectId)).toBe(newSessionId);
    expect(rawConfigDrive(projectId)['sessionId']).toBe(newSessionId);
    expect(rawConfigDrive(projectId)['rebindFrom']).toBe('sess_A');
    expect(driveOwnerOfProject(projectId)).toBeNull();

    submitMock.mockClear();
    const resumed = coordinator.resumeDrive(projectId, undefined, { fromHuman: true });
    expect(resumed.ok).toBe(true);
    expect(driveOwnerOfProject(projectId)).toBe(newSessionId);
    expect((submitMock.mock.calls[0]?.[1] as { sessionId?: string })?.sessionId).toBe(newSessionId);
  });

  it('Clear que FALHA nao re-aponta: a coluna segue na lane original aberta', async () => {
    seedLane('sess_A', 1);
    const projectId = newRunningProject('drive do Clear falho');
    coordinator.startDrive(projectId, 'sess_A', 'semi');
    await flush();

    const result = await makeClearer({ failCompaction: true }).clearLaneSession('sess_A', {
      force: true,
    });

    expect(result).toMatchObject({ ok: false, code: 'clear_failed' });
    expect(getSession('sess_A')?.status).toBe('active');
    expect(rawColumn(projectId)).toBe('sess_A');
    expect(rawConfigDrive(projectId)['rebindFrom']).toBeUndefined();
    expect(getDriveState(projectId)?.status).toBe('stopped');
    expect(isSessionClearing('sess_A')).toBe(false);
  });

  it('archive-session com drive awaiting-human (pausado, sem turno de drive em voo): coluna, dono e runtime migram juntos', () => {
    seedLane('sess_A', 1);
    const projectId = newRunningProject('archive com awaiting-human');
    coordinator.startDrive(projectId, 'sess_A', 'semi');
    coordinator.escalateFromOrchestrator(projectId, 'Preciso do seu OK no gate.');
    expect(getDriveState(projectId)?.status).toBe('awaiting-human');

    const { newSessionId } = replaceLaneSession({
      sessionId: 'sess_A',
      finalStatus: 'archived',
      orchestrator: null,
    });

    expect(newSessionId).toBeTruthy();
    expect(rawColumn(projectId)).toBe(newSessionId);
    expect(driveOwnerOfProject(projectId)).toBe(newSessionId);
    expect(peek(coordinator, projectId)?.drive.sessionId).toBe(newSessionId);
    expect(getDriveState(projectId)?.status).toBe('awaiting-human');

    submitMock.mockClear();
    pushes.assistant.mockClear();
    const resumed = coordinator.resumeDrive(projectId, undefined, { fromHuman: true });
    expect(resumed.ok).toBe(true);
    expect((submitMock.mock.calls[0]?.[1] as { sessionId?: string })?.sessionId).toBe(newSessionId);
  });

  it('archive de conversa SEM badge devolve newSessionId null e nenhuma coluna muda', () => {
    seedLane('sess_sem_badge', null);
    const projectId = newProject('sem badge');
    engage(projectId, 'sess_sem_badge', 'awaiting-human');

    const result = replaceLaneSession({
      sessionId: 'sess_sem_badge',
      finalStatus: 'archived',
      orchestrator: null,
    });

    expect(result).toEqual({ newSessionId: null });
    expect(rawColumn(projectId)).toBe('sess_sem_badge');
    expect(rawConfigDrive(projectId)['rebindFrom']).toBeUndefined();
  });

  it('turno de drive em voo: a transacao inteira rola de volta (sessao antiga intacta)', async () => {
    seedLane('sess_A', 1);
    const projectId = newRunningProject('rollback');
    coordinator.startDrive(projectId, 'sess_A', 'semi');
    await flush();
    peek(coordinator, projectId)!.currentDriveTurnId = 'drive-turn-em-voo';

    expect(() =>
      replaceLaneSession({ sessionId: 'sess_A', finalStatus: 'compacted', orchestrator: null }),
    ).toThrowError(/drive_turn_in_flight/);

    expect(getSession('sess_A')?.status).toBe('active');
    expect(getSession('sess_A')?.laneBadge).toBe(1);
    expect(rawColumn(projectId)).toBe('sess_A');
    expect(driveOwnerOfProject(projectId)).toBe('sess_A');
    expect(peek(coordinator, projectId)?.drive.sessionId).toBe('sess_A');
  });
});

describe('AC-7 (SPEC 7.1/7.3): boot com Clear interrupted e Refazer Clear', () => {
  it('Refazer Clear pula o stopDrive, re-aponta a lane e entrega o push de recuperacao na conversa nova', async () => {
    seedLane('sess_A', 1);
    const projectId = newProject('clear interrompido');
    engage(projectId, 'sess_A', 'driving');
    setDreamingStartedAt('sess_A', '2026-09-17T11:00:00.000Z');

    const clearer = makeClearer();
    expect(clearer.rebuildClearingSessionsOnBoot()).toEqual(['sess_A']);
    expect(isSessionClearing('sess_A')).toBe(true);

    coordinator.recoverInterruptedDrives();

    expect(driveOwnerOfProject(projectId)).toBe('sess_A');
    expect(getDriveState(projectId)?.status).toBe('awaiting-human');
    expect(pushes.assistant).not.toHaveBeenCalled();
    expect(peek(coordinator, projectId)?.pendingRecoveryPush).toContain('interrompido pelo restart');

    const result = await clearer.clearLaneSession('sess_A');

    expect(result).toMatchObject({ ok: true, pausedDriveProjectIds: [] });
    const newSessionId = (result as { newSessionId: string | null }).newSessionId!;
    expect(rawColumn(projectId)).toBe(newSessionId);
    expect(driveOwnerOfProject(projectId)).toBe(newSessionId);
    expect(peek(coordinator, projectId)?.drive.sessionId).toBe(newSessionId);
    expect(pushes.assistant).toHaveBeenCalledTimes(1);
    expect(pushes.assistant.mock.calls[0]?.[0]).toBe(newSessionId);
    expect(peek(coordinator, projectId)?.pendingRecoveryPush).toBeNull();
  });
});
