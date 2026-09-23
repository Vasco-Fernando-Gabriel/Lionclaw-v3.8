import { CLAUDE_MODELS } from '../../src/constants/claude-models';
import { CLAUDE_COMPAT_PRESETS } from '../../src/constants/claude-compat-presets';
import { CODEX_MODELS, staticEffortsFor } from '../../src/constants/codex-models';
import { CURSOR_MODELS } from '../../src/constants/cursor-models';
import { GROK_MODELS, GROK_DEFAULT_EFFORT } from '../../src/constants/grok-models';
import { KIMI_MODELS } from '../../src/constants/kimi-models';
import { VERTEX_MODEL_CATALOG } from '../../src/constants/vertex-gemini-models';
import type { OrchestratorProvider, OrchestratorRuntime } from '../../src/types';
import { getContextWindow } from './agent-runtime/model-context-windows';
import { findDiscoveredCodexModel } from './codex-runtime/model-capabilities';

export interface ProviderCatalogModel {
  id: string;
  label: string;
  reasoningOptions: readonly string[];
  defaultReasoning: string | null;
  contextWindow: number | null;
}

export interface ProviderCatalogEntry {
  runtime: OrchestratorRuntime;
  provider: OrchestratorProvider;
  dynamic: boolean;
  models: readonly ProviderCatalogModel[];
}

export const CLAUDE_REASONING_OPTIONS = ['low', 'medium', 'high', 'max'] as const;
export const CLAUDE_DEFAULT_REASONING = 'high';
export const CODEX_DEFAULT_REASONING = 'high';

function windowOf(id: string, provider: OrchestratorProvider, explicit?: number): number | null {
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  return getContextWindow(id, provider) ?? null;
}

function claudeEntry(): ProviderCatalogEntry {
  return {
    runtime: 'claude-sdk',
    provider: 'anthropic',
    dynamic: false,
    models: CLAUDE_MODELS.map((m) => ({
      id: m.id,
      label: m.displayName,
      reasoningOptions: CLAUDE_REASONING_OPTIONS,
      defaultReasoning: CLAUDE_DEFAULT_REASONING,
      contextWindow: windowOf(m.id, 'anthropic'),
    })),
  };
}

function codexEntry(): ProviderCatalogEntry {
  return {
    runtime: 'codex-sdk',
    provider: 'codex',
    dynamic: true,
    models: CODEX_MODELS.map((m) => ({
      id: m.slug,
      label: m.label,
      reasoningOptions: staticEffortsFor(m.slug),
      defaultReasoning: CODEX_DEFAULT_REASONING,
      contextWindow: windowOf(m.slug, 'codex'),
    })),
  };
}

function compatEntries(): ProviderCatalogEntry[] {
  return CLAUDE_COMPAT_PRESETS.map((preset) => ({
    runtime: 'claude-compat-sdk',
    provider: preset.id,
    dynamic: false,
    models: preset.models.map((m) => ({
      id: m.id,
      label: m.displayName,
      reasoningOptions: [],
      defaultReasoning: null,
      contextWindow: windowOf(m.id, preset.id),
    })),
  }));
}

function kimiEntry(): ProviderCatalogEntry {
  return {
    runtime: 'kimi-sdk',
    provider: 'kimi',
    dynamic: false,
    models: KIMI_MODELS.map((m) => ({
      id: m.slug,
      label: m.label,
      reasoningOptions: m.efforts,
      defaultReasoning: m.efforts.length === 0 ? null : (m.defaultEffort ?? m.efforts[m.efforts.length - 1] ?? null),
      contextWindow: windowOf(m.slug, 'kimi', m.contextWindow),
    })),
  };
}

function grokEntry(): ProviderCatalogEntry {
  return {
    runtime: 'grok-sdk',
    provider: 'grok',
    dynamic: false,
    models: GROK_MODELS.map((m) => ({
      id: m.slug,
      label: m.label,
      reasoningOptions: m.efforts,
      defaultReasoning: m.efforts.includes(GROK_DEFAULT_EFFORT)
        ? GROK_DEFAULT_EFFORT
        : (m.efforts[m.efforts.length - 1] ?? null),
      contextWindow: windowOf(m.slug, 'grok', m.contextWindow),
    })),
  };
}

function cursorEntry(): ProviderCatalogEntry {
  return {
    runtime: 'cursor-sdk',
    provider: 'cursor',
    dynamic: false,
    models: CURSOR_MODELS.map((m) => ({
      id: m.slug,
      label: m.label,
      reasoningOptions: m.effortTiers ?? [],
      defaultReasoning:
        m.effortTiers && m.effortTiers.length > 0 ? (m.effortTiers[m.effortTiers.length - 1] ?? null) : null,
      contextWindow: windowOf(m.slug, 'cursor', m.contextWindow),
    })),
  };
}

function lionEntries(): ProviderCatalogEntry[] {
  return [
    { runtime: 'lion-sdk', provider: 'ollama', dynamic: true, models: [] },
    { runtime: 'lion-sdk', provider: 'lmstudio', dynamic: true, models: [] },
    { runtime: 'lion-sdk', provider: 'openai-compatible', dynamic: true, models: [] },
    {
      runtime: 'lion-sdk',
      provider: 'vertex-ai',
      dynamic: false,
      models: VERTEX_MODEL_CATALOG.map((m) => ({
        id: m.id,
        label: m.displayName,
        reasoningOptions: [],
        defaultReasoning: null,
        contextWindow: windowOf(m.id, 'vertex-ai', m.contextWindow),
      })),
    },
  ];
}

export const PROVIDER_MODELS: readonly ProviderCatalogEntry[] = [
  claudeEntry(),
  codexEntry(),
  ...compatEntries(),
  kimiEntry(),
  grokEntry(),
  cursorEntry(),
  ...lionEntries(),
];

export function findCatalogEntry(
  runtime: OrchestratorRuntime,
  provider: OrchestratorProvider,
): ProviderCatalogEntry | undefined {
  return PROVIDER_MODELS.find((entry) => entry.runtime === runtime && entry.provider === provider);
}

export function findCatalogModel(
  runtime: OrchestratorRuntime,
  provider: OrchestratorProvider,
  model: string,
): ProviderCatalogModel | undefined {
  return findCatalogEntry(runtime, provider)?.models.find((entry) => entry.id === model);
}

export function isCuratedModel(model: string): boolean {
  return PROVIDER_MODELS.some((entry) => entry.runtime !== 'lion-sdk' && entry.models.some((m) => m.id === model));
}

export function reasoningOptionsFor(
  runtime: OrchestratorRuntime,
  provider: OrchestratorProvider,
  model: string,
): { options: readonly string[]; defaultReasoning: string | null } {
  const curated = findCatalogModel(runtime, provider, model);
  if (curated) return { options: curated.reasoningOptions, defaultReasoning: curated.defaultReasoning };
  if (runtime === 'codex-sdk') {
    const discovered = findDiscoveredCodexModel(model);
    if (discovered) {
      return { options: discovered.supportedEfforts, defaultReasoning: discovered.defaultEffort };
    }
  }
  return { options: [], defaultReasoning: null };
}
