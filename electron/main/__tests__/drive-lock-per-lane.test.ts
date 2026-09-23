import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveState } from '../../../src/types';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

interface FakeProject {
  id: string;
  name: string;
  pipelineType?: string;
  status: string;
  pipelineCurrentPhase?: number | null;
  pipelineStartPhase?: number | null;
  config: { drive?: DriveState };
}

const projects = new Map<string, FakeProject>();

function fakeGetDriveState(projectId: string): DriveState | null {
  return projects.get(projectId)?.config.drive ?? null;
}
function fakeSetDriveState(projectId: string, patch: Partial<DriveState>): DriveState {
  const project = projects.get(projectId);
  if (!project) throw new Error(`setDriveState: project not found: ${projectId}`);
  const existing = project.config.drive;
  const merged: DriveState = {
    driver: patch.driver ?? existing?.driver ?? 'orchestrator',
    status: patch.status ?? existing?.status ?? 'driving',
    handoff: patch.handoff ?? existing?.handoff ?? 'none',
    mode: patch.mode ?? existing?.mode ?? 'semi',
    sessionId: patch.sessionId !== undefined ? patch.sessionId : existing?.sessionId,
    requiresHumanPhases: patch.requiresHumanPhases ?? existing?.requiresHumanPhases ?? [],
    startedAt: patch.startedAt !== undefined ? patch.startedAt : existing?.startedAt,
  };
  project.config.drive = merged;
  return merged;
}
function fakeIsDriveEngaged(projectId: string): boolean {
  const drive = fakeGetDriveState(projectId);
  return !!drive && drive.driver === 'orchestrator' && drive.status !== 'stopped';
}
function fakeProjectsBySession(sessionId: string): FakeProject[] {
  return [...projects.values()].filter((p) => p.config.drive?.sessionId === sessionId);
}

vi.mock('../db', () => ({
  getHarnessProject: vi.fn((id: string) => projects.get(id)),
  listHarnessProjects: vi.fn(() => [...projects.values()]),
  listHarnessProjectsBySession: vi.fn((id: string) => fakeProjectsBySession(id)),
  findEngagedDriveBySession: vi.fn(
    (id: string) => fakeProjectsBySession(id).find((p) => fakeIsDriveEngaged(p.id)) ?? null,
  ),
  getDriveState: vi.fn((id: string) => fakeGetDriveState(id)),
  getDriveSessionId: vi.fn((id: string) => fakeGetDriveState(id)?.sessionId ?? null),
  isDriveEngaged: vi.fn((id: string) => fakeIsDriveEngaged(id)),
  getOpenLaneSessionById: vi.fn((id: string) =>
    id ? { id, laneBadge: Number(id.replace(/\D/g, '')) || 1, title: id } : null,
  ),
  getSession: vi.fn((id: string) => ({ id })),
  setDriveState: vi.fn((id: string, patch: Partial<DriveState>) => fakeSetDriveState(id, patch)),
  getLatestUserTurnIndex: vi.fn(() => 0),
}));

vi.mock('../chat-push', () => ({
  pushAssistantMessage: vi.fn(() => 1),
  pushDrivePaused: vi.fn(),
}));
vi.mock('../telegram-bridge', () => ({ notifyDriveHandoff: vi.fn(async () => {}) }));
vi.mock('../activity-log', () => ({ recordActivity: vi.fn() }));
vi.mock('../orchestrator', () => ({ submitMessage: vi.fn() }));
vi.mock('../pipeline-control-core', () => ({
  resolvePendingQuestion: vi.fn(() => 'O agente da fase perguntou algo.'),
  getCachedPhaseChanged: vi.fn(() => null),
}));

import {
  _resetDriveLockForTesting,
  acquireDriveLock,
  driveHolderOfSession,
  driveOwnerOfProject,
  hasAnyActiveDrive,
  listDriveLocks,
  releaseDriveLock,
} from '../drive-lock';
import { pipelineEventBus } from '../pipeline-event-bus';
import { PipelineDriveCoordinator } from '../pipeline-drive-coordinator';

