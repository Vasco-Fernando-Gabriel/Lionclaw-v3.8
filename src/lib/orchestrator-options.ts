import type { OrchestratorProvider, OrchestratorRuntime } from '../types';
import { CLAUDE_DEFAULT_MODEL, CLAUDE_MODELS, type ClaudeModelOption } from '../constants/claude-models';
import { CLAUDE_COMPAT_PRESETS, type ClaudeCompatModelInfo } from '../constants/claude-compat-presets';
import { OPENAI_COMPATIBLE_PRESETS, type OpenAiCompatiblePresetEntry } from '../constants/openai-compatible-presets';
import { CODEX_DEFAULT_MODEL, CODEX_MODELS, type CodexModelOption } from '../constants/codex-models';
import { VERTEX_DEFAULT_MODEL, VERTEX_MODEL_CATALOG } from '../constants/vertex-gemini-models';
import { KIMI_DEFAULT_MODEL, KIMI_MODELS } from '../constants/kimi-models';
import { GROK_DEFAULT_MODEL, GROK_MODELS } from '../constants/grok-models';
import { CURSOR_DEFAULT_MODEL, CURSOR_MODELS } from '../constants/cursor-models';

export interface OrchestratorModelOption {
  id: string;
  displayName: string;
}

export interface OrchestratorProviderGroup {
  runtime: OrchestratorRuntime;
  provider: OrchestratorProvider;
  displayName: string;
  staticModels: OrchestratorModelOption[];
  defaultModel: string;
  requiresBaseUrl: boolean;
  requiresApiKey: boolean;
}

function toOption(m: ClaudeModelOption | ClaudeCompatModelInfo): OrchestratorModelOption {
  return { id: m.id, displayName: m.displayName };
}

function codexToOption(m: CodexModelOption): OrchestratorModelOption {
  return { id: m.slug, displayName: m.label };
}

export function buildOrchestratorOptions(): OrchestratorProviderGroup[] {
  const groups: OrchestratorProviderGroup[] = [];

  groups.push({
    runtime: 'claude-sdk',
    provider: 'anthropic',
    displayName: 'Anthropic (Claude SDK)',
    staticModels: CLAUDE_MODELS.map(toOption),
    defaultModel: CLAUDE_DEFAULT_MODEL,
    requiresBaseUrl: false,
    requiresApiKey: false, // managed via existing Claude SDK auth, opaque to SPEC-001
  });

  for (const preset of CLAUDE_COMPAT_PRESETS) {
    groups.push({
      runtime: 'claude-compat-sdk',
      provider: preset.id,
      displayName: preset.displayName,
      staticModels: preset.models.map(toOption),
      defaultModel: preset.models[0]?.id ?? '',
      requiresBaseUrl: false, // baseUrl is hard-coded in the preset
      requiresApiKey: true,
    });
  }

  groups.push({
    runtime: 'codex-sdk',
    provider: 'codex',
    displayName: 'Codex (OpenAI OAuth)',
    staticModels: CODEX_MODELS.map(codexToOption),
    defaultModel: CODEX_DEFAULT_MODEL,
    requiresBaseUrl: false,
    requiresApiKey: false, // OAuth only (Rule #3), no API key
  });

  groups.push({
    runtime: 'kimi-sdk',
    provider: 'kimi',
    displayName: 'Kimi (assinatura)',
    staticModels: KIMI_MODELS.map((model) => ({ id: model.slug, displayName: model.label })),
    defaultModel: KIMI_DEFAULT_MODEL,
    requiresBaseUrl: false,
    requiresApiKey: false,
  });

  groups.push({
    runtime: 'grok-sdk',
    provider: 'grok',
    displayName: 'Grok Build (assinatura)',
    staticModels: GROK_MODELS.map((model) => ({ id: model.slug, displayName: model.label })),
    defaultModel: GROK_DEFAULT_MODEL,
    requiresBaseUrl: false,
    requiresApiKey: false,
  });

  groups.push({
    runtime: 'cursor-sdk',
    provider: 'cursor',
    displayName: 'Cursor (User API key)',
    staticModels: CURSOR_MODELS.map((model) => ({ id: model.slug, displayName: model.label })),
    defaultModel: CURSOR_DEFAULT_MODEL,
    requiresBaseUrl: false,
    requiresApiKey: true,
  });

  groups.push({
    runtime: 'lion-sdk',
    provider: 'ollama',
    displayName: 'Ollama (local)',
    staticModels: [], // discovered live from /api/tags
    defaultModel: '',
    requiresBaseUrl: true,
    requiresApiKey: false,
  });

  groups.push({
    runtime: 'lion-sdk',
    provider: 'lmstudio',
    displayName: 'LM Studio (local)',
    staticModels: [], // discovered live from /v1/models
    defaultModel: '',
    requiresBaseUrl: true,
    requiresApiKey: false,
  });

  groups.push({
    runtime: 'lion-sdk',
    provider: 'openai-compatible',
    displayName: 'OpenAI-compatible',
    staticModels: [], // discovered live from /v1/models; fallback per preset is owned by S4
    defaultModel: '',
    requiresBaseUrl: true,
    requiresApiKey: true,
  });

  groups.push({
    runtime: 'lion-sdk',
    provider: 'vertex-ai',
    displayName: 'Gemini Agent Platform',
    staticModels: VERTEX_MODEL_CATALOG.map((m) => ({
      id: m.id,
      displayName: m.displayName,
    })),
    defaultModel: VERTEX_DEFAULT_MODEL,
    requiresBaseUrl: false,
    requiresApiKey: true,
  });

  return groups;
}

export function findOrchestratorGroup(
  runtime: OrchestratorRuntime,
  provider: OrchestratorProvider,
): OrchestratorProviderGroup | undefined {
  return buildOrchestratorOptions().find((g) => g.runtime === runtime && g.provider === provider);
}

export function listOpenAiCompatiblePresets(): OpenAiCompatiblePresetEntry[] {
  return OPENAI_COMPATIBLE_PRESETS;
}
