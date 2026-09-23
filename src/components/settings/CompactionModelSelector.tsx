import { useState, useEffect, useCallback } from 'react';
import { PackageSearch } from 'lucide-react';
import type {
  ProviderStatusEntry,
  ProviderModelEntry,
  OrchestratorRuntime,
  OrchestratorProvider,
  AppSettings,
} from '@/types';
import { isProviderUsable } from '@/lib/provider-status';

interface SubscriptionProviderDescriptor {
  runtime: OrchestratorRuntime;
  provider: OrchestratorProvider;
  label: string;
}

const SUBSCRIPTION_PROVIDERS: ReadonlyArray<SubscriptionProviderDescriptor> = [
  { runtime: 'claude-sdk', provider: 'anthropic', label: 'Anthropic' },
  { runtime: 'claude-compat-sdk', provider: 'zai', label: 'Z.ai' },
  { runtime: 'claude-compat-sdk', provider: 'minimax', label: 'Minimax TokenPlan' },
  { runtime: 'codex-sdk', provider: 'codex', label: 'Codex' },
  { runtime: 'kimi-sdk', provider: 'kimi', label: 'Kimi' },
  { runtime: 'grok-sdk', provider: 'grok', label: 'Grok Build' },
  { runtime: 'cursor-sdk', provider: 'cursor', label: 'Cursor SDK' },
];

const LION_PROVIDERS: ReadonlyArray<OrchestratorProvider> = ['ollama', 'lmstudio', 'openai-compatible', 'vertex-ai'];

const LION_PROVIDER_LABELS: Record<string, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  'openai-compatible': 'OpenAI-compat',
  'vertex-ai': 'Gemini Agent Platform',
};

function findStatus(
  statuses: ProviderStatusEntry[],
  runtime: OrchestratorRuntime,
  provider: OrchestratorProvider,
): ProviderStatusEntry | undefined {
  return statuses.find((s) => s.runtime === runtime && s.provider === provider);
}

function savedProviderLabel(provider: OrchestratorProvider): string {
  const sub = SUBSCRIPTION_PROVIDERS.find((d) => d.provider === provider);
  if (sub) return sub.label;
  return LION_PROVIDER_LABELS[provider] ?? provider;
}

export interface SubscriptionCompactionGroup {
  runtime: OrchestratorRuntime;
  provider: OrchestratorProvider;
  label: string;
  models: ProviderModelEntry[];
}

export interface LionCompactionGroup {
  provider: OrchestratorProvider;
  label: string;
  models: ProviderModelEntry[];
}

export interface CompactionGroups {
  subscriptionGroups: SubscriptionCompactionGroup[];
  lionGroups: LionCompactionGroup[];
  orchestratorDisconnected: boolean;
}

export function buildCompactionGroups(statuses: ProviderStatusEntry[], settings: AppSettings): CompactionGroups {
  const orchRuntime = settings.orchestratorRuntime;
  const orchProvider = settings.orchestratorProvider;

  const subscriptionGroups: SubscriptionCompactionGroup[] = [];
  for (const desc of SUBSCRIPTION_PROVIDERS) {
    const st = findStatus(statuses, desc.runtime, desc.provider);
    if (!isProviderUsable(st)) continue;
    subscriptionGroups.push({
      runtime: desc.runtime,
      provider: desc.provider,
      label: desc.label,
      models: st?.models ?? [],
    });
  }

  const lionGroups: LionCompactionGroup[] = [];
  for (const provider of LION_PROVIDERS) {
    const st = findStatus(statuses, 'lion-sdk', provider);
    if (st?.connected !== true) continue;
    lionGroups.push({
      provider,
      label: LION_PROVIDER_LABELS[provider] ?? provider,
      models: st.models ?? [],
    });
  }

  const orchIsSubscription = SUBSCRIPTION_PROVIDERS.some(
    (d) => d.runtime === orchRuntime && d.provider === orchProvider,
  );
  const orchConnected = subscriptionGroups.some((g) => g.provider === orchProvider);
  const orchestratorDisconnected = orchIsSubscription && !orchConnected;

  return { subscriptionGroups, lionGroups, orchestratorDisconnected };
}