describe('drive-lock por lane (5.1)', () => {
  beforeEach(() => {
    _resetDriveLockForTesting();
  });

  it('mesmo projeto + mesma lane e ok idempotente', () => {
    expect(acquireDriveLock('proj_a', 'sess_1')).toMatchObject({ ok: true });
    expect(acquireDriveLock('proj_a', 'sess_1')).toMatchObject({ ok: true });
    expect(listDriveLocks()).toHaveLength(1);
  });

  it('outro projeto na MESMA lane e lane_busy com o detentor', () => {
    acquireDriveLock('proj_a', 'sess_1');

    expect(acquireDriveLock('proj_b', 'sess_1')).toEqual({
      ok: false,
      reason: 'lane_busy',
      holderProjectId: 'proj_a',
      sessionId: 'sess_1',
    });
    expect(driveOwnerOfProject('proj_b')).toBeNull();
  });

  it('lanes diferentes convivem (o lock deixou de ser global)', () => {
    expect(acquireDriveLock('proj_a', 'sess_1')).toMatchObject({ ok: true });
    expect(acquireDriveLock('proj_b', 'sess_2')).toMatchObject({ ok: true });
    expect(listDriveLocks()).toHaveLength(2);
  });

  it('mesmo projeto em outra lane sem allowRebind e drive_owned_by_other_lane com a lane dona', () => {
    acquireDriveLock('proj_a', 'sess_1');

    expect(acquireDriveLock('proj_a', 'sess_2')).toEqual({
      ok: false,
      reason: 'drive_owned_by_other_lane',
      sessionId: 'sess_1',
    });
    expect(driveOwnerOfProject('proj_a')).toBe('sess_1');
  });

  it('re-bind com allowRebind e turno em voo e drive_turn_in_flight (nao migra)', () => {
    acquireDriveLock('proj_a', 'sess_1');

    expect(acquireDriveLock('proj_a', 'sess_2', { allowRebind: true, turnInFlight: true })).toEqual({
      ok: false,
      reason: 'drive_turn_in_flight',
    });
    expect(driveOwnerOfProject('proj_a')).toBe('sess_1');
  });

  it('re-bind com allowRebind e sem turno em voo migra a lane do projeto', () => {
    acquireDriveLock('proj_a', 'sess_1');

    expect(acquireDriveLock('proj_a', 'sess_2', { allowRebind: true })).toMatchObject({ ok: true });
    expect(driveOwnerOfProject('proj_a')).toBe('sess_2');
    expect(driveHolderOfSession('sess_1')).toBeNull();
    expect(driveHolderOfSession('sess_2')).toBe('proj_a');
  });

  it('re-bind com allowRebind para a MESMA lane e ok idempotente (nao conta como re-bind)', () => {
    acquireDriveLock('proj_a', 'sess_1');
    const before = listDriveLocks()[0].since;

    expect(acquireDriveLock('proj_a', 'sess_1', { allowRebind: true, turnInFlight: true })).toMatchObject({ ok: true });
    expect(listDriveLocks()[0].since).toBe(before);
  });

  it('re-bind para lane ocupada por outro projeto e lane_busy', () => {
    acquireDriveLock('proj_a', 'sess_1');
    acquireDriveLock('proj_b', 'sess_2');

    expect(acquireDriveLock('proj_a', 'sess_2', { allowRebind: true })).toEqual({
      ok: false,
      reason: 'lane_busy',
      holderProjectId: 'proj_b',
      sessionId: 'sess_2',
    });
    expect(driveOwnerOfProject('proj_a')).toBe('sess_1');
  });

  it('releaseDriveLock libera SO o projeto pedido', () => {
    acquireDriveLock('proj_a', 'sess_1');
    acquireDriveLock('proj_b', 'sess_2');

    releaseDriveLock('proj_a');

    expect(driveOwnerOfProject('proj_a')).toBeNull();
    expect(driveOwnerOfProject('proj_b')).toBe('sess_2');
    expect(hasAnyActiveDrive()).toBe(true);

    releaseDriveLock('proj_b');
    expect(hasAnyActiveDrive()).toBe(false);
    expect(listDriveLocks()).toEqual([]);
  });

  it('listDriveLocks devolve copia: mexer no array nao mexe no lock', () => {
    acquireDriveLock('proj_a', 'sess_1');

    const locks = listDriveLocks();
    locks.pop();

    expect(listDriveLocks()).toHaveLength(1);
    expect(driveOwnerOfProject('proj_a')).toBe('sess_1');
  });
});

