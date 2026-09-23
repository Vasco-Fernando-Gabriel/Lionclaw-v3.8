import { getSetting, getSessionOrchestrator } from './db';
import { getSecret } from './secrets-vault';
import type { SdkLane } from './sdk-lane';
import { buildDefaultOrchestratorColumns, effortSettingKeyForRuntime, type SessionOrchestrator } from './lanes';
import { CLAUDE_DEFAULT_MODEL } from '../../src/constants/claude-models';
import { CODEX_DEFAULT_MODEL, CODEX_EFFORT_ORDER } from '../../src/constants/codex-models';
import {
  clampCodexEffortForModelDiscovered,
  findDiscoveredCodexModel,
  getCodexModelCapabilities,
} from './codex-runtime/model-capabilities';
import { KIMI_DEFAULT_MODEL, resolveKimiStoredEffort } from '../../src/constants/kimi-models';
import {
  GROK_DEFAULT_MODEL,
  GROK_DEFAULT_EFFORT,
  clampGrokEffortForModel,
  type GrokReasoningEffort,
} from '../../src/constants/grok-models';
import { CLAUDE_COMPAT_PRESETS } from '../../src/constants/claude-compat-presets';
import { CURSOR_DEFAULT_MODEL } from '../../src/constants/cursor-models';
import type { CodexChatReasoningEffort, OrchestratorProvider, OrchestratorRuntime } from '../../src/types';
import { validateOrchestratorOverride, validateOrchestratorTriple } from './orchestrator-selection-matrix';
import {
  CLAUDE_DEFAULT_REASONING,
  CLAUDE_REASONING_OPTIONS,
  findCatalogModel,
  isCuratedModel,
} from './provider-models-catalog';

export type OrchestratorSelectionErrorCode =
  | 'orchestrator_unconfigured'
  | 'orchestrator_provider_unavailable'
  | 'session_required'
  | 'lane_required'
  | 'invalid_selection'
  | 'model_not_in_provider'
  | 'effort_not_supported';

export type OrchestratorSelectionMissingField = 'runtime' | 'provider' | 'model';

export class InvalidOrchestratorSelectionError extends Error {
  readonly code: OrchestratorSelectionErrorCode;
  readonly missingField?: OrchestratorSelectionMissingField;

  constructor(
    message: string,
    code: OrchestratorSelectionErrorCode = 'orchestrator_unconfigured',
    missingField?: OrchestratorSelectionMissingField,
  ) {
    super(message);
    this.name = 'InvalidOrchestratorSelectionError';
    this.code = code;
    this.missingField = missingField;
  }
}

export interface OrchestratorSelection {
  runtime: OrchestratorRuntime;
  provider: OrchestratorProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  vertexLocation?: string;
  vertexProjectId?: string;
  vertexAuthMode?: 'api-key';
  effort?: string;
  source: 'settings' | 'agent' | 'request';
}

export type OrchestratorSelectionSurface = 'main-chat' | 'compaction' | 'default';

export interface ResolveOrchestratorSelectionInput {
  surface: OrchestratorSelectionSurface;
  lane?: Pick<SdkLane, 'kind'>;
  sessionId?: string;
  requestedModel?: string;
  requestedEffort?: string;
  agentModel?: string;
  selection?: SessionOrchestrator;
}

export function readDefaultOrchestratorColumns(): SessionOrchestrator | null {
  return buildDefaultOrchestratorColumns(getSetting);
}

const CLAUDE_SLUG_PREFIX = 'claude-';
const CODEX_SLUG_PREFIX = 'gpt-';
const GLM_SLUG_PREFIX = 'glm-';

function inferRuntimeFromModel(modelId: string): OrchestratorRuntime {
  if (modelId.startsWith(CLAUDE_SLUG_PREFIX)) return 'claude-sdk';
  if (modelId.startsWith(CODEX_SLUG_PREFIX)) return 'codex-sdk';
  if (modelId.startsWith(GLM_SLUG_PREFIX)) return 'claude-compat-sdk';
  if (modelId.startsWith('MiniMax-')) return 'claude-compat-sdk';
  return 'lion-sdk';
}

