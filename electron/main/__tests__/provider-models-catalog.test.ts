import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));
vi.mock('../codex-runtime/model-capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../codex-runtime/model-capabilities')>();
  return {
    ...actual,
    getCodexModelCapabilities: vi.fn(async () => null),
    findDiscoveredCodexModel: () => undefined,
  };
});

import { PROVIDER_MODELS, findCatalogModel, isCuratedModel, reasoningOptionsFor } from '../provider-models-catalog';
import { validateOrchestratorOverride, validateOrchestratorTriple } from '../orchestrator-selection-matrix';
import { getContextWindow } from '../agent-runtime/model-context-windows';
import { CLAUDE_MODELS } from '../../../src/constants/claude-models';
import { CODEX_MODELS, staticEffortsFor } from '../../../src/constants/codex-models';
import { KIMI_MODELS } from '../../../src/constants/kimi-models';
import { GROK_MODELS } from '../../../src/constants/grok-models';
import { CURSOR_MODELS } from '../../../src/constants/cursor-models';
import { CLAUDE_COMPAT_PRESETS } from '../../../src/constants/claude-compat-presets';
import { VERTEX_MODEL_CATALOG } from '../../../src/constants/vertex-gemini-models';

const CURATED = PROVIDER_MODELS.filter((entry) => entry.models.length > 0);

describe('PROVIDER_MODELS: catalogo unico consolidando os arquivos do renderer (7.3)', () => {
  it('cobre os ids de claude/codex/kimi/grok/cursor, os presets compat e o catalogo Vertex, na mesma ordem', () => {
    const ids = (runtime: string, provider: string) =>
      PROVIDER_MODELS.find((e) => e.runtime === runtime && e.provider === provider)?.models.map((m) => m.id);
    expect(ids('claude-sdk', 'anthropic')).toEqual(CLAUDE_MODELS.map((m) => m.id));
    expect(ids('codex-sdk', 'codex')).toEqual(CODEX_MODELS.map((m) => m.slug));
    expect(ids('kimi-sdk', 'kimi')).toEqual(KIMI_MODELS.map((m) => m.slug));
    expect(ids('grok-sdk', 'grok')).toEqual(GROK_MODELS.map((m) => m.slug));
    expect(ids('cursor-sdk', 'cursor')).toEqual(CURSOR_MODELS.map((m) => m.slug));
    for (const preset of CLAUDE_COMPAT_PRESETS) {
      expect(ids('claude-compat-sdk', preset.id)).toEqual(preset.models.map((m) => m.id));
    }
    expect(ids('lion-sdk', 'vertex-ai')).toEqual(VERTEX_MODEL_CATALOG.map((m) => m.id));
  });

  it('todo modelo tem label, reasoningOptions (array), defaultReasoning (string ou null) e contextWindow (>0 ou null)', () => {
    for (const entry of CURATED) {
      for (const model of entry.models) {
        expect(model.label.length, `${entry.provider}/${model.id}`).toBeGreaterThan(0);
        expect(Array.isArray(model.reasoningOptions)).toBe(true);
        expect(model.defaultReasoning === null || typeof model.defaultReasoning === 'string').toBe(true);
        if (model.defaultReasoning !== null) {
          expect(model.reasoningOptions, `${entry.provider}/${model.id} default fora das opcoes`).toContain(
            model.defaultReasoning,
          );
        }
        expect(model.contextWindow === null || model.contextWindow > 0).toBe(true);
      }
    }
  });

  it('reasoningOptions espelham as fontes: claude 4 tiers, codex staticEffortsFor, kimi/grok efforts, cursor effortTiers, compat/vertex vazios', () => {
    for (const m of CLAUDE_MODELS) {
      expect(findCatalogModel('claude-sdk', 'anthropic', m.id)?.reasoningOptions).toEqual([
        'low',
        'medium',
        'high',
        'max',
      ]);
    }
    for (const m of CODEX_MODELS) {
      expect(findCatalogModel('codex-sdk', 'codex', m.slug)?.reasoningOptions).toEqual(staticEffortsFor(m.slug));
    }
    for (const m of KIMI_MODELS) {
      expect(findCatalogModel('kimi-sdk', 'kimi', m.slug)?.reasoningOptions).toEqual(m.efforts);
    }
    for (const m of GROK_MODELS) {
      expect(findCatalogModel('grok-sdk', 'grok', m.slug)?.reasoningOptions).toEqual(m.efforts);
    }
    for (const m of CURSOR_MODELS) {
      expect(findCatalogModel('cursor-sdk', 'cursor', m.slug)?.reasoningOptions).toEqual(m.effortTiers ?? []);
    }
    for (const preset of CLAUDE_COMPAT_PRESETS) {
      for (const m of preset.models) {
        expect(findCatalogModel('claude-compat-sdk', preset.id, m.id)?.reasoningOptions).toEqual([]);
      }
    }
  });
});

