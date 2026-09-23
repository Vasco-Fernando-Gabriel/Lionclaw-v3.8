import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

vi.mock('../db', () => ({
  getSetting: vi.fn(),
  getSessionOrchestrator: vi.fn(),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(),
}));

vi.mock('../codex-runtime/model-capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../codex-runtime/model-capabilities')>();
  return { ...actual, getCodexModelCapabilities: vi.fn(async () => null), findDiscoveredCodexModel: () => undefined };
});

import { getSetting, getSessionOrchestrator } from '../db';
import { getSecret } from '../secrets-vault';
import {
  resolveOrchestratorSelection,
  InvalidOrchestratorSelectionError,
  readDefaultOrchestratorColumns,
} from '../orchestrator-selection';
import { cronLane, telegramLane, type SdkLane } from '../sdk-lane';

const desktopLane: SdkLane = {
  name: 'desktop',
  kind: 'desktop',
  sdkActiveSessionId: null,
  currentAbortController: null,
};

const mockedGetSetting = vi.mocked(getSetting);
const mockedGetSessionOrchestrator = vi.mocked(getSessionOrchestrator);

const DEFAULT_SETTINGS: Record<string, string> = {
  orchestrator_runtime: 'codex-sdk',
  orchestrator_provider: 'codex',
  orchestrator_model: 'gpt-5.5',
  orchestrator_codex_effort: 'xhigh',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetSetting.mockImplementation((key: string) => DEFAULT_SETTINGS[key]);
  mockedGetSessionOrchestrator.mockReturnValue(null);
});

