import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDriveStateMock = vi.fn();

vi.mock('../db', () => ({
  getHarnessProject: vi.fn(),
  listHarnessProjects: vi.fn(() => []),
  getPipelinePhaseMessagesAsChatHistory: vi.fn(() => []),
  getActiveChatSession: vi.fn(() => null),
  getDriveState: (projectId: string) => getDriveStateMock(projectId),
  isDriveEngaged: (projectId: string) => {
    const d = getDriveStateMock(projectId) as { driver?: string; status?: string } | null;
    return !!d && d.driver === 'orchestrator' && d.status !== 'stopped';
  },
}));
vi.mock('../pipeline-create', () => ({ createPipelineProject: vi.fn() }));
vi.mock('../pipeline-engine-ref', () => ({ getPipelineEngineRef: vi.fn(() => null) }));
vi.mock('../pipeline-drive-coordinator', () => ({ getPipelineDriveCoordinator: vi.fn(() => null) }));
vi.mock('../pipeline-event-bus', () => ({ pipelineEventBus: { on: vi.fn(), emit: vi.fn() } }));
vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: vi.fn() }));

import { driveConductBlocked } from '../pipeline-control-core';

function drive(partial: Record<string, unknown>) {
  return {
    driver: 'orchestrator',
    status: 'driving',
    mode: 'semi',
    handoff: 'none',
    sessionId: 's1',
    requiresHumanPhases: [],
    ...partial,
  };
}

describe('driveConductBlocked (enforcement Parar/Assumir)', () => {
  beforeEach(() => {
    getDriveStateMock.mockReset();
  });

  it('sem DriveState: nao bloqueia (uso ad-hoc preservado)', () => {
    getDriveStateMock.mockReturnValue(null);
    expect(driveConductBlocked('p1')).toBeNull();
  });

  it('driving (orquestrador no volante): nao bloqueia', () => {
    getDriveStateMock.mockReturnValue(drive({ status: 'driving' }));
    expect(driveConductBlocked('p1')).toBeNull();
  });

  it('awaiting-human (escalacao do semi): nao bloqueia', () => {
    getDriveStateMock.mockReturnValue(drive({ status: 'awaiting-human' }));
    expect(driveConductBlocked('p1')).toBeNull();
  });

  it('Parar (status stopped): bloqueia com instrucao de stand-down', () => {
    getDriveStateMock.mockReturnValue(drive({ status: 'stopped' }));
    const msg = driveConductBlocked('p1');
    expect(msg).toBeTruthy();
    expect(msg).toContain('PARADO');
    expect(msg).toContain('NAO re-engaje');
  });

  it('Assumir (driver human): bloqueia mesmo com status nao-stopped', () => {
    getDriveStateMock.mockReturnValue(drive({ driver: 'human', status: 'stopped', handoff: 'permanent' }));
    const msg = driveConductBlocked('p1');
    expect(msg).toBeTruthy();
    expect(msg).toContain('ASSUMIU');
  });
});

