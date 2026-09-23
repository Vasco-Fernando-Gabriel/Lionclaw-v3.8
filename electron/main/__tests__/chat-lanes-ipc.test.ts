import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

const h = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  webContentsSendMock: vi.fn(),
  submitMessageMock: vi.fn(),
  executionState: new Map<string, 'streaming' | 'queued' | 'idle'>(),
  lanes: [] as Array<Record<string, unknown>>,
  createLaneSessionMock: vi.fn<(input: unknown) => unknown>(),
  replaceLaneSessionMock: vi.fn((_input: unknown) => ({ newSessionId: 'nova' })),
  defaultOrchestrator: null as Record<string, unknown> | null,
  runCompactionMock: vi.fn(),
  summarizeLightweightMock: vi.fn(),
  engagedDrives: new Map<string, Record<string, unknown>>(),
  harnessProjects: new Map<string, Record<string, unknown>>(),
  clearLaneSessionMock: vi.fn(async (sessionId: string, _opts?: unknown) => ({
    ok: true,
    sessionId,
    newSessionId: `${sessionId}-new`,
    warnings: [],
    pausedDriveProjectIds: [],
  })),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      h.ipcHandlers.set(channel, handler);
    },
    on: vi.fn(),
  },
  BrowserWindow: class {},
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../db', () => ({
  getAllSessions: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  trashSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  getActiveChatSession: vi.fn(() => ({ id: 'heuristica' })),
  createSession: vi.fn(),
  getSetting: vi.fn(() => 'true'),
  insertMessage: vi.fn(),
  getSession: vi.fn((id: string) => h.lanes.find((l) => l['id'] === id)),
  getChatFeatureToggles: vi.fn(() => null),
  setChatFeatureToggles: vi.fn(),
  isOpenDesktopConversation: vi.fn(() => true),
  getOpenLaneSessionById: vi.fn((id: string) => h.lanes.find((l) => l['id'] === id) ?? null),
  listOpenDesktopSessions: vi.fn((resolve: (row: Record<string, unknown>) => string) =>
    h.lanes.map((row) => ({ ...row, state: resolve(row) })),
  ),
  listOpenDesktopSessionRows: vi.fn(() => h.lanes),
  createLaneSession: (input: unknown) => h.createLaneSessionMock(input),
  replaceLaneSession: (input: unknown) => h.replaceLaneSessionMock(input),
  setSessionOrchestrator: vi.fn(),
  countSessionMessages: vi.fn(() => 0),
  listHarnessProjects: vi.fn(() => []),
  isDriveEngaged: vi.fn(() => false),
  findEngagedDriveBySession: vi.fn((sessionId: string) => h.engagedDrives.get(sessionId) ?? null),
  getHarnessProject: vi.fn((id: string) => h.harnessProjects.get(id)),
}));

vi.mock('../orchestrator-selection', () => ({
  readDefaultOrchestratorColumns: () => h.defaultOrchestrator,
}));
vi.mock('../orchestrator-selection-matrix', () => ({
  validateOrchestratorTriple: vi.fn(async () => null),
}));
vi.mock('../chat-capability-resolve', () => ({
  resolveChatCapabilitiesForTurn: vi.fn(() => ({ pipelineControl: false, dynamicWorkflows: false })),
  sanitizeChatFeatureTogglesPatch: vi.fn(),
}));
vi.mock('../orchestrator', () => ({
  submitMessage: h.submitMessageMock,
  stopCurrentQuery: vi.fn(),
  getDesktopSessionExecutionState: (id: string) => h.executionState.get(id) ?? 'idle',
}));
vi.mock('../pipeline-drive-coordinator', () => ({
  getPipelineDriveCoordinator: vi.fn(() => null),
}));
vi.mock('../session-drive', () => ({ sessionHasActiveDrive: () => false }));
vi.mock('../codeburn-pty', () => ({
  spawnCodeburn: vi.fn(),
  writeCodeburn: vi.fn(),
  resizeCodeburn: vi.fn(),
  killCodeburn: vi.fn(),
}));
vi.mock('../permission-guard', () => ({ resolveConfirmation: vi.fn() }));
vi.mock('../ask-question', () => ({ resolveAskQuestion: vi.fn() }));
vi.mock('../memory-pipeline', () => ({
  runCompaction: (...args: unknown[]) => h.runCompactionMock(...args),
  summarizeLightweight: (...args: unknown[]) => h.summarizeLightweightMock(...args),
}));
vi.mock('../chat-clear', () => ({
  clearLaneSession: (sessionId: string, opts?: unknown) => h.clearLaneSessionMock(sessionId, opts),
  cancelQueuedClear: vi.fn(),
}));

