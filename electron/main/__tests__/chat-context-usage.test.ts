
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const h = {
  getSetting: vi.fn<(key: string) => string | undefined>(() => undefined),
};

vi.mock('../db', () => ({
  getSetting: (key: string) => h.getSetting(key),
}));

import {
  buildChatContextUsage,
  resolveCompactionThresholdPercent,
  resolveLionContextWindowTokens,
} from '../chat-context-usage';
import {
  setProbedContextWindows,
  clearProbedContextWindows,
} from '../agent-runtime/model-context-windows';
import {
  DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT,
  CHAT_COMPACTION_TRIGGER_PERCENT_SETTING_KEY,
} from '../chat-compaction-defaults';

beforeEach(() => {
  h.getSetting.mockReset();
  h.getSetting.mockReturnValue(undefined);
  clearProbedContextWindows();
});

describe('AC-A3: payload da barrinha por runtime (contextTokens / getContextWindow)', () => {
  it('AC-A3: cloud (Claude) — usage real do turno, janela do resolver, source provider', () => {
    const usage = buildChatContextUsage({
      model: 'claude-fable-5',
      provider: 'anthropic',
      contextTokens: 850 + 40,
      source: 'provider',
    });
    expect(usage).toEqual({
      contextTokens: 890,
      contextWindowTokens: 1_000_000,
      compactionThresholdPercent: 80,
      source: 'provider',
    });
  });

  it('AC-A3: compat GLM — glm-5.2 -> 1M (SPEC 0.5), source estimate', () => {
    const usage = buildChatContextUsage({
      model: 'glm-5.2',
      provider: 'zai',
      contextTokens: 123_456,
      source: 'estimate',
    });
    expect(usage?.contextWindowTokens).toBe(1_000_000);
    expect(usage?.contextTokens).toBe(123_456);
    expect(usage?.source).toBe('estimate');
  });

  it('AC-A3: compat MiniMax — MiniMax-M2.7 (case-insensitive) -> 204.800 (nao 196.608)', () => {
    const usage = buildChatContextUsage({
      model: 'MiniMax-M2.7',
      provider: 'minimax',
      contextTokens: 50_000,
      source: 'estimate',
    });
    expect(usage?.contextWindowTokens).toBe(204_800);
  });

  it('AC-A3: kimi — kimi-k2.6 -> 262.144 (exato, nao o "256K" arredondado)', () => {
    const usage = buildChatContextUsage({
      model: 'kimi-k2.6',
      provider: 'kimi',
      contextTokens: 10_000,
      source: 'estimate',
    });
    expect(usage?.contextWindowTokens).toBe(262_144);
  });

  it('AC-A3: codex — gpt-5.5 -> 1.05M (janela REAL, nao o breakpoint de preco 272K)', () => {
    const usage = buildChatContextUsage({
      model: 'gpt-5.5',
      provider: 'codex',
      contextTokens: 200_000,
      source: 'estimate',
    });
    expect(usage?.contextWindowTokens).toBe(1_050_000);
  });

  it('AC-A3: contextTokens fracionario e floored (payload inteiro)', () => {
    const usage = buildChatContextUsage({
      model: 'claude-fable-5',
      contextTokens: 100.9,
      source: 'estimate',
    });
    expect(usage?.contextTokens).toBe(100);
  });

  it('AC-A3: threshold vem do setting orchestrator_compaction_threshold_percent (clamp 50-95)', () => {
    h.getSetting.mockImplementation((key) =>
      key === 'orchestrator_compaction_threshold_percent' ? '85' : undefined,
    );
    expect(resolveCompactionThresholdPercent()).toBe(85);

    h.getSetting.mockImplementation(() => '30');
    expect(resolveCompactionThresholdPercent()).toBe(50); // clamp inferior

    h.getSetting.mockImplementation(() => '99');
    expect(resolveCompactionThresholdPercent()).toBe(95); // clamp superior

    h.getSetting.mockImplementation(() => 'lixo');
    expect(resolveCompactionThresholdPercent()).toBe(80); // UX-CTX (fix 3): default unificado (v129)
  });
});

