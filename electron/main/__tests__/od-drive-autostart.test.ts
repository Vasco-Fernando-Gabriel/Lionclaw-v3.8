
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../db', () => {
  const getDriveState = vi.fn();
  return {
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    getDriveState,
    isDriveEngaged: vi.fn((id: string) => {
      const d = getDriveState(id) as { driver?: string; status?: string } | null;
      return !!d && d.driver === 'orchestrator' && d.status !== 'stopped';
    }),
  };
});

vi.mock('../open-design/session-config', () => ({
  getSessionConfig: vi.fn(),
  setSessionConfig: vi.fn(),
  LAST_SESSION_CONFIG_SETTINGS_KEY: 'openDesign.lastSessionConfig',
}));

vi.mock('../open-design/config', () => ({
  getOpenDesignConfig: vi.fn(),
}));

vi.mock('../open-design/bootstrap', () => ({
  ensureSession: vi.fn(async () => ({
    openDesignProjectId: 'lionclaw-run1',
    conversationId: 'conv_1',
    webUrl: 'http://127.0.0.1:5175/projects/lionclaw-run1',
    initialPromptHash: 'hash',
    initialPromptSentAt: '2026-06-09T00:00:00.000Z',
    bootstrappedAt: '2026-06-09T00:00:00.000Z',
  })),
}));

vi.mock('../activity-log', () => ({
  recordSystemActivity: vi.fn(),
}));