function isModelInRuntime(modelId: string, runtime: OrchestratorRuntime): boolean {
  switch (runtime) {
    case 'claude-sdk':
      return findCatalogModel(runtime, 'anthropic', modelId) !== undefined;
    case 'codex-sdk':
      return (
        findCatalogModel(runtime, 'codex', modelId) !== undefined || findDiscoveredCodexModel(modelId) !== undefined
      );
    case 'claude-compat-sdk':
      return CLAUDE_COMPAT_PRESETS.some((p) => findCatalogModel(runtime, p.id, modelId) !== undefined);
    case 'kimi-sdk':
      return findCatalogModel(runtime, 'kimi', modelId) !== undefined;
    case 'grok-sdk':
      return findCatalogModel(runtime, 'grok', modelId) !== undefined;
    case 'cursor-sdk':
      return findCatalogModel(runtime, 'cursor', modelId) !== undefined;
    case 'lion-sdk':
      return !isCuratedModel(modelId);
    default: {
      const _exhaustive: never = runtime;
      return _exhaustive;
    }
  }
}

const CLAUDE_EFFORTS: readonly string[] = CLAUDE_REASONING_OPTIONS;
const CODEX_EFFORTS: readonly string[] = CODEX_EFFORT_ORDER;

export function normalizeSelectionEffort(
  runtime: OrchestratorRuntime,
  model: string,
  raw: string | undefined,
): string | undefined {
  const value = (raw ?? '').trim();
  switch (runtime) {
    case 'claude-sdk':
      return CLAUDE_EFFORTS.includes(value) ? value : CLAUDE_DEFAULT_REASONING;
    case 'codex-sdk': {
      const requested: CodexChatReasoningEffort = CODEX_EFFORTS.includes(value)
        ? (value as CodexChatReasoningEffort)
        : 'high';
      return clampCodexEffortForModelDiscovered(requested, model);
    }
    case 'kimi-sdk':
      return resolveKimiStoredEffort(model, value || undefined);
    case 'grok-sdk':
      return clampGrokEffortForModel((value || GROK_DEFAULT_EFFORT) as GrokReasoningEffort, model);
    case 'claude-compat-sdk':
    case 'cursor-sdk':
    case 'lion-sdk':
      return undefined;
    default: {
      const _exhaustive: never = runtime;
      return _exhaustive;
    }
  }
}

interface OrchestratorSettings {
  runtime?: OrchestratorRuntime;
  provider?: OrchestratorProvider;
  model?: string;
  ollamaBaseUrl?: string;
  lmstudioBaseUrl?: string;
  openAiCompatPreset?: string;
  openAiCompatBaseUrl?: string;
  openAiCompatApiKeyRef?: string;
  zaiApiKeyRef?: string;
  vertexApiKeyRef?: string;
  vertexLocation?: string;
  vertexProjectId?: string;
  vertexAuthMode?: string;
  claudeEffort?: string;
  codexEffort?: string;
  kimiEffort?: string;
  grokEffort?: string;
}

function readOrchestratorSettings(): OrchestratorSettings {
  return {
    runtime: getSetting('orchestrator_runtime') as OrchestratorRuntime | undefined,
    provider: getSetting('orchestrator_provider') as OrchestratorProvider | undefined,
    model: getSetting('orchestrator_model'),
    ollamaBaseUrl: getSetting('orchestrator_ollama_base_url'),
    lmstudioBaseUrl: getSetting('orchestrator_lmstudio_base_url'),
    openAiCompatPreset: getSetting('orchestrator_openai_compat_preset'),
    openAiCompatBaseUrl: getSetting('orchestrator_openai_compat_base_url'),
    openAiCompatApiKeyRef: getSetting('orchestrator_openai_compat_api_key_ref'),
    zaiApiKeyRef: getSetting('orchestrator_zai_api_key_ref'),
    vertexApiKeyRef: getSetting('orchestrator_vertex_api_key_ref'),
    vertexLocation: getSetting('orchestrator_vertex_location'),
    vertexProjectId: getSetting('orchestrator_vertex_project_id'),
    vertexAuthMode: getSetting('orchestrator_vertex_auth_mode'),
    claudeEffort: getSetting('orchestrator_effort'),
    codexEffort: getSetting('orchestrator_codex_effort'),
    kimiEffort: getSetting('orchestrator_kimi_effort'),
    grokEffort: getSetting('orchestrator_grok_effort'),
  };
}

