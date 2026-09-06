const ANTHROPIC_ALIASES: Record<string, string> = {
  'claude-fable-5-1': 'fable',
  'claude-fable-5': 'fable',
  'claude-sonnet-4-6': 'sonnet',
  'claude-sonnet-4-5': 'sonnet',
  'claude-sonnet-4': 'sonnet',
  'claude-haiku-4-5-20251001': 'haiku',
  'claude-haiku-4-5': 'haiku',
  'claude-haiku-4': 'haiku',
  'claude-opus-5': 'opus',
  'claude-opus-4-8': 'opus',
  'claude-opus-4-7': 'opus',
  'claude-opus-4-6': 'opus',
  'claude-opus-4': 'opus',
  'sonnet': 'sonnet',
  'haiku': 'haiku',
  'opus': 'opus',
  'fable': 'fable',
};

const GEMINI_ALIASES: Record<string, string> = {
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
  'gemini-3.1-pro-preview-customtools': 'Gemini 3.1 Pro',
  'gemini-3-pro-preview': 'Gemini 3 Pro',
  'gemini-3-flash-preview': 'Gemini 3 Flash',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-flash-lite': 'Gemini 2.5 Flash-Lite',
  'gemini-2.0-flash': 'Gemini 2.0 Flash',
  'gemini-2.0-flash-lite': 'Gemini 2.0 Flash-Lite',
};

const GROK_ALIASES: Record<string, string> = {
  'grok-4.5': 'Grok 4.5',
  'grok-4.6': 'Grok 4.6',
};

const CURSOR_ALIASES: Record<string, string> = {
  'composer-2.5': 'Composer 2.5',
  'gemini-3.7-flash': 'Gemini 3.7 Flash',
};

export function shortenModel(model: string | null | undefined): string {
  if (!model) return '';
  if (ANTHROPIC_ALIASES[model]) return ANTHROPIC_ALIASES[model];
  if (GEMINI_ALIASES[model]) return GEMINI_ALIASES[model];
  if (GROK_ALIASES[model]) return GROK_ALIASES[model];
  if (CURSOR_ALIASES[model]) return CURSOR_ALIASES[model];
  if (model.includes('/')) {
    const parts = model.split('/');
    const last = parts[parts.length - 1];
    return ANTHROPIC_ALIASES[last] ?? GEMINI_ALIASES[last] ?? last;
  }
  return model;
}

const EXTERNAL_DISPLAY: Record<string, { name: string; ctx: string }> = {
  'deepseek/deepseek-r4': { name: 'DeepSeek R4', ctx: '1M' },
  'deepseek/deepseek-r1': { name: 'DeepSeek R1', ctx: '128k' },
  'deepseek/deepseek-chat': { name: 'DeepSeek Chat', ctx: '128k' },
  'deepseek/deepseek-v3': { name: 'DeepSeek V3', ctx: '128k' },

  'minimax/minimax-m2.7': { name: 'MiniMax 2.7', ctx: '196k' },
  'minimax/minimax-m2': { name: 'MiniMax 2', ctx: '196k' },
  'minimax/minimax-text-01': { name: 'MiniMax Text 01', ctx: '4M' },

  'qwen/qwen3.6-max-preview': { name: 'Qwen 3.6 Max', ctx: '200k' },
  'qwen/qwen3-max': { name: 'Qwen 3 Max', ctx: '128k' },
  'qwen/qwen-2.5-72b-instruct': { name: 'Qwen 2.5 72B', ctx: '128k' },

  'moonshotai/kimi-k2': { name: 'Kimi K2', ctx: '200k' },
  'moonshotai/kimi-k1.5': { name: 'Kimi K1.5', ctx: '128k' },

  'thudm/glm-4.6': { name: 'GLM 4.6', ctx: '200k' },

  'anthropic/claude-sonnet-4-5': { name: 'Sonnet 4.5', ctx: '200k' },
  'anthropic/claude-sonnet-4-6': { name: 'Sonnet 4.6', ctx: '200k' },
  'anthropic/claude-haiku-4-5': { name: 'Haiku 4.5', ctx: '200k' },
  'anthropic/claude-opus-5': { name: 'Opus 5', ctx: '1M' },
  'anthropic/claude-opus-4-8': { name: 'Opus 4.8', ctx: '1M' },
  'anthropic/claude-opus-4-7': { name: 'Opus 4.7', ctx: '200k' },
};

export function displayModelWithContext(model: string | null | undefined): string {
  if (!model) return '';
  const meta = EXTERNAL_DISPLAY[model];
  if (meta) return `${meta.name} ${meta.ctx}`;
  return shortenModel(model);
}

const TIER_LABEL: Record<string, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
};

export function formatModelLabel(model: string | null | undefined): string {
  if (!model) return '';
  if (EXTERNAL_DISPLAY[model]) return EXTERNAL_DISPLAY[model].name;
  if (GEMINI_ALIASES[model]) return GEMINI_ALIASES[model];

  const anthropic = model.match(/claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i);
  if (anthropic) {
    const tier = TIER_LABEL[anthropic[1].toLowerCase()] ?? anthropic[1];
    return anthropic[3] !== undefined
      ? `${tier} ${anthropic[2]}.${anthropic[3]}`
      : `${tier} ${anthropic[2]}`;
  }

  const gpt = model.match(/^gpt-?(.+)$/i);
  if (gpt) return `GPT ${gpt[1].replace(/-/g, ' ')}`;

  return shortenModel(model);
}