import { registerChatHandlers } from '../ipc/chat';
import { registerChatDeprecatedHandlers } from '../ipc/chat-deprecated';
import { listOpenDesktopSessions, findEngagedDriveBySession } from '../db';
import type { OpenChatSession } from '../../../src/types';
import type { IpcContext } from '../ipc/context';
import { clearingSessions, markSessionClearing } from '../clearing-sessions';

const DEFAULT_ORCHESTRATOR = { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-sonnet-4-6' };

function lane(id: string, badge: number, lastUserMessageAt: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    laneBadge: badge,
    title: `Lane ${badge}`,
    orchestrator: DEFAULT_ORCHESTRATOR,
    messageCount: 1,
    lastUserMessageAt,
    createdAt: '2026-09-08 10:00:00',
    updatedAt: '2026-09-08 10:00:00',
    dreamingStartedAt: null,
    status: 'active',
    type: 'chat',
    ...extra,
  };
}

function ctx(): IpcContext {
  return {
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: h.webContentsSendMock } }),
  } as unknown as IpcContext;
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = h.ipcHandlers.get(channel);
  expect(handler, `handler ${channel}`).toBeDefined();
  return Promise.resolve(handler!({}, ...args));
}

const fsSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  h.ipcHandlers.clear();
  h.lanes = [];
  h.executionState.clear();
  h.defaultOrchestrator = { ...DEFAULT_ORCHESTRATOR };
  h.createLaneSessionMock.mockReset().mockImplementation(() => {
    const created = lane('nova', 1, null, { messageCount: 0 });
    h.lanes.push(created);
    return { ok: true, session: created };
  });
  h.replaceLaneSessionMock.mockClear();
  h.runCompactionMock.mockReset();
  h.summarizeLightweightMock.mockReset();
  h.clearLaneSessionMock.mockClear();
  h.webContentsSendMock.mockClear();
  h.engagedDrives.clear();
  h.harnessProjects.clear();
  clearingSessions.clear();
  fsSpies.push(vi.spyOn(fs, 'unlinkSync'), vi.spyOn(fs, 'rmSync'), vi.spyOn(fs.promises, 'unlink'));
  registerChatHandlers(ctx());
  registerChatDeprecatedHandlers(ctx());
});

afterEach(() => {
  for (const spy of fsSpies.splice(0)) spy.mockRestore();
  clearingSessions.clear();
});

function expectNoDreamingAndNoUnlink(): void {
  expect(h.runCompactionMock).not.toHaveBeenCalled();
  expect(h.summarizeLightweightMock).not.toHaveBeenCalled();
  for (const spy of fsSpies) expect(spy).not.toHaveBeenCalled();
}

describe('AC-4 (main): chat:create-session', () => {
  it('cria a lane com o Orquestrador padrao como pre-selecao, sem dreaming e sem apagar arquivo', async () => {
    const result = await invoke('chat:create-session');
    expect(result).toMatchObject({ session: { id: 'nova', laneBadge: 1, state: 'idle' } });
    expect(h.createLaneSessionMock).toHaveBeenCalledWith({
      orchestrator: DEFAULT_ORCHESTRATOR,
      reservedBadges: [],
    });
    expectNoDreamingAndNoUnlink();
  });

  it('RM7: Orquestrador padrao ausente = orchestrator_unconfigured, nunca grava NULL', async () => {
    h.defaultOrchestrator = null;
    const result = await invoke('chat:create-session');
    expect(result).toMatchObject({ code: 'orchestrator_unconfigured' });
    expect(h.createLaneSessionMock).not.toHaveBeenCalled();
  });

  it('lanes_full propagado como erro tipado', async () => {
    h.createLaneSessionMock.mockReturnValue({ ok: false, code: 'lanes_full' });
    const result = await invoke('chat:create-session');
    expect(result).toMatchObject({ code: 'lanes_full' });
  });
});

