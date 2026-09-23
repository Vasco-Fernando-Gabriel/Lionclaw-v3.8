import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  getHarnessProject: vi.fn(),
  updateHarnessProject: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/lionclaw-test-approot',
    getPath: (_name: string) => '/tmp/lionclaw-test-userdata',
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

import { getHarnessProject, updateHarnessProject, setSetting } from '../db';
import {
  getSessionConfig,
  setSessionConfig,
  clearSessionConfig,
  LAST_SESSION_CONFIG_SETTINGS_KEY,
} from '../open-design/session-config';
import type { OpenDesignSessionConfig } from '../../../src/types/open-design';

const mockGetHarnessProject = vi.mocked(getHarnessProject);
const mockUpdateHarnessProject = vi.mocked(updateHarnessProject);

const PROJECT_ID = 'proj_test';

function baseProject(openDesign: Record<string, unknown> = {}): {
  id: string;
  config: { openDesign: Record<string, unknown> };
} {
  return {
    id: PROJECT_ID,
    config: { openDesign },
  };
}

function validSessionConfig(): OpenDesignSessionConfig {
  return {
    agentId: 'claude',
    model: 'claude-opus-4-7',
    reasoning: 'high',
    designSystemId: 'lc-default',
    memoryEnabled: false,
    mcpServerIds: [],
    locale: 'pt-BR',
    configuredAt: '2026-05-11T00:00:00.000Z',
  };
}

