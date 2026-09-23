import { CLAUDE_COMPAT_PRESETS } from '../../src/constants/claude-compat-presets';
import type { OrchestratorProvider, OrchestratorRuntime } from '../../src/types';
import { findDiscoveredCodexModel, getCodexModelCapabilities } from './codex-runtime/model-capabilities';
import { findCatalogModel, isCuratedModel, reasoningOptionsFor } from './provider-models-catalog';

const LION_PROVIDERS = new Set<OrchestratorProvider>(['ollama', 'lmstudio', 'openai-compatible', 'vertex-ai']);

function providerMatchesRuntime(runtime: OrchestratorRuntime, provider: OrchestratorProvider): boolean {
  switch (runtime) {
    case 'claude-sdk':
      return provider === 'anthropic';
    case 'claude-compat-sdk':
      return CLAUDE_COMPAT_PRESETS.some((preset) => preset.id === provider);
    case 'codex-sdk':
      return provider === 'codex';
    case 'kimi-sdk':
      return provider === 'kimi';
    case 'grok-sdk':
      return provider === 'grok';
    case 'cursor-sdk':
      return provider === 'cursor';
    case 'lion-sdk':
      return LION_PROVIDERS.has(provider);
    default:
      return false;
  }
}

function belongsToAnotherCuratedRuntime(model: string): boolean {
  return isCuratedModel(model) || findDiscoveredCodexModel(model) !== undefined;
}

export async function validateOrchestratorTriple(
  runtime: OrchestratorRuntime,
  provider: OrchestratorProvider,
  model: string,
): Promise<string | null> {
  if (!providerMatchesRuntime(runtime, provider)) {
    return `Provider "${provider}" nao pertence ao runtime "${runtime}".`;
  }

  let modelAllowed = false;
  switch (runtime) {
    case 'claude-sdk':
    case 'claude-compat-sdk':
    case 'kimi-sdk':
    case 'grok-sdk':
    case 'cursor-sdk':
      modelAllowed = findCatalogModel(runtime, provider, model) !== undefined;
      break;
    case 'codex-sdk':
      modelAllowed = findCatalogModel(runtime, provider, model) !== undefined;
      if (!modelAllowed) {
        await getCodexModelCapabilities();
        modelAllowed = findDiscoveredCodexModel(model) !== undefined;
      }
      break;
    case 'lion-sdk':
      modelAllowed = !belongsToAnotherCuratedRuntime(model);
      break;
    default:
      modelAllowed = false;
  }

  return modelAllowed ? null : `Modelo "${model}" nao pertence ao provider "${provider}" do runtime "${runtime}".`;
}

export type OrchestratorOverrideErrorCode = 'model_not_in_provider' | 'effort_not_supported';

export type OrchestratorOverrideValidation =
  { ok: true } | { ok: false; code: OrchestratorOverrideErrorCode; error: string };

export async function validateOrchestratorOverride(input: {
  runtime: OrchestratorRuntime;
  provider: OrchestratorProvider;
  model: string;
  effort?: string;
}): Promise<OrchestratorOverrideValidation> {
  const tripleError = await validateOrchestratorTriple(input.runtime, input.provider, input.model);
  if (tripleError) return { ok: false, code: 'model_not_in_provider', error: tripleError };
  if (input.effort === undefined) return { ok: true };
  const { options } = reasoningOptionsFor(input.runtime, input.provider, input.model);
  if (!options.includes(input.effort)) {
    return {
      ok: false,
      code: 'effort_not_supported',
      error:
        options.length === 0
          ? `Modelo "${input.model}" (${input.provider}) nao aceita effort.`
          : `Effort "${input.effort}" nao e suportado por "${input.model}" (${input.provider}); opcoes: ${options.join(', ')}.`,
    };
  }
  return { ok: true };
}
