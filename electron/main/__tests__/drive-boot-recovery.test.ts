import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveState, DriveStateChangedEvent } from '../../../src/types';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

interface FakeProject {
  id: string;
  name: string;
  pipelineType?: string;
  status: string;
  pipelineCurrentPhase?: number | null;
  pipelineStartPhase?: number | null;
  sessionId: string | null;
  config: { drive?: DriveState };
}

const projects = new Map<string, FakeProject>();
const openLanes = new Map<string, number>();

function fakeSetDriveState(projectId: string, patch: Partial<DriveState>): DriveState {
  const project = projects.get(projectId);
  if (!project) throw new Error(`setDriveState: project not found: ${projectId}`);
  const existing = project.config.drive;
  const currentSessionId = project.sessionId ?? existing?.sessionId;
  const merged: DriveState = {
    driver: patch.driver ?? existing?.driver ?? 'orchestrator',
    status: patch.status ?? existing?.status ?? 'driving',
    handoff: patch.handoff ?? existing?.handoff ?? 'none',
    mode: patch.mode ?? existing?.mode ?? 'semi',
    sessionId: patch.sessionId !== undefined ? patch.sessionId : currentSessionId,
    requiresHumanPhases: patch.requiresHumanPhases ?? existing?.requiresHumanPhases ?? [],
    startedAt: patch.startedAt !== undefined ? patch.startedAt : existing?.startedAt,
    stoppedReason: patch.stoppedReason !== undefined ? patch.stoppedReason : existing?.stoppedReason,
    rebindFrom: patch.rebindFrom !== undefined ? patch.rebindFrom : existing?.rebindFrom,
    lastEscalation: 'lastEscalation' in patch ? patch.lastEscalation : existing?.lastEscalation,
  };
  project.config.drive = merged;
  if (patch.sessionId !== undefined) project.sessionId = patch.sessionId ?? null;
  return merged;
}

function fakeGetDriveState(projectId: string): DriveState | null {
  const project = projects.get(projectId);
  if (!project?.config.drive) return null;
  return { ...project.config.drive, sessionId: project.sessionId ?? undefined };
}

function fakeIsDriveEngaged(projectId: string): boolean {
  const drive = fakeGetDriveState(projectId);
  return !!drive && drive.driver === 'orchestrator' && drive.status !== 'stopped';
}

vi.mock('../db', () => ({
  getHarnessProject: vi.fn((id: string) => projects.get(id)),
  listHarnessProjects: vi.fn(() => [...projects.values()]),
  listHarnessProjectsBySession: vi.fn((sessionId: string) =>
    [...projects.values()].filter((p) => p.sessionId === sessionId),
  ),
  findEngagedDriveBySession: vi.fn(
    (sessionId: string) =>
      [...projects.values()].find((p) => p.sessionId === sessionId && fakeIsDriveEngaged(p.id)) ?? null,
  ),
  getDriveState: vi.fn((id: string) => fakeGetDriveState(id)),
  getDriveSessionId: vi.fn((id: string) => projects.get(id)?.sessionId ?? null),
  isDriveEngaged: vi.fn((id: string) => fakeIsDriveEngaged(id)),
  getOpenLaneSessionById: vi.fn((id: string) =>
    openLanes.has(id) ? { id, laneBadge: openLanes.get(id)!, title: `Lane ${openLanes.get(id)}` } : null,
  ),
  getSession: vi.fn((id: string) => ({ id })),
  setDriveState: vi.fn((id: string, patch: Partial<DriveState>) => fakeSetDriveState(id, patch)),
  getLatestUserTurnIndex: vi.fn(() => 0),
}));

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

const emitted = vi.hoisted(() => ({ calls: [] as Array<{ channel: string; payload: unknown }> }));
vi.mock('../pipeline-shared/ipc-emitter', () => ({
  emitIPC: (channel: string, payload: unknown) => {
    emitted.calls.push({ channel, payload });
  },
}));

import { pipelineEventBus } from '../pipeline-event-bus';
import { _resetDriveLockForTesting, driveOwnerOfProject } from '../drive-lock';
import { clearingSessions, markSessionClearing, unmarkSessionClearing } from '../clearing-sessions';
import { PipelineDriveCoordinator } from '../pipeline-drive-coordinator';

function seed(id: string, over: Partial<FakeProject> & { drive?: Partial<DriveState> } = {}): FakeProject {
  const project: FakeProject = {
    id,
    name: `Pipeline ${id}`,
    pipelineType: 'development',
    status: 'running',
    pipelineCurrentPhase: 3,
    pipelineStartPhase: 1,
    sessionId: over.sessionId !== undefined ? over.sessionId : 'sess_A',
    config: {},
    ...over,
  };
  project.config = {
    drive: {
      driver: 'orchestrator',
      status: 'driving',
      handoff: 'none',
      mode: 'semi',
      requiresHumanPhases: [],
      startedAt: '2026-09-17T09:00:00.000Z',
      ...over.drive,
    },
  };
  projects.set(id, project);
  return project;
}

