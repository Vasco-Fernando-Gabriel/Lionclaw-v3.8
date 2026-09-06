import { describe, it, expect } from 'vitest';

import { CLAUDE_COMPAT_PRESETS } from '../constants/claude-compat-presets';

describe('CLAUDE_COMPAT_PRESETS — SPEC-004 Sprint 1', () => {
  it('has exactly two presets (Z.ai + MiniMax Token Plan)', () => {
    expect(CLAUDE_COMPAT_PRESETS.length).toBe(2);
  });

  it('exposes the MiniMax preset with id "minimax"', () => {
    const minimax = CLAUDE_COMPAT_PRESETS.find((p) => p.id === 'minimax');
    expect(minimax).toBeDefined();
  });

  it('uses the camelCase AppSettings field as apiKeyVaultRef', () => {
    const minimax = CLAUDE_COMPAT_PRESETS.find((p) => p.id === 'minimax');
    expect(minimax?.apiKeyVaultRef).toBe('orchestratorMinimaxApiKeyRef');
  });

  it('registers all five MiniMax Token Plan models with the first being MiniMax-M2.7', () => {
    const minimax = CLAUDE_COMPAT_PRESETS.find((p) => p.id === 'minimax');
    expect(minimax?.models.length).toBe(5);
    expect(minimax?.models[0].id).toBe('MiniMax-M2.7');
    expect(minimax?.models.some((m) => m.id === 'MiniMax-M3')).toBe(true);
  });
});