import { getSetting, getDriveState } from '../db';
import { getSessionConfig, setSessionConfig } from '../open-design/session-config';
import { getOpenDesignConfig } from '../open-design/config';
import { ensureSession } from '../open-design/bootstrap';
import { recordSystemActivity } from '../activity-log';
import {
  maybeAutostartDesignSession,
  isDriveStartPending,
} from '../open-design/drive-autostart';
import { CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';
import type { OpenDesignSessionConfig } from '../../../src/types/open-design';

const getSessionConfigMock = getSessionConfig as Mock;
const setSessionConfigMock = setSessionConfig as Mock;
const getSettingMock = getSetting as Mock;
const ensureSessionMock = ensureSession as Mock;
const getDriveStateMock = getDriveState as Mock;
const getOpenDesignConfigMock = getOpenDesignConfig as Mock;
const recordSystemActivityMock = recordSystemActivity as Mock;

const PROJECT_ID = 'proj_dev_v2';

function lastSaved(): OpenDesignSessionConfig {
  return {
    agentId: 'codex',
    model: 'gpt-5.3-codex',
    reasoning: 'high',
    memoryEnabled: true,
    mcpServerIds: ['mcp_1'],
    locale: 'pt-BR',
    configuredAt: '2026-06-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionConfigMock.mockReturnValue(null);
  getSettingMock.mockReturnValue(undefined);
  getDriveStateMock.mockReturnValue(null);
  getOpenDesignConfigMock.mockReturnValue(null);
});

describe('maybeAutostartDesignSession (I5)', () => {
  it('sessionConfig existente -> no-op idempotente: nem set nem ensure (I5-AC3)', async () => {
    getSessionConfigMock.mockReturnValue({
      agentId: 'claude',
      model: CLAUDE_DEFAULT_MODEL,
      memoryEnabled: false,
      mcpServerIds: [],
      locale: 'pt-BR',
      configuredAt: '2026-06-01T00:00:00.000Z',
    });

    await maybeAutostartDesignSession(PROJECT_ID);

    expect(setSessionConfigMock).not.toHaveBeenCalled();
    expect(ensureSessionMock).not.toHaveBeenCalled();
  });

  it('null + sem ultimo salvo -> ABORTA sem inventar config (AC-20)', async () => {
    await expect(maybeAutostartDesignSession(PROJECT_ID)).resolves.toBeUndefined();

    expect(setSessionConfigMock).not.toHaveBeenCalled();
    expect(ensureSessionMock).not.toHaveBeenCalled();
    expect(recordSystemActivityMock).toHaveBeenCalledTimes(1);
    const arg = recordSystemActivityMock.mock.calls[0][0] as { status?: string };
    expect(arg.status).toBe('error');
  });

  it('null + ultimo salvo valido -> usa o ultimo (configuredAt renovado) + ensure', async () => {
    getSettingMock.mockReturnValue(JSON.stringify(lastSaved()));

    await maybeAutostartDesignSession(PROJECT_ID);

    expect(getSettingMock).toHaveBeenCalledWith('openDesign.lastSessionConfig');
    expect(setSessionConfigMock).toHaveBeenCalledTimes(1);
    const cfg = setSessionConfigMock.mock.calls[0][1] as OpenDesignSessionConfig;
    expect(cfg.agentId).toBe('codex');
    expect(cfg.model).toBe('gpt-5.3-codex');
    expect(cfg.reasoning).toBe('high');
    expect(cfg.configuredAt).not.toBe('2026-06-01T00:00:00.000Z');
    expect(ensureSessionMock).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('ultimo salvo CORROMPIDO (JSON invalido) -> ABORTA sem inventar config (AC-20)', async () => {
    getSettingMock.mockReturnValue('{nao-e-json');

    await expect(maybeAutostartDesignSession(PROJECT_ID)).resolves.toBeUndefined();

    expect(setSessionConfigMock).not.toHaveBeenCalled();
    expect(ensureSessionMock).not.toHaveBeenCalled();
    expect(recordSystemActivityMock).toHaveBeenCalledTimes(1);
  });

  it('ultimo salvo REJEITADO pelo setSessionConfig -> ABORTA (sem fallback, AC-20)', async () => {
    getSettingMock.mockReturnValue(JSON.stringify(lastSaved()));
    setSessionConfigMock.mockImplementationOnce(() => {
      throw new Error('OpenDesignSessionConfig: modelo invalido');
    });

    await expect(maybeAutostartDesignSession(PROJECT_ID)).resolves.toBeUndefined();

    expect(setSessionConfigMock).toHaveBeenCalledTimes(1);
    expect(ensureSessionMock).not.toHaveBeenCalled();
    expect(recordSystemActivityMock).toHaveBeenCalledTimes(1);
  });

  it('ensureSession com { error } -> nao lanca (loga e a fase fica para o humano)', async () => {
    getSettingMock.mockReturnValue(JSON.stringify(lastSaved()));
    ensureSessionMock.mockResolvedValueOnce({ error: 'boot install not ready' });

    await expect(maybeAutostartDesignSession(PROJECT_ID)).resolves.toBeUndefined();
    expect(setSessionConfigMock).toHaveBeenCalledTimes(1);
  });

  it('ensureSession que LANCA -> capturado (nunca propaga pro coordenador)', async () => {
    ensureSessionMock.mockRejectedValueOnce(new Error('daemon indisponivel'));

    await expect(maybeAutostartDesignSession(PROJECT_ID)).resolves.toBeUndefined();
  });


  it('W3.0-AC1 + AC-20: startGeneration=false sem ultimo-usado -> ABORTA (nao inventa config, zero ensureSession)', async () => {
    await expect(maybeAutostartDesignSession(PROJECT_ID, false)).resolves.toBeUndefined();

    expect(setSessionConfigMock).not.toHaveBeenCalled();
    expect(ensureSessionMock).not.toHaveBeenCalled();
    expect(recordSystemActivityMock).toHaveBeenCalledTimes(1);
  });

  it('W3.0-AC1: startGeneration=false COM ultimo-usado -> semeia mas NAO inicia geracao', async () => {
    getSettingMock.mockReturnValue(JSON.stringify(lastSaved()));

    await maybeAutostartDesignSession(PROJECT_ID, false);

    expect(setSessionConfigMock).toHaveBeenCalledTimes(1);
    const cfg = setSessionConfigMock.mock.calls[0][1] as OpenDesignSessionConfig;
    expect(cfg.agentId).toBe('codex');
    expect(ensureSessionMock).not.toHaveBeenCalled();
  });

  it('W3.0-AC3: startGeneration=false com ultimo-usado -> semeia o ultimo salvo, sem ensureSession', async () => {
    getSettingMock.mockReturnValue(JSON.stringify(lastSaved()));

    await maybeAutostartDesignSession(PROJECT_ID, false);

    expect(setSessionConfigMock).toHaveBeenCalledTimes(1);
    const cfg = setSessionConfigMock.mock.calls[0][1] as OpenDesignSessionConfig;
    expect(cfg.agentId).toBe('codex');
    expect(cfg.model).toBe('gpt-5.3-codex');
    expect(ensureSessionMock).not.toHaveBeenCalled();
  });

  it('W3.0: startGeneration=false com sessionConfig existente -> no-op (nem set nem ensure)', async () => {
    getSessionConfigMock.mockReturnValue({
      agentId: 'claude',
      model: CLAUDE_DEFAULT_MODEL,
      memoryEnabled: false,
      mcpServerIds: [],
      locale: 'pt-BR',
      configuredAt: '2026-06-01T00:00:00.000Z',
    });

    await maybeAutostartDesignSession(PROJECT_ID, false);

    expect(setSessionConfigMock).not.toHaveBeenCalled();
    expect(ensureSessionMock).not.toHaveBeenCalled();
  });

  it('default (startGeneration omitido) COM ultimo-usado: semeia + ensureSession', async () => {
    getSettingMock.mockReturnValue(JSON.stringify(lastSaved()));

    await maybeAutostartDesignSession(PROJECT_ID);

    expect(setSessionConfigMock).toHaveBeenCalledTimes(1);
    expect(ensureSessionMock).toHaveBeenCalledWith(PROJECT_ID);
  });
});


const ENGAGED_DRIVE = {
  driver: 'orchestrator',
  status: 'driving',
  handoff: 'auto',
  mode: 'semi',
  requiresHumanPhases: [],
} as unknown;

describe('isDriveStartPending (W3.0 - anti-furo pela UI)', () => {
  it('sem drive engajado -> false (fluxo humano nunca bloqueia)', () => {
    getDriveStateMock.mockReturnValue(null);
    getOpenDesignConfigMock.mockReturnValue(null);

    expect(isDriveStartPending(PROJECT_ID)).toBe(false);
    expect(getDriveStateMock).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('drive engajado + sem config OD -> true (start ainda nao dado, W3.0-AC5)', () => {
    getDriveStateMock.mockReturnValue(ENGAGED_DRIVE);
    getOpenDesignConfigMock.mockReturnValue(null);

    expect(isDriveStartPending(PROJECT_ID)).toBe(true);
  });

  it('drive engajado + config sem conversationId/initialPromptSentAt -> true', () => {
    getDriveStateMock.mockReturnValue(ENGAGED_DRIVE);
    getOpenDesignConfigMock.mockReturnValue({ runId: 'run1' });

    expect(isDriveStartPending(PROJECT_ID)).toBe(true);
  });

  it('drive engajado + conversationId vigente -> false (GO ja dado; canal volta ao normal)', () => {
    getDriveStateMock.mockReturnValue(ENGAGED_DRIVE);
    getOpenDesignConfigMock.mockReturnValue({ conversationId: 'conv_1' });

    expect(isDriveStartPending(PROJECT_ID)).toBe(false);
  });

  it('drive engajado + initialPromptSentAt vigente -> false (start dado)', () => {
    getDriveStateMock.mockReturnValue(ENGAGED_DRIVE);
    getOpenDesignConfigMock.mockReturnValue({
      initialPromptSentAt: '2026-06-11T00:00:00.000Z',
    });

    expect(isDriveStartPending(PROJECT_ID)).toBe(false);
  });

  it('drive engajado + conversationId vazio "" -> true (string vazia nao conta como start)', () => {
    getDriveStateMock.mockReturnValue(ENGAGED_DRIVE);
    getOpenDesignConfigMock.mockReturnValue({
      conversationId: '',
      initialPromptSentAt: '',
    });

    expect(isDriveStartPending(PROJECT_ID)).toBe(true);
  });

  it('drive PARADO (stopped) antes do GO -> false (humano nao fica preso em drive-pending-go)', () => {
    getDriveStateMock.mockReturnValue({ ...(ENGAGED_DRIVE as object), status: 'stopped' });
    getOpenDesignConfigMock.mockReturnValue({ conversationId: '', initialPromptSentAt: '' });

    expect(isDriveStartPending(PROJECT_ID)).toBe(false);
  });

  it('humano ASSUMIU (driver human) antes do GO -> false (UI do OD liberada)', () => {
    getDriveStateMock.mockReturnValue({
      ...(ENGAGED_DRIVE as object),
      driver: 'human',
      handoff: 'permanent',
      status: 'stopped',
    });
    getOpenDesignConfigMock.mockReturnValue(null);

    expect(isDriveStartPending(PROJECT_ID)).toBe(false);
  });
});


describe('maybeAutostartDesignSession - A1: config resolvido so via settings/fallback', () => {
  it('autostart usa lastSessionConfig (settings global) e semeia para o projeto pedido', async () => {
    getSettingMock.mockReturnValue(
      JSON.stringify({
        agentId: 'codex',
        model: 'gpt-5.3-codex',
        memoryEnabled: false,
        mcpServerIds: [],
        locale: 'pt-BR',
        configuredAt: '2026-06-01T00:00:00.000Z',
      }),
    );

    await maybeAutostartDesignSession('projeto_OUTRO', false);

    expect(setSessionConfigMock).toHaveBeenCalledTimes(1);
    const [pid] = setSessionConfigMock.mock.calls[0] as [string, OpenDesignSessionConfig];
    expect(pid).toBe('projeto_OUTRO');
    expect(getOpenDesignConfigMock).not.toHaveBeenCalled();
  });

  it('sem ultimo-usado: ABORTA sem semear (fallback removido, AC-20)', async () => {
    getSettingMock.mockReturnValue(undefined);

    await expect(
      maybeAutostartDesignSession('projeto_limpo', false),
    ).resolves.toBeUndefined();

    expect(setSessionConfigMock).not.toHaveBeenCalled();
    expect(getOpenDesignConfigMock).not.toHaveBeenCalled();
  });
});
