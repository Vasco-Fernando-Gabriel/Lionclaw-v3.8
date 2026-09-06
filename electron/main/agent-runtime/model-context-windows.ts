

export const CTX_GPT_5_2_UNCONFIRMED = 1_050_000;

export const CTX_GLM_5_TURBO_UNCONFIRMED = 200_000;

export const CTX_GLM_4_5_AIR_UNCONFIRMED = 131_072;


const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'opus': 1_000_000,
  'sonnet': 1_000_000,
  'haiku': 200_000,
  'claude-fable-5-1': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-sonnet-4-5-20250514': 200_000,
  'claude-sonnet-4-0-20250514': 200_000,
  'claude-opus-4-0-20250514': 200_000,
  'claude-haiku-3-5-20241022': 200_000,

  'gpt-6-astra': 1_050_000,
  'gpt-5.6-sol': 1_050_000,
  'gpt-5.6-terra': 1_050_000,
  'gpt-5.6-luna': 1_050_000,
  'gpt-5.5': 1_050_000,
  'gpt-5.5-pro': 1_050_000,
  'gpt-5.4': 1_050_000,
  'gpt-5.4-mini': 400_000,
  'gpt-5.3-codex': 1_050_000, // familia GPT-5.x (SPEC 0.5)
  'gpt-5.2': CTX_GPT_5_2_UNCONFIRMED,

  'grok-4.5': 500_000,
  'grok-4.6': 500_000,

  'composer-2.5': 200_000,
  'gemini-3.7-flash': 1_048_576,

  'glm-5.2': 1_000_000,
  'glm-5.3': 1_000_000,
  'glm-5.1': 200_000,
  'glm-5-turbo': CTX_GLM_5_TURBO_UNCONFIRMED,
  'glm-4.7': 202_752,
  'glm-4.5-air': CTX_GLM_4_5_AIR_UNCONFIRMED,

  'kimi-code/kimi-for-coding': 262_144,
  'kimi-k2.6': 262_144,
  'kimi-k3': 1_048_576,
  'kimi-code/k3': 1_048_576,
  'moonshot-v1-128k': 128_000,
  'moonshot-v1-32k': 32_000,
  'moonshot-v1-8k': 8_000,

  'minimax-m2.7': 204_800,
  'minimax-m2.7-highspeed': 204_800,
  'minimax-m2.5': 204_800,
  'minimax-m2.5-highspeed': 204_800,
  'm2-her': 204_800,
  'minimax-m3': 1_000_000,

  'deepseek-chat': 128_000,
  'deepseek-reasoner': 128_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek-v4-flash': 1_000_000,

  'qwen3-max': 131_072,
  'qwen3-coder-plus': 131_072,
  'qwen3-coder': 131_072,

  'gemini-3.1-pro-preview': 1_048_576,
  'gemini-3.1-pro-preview-customtools': 1_048_576,
  'gemini-3-pro-preview': 1_048_576,
  'gemini-3-flash-preview': 1_048_576,
  'gemini-3.1-flash-lite': 1_048_576,
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-flash-lite': 1_048_576,
  'gemini-2.0-flash': 1_048_576,
  'gemini-2.0-flash-lite': 1_048_576,
};


const CONTEXT_SUBSTRING_TABLE: ReadonlyArray<readonly [string, number]> = [
  ['qwen2.5:27b', 130_000],
  ['qwen2.5-72b', 131_072],
  ['qwen2.5-32b', 131_072],
  ['qwen2.5-14b', 131_072],
  ['qwen2.5-7b', 131_072],
  ['qwen2.5', 131_072],
  ['qwen', 131_072],
  ['llama-3.3', 131_072],
  ['llama-3.2', 131_072],
  ['llama-3.1', 131_072],
  ['llama3', 131_072],
  ['llama-3', 131_072],
  ['deepseek-r1', 131_072],
  ['deepseek-v3', 131_072],
  ['deepseek-coder', 128_000],
  ['deepseek', 128_000],
  ['mistral-small', 131_072],
  ['mistral-large', 131_072],
  ['mixtral', 32_768],
  ['mistral', 32_768],
  ['gemma3', 131_072],
  ['gemma2', 8_192],
  ['gemma', 8_192],
  ['phi-4', 16_384],
  ['phi3.5', 131_072],
  ['phi3', 131_072],
  ['command-r-plus', 131_072],
  ['command-r', 131_072],
  ['starcoder2', 16_384],
  ['starcoder', 8_192],
];


export type LocalProbeProvider = 'ollama' | 'lmstudio';

const probedContextWindows = new Map<LocalProbeProvider, Map<string, number>>();

export function setProbedContextWindows(
  provider: LocalProbeProvider,
  models: ReadonlyArray<{ id: string; contextWindow?: number }>,
): void {
  const byModel = new Map<string, number>();
  for (const m of models) {
    if (!m.id) continue;
    if (typeof m.contextWindow !== 'number' || !Number.isFinite(m.contextWindow)) continue;
    const rounded = Math.floor(m.contextWindow);
    if (rounded <= 0) continue;
    byModel.set(m.id.toLowerCase(), rounded);
  }
  probedContextWindows.set(provider, byModel);
}

export function clearProbedContextWindows(): void {
  probedContextWindows.clear();
}

function isLocalProbeProvider(provider: string | undefined): provider is LocalProbeProvider {
  return provider === 'ollama' || provider === 'lmstudio';
}


export function getContextWindow(model: string, provider?: string): number | undefined {
  const normalizedModel = model.toLowerCase();

  if (isLocalProbeProvider(provider)) {
    const probed = probedContextWindows.get(provider)?.get(normalizedModel);
    if (probed !== undefined) return probed;
  }

  const direct = MODEL_CONTEXT_WINDOWS[normalizedModel];
  if (direct !== undefined) return direct;

  for (const [key, ctx] of CONTEXT_SUBSTRING_TABLE) {
    if (normalizedModel.includes(key)) return ctx;
  }

  if (
    normalizedModel.includes('opus') ||
    normalizedModel.includes('haiku') ||
    normalizedModel.includes('sonnet') ||
    normalizedModel.includes('claude')
  ) {
    return 200_000;
  }

  return undefined;
}
