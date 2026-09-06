
import { describe, it, expect, vi } from 'vitest';


vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../ollama-client', () => ({
  ollamaChatWithTools: vi.fn(),
}));

vi.mock('../vault-registry', () => ({
  getSecret: vi.fn().mockResolvedValue(null),
}));


import { materializeReasoning, mapReasoningParams } from '../agent-runtime/external-http';
import type { ReasoningCapability } from '../../../src/lib/provider-presets';


describe('materializeReasoning', () => {
  it('kind=none returns {} regardless of effort', () => {
    const cap: ReasoningCapability = { kind: 'none' };
    expect(materializeReasoning(cap, 'high', undefined)).toEqual({});
    expect(materializeReasoning(cap, 'low', undefined)).toEqual({});
    expect(materializeReasoning(cap, 'medium', 'enabled')).toEqual({});
  });

  it('kind=openai-effort returns { reasoning_effort: effort }', () => {
    const cap: ReasoningCapability = { kind: 'openai-effort' };
    expect(materializeReasoning(cap, 'low', undefined)).toEqual({ reasoning_effort: 'low' });
    expect(materializeReasoning(cap, 'medium', undefined)).toEqual({ reasoning_effort: 'medium' });
    expect(materializeReasoning(cap, 'high', undefined)).toEqual({ reasoning_effort: 'high' });
  });

  it('kind=anthropic-thinking-flag returns { thinking: { type: "enabled" } }', () => {
    const cap: ReasoningCapability = { kind: 'anthropic-thinking-flag' };
    expect(materializeReasoning(cap, 'medium', undefined)).toEqual({ thinking: { type: 'enabled' } });
    expect(materializeReasoning(cap, 'high', 'enabled')).toEqual({ thinking: { type: 'enabled' } });
  });

  it('kind=qwen-thinking-flag returns { thinking: { type: "enabled" } }', () => {
    const cap: ReasoningCapability = { kind: 'qwen-thinking-flag' };
    expect(materializeReasoning(cap, 'medium', undefined)).toEqual({ thinking: { type: 'enabled' } });
  });

  it('kind=reasoning-content-builtin returns {}', () => {
    const cap: ReasoningCapability = { kind: 'reasoning-content-builtin' };
    expect(materializeReasoning(cap, 'high', undefined)).toEqual({});
    expect(materializeReasoning(cap, 'high', 'enabled')).toEqual({});
  });

  it('thinking=disabled always returns {} for all kinds', () => {
    const kinds: ReasoningCapability['kind'][] = [
      'none', 'openai-effort', 'anthropic-thinking-flag', 'qwen-thinking-flag', 'reasoning-content-builtin',
    ];
    for (const kind of kinds) {
      const cap = { kind } as ReasoningCapability;
      expect(
        materializeReasoning(cap, 'high', 'disabled'),
        `kind=${kind} with thinking=disabled should return {}`,
      ).toEqual({});
    }
  });
});