describe('AC-5: liberacoes do lock por projectId (stop/assumir/terminal)', () => {
  function seed(id: string, phase = 1): FakeProject {
    const project: FakeProject = {
      id,
      name: id,
      pipelineType: 'development',
      status: 'running',
      pipelineCurrentPhase: phase,
      pipelineStartPhase: 1,
      config: {},
    };
    projects.set(id, project);
    return project;
  }

  function makeCoordinator(): PipelineDriveCoordinator {
    const coord = new PipelineDriveCoordinator(() => null);
    coord.start();
    return coord;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    projects.clear();
    pipelineEventBus._resetForTesting();
    _resetDriveLockForTesting();
  });

  it('stopDrive(P1) libera SO a lane A; P2 segue dirigindo na lane B', () => {
    seed('proj_1');
    seed('proj_2');
    const coord = makeCoordinator();
    coord.startDrive('proj_1', 'sess_1', 'semi');
    coord.startDrive('proj_2', 'sess_2', 'semi');

    coord.stopDrive('proj_1', 'ui-stop');

    expect(driveOwnerOfProject('proj_1')).toBeNull();
    expect(listDriveLocks()).toEqual([expect.objectContaining({ projectId: 'proj_2', sessionId: 'sess_2' })]);
  });

  it('assumirDrive(P1) libera SO a lane A; P2 continua com a lane B', () => {
    seed('proj_1');
    seed('proj_2');
    const coord = makeCoordinator();
    coord.startDrive('proj_1', 'sess_1', 'semi');
    coord.startDrive('proj_2', 'sess_2', 'semi');

    coord.assumirDrive('proj_1');

    expect(driveOwnerOfProject('proj_1')).toBeNull();
    expect(driveOwnerOfProject('proj_2')).toBe('sess_2');
  });

  it('stopDrive de projeto SEM drive persistido nao mexe em lock nenhum', () => {
    seed('proj_1');
    seed('proj_2');
    const coord = makeCoordinator();
    coord.startDrive('proj_2', 'sess_2', 'semi');

    coord.stopDrive('proj_1', 'project-deleted');

    expect(driveOwnerOfProject('proj_2')).toBe('sess_2');
    expect(listDriveLocks()).toHaveLength(1);
  });

  it('terminal FAILED mantem a lane ocupada (segue awaiting-human) e outro pipeline na mesma lane e recusado', () => {
    seed('proj_1');
    seed('proj_2');
    const coord = makeCoordinator();
    coord.startDrive('proj_1', 'sess_1', 'semi');

    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_1',
      phase: 1,
      status: 'failed',
      awaitingUser: false,
    });

    expect(fakeGetDriveState('proj_1')?.status).toBe('awaiting-human');
    expect(driveOwnerOfProject('proj_1')).toBe('sess_1');

    const second = coord.startDrive('proj_2', 'sess_1', 'semi');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('lane_busy');
  });

  it('terminal ABORTED passa por stopDrive e libera a lane', () => {
    seed('proj_1');
    seed('proj_2');
    const coord = makeCoordinator();
    coord.startDrive('proj_1', 'sess_1', 'semi');

    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_1',
      phase: 1,
      status: 'aborted',
      awaitingUser: false,
    });

    expect(fakeGetDriveState('proj_1')?.status).toBe('stopped');
    expect(driveOwnerOfProject('proj_1')).toBeNull();
    expect(hasAnyActiveDrive()).toBe(false);

    const second = coord.startDrive('proj_2', 'sess_1', 'semi');
    expect(second.ok).toBe(true);
  });
});