describe('chat:ensure-session nao devolve lane interrupted/clearing', () => {
  it('escolhe a lane selecionavel com lastUserMessageAt mais recente, pulando interrupted e clearing', async () => {
    h.lanes = [lane('a', 1, '2026-09-08 10:00:00'), lane('b', 2, '2026-09-08 12:00:00')];
    markSessionClearing('b', 'interrupted', 2);
    expect(await invoke('chat:ensure-session')).toEqual({ sessionId: 'a' });

    clearingSessions.clear();
    markSessionClearing('b', 'queued', 2);
    expect(await invoke('chat:ensure-session')).toEqual({ sessionId: 'a' });
    expect(h.createLaneSessionMock).not.toHaveBeenCalled();
  });

  it('preferredSessionId em Clear interrompido e ignorado', async () => {
    h.lanes = [lane('a', 1, '2026-09-08 10:00:00'), lane('b', 2, '2026-09-08 12:00:00')];
    markSessionClearing('b', 'interrupted', 2);
    expect(await invoke('chat:ensure-session', { preferredSessionId: 'b' })).toEqual({ sessionId: 'a' });
  });

  it('sem lane selecionavel cria uma nova; sem Orquestrador padrao recusa orchestrator_unconfigured', async () => {
    h.lanes = [lane('b', 2, '2026-09-08 12:00:00')];
    markSessionClearing('b', 'interrupted', 2);
    expect(await invoke('chat:ensure-session')).toEqual({ sessionId: 'nova' });
    expect(h.createLaneSessionMock).toHaveBeenCalledWith({
      orchestrator: DEFAULT_ORCHESTRATOR,
      reservedBadges: [2],
    });

    h.createLaneSessionMock.mockClear();
    h.defaultOrchestrator = null;
    h.lanes = [];
    clearingSessions.clear();
    expect(await invoke('chat:ensure-session')).toMatchObject({ code: 'orchestrator_unconfigured' });
    expect(h.createLaneSessionMock).not.toHaveBeenCalled();
  });
});

describe('RM7: chat:list-open-sessions em falha devolve { error }, nunca []', () => {
  it('excecao do db vira { error } tipado', async () => {
    vi.mocked(listOpenDesktopSessions).mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    const result = await invoke('chat:list-open-sessions');
    expect(result).toEqual({ error: 'SQLITE_BUSY: database is locked' });
  });

  it('sem falha devolve a lista', async () => {
    h.lanes = [lane('a', 1, '2026-09-08 10:00:00')];
    const result = await invoke('chat:list-open-sessions');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toMatchObject([{ id: 'a', laneBadge: 1 }]);
  });
});

describe('AC-8: canais deprecated', () => {
  it('chat:compact-session sem argumento = Clear na lane com lastUserMessageAt mais recente', async () => {
    h.lanes = [lane('a', 1, '2026-09-08 10:00:00'), lane('b', 2, '2026-09-08 12:00:00')];
    const result = await invoke('chat:compact-session');
    expect(h.clearLaneSessionMock).toHaveBeenCalledTimes(1);
    expect(h.clearLaneSessionMock.mock.calls[0]?.[0]).toBe('b');
    expect(result).toEqual({ success: true, newSessionId: 'b-new' });
  });

  it('chat:compact-session com sessionId = Clear naquela lane', async () => {
    h.lanes = [lane('a', 1, '2026-09-08 10:00:00'), lane('b', 2, '2026-09-08 12:00:00')];
    await invoke('chat:compact-session', 'a');
    expect(h.clearLaneSessionMock.mock.calls[0]?.[0]).toBe('a');
  });

  it('chat:clear-session arquiva sem dreaming, sem apagar jsonl e cria a conversa nova', async () => {
    h.lanes = [lane('a', 1, '2026-09-08 10:00:00')];
    const result = await invoke('chat:clear-session', 'a');
    expect(result).toEqual({ success: true, newSessionId: 'nova' });
    expect(h.replaceLaneSessionMock).toHaveBeenCalledWith({
      sessionId: 'a',
      finalStatus: 'archived',
      orchestrator: DEFAULT_ORCHESTRATOR,
    });
    expect(h.clearLaneSessionMock).not.toHaveBeenCalled();
    expectNoDreamingAndNoUnlink();
  });

  it('chat:clear-session/chat:archive-session recusam sessao em Clear (session_clearing) e turno em voo (session_busy)', async () => {
    h.lanes = [lane('a', 1, '2026-09-08 10:00:00')];
    markSessionClearing('a', 'running', 1);
    expect(await invoke('chat:clear-session', 'a')).toEqual({ success: false, reason: 'session_clearing' });
    expect(await invoke('chat:archive-session', 'a')).toBe(false);

    clearingSessions.clear();
    h.executionState.set('a', 'streaming');
    expect(await invoke('chat:clear-session', 'a')).toEqual({ success: false, reason: 'session_busy' });
    h.executionState.set('a', 'queued');
    expect(await invoke('chat:archive-session', 'a')).toBe(false);
    expect(h.replaceLaneSessionMock).not.toHaveBeenCalled();
  });
});

