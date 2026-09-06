
import type { ExternalProtocol } from '../types';
import { VERTEX_DEFAULT_MODEL, VERTEX_MODEL_CATALOG } from '../constants/vertex-gemini-models';

export const PROVIDER_PRESETS: Record<string, {
  label: string;
  protocol: ExternalProtocol;
  baseUrl?: string;
  modelsEndpoint?: string;
  testEndpoint?: string;
  defaultModel: string;
  requiresApiKey: boolean;
  extraHeaders?: Record<string, string>;
  pricingUrl?: string;
  vaultKey: string;
  supportsTools: boolean;
}> = {
  openrouter: {
    label: 'OpenRouter',
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelsEndpoint: '/models',
    testEndpoint: '/auth/key',
    defaultModel: 'deepseek/deepseek-v4-pro',
    requiresApiKey: true,
    extraHeaders: {
      'HTTP-Referer': 'https://lionclaw.app',
      'X-Title': 'LionClaw',
    },
    pricingUrl: 'https://openrouter.ai/models',
    vaultKey: 'HARNESS_OPENROUTER_KEY',
    supportsTools: true,
  },
  openai: {
    label: 'OpenAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    modelsEndpoint: '/models',
    defaultModel: 'gpt-5.5',
    requiresApiKey: true,
    pricingUrl: 'https://openai.com/api/pricing/',
    vaultKey: 'HARNESS_OPENAI_KEY',
    supportsTools: true,
  },
  kimi: {
    label: 'Kimi (Moonshot)',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.moonshot.ai/v1',
    modelsEndpoint: '/models',
    defaultModel: 'kimi-k2.6',
    requiresApiKey: true,
    pricingUrl: 'https://platform.moonshot.ai/docs/pricing/chat',
    vaultKey: 'HARNESS_KIMI_KEY',
    supportsTools: true,
  },
  deepseek: {
    label: 'DeepSeek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    modelsEndpoint: '/models',
    defaultModel: 'deepseek-chat',
    requiresApiKey: true,
    pricingUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    vaultKey: 'HARNESS_DEEPSEEK_KEY',
    supportsTools: true,
  },
  qwen: {
    label: 'Qwen (Alibaba DashScope)',
    protocol: 'openai-compatible',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    modelsEndpoint: '/models',
    defaultModel: 'qwen3-max',
    requiresApiKey: true,
    pricingUrl: 'https://www.alibabacloud.com/help/en/model-studio/models',
    vaultKey: 'HARNESS_QWEN_KEY',
    supportsTools: true,
  },
  'minimax-payg': {
    label: 'MiniMax (Pay-as-you-go)',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.minimax.io/v1',
    modelsEndpoint: '/models',
    defaultModel: 'MiniMax-M2.7',
    requiresApiKey: true,
    pricingUrl: 'https://platform.minimax.io/document/Pricing',
    vaultKey: 'HARNESS_MINIMAX_PAYG_KEY',
    supportsTools: true,
  },
  'gemini-agent-platform': {
    label: 'Gemini Agent Platform',
    protocol: 'google-genai',
    defaultModel: VERTEX_DEFAULT_MODEL,
    requiresApiKey: true,
    pricingUrl: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
    vaultKey: 'ORCHESTRATOR_VERTEX_API_KEY',
    supportsTools: true,
  },
};


export type ReasoningCapability =
  | { kind: 'none' }
  | { kind: 'openai-effort' }
  | { kind: 'anthropic-thinking-flag' }
  | { kind: 'qwen-thinking-flag' }
  | { kind: 'reasoning-content-builtin' };

export interface CatalogedModel {
  id: string;
  label: string;
  pricingKey: string | null;
  supportsTools: boolean;
  contextWindow: number;
  notes?: string;
  reasoning?: ReasoningCapability;
}

