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

import { pushAssistantMessage } from '../chat-push';
import { pipelineEventBus } from '../pipeline-event-bus';
import { _resetDriveLockForTesting, driveOwnerOfProject } from '../drive-lock';
import { DRIVE_TOKEN_BUDGET, PipelineDriveCoordinator } from '../pipeline-drive-coordinator';
import { reportDriveTurnUsage, _resetDriveUsageSinkForTesting } from '../drive-usage-sink';

const pushMock = pushAssistantMessage as unknown as ReturnType<typeof vi.fn>;

function seed(id: string): FakeProject {
  const project: FakeProject = {
    id,
    name: id,
    pipelineType: 'development',
    status: 'running',
    pipelineCurrentPhase: 1,
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

describe('AC-4: usage de turno de drive casa por projectId, nunca por sessionId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projects.clear();
    pipelineEventBus._resetForTesting();
    _resetDriveLockForTesting();
    _resetDriveUsageSinkForTesting();
  });

  it('usage de P2 estoura o budget de P2 e NAO toca P1, mesmo com o sessionId de P1 no payload', () => {
    seed('proj_1');
    seed('proj_2');
    const coord = makeCoordinator();
    coord.startDrive('proj_1', 'sess_1', 'full');
    coord.startDrive('proj_2', 'sess_2', 'full');
    pushMock.mockClear();

    reportDriveTurnUsage({
      sessionId: 'sess_1',
      projectId: 'proj_2',
      tokens: DRIVE_TOKEN_BUDGET + 1,
    });

    expect(fakeGetDriveState('proj_2')?.status).toBe('stopped');
    expect(driveOwnerOfProject('proj_2')).toBeNull();
    expect(fakeGetDriveState('proj_1')?.status).toBe('driving');
    expect(driveOwnerOfProject('proj_1')).toBe('sess_1');
    const messages = pushMock.mock.calls.map((call) => String(call[1]));
    expect(messages.some((m) => m.includes('budget de tokens'))).toBe(true);
  });

  it('tokens somam so no runtime do proprio projeto (budget de P1 intacto apos usage de P2)', () => {
    seed('proj_1');
    seed('proj_2');
    const coord = makeCoordinator();
    coord.startDrive('proj_1', 'sess_1', 'full');
    coord.startDrive('proj_2', 'sess_2', 'full');

    reportDriveTurnUsage({
      sessionId: 'sess_2',
      projectId: 'proj_2',
      tokens: DRIVE_TOKEN_BUDGET - 1,
    });
    reportDriveTurnUsage({ sessionId: 'sess_1', projectId: 'proj_1', tokens: 10 });

    expect(fakeGetDriveState('proj_1')?.status).toBe('driving');
    expect(fakeGetDriveState('proj_2')?.status).toBe('driving');

    reportDriveTurnUsage({ sessionId: 'sess_2', projectId: 'proj_2', tokens: 2 });

    expect(fakeGetDriveState('proj_2')?.status).toBe('stopped');
    expect(fakeGetDriveState('proj_1')?.status).toBe('driving');
  });

  it('projeto desconhecido pelo coordenador nao altera contador nenhum (RM6: log e descarte)', () => {
    seed('proj_1');
    const coord = makeCoordinator();
    coord.startDrive('proj_1', 'sess_1', 'full');

    reportDriveTurnUsage({
      sessionId: 'sess_1',
      projectId: 'proj_fantasma',
      tokens: DRIVE_TOKEN_BUDGET + 1,
    });

    expect(fakeGetDriveState('proj_1')?.status).toBe('driving');
    expect(driveOwnerOfProject('proj_1')).toBe('sess_1');
  });
});
