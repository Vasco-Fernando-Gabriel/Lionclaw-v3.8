
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HarnessProject } from '../../../src/types';
import type { HarnessEngine } from '../harness-engine';
import type { IpcContext } from '../ipc/context';


const ipcRegistry = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      fn: (event: unknown, ...args: unknown[]) => unknown,
    ) => {
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


import { registerHarnessHandlers } from '../ipc/harness';
import { getHarnessProject, listHarnessProjects } from '../db';

const mockedGetHarnessProject = vi.mocked(getHarnessProject);
const mockedListHarnessProjects = vi.mocked(listHarnessProjects);


const CHANNEL = 'harness:regenerate-sprints';

type ProjectStatus = HarnessProject['status'];

function makeProject(status: ProjectStatus): HarnessProject {
  return { id: 'proj-1', status } as unknown as HarnessProject;
}

function isErrorResult(result: unknown): result is { error: string } {
  return typeof result === 'object' && result !== null && 'error' in result;
}

interface Setup {
  regenerate: ReturnType<typeof vi.fn>;
  invoke: (projectId: string, feedback: string) => Promise<unknown>;
}

function setupHandlers(opts: { engineAvailable?: boolean } = {}): Setup {
  const engineAvailable = opts.engineAvailable ?? true;
  ipcRegistry.handlers.clear();

  const regenerate = vi.fn(() => Promise.resolve());
  const fakeEngine = { regenerate } as unknown as HarnessEngine;

  const ctx: IpcContext = {
    getMainWindow: () => null,
    getHarnessEngine: () => (engineAvailable ? fakeEngine : null),
    getPipelineEngine: () => null,
  };
  registerHarnessHandlers(ctx);

  const invoke = async (projectId: string, feedback: string): Promise<unknown> => {
    const handler = ipcRegistry.handlers.get(CHANNEL);
    expect(handler).toBeDefined();
    return await handler!(null, projectId, feedback);
  };

  return { regenerate, invoke };
}

beforeEach(() => {
  vi.clearAllMocks();
});


describe('harness:regenerate-sprints - registro', () => {
  it('registerHarnessHandlers registra o canal harness:regenerate-sprints', () => {
    setupHandlers();
    expect(ipcRegistry.handlers.has(CHANNEL)).toBe(true);
  });
});


describe('harness:regenerate-sprints - guard de status (N1/AC-9)', () => {
  it('projeto inexistente: retorna { error } e NAO chama engine.regenerate', async () => {
    const { regenerate, invoke } = setupHandlers();
    mockedGetHarnessProject.mockReturnValue(undefined);

    const result = await invoke('proj-missing', 'feedback qualquer');

    expect(isErrorResult(result)).toBe(true);
    expect((result as { error: string }).error).toBe('Projeto nao encontrado');
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("status 'running': retorna { error } citando o status atual e NAO chama engine.regenerate", async () => {
    const { regenerate, invoke } = setupHandlers();
    mockedGetHarnessProject.mockReturnValue(makeProject('running'));

    const result = await invoke('proj-1', 'feedback');

    expect(isErrorResult(result)).toBe(true);
    const error = (result as { error: string }).error;
    expect(error).toMatch(/reviewing/);
    expect(error).toMatch(/running/);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it('todos os demais status fora de reviewing tambem sao recusados', async () => {
    const blocked: ProjectStatus[] = [
      'idle',
      'planning',
      'ready',
      'running',
      'paused',
      'done',
      'failed',
      'aborted',
      'interrupted',
    ];
    for (const status of blocked) {
      const { regenerate, invoke } = setupHandlers();
      mockedGetHarnessProject.mockReturnValue(makeProject(status));

      const result = await invoke('proj-1', 'feedback');

      expect(isErrorResult(result), `status '${status}' deveria ser recusado`).toBe(true);
      expect((result as { error: string }).error).toContain(status);
      expect(regenerate, `status '${status}' nao pode chamar regenerate`).not.toHaveBeenCalled();
    }
  });

  it("status 'reviewing': chama engine.regenerate(projectId, feedback) sem { error }", async () => {
    const { regenerate, invoke } = setupHandlers();
    mockedGetHarnessProject.mockReturnValue(makeProject('reviewing'));

    const result = await invoke('proj-1', 'refaca o sprint 2');

    expect(isErrorResult(result)).toBe(false);
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(regenerate).toHaveBeenCalledWith('proj-1', 'refaca o sprint 2');
    expect(mockedGetHarnessProject).toHaveBeenCalledWith('proj-1');
  });

  it('convencao IPC: caminho de erro NUNCA lanca (resolve com { error })', async () => {
    const { invoke } = setupHandlers();
    mockedGetHarnessProject.mockReturnValue(makeProject('failed'));

    await expect(invoke('proj-1', 'feedback')).resolves.toSatisfy(isErrorResult);
  });

  it("guard passou mas engine nao inicializado: { error } de withHarnessEngine", async () => {
    const { regenerate, invoke } = setupHandlers({ engineAvailable: false });
    mockedGetHarnessProject.mockReturnValue(makeProject('reviewing'));

    const result = await invoke('proj-1', 'feedback');

    expect(isErrorResult(result)).toBe(true);
    expect((result as { error: string }).error).toBe('HarnessEngine nao inicializado');
    expect(regenerate).not.toHaveBeenCalled();
  });
});

describe('harness:resume - autenticacao do provider', () => {
  function setupResumeHandlers() {
    ipcRegistry.handlers.clear();
    const resume = vi.fn(() => ({
      ok: false as const,
      message: 'Retomada bloqueada: reconecte o grok no aviso de autenticacao, verifique o login e tente novamente.',
    }));
    const resumeAfterAuth = vi.fn(async () => ({ ok: true as const }));
    const fakeEngine = { resume, resumeAfterAuth } as unknown as HarnessEngine;
    registerHarnessHandlers({
      getMainWindow: () => null,
      getHarnessEngine: () => fakeEngine,
      getPipelineEngine: () => null,
    });
    const handler = ipcRegistry.handlers.get('harness:resume');
    expect(handler).toBeDefined();
    return { handler: handler!, resume, resumeAfterAuth };
  }

  it('sem provider propaga a recusa do resume generico sem tentar revalidar', async () => {
    const { handler, resume, resumeAfterAuth } = setupResumeHandlers();

    await expect(handler(null, 'proj-1')).resolves.toEqual({
      ok: false,
      message: 'Retomada bloqueada: reconecte o grok no aviso de autenticacao, verifique o login e tente novamente.',
    });
    expect(resume).toHaveBeenCalledWith('proj-1');
    expect(resumeAfterAuth).not.toHaveBeenCalled();
  });

  it('com provider usa exclusivamente resumeAfterAuth', async () => {
    const { handler, resume, resumeAfterAuth } = setupResumeHandlers();

    await expect(handler(null, 'proj-1', 'grok')).resolves.toEqual({ ok: true });
    expect(resumeAfterAuth).toHaveBeenCalledWith('proj-1', 'grok');
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('harness:list-projects - checkpoint apos reload', () => {
  it('expoe provider e round persistidos no estado inicial sem acionar resume', async () => {
    ipcRegistry.handlers.clear();
    const checkpointProject = {
      ...makeProject('paused'),
      config: {
        providerAuthCheckpoint: {
          checkpointId: 'checkpoint-reloaded',
          pauseReason: 'provider-auth',
          provider: 'grok',
          ownerKind: 'harness',
          phaseNumber: 14,
          agentId: 'harness-evaluator',
          roundId: 'round-7',
          claimState: 'pending',
          resume: { kind: 'run' },
        },
      },
    } as unknown as HarnessProject;
    mockedListHarnessProjects.mockReturnValue([checkpointProject]);
    const resume = vi.fn();
    registerHarnessHandlers({
      getMainWindow: () => null,
      getHarnessEngine: () => ({ resume } as unknown as HarnessEngine),
      getPipelineEngine: () => null,
    });

    const handler = ipcRegistry.handlers.get('harness:list-projects');
    expect(handler).toBeDefined();
    expect(await handler!(null)).toEqual([checkpointProject]);
    expect(resume).not.toHaveBeenCalled();
  });
});
