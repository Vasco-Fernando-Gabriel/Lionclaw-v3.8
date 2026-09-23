import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveState } from '../../../src/types';

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
  const merged: DriveState = {
    driver: patch.driver ?? existing?.driver ?? 'orchestrator',
    status: patch.status ?? existing?.status ?? 'driving',
    handoff: patch.handoff ?? existing?.handoff ?? 'none',
    mode: patch.mode ?? existing?.mode ?? 'semi',
    sessionId: patch.sessionId !== undefined ? patch.sessionId : (project.sessionId ?? existing?.sessionId),
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

vi.mock('../chat-push', () => ({
  pushAssistantMessage: vi.fn(() => 1),
  pushDrivePaused: vi.fn(),
}));
vi.mock('../activity-log', () => ({ recordActivity: vi.fn() }));
vi.mock('../orchestrator', () => ({ submitMessage: vi.fn() }));
vi.mock('../pipeline-control-core', () => ({
  resolvePendingQuestion: vi.fn(() => 'O agente da fase perguntou algo.'),
  getCachedPhaseChanged: vi.fn(() => null),
}));
vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: vi.fn() }));

import { submitMessage } from '../orchestrator';
import { pipelineEventBus } from '../pipeline-event-bus';
import { _resetDriveLockForTesting } from '../drive-lock';
import { clearingSessions, isSessionClearing, markSessionClearing, unmarkSessionClearing } from '../clearing-sessions';
import { createLaneClearer, type ClearLaneDeps } from '../chat-clear-core';
import { resetDreamingMutexForTests, acquireDreamingMutex } from '../dreaming-mutex';
import { PipelineDriveCoordinator } from '../pipeline-drive-coordinator';

const submitMock = vi.mocked(submitMessage);

interface RuntimePeek {
  drive: DriveState;
  turnsThisPhase: number;
  tickTimer: NodeJS.Timeout | null;
  pendingTickTurn: boolean;
  turnInFlightSince: number | null;
  pendingHumanInterject: string | null;
}

function peek(coordinator: PipelineDriveCoordinator, projectId: string): RuntimePeek {
  const states = (coordinator as unknown as { states: Map<string, RuntimePeek> }).states;
  const rt = states.get(projectId);
  expect(rt, `runtime de ${projectId}`).toBeDefined();
  return rt!;
}

function seed(id: string, sessionId: string): FakeProject {
  const project: FakeProject = {
    id,
    name: `Pipeline ${id}`,
    pipelineType: 'development',
    status: 'running',
    pipelineCurrentPhase: 3,
    pipelineStartPhase: 1,
    sessionId,
    config: {},
  };
  projects.set(id, project);
  return project;
}

function emitSamePhaseGate(projectId: string): void {
  pipelineEventBus.emit('pipeline:phase-changed', {
    projectId,
    phase: 3,
    status: 'awaiting-input',
    awaitingUser: true,
  });
}

function makeCoordinator(): PipelineDriveCoordinator {
  const coordinator = new PipelineDriveCoordinator(() => null);
  coordinator.start();
  return coordinator;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  projects.clear();
  openLanes.clear();
  clearingSessions.clear();
  pipelineEventBus._resetForTesting();
  _resetDriveLockForTesting();
  resetDreamingMutexForTests();
  openLanes.set('sess_A', 1);
  openLanes.set('sess_B', 2);
});

