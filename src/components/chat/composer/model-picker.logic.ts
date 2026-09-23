import type {
  AppSettings,
  OpenChatSession,
  OrchestratorProvider,
  OrchestratorRuntime,
  ProviderStatusEntry,
  SessionOrchestrator,
} from '@/types';
import { scoreModelPickerSearch, type ModelPickerSearchableModel } from './model-picker-search';

export interface PickerProviderRef {
  runtime: OrchestratorRuntime;
  provider: OrchestratorProvider;
}

export interface PickerModel extends PickerProviderRef {
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  available: boolean;
  unavailableReason?: string;
  reasoningOptions: readonly string[];
  defaultReasoning: string | null;
  contextWindow?: number;
}

export interface PickerProviderTab extends PickerProviderRef {
  key: string;
  label: string;
  available: boolean;
  unavailableReason?: string;
}

export type SidebarTab = 'favorites' | string;

export const PROVIDER_LABELS: Record<OrchestratorProvider, string> = {
  anthropic: 'Claude',
  zai: 'GLM (Z.ai)',
  minimax: 'MiniMax',
  codex: 'Codex',
  'codex-official': 'Codex (app-server)',
  kimi: 'Kimi',
  grok: 'Grok',
  cursor: 'Cursor',
  ollama: 'Lion: Ollama',
  lmstudio: 'Lion: LM Studio',
  'openai-compatible': 'Lion: OpenAI-compat',
  'vertex-ai': 'Lion: Vertex',
};

const PROVIDER_ORDER: readonly OrchestratorProvider[] = [
  'anthropic',
  'codex',
  'zai',
  'minimax',
  'grok',
  'kimi',
  'cursor',
  'ollama',
  'lmstudio',
  'openai-compatible',
  'vertex-ai',
];

const PICKER_HIDDEN_PROVIDERS: ReadonlySet<OrchestratorProvider> = new Set(['codex-official']);

export function providerKey(ref: PickerProviderRef): string {
  return `${ref.runtime}:${ref.provider}`;
}

export function favoriteKey(runtime: OrchestratorRuntime, modelId: string): string {
  return `${runtime}:${modelId}`;
}

export function keyOf(model: Pick<PickerModel, 'runtime' | 'modelId'>): string {
  return favoriteKey(model.runtime, model.modelId);
}

export function sameProvider(
  a: PickerProviderRef | null | undefined,
  b: PickerProviderRef | null | undefined,
): boolean {
  return Boolean(a && b && a.runtime === b.runtime && a.provider === b.provider);
}

function providerRank(provider: OrchestratorProvider): number {
  const index = PROVIDER_ORDER.indexOf(provider);
  return index === -1 ? PROVIDER_ORDER.length : index;
}

export function buildRuntimePickerCatalog(entries: readonly ProviderStatusEntry[]): {
  models: PickerModel[];
  tabs: PickerProviderTab[];
} {
  const visible = entries
    .filter((entry) => !PICKER_HIDDEN_PROVIDERS.has(entry.provider))
    .slice()
    .sort((a, b) => providerRank(a.provider) - providerRank(b.provider));
  const tabs: PickerProviderTab[] = visible.map((entry) => ({
    key: providerKey(entry),
    runtime: entry.runtime,
    provider: entry.provider,
    label: PROVIDER_LABELS[entry.provider] ?? entry.provider,
    available: entry.available,
    ...(entry.reason && !entry.available ? { unavailableReason: entry.reason } : {}),
  }));
  const models: PickerModel[] = visible.flatMap((entry) =>
    (entry.models ?? []).map((model) => ({
      runtime: entry.runtime,
      provider: entry.provider,
      providerLabel: PROVIDER_LABELS[entry.provider] ?? entry.provider,
      modelId: model.id,
      modelLabel: model.label || model.displayName || model.id,
      available: entry.available,
      ...(entry.reason && !entry.available ? { unavailableReason: entry.reason } : {}),
      reasoningOptions: model.reasoningOptions,
      defaultReasoning: model.defaultReasoning,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    })),
  );
  return { models, tabs };
}

export function filterCatalogByProvider(
  catalog: { models: PickerModel[]; tabs: PickerProviderTab[] },
  lock: PickerProviderRef | null | undefined,
): { models: PickerModel[]; tabs: PickerProviderTab[] } {
  if (!lock) return catalog;
  return {
    models: catalog.models.filter((model) => sameProvider(model, lock)),
    tabs: catalog.tabs.filter((tab) => sameProvider(tab, lock)),
  };
}

