import type { OpenAiCompatiblePreset } from '../types';

export interface OpenAiCompatiblePresetEntry {
  id: OpenAiCompatiblePreset;
  displayName: string;
  baseUrl: string;
  defaultModel?: string;
  models?: OpenAiCompatibleModelEntry[];
}

export interface OpenAiCompatibleModelEntry {
  id: string;
  displayName: string;
  contextWindow?: number;
  notes?: string;
}

export const OPENAI_COMPATIBLE_PRESETS: OpenAiCompatiblePresetEntry[] = [
  {
    id: 'kimi',
    displayName: 'Kimi (Moonshot Global)',
    baseUrl: 'https://api.moonshot.ai',
    defaultModel: 'kimi-k2.6',
    models: [
      {
        id: 'kimi-k3',
        displayName: 'Kimi K3',
        contextWindow: 1_048_576,
        notes: 'Flagship Moonshot com contexto de 1M tokens.',
      },
      {
        id: 'kimi-k2.6',
        displayName: 'Kimi K2.6',
        contextWindow: 262_144,
        notes: 'Modelo principal atual da API Moonshot/Kimi.',
      },
      {
        id: 'moonshot-v1-128k',
        displayName: 'Moonshot v1 128k',
        contextWindow: 128_000,
        notes: 'Modelo legado de texto longo.',
      },
      {
        id: 'moonshot-v1-32k',
        displayName: 'Moonshot v1 32k',
        contextWindow: 32_000,
        notes: 'Modelo legado.',
      },
      {
        id: 'moonshot-v1-8k',
        displayName: 'Moonshot v1 8k',
        contextWindow: 8_000,
        notes: 'Modelo legado.',
      },
    ],
  },
  {
    id: 'kimi-cn',
    displayName: 'Kimi (Moonshot China)',
    baseUrl: 'https://api.moonshot.cn',
    defaultModel: 'kimi-k2.6',
    models: [
      {
        id: 'kimi-k3',
        displayName: 'Kimi K3',
        contextWindow: 1_048_576,
      },
      {
        id: 'kimi-k2.6',
        displayName: 'Kimi K2.6',
        contextWindow: 262_144,
      },
      {
        id: 'moonshot-v1-128k',
        displayName: 'Moonshot v1 128k',
        contextWindow: 128_000,
      },
      {
        id: 'moonshot-v1-32k',
        displayName: 'Moonshot v1 32k',
        contextWindow: 32_000,
      },
      {
        id: 'moonshot-v1-8k',
        displayName: 'Moonshot v1 8k',
        contextWindow: 8_000,
      },
    ],
  },
  {
    id: 'qwen',
    displayName: 'Qwen (Aliyun)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    defaultModel: 'qwen3-max',
    models: [
      {
        id: 'qwen3-max',
        displayName: 'Qwen3 Max',
        contextWindow: 131_072,
      },
      {
        id: 'qwen3-coder-plus',
        displayName: 'Qwen3 Coder Plus',
        contextWindow: 131_072,
      },
      {
        id: 'qwen3-coder',
        displayName: 'Qwen3 Coder',
        contextWindow: 131_072,
      },
      {
        id: 'qwen-plus',
        displayName: 'Qwen Plus',
      },
      {
        id: 'qwen-max',
        displayName: 'Qwen Max',
      },
    ],
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-pro',
    models: [
      {
        id: 'deepseek-v4-pro',
        displayName: 'DeepSeek V4 Pro',
        contextWindow: 1_000_000,
      },
      {
        id: 'deepseek-v4-flash',
        displayName: 'DeepSeek V4 Flash',
        contextWindow: 1_000_000,
      },
      {
        id: 'deepseek-chat',
        displayName: 'DeepSeek Chat',
        contextWindow: 64_000,
      },
      {
        id: 'deepseek-reasoner',
        displayName: 'DeepSeek Reasoner',
        contextWindow: 64_000,
      },
    ],
  },
  {
    id: 'minimax',
    displayName: 'MiniMax (Pay-as-you-go)',
    baseUrl: 'https://api.minimaxi.chat',
    defaultModel: 'MiniMax-M2.7',
    models: [
      {
        id: 'MiniMax-M2.7',
        displayName: 'MiniMax M2.7',
        contextWindow: 196_608,
      },
      {
        id: 'MiniMax-M2.7-highspeed',
        displayName: 'MiniMax M2.7 Highspeed',
        contextWindow: 196_608,
      },
      {
        id: 'MiniMax-M2.5',
        displayName: 'MiniMax M2.5',
        contextWindow: 196_608,
      },
      {
        id: 'MiniMax-M2.5-highspeed',
        displayName: 'MiniMax M2.5 Highspeed',
        contextWindow: 196_608,
      },
      {
        id: 'M2-her',
        displayName: 'MiniMax M2-her',
        contextWindow: 196_608,
      },
      {
        id: 'MiniMax-M3',
        displayName: 'MiniMax M3',
        contextWindow: 1_000_000,
      },
    ],
  },
  {
    id: 'custom',
    displayName: 'Custom',
    baseUrl: '',
    defaultModel: '',
    models: [],
  },
];

export function getOpenAiCompatiblePreset(id: OpenAiCompatiblePreset): OpenAiCompatiblePresetEntry | undefined {
  return OPENAI_COMPATIBLE_PRESETS.find((p) => p.id === id);
}