describe('consistencia com model-context-windows (teste de igualdade)', () => {
  it('contextWindow de cada modelo curado == getContextWindow(id, provider)', () => {
    for (const entry of CURATED) {
      for (const model of entry.models) {
        expect(model.contextWindow, `${entry.provider}/${model.id}`).toBe(
          getContextWindow(model.id, entry.provider) ?? null,
        );
      }
    }
  });

  it('janelas explicitas de grok/cursor/kimi/vertex batem com o resolver', () => {
    for (const m of GROK_MODELS) expect(getContextWindow(m.slug, 'grok')).toBe(m.contextWindow);
    for (const m of CURSOR_MODELS) expect(getContextWindow(m.slug, 'cursor')).toBe(m.contextWindow);
    for (const m of KIMI_MODELS) expect(getContextWindow(m.slug, 'kimi')).toBe(m.contextWindow);
    for (const m of VERTEX_MODEL_CATALOG) expect(getContextWindow(m.id, 'vertex-ai')).toBe(m.contextWindow);
  });
});

describe('consistencia com orchestrator-selection-matrix', () => {
  it('validateOrchestratorTriple aceita TODO modelo curado no proprio (runtime, provider)', async () => {
    for (const entry of CURATED) {
      for (const model of entry.models) {
        expect(
          await validateOrchestratorTriple(entry.runtime, entry.provider, model.id),
          `${entry.runtime}/${entry.provider}/${model.id}`,
        ).toBeNull();
      }
    }
  });

  it('modelo de outro provider e recusado; lion-sdk recusa modelo curado (isCuratedModel) e aceita slug livre', async () => {
    expect(await validateOrchestratorTriple('claude-sdk', 'anthropic', 'gpt-5.5')).toMatch(/nao pertence/);
    expect(await validateOrchestratorTriple('codex-sdk', 'codex', 'claude-opus-5')).toMatch(/nao pertence/);
    expect(isCuratedModel('claude-opus-5')).toBe(true);
    expect(isCuratedModel('llama3.1:8b')).toBe(false);
    expect(await validateOrchestratorTriple('lion-sdk', 'ollama', 'claude-opus-5')).toMatch(/nao pertence/);
    expect(await validateOrchestratorTriple('lion-sdk', 'ollama', 'llama3.1:8b')).toBeNull();
  });

  it('validateOrchestratorOverride: model_not_in_provider e effort_not_supported tipados', async () => {
    expect(
      await validateOrchestratorOverride({ runtime: 'claude-sdk', provider: 'anthropic', model: 'gpt-5.5' }),
    ).toMatchObject({ ok: false, code: 'model_not_in_provider' });
    expect(
      await validateOrchestratorOverride({
        runtime: 'claude-sdk',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        effort: 'ultra',
      }),
    ).toMatchObject({ ok: false, code: 'effort_not_supported' });
    expect(
      await validateOrchestratorOverride({
        runtime: 'claude-compat-sdk',
        provider: 'zai',
        model: 'glm-5.2',
        effort: 'high',
      }),
    ).toMatchObject({ ok: false, code: 'effort_not_supported' });
    expect(
      await validateOrchestratorOverride({
        runtime: 'claude-sdk',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        effort: 'max',
      }),
    ).toEqual({ ok: true });
    expect(
      await validateOrchestratorOverride({
        runtime: 'codex-sdk',
        provider: 'codex',
        model: 'gpt-5.2',
        effort: 'xhigh',
      }),
    ).toMatchObject({ ok: false, code: 'effort_not_supported' });
  });

  it('reasoningOptionsFor: curado primeiro; desconhecido = vazio/null', () => {
    expect(reasoningOptionsFor('kimi-sdk', 'kimi', 'kimi-code/k3')).toEqual({
      options: ['low', 'high', 'max'],
      defaultReasoning: 'max',
    });
    expect(reasoningOptionsFor('kimi-sdk', 'kimi', 'kimi-code/kimi-for-coding')).toEqual({
      options: [],
      defaultReasoning: null,
    });
    expect(reasoningOptionsFor('lion-sdk', 'ollama', 'llama3.1:8b')).toEqual({ options: [], defaultReasoning: null });
  });
});