export interface ReconciledSelection {
  selectedProvider: OrchestratorProvider | null;
  offline: boolean;
}

export function reconcileCompactionSelection(
  settings: AppSettings,
  statuses: ProviderStatusEntry[],
): ReconciledSelection {
  const savedRuntime = settings.orchestratorCompactionRuntime;
  const savedProvider = settings.orchestratorCompactionProvider;

  if (!savedProvider || !savedRuntime) {
    return { selectedProvider: null, offline: false };
  }

  const st = findStatus(statuses, savedRuntime, savedProvider);
  const offline = !isProviderUsable(st);
  return { selectedProvider: savedProvider, offline };
}

export function compactionProviderMissingCredential(settings: AppSettings, statuses: ProviderStatusEntry[]): boolean {
  const { selectedProvider, offline } = reconcileCompactionSelection(settings, statuses);
  return selectedProvider !== null && offline;
}

export function buildClearPatch(): Partial<AppSettings> {
  return {
    orchestratorCompactionRuntime: '' as unknown as OrchestratorRuntime,
    orchestratorCompactionProvider: '' as unknown as OrchestratorProvider,
    orchestratorCompactionModel: '',
  };
}

interface Props {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}

export function CompactionModelSelector({ settings, onUpdate }: Props) {
  const [statuses, setStatuses] = useState<ProviderStatusEntry[]>([]);

  useEffect(() => {
    window.lionclaw.provider
      .listStatuses()
      .then((result) => {
        if (Array.isArray(result)) setStatuses(result);
      })
      .catch(() => setStatuses([]));
  }, []);

  const handleClear = useCallback(() => {
    onUpdate(buildClearPatch());
  }, [onUpdate]);

  const handleModelChange = useCallback(
    (runtime: OrchestratorRuntime, provider: OrchestratorProvider, model: string) => {
      onUpdate({
        orchestratorCompactionRuntime: runtime,
        orchestratorCompactionProvider: provider,
        orchestratorCompactionModel: model,
      });
    },
    [onUpdate],
  );

  const { subscriptionGroups, lionGroups, orchestratorDisconnected } = buildCompactionGroups(statuses, settings);
  const { selectedProvider, offline } = reconcileCompactionSelection(settings, statuses);
  const missingCredential = compactionProviderMissingCredential(settings, statuses);

  const savedModel = settings.orchestratorCompactionModel;
  const isAuto = selectedProvider === null;

  const hasAnyProvider = subscriptionGroups.length > 0 || lionGroups.length > 0;
  const showDisconnectedWarning = !hasAnyProvider && orchestratorDisconnected;

  let selectedModels: ProviderModelEntry[] = [];
  let selectedRuntime: OrchestratorRuntime | null = null;
  if (selectedProvider) {
    const sub = subscriptionGroups.find((g) => g.provider === selectedProvider);
    if (sub) {
      selectedModels = sub.models;
      selectedRuntime = sub.runtime;
    } else {
      const lion = lionGroups.find((g) => g.provider === selectedProvider);
      if (lion) {
        selectedModels = lion.models;
        selectedRuntime = 'lion-sdk';
      } else if (offline) {
        selectedRuntime = settings.orchestratorCompactionRuntime ?? null;
      }
    }
  }

  const renderProviderChip = (
    key: string,
    label: string,
    active: boolean,
    onClick: () => void,
    opts?: { offline?: boolean },
  ) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors border ${
        active
          ? 'bg-amber-600/15 text-amber-300 border-amber-600/40'
          : 'bg-zinc-800/50 text-zinc-400 hover:text-zinc-200 border-zinc-700'
      }`}
    >
      {label}
      {opts?.offline && <span className="ml-1 text-[9px] text-red-400">offline</span>}
    </button>
  );

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
          <PackageSearch size={16} className="text-amber-500" />
          Modelo de compactacao (opcional)
        </h2>
        {!isAuto && (
          <button
            type="button"
            onClick={handleClear}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors underline"
          >
            Limpar
          </button>
        )}
      </div>

      <p className="text-xs text-zinc-500">
        Vazio = usar o Orquestrador padrao. Escolha qualquer provedor de assinatura conectado ou um provedor local
        conectado (Ollama/LM Studio). Vale para compactacao e dreaming.
      </p>

      {missingCredential && (
        <p className="text-xs text-amber-400/90" role="alert">
          O provedor de compactacao selecionado nao tem credencial conectada. A compactacao vai falhar e retentar no
          proximo ciclo (o contexto fica intacto). Conecte o provedor em External Providers ou escolha Auto
          (Orquestrador padrao).
        </p>
      )}

      <div className="bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3 space-y-3">
        {showDisconnectedWarning && (
          <p className="text-xs text-amber-400/80">Conecte um provedor em External Providers</p>
        )}

        {/* Grupo 1: provedores de assinatura conectados */}
        {subscriptionGroups.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wide text-zinc-500">Provedores de assinatura</p>
            <div className="flex flex-wrap gap-1">
              {subscriptionGroups.map((g) => {
                const isActiveOrch =
                  settings.orchestratorRuntime === g.runtime && settings.orchestratorProvider === g.provider;
                const chipLabel = isActiveOrch ? `${g.label} (atual)` : g.label;
                return renderProviderChip(`sub-${g.provider}`, chipLabel, selectedProvider === g.provider, () => {
                  const firstModel = g.models[0]?.id ?? '';
                  if (firstModel) {
                    handleModelChange(g.runtime, g.provider, firstModel);
                  }
                });
              })}
            </div>
          </div>
        )}

        {/* Grupo 2: locais / lion conectados */}
        {lionGroups.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wide text-zinc-500">Locais / Lion conectados</p>
            <div className="flex flex-wrap gap-1">
              {lionGroups.map((g) =>
                renderProviderChip(`lion-${g.provider}`, g.label, selectedProvider === g.provider, () => {
                  const firstModel = g.models[0]?.id ?? '';
                  if (firstModel) {
                    handleModelChange('lion-sdk', g.provider, firstModel);
                  }
                }),
              )}
            </div>
          </div>
        )}

        {/* Escolha salva mas offline (provedor de assinatura ou lion nao mais
            conectado). Cobre ambos os ramos: o pick fica selecionado, sem chip
            ativo em nenhum dos grupos visiveis. */}
        {offline &&
          selectedProvider &&
          !subscriptionGroups.some((g) => g.provider === selectedProvider) &&
          !lionGroups.some((g) => g.provider === selectedProvider) && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wide text-zinc-500">Escolha salva</p>
              <div className="flex flex-wrap gap-1">
                {renderProviderChip(
                  `offline-${selectedProvider}`,
                  savedProviderLabel(selectedProvider),
                  true,
                  () => {},
                  { offline: true },
                )}
              </div>
            </div>
          )}

        {/* Auto (Orquestrador padrao) sempre presente */}
        <div className="flex flex-wrap gap-1">
          {renderProviderChip('auto', 'Auto (Orquestrador padrao)', isAuto, handleClear)}
        </div>

        {/* Dropdown de modelos do provider selecionado */}
        {!isAuto && selectedRuntime && selectedModels.length > 0 && (
          <select
            value={savedModel ?? selectedModels[0]?.id ?? ''}
            onChange={(e) => selectedProvider && handleModelChange(selectedRuntime, selectedProvider, e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
          >
            {selectedModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName || m.id}
              </option>
            ))}
          </select>
        )}

        {!isAuto && selectedProvider && selectedModels.length === 0 && !offline && (
          <p className="text-xs text-zinc-500">Nenhum modelo disponivel reportado pelo provedor.</p>
        )}
      </div>
    </section>
  );
}
