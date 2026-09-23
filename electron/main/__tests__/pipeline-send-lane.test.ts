import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LionClawAPI } from '../../../src/types';
import type { OpenDesktopSessionRow } from '../db';

type SendResult = Awaited<ReturnType<LionClawAPI['pipeline']['send']>>;

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const db = vi.hoisted(() => ({
  isDriveEngaged: vi.fn(() => false),
  getDriveSessionId: vi.fn<(projectId: string) => string | null>(() => null),
  getOpenLaneSessionById: vi.fn<(id: string) => OpenDesktopSessionRow | null>(() => null),
}));

vi.mock('../db', () => ({
  getHarnessProject: vi.fn(() => undefined),
  listHarnessProjects: vi.fn(() => []),
  getSecurityAgentStatuses: vi.fn(() => []),
  getAuditAgentsState: vi.fn(() => null),
  deleteHarnessProject: vi.fn(),
  getHarnessSprints: vi.fn(() => []),
  getHarnessSprintAggregateMetrics: vi.fn(() => ({})),
  getHarnessSprintByIndex: vi.fn(() => undefined),
  getPipelinePhaseMessages: vi.fn(() => []),
  listPipelineMessagesForSprint: vi.fn(() => []),
  getPipelineMetrics: vi.fn(() => ({})),
  getSecuritySummaryJson: vi.fn(() => null),
  getBugAnalysisAgentsState: vi.fn(() => null),
  isDriveEngaged: db.isDriveEngaged,
  getDriveSessionId: db.getDriveSessionId,
  getOpenLaneSessionById: db.getOpenLaneSessionById,
}));

const bus = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('../pipeline-event-bus', () => ({
  pipelineEventBus: { emit: bus.emit, on: vi.fn(() => () => {}) },
}));

const locks = vi.hoisted(() => ({ ensureProjectLock: vi.fn() }));
vi.mock('../pipeline-shared/lock', () => ({
  acquireProjectLock: vi.fn(() => true),
  ensureProjectLock: locks.ensureProjectLock,
  releaseProjectLock: vi.fn(),
}));

vi.mock('../pipeline-drive-coordinator', () => ({
  getPipelineDriveCoordinator: () => null,
}));
vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: vi.fn() }));
vi.mock('../pipeline-create', () => ({ createPipelineProject: vi.fn() }));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

import { registerPipelineHandlers } from '../ipc/pipeline';
import type { IpcContext } from '../ipc/context';

const sendMessage = vi.fn(async () => {});

function laneRow(id: string, laneBadge: number): OpenDesktopSessionRow {
  return {
    id,
    laneBadge,
    title: `Lane ${laneBadge}`,
    orchestrator: null,
    messageCount: 4,
    lastUserMessageAt: '2026-09-17 10:00:00',
    createdAt: '2026-09-17 09:00:00',
    updatedAt: '2026-09-17 10:00:00',
    dreamingStartedAt: null,
  };
}

function send(projectId: string, message: string): Promise<SendResult> {
  const handler = handlers.get('pipeline:send');
  expect(handler, 'handler pipeline:send').toBeDefined();
  return Promise.resolve(handler!({}, projectId, message)) as Promise<SendResult>;
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  db.isDriveEngaged.mockReturnValue(false);
  db.getDriveSessionId.mockReturnValue(null);
  db.getOpenLaneSessionById.mockReturnValue(null);
  registerPipelineHandlers({
    getMainWindow: () => null,
    getHarnessEngine: () => null,
    getPipelineEngine: () => ({ sendMessage }) as never,
  } as unknown as IpcContext);
});

describe('AC (SPEC 7.5): pipeline:send resolve a lane pela coluna ANTES de emitir', () => {
  it('drive engajado com coluna fora das lanes abertas = session_not_active sincrono, sem emit e sem sendMessage', async () => {
    db.isDriveEngaged.mockReturnValue(true);
    db.getDriveSessionId.mockReturnValue('sess_fechada');
    db.getOpenLaneSessionById.mockReturnValue(null);

    const result = await send('proj', 'segue o gate');

    expect(result).toMatchObject({ code: 'session_not_active' });
    expect('ok' in result).toBe(false);
    expect(bus.emit).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(locks.ensureProjectLock).toHaveBeenCalledWith('proj', 'pipeline-engine');
  });

  it('drive engajado com coluna NULL tambem recusa session_not_active', async () => {
    db.isDriveEngaged.mockReturnValue(true);
    db.getDriveSessionId.mockReturnValue(null);

    const result = await send('proj', 'segue o gate');

    expect(result).toMatchObject({ code: 'session_not_active' });
    expect(db.getOpenLaneSessionById).not.toHaveBeenCalled();
    expect(bus.emit).not.toHaveBeenCalled();
  });

  it('drive engajado em lane aberta emite e devolve resumedInSessionId + laneBadge', async () => {
    db.isDriveEngaged.mockReturnValue(true);
    db.getDriveSessionId.mockReturnValue('sess_A');
    db.getOpenLaneSessionById.mockImplementation((id) => (id === 'sess_A' ? laneRow('sess_A', 3) : null));

    const result = await send('proj', 'pode aprovar');

    expect(result).toEqual({ ok: true, resumedInSessionId: 'sess_A', laneBadge: 3 });
    if (!('ok' in result)) throw new Error('esperava sucesso');
    expect(result.resumedInSessionId).toBe('sess_A');
    expect(result.laneBadge).toBe(3);
    expect(bus.emit).toHaveBeenCalledWith('pipeline:human-message', {
      projectId: 'proj',
      content: 'pode aprovar',
    });
    expect(sendMessage).toHaveBeenCalledWith('proj', 'pode aprovar', undefined);
  });

  it('projeto SEM drive engajado mantem o fluxo atual: { ok: true } puro', async () => {
    db.isDriveEngaged.mockReturnValue(false);

    const result = await send('proj', 'oi');

    expect(result).toEqual({ ok: true });
    expect(db.getDriveSessionId).not.toHaveBeenCalled();
    expect(bus.emit).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('drive STOPPED com session_id historico nao e engajado: fala com o pipeline como hoje', async () => {
    db.isDriveEngaged.mockReturnValue(false);
    db.getDriveSessionId.mockReturnValue('sess_historica_fechada');

    const result = await send('proj', 'ainda quero falar');

    expect(result).toEqual({ ok: true });
    expect(result).not.toMatchObject({ code: 'session_not_active' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
