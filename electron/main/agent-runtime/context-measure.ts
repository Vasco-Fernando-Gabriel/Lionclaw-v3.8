export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export type UsageApiShape = 'anthropic' | 'openai-chat' | 'codex';

const EMPTY_USAGE: CanonicalUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

export const IMAGE_TOKEN_COST = 1500;

function toInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function pick(raw: Record<string, unknown>, keys: readonly string[]): number {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  }
  return 0;
}

function pickNested(raw: Record<string, unknown>, parents: readonly string[], keys: readonly string[]): number {
  for (const p of parents) {
    const obj = raw[p];
    if (obj && typeof obj === 'object') {
      const n = pick(obj as Record<string, unknown>, keys);
      if (n > 0) return n;
    }
  }
  return 0;
}

export function normalizeUsage(raw: unknown, shape: UsageApiShape): CanonicalUsage {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_USAGE };
  const r = raw as Record<string, unknown>;

  if (shape === 'anthropic') {
    const input = pick(r, ['input_tokens', 'inputTokens']);
    const cacheRead = pick(r, ['cache_read_input_tokens', 'cacheReadInputTokens', 'cacheReadTokens']);
    const cacheWrite = pick(r, ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cacheCreationTokens']);
    return {
      inputTokens: input,
      outputTokens: pick(r, ['output_tokens', 'outputTokens']),
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: 0,
    };
  }

  if (shape === 'codex') {
    const inputTotal = pick(r, ['input_tokens', 'inputTokens']);
    const cacheRead = pick(r, ['cached_tokens', 'cachedInputTokens', 'cached_input_tokens']);
    return {
      inputTokens: Math.max(0, inputTotal - cacheRead),
      outputTokens: pick(r, ['output_tokens', 'outputTokens']),
      cacheReadTokens: cacheRead,
      cacheWriteTokens: 0,
      reasoningTokens: pick(r, ['reasoning_output_tokens', 'reasoningOutputTokens']),
    };
  }

  const promptTotal = pick(r, ['prompt_tokens', 'promptTokens']);
  const cacheRead =
    pickNested(r, ['prompt_tokens_details', 'promptTokensDetails'], ['cached_tokens', 'cachedTokens']) ||
    pick(r, ['cache_read_input_tokens', 'cacheReadInputTokens', 'cacheReadTokens']);
  const cacheWrite =
    pickNested(r, ['prompt_tokens_details', 'promptTokensDetails'], ['cache_write_tokens', 'cacheWriteTokens']) ||
    pick(r, ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cacheCreationTokens']);
  const reasoning = pickNested(
    r,
    ['output_tokens_details', 'outputTokensDetails', 'completion_tokens_details', 'completionTokensDetails'],
    ['reasoning_tokens', 'reasoningTokens'],
  );
  return {
    inputTokens: Math.max(0, promptTotal - cacheRead - cacheWrite),
    outputTokens: pick(r, ['completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens']),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
  };
}

export function canonicalPromptTokens(u: CanonicalUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

function estimateTextTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

export function estimateRequestTokens(args: {
  systemPrompt?: string;
  messageTexts: readonly string[];
  toolSchemasJson?: string;
  imageCount?: number;
}): number {
  let total = 0;
  if (args.systemPrompt) total += estimateTextTokens(args.systemPrompt);
  for (const t of args.messageTexts) total += estimateTextTokens(t);
  if (args.toolSchemasJson) total += estimateTextTokens(args.toolSchemasJson);
  if (args.imageCount && args.imageCount > 0) total += args.imageCount * IMAGE_TOKEN_COST;
  return total;
}

export function reconcileActiveContext(
  realPromptTokens: number,
  realOutputTokens: number,
  estimateFallback: number,
): number {
  if (realPromptTokens > 0) {
    return Math.max(0, Math.floor(realPromptTokens)) + Math.max(0, Math.floor(realOutputTokens));
  }
  return Math.max(0, Math.floor(estimateFallback));
}

export function estimateTokensRough(text: string): number {
  return estimateTextTokens(text);
}

export const CONTEXT_CALIBRATION_SDK_VERSION = '0.3.257';

export const CLI_PRESET_TOKENS = 7433;
export const CLI_BUILTIN_SCHEMAS_TOKENS = 15000;

export const KIMI_PRESET_TOKENS = 4000;

export const CODEX_PRESET_TOKENS = 5000;

export interface StrongFloorInput {
  systemPrompt?: string;
  systemPromptTokens?: number;
  presetTokens?: number;
  settingsFilesTokens?: number;
  builtinSchemasTokens?: number;
  mcpSchemasJson?: string;
  mcpSchemasTokens?: number;
  agentDefsTokens?: number;
  messageTexts?: readonly string[];
  agenticTokens?: number;
  imageCount?: number;
}

export function estimateStrongFloor(input: StrongFloorInput): number {
  let total = 0;
  if (input.systemPrompt) total += estimateTextTokens(input.systemPrompt);
  if (input.systemPromptTokens) total += Math.max(0, Math.floor(input.systemPromptTokens));
  if (input.presetTokens) total += Math.max(0, Math.floor(input.presetTokens));
  if (input.settingsFilesTokens) total += Math.max(0, Math.floor(input.settingsFilesTokens));
  if (input.builtinSchemasTokens) total += Math.max(0, Math.floor(input.builtinSchemasTokens));
  if (input.mcpSchemasJson) total += estimateTextTokens(input.mcpSchemasJson);
  if (input.mcpSchemasTokens) total += Math.max(0, Math.floor(input.mcpSchemasTokens));
  if (input.agentDefsTokens) total += Math.max(0, Math.floor(input.agentDefsTokens));
  if (input.messageTexts) {
    for (const t of input.messageTexts) total += estimateTextTokens(t);
  }
  if (input.agenticTokens) total += Math.max(0, Math.floor(input.agenticTokens));
  if (input.imageCount && input.imageCount > 0) total += input.imageCount * IMAGE_TOKEN_COST;
  return total;
}

export function estimateAgenticContentTokens(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return estimateTextTokens(value);
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += estimateAgenticContentTokens(item);
    return total;
  }
  if (typeof value === 'object') {
    const block = value as Record<string, unknown>;
    if (block.type === 'image') return IMAGE_TOKEN_COST;
    if (block.type === 'text' && typeof block.text === 'string') {
      return estimateTextTokens(block.text);
    }
    try {
      return estimateTextTokens(JSON.stringify(value) ?? '');
    } catch {
      return 0;
    }
  }
  try {
    return estimateTextTokens(String(value));
  } catch {
    return 0;
  }
}

export function resolveHistoryFence(
  compactedUpToMessageId: number | null | undefined,
  threadResetMessageId: number | null | undefined,
): number | null {
  const a = typeof compactedUpToMessageId === 'number' ? compactedUpToMessageId : null;
  const b = typeof threadResetMessageId === 'number' ? threadResetMessageId : null;
  if (a === null && b === null) return null;
  return Math.max(a ?? Number.MIN_SAFE_INTEGER, b ?? Number.MIN_SAFE_INTEGER);
}

export interface CompositionStaticTokens {
  settingsFilesTokens: number;
  mcpSchemasTokens: number;
  agentDefsTokens: number;
}

export interface CompositionSignatureParts {
  runtimeKey: string;
  sdkVersion: string;
  mcpServerIds: readonly string[];
  mode: string;
  capabilityKey: string;
  systemPromptLength: number;
  agentIds: readonly string[];
}

export function computeCompositionSignature(parts: CompositionSignatureParts): string {
  return [
    parts.runtimeKey,
    parts.sdkVersion,
    parts.mode,
    parts.capabilityKey,
    String(parts.systemPromptLength),
    [...parts.mcpServerIds].sort().join(','),
    [...parts.agentIds].sort().join(','),
  ].join('|');
}

const COMPOSITION_CACHE_MAX = 32;
const compositionCache = new Map<string, CompositionStaticTokens>();
let compositionCacheHits = 0;
let compositionCacheMisses = 0;

export function getOrComputeCompositionStatic(
  signature: string,
  compute: () => CompositionStaticTokens,
): CompositionStaticTokens {
  const hit = compositionCache.get(signature);
  if (hit) {
    compositionCacheHits += 1;
    return hit;
  }
  compositionCacheMisses += 1;
  const value = compute();
  if (compositionCache.size >= COMPOSITION_CACHE_MAX) {
    const oldest = compositionCache.keys().next().value;
    if (oldest !== undefined) compositionCache.delete(oldest);
  }
  compositionCache.set(signature, value);
  return value;
}

export function __clearCompositionCacheForTests(): void {
  compositionCache.clear();
  compositionCacheHits = 0;
  compositionCacheMisses = 0;
}

export function __compositionCacheStatsForTests(): { hits: number; misses: number } {
  return { hits: compositionCacheHits, misses: compositionCacheMisses };
}

export { toInt as __toIntForTests };
