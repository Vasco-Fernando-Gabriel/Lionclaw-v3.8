import type { OrchestratorRuntime, OrchestratorProvider, OpenAiCompatiblePreset } from '../../src/types';
import { getContextWindow } from './agent-runtime/model-context-windows';


export interface LongContextPricing {
  thresholdTokens: number;
  inputMultiplier: number;
  outputMultiplier: number;
}

export interface ModelPricingEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreationBilling?: 'not-separately-reported';
  longContext?: LongContextPricing;
}

const GPT_LONG_CONTEXT_272K: LongContextPricing = {
  thresholdTokens: 272_000,
  inputMultiplier: 2,
  outputMultiplier: 1.5,
};

const GROK_45_LONG_CONTEXT: LongContextPricing = {
  thresholdTokens: 200_000,
  inputMultiplier: 2,
  outputMultiplier: 2,
};

export const MODEL_PRICING: Record<string, ModelPricingEntry> = {
  'sonnet': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreation: 3.75 },
  'opus': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheCreation: 6.25 },
  'haiku': { input: 1.00, output: 5.00, cacheRead: 0.10, cacheCreation: 1.25 },
  'claude-fable-5-1': { input: 10.00, output: 50.00, cacheRead: 0.25, cacheCreation: 12.50 },
  'claude-fable-5': { input: 10.00, output: 50.00, cacheRead: 1.00, cacheCreation: 12.50 },
  'claude-opus-5': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheCreation: 6.25 },
  'claude-opus-4-8': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheCreation: 6.25 },
  'claude-opus-4-7': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheCreation: 6.25 },
  'claude-opus-4-6': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheCreation: 6.25 },
  'claude-sonnet-5': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreation: 3.75 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreation: 3.75 },
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00, cacheRead: 0.10, cacheCreation: 1.25 },
  'claude-sonnet-4-5-20250514': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreation: 3.75 },
  'claude-sonnet-4-0-20250514': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreation: 3.75 },
  'claude-opus-4-0-20250514': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheCreation: 18.75 },
  'claude-haiku-3-5-20241022': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheCreation: 1.00 },

  'gpt-5.6-sol':   { input: 5.00,  output: 30.00,  cacheRead: 0.50,   cacheCreation: 6.25,  longContext: GPT_LONG_CONTEXT_272K },
  'gpt-5.6-terra': { input: 2.50,  output: 15.00,  cacheRead: 0.25,   cacheCreation: 3.125, longContext: GPT_LONG_CONTEXT_272K },
  'gpt-5.6-luna':  { input: 1.00,  output: 6.00,   cacheRead: 0.10,   cacheCreation: 1.25,  longContext: GPT_LONG_CONTEXT_272K },

  'gpt-6-astra':   { input: 10.00, output: 50.00,  cacheRead: 1.00,   cacheCreation: 12.50, longContext: GPT_LONG_CONTEXT_272K },

  'gpt-5.5':       { input: 5.00,  output: 30.00,  cacheRead: 0.50,   cacheCreation: 0 },
  'gpt-5.5-pro':   { input: 30.00, output: 180.00, cacheRead: 3.00,   cacheCreation: 0 },
  'gpt-5.4':       { input: 2.50,  output: 15.00,  cacheRead: 0.25,   cacheCreation: 0 },
  'gpt-5.4-mini':  { input: 0.75,  output: 4.50,   cacheRead: 0.075,  cacheCreation: 0 },
  'gpt-5.3-codex': { input: 1.75,  output: 14.00,  cacheRead: 0.175,  cacheCreation: 0 },
  'gpt-5.2':       { input: 1.75,  output: 14.00,  cacheRead: 0.175,  cacheCreation: 0 },

  'grok-4.5':       { input: 2.00, output: 6.00, cacheRead: 0.50, cacheCreation: 0, cacheCreationBilling: 'not-separately-reported', longContext: GROK_45_LONG_CONTEXT },
  'grok-4.6':       { input: 2.00, output: 6.00, cacheRead: 0.50, cacheCreation: 0, cacheCreationBilling: 'not-separately-reported', longContext: GROK_45_LONG_CONTEXT },

  'or:deepseek/deepseek-v4-pro':    { input: 0.435,  output: 0.87,  cacheRead: 0.10,  cacheCreation: 0 },
  'or:deepseek/deepseek-v4-flash':  { input: 0.14,   output: 0.28,  cacheRead: 0.04,  cacheCreation: 0 },
  'or:moonshotai/kimi-k2.6':        { input: 0.7448, output: 4.655, cacheRead: 0,     cacheCreation: 0 },
  'or:moonshotai/kimi-k2-thinking': { input: 0.60,   output: 2.50,  cacheRead: 0,     cacheCreation: 0 },
  'or:moonshotai/kimi-k3':          { input: 3.00,   output: 15.00, cacheRead: 0,     cacheCreation: 0 },
  'or:qwen/qwen3.6-max-preview':    { input: 1.04,   output: 6.24,  cacheRead: 0,     cacheCreation: 0 },
  'or:qwen/qwen3.6-plus':           { input: 0.325,  output: 1.95,  cacheRead: 0,     cacheCreation: 0 },
  'or:minimax/minimax-m2.7':        { input: 0.30,   output: 1.20,  cacheRead: 0.059, cacheCreation: 0 },
  'or:minimax/minimax-m2.5':        { input: 0.15,   output: 1.15,  cacheRead: 0,     cacheCreation: 0 },
  'or:minimax/minimax-m1':          { input: 0.40,   output: 2.20,  cacheRead: 0,     cacheCreation: 0 },
  'or:z-ai/glm-4.7':                { input: 0.38,   output: 1.74,  cacheRead: 0,     cacheCreation: 0 },
  'or:z-ai/glm-4.7-flash':          { input: 0.06,   output: 0.40,  cacheRead: 0,     cacheCreation: 0 },

  'or:anthropic/claude-sonnet-4-5': { input: 3.00,  output: 15.00, cacheRead: 0.30, cacheCreation: 3.75 },
  'or:anthropic/claude-opus-4':     { input: 15.00, output: 75.00, cacheRead: 1.50, cacheCreation: 18.75 },
  'or:anthropic/claude-haiku-4-5':  { input: 1.00,  output: 5.00,  cacheRead: 0.10, cacheCreation: 1.25 },

  'glm-4.7':      { input: 0.60,  output: 2.20,  cacheRead: 0.11, cacheCreation: 0.60 },
  'glm-4.5-air':  { input: 0.20,  output: 1.10,  cacheRead: 0.03, cacheCreation: 0.20 },
  'glm-5.1':      { input: 1.40,  output: 4.40,  cacheRead: 0.26, cacheCreation: 1.40 },
  'glm-5.2':      { input: 1.40,  output: 4.40,  cacheRead: 0.26, cacheCreation: 1.40 },
  'glm-5.3':      { input: 1.40,  output: 4.40,  cacheRead: 0.26, cacheCreation: 1.40 },
  'glm-5-turbo':  { input: 1.20,  output: 4.00,  cacheRead: 0.24, cacheCreation: 1.20 },

  'minimax-m2.7':           { input: 0.30, output: 1.20, cacheRead: 0.06, cacheCreation: 0.375 },
  'minimax-m2.7-highspeed': { input: 0.60, output: 2.40, cacheRead: 0.06, cacheCreation: 0.375 },
  'minimax-m2.5':           { input: 0.30, output: 1.20, cacheRead: 0.03, cacheCreation: 0.375 },
  'minimax-m2.5-highspeed': { input: 0.60, output: 2.40, cacheRead: 0.03, cacheCreation: 0.375 },
  'minimax-m3':             { input: 0.60, output: 2.40, cacheRead: 0.12, cacheCreation: 0.375 },
  'm2-her':                 { input: 0.30, output: 1.20, cacheRead: 0,    cacheCreation: 0     },


  'deepseek-chat':       { input: 0.27,    output: 1.10,  cacheRead: 0.07,    cacheCreation: 0 },
  'deepseek-reasoner':   { input: 0.55,    output: 2.19,  cacheRead: 0.14,    cacheCreation: 0 },
  'deepseek-v4-flash':   { input: 0.14,    output: 0.28,  cacheRead: 0.0028,  cacheCreation: 0 },
  'deepseek-v4-pro':     { input: 0.435,   output: 0.87,  cacheRead: 0.003625, cacheCreation: 0 },

  'qwen3-max':         { input: 0.40,  output: 1.20,  cacheRead: 0,     cacheCreation: 0 },
  'qwen3-coder-plus':  { input: 1.00,  output: 5.00,  cacheRead: 0,     cacheCreation: 0 },

  'minimax-m2':        { input: 0.30,  output: 1.20,  cacheRead: 0.06, cacheCreation: 0.375 },

  'kimi-k2.6':         { input: 0.95,  output: 4.00,  cacheRead: 0.16,  cacheCreation: 0 },
  'kimi-k3':           { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheCreation: 0 },

  'gemini-2.5-flash-lite-preview-09-2025': { input: 0.10, output: 0.40, cacheRead: 0.01, cacheCreation: 0 },


  'composer-2.5':     { input: 1.25, output: 10.00, cacheRead: 0.125, cacheCreation: 0, cacheCreationBilling: 'not-separately-reported' },
  'gemini-3.7-flash': { input: 0.30, output: 2.50, cacheRead: 0.03, cacheCreation: 0 },

  'kimi-for-coding': { input: 0.95, output: 4.00, cacheRead: 0.19, cacheCreation: 0 },
  'kimi-k2.7-code':  { input: 0.95, output: 4.00, cacheRead: 0.19, cacheCreation: 0 },
};