function defaultProviderForRuntime(runtime: OrchestratorRuntime): OrchestratorProvider {
  switch (runtime) {
    case 'claude-sdk':
      return 'anthropic';
    case 'claude-compat-sdk':
      return 'zai';
    case 'codex-sdk':
      return 'codex';
    case 'kimi-sdk':
      return 'kimi';
    case 'grok-sdk':
      return 'grok';
    case 'cursor-sdk':
      return 'cursor';
    case 'lion-sdk':
      return 'ollama';
    default: {
      const _exhaustive: never = runtime;
      return _exhaustive;
    }
  }
}

function defaultModelForRuntime(runtime: OrchestratorRuntime): string {
  switch (runtime) {
    case 'claude-sdk':
      return CLAUDE_DEFAULT_MODEL;
    case 'codex-sdk':
      return CODEX_DEFAULT_MODEL;
    case 'kimi-sdk':
      return KIMI_DEFAULT_MODEL;
    case 'grok-sdk':
      return GROK_DEFAULT_MODEL;
    case 'cursor-sdk':
      return CURSOR_DEFAULT_MODEL;
    case 'claude-compat-sdk':
      return CLAUDE_COMPAT_PRESETS[0]?.models[0]?.id ?? '';
    case 'lion-sdk':
      return '';
    default: {
      const _exhaustive: never = runtime;
      return _exhaustive;
    }
  }
}

interface SelectionTriple {
  runtime: OrchestratorRuntime;
  provider: OrchestratorProvider;
  model: string;
  effort?: string;
}

function settingsEffortForRuntime(runtime: OrchestratorRuntime, settings: OrchestratorSettings): string | undefined {
  switch (runtime) {
    case 'claude-sdk':
      return settings.claudeEffort;
    case 'codex-sdk':
      return settings.codexEffort;
    case 'kimi-sdk':
      return settings.kimiEffort;
    case 'grok-sdk':
      return settings.grokEffort;
    default:
      return undefined;
  }
}

function tripleFromSettings(settings: OrchestratorSettings): SelectionTriple {
  if (!settings.runtime) {
    throw new InvalidOrchestratorSelectionError(
      'Orquestrador nao configurado: runtime ausente nos settings. Abra Configuracoes no app.',
      'orchestrator_unconfigured',
      'runtime',
    );
  }
  if (!settings.provider) {
    throw new InvalidOrchestratorSelectionError(
      'Orquestrador nao configurado: provider ausente nos settings. Abra Configuracoes no app.',
      'orchestrator_unconfigured',
      'provider',
    );
  }
  if (!settings.model) {
    throw new InvalidOrchestratorSelectionError(
      'Orquestrador nao configurado: modelo ausente nos settings. Abra Configuracoes no app.',
      'orchestrator_unconfigured',
      'model',
    );
  }
  return {
    runtime: settings.runtime,
    provider: settings.provider,
    model: settings.model,
    effort: settingsEffortForRuntime(settings.runtime, settings),
  };
}

function tripleFromLaneSession(sessionId: string): SelectionTriple {
  const columns = getSessionOrchestrator(sessionId);
  if (!columns) {
    throw new InvalidOrchestratorSelectionError(
      `Lane sem orquestrador: a sessao ${sessionId} nao tem runtime/provider/modelo gravados. De Clear na lane ou abra uma conversa nova.`,
      'orchestrator_unconfigured',
      'runtime',
    );
  }
  return {
    runtime: columns.runtime,
    provider: columns.provider,
    model: columns.model,
    effort: columns.effort,
  };
}

function resolveSelectionTriple(
  input: ResolveOrchestratorSelectionInput,
  settings: OrchestratorSettings,
): SelectionTriple {
  if (input.selection) {
    if (input.surface !== 'default') {
      throw new InvalidOrchestratorSelectionError(
        `Selecao explicita so e aceita na surface 'default' (recebida: ${input.surface}).`,
        'invalid_selection',
      );
    }
    return {
      runtime: input.selection.runtime,
      provider: input.selection.provider,
      model: input.selection.model,
      effort: input.selection.effort,
    };
  }
  if (input.surface !== 'main-chat') return tripleFromSettings(settings);
  if (!input.lane) {
    throw new InvalidOrchestratorSelectionError(
      'resolveOrchestratorSelection(main-chat) exige a lane do turno.',
      'lane_required',
    );
  }
  if (input.lane.kind !== 'desktop') return tripleFromSettings(settings);
  if (!input.sessionId) {
    throw new InvalidOrchestratorSelectionError(
      'Turno desktop sem sessionId: a lane e resolvida pelas colunas da sessao.',
      'session_required',
    );
  }
  return tripleFromLaneSession(input.sessionId);
}

