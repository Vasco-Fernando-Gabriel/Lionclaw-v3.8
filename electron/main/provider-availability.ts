import { getSetting } from './db';
import { getSecret } from './secrets-vault';
import { isCodexAvailable } from './codex-runtime/binary';
import { createCodexDriver } from './codex-runtime/factory';
import { createLogger } from './logger';
import { getContextWindow, setProbedContextWindows } from './agent-runtime/model-context-windows';
import { getCodexModelCapabilities } from './codex-runtime/model-capabilities';
import { CLAUDE_COMPAT_PRESETS } from '../../src/constants/claude-compat-presets';
import { OPENAI_COMPATIBLE_PRESETS } from '../../src/constants/openai-compatible-presets';
import { isProviderUsable } from '../../src/lib/provider-status';
import { findCatalogEntry, type ProviderCatalogModel } from './provider-models-catalog';
import { describeClaudeCliUnavailable, detectClaudeCliStatus } from './claude-cli-status';
export { isProviderUsable } from '../../src/lib/provider-status';
import type { OrchestratorProvider, OrchestratorRuntime, OpenAiCompatiblePreset } from '../../src/types';

const log = createLogger('provider-availability');

const CURSOR_VAULT_KEY = 'CURSOR_API_KEY';

export interface ModelInfo {
  id: string;
  displayName: string;
  label: string;
  reasoningOptions: string[];
  defaultReasoning: string | null;
  contextWindow?: number;
}

