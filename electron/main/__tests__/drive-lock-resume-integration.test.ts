import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { DriveState } from '../../../src/types';

interface DriveTurnOptions {
  sessionId: string;
  origin?: string;
  driveProjectId?: string;
  drivePhase?: number;
  driveTurnId?: string;
}

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
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
  config: { drive?: DriveState };
}

const projects = new Map<string, FakeProject>();

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

function fakeIsDriveEngaged(projectId: string): boolean {
  const drive = projects.get(projectId)?.config.drive;
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
  getDriveState: vi.fn((id: string) => projects.get(id)?.config.drive ?? null),
  getDriveSessionId: vi.fn((id: string) => projects.get(id)?.config.drive?.sessionId ?? null),
  isDriveEngaged: vi.fn((id: string) => fakeIsDriveEngaged(id)),
  getOpenLaneSessionById: vi.fn((id: string) =>
    id ? { id, laneBadge: Number(id.replace(/\D/g, '')) || 1, title: id } : null,
  ),
  getSession: vi.fn((id: string) => ({ id })),
  setDriveState: vi.fn((id: string, patch: Partial<DriveState>) => fakeSetDriveState(id, patch)),
  getLatestUserTurnIndex: vi.fn(() => 0),
}));

vi.mock('../chat-push', () => ({ pushAssistantMessage: vi.fn(() => 1) }));
vi.mock('../activity-log', () => ({ recordActivity: vi.fn() }));
vi.mock('../orchestrator', () => ({ submitMessage: vi.fn() }));
vi.mock('../pipeline-control-core', () => ({
  resolvePendingQuestion: vi.fn(() => 'O agente da fase perguntou algo.'),
  getCachedPhaseChanged: vi.fn(() => null),
}));

import { submitMessage } from '../orchestrator';
import { pipelineEventBus } from '../pipeline-event-bus';
import { _resetDriveLockForTesting, driveOwnerOfProject } from '../drive-lock';
import { PipelineDriveCoordinator } from '../pipeline-drive-coordinator';

const submitMock = submitMessage as Mock;

const ODS_PHASE = 5;
const FIRST_ACTIONABLE_AFTER_LOCK = 8;

function seedDevV2(currentPhase: number): FakeProject {
  const p: FakeProject = {
    id: 'proj_v2',
    name: 'Multichat',
    pipelineType: 'development-v2',
    status: 'running',
    pipelineCurrentPhase: currentPhase,
    pipelineStartPhase: 1,
    config: {},
  };
  projects.set(p.id, p);
  return p;
}

function discardsByF7Contract(opts: DriveTurnOptions): boolean {
  if (opts.origin !== 'system-event' || !opts.driveProjectId) return false;
  if (typeof opts.drivePhase !== 'number') return false;
  const realPhase = projects.get(opts.driveProjectId)?.pipelineCurrentPhase;
  if (typeof realPhase !== 'number') return false;
  return opts.drivePhase < realPhase;
}

function optsOfCall(n: number): DriveTurnOptions {
  return submitMock.mock.calls[n]?.[1] as DriveTurnOptions;
}

describe('W4.3 - retomada pos-lock no primeiro ponto acionavel + descarte F7 do turno ODS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projects.clear();
    pipelineEventBus._resetForTesting();
    _resetDriveLockForTesting();
  });

  it('W4-AC2 (C-03): entrada na fase ODS NAO dispara turno (faixa silenciosa, sem ceder o volante)', () => {
    seedDevV2(ODS_PHASE);
    const coord = new PipelineDriveCoordinator(() => null);
    coord.start();

    const res = coord.startDrive('proj_v2', 'sess_1', 'full');
    expect(res.ok).toBe(true);

    const drive = projects.get('proj_v2')?.config.drive;
    expect(drive?.status).toBe('driving');
    expect(drive?.handoff).toBe('none');
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('W4-AC3: turno defasado da ODS ("completed" emitido no lock) e DESCARTADO pelo guard F7 apos o pipe avancar', () => {
    const project = seedDevV2(ODS_PHASE);
    const coord = new PipelineDriveCoordinator(() => null);
    coord.start();
    coord.startDrive('proj_v2', 'sess_1', 'full');

    expect(projects.get('proj_v2')?.config.drive?.status).toBe('driving');
    expect(submitMock).not.toHaveBeenCalled();

    project.pipelineCurrentPhase = FIRST_ACTIONABLE_AFTER_LOCK;
    const staleOdsTurn: DriveTurnOptions = {
      sessionId: 'sess_1',
      origin: 'system-event',
      driveProjectId: 'proj_v2',
      drivePhase: ODS_PHASE, // turno defasado: header da fase 5
    };
    expect(discardsByF7Contract(staleOdsTurn)).toBe(true);
  });

  it('W4-AC3: lock humano -> drive (ainda driving) age no primeiro ponto acionavel; o turno NAO e defasado (passa pelo F7)', () => {
    vi.useFakeTimers();
    try {
      const project = seedDevV2(ODS_PHASE);
      const coord = new PipelineDriveCoordinator(() => null);
      coord.start();
      coord.startDrive('proj_v2', 'sess_1', 'full');

      expect(projects.get('proj_v2')?.config.drive?.status).toBe('driving');
      expect(submitMock).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      submitMock.mockClear();

      project.pipelineCurrentPhase = FIRST_ACTIONABLE_AFTER_LOCK;
      pipelineEventBus.emit('pipeline:phase-changed', {
        projectId: 'proj_v2',
        phase: FIRST_ACTIONABLE_AFTER_LOCK,
        status: 'started',
        awaitingUser: true,
      });
      pipelineEventBus.emit('pipeline:stream', {
        projectId: 'proj_v2',
        phase: FIRST_ACTIONABLE_AFTER_LOCK,
        type: 'done',
      });

      const drive = projects.get('proj_v2')?.config.drive;
      expect(drive?.status).toBe('driving');
      expect(drive?.handoff).toBe('none');
      expect(driveOwnerOfProject('proj_v2')).toBe('sess_1');
      expect(submitMock).toHaveBeenCalledTimes(1);

      const resumeOpts = optsOfCall(0);
      expect(resumeOpts.driveProjectId).toBe('proj_v2');
      expect(resumeOpts.drivePhase).toBe(FIRST_ACTIONABLE_AFTER_LOCK);
      expect(discardsByF7Contract(resumeOpts)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('W4-AC3 (contrato F7): com a fase real ja em 8, QUALQUER turno com drivePhase < 8 e descartado', () => {
    seedDevV2(FIRST_ACTIONABLE_AFTER_LOCK);

    for (const stalePhase of [ODS_PHASE, 6, 7]) {
      expect(
        discardsByF7Contract({
          sessionId: 'sess_1',
          origin: 'system-event',
          driveProjectId: 'proj_v2',
          drivePhase: stalePhase,
        }),
      ).toBe(true);
    }

    expect(
      discardsByF7Contract({
        sessionId: 'sess_1',
        origin: 'system-event',
        driveProjectId: 'proj_v2',
        drivePhase: FIRST_ACTIONABLE_AFTER_LOCK,
      }),
    ).toBe(false);
  });
});