async function listOpenSessionsViaIpc(): Promise<OpenChatSession[]> {
  const result = await invoke('chat:list-open-sessions');
  if (!Array.isArray(result)) throw new Error('chat:list-open-sessions nao devolveu lista');
  return result;
}

describe('SPEC pipeline-por-lane 8.6 (F10): OpenChatSession.drive independe do state da lane', () => {
  function engage(
    sessionId: string,
    projectId: string,
    name: string,
    status: 'driving' | 'awaiting-human' | 'stopped',
  ): void {
    h.engagedDrives.set(sessionId, {
      id: projectId,
      name,
      config: { drive: { driver: 'orchestrator', status, handoff: 'none', mode: 'semi', requiresHumanPhases: [] } },
    });
    h.harnessProjects.set(projectId, { id: projectId, name });
  }

  it('lane com pipeline engajado traz projectId, nome e status do drive', async () => {
    h.lanes = [lane('a', 1, '2026-09-17 10:00:00')];
    engage('a', 'proj_1', 'Refatorar o motor', 'awaiting-human');

    const result = await listOpenSessionsViaIpc();

    expect(result).toHaveLength(1);
    expect(result[0].drive).toEqual({
      projectId: 'proj_1',
      name: 'Refatorar o motor',
      status: 'awaiting-human',
    });
  });

  it('turno em voo (state streaming) NAO esconde o pipeline da lane; resolveLaneState segue sem "drive"', async () => {
    h.lanes = [lane('a', 1, '2026-09-17 10:00:00')];
    h.executionState.set('a', 'streaming');
    engage('a', 'proj_1', 'Refatorar o motor', 'driving');

    const result = await listOpenSessionsViaIpc();

    expect(result[0].state).toBe('streaming');
    expect(result[0].drive).toMatchObject({ projectId: 'proj_1', name: 'Refatorar o motor', status: 'driving' });
  });

  it('lane sem pipeline engajado devolve drive null', async () => {
    h.lanes = [lane('a', 1, '2026-09-17 10:00:00')];

    const result = await listOpenSessionsViaIpc();

    expect(result[0].drive).toBeNull();
  });

  it('drive_uniqueness_violated e logado e devolve null, nunca o primeiro engajado', async () => {
    h.lanes = [lane('a', 1, '2026-09-17 10:00:00')];
    vi.mocked(findEngagedDriveBySession).mockImplementationOnce(() => {
      throw new Error('drive_uniqueness_violated: 2 pipelines engajados na sessao "a"');
    });

    const result = await listOpenSessionsViaIpc();

    expect(result[0].drive).toBeNull();
  });

  it('projeto excluido entre a consulta e o map devolve drive null', async () => {
    h.lanes = [lane('a', 1, '2026-09-17 10:00:00')];
    engage('a', 'proj_1', 'Refatorar o motor', 'driving');
    h.harnessProjects.delete('proj_1');

    const result = await listOpenSessionsViaIpc();

    expect(result[0].drive).toBeNull();
  });
});