describe('mapReasoningParams - existing openai/openrouter paths (byte-identical)', () => {
  it('openai gpt-5.5: thinking=enabled returns { reasoning_effort: "high" } for effort=max', () => {
    const result = mapReasoningParams('max', 'enabled', undefined, 'openai', 'gpt-5.5-turbo');
    expect(result).toEqual({ reasoning_effort: 'high' }); // max -> high clamped
  });

  it('openai gpt-5.5: thinking=disabled returns {}', () => {
    const result = mapReasoningParams('high', 'disabled', undefined, 'openai', 'gpt-5.5-turbo');
    expect(result).toEqual({});
  });

  it('openai o3: thinking=enabled returns { reasoning_effort: "medium" }', () => {
    const result = mapReasoningParams('medium', undefined, undefined, 'openai', 'o3');
    expect(result).toEqual({ reasoning_effort: 'medium' });
  });

  it('openai non-reasoning model (gpt-4o): returns {} even with thinking=enabled', () => {
    const result = mapReasoningParams('high', 'enabled', undefined, 'openai', 'gpt-4o');
    expect(result).toEqual({});
  });

  it('openrouter openai/gpt-5: thinking=enabled returns { reasoning_effort }', () => {
    const result = mapReasoningParams('low', 'enabled', undefined, 'openrouter', 'openai/gpt-5-turbo');
    expect(result).toEqual({ reasoning_effort: 'low' });
  });

  it('openrouter openai/gpt-5: thinking=disabled returns {}', () => {
    const result = mapReasoningParams('low', 'disabled', undefined, 'openrouter', 'openai/gpt-5-turbo');
    expect(result).toEqual({});
  });

  it('openrouter kimi-k2-thinking: returns {} (reasoning-content-builtin, no extra param)', () => {
    const result = mapReasoningParams('high', 'enabled', undefined, 'openrouter', 'moonshotai/kimi-k2-thinking');
    expect(result).toEqual({});
  });

  it('openrouter qwen3.6: thinking enabled returns { thinking: { type: "enabled" } }', () => {
    const result = mapReasoningParams('high', 'enabled', undefined, 'openrouter', 'qwen/qwen3.6-max-preview');
    expect(result).toEqual({ thinking: { type: 'enabled' } });
  });

  it('openrouter qwen3.6: thinking disabled returns {}', () => {
    const result = mapReasoningParams('high', 'disabled', undefined, 'openrouter', 'qwen/qwen3.6-max-preview');
    expect(result).toEqual({});
  });

  it('openai-compatible provider: always returns {} (not in any branch)', () => {
    const result = mapReasoningParams('high', 'enabled', undefined, 'openai-compatible', 'my-custom-model');
    expect(result).toEqual({});
  });
});


describe('mapReasoningParams - new providers via catalog (declarative branch)', () => {
  it('kimi + kimi-k2-turbo-preview (kind=none): returns {}', () => {
    const result = mapReasoningParams('high', 'enabled', undefined, 'kimi', 'kimi-k2-turbo-preview');
    expect(result).toEqual({});
  });

  it('kimi + unknown model not in catalog: returns {}', () => {
    const result = mapReasoningParams('high', 'enabled', undefined, 'kimi', 'kimi-v99-future-model');
    expect(result).toEqual({});
  });

  it('deepseek + deepseek-chat (kind=none): returns {}', () => {
    const result = mapReasoningParams('high', 'enabled', undefined, 'deepseek', 'deepseek-chat');
    expect(result).toEqual({});
  });

  it('deepseek + deepseek-reasoner (kind=reasoning-content-builtin): returns {}', () => {
    const result = mapReasoningParams('high', 'enabled', undefined, 'deepseek', 'deepseek-reasoner');
    expect(result).toEqual({});
  });

  it('qwen + qwen3-max (kind=none): returns {}', () => {
    const result = mapReasoningParams('high', 'enabled', undefined, 'qwen', 'qwen3-max');
    expect(result).toEqual({});
  });

  it('qwen + qwen3-coder (kind=none): returns {}', () => {
    const result = mapReasoningParams('high', 'enabled', undefined, 'qwen', 'qwen3-coder');
    expect(result).toEqual({});
  });

  it('minimax-payg + MiniMax-M2 (kind=none): returns {}', () => {
    const result = mapReasoningParams('high', 'enabled', undefined, 'minimax-payg', 'MiniMax-M2');
    expect(result).toEqual({});
  });

  it('minimax-payg + MiniMax-Text-01 (kind=none): returns {}', () => {
    const result = mapReasoningParams('high', 'enabled', undefined, 'minimax-payg', 'MiniMax-Text-01');
    expect(result).toEqual({});
  });

  it('minimax-payg + unknown model: returns {}', () => {
    const result = mapReasoningParams('high', 'enabled', undefined, 'minimax-payg', 'MiniMax-V99');
    expect(result).toEqual({});
  });
});
