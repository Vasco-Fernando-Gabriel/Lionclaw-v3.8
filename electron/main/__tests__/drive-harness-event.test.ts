import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveStateChangedEvent } from '../../../src/types';
import type { IpcContext } from '../ipc/context';

const ipcRegistry = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcRegistry.handlers.set(channel, fn);
    },
  },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('../db', () => ({
  insertHarnessProject: vi.fn(),
  updateHarnessProject: vi.fn(),
  getHarnessProject: vi.fn(),
  listHarnessProjects: vi.fn(),
  deleteHarnessProject: vi.fn(),
  getHarnessSprints: vi.fn(),
  getHarnessRounds: vi.fn(),
  getHarnessProjectMetrics: vi.fn(),
  getDriveSessionId: vi.fn(() => null),
  getOpenLaneSessionById: vi.fn(() => null),
}));

vi.mock('../pipeline-shared/status', () => ({
  setProjectStatus: vi.fn(),
}));

vi.mock('../harness-planner', () => ({
  readHarnessSprintsJson: vi.fn(),
}));

vi.mock('../pipeline-paths', () => ({
  getLegacyHarnessSprintArtifactDir: vi.fn(() => '/tmp/legacy'),
  resolveHarnessProjectDir: vi.fn(() => '/tmp/project'),
  resolveHarnessSprintArtifactDir: vi.fn(() => '/tmp/sprint'),
}));

vi.mock('../pipeline-drive-coordinator', () => ({
  getPipelineDriveCoordinator: vi.fn(),
}));

vi.mock('../pipeline-shared/ipc-emitter', () => ({
  emitIPC: vi.fn(),
}));

import { registerHarnessHandlers } from '../ipc/harness';
import { deleteHarnessProject, getDriveSessionId, getOpenLaneSessionById } from '../db';
import { getPipelineDriveCoordinator } from '../pipeline-drive-coordinator';
import { emitIPC } from '../pipeline-shared/ipc-emitter';

const mockedDeleteHarnessProject = vi.mocked(deleteHarnessProject);
const mockedGetDriveSessionId = vi.mocked(getDriveSessionId);
const mockedGetOpenLaneSessionById = vi.mocked(getOpenLaneSessionById);
const mockedGetCoordinator = vi.mocked(getPipelineDriveCoordinator);
const mockedEmitIPC = vi.mocked(emitIPC);

const CHANNEL = 'harness:delete-project';

function isDriveStateChangedEvent(payload: unknown): payload is DriveStateChangedEvent {
  if (typeof payload !== 'object' || payload === null) return false;
  if (!('projectId' in payload) || typeof payload.projectId !== 'string') return false;
  if (!('drive' in payload) || !('sessionId' in payload) || !('laneBadge' in payload)) return false;
  const { drive, sessionId, laneBadge } = payload;
  if (drive !== null && typeof drive !== 'object') return false;
  if (sessionId !== null && typeof sessionId !== 'string') return false;
  if (laneBadge !== null && typeof laneBadge !== 'number') return false;
  return true;
}

function captureDriveEvent(): DriveStateChangedEvent {
  const call = mockedEmitIPC.mock.calls.find(([channel]) => channel === 'drive:state-changed');
  expect(call, 'handler deveria emitir drive:state-changed').toBeDefined();
  const payload = call![1];
  if (!isDriveStateChangedEvent(payload)) {
    throw new Error(`payload fora do contrato DriveStateChangedEvent: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function setup(opts: { stopDrive?: ReturnType<typeof vi.fn> } = {}): {
  invoke: (projectId: string) => Promise<unknown>;
} {
  ipcRegistry.handlers.clear();
  if (opts.stopDrive) {
    mockedGetCoordinator.mockReturnValue({
      stopDrive: opts.stopDrive,
    } as unknown as ReturnType<typeof getPipelineDriveCoordinator>);
  } else {
    mockedGetCoordinator.mockReturnValue(null);
  }

  const ctx: IpcContext = {
    getMainWindow: () => null,
    getHarnessEngine: () => null,
    getPipelineEngine: () => null,
  };
  registerHarnessHandlers(ctx);

  return {
    invoke: async (projectId: string) => {
      const handler = ipcRegistry.handlers.get(CHANNEL);
      expect(handler).toBeDefined();
      return await handler!(null, projectId);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetDriveSessionId.mockReturnValue(null);
  mockedGetOpenLaneSessionById.mockReturnValue(null);
});

describe('harness:delete-project - evento de drive tipado por lane', () => {
  it('emite drive:state-changed com o contrato completo (drive null)', async () => {
    const { invoke } = setup();

    await invoke('proj-1');

    const event = captureDriveEvent();
    expect(event).toEqual({
      projectId: 'proj-1',
      drive: null,
      sessionId: null,
      laneBadge: null,
    });
    expect(event.projectId).toBe('proj-1');
    expect(event.drive).toBeNull();
    expect(event.sessionId).toBeNull();
    expect(event.laneBadge).toBeNull();
  });

  it('nao deduz lane do projeto excluido nem consulta a lane aberta', async () => {
    mockedGetDriveSessionId.mockReturnValue('sess_lane_4');
    mockedGetOpenLaneSessionById.mockReturnValue(null);
    const { invoke } = setup();

    await invoke('proj-1');

    const event = captureDriveEvent();
    expect(event.sessionId).toBeNull();
    expect(event.laneBadge).toBeNull();
    expect(mockedGetDriveSessionId).not.toHaveBeenCalled();
    expect(mockedGetOpenLaneSessionById).not.toHaveBeenCalled();
  });

  it('preserva stopDrive antes de excluir o projeto e emitir o evento', async () => {
    const stopDrive = vi.fn();
    const { invoke } = setup({ stopDrive });

    await invoke('proj-1');

    expect(stopDrive).toHaveBeenCalledWith('proj-1', 'project-deleted');
    expect(mockedDeleteHarnessProject).toHaveBeenCalledWith('proj-1');
    expect(stopDrive.mock.invocationCallOrder[0]).toBeLessThan(mockedDeleteHarnessProject.mock.invocationCallOrder[0]);
    expect(mockedDeleteHarnessProject.mock.invocationCallOrder[0]).toBeLessThan(
      mockedEmitIPC.mock.invocationCallOrder[0],
    );
  });

  it('sem coordenador de drive o evento continua sendo emitido', async () => {
    const { invoke } = setup();

    await invoke('proj-9');

    expect(captureDriveEvent().projectId).toBe('proj-9');
  });
});
