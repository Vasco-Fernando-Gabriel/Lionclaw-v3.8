
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('../db', () => ({
  getHarnessProject: vi.fn((id: string) => projects.get(id)),
  listHarnessProjects: vi.fn(() => [...projects.values()]),
  getDriveState: vi.fn((id: string) => projects.get(id)?.config.drive ?? null),
  setDriveState: vi.fn((id: string, patch: Partial<DriveState>) => fakeSetDriveState(id, patch)),
  getLatestUserTurnIndex: vi.fn(() => 0),
  getPipelinePhaseMessagesAsChatHistory: vi.fn(() => []),
  getActiveChatSession: vi.fn(() => null),
}));

vi.mock('../chat-push', () => ({
  pushAssistantMessage: vi.fn(() => 1),
}));
vi.mock('../activity-log', () => ({
  recordActivity: vi.fn(),
}));
vi.mock('../orchestrator', () => ({
  submitMessage: vi.fn(),
}));

vi.mock('../pipeline-shared/ipc-emitter', () => ({
  emitIPC: vi.fn(),
}));

vi.mock('../open-design/drive-autostart', () => ({
  maybeAutostartDesignSession: vi.fn(async () => undefined),
}));

import { emitIPC } from '../pipeline-shared/ipc-emitter';
import { maybeAutostartDesignSession } from '../open-design/drive-autostart';
import { pipelineEventBus } from '../pipeline-event-bus';
import { _resetDriveLockForTesting } from '../drive-lock';
import { _resetDriveUsageSinkForTesting } from '../drive-usage-sink';
import { PipelineDriveCoordinator } from '../pipeline-drive-coordinator';
import {
  registerPipelineEngineRef,
  _resetPipelineEngineRefForTesting,
} from '../pipeline-engine-ref';
import { pipelineReplyCore } from '../pipeline-control-core';

const emitIPCMock = emitIPC as Mock;
const autostartMock = maybeAutostartDesignSession as Mock;


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

function messagesUpdatedCalls(): Array<unknown[]> {
  return emitIPCMock.mock.calls.filter((c) => c[0] === 'pipeline:messages-updated');
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  projects.clear();
  pipelineEventBus._resetForTesting();
  _resetDriveLockForTesting();
  _resetDriveUsageSinkForTesting();
  _resetPipelineEngineRefForTesting();
});


describe('I1: pipelineReplyCore emite pipeline:messages-updated', () => {
  it('emite { projectId, phase } logo apos o engine.sendMessage retornar (I1-AC1)', async () => {
    seedProject({ pipelineCurrentPhase: 3 });
    const sendMessage = vi.fn(() => undefined);
    const getCurrentPhase = vi.fn(() => ({ phase: 3, status: 'awaiting-user' }));
    registerPipelineEngineRef((() => ({ sendMessage, getCurrentPhase })) as never);

    const replyPromise = pipelineReplyCore('proj_a', 'vamos de opcao B');
    await flushAsync(); // o send e dispatchado apos o listener armar (A6)

    expect(sendMessage).toHaveBeenCalledWith('proj_a', 'vamos de opcao B', []);
    expect(messagesUpdatedCalls()).toEqual([
      ['pipeline:messages-updated', { projectId: 'proj_a', phase: 3 }],
    ]);

    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 3, type: 'done' });
    const res = await replyPromise;
    expect(res.ok).toBe(true);
  });

  it('sendMessage com { error } sincrono: reply falha mas o processo nao pendura', async () => {
    seedProject({ pipelineCurrentPhase: 2 });
    const sendMessage = vi.fn(() => ({ error: 'fase nao conversacional' }));
    const getCurrentPhase = vi.fn(() => ({ phase: 2, status: 'running' }));
    registerPipelineEngineRef((() => ({ sendMessage, getCurrentPhase })) as never);

    const res = await pipelineReplyCore('proj_a', 'oi');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/fase nao conversacional/);
  });
});


describe('I1: coordenador re-emite no pipeline:stream done (drive ativo)', () => {
  it('drive ativo: done da fase emite pipeline:messages-updated { projectId, phase }', () => {
    seedProject({ pipelineCurrentPhase: 1 }); // development fase 1 = Discovery (conversation)
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    emitIPCMock.mockClear();

    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 1, type: 'done' });

    expect(messagesUpdatedCalls()).toEqual([
      ['pipeline:messages-updated', { projectId: 'proj_a', phase: 1 }],
    ]);
  });

  it('REGRESSAO (I1-AC2): projeto SEM drive nao gera o evento (fluxo humano intocado)', () => {
    seedProject({ id: 'proj_humano', pipelineCurrentPhase: 1 });
    makeCoordinator();

    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_humano', phase: 1, type: 'done' });

    expect(messagesUpdatedCalls()).toHaveLength(0);
  });
});


describe('I5 (C-03): coordenador NAO faz autostart do Open Design', () => {
  it('drive ativo + dev-v2 + transicao para a fase do open-design-studio -> autostart NAO dispara (C-03)', async () => {
    const project = seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');

    project.pipelineCurrentPhase = 5;
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 5,
      status: 'started',
      awaitingUser: false,
    });
    await flushAsync(); // cobre qualquer fire-and-forget remanescente

    expect(autostartMock).not.toHaveBeenCalled();
  });

  it('pipeline NAO dev-v2 na fase 5: autostart NAO dispara', async () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 1 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');

    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 5,
      status: 'started',
      awaitingUser: false,
    });
    await flushAsync();

    expect(autostartMock).not.toHaveBeenCalled();
  });

  it('status de falha na fase do OD: autostart NAO dispara', async () => {
    const project = seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');

    project.pipelineCurrentPhase = 5;
    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 5,
      status: 'failed',
      awaitingUser: false,
    });
    await flushAsync();

    expect(autostartMock).not.toHaveBeenCalled();
  });

  it('SEM drive (fluxo humano): autostart NAO dispara mesmo em dev-v2 fase 5', async () => {
    seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 5 });
    makeCoordinator();

    pipelineEventBus.emit('pipeline:phase-changed', {
      projectId: 'proj_a',
      phase: 5,
      status: 'started',
      awaitingUser: false,
    });
    await flushAsync();

    expect(autostartMock).not.toHaveBeenCalled();
  });
});