describe('AC-15 (SPEC 7.4): lane em Clear nao enfileira nem conta turno de drive', () => {
  it('turno de drive na lane em Clear: sem submitMessage, sem incremento, tick desarmado e pendingTickTurn', async () => {
    seed('p1', 'sess_A');
    const coordinator = makeCoordinator();
    coordinator.startDrive('p1', 'sess_A', 'semi');
    await flush();

    expect(submitMock).toHaveBeenCalledTimes(1);
    const before = peek(coordinator, 'p1');
    expect(before.turnsThisPhase).toBe(1);
    expect(before.tickTimer).not.toBeNull();

    markSessionClearing('sess_A', 'running', 1);
    emitSamePhaseGate('p1');

    const rt = peek(coordinator, 'p1');
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(rt.turnsThisPhase).toBe(1);
    expect(rt.tickTimer).toBeNull();
    expect(rt.pendingTickTurn).toBe(true);
  });

  it('a mesma lane FORA do Clear enfileira e conta o turno (controle do gate)', async () => {
    seed('p1', 'sess_A');
    const coordinator = makeCoordinator();
    coordinator.startDrive('p1', 'sess_A', 'semi');
    await flush();
    submitMock.mockClear();

    emitSamePhaseGate('p1');
    await flush();

    const rt = peek(coordinator, 'p1');
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(rt.turnsThisPhase).toBe(2);
    expect(rt.tickTimer).not.toBeNull();
    expect(rt.pendingTickTurn).toBe(false);
  });

  it('Clear numa OUTRA lane nao afeta o drive desta lane', async () => {
    seed('p1', 'sess_A');
    const coordinator = makeCoordinator();
    coordinator.startDrive('p1', 'sess_A', 'semi');
    await flush();
    submitMock.mockClear();

    markSessionClearing('sess_B', 'running', 2);
    emitSamePhaseGate('p1');
    await flush();

    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(peek(coordinator, 'p1').tickTimer).not.toBeNull();
  });

  it('o turno HUMANO em voo na lane em Clear nao e afetado: so o turno de DRIVE deixa de ser enfileirado', async () => {
    seed('p1', 'sess_A');
    const coordinator = makeCoordinator();
    coordinator.startDrive('p1', 'sess_A', 'semi');
    await flush();
    submitMock.mockClear();

    markSessionClearing('sess_A', 'running', 1);
    pipelineEventBus.emit('pipeline:human-message', {
      projectId: 'p1',
      content: 'pode aprovar esse gate',
    });
    emitSamePhaseGate('p1');

    const rt = peek(coordinator, 'p1');
    expect(rt.pendingHumanInterject).toBe('pode aprovar esse gate');
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('apos onLaneClearFinished(A) o tick rearma e o turno represado sai', async () => {
    seed('p1', 'sess_A');
    const coordinator = makeCoordinator();
    coordinator.startDrive('p1', 'sess_A', 'semi');
    await flush();
    submitMock.mockClear();

    markSessionClearing('sess_A', 'running', 1);
    emitSamePhaseGate('p1');
    expect(peek(coordinator, 'p1').tickTimer).toBeNull();
    expect(submitMock).not.toHaveBeenCalled();

    unmarkSessionClearing('sess_A');
    coordinator.onLaneClearFinished('sess_A');
    await flush();

    const rt = peek(coordinator, 'p1');
    expect(rt.tickTimer).not.toBeNull();
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(rt.turnsThisPhase).toBe(2);
  });

  it('onLaneClearFinished de outra lane nao rearma o tick desta', async () => {
    seed('p1', 'sess_A');
    const coordinator = makeCoordinator();
    coordinator.startDrive('p1', 'sess_A', 'semi');
    await flush();
    markSessionClearing('sess_A', 'running', 1);
    emitSamePhaseGate('p1');
    submitMock.mockClear();

    coordinator.onLaneClearFinished('sess_B');

    expect(peek(coordinator, 'p1').tickTimer).toBeNull();
    expect(submitMock).not.toHaveBeenCalled();
  });
});

describe('AC-15 (conclusao real do Clear): createLaneClearer chama onLaneClearFinished na lane RESULTANTE', () => {
  function clearerFor(
    coordinator: PipelineDriveCoordinator,
    onReplace: (sessionId: string, newSessionId: string) => void,
  ) {
    const sessions = new Map<string, { id: string; status: string; type: string; laneBadge: number | null }>([
      ['sess_A', { id: 'sess_A', status: 'active', type: 'chat', laneBadge: 1 }],
    ]);
    const deps = {
      getSession: (id: string) => sessions.get(id),
      countSessionMessages: () => 4,
      isOpenDesktopConversation: (s: { status: string; type: string; id: string }) =>
        s.status === 'active' && (s.type === 'chat' || s.type === 'manual'),
      setDreamingStartedAt: vi.fn(),
      replaceLaneSession: (input: { sessionId: string }) => {
        const newSessionId = `${input.sessionId}2`;
        onReplace(input.sessionId, newSessionId);
        return { newSessionId };
      },
      getSessionsWithDreamingStarted: () => [],
      getExecutionState: () => 'idle' as const,
      isCompacting: () => false,
      listActiveDriveProjectIds: () => [],
      stopDrive: vi.fn(),
      onLaneClearFinished: (sessionId: string) => coordinator.onLaneClearFinished(sessionId),
      stopSessionQuery: vi.fn(),
      awaitTurnSettled: async () => ({ settled: true as const }),
      readSettleTimeoutMs: () => 1_000,
      acquireDreamingMutex,
      runCompaction: async () => ({ executiveSummary: 'resumo', warnings: [] }),
      resolveModelLabel: async () => 'modelo',
      readDefaultOrchestrator: () => null,
      closeCodexSession: vi.fn(),
      emitCompactionActive: vi.fn(),
      emitSessionsUpdated: vi.fn(),
      now: () => new Date('2026-09-17T12:00:00.000Z'),
    } as unknown as ClearLaneDeps;
    return createLaneClearer(deps);
  }

  it('o Clear concluido rearma o tick do drive re-apontado para a conversa nova', async () => {
    seed('p1', 'sess_A');
    const coordinator = makeCoordinator();
    coordinator.startDrive('p1', 'sess_A', 'semi');
    await flush();

    const clearer = clearerFor(coordinator, (oldSessionId, newSessionId) => {
      for (const project of projects.values()) {
        if (project.sessionId === oldSessionId) {
          project.sessionId = newSessionId;
          if (project.config.drive) project.config.drive.sessionId = newSessionId;
        }
      }
      openLanes.delete(oldSessionId);
      openLanes.set(newSessionId, 1);
    });

    markSessionClearing('sess_A', 'running', 1);
    emitSamePhaseGate('p1');
    expect(peek(coordinator, 'p1').tickTimer).toBeNull();
    unmarkSessionClearing('sess_A');
    submitMock.mockClear();

    const result = await clearer.clearLaneSession('sess_A');
    await flush();

    expect(result).toMatchObject({ ok: true, newSessionId: 'sess_A2' });
    expect(isSessionClearing('sess_A')).toBe(false);
    expect(projects.get('p1')?.sessionId).toBe('sess_A2');
    const rt = peek(coordinator, 'p1');
    expect(rt.tickTimer).not.toBeNull();
    expect(submitMock).toHaveBeenCalledTimes(1);
  });
});