export const CURSOR_MODEL_PRICING: Record<string, ModelPricingEntry> = {
  'composer-2.5':     MODEL_PRICING['composer-2.5'],
  'claude-fable-5':   MODEL_PRICING['claude-fable-5'],
  'claude-opus-5':    MODEL_PRICING['claude-opus-5'],
  'claude-opus-4-8':  MODEL_PRICING['claude-opus-4-8'],
  'claude-sonnet-5':  MODEL_PRICING['claude-sonnet-5'],
  'gpt-5.6-sol':      MODEL_PRICING['gpt-5.6-sol'],
  'gpt-5.6-terra':    MODEL_PRICING['gpt-5.6-terra'],
  'gpt-5.5':          MODEL_PRICING['gpt-5.5'],
  'grok-4.6':         MODEL_PRICING['grok-4.6'],
  'grok-4.5':         MODEL_PRICING['grok-4.5'],
  'gemini-3.7-flash': MODEL_PRICING['gemini-3.7-flash'],
};

const KIMI_MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreation: number }> = {
  'moonshot-v1-8k':    { input: 0.12,   output: 0.12,   cacheRead: 0, cacheCreation: 0 },
  'moonshot-v1-32k':   { input: 0.24,   output: 0.24,   cacheRead: 0, cacheCreation: 0 },
  'moonshot-v1-128k':  { input: 0.81,   output: 0.81,   cacheRead: 0, cacheCreation: 0 },
  'kimi-k2-instruct':  { input: 0.7448, output: 4.655,  cacheRead: 0, cacheCreation: 0 },
  'kimi-k3':           { input: 3.00,   output: 15.00,  cacheRead: 0.30, cacheCreation: 0 },
};

