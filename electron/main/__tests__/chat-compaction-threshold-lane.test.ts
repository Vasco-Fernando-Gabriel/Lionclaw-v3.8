import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({
  orchestrators: new Map<string, { runtime: string; provider: string; model: string; effort?: string }>(),
  settings: { orchestrator_model: 'claude-haiku-4-5-20251001', orchestrator_provider: 'anthropic' } as Record<
    string,
    string
  >,
}));

vi.mock('../db', () => ({
  getSession: vi.fn(),
  getSessionOrchestrator: (id: string) => h.orchestrators.get(id) ?? null,
  getSetting: (key: string) => h.settings[key],
}));
vi.mock('../chat-compaction-inplace', () => ({ compactChatSessionInPlace: vi.fn() }));
vi.mock('../clearing-sessions', () => ({ isSessionClearing: () => false }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
}));

import { getChatCompactionThreshold } from '../chat-compaction-trigger';

describe('AC-13 (main): limiar de Compactacao por lane', () => {
  it('cada lane usa a janela do proprio modelo; o padrao global so entra sem lane', () => {
    h.orchestrators.set('lane-claude', {
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-opus-5',
      effort: 'max',
    });
    h.orchestrators.set('lane-codex', {
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-5.4-mini',
      effort: 'low',
    });

    expect(getChatCompactionThreshold(undefined, 'lane-claude')).toBe(Math.floor(1_000_000 * 0.8));
    expect(getChatCompactionThreshold(undefined, 'lane-codex')).toBe(Math.floor(400_000 * 0.8));
    expect(getChatCompactionThreshold()).toBe(Math.floor(200_000 * 0.8));
  });

  it('P3-2 (RM7): lane sem colunas de orquestrador = sem gatilho (undefined), nunca o padrao global', () => {
    h.orchestrators.delete('lane-sem-colunas');
    expect(getChatCompactionThreshold(undefined, 'lane-sem-colunas')).toBeUndefined();
    expect(getChatCompactionThreshold(undefined, 'dw-drive-sem-colunas')).toBeUndefined();
  });

  it('turnModel explicito vence as colunas da lane', () => {
    h.orchestrators.set('lane-x', { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-5' });
    expect(getChatCompactionThreshold({ model: 'gpt-5.4-mini', provider: 'codex' }, 'lane-x')).toBe(
      Math.floor(400_000 * 0.8),
    );
  });
});
