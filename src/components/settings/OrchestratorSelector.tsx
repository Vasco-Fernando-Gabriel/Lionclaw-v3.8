import { useState, useEffect, useCallback, useMemo } from 'react';
import { Cpu, Loader2, RefreshCw } from 'lucide-react';
import type { ProviderStatusEntry, OrchestratorRuntime, OrchestratorProvider, AppSettings } from '@/types';
import { isProviderUsable } from '@/lib/provider-status';
import { translateLlmError } from '@/utils/translate-llm-error';
import { effortSettingFieldForRuntime } from '@/components/chat/composer/model-picker.logic';
import { effortLabel, orderEffortOptions } from '@/components/chat/composer/EffortPill';

export interface DefaultEffortOptions {
  options: string[];
  defaultReasoning: string | null;
  field: ReturnType<typeof effortSettingFieldForRuntime>;
  value: string;
}

export function resolveDefaultEffortOptions(
  status: Pick<ProviderStatusEntry, 'runtime' | 'models'> | undefined,
  runtime: OrchestratorRuntime,
  modelId: string,
  settings: Partial<Pick<AppSettings, NonNullable<ReturnType<typeof effortSettingFieldForRuntime>>>>,
): DefaultEffortOptions {
  const model = status?.models?.find((m) => m.id === modelId);
  const options = orderEffortOptions(model?.reasoningOptions ?? []);
  const defaultReasoning = model?.defaultReasoning ?? null;
  const field = effortSettingFieldForRuntime(runtime);
  const saved = field ? settings[field] : undefined;
  const value =
    saved && options.includes(saved)
      ? saved
      : defaultReasoning && options.includes(defaultReasoning)
        ? defaultReasoning
        : (options[0] ?? '');
  return { options, defaultReasoning, field, value };
}

type UiTabId = 'claude' | 'codex' | 'kimi' | 'grok' | 'cursor' | 'lion';

interface UiProviderDescriptor {
  uiProviderId: string;
  label: string;
  runtime: OrchestratorRuntime;
  provider: OrchestratorProvider;
  hint?: string;
}

interface UiTabDescriptor {
  id: UiTabId;
  label: string;
  providers: UiProviderDescriptor[];
  emptyMessage: string;
}

const UI_TABS: UiTabDescriptor[] = [
  {
    id: 'claude',
    label: 'Claude SDK',
    emptyMessage:
      'Nenhum provedor Claude SDK conectado. Conecte Anthropic, Z.ai ou Minimax TokenPlan no painel Provedores externos.',
    providers: [
      {
        uiProviderId: 'anthropic',
        label: 'Anthropic',
        runtime: 'claude-sdk',
        provider: 'anthropic',
      },
      {
        uiProviderId: 'zai',
        label: 'Z.ai',
        runtime: 'claude-compat-sdk',
        provider: 'zai',
      },
      {
        uiProviderId: 'minimax',
        label: 'Minimax TokenPlan',
        runtime: 'claude-compat-sdk',
        provider: 'minimax',
      },
    ],
  },
  {
    id: 'codex',
    label: 'Codex SDK',
    emptyMessage: 'Codex OAuth nao conectado. Conecte em Provedores externos.',
    providers: [
      {
        uiProviderId: 'codex',
        label: 'Codex OAuth',
        runtime: 'codex-sdk',
        provider: 'codex',
      },
    ],
  },
  {
    id: 'kimi',
    label: 'Kimi SDK',
    emptyMessage: 'Kimi nao conectado. Conecte em Provedores externos.',
    providers: [
      {
        uiProviderId: 'kimi',
        label: 'Kimi',
        runtime: 'kimi-sdk',
        provider: 'kimi',
      },
    ],
  },
  {
    id: 'grok',
    label: 'Grok Build',
    emptyMessage: 'Grok nao conectado. Conecte sua assinatura em Provedores externos.',
    providers: [
      {
        uiProviderId: 'grok',
        label: 'Grok subscription',
        runtime: 'grok-sdk',
        provider: 'grok',
        hint: 'Grok 4.6, contexto de 500K, via CLI oficial por assinatura',
      },
    ],
  },
  {
    id: 'cursor',
    label: 'Cursor SDK',
    emptyMessage: 'Cursor nao conectado. Cadastre a User API key (cursor.com/dashboard > API) em Provedores externos.',
    providers: [
      {
        uiProviderId: 'cursor',
        label: 'Cursor (User API key)',
        runtime: 'cursor-sdk',
        provider: 'cursor',
        hint: 'Agente do Cursor (@cursor/sdk) via assinatura; catalogo multi-frontier. O custo em USD e equivalente-API estimado; a cobranca real e o plano Cursor.',
      },
    ],
  },
  {
    id: 'lion',
    label: 'Lion-SDK',
    emptyMessage:
      'Nenhum provedor Lion-SDK conectado. Conecte Ollama, LM Studio ou OpenAI-compat no painel Provedores externos.',
    providers: [
      {
        uiProviderId: 'ollama',
        label: 'Ollama',
        runtime: 'lion-sdk',
        provider: 'ollama',
        hint: 'Lista dinamica de /api/tags',
      },
      {
        uiProviderId: 'lmstudio',
        label: 'LM Studio',
        runtime: 'lion-sdk',
        provider: 'lmstudio',
        hint: 'Lista dinamica de /v1/models',
      },
      {
        uiProviderId: 'openai-compatible',
        label: 'OpenAI-compat',
        runtime: 'lion-sdk',
        provider: 'openai-compatible',
        hint: 'Lista dinamica de {base}/v1/models, fallback estatico per preset',
      },
      {
        uiProviderId: 'vertex-ai',
        label: 'Gemini Agent Platform',
        runtime: 'lion-sdk',
        provider: 'vertex-ai',
        hint: 'Express API key',
      },
    ],
  },
];

