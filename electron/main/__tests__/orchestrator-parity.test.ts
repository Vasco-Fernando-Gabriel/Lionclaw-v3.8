
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
import {
  resolveOrchestratorSelection,
  type OrchestratorSelection,
} from '../orchestrator-selection';

const mockedGetSetting = vi.mocked(getSetting);
const mockedGetSecret = vi.mocked(getSecret);

const FIXED_CLAUDE_SETTINGS: Record<string, string | undefined> = {
  orchestrator_runtime: 'claude-sdk',
  orchestrator_provider: 'anthropic',
  orchestrator_model: 'claude-opus-4-8',
};

function setSettings(map: Record<string, string | undefined>) {
  mockedGetSetting.mockImplementation((key: string) => map[key]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetSecret.mockResolvedValue(null);
});

describe('AC-12 parity gate: claude-sdk settings fixos -> selection estavel', () => {
  it('resolve o mesmo runtime/provider/model/source (snapshot inline)', async () => {
    setSettings(FIXED_CLAUDE_SETTINGS);
    const sel = await resolveOrchestratorSelection({ surface: 'main-chat' });

    const snapshot: Pick<
      OrchestratorSelection,
      'runtime' | 'provider' | 'model' | 'source'
    > = {
      runtime: sel.runtime,
      provider: sel.provider,
      model: sel.model,
      source: sel.source,
    };
    expect(snapshot).toEqual({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      source: 'settings',
    });
  });

  it('e deterministico: duas resolucoes com os mesmos settings sao identicas', async () => {
    setSettings(FIXED_CLAUDE_SETTINGS);
    const a = await resolveOrchestratorSelection({ surface: 'main-chat' });
    const b = await resolveOrchestratorSelection({ surface: 'main-chat' });
    expect({
      runtime: a.runtime,
      provider: a.provider,
      model: a.model,
      source: a.source,
    }).toEqual({
      runtime: b.runtime,
      provider: b.provider,
      model: b.model,
      source: b.source,
    });
  });

  it('agentModel NAO muda runtime/provider, MAS sobrescreve o modelo (S4: source agent)', async () => {
    setSettings(FIXED_CLAUDE_SETTINGS);
    const sel = await resolveOrchestratorSelection({
      surface: 'main-chat',
      agentModel: 'claude-sonnet-4-6',
    });
    expect(sel.runtime).toBe('claude-sdk');
    expect(sel.provider).toBe('anthropic');
    expect(sel.model).toBe('claude-sonnet-4-6');
    expect(sel.source).toBe('agent');
  });
});
