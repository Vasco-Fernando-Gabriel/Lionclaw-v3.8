
import { describe, it, expect } from 'vitest';

import { CLAUDE_COMPAT_PRESETS } from '../constants/claude-compat-presets';

describe('CLAUDE_COMPAT_PRESETS - SPEC-006 supportTier', () => {
  const minimax = CLAUDE_COMPAT_PRESETS.find((p) => p.id === 'minimax');
  const zai = CLAUDE_COMPAT_PRESETS.find((p) => p.id === 'zai');

  it('minimax preset exists', () => {
    expect(minimax).toBeDefined();
  });

  it('minimax has exactly 5 models', () => {
    expect(minimax?.models.length).toBe(5);
  });

  it('MiniMax-M3 has supportTier = "official"', () => {
    const model = minimax?.models.find((m) => m.id === 'MiniMax-M3');
    expect(model).toBeDefined();
    expect(model?.supportTier).toBe('official');
  });

  it('MiniMax-M2.7 has supportTier = "official"', () => {
    const model = minimax?.models.find((m) => m.id === 'MiniMax-M2.7');
    expect(model).toBeDefined();
    expect(model?.supportTier).toBe('official');
  });

  it('MiniMax-M2.7-highspeed has supportTier = "official"', () => {
    const model = minimax?.models.find((m) => m.id === 'MiniMax-M2.7-highspeed');
    expect(model).toBeDefined();
    expect(model?.supportTier).toBe('official');
  });

  it('MiniMax-M2.5 has supportTier = "parameter-only"', () => {
    const model = minimax?.models.find((m) => m.id === 'MiniMax-M2.5');
    expect(model).toBeDefined();
    expect(model?.supportTier).toBe('parameter-only');
  });

  it('MiniMax-M2.5 has notes about quota', () => {
    const model = minimax?.models.find((m) => m.id === 'MiniMax-M2.5');
    expect(model?.notes).toBeTruthy();
    expect(model?.notes).toContain('quota');
  });

  it('MiniMax-M2.5-highspeed has supportTier = "highspeed-only"', () => {
    const model = minimax?.models.find((m) => m.id === 'MiniMax-M2.5-highspeed');
    expect(model).toBeDefined();
    expect(model?.supportTier).toBe('highspeed-only');
  });

  it('MiniMax-M2.5-highspeed has notes about High-Speed', () => {
    const model = minimax?.models.find((m) => m.id === 'MiniMax-M2.5-highspeed');
    expect(model?.notes).toBeTruthy();
    expect(model?.notes).toContain('High-Speed');
  });

  it('Z.ai models do NOT have supportTier defined (optional field, absent = official)', () => {
    expect(zai).toBeDefined();
    for (const model of zai?.models ?? []) {
      expect(model.supportTier).toBeUndefined();
    }
  });

  it('ClaudeCompatModelInfo supportTier field accepts valid values', () => {
    const m = minimax?.models[0];
    if (m) {
      expect(['official', 'parameter-only', 'highspeed-only', undefined]).toContain(m.supportTier);
    }
  });

  it('first model in minimax preset is MiniMax-M2.7 (the default)', () => {
    expect(minimax?.models[0].id).toBe('MiniMax-M2.7');
  });
});