describe('session-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('round-trip get/set persiste sessionConfig em harness_projects.config.openDesign', () => {
    const project = baseProject();
    mockGetHarnessProject.mockReturnValue(project as never);
    mockUpdateHarnessProject.mockReturnValue(project as never);

    const cfg = validSessionConfig();
    setSessionConfig(PROJECT_ID, cfg);

    expect(mockUpdateHarnessProject).toHaveBeenCalledTimes(1);
    const updateArgs = mockUpdateHarnessProject.mock.calls[0]![1];
    const persistedOd = (updateArgs as unknown as { config: { openDesign: Record<string, unknown> } }).config
      .openDesign;
    expect(persistedOd.sessionConfig).toEqual(cfg);

    const projectWithCfg = baseProject({ sessionConfig: cfg });
    mockGetHarnessProject.mockReturnValue(projectWithCfg as never);
    expect(getSessionConfig(PROJECT_ID)).toEqual(cfg);
  });

  it('getSessionConfig retorna null quando nao existe', () => {
    mockGetHarnessProject.mockReturnValue(baseProject() as never);
    expect(getSessionConfig(PROJECT_ID)).toBeNull();
  });

  it('rejeita payload com chave "token" no top-level', () => {
    mockGetHarnessProject.mockReturnValue(baseProject() as never);
    const bad = { ...validSessionConfig(), token: 'sk-...' };
    expect(() => setSessionConfig(PROJECT_ID, bad as never)).toThrow(/chave proibida/i);
    expect(mockUpdateHarnessProject).not.toHaveBeenCalled();
  });

  it('rejeita payload com chave "apiKey" (case-insensitive)', () => {
    mockGetHarnessProject.mockReturnValue(baseProject() as never);
    const bad = { ...validSessionConfig(), apiKey: 'sk-...' };
    expect(() => setSessionConfig(PROJECT_ID, bad as never)).toThrow(/chave proibida/i);
  });

  it('rejeita payload com chave terminando em "key" (case-insensitive)', () => {
    mockGetHarnessProject.mockReturnValue(baseProject() as never);
    const bad = { ...validSessionConfig(), someKey: 'value' };
    expect(() => setSessionConfig(PROJECT_ID, bad as never)).toThrow(/chave proibida/i);
  });

  it('rejeita payload com chave proibida em objeto nested', () => {
    mockGetHarnessProject.mockReturnValue(baseProject() as never);
    const bad = {
      ...validSessionConfig(),
      meta: { nested: { apiKey: 'sk-...' } } as unknown,
    };
    expect(() => setSessionConfig(PROJECT_ID, bad as never)).toThrow(/chave proibida.*apiKey/i);
  });

  it('rejeita TOKEN_HEADER (uppercase + sufixo)', () => {
    mockGetHarnessProject.mockReturnValue(baseProject() as never);
    const bad = { ...validSessionConfig(), TOKEN_HEADER: 'x' };
    expect(() => setSessionConfig(PROJECT_ID, bad as never)).toThrow(/chave proibida/i);
  });

  it('rejeita modelo com label/display text em vez de slug', () => {
    mockGetHarnessProject.mockReturnValue(baseProject() as never);
    const bad = { ...validSessionConfig(), model: 'Claude Sonnet 4.6' };
    expect(() => setSessionConfig(PROJECT_ID, bad)).toThrow(/modelo invalido/i);
    expect(mockUpdateHarnessProject).not.toHaveBeenCalled();
  });

  it('aceita slugs e aliases de modelo usados pelo Open Design', () => {
    const project = baseProject();
    mockGetHarnessProject.mockReturnValue(project as never);
    mockUpdateHarnessProject.mockReturnValue(project as never);

    setSessionConfig(PROJECT_ID, { ...validSessionConfig(), model: 'sonnet' });

    const persistedOd = (
      mockUpdateHarnessProject.mock.calls[0]![1] as unknown as {
        config: { openDesign: Record<string, unknown> };
      }
    ).config.openDesign;
    expect(persistedOd.sessionConfig).toMatchObject({ model: 'sonnet' });
  });

  it('rejeita modelo GPT quando o agente selecionado eh Claude', () => {
    mockGetHarnessProject.mockReturnValue(baseProject() as never);

    expect(() =>
      setSessionConfig(PROJECT_ID, { ...validSessionConfig(), agentId: 'claude', model: 'gpt-5.5' }),
    ).toThrow(/nao pertence ao agente Claude/i);
    expect(mockUpdateHarnessProject).not.toHaveBeenCalled();
  });

  it('rejeita alias Opus quando o agente selecionado eh Codex', () => {
    mockGetHarnessProject.mockReturnValue(baseProject() as never);

    expect(() => setSessionConfig(PROJECT_ID, { ...validSessionConfig(), agentId: 'codex', model: 'opus' })).toThrow(
      /nao pertence ao agente Codex/i,
    );
    expect(mockUpdateHarnessProject).not.toHaveBeenCalled();
  });

  it('aceita GPT no agente Codex', () => {
    const project = baseProject();
    mockGetHarnessProject.mockReturnValue(project as never);
    mockUpdateHarnessProject.mockReturnValue(project as never);

    setSessionConfig(PROJECT_ID, { ...validSessionConfig(), agentId: 'codex', model: 'gpt-5.5' });

    const persistedOd = (
      mockUpdateHarnessProject.mock.calls[0]![1] as unknown as {
        config: { openDesign: Record<string, unknown> };
      }
    ).config.openDesign;
    expect(persistedOd.sessionConfig).toMatchObject({ agentId: 'codex', model: 'gpt-5.5' });
  });

  it('aceita aliases Claude no agente Claude', () => {
    const project = baseProject();
    mockGetHarnessProject.mockReturnValue(project as never);
    mockUpdateHarnessProject.mockReturnValue(project as never);

    setSessionConfig(PROJECT_ID, { ...validSessionConfig(), agentId: 'claude', model: 'opus' });

    const persistedOd = (
      mockUpdateHarnessProject.mock.calls[0]![1] as unknown as {
        config: { openDesign: Record<string, unknown> };
      }
    ).config.openDesign;
    expect(persistedOd.sessionConfig).toMatchObject({ agentId: 'claude', model: 'opus' });
  });

  it('setSessionConfig invalida conversationId e initialPromptHash', () => {
    const project = baseProject({
      sessionConfig: { ...validSessionConfig(), agentId: 'codex' },
      conversationId: 'conv_old',
      initialPromptHash: 'oldhash',
      initialPromptSentAt: '2025-01-01T00:00:00.000Z',
      sessionConfigHash: 'oldsessionhash',
      openDesignProjectId: 'lionclaw-foo',
    });
    mockGetHarnessProject.mockReturnValue(project as never);
    mockUpdateHarnessProject.mockReturnValue(project as never);

    setSessionConfig(PROJECT_ID, validSessionConfig());

    const updateArgs = mockUpdateHarnessProject.mock.calls[0]![1];
    const persistedOd = (updateArgs as unknown as { config: { openDesign: Record<string, unknown> } }).config
      .openDesign;
    expect(persistedOd.sessionConfig).toEqual(validSessionConfig());
    expect(persistedOd.openDesignProjectId).toBe('lionclaw-foo');
    expect(persistedOd.conversationId).toBeUndefined();
    expect(persistedOd.initialPromptHash).toBeUndefined();
    expect(persistedOd.initialPromptSentAt).toBeUndefined();
    expect(persistedOd.sessionConfigHash).toBeUndefined();
  });

  it('setSessionConfig grava o ultimo-config-usado na settings key (V6)', () => {
    const project = baseProject();
    mockGetHarnessProject.mockReturnValue(project as never);
    mockUpdateHarnessProject.mockReturnValue(project as never);

    const cfg = validSessionConfig();
    setSessionConfig(PROJECT_ID, cfg);

    expect(setSetting).toHaveBeenCalledWith(LAST_SESSION_CONFIG_SETTINGS_KEY, JSON.stringify(cfg));
  });

  it('payload REJEITADO nao grava o ultimo-config-usado (so apos sucesso)', () => {
    mockGetHarnessProject.mockReturnValue(baseProject() as never);
    const bad = { ...validSessionConfig(), model: 'Claude Sonnet 4.6' };

    expect(() => setSessionConfig(PROJECT_ID, bad)).toThrow(/modelo invalido/i);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('clearSessionConfig zera todos os derivados', () => {
    const project = baseProject({
      sessionConfig: validSessionConfig(),
      conversationId: 'conv_x',
      initialPromptHash: 'hashx',
      sessionConfigHash: 'sch',
    });
    mockGetHarnessProject.mockReturnValue(project as never);
    mockUpdateHarnessProject.mockReturnValue(project as never);

    clearSessionConfig(PROJECT_ID);

    const persistedOd = (
      mockUpdateHarnessProject.mock.calls[0]![1] as unknown as {
        config: { openDesign: Record<string, unknown> };
      }
    ).config.openDesign;
    expect(persistedOd.sessionConfig).toBeUndefined();
    expect(persistedOd.conversationId).toBeUndefined();
    expect(persistedOd.initialPromptHash).toBeUndefined();
  });
});
