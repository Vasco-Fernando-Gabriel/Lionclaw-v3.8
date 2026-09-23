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
  const stored: DriveState = { ...merged };
  if (stored.lastEscalation === undefined) delete stored.lastEscalation;
  project.config.drive = stored;
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
vi.mock('../telegram-bridge', () => ({ notifyDriveHandoff: vi.fn() }));

import { submitMessage } from '../orchestrator';
import { getDriveState } from '../db';
import { pipelineEventBus } from '../pipeline-event-bus';
import { _resetDriveLockForTesting, driveOwnerOfProject } from '../drive-lock';
import { clearingSessions } from '../clearing-sessions';
import { PipelineDriveCoordinator } from '../pipeline-drive-coordinator';

const submitMock = vi.mocked(submitMessage);
const ESCALATION = 'Posso aplicar a migration destrutiva da fase 3?';
const RECAP_PREFIX = 'Pergunta escalada pendente (antes da pausa):';

function promptOfCall(n: number): string {
  return String(submitMock.mock.calls[n]?.[0] ?? '');
}

function sessionOfCall(n: number): string | undefined {
  return (submitMock.mock.calls[n]?.[1] as { sessionId?: string } | undefined)?.sessionId;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

function makeCoordinator(): PipelineDriveCoordinator {
  const coordinator = new PipelineDriveCoordinator(() => null);
  coordinator.start();
  return coordinator;
}

beforeEach(() => {
  vi.clearAllMocks();
  projects.clear();
  openLanes.clear();
  clearingSessions.clear();
  pipelineEventBus._resetForTesting();
  _resetDriveLockForTesting();
  openLanes.set('sess_A', 1);
});

describe('AC-7 (SPEC 5/R1): pergunta escalada pendente re-injetada no Retomar', () => {
  it('escalate persiste lastEscalation; Clear force para o drive e a pergunta sobrevive ao stopped', async () => {
    seed('p1', 'sess_A');
    const coordinator = makeCoordinator();
    coordinator.startDrive('p1', 'sess_A', 'semi');
    await flush();

    coordinator.escalateFromOrchestrator('p1', ESCALATION);

    expect(getDriveState('p1')).toMatchObject({
      status: 'awaiting-human',
      lastEscalation: ESCALATION,
    });

    coordinator.stopDrive('p1', 'lane-clear-force');

    const afterStop = getDriveState('p1');
    expect(afterStop?.status).toBe('stopped');
    expect(afterStop?.lastEscalation).toBe(ESCALATION);
    expect(driveOwnerOfProject('p1')).toBeNull();
  });

  it('fluxo completo: escalate, stop, re-bind e resumeDrive(P1, A) injetam a pergunta e a limpam apos o turno', async () => {
    seed('p1', 'sess_A');
    const coordinator = makeCoordinator();
    coordinator.startDrive('p1', 'sess_A', 'semi');
    await flush();
    coordinator.escalateFromOrchestrator('p1', ESCALATION);
    coordinator.stopDrive('p1', 'lane-clear-force');

    projects.get('p1')!.sessionId = 'sess_A2';
    projects.get('p1')!.config.drive!.rebindFrom = 'sess_A';
    openLanes.delete('sess_A');
    openLanes.set('sess_A2', 1);
    submitMock.mockClear();

    expect(getDriveState('p1')?.status).toBe('stopped');
    const resumed = coordinator.resumeDrive('p1', 'sess_A2', { fromHuman: true });
    expect(resumed.ok).toBe(true);

    expect(submitMock).toHaveBeenCalledTimes(1);
    const prompt = promptOfCall(0);
    expect(prompt).toContain(`${RECAP_PREFIX} ${ESCALATION}`);
    expect(sessionOfCall(0)).toBe('sess_A2');

    expect(getDriveState('p1')?.lastEscalation).toBeUndefined();
    expect(getDriveState('p1')?.status).toBe('driving');

    await flush();
    submitMock.mockClear();
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'p1',
      phase: 3,
      status: 'awaiting-input',
      awaitingUser: true,
    });
    await flush();
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(promptOfCall(0)).not.toContain(RECAP_PREFIX);
  });

  it('o bloco da pergunta escalada vem ANTES do interject do humano no prompt', async () => {
    seed('p1', 'sess_A');
    const coordinator = makeCoordinator();
    coordinator.startDrive('p1', 'sess_A', 'semi');
    await flush();
    coordinator.escalateFromOrchestrator('p1', ESCALATION);
    submitMock.mockClear();

    const resumed = coordinator.resumeDrive('p1', 'sess_A', {
      fromHuman: true,
      humanInterject: 'pode aplicar sim',
    });
    expect(resumed.ok).toBe(true);

    const prompt = promptOfCall(0);
    const recapAt = prompt.indexOf(RECAP_PREFIX);
    const interjectAt = prompt.indexOf('O HUMANO RESPONDEU DIRETO NA CONVERSA DA FASE');
    expect(recapAt).toBeGreaterThan(-1);
    expect(interjectAt).toBeGreaterThan(-1);
    expect(recapAt).toBeLessThan(interjectAt);
    expect(prompt).toContain('pode aplicar sim');
  });

  it('sem escalacao pendente o prompt do Retomar nao ganha o bloco novo', async () => {
    seed('p1', 'sess_A');
    const coordinator = makeCoordinator();
    coordinator.startDrive('p1', 'sess_A', 'semi');
    await flush();

    expect(promptOfCall(0)).not.toContain(RECAP_PREFIX);
    expect(getDriveState('p1')?.lastEscalation).toBeUndefined();
  });

  it('pipeline failed tambem grava a pergunta de pausa como lastEscalation', async () => {
    seed('p1', 'sess_A');
    const coordinator = makeCoordinator();
    coordinator.startDrive('p1', 'sess_A', 'semi');
    await flush();

    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'p1',
      phase: 3,
      status: 'failed',
    });

    const persisted = getDriveState('p1');
    expect(persisted?.status).toBe('awaiting-human');
    expect(persisted?.lastEscalation).toContain('Quer que eu investigue ou prefere assumir?');

    submitMock.mockClear();
    coordinator.resumeDrive('p1', 'sess_A', { fromHuman: true });
    expect(promptOfCall(0)).toContain(RECAP_PREFIX);
    expect(getDriveState('p1')?.lastEscalation).toBeUndefined();
  });
});