function findStatus(
  statuses: ProviderStatusEntry[],
  runtime: OrchestratorRuntime,
  provider: OrchestratorProvider,
): ProviderStatusEntry | undefined {
  return statuses.find((s) => s.runtime === runtime && s.provider === provider);
}

function locateBackend(
  runtime: OrchestratorRuntime,
  provider: OrchestratorProvider,
): { tab: UiTabDescriptor; provider: UiProviderDescriptor } | undefined {
  for (const tab of UI_TABS) {
    const match = tab.providers.find((p) => p.runtime === runtime && p.provider === provider);
    if (match) return { tab, provider: match };
  }
  return undefined;
}

const FALLBACK_TAB: UiTabId = 'claude';
const FALLBACK_PROVIDER_ID = 'anthropic';

interface OrchestratorSelectorProps {
  onSettingsChange?: (patch: Partial<AppSettings>) => void;
}

type PendingSelection = {
  runtime: OrchestratorRuntime;
  provider: OrchestratorProvider;
  model: string;
};

function formatContextWindow(value: number | undefined): string {
  if (!value || value <= 0) return '';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

export function OrchestratorSelector({ onSettingsChange }: OrchestratorSelectorProps = {}) {
  const [statuses, setStatuses] = useState<ProviderStatusEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [savingSelection, setSavingSelection] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  const [savedHint, setSavedHint] = useState(false);

  const [activeTabId, setActiveTabId] = useState<UiTabId>(FALLBACK_TAB);
  const [activeProviderId, setActiveProviderId] = useState<string>(FALLBACK_PROVIDER_ID);
  const [errorHint, setErrorHint] = useState<string | null>(null);

  const loadStatuses = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await window.lionclaw.provider.listStatuses();
      if (Array.isArray(result)) {
        setStatuses(result);
      } else if (result && 'error' in result) {
        setStatuses([]);
      }
    } catch {
      setStatuses([]);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    const s = await window.lionclaw.settings.get();
    setSettings(s);
  }, []);

  useEffect(() => {
    loadSettings();
    loadStatuses();
  }, [loadSettings, loadStatuses]);

  useEffect(() => {
    if (!settings) return;
    if (pendingSelection) return;
    const located = locateBackend(settings.orchestratorRuntime, settings.orchestratorProvider);
    if (located) {
      const status = findStatus(statuses, located.provider.runtime, located.provider.provider);
      if (isProviderUsable(status)) {
        setActiveTabId(located.tab.id);
        setActiveProviderId(located.provider.uiProviderId);
        return;
      }
    }
    for (const tab of UI_TABS) {
      const firstConnected = tab.providers.find((p) => {
        const st = findStatus(statuses, p.runtime, p.provider);
        return isProviderUsable(st);
      });
      if (firstConnected) {
        setActiveTabId(tab.id);
        setActiveProviderId(firstConnected.uiProviderId);
        return;
      }
    }
    setActiveTabId(FALLBACK_TAB);
    setActiveProviderId(FALLBACK_PROVIDER_ID);
  }, [pendingSelection, settings, statuses]);

  const persistSelection = useCallback(
    async (runtime: OrchestratorRuntime, provider: OrchestratorProvider, modelId: string) => {
      if (!settings) return;
      const status = findStatus(statuses, runtime, provider);
      const selectedModel = status?.models?.find((m) => m.id === modelId);
      const next: Partial<AppSettings> = {
        orchestratorRuntime: runtime,
        orchestratorProvider: provider,
        orchestratorModel: modelId,
      };
      if (runtime === 'lion-sdk' && provider === 'lmstudio') {
        next.orchestratorContextWindowTokens = selectedModel?.contextWindow ?? 0;
      }
      const pending: PendingSelection = { runtime, provider, model: modelId };
      setPendingSelection(pending);
      setSavingSelection(true);
      setSettings((prev) => (prev ? { ...prev, ...next } : prev));
      onSettingsChange?.(next);
      try {
        const result = await window.lionclaw.settings.update(next);
        if (result && 'error' in result && result.error) {
          setErrorHint(translateLlmError({ error: result.error }).body);
          const fresh = await window.lionclaw.settings.get();
          setSettings(fresh);
          onSettingsChange?.({
            orchestratorRuntime: fresh.orchestratorRuntime,
            orchestratorProvider: fresh.orchestratorProvider,
            orchestratorModel: fresh.orchestratorModel,
            orchestratorContextWindowTokens: fresh.orchestratorContextWindowTokens,
          });
          return;
        }
        setSettings((prev) => (prev ? { ...prev, ...next } : prev));
        setErrorHint(null);

        setSavedHint(true);
        setTimeout(() => setSavedHint(false), 1500);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setErrorHint(message);
        const fresh = await window.lionclaw.settings.get();
        setSettings(fresh);
        onSettingsChange?.({
          orchestratorRuntime: fresh.orchestratorRuntime,
          orchestratorProvider: fresh.orchestratorProvider,
          orchestratorModel: fresh.orchestratorModel,
          orchestratorContextWindowTokens: fresh.orchestratorContextWindowTokens,
        });
      } finally {
        setPendingSelection(null);
        setSavingSelection(false);
      }
    },
    [onSettingsChange, settings, statuses],
  );

  useEffect(() => {
    if (
      !settings ||
      pendingSelection ||
      settings.orchestratorRuntime !== 'lion-sdk' ||
      settings.orchestratorProvider !== 'lmstudio'
    ) {
      return;
    }
    const status = findStatus(statuses, 'lion-sdk', 'lmstudio');
    const selectedModel = status?.models?.find((m) => m.id === settings.orchestratorModel);
    const contextWindow = selectedModel?.contextWindow;
    if (!contextWindow || contextWindow === settings.orchestratorContextWindowTokens) {
      return;
    }
    const patch: Partial<AppSettings> = {
      orchestratorContextWindowTokens: contextWindow,
    };
    window.lionclaw.settings
      .update(patch)
      .then((result) => {
        if (result && 'error' in result && result.error) return;
        setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
        onSettingsChange?.(patch);
      })
      .catch(() => {});
  }, [onSettingsChange, pendingSelection, settings, statuses]);

  useEffect(() => {
    if (!settings || pendingSelection) return;
    const status = findStatus(statuses, settings.orchestratorRuntime, settings.orchestratorProvider);
    const resolved = resolveDefaultEffortOptions(
      status,
      settings.orchestratorRuntime,
      settings.orchestratorModel,
      settings,
    );
    if (!resolved.field || resolved.options.length === 0) return;
    const saved = settings[resolved.field];
    if (!saved || resolved.options.includes(saved)) return;
    const patch: Partial<AppSettings> = { [resolved.field]: resolved.value };
    window.lionclaw.settings
      .update(patch)
      .then((result) => {
        if (result && 'error' in result && result.error) return;
        setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
        onSettingsChange?.(patch);
      })
      .catch(() => {});
  }, [onSettingsChange, pendingSelection, settings, statuses]);

  const pickAutoSelectionForTab = useCallback(
    (tab: UiTabDescriptor): { provider: UiProviderDescriptor; modelId: string } | undefined => {
      for (const p of tab.providers) {
        const st = findStatus(statuses, p.runtime, p.provider);
        if (!isProviderUsable(st)) continue;
        const firstModel = st?.models?.[0]?.id;
        if (firstModel) return { provider: p, modelId: firstModel };
      }
      return undefined;
    },
    [statuses],
  );

  const handleTabClick = useCallback(
    (tabId: UiTabId) => {
      if (savingSelection) return;
      if (tabId === activeTabId) return;
      const tab = UI_TABS.find((t) => t.id === tabId);
      if (!tab) return;
      setActiveTabId(tabId);
      const auto = pickAutoSelectionForTab(tab);
      if (auto) {
        setActiveProviderId(auto.provider.uiProviderId);
        persistSelection(auto.provider.runtime, auto.provider.provider, auto.modelId);
      } else {
        setActiveProviderId(tab.providers[0]?.uiProviderId ?? '');
      }
    },
    [activeTabId, pickAutoSelectionForTab, persistSelection, savingSelection],
  );

  const handleProviderClick = useCallback(
    (providerId: string) => {
      if (savingSelection) return;
      if (providerId === activeProviderId) return;
      const tab = UI_TABS.find((t) => t.id === activeTabId);
      if (!tab) return;
      const desc = tab.providers.find((p) => p.uiProviderId === providerId);
      if (!desc) return;
      setActiveProviderId(providerId);
      const st = findStatus(statuses, desc.runtime, desc.provider);
      const firstModel = st?.models?.[0]?.id;
      if (firstModel) {
        persistSelection(desc.runtime, desc.provider, firstModel);
      }
    },
    [activeTabId, activeProviderId, statuses, persistSelection, savingSelection],
  );

  const activeTab = useMemo(() => UI_TABS.find((t) => t.id === activeTabId) ?? UI_TABS[0], [activeTabId]);
  const activeProvider = useMemo(
    () => activeTab.providers.find((p) => p.uiProviderId === activeProviderId),
    [activeTab, activeProviderId],
  );

  if (loading || !settings) {
    return (
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
          <Cpu size={16} className="text-amber-500" />
          Orquestrador padrao
        </h2>
        <div className="flex items-center gap-2 text-xs text-zinc-500 bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3">
          <Loader2 size={14} className="animate-spin" />
          Carregando status dos provedores...
        </div>
      </section>
    );
  }

  const connectedProvidersInTab = activeTab.providers.filter((p) => {
    const st = findStatus(statuses, p.runtime, p.provider);
    return isProviderUsable(st);
  });

  const activeStatus = activeProvider
    ? findStatus(statuses, activeProvider.runtime, activeProvider.provider)
    : undefined;
  const activeModels = activeStatus?.models ?? [];

  const savedMatchesActive =
    activeProvider !== undefined &&
    settings.orchestratorRuntime === activeProvider.runtime &&
    settings.orchestratorProvider === activeProvider.provider;
  const selectedModelValue = savedMatchesActive ? settings.orchestratorModel : (activeModels[0]?.id ?? '');

  const savedLocated = locateBackend(settings.orchestratorRuntime, settings.orchestratorProvider);
  const savedTabId = savedLocated?.tab.id;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
          <Cpu size={16} className="text-amber-500" />
          Orquestrador padrao
        </h2>
        <div className="flex items-center gap-2">
          {savingSelection && <span className="text-[10px] text-amber-400">Salvando...</span>}
          {savedHint && <span className="text-[10px] text-green-400">Salvo</span>}
          {errorHint && (
            <span className="text-[10px] text-red-400 max-w-[220px] truncate" title={errorHint}>
              {errorHint}
            </span>
          )}
          <button
            onClick={loadStatuses}
            disabled={refreshing || savingSelection}
            title="Recarregar status dos provedores"
            className="text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <p className="text-xs text-zinc-500">
        Apenas grupos conectados aparecem abaixo. Para conectar um provedor, use o painel &quot;Provedores
        externos&quot; acima.
      </p>
      <p
        className="text-xs text-amber-400/90 bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2"
        data-testid="orchestrator-default-lanes-notice"
      >
        Lanes abertas mantem o orquestrador delas; para trocar, de Clear na lane. O padrao vale para lanes novas,
        Telegram e Scheduler.
      </p>

      {/* Stage 1: SDK tabs (segmented control) */}
      <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900 p-1 gap-1">
        {UI_TABS.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isSaved = tab.id === savedTabId;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleTabClick(tab.id)}
              disabled={savingSelection}
              aria-pressed={isActive}
              className={`relative px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:cursor-wait disabled:opacity-80 ${isActive ? 'bg-amber-600/20 text-amber-300 border border-amber-600/40' : 'text-zinc-400 hover:text-zinc-200 border border-transparent'}`}
            >
              <span>{tab.label}</span>
              {isSaved && (
                <span className="ml-2 text-[9px] text-amber-400 uppercase tracking-wide align-middle">selecionado</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Stage 2: provider sub-selector + model dropdown */}
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3 space-y-3">
        {connectedProvidersInTab.length === 0 ? (
          <p className="text-xs text-zinc-500">{activeTab.emptyMessage}</p>
        ) : (
          <>
            {connectedProvidersInTab.length > 1 && (
              <div className="flex flex-wrap gap-1">
                {connectedProvidersInTab.map((p) => {
                  const isActive = p.uiProviderId === activeProviderId;
                  return (
                    <button
                      key={p.uiProviderId}
                      type="button"
                      onClick={() => handleProviderClick(p.uiProviderId)}
                      disabled={savingSelection}
                      aria-pressed={isActive}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors border disabled:cursor-wait disabled:opacity-80 ${isActive ? 'bg-amber-600/15 text-amber-300 border-amber-600/40' : 'bg-zinc-800/50 text-zinc-400 hover:text-zinc-200 border-zinc-700'}`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            )}

            {connectedProvidersInTab.length === 1 && activeProvider && (
              <div className="text-xs text-zinc-400">{activeProvider.label}</div>
            )}

            {activeProvider && activeModels.length === 0 && (
              <p className="text-xs text-zinc-500">Nenhum modelo disponivel reportado pelo provedor.</p>
            )}

            {activeProvider && activeModels.length > 0 && (
              <select
                value={selectedModelValue}
                disabled={savingSelection}
                onChange={(e) => {
                  persistSelection(activeProvider.runtime, activeProvider.provider, e.target.value);
                }}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 disabled:cursor-wait disabled:opacity-80"
              >
                {activeModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName || m.id}
                    {m.contextWindow ? ` - ctx ${formatContextWindow(m.contextWindow)}` : ''}
                  </option>
                ))}
              </select>
            )}

            {activeProvider &&
              (() => {
                const effortState = resolveDefaultEffortOptions(
                  activeStatus,
                  activeProvider.runtime,
                  selectedModelValue,
                  settings,
                );
                const modelSupportsEffort = effortState.field !== null && effortState.options.length > 0;
                return (
                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-400">Reasoning effort</label>
                    <select
                      value={effortState.value}
                      disabled={!modelSupportsEffort}
                      data-testid="orchestrator-default-effort"
                      onChange={async (e) => {
                        if (!effortState.field) return;
                        const patch: Partial<AppSettings> = { [effortState.field]: e.target.value };
                        try {
                          const result = await window.lionclaw.settings.update(patch);
                          if (result && 'error' in result && result.error) {
                            setErrorHint(translateLlmError({ error: result.error }).body);
                            return;
                          }
                          setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
                          onSettingsChange?.(patch);
                          setErrorHint(null);
                          setSavedHint(true);
                          setTimeout(() => setSavedHint(false), 1500);
                        } catch (err) {
                          setErrorHint(err instanceof Error ? err.message : String(err));
                        }
                      }}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {modelSupportsEffort ? (
                        effortState.options.map((opt) => (
                          <option key={opt} value={opt}>
                            {effortLabel(opt)}
                            {opt === effortState.defaultReasoning ? ' (padrao)' : ''}
                          </option>
                        ))
                      ) : (
                        <option value="">Sem tiers de effort</option>
                      )}
                    </select>
                    {modelSupportsEffort ? (
                      <p className="text-[10px] text-zinc-600">
                        Effort inicial das lanes novas, do Telegram e do Scheduler. As opcoes vem do modelo selecionado.
                      </p>
                    ) : (
                      <p className="text-[10px] text-amber-500/70">Este modelo nao expoe tiers de effort.</p>
                    )}
                  </div>
                );
              })()}

            {activeProvider?.hint && <p className="text-[10px] text-zinc-600">{activeProvider.hint}</p>}
          </>
        )}
      </div>
    </section>
  );
}