export const PRESET_MODEL_PRICING: Record<
  string,
  Record<string, { input: number; output: number; cacheRead: number; cacheCreation: number }>
> = {
  kimi: KIMI_MODEL_PRICING,
  'kimi-cn': KIMI_MODEL_PRICING,
  qwen: {
    'qwen-plus':         { input: 0.40,   output: 1.20,   cacheRead: 0, cacheCreation: 0 },
    'qwen-turbo':        { input: 0.20,   output: 0.60,   cacheRead: 0, cacheCreation: 0 },
    'qwen-max':          { input: 2.40,   output: 9.60,   cacheRead: 0, cacheCreation: 0 },
    'qwen3-235b-a22b':   { input: 0.325,  output: 1.95,   cacheRead: 0, cacheCreation: 0 },
    'qwen3-32b':         { input: 0.20,   output: 0.60,   cacheRead: 0, cacheCreation: 0 },
  },
  deepseek: {
    'deepseek-chat':     { input: 0.27,   output: 1.10,   cacheRead: 0.07, cacheCreation: 0 },
    'deepseek-reasoner': { input: 0.55,   output: 2.19,   cacheRead: 0.14, cacheCreation: 0 },
    'deepseek-v3':       { input: 0.27,   output: 1.10,   cacheRead: 0.07, cacheCreation: 0 },
    'deepseek-r1':       { input: 0.55,   output: 2.19,   cacheRead: 0.14, cacheCreation: 0 },
  },
  minimax: {
    'MiniMax-Text-01':   { input: 0.40,   output: 2.20,   cacheRead: 0, cacheCreation: 0 },
    'abab6.5s-chat':     { input: 0.10,   output: 0.10,   cacheRead: 0, cacheCreation: 0 },
    'abab6.5g-chat':     { input: 0.15,   output: 0.15,   cacheRead: 0, cacheCreation: 0 },
    'minimax-m2':        { input: 0.30,   output: 1.20,   cacheRead: 0.059, cacheCreation: 0 },
    'MiniMax-M3':        { input: 0.60,   output: 2.40,   cacheRead: 0.12,  cacheCreation: 0 },
  },
};


export function getModelContextWindow(model: string): number | undefined {
  return getContextWindow(model);
}

const WEB_SEARCH_COST_PER_REQUEST = 0.01; // $10 per 1,000 searches

export const PRICING_VERSION = '2026-07-24';