export async function resolveOrchestratorSelection(
  input: ResolveOrchestratorSelectionInput,
): Promise<OrchestratorSelection> {
  if (input.surface !== 'main-chat' && input.surface !== 'compaction' && input.surface !== 'default') {
    throw new InvalidOrchestratorSelectionError(
      `resolveOrchestratorSelection invoked with unsupported surface=${String(input.surface)}`,
    );
  }

  const settings = readOrchestratorSettings();
  const triple = resolveSelectionTriple(input, settings);

  if (triple.runtime === 'codex-sdk') {
    await getCodexModelCapabilities();
  }

  const runtime: OrchestratorRuntime = triple.runtime;
  const provider: OrchestratorProvider = triple.provider;
  let model: string = triple.model;
  let source: OrchestratorSelection['source'] = 'settings';

  const tripleError = await validateOrchestratorTriple(runtime, provider, model);
  if (tripleError) throw new InvalidOrchestratorSelectionError(tripleError);

  if (input.requestedModel) {
    const requestedTripleError = await validateOrchestratorTriple(runtime, provider, input.requestedModel);
    if (requestedTripleError) {
      const inferred = inferRuntimeFromModel(input.requestedModel);
      throw new InvalidOrchestratorSelectionError(
        `${requestedTripleError} ` +
          `(inferred from slug: "${inferred}"). Switch the orchestrator runtime first or pick a model from "${runtime}".`,
        'model_not_in_provider',
      );
    }
    model = input.requestedModel;
    source = 'request';
  }

  if (!input.requestedModel && input.agentModel) {
    model = input.agentModel;
    source = 'agent';
  }

  if (
    (runtime === 'kimi-sdk' || runtime === 'grok-sdk' || runtime === 'cursor-sdk') &&
    !isModelInRuntime(model, runtime)
  ) {
    throw new InvalidOrchestratorSelectionError(
      `Modelo final "${model}" nao pertence ao runtime "${runtime}" (source: ${source}).`,
    );
  }

  let effortRaw: string | undefined = triple.effort;
  if (input.requestedEffort !== undefined) {
    const requested = input.requestedEffort.trim();
    const validation = await validateOrchestratorOverride({
      runtime,
      provider,
      model,
      effort: requested,
    });
    if (!validation.ok) {
      throw new InvalidOrchestratorSelectionError(validation.error, validation.code);
    }
    effortRaw = requested;
    source = 'request';
  }

  const selection: OrchestratorSelection = {
    runtime,
    provider,
    model,
    source,
  };

  const effort = normalizeSelectionEffort(runtime, model, effortRaw);
  if (effort) selection.effort = effort;

  if (runtime === 'claude-compat-sdk') {
    const preset = CLAUDE_COMPAT_PRESETS.find((p) => p.id === provider);
    if (!preset) {
      throw new InvalidOrchestratorSelectionError(`Provider "${provider}" nao registrado em CLAUDE_COMPAT_PRESETS.`);
    }
    const settingKey = `orchestrator_${provider}_api_key_ref`;
    const vaultRef = getSetting(settingKey);
    if (!vaultRef) {
      throw new InvalidOrchestratorSelectionError(
        `API key do provedor "${preset.displayName}" nao configurada. Va em Settings > External Providers.`,
      );
    }
    const apiKey = await getSecret(vaultRef);
    if (!apiKey) {
      throw new InvalidOrchestratorSelectionError(
        `Vault sem valor para "${vaultRef}" — reconecte ${preset.displayName} em Settings.`,
      );
    }
    selection.apiKey = apiKey;
    selection.baseUrl = preset.baseUrl;
  }

  if (runtime === 'lion-sdk' && provider === 'vertex-ai') {
    const vaultRef = settings.vertexApiKeyRef;
    if (!vaultRef || vaultRef.trim().length === 0) {
      throw new InvalidOrchestratorSelectionError(
        'Vertex Gemini is selected but orchestrator_vertex_api_key_ref is not set. ' +
          'Connect Vertex Gemini in External Providers before chatting.',
      );
    }
    const apiKey = await getSecret(vaultRef);
    if (!apiKey) {
      throw new InvalidOrchestratorSelectionError(
        `Vertex Gemini API key is missing from the vault (ref=${vaultRef}). ` +
          'Reconnect Vertex Gemini in External Providers.',
      );
    }
    selection.apiKey = apiKey;
    selection.vertexAuthMode = 'api-key';
    return selection;
  }

  if (runtime === 'lion-sdk') {
    let baseUrl: string | undefined;
    switch (provider) {
      case 'ollama':
        baseUrl = settings.ollamaBaseUrl;
        break;
      case 'lmstudio':
        baseUrl = settings.lmstudioBaseUrl;
        break;
      case 'openai-compatible':
        baseUrl = settings.openAiCompatBaseUrl;
        break;
      default:
        throw new InvalidOrchestratorSelectionError(`Unsupported provider "${provider}" for runtime "lion-sdk".`);
    }
    if (!baseUrl || baseUrl.trim().length === 0) {
      throw new InvalidOrchestratorSelectionError(
        `Lion-SDK provider "${provider}" requires a base URL in settings, but none is configured.`,
      );
    }
    selection.baseUrl = baseUrl;

    if (provider === 'openai-compatible') {
      const vaultRef = settings.openAiCompatApiKeyRef;
      if (!vaultRef) {
        throw new InvalidOrchestratorSelectionError(
          'OpenAI-compatible provider is selected but orchestrator_openai_compat_api_key_ref is not set. ' +
            'Connect the provider in External Providers before chatting.',
        );
      }
      const apiKey = await getSecret(vaultRef);
      if (!apiKey) {
        throw new InvalidOrchestratorSelectionError(
          `OpenAI-compatible API key is missing from the vault (ref=${vaultRef}). ` +
            'Reconnect the provider in External Providers.',
        );
      }
      selection.apiKey = apiKey;
    }
  }

  return selection;
}