export interface ProviderStatus {
  runtime: OrchestratorRuntime;
  provider: OrchestratorProvider;
  connected: boolean;
  available: boolean;
  authenticated?: boolean;
  subscriptionRouteVerified?: boolean;
  isolationVerified?: boolean;
  toolPolicyVerified?: boolean;
  modelAvailable?: boolean | null;
  usable?: boolean;
  reason?: string;
  models?: ModelInfo[];
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

type ProviderProbe = Omit<ProviderStatus, 'available'>;

function finalizeStatus(probe: ProviderProbe): ProviderStatus {
  return { ...probe, available: isProviderUsable(probe) };
}

function catalogModelInfo(model: ProviderCatalogModel): ModelInfo {
  return {
    id: model.id,
    displayName: model.label,
    label: model.label,
    reasoningOptions: [...model.reasoningOptions],
    defaultReasoning: model.defaultReasoning,
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
  };
}

function catalogModelsFor(runtime: OrchestratorRuntime, provider: OrchestratorProvider): ModelInfo[] {
  return (findCatalogEntry(runtime, provider)?.models ?? []).map(catalogModelInfo);
}

function dynamicModelInfo(id: string, displayName: string, contextWindow?: number): ModelInfo {
  return {
    id,
    displayName,
    label: displayName,
    reasoningOptions: [],
    defaultReasoning: null,
    ...(contextWindow ? { contextWindow } : {}),
  };
}

function withKnownContextWindows(models: ModelInfo[], provider: OrchestratorProvider): ModelInfo[] {
  return models.map((m) => {
    if (m.contextWindow) return m;
    const known = getContextWindow(m.id, provider);
    return known ? { ...m, contextWindow: known } : m;
  });
}

const DEFAULT_PROBE_TIMEOUT_MS = 4000;

interface ProbeResult {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
}

export interface OpenAiCompatibleProbeResult {
  ok: boolean;
  status?: number;
  url: string;
  models?: ModelInfo[];
  error?: string;
}

async function probeJsonGet(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: opts.headers,
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

interface OllamaTagsModel {
  name?: string;
  model?: string;
}
interface OllamaTagsResponse {
  models?: OllamaTagsModel[];
}

function parseOllamaTags(body: string): ModelInfo[] {
  try {
    const data = JSON.parse(body) as OllamaTagsResponse;
    if (!data || !Array.isArray(data.models)) return [];
    return data.models
      .map((m) => m.name ?? m.model ?? '')
      .filter((id) => id.length > 0)
      .map((id) => dynamicModelInfo(id, id));
  } catch (err) {
    log.warn({ err }, 'failed to parse Ollama /api/tags response');
    return [];
  }
}

interface OpenAiModelsModel {
  id?: string;
  context_length?: number;
  context_window?: number;
  max_context_length?: number;
}
interface OpenAiModelsResponse {
  data?: OpenAiModelsModel[];
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}

function parseOpenAiStyleModels(body: string): ModelInfo[] {
  try {
    const data = JSON.parse(body) as OpenAiModelsResponse;
    if (!data || !Array.isArray(data.data)) return [];
    return data.data
      .map((m) => {
        const id = m.id ?? '';
        if (id.length === 0) return null;
        const contextWindow =
          positiveInteger(m.context_length) ??
          positiveInteger(m.context_window) ??
          positiveInteger(m.max_context_length);
        return dynamicModelInfo(id, id, contextWindow);
      })
      .filter((m): m is ModelInfo => m !== null);
  } catch (err) {
    log.warn({ err }, 'failed to parse OpenAI-style /v1/models response');
    return [];
  }
}

function compactBodySnippet(body: string | undefined, maxLength = 260): string {
  if (!body) return '';
  return body.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function formatOpenAiCompatibleProbeFailure(probe: ProbeResult, url: string, preset?: OpenAiCompatiblePreset): string {
  if (probe.error) return `OpenAI-compatible probe failed: ${probe.error}`;

  const status = probe.status ?? 'unknown';
  const bodySnippet = compactBodySnippet(probe.body);
  const bodySuffix = bodySnippet ? ` Resposta: ${bodySnippet}` : '';
  const kimiHint =
    (status === 401 || status === 403) && (preset === 'kimi' || preset === 'kimi-cn')
      ? ' Verifique se a chave e a Base URL sao da mesma plataforma: platform.kimi.ai usa https://api.moonshot.ai; platform.kimi.com usa https://api.moonshot.cn.'
      : '';

  return `OpenAI-compatible returned HTTP ${status} on ${url}.${bodySuffix}${kimiHint}`;
}

export async function probeOpenAiCompatibleModels(
  baseRaw: string,
  apiKey: string,
  preset?: OpenAiCompatiblePreset,
): Promise<OpenAiCompatibleProbeResult> {
  const base = normalizeBaseUrl(baseRaw);
  const url = `${base}/v1/models`;
  const probe = await probeJsonGet(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!probe.ok) {
    return {
      ok: false,
      status: probe.status,
      url,
      error: formatOpenAiCompatibleProbeFailure(probe, url, preset),
    };
  }

  return {
    ok: true,
    status: probe.status,
    url,
    models: parseOpenAiStyleModels(probe.body ?? ''),
  };
}

interface LmStudioNativeModel {
  type?: string;
  key?: string;
  display_name?: string;
  selected_variant?: string;
  max_context_length?: number;
  loaded_instances?: Array<{
    id?: string;
    config?: {
      context_length?: number;
    };
  }>;
}

interface LmStudioNativeModelsResponse {
  models?: LmStudioNativeModel[];
}

function parseLmStudioNativeModels(body: string): ModelInfo[] {
  try {
    const data = JSON.parse(body) as LmStudioNativeModelsResponse;
    if (!data || !Array.isArray(data.models)) return [];
    const models: ModelInfo[] = [];

    for (const m of data.models) {
      if (m.type && m.type !== 'llm') continue;
      const fallbackContextWindow = positiveInteger(m.max_context_length);
      const baseDisplayName = m.display_name ?? m.key ?? m.selected_variant ?? '';

      const instances = Array.isArray(m.loaded_instances) ? m.loaded_instances : [];
      if (instances.length > 0) {
        for (const instance of instances) {
          const id = instance.id ?? m.selected_variant ?? m.key ?? '';
          if (!id) continue;
          const contextWindow = positiveInteger(instance.config?.context_length) ?? fallbackContextWindow;
          models.push(dynamicModelInfo(id, baseDisplayName || id, contextWindow));
        }
        continue;
      }

      const id = m.selected_variant ?? m.key ?? '';
      if (!id) continue;
      models.push(dynamicModelInfo(id, baseDisplayName || id, fallbackContextWindow));
    }

    return models;
  } catch (err) {
    log.warn({ err }, 'failed to parse LM Studio /api/v1/models response');
    return [];
  }
}

function enrichModelsWithContext(primary: ModelInfo[], metadata: ModelInfo[]): ModelInfo[] {
  if (primary.length === 0 || metadata.length === 0) return primary;
  const byId = new Map(metadata.map((m) => [m.id, m]));
  return primary.map((m) => {
    const meta = byId.get(m.id);
    if (!meta) return m;
    const displayName = m.displayName || meta.displayName;
    return {
      ...m,
      displayName,
      label: displayName,
      contextWindow: m.contextWindow ?? meta.contextWindow,
    };
  });
}

function compatFallback(id: string, displayName: string): ModelInfo {
  return dynamicModelInfo(id, displayName);
}

const KIMI_FALLBACK_MODELS: ModelInfo[] = [
  compatFallback('moonshot-v1-8k', 'Moonshot v1 8k'),
  compatFallback('moonshot-v1-32k', 'Moonshot v1 32k'),
  compatFallback('moonshot-v1-128k', 'Moonshot v1 128k'),
];

const OPENAI_COMPAT_FALLBACK_MODELS: Record<OpenAiCompatiblePreset, ModelInfo[]> = {
  kimi: KIMI_FALLBACK_MODELS,
  'kimi-cn': KIMI_FALLBACK_MODELS,
  qwen: [
    compatFallback('qwen-plus', 'Qwen Plus'),
    compatFallback('qwen-max', 'Qwen Max'),
    compatFallback('qwen-turbo', 'Qwen Turbo'),
  ],
  deepseek: [
    compatFallback('deepseek-chat', 'DeepSeek Chat'),
    compatFallback('deepseek-reasoner', 'DeepSeek Reasoner'),
  ],
  minimax: [compatFallback('abab6.5s-chat', 'ABAB 6.5s Chat')],
  custom: [],
};

function fallbackForPreset(preset: OpenAiCompatiblePreset | undefined): ModelInfo[] {
  if (!preset) return [];
  return OPENAI_COMPAT_FALLBACK_MODELS[preset] ?? [];
}

async function checkClaudeSdkAnthropic(): Promise<ProviderProbe> {
  const models = catalogModelsFor('claude-sdk', 'anthropic');
  try {
    const cli = await detectClaudeCliStatus();
    const reason = describeClaudeCliUnavailable(cli);
    return {
      runtime: 'claude-sdk',
      provider: 'anthropic',
      connected: reason === null,
      authenticated: cli.authenticated,
      ...(reason ? { reason } : {}),
      models,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      runtime: 'claude-sdk',
      provider: 'anthropic',
      connected: false,
      reason: `Claude Code status check failed: ${message}`,
      models,
    };
  }
}

async function checkClaudeCompatPreset(provider: OrchestratorProvider): Promise<ProviderProbe> {
  const preset = CLAUDE_COMPAT_PRESETS.find((p) => p.id === provider);
  if (!preset) {
    return {
      runtime: 'claude-compat-sdk',
      provider,
      connected: false,
      reason: `Claude-compat preset desconhecido para provider="${provider}".`,
    };
  }
  const settingKey = `orchestrator_${provider}_api_key_ref`;
  const vaultRef = getSetting(settingKey);
  const models = catalogModelsFor('claude-compat-sdk', provider);
  if (!vaultRef) {
    return {
      runtime: 'claude-compat-sdk',
      provider,
      connected: false,
      reason: `${preset.displayName} API key reference not configured (${settingKey}).`,
      models,
    };
  }
  const apiKey = await getSecret(vaultRef);
  if (!apiKey) {
    return {
      runtime: 'claude-compat-sdk',
      provider,
      connected: false,
      reason: `${preset.displayName} API key missing from vault (ref=${vaultRef}).`,
      models,
    };
  }
  return {
    runtime: 'claude-compat-sdk',
    provider,
    connected: true,
    models,
  };
}

async function checkCodexSdk(): Promise<ProviderProbe> {
  try {
    const status = await isCodexAvailable();
    if (!status.installed) {
      return {
        runtime: 'codex-sdk',
        provider: 'codex',
        connected: false,
        reason: 'Codex CLI binary not found.',
      };
    }
    if (!status.authenticated) {
      return {
        runtime: 'codex-sdk',
        provider: 'codex',
        connected: false,
        reason: 'Codex CLI is installed but not authenticated (run `codex login`).',
      };
    }
    if (!status.appServerSupported) {
      return {
        runtime: 'codex-sdk',
        provider: 'codex',
        connected: false,
        reason: status.error ?? 'Codex CLI does not support app-server.',
      };
    }
    return {
      runtime: 'codex-sdk',
      provider: 'codex',
      connected: true,
      models: await codexModelsWithDiscovered(),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      runtime: 'codex-sdk',
      provider: 'codex',
      connected: false,
      reason: `Codex availability check failed: ${message}`,
    };
  }
}

async function codexModelsWithDiscovered(): Promise<ModelInfo[]> {
  const models = catalogModelsFor('codex-sdk', 'codex');
  try {
    const discovered = await getCodexModelCapabilities();
    for (const cap of discovered ?? []) {
      if (cap.hidden) continue;
      const existing = models.find((m) => m.id.toLowerCase() === cap.id.toLowerCase());
      if (existing) {
        existing.reasoningOptions = [...cap.supportedEfforts];
        existing.defaultReasoning = cap.defaultEffort;
        continue;
      }
      const displayName = cap.displayName || cap.id;
      models.push({
        ...dynamicModelInfo(cap.id, displayName),
        reasoningOptions: [...cap.supportedEfforts],
        defaultReasoning: cap.defaultEffort,
      });
    }
  } catch {}
  return models;
}

async function checkCodexAppServer(): Promise<ProviderProbe> {
  try {
    const availability = await createCodexDriver().isAvailable();
    if (!availability.installed) {
      return {
        runtime: 'codex-sdk',
        provider: 'codex-official',
        connected: false,
        reason: `Codex official driver (${availability.implementation}): CLI binary not found.`,
      };
    }
    if (!availability.authenticated) {
      return {
        runtime: 'codex-sdk',
        provider: 'codex-official',
        connected: false,
        reason: `Codex official driver (${availability.implementation}): installed but not authenticated (run \`codex login\`).`,
      };
    }
    if (!availability.appServerSupported) {
      return {
        runtime: 'codex-sdk',
        provider: 'codex-official',
        connected: false,
        reason: availability.error ?? 'Codex CLI does not support app-server.',
      };
    }
    return {
      runtime: 'codex-sdk',
      provider: 'codex-official',
      connected: true,
      models: await codexModelsWithDiscovered(),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      runtime: 'codex-sdk',
      provider: 'codex-official',
      connected: false,
      reason: `Codex official availability check failed: ${message}`,
    };
  }
}

async function checkKimiSdk(): Promise<ProviderProbe> {
  try {
    const { isKimiAvailable } = await import('./agent-runtime/kimi-availability');
    const availability = await isKimiAvailable();
    if (!availability.installed) {
      return {
        runtime: 'kimi-sdk',
        provider: 'kimi',
        connected: false,
        reason: 'Kimi CLI nao encontrado.',
      };
    }
    if (!availability.authenticated && availability.authMode === 'none') {
      return {
        runtime: 'kimi-sdk',
        provider: 'kimi',
        connected: false,
        reason: 'Kimi instalado mas nao autenticado (faca login no CLI por assinatura).',
      };
    }
    const authenticated = availability.authenticated === true;
    const usable = availability.usable ?? authenticated;
    const connected = authenticated;
    return {
      runtime: 'kimi-sdk',
      provider: 'kimi',
      connected,
      authenticated,
      subscriptionRouteVerified: availability.managedProviderVerified,
      modelAvailable: availability.modelAvailable,
      isolationVerified: true,
      usable,
      reason: usable ? undefined : availability.reason,
      models: (availability.availableModels?.length
        ? availability.availableModels
        : catalogModelsFor('kimi-sdk', 'kimi').map((model) => model.id)
      ).map((id) => {
        const curated = catalogModelsFor('kimi-sdk', 'kimi').find((model) => model.id === id);
        return curated ?? dynamicModelInfo(id, id);
      }),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      runtime: 'kimi-sdk',
      provider: 'kimi',
      connected: false,
      reason: `Kimi availability check failed: ${message}`,
    };
  }
}

async function checkGrokSdk(): Promise<ProviderProbe> {
  try {
    const { isGrokAvailable } = await import('./agent-runtime/grok-availability');
    const availability = await isGrokAvailable();
    const installed = availability.installed === true;
    const authenticated = availability.authenticated === true;
    const subscriptionRouteVerified = availability.subscriptionRouteVerified === true;
    const isolationVerified = availability.isolationVerified === true;
    const toolPolicyVerified = availability.toolPolicyVerified === true;
    const modelAvailable = availability.modelAvailable ?? null;
    const connected = installed && authenticated;
    const usable = availability.usable === true;
    return {
      runtime: 'grok-sdk',
      provider: 'grok',
      connected,
      authenticated,
      subscriptionRouteVerified,
      isolationVerified,
      toolPolicyVerified,
      modelAvailable,
      usable,
      reason: usable ? undefined : availability.reason,
      models: catalogModelsFor('grok-sdk', 'grok'),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      runtime: 'grok-sdk',
      provider: 'grok',
      connected: false,
      authenticated: false,
      subscriptionRouteVerified: false,
      isolationVerified: false,
      toolPolicyVerified: false,
      modelAvailable: null,
      usable: false,
      reason: `Grok availability check failed: ${message}`,
      models: catalogModelsFor('grok-sdk', 'grok'),
    };
  }
}

async function checkCursorSdk(): Promise<ProviderProbe> {
  const models = catalogModelsFor('cursor-sdk', 'cursor');
  const apiKey = await getSecret(CURSOR_VAULT_KEY);
  if (!apiKey) {
    return {
      runtime: 'cursor-sdk',
      provider: 'cursor',
      connected: false,
      reason: `Cursor API key missing from vault (ref=${CURSOR_VAULT_KEY}).`,
      models,
    };
  }
  return {
    runtime: 'cursor-sdk',
    provider: 'cursor',
    connected: true,
    models,
  };
}

async function checkLionOllama(): Promise<ProviderProbe> {
  const baseRaw = getSetting('orchestrator_ollama_base_url');
  if (!baseRaw) {
    return {
      runtime: 'lion-sdk',
      provider: 'ollama',
      connected: false,
      reason: 'Ollama base URL not configured (orchestrator_ollama_base_url).',
    };
  }
  const base = normalizeBaseUrl(baseRaw);
  const url = `${base}/api/tags`;
  const probe = await probeJsonGet(url);
  if (!probe.ok) {
    return {
      runtime: 'lion-sdk',
      provider: 'ollama',
      connected: false,
      reason: probe.error
        ? `Ollama probe failed: ${probe.error}`
        : `Ollama returned HTTP ${probe.status ?? 'unknown'} on ${url}.`,
    };
  }
  const ollamaModels = parseOllamaTags(probe.body ?? '');
  setProbedContextWindows('ollama', ollamaModels);
  return {
    runtime: 'lion-sdk',
    provider: 'ollama',
    connected: true,
    models: withKnownContextWindows(ollamaModels, 'ollama'),
  };
}

async function checkLionLmStudio(): Promise<ProviderProbe> {
  const baseRaw = getSetting('orchestrator_lmstudio_base_url');
  if (!baseRaw) {
    return {
      runtime: 'lion-sdk',
      provider: 'lmstudio',
      connected: false,
      reason: 'LM Studio base URL not configured (orchestrator_lmstudio_base_url).',
    };
  }
  const base = normalizeBaseUrl(baseRaw);
  const url = `${base}/v1/models`;
  const probe = await probeJsonGet(url);
  if (!probe.ok) {
    return {
      runtime: 'lion-sdk',
      provider: 'lmstudio',
      connected: false,
      reason: probe.error
        ? `LM Studio probe failed: ${probe.error}`
        : `LM Studio returned HTTP ${probe.status ?? 'unknown'} on ${url}.`,
    };
  }
  const nativeProbe = await probeJsonGet(`${base}/api/v1/models`);
  const openAiModels = parseOpenAiStyleModels(probe.body ?? '');
  const nativeModels = nativeProbe.ok ? parseLmStudioNativeModels(nativeProbe.body ?? '') : [];
  const lmStudioModels = enrichModelsWithContext(openAiModels, nativeModels);
  setProbedContextWindows('lmstudio', lmStudioModels);
  return {
    runtime: 'lion-sdk',
    provider: 'lmstudio',
    connected: true,
    models: withKnownContextWindows(lmStudioModels, 'lmstudio'),
  };
}

async function checkLionOpenAiCompatible(): Promise<ProviderProbe> {
  const baseRaw = getSetting('orchestrator_openai_compat_base_url');
  const vaultRef = getSetting('orchestrator_openai_compat_api_key_ref');
  const presetRaw = getSetting('orchestrator_openai_compat_preset');
  const preset = (presetRaw as OpenAiCompatiblePreset | undefined) ?? undefined;
  const isKnownPreset = preset ? OPENAI_COMPATIBLE_PRESETS.some((p) => p.id === preset) : false;
  const presetSafe: OpenAiCompatiblePreset | undefined = isKnownPreset ? preset : undefined;

  if (!vaultRef) {
    return {
      runtime: 'lion-sdk',
      provider: 'openai-compatible',
      connected: false,
      reason: 'OpenAI-compatible API key reference not configured.',
    };
  }
  if (!baseRaw) {
    return {
      runtime: 'lion-sdk',
      provider: 'openai-compatible',
      connected: false,
      reason: 'OpenAI-compatible base URL not configured.',
    };
  }
  const apiKey = await getSecret(vaultRef);
  if (!apiKey) {
    return {
      runtime: 'lion-sdk',
      provider: 'openai-compatible',
      connected: false,
      reason: `OpenAI-compatible API key missing from vault (ref=${vaultRef}).`,
    };
  }
  const probe = await probeOpenAiCompatibleModels(baseRaw, apiKey, presetSafe);
  if (!probe.ok) {
    return {
      runtime: 'lion-sdk',
      provider: 'openai-compatible',
      connected: false,
      reason: probe.error,
    };
  }
  const discovered = probe.models ?? [];
  const models = discovered.length > 0 ? discovered : fallbackForPreset(presetSafe);
  return {
    runtime: 'lion-sdk',
    provider: 'openai-compatible',
    connected: true,
    models: withKnownContextWindows(models, 'openai-compatible'),
  };
}

async function checkLionVertexAi(): Promise<ProviderProbe> {
  const vaultRef = getSetting('orchestrator_vertex_api_key_ref');
  if (!vaultRef) {
    return {
      runtime: 'lion-sdk',
      provider: 'vertex-ai',
      connected: false,
      reason: 'API key not configured (orchestrator_vertex_api_key_ref).',
    };
  }
  const apiKey = await getSecret(vaultRef);
  if (!apiKey) {
    return {
      runtime: 'lion-sdk',
      provider: 'vertex-ai',
      connected: false,
      reason: `API key missing from vault (ref=${vaultRef}).`,
    };
  }
  return {
    runtime: 'lion-sdk',
    provider: 'vertex-ai',
    connected: true,
    models: catalogModelsFor('lion-sdk', 'vertex-ai'),
  };
}

export async function checkProvider(
  runtime: OrchestratorRuntime,
  provider: OrchestratorProvider,
): Promise<ProviderStatus> {
  return finalizeStatus(await probeProvider(runtime, provider));
}

async function probeProvider(runtime: OrchestratorRuntime, provider: OrchestratorProvider): Promise<ProviderProbe> {
  if (runtime === 'claude-sdk' && provider === 'anthropic') return checkClaudeSdkAnthropic();
  if (runtime === 'claude-compat-sdk') return checkClaudeCompatPreset(provider);
  if (runtime === 'codex-sdk' && provider === 'codex') return checkCodexSdk();
  if (runtime === 'codex-sdk' && provider === 'codex-official') return checkCodexAppServer();
  if (runtime === 'kimi-sdk' && provider === 'kimi') return checkKimiSdk();
  if (runtime === 'grok-sdk' && provider === 'grok') return checkGrokSdk();
  if (runtime === 'cursor-sdk' && provider === 'cursor') return checkCursorSdk();
  if (runtime === 'lion-sdk' && provider === 'ollama') return checkLionOllama();
  if (runtime === 'lion-sdk' && provider === 'lmstudio') return checkLionLmStudio();
  if (runtime === 'lion-sdk' && provider === 'openai-compatible') return checkLionOpenAiCompatible();
  if (runtime === 'lion-sdk' && provider === 'vertex-ai') return checkLionVertexAi();
  return {
    runtime,
    provider,
    connected: false,
    reason: `Unsupported (runtime, provider) pair: ${runtime} / ${provider}.`,
  };
}

interface CacheEntry {
  expiresAt: number;
  promise: Promise<ProviderStatus[]>;
}

const CACHE_TTL_MS = 60_000;
let cacheEntry: CacheEntry | null = null;

export interface ListProviderStatusesOptions {
  refresh?: boolean;
}

export async function listProviderStatuses(opts: ListProviderStatusesOptions = {}): Promise<ProviderStatus[]> {
  const now = Date.now();
  if (!opts.refresh && cacheEntry && cacheEntry.expiresAt > now) {
    return cacheEntry.promise;
  }
  const promise = (async () => {
    const compatResults = await Promise.all(CLAUDE_COMPAT_PRESETS.map((p) => checkProvider('claude-compat-sdk', p.id)));
    const results = await Promise.all([
      checkProvider('claude-sdk', 'anthropic'),
      checkProvider('codex-sdk', 'codex'),
      checkProvider('lion-sdk', 'ollama'),
      checkProvider('lion-sdk', 'lmstudio'),
      checkProvider('lion-sdk', 'openai-compatible'),
      checkProvider('lion-sdk', 'vertex-ai'),
      checkProvider('kimi-sdk', 'kimi'),
      checkProvider('grok-sdk', 'grok'),
      checkProvider('codex-sdk', 'codex-official'),
      checkProvider('cursor-sdk', 'cursor'),
    ]);
    return [results[0], ...compatResults, ...results.slice(1)];
  })();
  cacheEntry = {
    expiresAt: now + CACHE_TTL_MS,
    promise,
  };
  promise.catch(() => {
    if (cacheEntry && cacheEntry.promise === promise) {
      cacheEntry = null;
    }
  });
  return promise;
}

export function invalidateProviderStatusCache(): void {
  cacheEntry = null;
}

export const __internal = {
  parseOllamaTags,
  parseOpenAiStyleModels,
  parseLmStudioNativeModels,
  enrichModelsWithContext,
  fallbackForPreset,
  CACHE_TTL_MS,
};