describe('7.2 (V1/V11): resolucao por lane.kind', () => {
  it('desktop le as colunas da sessao, nao o Orquestrador padrao (AC-16)', async () => {
    mockedGetSessionOrchestrator.mockReturnValue({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
    });
    const sel = await resolveOrchestratorSelection({
      surface: 'main-chat',
      lane: desktopLane,
      sessionId: 'lane-A',
    });
    expect(mockedGetSessionOrchestrator).toHaveBeenCalledWith('lane-A');
    expect(sel).toMatchObject({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      source: 'settings',
    });
  });

  it('sessao dw-drive-* roda pelo caminho desktop e le as PROPRIAS colunas (AC-22)', async () => {
    mockedGetSessionOrchestrator.mockReturnValue({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    const sel = await resolveOrchestratorSelection({
      surface: 'main-chat',
      lane: desktopLane,
      sessionId: 'dw-drive-run1-abc',
    });
    expect(sel.model).toBe('claude-sonnet-4-6');
    expect(sel.runtime).toBe('claude-sdk');
  });

  it('desktop sem sessionId = session_required (RM7)', async () => {
    await expect(resolveOrchestratorSelection({ surface: 'main-chat', lane: desktopLane })).rejects.toMatchObject({
      name: 'InvalidOrchestratorSelectionError',
      code: 'session_required',
    });
    expect(mockedGetSessionOrchestrator).not.toHaveBeenCalled();
  });

  it('desktop com sessao sem colunas = orchestrator_unconfigured, nunca fallback ao padrao', async () => {
    mockedGetSessionOrchestrator.mockReturnValue(null);
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat', lane: desktopLane, sessionId: 'lane-vazia' }),
    ).rejects.toMatchObject({ code: 'orchestrator_unconfigured' });
  });

  it('main-chat sem lane = lane_required', async () => {
    await expect(resolveOrchestratorSelection({ surface: 'main-chat', sessionId: 'x' })).rejects.toBeInstanceOf(
      InvalidOrchestratorSelectionError,
    );
    await expect(resolveOrchestratorSelection({ surface: 'main-chat', sessionId: 'x' })).rejects.toMatchObject({
      code: 'lane_required',
    });
  });

  it('telegram e cron usam o Orquestrador padrao (settings) e ignoram colunas', async () => {
    mockedGetSessionOrchestrator.mockReturnValue({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
    });
    for (const lane of [telegramLane, cronLane]) {
      const sel = await resolveOrchestratorSelection({ surface: 'main-chat', lane, sessionId: 'tg-1' });
      expect(sel).toMatchObject({ runtime: 'codex-sdk', provider: 'codex', model: 'gpt-5.5' });
    }
    expect(mockedGetSessionOrchestrator).not.toHaveBeenCalled();
  });

  it("surface 'default' = settings + validateOrchestratorTriple (sync de subagentes, lane nova)", async () => {
    const sel = await resolveOrchestratorSelection({ surface: 'default' });
    expect(sel).toMatchObject({ runtime: 'codex-sdk', provider: 'codex', model: 'gpt-5.5' });
    expect(mockedGetSessionOrchestrator).not.toHaveBeenCalled();
  });

  it('requestedModel do turno e validado contra o provider DA LANE, nao do padrao', async () => {
    mockedGetSessionOrchestrator.mockReturnValue({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
    });
    await expect(
      resolveOrchestratorSelection({
        surface: 'main-chat',
        lane: desktopLane,
        sessionId: 'lane-A',
        requestedModel: 'gpt-5.5',
      }),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });

  it('readDefaultOrchestratorColumns espelha o padrao com o effort do runtime', () => {
    expect(readDefaultOrchestratorColumns()).toEqual({
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'xhigh',
    });
  });
});

describe('7.6: effort por lane na OrchestratorSelection', () => {
  it('desktop: effort vem da coluna da lane, nao do setting global (claude)', async () => {
    mockedGetSetting.mockImplementation(
      (key: string) =>
        ({
          ...DEFAULT_SETTINGS,
          orchestrator_runtime: 'claude-sdk',
          orchestrator_provider: 'anthropic',
          orchestrator_model: 'claude-opus-5',
          orchestrator_effort: 'low',
        })[key],
    );
    mockedGetSessionOrchestrator.mockReturnValue({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-opus-5',
      effort: 'max',
    });
    const sel = await resolveOrchestratorSelection({ surface: 'main-chat', lane: desktopLane, sessionId: 'lane-2' });
    expect(sel.effort).toBe('max');
  });

  it('desktop: duas lanes com efforts distintos resolvem cada uma o proprio (AC-14 lado resolver)', async () => {
    mockedGetSessionOrchestrator.mockImplementation((id: string) =>
      id === 'lane-1'
        ? { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-5', effort: 'low' }
        : { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-5', effort: 'max' },
    );
    expect(
      (await resolveOrchestratorSelection({ surface: 'main-chat', lane: desktopLane, sessionId: 'lane-1' })).effort,
    ).toBe('low');
    expect(
      (await resolveOrchestratorSelection({ surface: 'main-chat', lane: desktopLane, sessionId: 'lane-2' })).effort,
    ).toBe('max');
  });

  it('coluna sem effort = default do runtime (claude high; codex high clampado ao modelo)', async () => {
    mockedGetSessionOrchestrator.mockReturnValue({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-opus-5',
    });
    expect(
      (await resolveOrchestratorSelection({ surface: 'main-chat', lane: desktopLane, sessionId: 'a' })).effort,
    ).toBe('high');
    mockedGetSessionOrchestrator.mockReturnValue({
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-5.2',
      effort: 'xhigh',
    });
    expect(
      (await resolveOrchestratorSelection({ surface: 'main-chat', lane: desktopLane, sessionId: 'a' })).effort,
    ).toBe('high');
  });

  it('telegram/cron: effort vem do setting global do runtime (codex xhigh)', async () => {
    const sel = await resolveOrchestratorSelection({ surface: 'main-chat', lane: telegramLane, sessionId: 'tg' });
    expect(sel).toMatchObject({ runtime: 'codex-sdk', model: 'gpt-5.5', effort: 'xhigh' });
  });

  it('runtimes sem effort (compat) nao carregam o campo', async () => {
    mockedGetSetting.mockImplementation((key: string) => ({ orchestrator_zai_api_key_ref: 'ZAI' })[key]);
    vi.mocked(getSecret).mockResolvedValue('k');
    mockedGetSessionOrchestrator.mockReturnValue({
      runtime: 'claude-compat-sdk',
      provider: 'zai',
      model: 'glm-5.2',
      effort: 'max',
    });
    const sel = await resolveOrchestratorSelection({ surface: 'main-chat', lane: desktopLane, sessionId: 'a' });
    expect(sel).not.toHaveProperty('effort');
  });

  it('requestedEffort valido vence a coluna; invalido = effort_not_supported; requestedModel fora do provider = model_not_in_provider', async () => {
    mockedGetSessionOrchestrator.mockReturnValue({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-opus-5',
      effort: 'high',
    });
    const sel = await resolveOrchestratorSelection({
      surface: 'main-chat',
      lane: desktopLane,
      sessionId: 'a',
      requestedEffort: 'low',
    });
    expect(sel).toMatchObject({ effort: 'low', source: 'request' });
    await expect(
      resolveOrchestratorSelection({
        surface: 'main-chat',
        lane: desktopLane,
        sessionId: 'a',
        requestedEffort: 'ultra',
      }),
    ).rejects.toMatchObject({ code: 'effort_not_supported' });
    await expect(
      resolveOrchestratorSelection({
        surface: 'main-chat',
        lane: desktopLane,
        sessionId: 'a',
        requestedModel: 'gpt-5.5',
      }),
    ).rejects.toMatchObject({ code: 'model_not_in_provider' });
  });

  it("surface 'default' com selection explicita (7.7) resolve a selecao e ecoa o effort; fora de default e recusada", async () => {
    const sel = await resolveOrchestratorSelection({
      surface: 'default',
      selection: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-sonnet-5', effort: 'max' },
    });
    expect(sel).toMatchObject({ runtime: 'claude-sdk', model: 'claude-sonnet-5', effort: 'max' });
    expect(mockedGetSessionOrchestrator).not.toHaveBeenCalled();
    await expect(
      resolveOrchestratorSelection({
        surface: 'main-chat',
        lane: desktopLane,
        sessionId: 'a',
        selection: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-sonnet-5' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_selection' });
  });

  it('AC-16 estendido: trocar o effort global em Settings nao altera o effort de lane aberta', async () => {
    mockedGetSessionOrchestrator.mockReturnValue({
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'low',
    });
    mockedGetSetting.mockImplementation(
      (key: string) => ({ ...DEFAULT_SETTINGS, orchestrator_codex_effort: 'max' })[key],
    );
    const lane = await resolveOrchestratorSelection({ surface: 'main-chat', lane: desktopLane, sessionId: 'a' });
    expect(lane.effort).toBe('low');
    const fresh = readDefaultOrchestratorColumns();
    expect(fresh?.effort).toBe('max');
  });
});