export const MODEL_CATALOG: Record<string, CatalogedModel[]> = {
  openai: [
    {
      id: 'gpt-5.5',
      label: 'GPT-5.5 CTX 1M',
      pricingKey: 'gpt-5.5',
      supportsTools: true,
      contextWindow: 1_000_000,
      notes: 'Atencao: input >272k cobra 2x e output 1.5x pelo restante da sessao.',
    },
    {
      id: 'gpt-5.5-pro',
      label: 'GPT-5.5 Pro CTX 1M',
      pricingKey: 'gpt-5.5-pro',
      supportsTools: true,
      contextWindow: 1_000_000,
      notes: 'Reasoning extra. Custo opus-level. Use apenas quando precisa qualidade maxima.',
    },
  ],
  openrouter: [
    {
      id: 'deepseek/deepseek-v4-pro',
      label: 'DeepSeek V4 Pro CTX 1M',
      pricingKey: 'or:deepseek/deepseek-v4-pro',
      supportsTools: true,
      contextWindow: 1_000_000,
      notes: 'Frontier custo-beneficio. Bom Coder default.',
    },
    {
      id: 'deepseek/deepseek-v4-flash',
      label: 'DeepSeek V4 Flash CTX 1M',
      pricingKey: 'or:deepseek/deepseek-v4-flash',
      supportsTools: true,
      contextWindow: 1_000_000,
      notes: 'Rapido e barato. Bom Evaluator.',
    },

    {
      id: 'moonshotai/kimi-k2.6',
      label: 'Kimi K2.6 CTX 256K',
      pricingKey: 'or:moonshotai/kimi-k2.6',
      supportsTools: true,
      contextWindow: 256_000,
      notes: 'Treinado pra long-horizon coding multi-agent.',
    },
    {
      id: 'moonshotai/kimi-k2-thinking',
      label: 'Kimi K2 Thinking CTX 256K',
      pricingKey: 'or:moonshotai/kimi-k2-thinking',
      supportsTools: true,
      contextWindow: 256_000,
      notes: 'Reasoning explicito. Bom Planner.',
    },
    {
      id: 'moonshotai/kimi-k3',
      label: 'Kimi K3 CTX 1M',
      pricingKey: 'or:moonshotai/kimi-k3',
      supportsTools: true,
      contextWindow: 1_048_576,
      notes: 'Flagship Moonshot (Jul/2026). Long-horizon coding, ctx 1M. $3/$15 por 1M.',
    },

    {
      id: 'qwen/qwen3.6-max-preview',
      label: 'Qwen 3.6 Max Preview CTX 262K',
      pricingKey: 'or:qwen/qwen3.6-max-preview',
      supportsTools: true,
      contextWindow: 262_000,
      notes: 'Thinking mode integrado + tool use forte.',
    },
    {
      id: 'qwen/qwen3.6-plus',
      label: 'Qwen 3.6 Plus CTX 262K',
      pricingKey: 'or:qwen/qwen3.6-plus',
      supportsTools: true,
      contextWindow: 262_000,
    },

    {
      id: 'minimax/minimax-m2.7',
      label: 'MiniMax M2.7 CTX 196K',
      pricingKey: 'or:minimax/minimax-m2.7',
      supportsTools: true,
      contextWindow: 196_608,
      notes: 'Excelente custo-beneficio. Forte em SWE-Pro e Terminal Bench. Cache nativo $0.059/1M.',
    },
    {
      id: 'minimax/minimax-m2.5',
      label: 'MiniMax M2.5 CTX 196K',
      pricingKey: 'or:minimax/minimax-m2.5',
      supportsTools: true,
      contextWindow: 196_608,
      notes: 'Output ate 131K tokens. Bom pra geracoes longas.',
    },
    {
      id: 'minimax/minimax-m1',
      label: 'MiniMax M1 CTX 1M',
      pricingKey: 'or:minimax/minimax-m1',
      supportsTools: true,
      contextWindow: 1_000_000,
      notes: 'Contexto enorme. Output limitado a 40k tokens.',
    },

    {
      id: 'z-ai/glm-4.7',
      label: 'GLM 4.7 CTX 202K',
      pricingKey: 'or:z-ai/glm-4.7',
      supportsTools: true,
      contextWindow: 202_752,
      notes: 'Z.ai newest. Forte em agent frameworks e tool use.',
    },
    {
      id: 'z-ai/glm-4.7-flash',
      label: 'GLM 4.7 Flash CTX 202K',
      pricingKey: 'or:z-ai/glm-4.7-flash',
      supportsTools: true,
      contextWindow: 202_752,
      notes: '30B-class SOTA. $0.06 input. Output limitado a 16K tokens.',
    },
  ],


  kimi: [
    {
      id: 'kimi-k3',
      label: 'Kimi K3 CTX 1M',
      pricingKey: 'kimi-k3',
      supportsTools: true,
      contextWindow: 1_048_576,
      reasoning: { kind: 'none' },
      notes: 'Flagship Moonshot. Cache hit $0.30, cache miss $3.00, output $15.00 por 1M. Ctx 1M flat.',
    },
    {
      id: 'kimi-k2.6',
      label: 'Kimi K2.6 CTX 262K',
      pricingKey: 'kimi-k2.6',
      supportsTools: true,
      contextWindow: 262_144,
      reasoning: { kind: 'none' },
      notes: 'Kimi K2.6. Cache hit $0.16, cache miss $0.95, output $4.00 por 1M.',
    },
    {
      id: 'kimi-k2-turbo-preview',
      label: 'Kimi K2 Turbo Preview CTX 128K',
      pricingKey: null,
      supportsTools: true,
      contextWindow: 128_000,
      reasoning: { kind: 'none' },
      notes: 'Kimi K2 Turbo via Moonshot API. Pricing nao confirmado.',
    },
  ],

  deepseek: [
    {
      id: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro CTX 1M',
      pricingKey: 'deepseek-v4-pro',
      supportsTools: true,
      contextWindow: 1_000_000,
      reasoning: { kind: 'none' },
      notes: 'V4 Pro. Promo 75% off ativa: input $0.435 (cache miss), $0.003625 (cache hit), output $0.87 por 1M. Max output 384K. Suporta thinking mode.',
    },
    {
      id: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash CTX 1M',
      pricingKey: 'deepseek-v4-flash',
      supportsTools: true,
      contextWindow: 1_000_000,
      reasoning: { kind: 'none' },
      notes: 'V4 Flash. Input $0.14 (cache miss), $0.0028 (cache hit), output $0.28 por 1M. Max output 384K.',
    },
    {
      id: 'deepseek-chat',
      label: 'DeepSeek Chat (legacy) CTX 64K',
      pricingKey: 'deepseek-chat',
      supportsTools: true,
      contextWindow: 64_000,
      reasoning: { kind: 'none' },
      notes: 'Endpoint legacy (V3-era). Use V4-Pro/Flash para novos agentes.',
    },
    {
      id: 'deepseek-reasoner',
      label: 'DeepSeek Reasoner (legacy) CTX 64K',
      pricingKey: 'deepseek-reasoner',
      supportsTools: true,
      contextWindow: 64_000,
      reasoning: { kind: 'reasoning-content-builtin' },
      notes: 'Legacy. Chain-of-thought embutido (reasoning_content).',
    },
  ],

  qwen: [
    {
      id: 'qwen3-max',
      label: 'Qwen3 Max CTX 131K',
      pricingKey: 'qwen3-max',
      supportsTools: true,
      contextWindow: 131_072,
      reasoning: { kind: 'none' },
    },
    {
      id: 'qwen3-coder-plus',
      label: 'Qwen3 Coder Plus CTX 131K',
      pricingKey: 'qwen3-coder-plus',
      supportsTools: true,
      contextWindow: 131_072,
      reasoning: { kind: 'none' },
      notes: 'Qwen3 Coder Plus. $1 input / $5 output por 1M.',
    },
    {
      id: 'qwen3-coder',
      label: 'Qwen3 Coder CTX 131K',
      pricingKey: null,
      supportsTools: true,
      contextWindow: 131_072,
      reasoning: { kind: 'none' },
      notes: 'Variante base. Pricing nao confirmado na documentacao internacional.',
    },
  ],

  'minimax-payg': [
    {
      id: 'MiniMax-M2.7',
      label: 'MiniMax M2.7 CTX 196K',
      pricingKey: 'minimax-m2.7',
      supportsTools: true,
      contextWindow: 196_608,
      reasoning: { kind: 'none' },
      notes: 'Default. Mesmo pricing do TokenPlan ($0.30/$1.20). Cache read $0.06 / write $0.375.',
    },
    {
      id: 'MiniMax-M2.7-highspeed',
      label: 'MiniMax M2.7 Highspeed CTX 196K',
      pricingKey: 'minimax-m2.7-highspeed',
      supportsTools: true,
      contextWindow: 196_608,
      reasoning: { kind: 'none' },
      notes: 'Variante highspeed: 2x o custo do M2.7 ($0.60/$2.40). Latencia menor.',
    },
    {
      id: 'MiniMax-M2.5',
      label: 'MiniMax M2.5 CTX 196K',
      pricingKey: 'minimax-m2.5',
      supportsTools: true,
      contextWindow: 196_608,
      reasoning: { kind: 'none' },
      notes: 'Versao anterior do M2. Cache read $0.03 (mais barato que M2.7).',
    },
    {
      id: 'MiniMax-M2.5-highspeed',
      label: 'MiniMax M2.5 Highspeed CTX 196K',
      pricingKey: 'minimax-m2.5-highspeed',
      supportsTools: true,
      contextWindow: 196_608,
      reasoning: { kind: 'none' },
      notes: 'Variante highspeed do M2.5: 2x o custo ($0.60/$2.40).',
    },
    {
      id: 'M2-her',
      label: 'MiniMax M2-her CTX 196K',
      pricingKey: 'm2-her',
      supportsTools: true,
      contextWindow: 196_608,
      reasoning: { kind: 'none' },
      notes: 'Sem prompt caching (cache read/write nao cobrados/aplicaveis). $0.30/$1.20.',
    },
  ],

  'gemini-agent-platform': VERTEX_MODEL_CATALOG.map((model): CatalogedModel => ({
    id: model.id,
    label: `${model.displayName} CTX ${Math.round(model.contextWindow / 1_000_000)}M`,
    pricingKey: null,
    supportsTools: true,
    contextWindow: model.contextWindow,
    reasoning: { kind: 'none' },
    notes: `${model.stage}. Max output ${model.outputCap} tokens. Pricing nao confirmado; custo nao estimado.`,
  })),
};

