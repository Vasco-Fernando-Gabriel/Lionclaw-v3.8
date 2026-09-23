import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  rootLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('../db', () => ({
  getSetting: vi.fn(),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(),
}));

import { getSetting } from '../db';
import { getSecret } from '../secrets-vault';
import { resolveOrchestratorSelection, __internal } from '../orchestrator-selection';

const mockedGetSetting = vi.mocked(getSetting);
const mockedGetSecret = vi.mocked(getSecret);

function setSettings(map: Record<string, string | undefined>) {
  mockedGetSetting.mockImplementation((key: string) => map[key]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetSecret.mockResolvedValue(null);
});

describe('SPEC-011 S2: kimi-sdk orchestrator runtime', () => {
  it('T-R1: existing kimi-* ids still resolve to lion-sdk (frozen HTTP preset)', () => {
    expect(__internal.inferRuntimeFromModel('kimi-k2.7-code')).toBe('lion-sdk');
    expect(__internal.inferRuntimeFromModel('kimi-code/kimi-for-coding')).toBe('lion-sdk');
    expect(__internal.isModelInRuntime('kimi-k2.7-code', 'lion-sdk')).toBe(true);
  });

  it('T-R2: kimi-sdk is reachable only by explicit selection, never by inference', () => {
    expect(__internal.inferRuntimeFromModel('kimi-code/kimi-for-coding')).not.toBe('kimi-sdk');
    expect(__internal.isModelInRuntime('kimi-code/kimi-for-coding', 'kimi-sdk')).toBe(true);
  });

  it('T-R3: kimi-code/kimi-for-coding membership is exclusive to kimi-sdk', () => {
    expect(__internal.isModelInRuntime('kimi-code/kimi-for-coding', 'kimi-sdk')).toBe(true);
    expect(__internal.isModelInRuntime('kimi-code/kimi-for-coding', 'claude-sdk')).toBe(false);
    expect(__internal.isModelInRuntime('kimi-code/kimi-for-coding', 'codex-sdk')).toBe(false);
    expect(__internal.isModelInRuntime('kimi-code/kimi-for-coding', 'claude-compat-sdk')).toBe(false);
    expect(__internal.isModelInRuntime('kimi-code/kimi-for-coding', 'lion-sdk')).toBe(false);
  });

  it('T-R4: defaultProviderForRuntime/defaultModelForRuntime for kimi-sdk', () => {
    expect(__internal.defaultProviderForRuntime('kimi-sdk')).toBe('kimi');
    expect(__internal.defaultModelForRuntime('kimi-sdk')).toBe('kimi-code/kimi-for-coding');
  });

  it('T-R5: resolveOrchestratorSelection returns kimi-sdk from explicit settings', async () => {
    setSettings({
      orchestrator_runtime: 'kimi-sdk',
      orchestrator_provider: 'kimi',
      orchestrator_model: 'kimi-code/kimi-for-coding',
    });
    const selection = await resolveOrchestratorSelection({ surface: 'default' });
    expect(selection).toEqual({
      runtime: 'kimi-sdk',
      provider: 'kimi',
      model: 'kimi-code/kimi-for-coding',
      source: 'settings',
    });
    expect(mockedGetSecret).not.toHaveBeenCalled();
  });

  it.each(['low', 'high'] as const)('preserva effort K3 %s na selecao principal', async (effort) => {
    setSettings({
      orchestrator_runtime: 'kimi-sdk',
      orchestrator_provider: 'kimi',
      orchestrator_model: 'kimi-code/k3',
      orchestrator_kimi_effort: effort,
    });

    await expect(resolveOrchestratorSelection({ surface: 'default' })).resolves.toEqual({
      runtime: 'kimi-sdk',
      provider: 'kimi',
      model: 'kimi-code/k3',
      effort,
      source: 'settings',
    });
  });

  it('omite effort no K2.7 boolean-only mesmo quando existe setting legado', async () => {
    setSettings({
      orchestrator_runtime: 'kimi-sdk',
      orchestrator_provider: 'kimi',
      orchestrator_model: 'kimi-code/kimi-for-coding',
      orchestrator_kimi_effort: 'max',
    });

    await expect(resolveOrchestratorSelection({ surface: 'default' })).resolves.not.toHaveProperty('effort');
  });
});