export function findPickerModel(
  models: readonly PickerModel[],
  selection: SessionOrchestrator | (PickerProviderRef & { model: string }) | null | undefined,
): PickerModel | undefined {
  if (!selection) return undefined;
  return models.find((model) => sameProvider(model, selection) && model.modelId === selection.model);
}

export function computeVisibleModels(input: {
  isSearching: boolean;
  query: string;
  tab: SidebarTab;
  favorites: ReadonlySet<string>;
  models: readonly PickerModel[];
}): PickerModel[] {
  const { isSearching, query, tab, favorites, models } = input;
  if (isSearching) {
    const ranked = models
      .map((model) => {
        const searchable: ModelPickerSearchableModel = {
          name: model.modelLabel,
          providerLabel: model.providerLabel,
          provider: model.provider,
          modelId: model.modelId,
          isFavorite: favorites.has(keyOf(model)),
        };
        return { model, score: scoreModelPickerSearch(searchable, query) };
      })
      .filter((entry): entry is { model: PickerModel; score: number } => entry.score !== null);
    ranked.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.model.modelLabel.localeCompare(b.model.modelLabel);
    });
    return ranked.map((entry) => entry.model);
  }

  const inTab =
    tab === 'favorites'
      ? models.filter((model) => favorites.has(keyOf(model)))
      : models.filter((model) => providerKey(model) === tab);

  if (tab === 'favorites') return inTab;
  return [...inTab].sort((a, b) => {
    const favA = favorites.has(keyOf(a)) ? 0 : 1;
    const favB = favorites.has(keyOf(b)) ? 0 : 1;
    return favA - favB;
  });
}

export function nextHighlight(current: number, length: number): number {
  return length === 0 ? 0 : (current + 1) % length;
}

export function prevHighlight(current: number, length: number): number {
  return length === 0 ? 0 : (current - 1 + length) % length;
}

export function clampHighlight(current: number, length: number): number {
  return length === 0 ? 0 : Math.min(current, length - 1);
}

export function shortcutForIndex(index: number): number | null {
  return index < 9 ? index + 1 : null;
}

export function isLaneEmpty(lane: Pick<OpenChatSession, 'messageCount' | 'state'> | null | undefined): boolean {
  return Boolean(lane && lane.messageCount === 0 && lane.state === 'idle');
}

export function lockedProviderFor(
  lane: Pick<OpenChatSession, 'messageCount' | 'state' | 'orchestrator'> | null | undefined,
): PickerProviderRef | null {
  if (!lane || !lane.orchestrator) return null;
  if (isLaneEmpty(lane)) return null;
  return { runtime: lane.orchestrator.runtime, provider: lane.orchestrator.provider };
}

export function selectionForModel(
  current: SessionOrchestrator | null | undefined,
  model: PickerModel,
): SessionOrchestrator {
  const carriedEffort =
    current && sameProvider(current, model) && current.effort && model.reasoningOptions.includes(current.effort)
      ? current.effort
      : undefined;
  return {
    runtime: model.runtime,
    provider: model.provider,
    model: model.modelId,
    ...(carriedEffort ? { effort: carriedEffort } : {}),
  };
}

export function selectionForEffort(current: SessionOrchestrator, effort: string): SessionOrchestrator {
  return { runtime: current.runtime, provider: current.provider, model: current.model, effort };
}

export function formatContextWindowShort(tokens: number | undefined): string {
  if (!tokens || tokens <= 0) return '';
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

export const LOCKED_PICKER_FOOTER = 'Para trocar de provider, de Clear na lane';

export type EffortSettingField =
  'orchestratorEffort' | 'orchestratorCodexEffort' | 'orchestratorKimiEffort' | 'orchestratorGrokEffort';

export function effortSettingFieldForRuntime(runtime: OrchestratorRuntime): EffortSettingField | null {
  switch (runtime) {
    case 'claude-sdk':
      return 'orchestratorEffort';
    case 'codex-sdk':
      return 'orchestratorCodexEffort';
    case 'kimi-sdk':
      return 'orchestratorKimiEffort';
    case 'grok-sdk':
      return 'orchestratorGrokEffort';
    default:
      return null;
  }
}

export function defaultOrchestratorFromSettings(
  settings: Pick<AppSettings, 'orchestratorRuntime' | 'orchestratorProvider' | 'orchestratorModel'> &
    Partial<Pick<AppSettings, EffortSettingField>>,
): SessionOrchestrator {
  const field = effortSettingFieldForRuntime(settings.orchestratorRuntime);
  const effort = field ? settings[field] : undefined;
  return {
    runtime: settings.orchestratorRuntime,
    provider: settings.orchestratorProvider,
    model: settings.orchestratorModel,
    ...(effort ? { effort } : {}),
  };
}
