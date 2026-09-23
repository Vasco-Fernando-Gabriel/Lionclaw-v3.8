import { describe, expect, it } from 'vitest';
import type { OpenChatSession, ProviderStatusEntry } from '@/types';
import {
  buildRuntimePickerCatalog,
  computeVisibleModels,
  defaultOrchestratorFromSettings,
  filterCatalogByProvider,
  findPickerModel,
  isLaneEmpty,
  keyOf,
  lockedProviderFor,
  nextHighlight,
  prevHighlight,
  selectionForEffort,
  selectionForModel,
  shortcutForIndex,
} from '../composer/model-picker.logic';
import { scoreModelPickerSearch } from '../composer/model-picker-search';

function entry(
  over: Partial<ProviderStatusEntry> & Pick<ProviderStatusEntry, 'runtime' | 'provider'>,
): ProviderStatusEntry {
  return { connected: true, available: true, ...over };
}

const ENTRIES: ProviderStatusEntry[] = [
  entry({
    runtime: 'codex-sdk',
    provider: 'codex',
    models: [
      {
        id: 'gpt-6-astra',
        displayName: 'GPT-6-Astra',
        label: 'GPT-6-Astra',
        reasoningOptions: ['low', 'high', 'max'],
        defaultReasoning: 'high',
        contextWindow: 400_000,
      },
    ],
  }),
  entry({
    runtime: 'claude-sdk',
    provider: 'anthropic',
    models: [
      {
        id: 'claude-opus-5',
        displayName: 'Claude Opus 5',
        label: 'Claude Opus 5',
        reasoningOptions: ['low', 'medium', 'high', 'max'],
        defaultReasoning: 'high',
        contextWindow: 1_000_000,
      },
      {
        id: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        label: 'Claude Sonnet 4.6',
        reasoningOptions: ['low', 'medium', 'high', 'max'],
        defaultReasoning: 'high',
        contextWindow: 200_000,
      },
    ],
  }),
  entry({
    runtime: 'codex-sdk',
    provider: 'codex-official',
    models: [{ id: 'gpt-6-astra', displayName: 'x', label: 'x', reasoningOptions: [], defaultReasoning: null }],
  }),
  entry({
    runtime: 'kimi-sdk',
    provider: 'kimi',
    connected: false,
    available: false,
    reason: 'CLI do Kimi nao encontrado',
    models: [
      {
        id: 'kimi-code/k3',
        displayName: 'Kimi K3',
        label: 'Kimi K3',
        reasoningOptions: ['low', 'high', 'max'],
        defaultReasoning: 'max',
      },
    ],
  }),
];