export interface PricingSnapshot {
  pricingVersion: string;
  model: string;
  entry: ModelPricingEntry | null;
}

function resolveModelPricing(model: string): ModelPricingEntry | null {
  const normalizedModel = model.toLowerCase();
  const direct = MODEL_PRICING[normalizedModel];
  if (direct) return direct;
  if (normalizedModel.includes('opus')) return MODEL_PRICING['opus'];
  if (normalizedModel.includes('haiku')) return MODEL_PRICING['haiku'];
  if (normalizedModel.includes('sonnet') || normalizedModel.includes('claude')) {
    return MODEL_PRICING['sonnet'];
  }
  return null;
}

export function getPricingSnapshot(model: string): PricingSnapshot {
  const entry = resolveModelPricing(model);
  return {
    pricingVersion: PRICING_VERSION,
    model,
    entry: entry ? { ...entry } : null,
  };
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens?: number,
  cacheCreationTokens?: number,
  webSearchRequests?: number,
  opts?: {
    perRequestInput?: boolean;
  },
): number {
  const pricing = resolveModelPricing(model)
    ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

  const lc = pricing.longContext;
  const longContextActive =
    lc !== undefined && opts?.perRequestInput === true && inputTokens > lc.thresholdTokens;
  const inputMult = longContextActive ? lc.inputMultiplier : 1;
  const outputMult = longContextActive ? lc.outputMultiplier : 1;

  let inputCost: number;
  if (cacheReadTokens !== undefined || cacheCreationTokens !== undefined) {
    const pureInput = inputTokens - (cacheReadTokens || 0) - (cacheCreationTokens || 0);
    inputCost = (pureInput / 1_000_000) * pricing.input
      + ((cacheReadTokens || 0) / 1_000_000) * pricing.cacheRead
      + ((cacheCreationTokens || 0) / 1_000_000) * pricing.cacheCreation;
  } else {
    inputCost = (inputTokens / 1_000_000) * pricing.input;
  }
  inputCost *= inputMult;

  const outputCost = (outputTokens / 1_000_000) * pricing.output * outputMult;
  const webCost = (webSearchRequests || 0) * WEB_SEARCH_COST_PER_REQUEST;

  return Math.round((inputCost + outputCost + webCost) * 1_000_000) / 1_000_000;
}

export function hasKnownPricing(model: string): boolean {
  const normalizedModel = model.toLowerCase();
  if (MODEL_PRICING[normalizedModel]) return true;
  if (
    normalizedModel.includes('opus') ||
    normalizedModel.includes('haiku') ||
    normalizedModel.includes('sonnet') ||
    normalizedModel.includes('claude')
  ) {
    return true;
  }
  return false;
}

export function formatCost(costUsd: number): string {
  if (costUsd < 0.01) {
    return `$${costUsd.toFixed(4)}`;
  }
  return `$${costUsd.toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return String(tokens);
}

export interface PricingCalculateInput {
  runtime: OrchestratorRuntime;
  provider: OrchestratorProvider;
  model: string;
  presetId?: OpenAiCompatiblePreset | string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export function pricingCalculate(
  input: PricingCalculateInput,
): { costUsd: number | null } {
  const { runtime, provider, model, presetId, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = input;

  if (runtime === 'lion-sdk' && (provider === 'ollama' || provider === 'lmstudio')) {
    return { costUsd: 0 };
  }

  if (provider === 'openai-compatible' && presetId) {
    if (presetId === 'custom') {
      return { costUsd: null };
    }
    const presetTable = PRESET_MODEL_PRICING[presetId];
    if (presetTable) {
      const presetPricing = presetTable[model];
      if (presetPricing) {
        let inputCost: number;
        if (cacheReadTokens !== undefined || cacheCreationTokens !== undefined) {
          const pureInput = inputTokens - (cacheReadTokens || 0) - (cacheCreationTokens || 0);
          inputCost = (pureInput / 1_000_000) * presetPricing.input
            + ((cacheReadTokens || 0) / 1_000_000) * presetPricing.cacheRead
            + ((cacheCreationTokens || 0) / 1_000_000) * presetPricing.cacheCreation;
        } else {
          inputCost = (inputTokens / 1_000_000) * presetPricing.input;
        }
        const outputCost = (outputTokens / 1_000_000) * presetPricing.output;
        const costUsd = Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
        return { costUsd };
      }
    }
    return { costUsd: null };
  }

  if (runtime === 'lion-sdk' && provider === 'vertex-ai') {
    return { costUsd: null };
  }

  const costUsd = calculateCost(model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens);
  return { costUsd };
}