export async function resolveSubscriptionSelectionFor(
  runtime: OrchestratorRuntime,
  provider: OrchestratorProvider,
  model: string,
): Promise<OrchestratorSelection> {
  if (runtime === 'codex-sdk') {
    await getCodexModelCapabilities();
  }
  if (
    runtime !== 'claude-sdk' &&
    runtime !== 'claude-compat-sdk' &&
    runtime !== 'codex-sdk' &&
    runtime !== 'kimi-sdk' &&
    runtime !== 'grok-sdk' &&
    runtime !== 'cursor-sdk'
  ) {
    throw new InvalidOrchestratorSelectionError(
      `Runtime "${runtime}" nao e um runtime de assinatura suportado para compactacao.`,
    );
  }

  const tripleError = await validateOrchestratorTriple(runtime, provider, model);
  if (tripleError) throw new InvalidOrchestratorSelectionError(tripleError);

  const selection: OrchestratorSelection = {
    runtime,
    provider,
    model,
    source: 'request',
  };

  const effortKey = effortSettingKeyForRuntime(runtime);
  const effort = normalizeSelectionEffort(runtime, model, effortKey ? getSetting(effortKey) : undefined);
  if (effort) selection.effort = effort;

  if (runtime === 'claude-compat-sdk') {
    const preset = CLAUDE_COMPAT_PRESETS.find((p) => p.id === provider);
    if (!preset) {
      throw new InvalidOrchestratorSelectionError(`Provider "${provider}" nao registrado em CLAUDE_COMPAT_PRESETS.`);
    }
    const settingKey = `orchestrator_${provider}_api_key_ref`;
    const vaultRef = getSetting(settingKey);
    if (!vaultRef) {
      throw new InvalidOrchestratorSelectionError(
        `API key do provedor "${preset.displayName}" nao configurada. Va em Settings > External Providers.`,
      );
    }
    const apiKey = await getSecret(vaultRef);
    if (!apiKey) {
      throw new InvalidOrchestratorSelectionError(
        `Vault sem valor para "${vaultRef}" - reconecte ${preset.displayName} em Settings.`,
      );
    }
    selection.apiKey = apiKey;
    selection.baseUrl = preset.baseUrl;
  }

  return selection;
}

export const __internal = {
  inferRuntimeFromModel,
  isModelInRuntime,
  defaultProviderForRuntime,
  defaultModelForRuntime,
};