describe('buildRuntimePickerCatalog (7.3)', () => {
  it('achata o snapshot em modelos com provider, effort e contexto; ordena providers; esconde codex-official', () => {
    const catalog = buildRuntimePickerCatalog(ENTRIES);
    expect(catalog.tabs.map((t) => t.provider)).toEqual(['anthropic', 'codex', 'kimi']);
    expect(catalog.models.map(keyOf)).toEqual([
      'claude-sdk:claude-opus-5',
      'claude-sdk:claude-sonnet-4-6',
      'codex-sdk:gpt-6-astra',
      'kimi-sdk:kimi-code/k3',
    ]);
    const opus = catalog.models[0];
    expect(opus.reasoningOptions).toEqual(['low', 'medium', 'high', 'max']);
    expect(opus.defaultReasoning).toBe('high');
    expect(opus.contextWindow).toBe(1_000_000);
    expect(opus.providerLabel).toBe('Claude');
  });

  it('provider off aparece com o motivo e modelos desabilitados', () => {
    const catalog = buildRuntimePickerCatalog(ENTRIES);
    const kimiTab = catalog.tabs.find((t) => t.provider === 'kimi');
    expect(kimiTab?.available).toBe(false);
    expect(kimiTab?.unavailableReason).toBe('CLI do Kimi nao encontrado');
    const k3 = catalog.models.find((m) => m.modelId === 'kimi-code/k3');
    expect(k3?.available).toBe(false);
    expect(k3?.unavailableReason).toBe('CLI do Kimi nao encontrado');
  });

  it('lockProvider filtra modelos e abas para o provider da lane', () => {
    const locked = filterCatalogByProvider(buildRuntimePickerCatalog(ENTRIES), {
      runtime: 'codex-sdk',
      provider: 'codex',
    });
    expect(locked.tabs).toHaveLength(1);
    expect(locked.models.map((m) => m.modelId)).toEqual(['gpt-6-astra']);
  });

  it('findPickerModel resolve a selecao da lane pelo par runtime/provider + modelo', () => {
    const { models } = buildRuntimePickerCatalog(ENTRIES);
    expect(
      findPickerModel(models, { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-sonnet-4-6' })
        ?.contextWindow,
    ).toBe(200_000);
    expect(
      findPickerModel(models, { runtime: 'codex-sdk', provider: 'codex', model: 'claude-sonnet-4-6' }),
    ).toBeUndefined();
    expect(findPickerModel(models, null)).toBeUndefined();
  });
});

describe('computeVisibleModels: busca com score, favoritos no topo, atalhos', () => {
  const { models } = buildRuntimePickerCatalog(ENTRIES);

  it('busca ranqueia por score em todos os providers e descarta quem nao casa', () => {
    const visible = computeVisibleModels({
      isSearching: true,
      query: 'sonnet',
      tab: 'favorites',
      favorites: new Set(),
      models,
    });
    expect(visible.map((m) => m.modelId)).toEqual(['claude-sonnet-4-6']);
    const byProvider = computeVisibleModels({
      isSearching: true,
      query: 'claude',
      tab: 'favorites',
      favorites: new Set(),
      models,
    });
    expect(byProvider.map((m) => m.modelId)).toEqual(['claude-opus-5', 'claude-sonnet-4-6']);
  });

  it('favorito ganha boost na busca e vai para o topo da aba do provider', () => {
    const favorites = new Set(['claude-sdk:claude-sonnet-4-6']);
    const searched = computeVisibleModels({ isSearching: true, query: 'claude', tab: 'favorites', favorites, models });
    expect(searched[0].modelId).toBe('claude-sonnet-4-6');
    const tab = computeVisibleModels({ isSearching: false, query: '', tab: 'claude-sdk:anthropic', favorites, models });
    expect(tab.map((m) => m.modelId)).toEqual(['claude-sonnet-4-6', 'claude-opus-5']);
    const favTab = computeVisibleModels({ isSearching: false, query: '', tab: 'favorites', favorites, models });
    expect(favTab.map(keyOf)).toEqual(['claude-sdk:claude-sonnet-4-6']);
  });

  it('score: exato < prefixo < fronteira < contem; token sem match = null', () => {
    const base = { name: 'Claude Opus 5', providerLabel: 'Claude', provider: 'anthropic', modelId: 'claude-opus-5' };
    const exact = scoreModelPickerSearch({ ...base, name: 'opus' }, 'opus');
    const prefix = scoreModelPickerSearch({ ...base, name: 'opus 5' }, 'opus');
    const boundary = scoreModelPickerSearch(base, 'opus');
    expect(exact).not.toBeNull();
    expect(prefix).not.toBeNull();
    expect(boundary).not.toBeNull();
    expect(exact!).toBeLessThan(prefix!);
    expect(prefix!).toBeLessThan(boundary!);
    expect(scoreModelPickerSearch(base, 'gemini')).toBeNull();
    expect(scoreModelPickerSearch(base, '')).toBe(0);
  });

  it('atalhos posicionais: 1..9 pelas posicoes visiveis; navegacao com wrap', () => {
    expect(shortcutForIndex(0)).toBe(1);
    expect(shortcutForIndex(8)).toBe(9);
    expect(shortcutForIndex(9)).toBeNull();
    expect(nextHighlight(2, 3)).toBe(0);
    expect(prevHighlight(0, 3)).toBe(2);
    expect(nextHighlight(0, 0)).toBe(0);
  });
});

describe('7.4: lane vazia destrava o provider; selecao de modelo carrega o effort compativel', () => {
  function lane(over: Partial<OpenChatSession>): OpenChatSession {
    return {
      id: 'a',
      laneBadge: 1,
      title: 'A',
      orchestrator: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-5', effort: 'max' },
      messageCount: 0,
      lastUserMessageAt: null,
      createdAt: '2026-09-08T09:00:00.000Z',
      updatedAt: '2026-09-08T09:00:00.000Z',
      state: 'idle',
      drive: null,
      ...over,
    };
  }

  it('vazia = messageCount 0 E state idle (nunca messages.length local)', () => {
    expect(isLaneEmpty(lane({}))).toBe(true);
    expect(isLaneEmpty(lane({ messageCount: 3 }))).toBe(false);
    expect(isLaneEmpty(lane({ state: 'queued' }))).toBe(false);
    expect(lockedProviderFor(lane({}))).toBeNull();
    expect(lockedProviderFor(lane({ messageCount: 1 }))).toEqual({ runtime: 'claude-sdk', provider: 'anthropic' });
    expect(lockedProviderFor(lane({ state: 'streaming' }))).toEqual({ runtime: 'claude-sdk', provider: 'anthropic' });
    expect(lockedProviderFor(lane({ orchestrator: null, messageCount: 5 }))).toBeNull();
  });

  it('selectionForModel mantem o effort so quando o novo modelo o suporta no mesmo provider', () => {
    const { models } = buildRuntimePickerCatalog(ENTRIES);
    const current = {
      runtime: 'claude-sdk' as const,
      provider: 'anthropic' as const,
      model: 'claude-opus-5',
      effort: 'max',
    };
    const sonnet = models.find((m) => m.modelId === 'claude-sonnet-4-6')!;
    expect(selectionForModel(current, sonnet)).toEqual({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      effort: 'max',
    });
    const codex = models.find((m) => m.provider === 'codex')!;
    expect(selectionForModel(current, codex)).toEqual({
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-6-astra',
    });
    expect(selectionForModel({ ...current, effort: 'medium' }, codex)).toEqual({
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-6-astra',
    });
    expect(selectionForEffort(current, 'low')).toEqual({ ...current, effort: 'low' });
  });

  it('defaultOrchestratorFromSettings le o effort da chave do runtime', () => {
    expect(
      defaultOrchestratorFromSettings({
        orchestratorRuntime: 'codex-sdk',
        orchestratorProvider: 'codex',
        orchestratorModel: 'gpt-6-astra',
        orchestratorEffort: 'max',
        orchestratorCodexEffort: 'xhigh',
      }),
    ).toEqual({ runtime: 'codex-sdk', provider: 'codex', model: 'gpt-6-astra', effort: 'xhigh' });
    expect(
      defaultOrchestratorFromSettings({
        orchestratorRuntime: 'lion-sdk',
        orchestratorProvider: 'ollama',
        orchestratorModel: 'llama3',
        orchestratorEffort: 'max',
      }),
    ).toEqual({ runtime: 'lion-sdk', provider: 'ollama', model: 'llama3' });
  });
});
