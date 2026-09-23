import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { DriveState } from '../../../src/types';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

interface FakeProject {
  id: string;
  name: string;
  pipelineType?: string;
  status: string;
  pipelineCurrentPhase?: number | null;
  pipelineStartPhase?: number | null;
  config: {
    drive?: DriveState;
    openDesign?: { conversationId?: string; initialPromptSentAt?: string };
  };
}

const projects = new Map<string, FakeProject>();

function fakeGetHarnessProject(id: string): FakeProject | undefined {
  return projects.get(id);
}
function fakeListHarnessProjects(): FakeProject[] {
  return [...projects.values()];
}
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
  };
  project.config.drive = merged;
  return merged;
}

function fakeGetDriveSessionId(projectId: string): string | null {
  return projects.get(projectId)?.config.drive?.sessionId ?? null;
}
function fakeIsDriveEngaged(projectId: string): boolean {
  const drive = fakeGetDriveState(projectId);
  return !!drive && drive.driver === 'orchestrator' && drive.status !== 'stopped';
}
function fakeListHarnessProjectsBySession(sessionId: string): FakeProject[] {
  return [...projects.values()].filter((p) => p.config.drive?.sessionId === sessionId);
}
function fakeFindEngagedDriveBySession(sessionId: string): FakeProject | null {
  return fakeListHarnessProjectsBySession(sessionId).find((p) => fakeIsDriveEngaged(p.id)) ?? null;
}
function fakeGetOpenLaneSessionById(id: string): { id: string; laneBadge: number; title: string } | null {
  if (!id || closedLanes.has(id)) return null;
  return { id, laneBadge: Number(id.replace(/\D/g, '')) || 1, title: id };
}
const closedLanes = new Set<string>();

vi.mock('../db', () => ({
  getHarnessProject: vi.fn((id: string) => fakeGetHarnessProject(id)),
  listHarnessProjects: vi.fn(() => fakeListHarnessProjects()),
  listHarnessProjectsBySession: vi.fn((id: string) => fakeListHarnessProjectsBySession(id)),
  findEngagedDriveBySession: vi.fn((id: string) => fakeFindEngagedDriveBySession(id)),
  getDriveState: vi.fn((id: string) => fakeGetDriveState(id)),
  getDriveSessionId: vi.fn((id: string) => fakeGetDriveSessionId(id)),
  isDriveEngaged: vi.fn((id: string) => fakeIsDriveEngaged(id)),
  getOpenLaneSessionById: vi.fn((id: string) => fakeGetOpenLaneSessionById(id)),
  getSession: vi.fn((id: string) => ({ id })),
  setDriveState: vi.fn((id: string, patch: Partial<DriveState>) => fakeSetDriveState(id, patch)),
  getLatestUserTurnIndex: vi.fn(() => 0),
}));

vi.mock('../chat-push', () => ({
  pushAssistantMessage: vi.fn(() => 1),
  pushDrivePaused: vi.fn(),
}));

vi.mock('../telegram-bridge', () => ({
  notifyDriveHandoff: vi.fn(async () => {}),
}));

vi.mock('../activity-log', () => ({
  recordActivity: vi.fn(),
}));

vi.mock('../orchestrator', () => ({
  submitMessage: vi.fn(),
}));

vi.mock('../pipeline-control-core', () => ({
  resolvePendingQuestion: vi.fn(() => 'O agente da fase perguntou algo.'),
  getCachedPhaseChanged: vi.fn(() => null),
}));

import { pushAssistantMessage } from '../chat-push';
import { submitMessage } from '../orchestrator';
import { pipelineEventBus } from '../pipeline-event-bus';
import { _resetDriveLockForTesting } from '../drive-lock';
import { PipelineDriveCoordinator, GREETING_DONE_TIMEOUT_MS } from '../pipeline-drive-coordinator';
import { reportDriveTurnComplete, _resetDriveUsageSinkForTesting } from '../drive-usage-sink';