function driveEvents(): DriveStateChangedEvent[] {
  return emitted.calls
    .filter((c) => c.channel === 'drive:state-changed')
    .map((c) => c.payload as DriveStateChangedEvent);
}

function makeCoordinator(): PipelineDriveCoordinator {
  const coordinator = new PipelineDriveCoordinator(() => null);
  coordinator.start();
  return coordinator;
}

beforeEach(() => {
  vi.clearAllMocks();
  projects.clear();
  openLanes.clear();
  emitted.calls.length = 0;
  clearingSessions.clear();
  pipelineEventBus._resetForTesting();
  _resetDriveLockForTesting();
  openLanes.set('sess_A', 1);
  openLanes.set('sess_B', 2);
});

describe('AC-8 (SPEC 7.3): boot readquire lock e rt para TODO projeto engajado', () => {
  it('awaiting-human em A aberta: lock e rt readquiridos, sem push novo', () => {
    seed('p1', { drive: { status: 'awaiting-human' } as Partial<DriveState> });
    const coordinator = makeCoordinator();

    coordinator.recoverInterruptedDrives();

    expect(driveOwnerOfProject('p1')).toBe('sess_A');
    expect(coordinator.getDrive('p1')?.status).toBe('awaiting-human');
    expect(pushes.assistant).not.toHaveBeenCalled();
    expect(driveEvents()).toHaveLength(0);
  });

  it('driving em A: rebaixado para awaiting-human, com push D4 e lock readquirido', () => {
    seed('p1');
    const coordinator = makeCoordinator();

    coordinator.recoverInterruptedDrives();

    expect(driveOwnerOfProject('p1')).toBe('sess_A');
    expect(projects.get('p1')?.config.drive?.status).toBe('awaiting-human');
    expect(coordinator.getDrive('p1')?.status).toBe('awaiting-human');
    expect(pushes.assistant).toHaveBeenCalledTimes(1);
    expect(pushes.assistant.mock.calls[0]?.[0]).toBe('sess_A');
    expect(String(pushes.assistant.mock.calls[0]?.[1])).toContain('interrompido pelo restart');
    const event = driveEvents().at(-1);
    expect(event).toMatchObject({ projectId: 'p1', sessionId: 'sess_A', laneBadge: 1 });
    expect(event?.drive?.status).toBe('awaiting-human');
  });

  it('handoff temporary: handoffTemporaryPhase restaurado e o auto-resume volta a funcionar apos restart', () => {
    const project = seed('p1', {
      pipelineCurrentPhase: 5,
      drive: {
        status: 'awaiting-human',
        handoff: 'temporary',
        requiresHumanPhases: [5],
      } as Partial<DriveState>,
    });
    const coordinator = makeCoordinator();

    coordinator.recoverInterruptedDrives();
    expect(coordinator.getDrive('p1')?.handoff).toBe('temporary');

    project.pipelineCurrentPhase = 6;
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'p1',
      phase: 6,
      status: 'started',
      awaitingUser: true,
    });

    expect(projects.get('p1')?.config.drive?.status).toBe('driving');
    expect(driveOwnerOfProject('p1')).toBe('sess_A');
  });

  it('lane em Clear (interrupted): lock e rt criados, push ADIADO e entregue por onLaneClearFinished', () => {
    seed('p1');
    markSessionClearing('sess_A', 'interrupted', 1);
    const coordinator = makeCoordinator();

    coordinator.recoverInterruptedDrives();

    expect(driveOwnerOfProject('p1')).toBe('sess_A');
    expect(coordinator.getDrive('p1')?.status).toBe('awaiting-human');
    expect(pushes.assistant).not.toHaveBeenCalled();

    unmarkSessionClearing('sess_A');
    coordinator.onLaneClearFinished('sess_A');

    expect(pushes.assistant).toHaveBeenCalledTimes(1);
    expect(pushes.assistant.mock.calls[0]?.[0]).toBe('sess_A');
    expect(String(pushes.assistant.mock.calls[0]?.[1])).toContain('interrompido pelo restart');
  });

  it('o push adiado segue a lane RESULTANTE do re-bind (conversa nova do Clear)', () => {
    seed('p1');
    markSessionClearing('sess_A', 'running', 1);
    const coordinator = makeCoordinator();
    coordinator.recoverInterruptedDrives();
    expect(pushes.assistant).not.toHaveBeenCalled();

    projects.get('p1')!.sessionId = 'sess_A2';
    openLanes.delete('sess_A');
    openLanes.set('sess_A2', 1);
    unmarkSessionClearing('sess_A');

    coordinator.onLaneClearFinished('sess_A2');

    expect(pushes.assistant).toHaveBeenCalledTimes(1);
    expect(pushes.assistant.mock.calls[0]?.[0]).toBe('sess_A2');
  });

  it('sessao compacted (nao e lane aberta): stopped lane_gone_on_boot + drive:state-changed, sem lock', () => {
    seed('p1', { sessionId: 'sess_compacted' });
    const coordinator = makeCoordinator();

    coordinator.recoverInterruptedDrives();

    expect(projects.get('p1')?.config.drive?.status).toBe('stopped');
    expect(projects.get('p1')?.config.drive?.stoppedReason).toBe('lane_gone_on_boot');
    expect(driveOwnerOfProject('p1')).toBeNull();
    const event = driveEvents().at(-1);
    expect(event?.projectId).toBe('p1');
    expect(event?.drive?.stoppedReason).toBe('lane_gone_on_boot');
    expect(pushes.assistant).not.toHaveBeenCalled();
  });

  it('session_id NULL tambem vira stopped lane_gone_on_boot (nenhuma busca de sessao substituta)', () => {
    seed('p1', { sessionId: null });
    const coordinator = makeCoordinator();

    coordinator.recoverInterruptedDrives();

    expect(projects.get('p1')?.config.drive?.stoppedReason).toBe('lane_gone_on_boot');
    expect(driveOwnerOfProject('p1')).toBeNull();
  });

  it('conflito por lane: o segundo por startedAt vira stopped lane_conflict_on_boot + push na lane', () => {
    seed('p_primeiro', { drive: { startedAt: '2026-09-17T08:00:00.000Z' } as Partial<DriveState> });
    seed('p_segundo', { drive: { startedAt: '2026-09-17T10:00:00.000Z' } as Partial<DriveState> });
    const coordinator = makeCoordinator();

    coordinator.recoverInterruptedDrives();

    expect(driveOwnerOfProject('p_primeiro')).toBe('sess_A');
    expect(driveOwnerOfProject('p_segundo')).toBeNull();
    expect(projects.get('p_segundo')?.config.drive?.stoppedReason).toBe('lane_conflict_on_boot');
    const conflictPush = pushes.assistant.mock.calls.find((call) => String(call[1]).includes('ja esta'));
    expect(conflictPush?.[0]).toBe('sess_A');
  });

  it('pipeline terminal no banco (done) encerra o drive via stopDrive, sem readquirir lock', () => {
    seed('p1', { status: 'done' });
    const coordinator = makeCoordinator();

    coordinator.recoverInterruptedDrives();

    expect(projects.get('p1')?.config.drive?.status).toBe('stopped');
    expect(projects.get('p1')?.config.drive?.stoppedReason).toBeUndefined();
    expect(driveOwnerOfProject('p1')).toBeNull();
    expect(coordinator.getDrive('p1')?.status).toBe('stopped');
  });

  it('drive parado ou assumido pelo humano NAO e tocado pelo recovery', () => {
    seed('p_stopped', { drive: { status: 'stopped' } as Partial<DriveState> });
    seed('p_human', { drive: { driver: 'human' } as Partial<DriveState> });
    const coordinator = makeCoordinator();

    coordinator.recoverInterruptedDrives();

    expect(driveOwnerOfProject('p_stopped')).toBeNull();
    expect(driveOwnerOfProject('p_human')).toBeNull();
    expect(pushes.assistant).not.toHaveBeenCalled();
    expect(driveEvents()).toHaveLength(0);
  });

  it('cada lane aberta recupera o seu drive (varredura cobre TODOS os engajados)', () => {
    seed('p_a', { sessionId: 'sess_A', drive: { startedAt: '2026-09-17T08:00:00.000Z' } as Partial<DriveState> });
    seed('p_b', {
      sessionId: 'sess_B',
      drive: { status: 'awaiting-human', startedAt: '2026-09-17T09:00:00.000Z' } as Partial<DriveState>,
    });
    const coordinator = makeCoordinator();

    coordinator.recoverInterruptedDrives();

    expect(driveOwnerOfProject('p_a')).toBe('sess_A');
    expect(driveOwnerOfProject('p_b')).toBe('sess_B');
    expect(pushes.assistant).toHaveBeenCalledTimes(1);
    expect(pushes.assistant.mock.calls[0]?.[0]).toBe('sess_A');
  });
});

describe('AC-1 (SPEC 7.4): ordem de boot em index.ts', () => {
  it('rebuildClearingSessionsOnBoot roda ANTES de initPipelineDriveCoordinator, com o try/catch preservado', () => {
    const source = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const rebuildAt = source.indexOf('rebuildClearingSessionsOnBoot();');
    const initAt = source.indexOf('initPipelineDriveCoordinator(getMainWindow);');

    expect(rebuildAt).toBeGreaterThan(-1);
    expect(initAt).toBeGreaterThan(-1);
    expect(rebuildAt).toBeLessThan(initAt);
    expect(source.slice(Math.max(0, rebuildAt - 200), rebuildAt)).toContain('try {');
    expect(source.slice(rebuildAt, initAt)).toContain('catch');
  });
});