describe('UX-CTX-3: % da barrinha vem da MESMA cadeia do gatilho (fonte unica)', () => {
  it('UX-CTX-3: setting ausente -> default do gatilho (leaf), nao o 70 legado', () => {
    h.getSetting.mockReturnValue(undefined);
    expect(resolveCompactionThresholdPercent()).toBe(DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT);
    expect(DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT).toBe(80);
  });

  it('UX-CTX-3: le a MESMA key que o gatilho (outras keys nao afetam)', () => {
    h.getSetting.mockImplementation((key) =>
      key === CHAT_COMPACTION_TRIGGER_PERCENT_SETTING_KEY ? '88' : 'lixo-de-outra-key',
    );
    expect(resolveCompactionThresholdPercent()).toBe(88);
  });
});

describe('AC-A4: janela undefined -> sem barrinha (D5), sem crash', () => {
  it('AC-A4: modelo desconhecido -> undefined (caller nao emite chunk)', () => {
    expect(
      buildChatContextUsage({
        model: 'modelo-misterioso-9000',
        provider: 'external',
        contextTokens: 1000,
        source: 'estimate',
      }),
    ).toBeUndefined();
  });

  it('AC-A4: model ausente (selection?.model undefined no path cloud) -> undefined, sem throw', () => {
    expect(
      buildChatContextUsage({
        model: undefined,
        contextTokens: 1000,
        source: 'provider',
      }),
    ).toBeUndefined();
  });

  it('AC-A4: contextTokens invalido (NaN / negativo) -> undefined, sem throw', () => {
    expect(
      buildChatContextUsage({ model: 'claude-fable-5', contextTokens: NaN, source: 'estimate' }),
    ).toBeUndefined();
    expect(
      buildChatContextUsage({ model: 'claude-fable-5', contextTokens: -1, source: 'estimate' }),
    ).toBeUndefined();
  });
});

describe('SA-2: lion-sdk resolve a janela pelo resolver (nao pelo setting manual)', () => {
  it('modelo conhecido pelo resolver vence o setting manual (qualquer provider)', () => {
    expect(resolveLionContextWindowTokens('deepseek-chat', 'deepseek', 999)).toBe(128_000);
  });

  it('probe local (F6) sobrescreve via resolver', () => {
    setProbedContextWindows('ollama', [{ id: 'meu-modelo-local', contextWindow: 32_768 }]);
    expect(resolveLionContextWindowTokens('meu-modelo-local', 'ollama', 999)).toBe(32_768);
  });

  it('local desconhecido do resolver -> fallback pro setting manual (comportamento anterior)', () => {
    expect(resolveLionContextWindowTokens('modelo-local-obscuro', 'ollama', 8192)).toBe(8192);
    expect(resolveLionContextWindowTokens('modelo-local-obscuro', 'lmstudio', undefined)).toBeUndefined();
  });

  it('AC-A4: nao-local desconhecido -> undefined (sem barrinha, D5)', () => {
    expect(resolveLionContextWindowTokens('modelo-misterioso', 'openai-compatible', 999)).toBeUndefined();
  });
});

describe('AC-A3: fiacao — os 4 runtimes que nao emitiam passam a emitir context_usage', () => {
  const read = (rel: string) =>
    readFileSync(join(__dirname, '..', rel), 'utf-8');

  it.each([
    ['orchestrator.ts (cloud, query() direto)', 'orchestrator.ts'],
    ['claude-compat-sdk', 'claude-compat-sdk/index.ts'],
    ['kimi-sdk', 'kimi-sdk/index.ts'],
    ['codex-sdk', 'codex-sdk/index.ts'],
  ])('AC-A3: %s chama buildChatContextUsage e emite chunk context_usage', (_label, rel) => {
    const src = read(rel);
    expect(src).toContain('buildChatContextUsage');
    expect(src).toMatch(/type:\s*['"]context_usage['"]/);
  });

  it('SA-2: lion-sdk usa resolveLionContextWindowTokens (janela do resolver)', () => {
    const src = read('lion-sdk/index.ts');
    expect(src).toContain('resolveLionContextWindowTokens(');
  });
});