function seedProject(over: Partial<FakeProject> = {}): FakeProject {
  const p: FakeProject = {
    id: over.id ?? 'proj_a',
    name: over.name ?? 'Demo',
    pipelineType: over.pipelineType ?? 'development',
    status: over.status ?? 'running',
    pipelineCurrentPhase: over.pipelineCurrentPhase ?? 1,
    pipelineStartPhase: over.pipelineStartPhase ?? 1,
    config: over.config ?? {},
  };
  projects.set(p.id, p);
  return p;
}

function makeCoordinator(): PipelineDriveCoordinator {
  const coord = new PipelineDriveCoordinator(() => null);
  coord.start();
  return coord;
}

const submitMock = submitMessage as Mock;
const pushMock = pushAssistantMessage as Mock;

function emitStarted(projectId: string, phase: number): void {
  pipelineEventBus.emit('pipeline:phase-changed', {
    projectId,
    phase,
    status: 'started',
    awaitingUser: true,
  });
}

function emitGreetingDone(projectId: string, phase: number): void {
  pipelineEventBus.emit('pipeline:stream', { projectId, phase, type: 'done' });
}

describe('greeting-gate (SPRINT-B / BUG-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projects.clear();
    pipelineEventBus._resetForTesting();
    _resetDriveLockForTesting();
    _resetDriveUsageSinkForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('B-AC1: started/awaitingUser de fase conversacional -> fireOrchestratorTurn SO apos o stream done do greeting (ordem assertada, exatamente 1 turno)', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 2 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    submitMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 3;
    emitStarted('proj_a', 3);

    expect(submitMock).not.toHaveBeenCalled();

    emitGreetingDone('proj_a', 3);

    expect(submitMock).toHaveBeenCalledTimes(1);

    function latestTurnId(): string {
      const calls = submitMock.mock.calls;
      return (calls[calls.length - 1][1] as { driveTurnId?: string }).driveTurnId ?? '';
    }
    vi.advanceTimersByTime(1);
    reportDriveTurnComplete('proj_a', latestTurnId());
    vi.advanceTimersByTime(1);
    project.pipelineCurrentPhase = 4;
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 4,
      status: 'started',
      awaitingUser: false, // fase 4 = PRD Completo (auto): nao arma gate nem dispara
    });
    vi.advanceTimersByTime(1);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('B-AC2: done atrasado -> nenhum reply/turno corre antes do done (zero erro "no active threadId" simulado)', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 2 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    submitMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 3;
    emitStarted('proj_a', 3);

    emitStarted('proj_a', 3);
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 3,
      status: 'running',
      awaitingUser: true,
    });
    expect(submitMock).not.toHaveBeenCalled();

    emitGreetingDone('proj_a', 3);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('B-AC3: greeting que nunca fecha -> timeout ESCALA (pushAssistantMessage + drive awaiting-human) e NUNCA dispara turno', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 2 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    submitMock.mockClear();
    pushMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 3;
    emitStarted('proj_a', 3);
    vi.advanceTimersByTime(GREETING_DONE_TIMEOUT_MS + 1);

    expect(pushMock).toHaveBeenCalled();
    const msg = pushMock.mock.calls.at(-1)?.[1] as string;
    expect(msg).toContain('fase 3');
    expect(fakeGetDriveState('proj_a')?.status).toBe('awaiting-human');
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('B3 (janela de silencio): atividade de stream REARMA o timer - greeting longo TRABALHANDO nao escala; silencio real escala', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 9 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    submitMock.mockClear();
    pushMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 10;
    emitStarted('proj_a', 10);

    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(GREETING_DONE_TIMEOUT_MS - 1000);
      pipelineEventBus.emit('pipeline:stream', {
        projectId: 'proj_a',
        phase: 10,
        type: 'tool_call',
        tool: 'Read',
      });
    }
    expect(pushMock).not.toHaveBeenCalled();
    expect(fakeGetDriveState('proj_a')?.status).toBe('driving');
    expect(submitMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(GREETING_DONE_TIMEOUT_MS + 1);
    expect(pushMock).toHaveBeenCalled();
    const msg = pushMock.mock.calls.at(-1)?.[1] as string;
    expect(msg).toContain('fase 10');
    expect(fakeGetDriveState('proj_a')?.status).toBe('awaiting-human');
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('B-AC3 (rev7 P2): timeout SEM drive engajado marca timedOut e mantem a entrada; engate tardio escala imediatamente e nunca dispara', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 1 });
    const coord = makeCoordinator();
    emitStarted('proj_a', 1);

    vi.advanceTimersByTime(GREETING_DONE_TIMEOUT_MS + 1);
    expect(submitMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();

    coord.startDrive('proj_a', 'sess_1', 'semi');
    expect(submitMock).not.toHaveBeenCalled();
    expect(fakeGetDriveState('proj_a')?.status).toBe('awaiting-human');
    const msg = pushMock.mock.calls.at(-1)?.[1] as string;
    expect(msg).toContain('fase 1');
  });

  it('B-AC4: fase auto/loop nao arma o gate e nao atrasa nada', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 1 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    submitMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 13;
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 13,
      status: 'started',
      awaitingUser: false,
    });
    expect(submitMock).not.toHaveBeenCalled();

    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 13, type: 'done' });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('B-AC5: re-entrada pos-greeting na mesma fase dispara normal (gate nao rearma apos done)', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 2 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    submitMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 3;
    emitStarted('proj_a', 3);
    expect(submitMock).not.toHaveBeenCalled();
    emitGreetingDone('proj_a', 3);
    expect(submitMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);

    function latestTurnId(): string {
      const calls = submitMock.mock.calls;
      return (calls[calls.length - 1][1] as { driveTurnId?: string }).driveTurnId ?? '';
    }
    let prevCount = -1;
    while (submitMock.mock.calls.length !== prevCount) {
      prevCount = submitMock.mock.calls.length;
      reportDriveTurnComplete('proj_a', latestTurnId());
      vi.advanceTimersByTime(1);
    }
    submitMock.mockClear();

    emitGreetingDone('proj_a', 3);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('B-AC6: fluxo humano (pipeline:send, sem drive) intocado pelo gate', () => {
    vi.useFakeTimers();
    seedProject({ id: 'proj_humano', pipelineType: 'development', pipelineCurrentPhase: 1 });
    makeCoordinator();

    emitStarted('proj_humano', 1);
    emitGreetingDone('proj_humano', 1);
    expect(submitMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();

    emitStarted('proj_humano', 3);
    vi.advanceTimersByTime(GREETING_DONE_TIMEOUT_MS + 1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('B-AC7: resumeDrive numa fase conversacional fresca tambem serializa (evaluateNow :760 bloqueado ate o done)', () => {
    vi.useFakeTimers();
    seedProject({
      pipelineType: 'development',
      pipelineCurrentPhase: 3,
      config: {
        drive: {
          driver: 'orchestrator',
          status: 'awaiting-human',
          handoff: 'none',
          mode: 'semi',
          sessionId: 'sess_1',
          requiresHumanPhases: [],
        },
      },
    });
    const coord = makeCoordinator();

    emitStarted('proj_a', 3);
    submitMock.mockClear();

    const res = coord.resumeDrive('proj_a');
    expect(res.ok).toBe(true);
    expect(submitMock).not.toHaveBeenCalled();

    emitGreetingDone('proj_a', 3);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('B-AC8: follow-up coalescido (releaseTurnGate :1130) respeita o greeting-gate', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 1 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    expect(submitMock).toHaveBeenCalledTimes(1);

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 3;
    emitStarted('proj_a', 3);
    expect(submitMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 3,
      status: 'running',
      awaitingUser: true,
    });
    expect(submitMock).toHaveBeenCalledTimes(1);

    emitGreetingDone('proj_a', 3);
    expect(submitMock).toHaveBeenCalledTimes(2);
  });

  it('B-AC9: containment dos 5 caminhos (startDrive/resumeDrive/onStream/releaseTurnGate/onPhaseChanged) - NENHUM dispara fireOrchestratorTurn com o gate armado', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();

    emitStarted('proj_a', 3);
    submitMock.mockClear();

    coord.startDrive('proj_a', 'sess_1', 'semi');
    expect(submitMock).not.toHaveBeenCalled();

    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 3,
      status: 'running',
      awaitingUser: true,
    });
    expect(submitMock).not.toHaveBeenCalled();

    fakeSetDriveState('proj_a', { status: 'awaiting-human' });
    coord.resumeDrive('proj_a');
    expect(submitMock).not.toHaveBeenCalled();
    expect(fakeGetDriveState('proj_a')?.status).toBe('driving');

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 2;
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 2,
      status: 'running',
      awaitingUser: true,
    });
    expect(submitMock).toHaveBeenCalledTimes(1);
    const inflightTurnId = (submitMock.mock.calls.at(-1)?.[1] as { driveTurnId?: string }).driveTurnId ?? '';
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 2,
      status: 'running',
      awaitingUser: true,
    });
    expect(submitMock).toHaveBeenCalledTimes(1);
    submitMock.mockClear();
    project.pipelineCurrentPhase = 3;
    reportDriveTurnComplete('proj_a', inflightTurnId);
    vi.advanceTimersByTime(1);
    expect(submitMock).not.toHaveBeenCalled();

    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 2, type: 'done' });
    expect(submitMock).not.toHaveBeenCalled();

    emitGreetingDone('proj_a', 3);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('B-AC10: fase OD (open-design-studio) NAO arma o greeting-gate; faixa silenciosa nao trava nem escala (C-03)', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 5 });
    const coord = makeCoordinator();
    const res = coord.startDrive('proj_a', 'sess_1', 'semi');
    expect(res.ok).toBe(true);

    expect(submitMock).not.toHaveBeenCalled();

    pushMock.mockClear();
    vi.advanceTimersByTime(GREETING_DONE_TIMEOUT_MS + 1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(fakeGetDriveState('proj_a')?.status).toBe('driving');
  });

  it('B-AC10b: phase-changed started da fase OD (caminho do armGreetingGate) NAO arma o gate (mutante !isOpenDesignStudioPhase morre)', () => {
    vi.useFakeTimers();
    seedProject({
      pipelineType: 'development-v2',
      pipelineCurrentPhase: 4, // Design Plan (auto): engata o drive sem mexer na OD
      config: { openDesign: { conversationId: 'conv_od_1' } },
    });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    submitMock.mockClear();
    pushMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 5;
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 5,
      status: 'started',
      awaitingUser: true,
    });

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0][1]).toContain('design');
    pushMock.mockClear();

    vi.advanceTimersByTime(GREETING_DONE_TIMEOUT_MS + 1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(fakeGetDriveState('proj_a')?.status).toBe('driving');
  });

  it('C-05: started (awaitingUser:false) da fase 12 dev-v2 (loop) NAO arma o gate -> timeout NAO escala (mutante !isSpecLoopActive morre)', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 7 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    submitMock.mockClear();
    pushMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 12;
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 12,
      status: 'started',
      awaitingUser: false,
    });

    vi.advanceTimersByTime(GREETING_DONE_TIMEOUT_MS + 1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
    expect(fakeGetDriveState('proj_a')?.status).toBe('driving');
  });

  it('C-05: started com awaitingUser:true na fase 12 dev-v2 (loop) tambem NAO arma o gate (robusto ao flag do payload)', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 7 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    submitMock.mockClear();
    pushMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 12;
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 12,
      status: 'started',
      awaitingUser: true,
    });

    vi.advanceTimersByTime(GREETING_DONE_TIMEOUT_MS + 1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
    expect(fakeGetDriveState('proj_a')?.status).toBe('driving');
  });

  it('C-05 feature fase 9 (spec-builder, loop): started awaitingUser:false NAO arma o gate -> timeout NAO escala', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'feature', pipelineCurrentPhase: 2 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    submitMock.mockClear();
    pushMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 9;
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 9,
      status: 'started',
      awaitingUser: false,
    });

    vi.advanceTimersByTime(GREETING_DONE_TIMEOUT_MS + 1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
    expect(fakeGetDriveState('proj_a')?.status).toBe('driving');
  });

  it('C-05 feature fase 9 (spec-builder, loop): started awaitingUser:true tambem NAO arma o gate (robusto ao flag do payload)', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'feature', pipelineCurrentPhase: 2 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    submitMock.mockClear();
    pushMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 9;
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 9,
      status: 'started',
      awaitingUser: true,
    });

    vi.advanceTimersByTime(GREETING_DONE_TIMEOUT_MS + 1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
    expect(fakeGetDriveState('proj_a')?.status).toBe('driving');
  });

  it('C-05 security fase 6 (spec-builder, loop): started awaitingUser:false NAO arma o gate -> timeout NAO escala', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'security', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    submitMock.mockClear();
    pushMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 6;
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 6,
      status: 'started',
      awaitingUser: false,
    });

    vi.advanceTimersByTime(GREETING_DONE_TIMEOUT_MS + 1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
    expect(fakeGetDriveState('proj_a')?.status).toBe('driving');
  });

  it('C-05 security fase 6 (spec-builder, loop): started awaitingUser:true tambem NAO arma o gate (robusto ao flag do payload)', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'security', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    submitMock.mockClear();
    pushMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 6;
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 6,
      status: 'started',
      awaitingUser: true,
    });

    vi.advanceTimersByTime(GREETING_DONE_TIMEOUT_MS + 1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
    expect(fakeGetDriveState('proj_a')?.status).toBe('driving');
  });

  it('B-AC11 (P1-1): emitir started e SO DEPOIS chamar startDrive (engate tardio) -> turno SO apos o done (zero fireOrchestratorTurn antes)', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 1 });
    const coord = makeCoordinator();
    emitStarted('proj_a', 1);

    coord.startDrive('proj_a', 'sess_1', 'semi');
    expect(submitMock).not.toHaveBeenCalled();

    emitGreetingDone('proj_a', 1);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('B-AC13 (rev8 P1): re-entrada FRESCA da mesma fase via novo started (reset/avanco-e-volta) REARMA o gate -> turno espera o NOVO done', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 2 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    submitMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 3;

    emitStarted('proj_a', 3);
    expect(submitMock).not.toHaveBeenCalled();
    emitGreetingDone('proj_a', 3);
    expect(submitMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);

    function latestTurnId(): string {
      const calls = submitMock.mock.calls;
      return (calls[calls.length - 1][1] as { driveTurnId?: string }).driveTurnId ?? '';
    }
    let prevCount = -1;
    while (submitMock.mock.calls.length !== prevCount) {
      prevCount = submitMock.mock.calls.length;
      reportDriveTurnComplete('proj_a', latestTurnId());
      vi.advanceTimersByTime(1);
    }
    submitMock.mockClear();

    emitStarted('proj_a', 3);
    expect(submitMock).not.toHaveBeenCalled();

    emitGreetingDone('proj_a', 3);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('B-AC13b (rev8 P1): novo started rearma LIMPO mesmo com entrada timedOut residual da ocupacao anterior (timer velho cancelado, espera o novo done)', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 3 });
    makeCoordinator();

    emitStarted('proj_a', 3);
    vi.advanceTimersByTime(GREETING_DONE_TIMEOUT_MS + 1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();

    emitStarted('proj_a', 3);
    vi.advanceTimersByTime(1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();

    emitGreetingDone('proj_a', 3);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('B-AC12 (P1-2): com pendingFollowup represado, started de fase conversacional fresca -> releaseTurnGate NAO dispara turno ate o done (zero fireOrchestratorTurn)', () => {
    vi.useFakeTimers();
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 1 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    expect(submitMock).toHaveBeenCalledTimes(1);

    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 1, type: 'done' });
    expect(submitMock).toHaveBeenCalledTimes(1);
    submitMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 3;
    emitStarted('proj_a', 3);
    expect(submitMock).not.toHaveBeenCalled();

    emitGreetingDone('proj_a', 3);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });
});
