import { describe, it, expect } from 'vitest';
import { CLAUDE_COMPAT_PRESETS, getClaudeCompatPreset } from '../provider-presets';

describe('CLAUDE_COMPAT_PRESETS', () => {
  it('contains exactly 2 presets after SPEC-004 (Z.ai + MiniMax)', () => {
    expect(CLAUDE_COMPAT_PRESETS).toHaveLength(2);
    expect(CLAUDE_COMPAT_PRESETS[0].id).toBe('zai');
    expect(CLAUDE_COMPAT_PRESETS[1].id).toBe('minimax');
  });

  it('has Z.ai baseUrl matching SPEC §10.3 character-for-character (no /v1 suffix)', () => {
    const zai = CLAUDE_COMPAT_PRESETS.find((p) => p.id === 'zai');
    expect(zai).toBeDefined();
    expect(zai!.baseUrl).toBe('https://api.z.ai/api/anthropic');
    expect(zai!.baseUrl.endsWith('/v1')).toBe(false);
    expect(zai!.baseUrl.endsWith('/v1/')).toBe(false);
  });

  it('points apiKeyVaultRef at the settings key defined in SPEC §5', () => {
    const zai = CLAUDE_COMPAT_PRESETS.find((p) => p.id === 'zai');
    expect(zai!.apiKeyVaultRef).toBe('orchestratorZaiApiKeyRef');
  });

  it('lists the GLM models of the curated catalog (SPEC §10.3 + GLM-5.3)', () => {
    const zai = CLAUDE_COMPAT_PRESETS.find((p) => p.id === 'zai');
    expect(zai!.models).toHaveLength(6);
    const ids = zai!.models.map((m) => m.id);
    expect(ids).toEqual(['glm-5.2', 'glm-5.3', 'glm-5.1', 'glm-5-turbo', 'glm-4.7', 'glm-4.5-air']);
  });

  it('has a human-friendly displayName on every model', () => {
    const zai = CLAUDE_COMPAT_PRESETS.find((p) => p.id === 'zai');
    for (const m of zai!.models) {
      expect(m.displayName.length).toBeGreaterThan(0);
    }
  });
});

describe('getClaudeCompatPreset', () => {
  it('returns the Z.ai preset for provider="zai"', () => {
    const preset = getClaudeCompatPreset('zai');
    expect(preset.id).toBe('zai');
    expect(preset.baseUrl).toBe('https://api.z.ai/api/anthropic');
  });

  it('throws when the provider id is not registered', () => {
    expect(() => getClaudeCompatPreset('anthropic')).toThrow(/unknown claude-compat provider/i);
    expect(() => getClaudeCompatPreset('ollama')).toThrow(/unknown claude-compat provider/i);
  });
});
