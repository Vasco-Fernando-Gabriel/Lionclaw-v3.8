import { CLAUDE_MODELS } from '../../src/constants/claude-models';
import { CLAUDE_COMPAT_PRESETS } from '../../src/constants/claude-compat-presets';
import { CODEX_MODELS } from '../../src/constants/codex-models';
import { CURSOR_MODELS } from '../../src/constants/cursor-models';
import { GROK_MODELS } from '../../src/constants/grok-models';
import { KIMI_MODELS } from '../../src/constants/kimi-models';
import type { OrchestratorProvider, OrchestratorRuntime } from '../../src/types';
import {
  findDiscoveredCodexModel,
  getCodexModelCapabilities,
} from './codex-runtime/model-capabilities';

const LION_PROVIDERS = new Set<OrchestratorProvider>([
  'ollama',
  'lmstudio',
  'openai-compatible',
  'vertex-ai',
]);

function providerMatchesRuntime(
  runtime: OrchestratorRuntime,
  provider: OrchestratorProvider,
): boolean {
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
  return CLAUDE_MODELS.some((entry) => entry.id === model)
    || CODEX_MODELS.some((entry) => entry.slug === model)
    || findDiscoveredCodexModel(model) !== undefined
    || CLAUDE_COMPAT_PRESETS.some((preset) => preset.models.some((entry) => entry.id === model))
    || KIMI_MODELS.some((entry) => entry.slug === model)
    || GROK_MODELS.some((entry) => entry.slug === model)
    || CURSOR_MODELS.some((entry) => entry.slug === model);
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
      modelAllowed = CLAUDE_MODELS.some((entry) => entry.id === model);
      break;
    case 'claude-compat-sdk':
      modelAllowed = CLAUDE_COMPAT_PRESETS
        .find((preset) => preset.id === provider)
        ?.models.some((entry) => entry.id === model) === true;
      break;
    case 'codex-sdk':
      modelAllowed = CODEX_MODELS.some((entry) => entry.slug === model);
      if (!modelAllowed) {
        await getCodexModelCapabilities();
        modelAllowed = findDiscoveredCodexModel(model) !== undefined;
      }
      break;
    case 'kimi-sdk':
      modelAllowed = KIMI_MODELS.some((entry) => entry.slug === model);
      break;
    case 'grok-sdk':
      modelAllowed = GROK_MODELS.some((entry) => entry.slug === model);
      break;
    case 'cursor-sdk':
      modelAllowed = CURSOR_MODELS.some((entry) => entry.slug === model);
      break;
    case 'lion-sdk':
      modelAllowed = !belongsToAnotherCuratedRuntime(model);
      break;
    default:
      modelAllowed = false;
  }

  return modelAllowed
    ? null
    : `Modelo "${model}" nao pertence ao provider "${provider}" do runtime "${runtime}".`;
}
