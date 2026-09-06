
import { describe, it, expect } from 'vitest';
import {
  buildOrchestratorOptions,
  findOrchestratorGroup,
  listOpenAiCompatiblePresets,
} from '../orchestrator-options';
import { CLAUDE_DEFAULT_MODEL } from '../../constants/claude-models';
import { VERTEX_MODEL_CATALOG } from '../../constants/vertex-gemini-models';

describe('orchestrator-options: Claude SDK catalog', () => {
  it('exposes Opus 4.8/4.7 e Sonnet 5, com Opus 4.8 como default (bump 2026-07-02)', () => {
    const claude = findOrchestratorGroup('claude-sdk', 'anthropic');

    expect(claude).toBeDefined();
    expect(claude!.staticModels).toEqual(
      expect.arrayContaining([
        { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8' },
        { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7' },
        { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
      ]),
    );
    expect(claude!.defaultModel).toBe(CLAUDE_DEFAULT_MODEL);
    expect(claude!.defaultModel).toBe('claude-opus-5');
  });
});

describe('orchestrator-options: Gemini Agent Platform group', () => {
  it('buildOrchestratorOptions includes a vertex-ai group', () => {
    const groups = buildOrchestratorOptions();
    const vertex = groups.find(
      (g) => g.runtime === 'lion-sdk' && g.provider === 'vertex-ai',
    );
    expect(vertex).toBeDefined();
  });

  it('Vertex group has correct displayName, defaultModel, flags', () => {
    const vertex = findOrchestratorGroup('lion-sdk', 'vertex-ai');
    expect(vertex).toBeDefined();
    expect(vertex!.displayName).toBe('Gemini Agent Platform');
    expect(vertex!.defaultModel).toBe('gemini-3-flash-preview');
    expect(vertex!.requiresBaseUrl).toBe(false);
    expect(vertex!.requiresApiKey).toBe(true);
  });

  it('Vertex staticModels matches VERTEX_MODEL_CATALOG shape', () => {
    const vertex = findOrchestratorGroup('lion-sdk', 'vertex-ai');
    expect(vertex!.staticModels.length).toBe(VERTEX_MODEL_CATALOG.length);
    for (const entry of VERTEX_MODEL_CATALOG) {
      const option = vertex!.staticModels.find((m) => m.id === entry.id);
      expect(option).toBeDefined();
      expect(option!.displayName).toBe(entry.displayName);
    }
  });

  it('R2 — existing groups are still present', () => {
    const groups = buildOrchestratorOptions();
    const expected: Array<[string, string]> = [
      ['claude-sdk', 'anthropic'],
      ['claude-compat-sdk', 'zai'],
      ['codex-sdk', 'codex'],
      ['kimi-sdk', 'kimi'],
      ['grok-sdk', 'grok'],
      ['cursor-sdk', 'cursor'],
      ['lion-sdk', 'ollama'],
      ['lion-sdk', 'lmstudio'],
      ['lion-sdk', 'openai-compatible'],
      ['lion-sdk', 'vertex-ai'],
    ];
    for (const [runtime, provider] of expected) {
      expect(
        groups.find((g) => g.runtime === runtime && g.provider === provider),
      ).toBeDefined();
    }
  });
});

describe('orchestrator-options: Cursor group (SPEC cursor-runtime F2 item 6, E10)', () => {
  it('expoe o grupo cursor-sdk/cursor com o catalogo curado G6 e default composer-2.5', () => {
    const cursor = findOrchestratorGroup('cursor-sdk', 'cursor');
    expect(cursor).toBeDefined();
    expect(cursor!.displayName).toBe('Cursor (User API key)');
    expect(cursor!.defaultModel).toBe('composer-2.5');
    expect(cursor!.requiresBaseUrl).toBe(false);
    expect(cursor!.requiresApiKey).toBe(true);
    expect(cursor!.staticModels).toEqual(
      expect.arrayContaining([
        { id: 'composer-2.5', displayName: 'Composer 2.5' },
        { id: 'claude-fable-5', displayName: 'Claude Fable 5 (via Cursor)' },
        { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol (via Cursor)' },
      ]),
    );
    expect(cursor!.staticModels.some((m) => m.id === 'default')).toBe(false);
  });
});

describe('orchestrator-options: OpenAI-compatible setup presets', () => {
  it('Kimi preset exposes a default model and curated model list', () => {
    const kimi = listOpenAiCompatiblePresets().find((preset) => preset.id === 'kimi');

    expect(kimi?.baseUrl).toBe('https://api.moonshot.ai');
    expect(kimi?.defaultModel).toBe('kimi-k2.6');
    expect(kimi?.models?.some((model) => model.id === 'kimi-k2.6')).toBe(true);
  });

  it('Custom preset remains manual-only', () => {
    const custom = listOpenAiCompatiblePresets().find((preset) => preset.id === 'custom');

    expect(custom?.defaultModel).toBe('');
    expect(custom?.models).toEqual([]);
  });
});
