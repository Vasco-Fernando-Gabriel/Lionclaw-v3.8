import type { CliAgenticResponse, CliStreamCallbacks } from '../agent-runtime/cli-agentic/contract';
import type {
  GrokAcpSessionUpdate,
  GrokAcpUsage,
  GrokModelUsage,
} from './types';

export interface GrokAcpResponse extends CliAgenticResponse {
  usage: GrokAcpUsage;
  metadata?: {
    modelId?: string;
    reasoningTokens?: number;
    modelCalls?: number;
    apiDurationMs?: number;
    costUsdTicks?: number;
    numTurns?: number;
    modelUsage?: Record<string, GrokModelUsage>;
    rawUsage?: Partial<Omit<GrokAcpUsage, 'reported' | 'modelUsage'>>;
  };
}

export interface GrokAcpAccumulator {
  content: string;
  toolUses: number;
  toolNameById: Map<string, string>;
  toolInputById: Map<string, unknown>;
}

export function createGrokAccumulator(): GrokAcpAccumulator {
  return {
    content: '',
    toolUses: 0,
    toolNameById: new Map(),
    toolInputById: new Map(),
  };
}

function resolveMcpDisplayName(base: string, ...candidates: unknown[]): string {
  if (base !== 'use_tool') return base;
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const tool = typeof record['tool_name'] === 'string' && record['tool_name'].length > 0
      ? record['tool_name']
      : undefined;
    if (!tool) continue;
    const server = typeof record['server_name'] === 'string' && record['server_name'].length > 0
      ? record['server_name']
      : undefined;
    return server ? `${server}/${tool}` : tool;
  }
  return base;
}

function textContent(content: GrokAcpSessionUpdate['content']): string | undefined {
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => typeof part.text === 'string' ? part.text : '')
      .join('');
    return joined || undefined;
  }
  return typeof content?.text === 'string' ? content.text : undefined;
}

export function translateGrokSessionUpdate(
  update: GrokAcpSessionUpdate,
  accumulator: GrokAcpAccumulator,
  callbacks?: CliStreamCallbacks,
  onUnknown?: (update: GrokAcpSessionUpdate) => void,
): void {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = textContent(update.content);
      if (text) {
        accumulator.content += text;
        callbacks?.onText?.(text);
      }
      return;
    }
    case 'agent_thought_chunk': {
      const text = textContent(update.content);
      if (text) callbacks?.onThinking?.(text);
      return;
    }
    case 'tool_call': {
      const name = resolveMcpDisplayName(update.title ?? update.kind ?? 'tool', update.rawInput);
      if (update.toolCallId) {
        accumulator.toolNameById.set(update.toolCallId, name);
        if (update.rawInput !== undefined) accumulator.toolInputById.set(update.toolCallId, update.rawInput);
      }
      accumulator.toolUses += 1;
      callbacks?.onToolUse?.(name, update.toolCallId);
      return;
    }
    case 'tool_call_update': {
      if (update.toolCallId && update.rawInput !== undefined) {
        accumulator.toolInputById.set(update.toolCallId, update.rawInput);
      }
      if (update.status !== 'completed') return;
      const name = (update.toolCallId ? accumulator.toolNameById.get(update.toolCallId) : undefined)
        ?? update.title
        ?? update.kind
        ?? 'tool';
      const input = (update.toolCallId ? accumulator.toolInputById.get(update.toolCallId) : undefined)
        ?? update.rawInput;
      const output = update.rawOutput ?? textContent(update.content);
      const resolved = resolveMcpDisplayName(name, input, output);
      callbacks?.onToolUseComplete?.(resolved, input ?? output, update.toolCallId);
      callbacks?.onToolUseIO?.(resolved, input, output, update.toolCallId);
      return;
    }
    case 'available_commands_update':
    case 'user_message_chunk':
    case 'current_mode_update':
    case 'plan':
      return;
    default:
      onUnknown?.(update);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function unreportedUsage(): GrokAcpUsage {
  return {
    reported: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function rawGrokUsage(meta: Record<string, unknown>, usage: Record<string, unknown>):
Partial<Omit<GrokAcpUsage, 'reported' | 'modelUsage'>> {
  const readNumber = (key: string): number | undefined =>
    finiteNonNegative(usage[key]) ?? finiteNonNegative(meta[key]);
  const readInteger = (key: string): number | undefined =>
    finiteInteger(usage[key]) ?? finiteInteger(meta[key]);
  const output: Partial<Omit<GrokAcpUsage, 'reported' | 'modelUsage'>> = {};
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cacheCreationTokens',
    'providerInputTokens',
    'reasoningTokens',
    'apiDurationMs',
  ] as const) {
    const value = readNumber(key);
    if (value !== undefined) output[key] = value;
  }
  const cacheReadTokens = readNumber('cachedReadTokens') ?? readNumber('cacheReadTokens');
  if (cacheReadTokens !== undefined) output.cacheReadTokens = cacheReadTokens;
  for (const key of ['modelCalls', 'costUsdTicks', 'numTurns'] as const) {
    const value = readInteger(key);
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function parseGrokUsageEnvelope(result: unknown): {
  usage: GrokAcpUsage;
  rawUsage?: Partial<Omit<GrokAcpUsage, 'reported' | 'modelUsage'>>;
} {
  const terminal = record(result);
  const meta = record(terminal['_meta']);
  const wireUsage = record(meta['usage']);
  const rawUsage = rawGrokUsage(meta, wireUsage);
  const explicitVeto = wireUsage['reported'] === false || meta['reported'] === false;
  const cacheCreationTokens = rawUsage.cacheCreationTokens ?? 0;
  if (explicitVeto || cacheCreationTokens > 0) {
    return { usage: unreportedUsage(), rawUsage };
  }
  const canonical = parseGrokReportedUsage(meta, wireUsage);
  return canonical?.reported
    ? { usage: canonical }
    : { usage: unreportedUsage(), rawUsage };
}

function parseGrokReportedUsage(
  meta: Record<string, unknown>,
  usage: Record<string, unknown>,
): GrokAcpUsage | undefined {
  const readCanonical = (...keys: string[]): { present: boolean; value?: number } => {
    for (const source of [usage, meta]) {
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          return { present: true, value: finiteInteger(source[key]) };
        }
      }
    }
    return { present: false };
  };
  const input = readCanonical('inputTokens');
  const output = readCanonical('outputTokens');
  const cacheRead = readCanonical('cachedReadTokens', 'cacheReadTokens');
  const cacheCreation = readCanonical('cacheCreationTokens');
  if ([input, output, cacheRead, cacheCreation].some(value => value.present && value.value === undefined)) {
    return undefined;
  }
  const inputTokens = input.value ?? 0;
  const outputTokens = output.value ?? 0;
  const cacheReadTokens = cacheRead.value ?? 0;
  const cacheCreationTokens = cacheCreation.value ?? 0;
  if (cacheReadTokens > inputTokens || cacheCreationTokens > inputTokens - cacheReadTokens) {
    return undefined;
  }
  const read = (key: string): number | undefined =>
    finiteNonNegative(usage[key]) ?? finiteNonNegative(meta[key]);
  const explicitlyComplete = usage['reported'] === true || meta['reported'] === true;
  const reported = explicitlyComplete || (inputTokens > 0 && outputTokens > 0);
  const costUsdTicks = finiteInteger(usage['costUsdTicks']);
  const modelUsage = parseModelUsage(usage['modelUsage']);
  return {
    reported,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    ...(read('providerInputTokens') !== undefined ? { providerInputTokens: read('providerInputTokens') } : {}),
    ...(read('reasoningTokens') !== undefined ? { reasoningTokens: read('reasoningTokens') } : {}),
    ...(finiteInteger(usage['modelCalls']) !== undefined ? { modelCalls: finiteInteger(usage['modelCalls']) } : {}),
    ...(finiteNonNegative(usage['apiDurationMs']) !== undefined ? { apiDurationMs: finiteNonNegative(usage['apiDurationMs']) } : {}),
    ...(costUsdTicks !== undefined ? { costUsdTicks } : {}),
    ...(finiteInteger(usage['numTurns']) !== undefined ? { numTurns: finiteInteger(usage['numTurns']) } : {}),
    ...(modelUsage !== undefined ? { modelUsage } : {}),
  };
}

function parseModelUsage(value: unknown): Record<string, GrokModelUsage> | undefined {
  const input = record(value);
  const output: Record<string, GrokModelUsage> = {};
  for (const [model, raw] of Object.entries(input)) {
    const usage = record(raw);
    const inputTokens = finiteInteger(usage['inputTokens']);
    const outputTokens = finiteInteger(usage['outputTokens']);
    const cachedReadTokens = finiteInteger(usage['cachedReadTokens']);
    const reasoningTokens = finiteInteger(usage['reasoningTokens']);
    if (
      inputTokens === undefined
      || outputTokens === undefined
      || cachedReadTokens === undefined
      || reasoningTokens === undefined
    ) {
      return undefined;
    }
    output[model] = {
      inputTokens,
      outputTokens,
      cachedReadTokens,
      reasoningTokens,
      ...(finiteInteger(usage['modelCalls']) !== undefined ? { modelCalls: finiteInteger(usage['modelCalls']) } : {}),
      ...(finiteInteger(usage['costUsdTicks']) !== undefined ? { costUsdTicks: finiteInteger(usage['costUsdTicks']) } : {}),
    };
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function parseGrokUsage(result: unknown): GrokAcpUsage {
  return parseGrokUsageEnvelope(result).usage;
}

export type GrokTurnOutcome = 'completed' | 'cancelled' | 'failed';

export function grokStopReasonOutcome(stopReason: unknown): GrokTurnOutcome {
  switch (stopReason) {
    case 'end_turn':
    case 'stop':
    case 'completed':
      return 'completed';
    case 'cancelled':
    case 'interrupted':
      return 'cancelled';
    case 'max_tokens':
    case 'max_steps':
    case 'refusal':
    case 'error':
      return 'failed';
    default:
      return 'failed';
  }
}

export function finalizeGrokResponse(
  accumulator: GrokAcpAccumulator,
  outcome: GrokTurnOutcome,
  terminal: unknown,
): GrokAcpResponse {
  const terminalRecord = record(terminal);
  const meta = record(terminalRecord['_meta']);
  const parsedUsage = parseGrokUsageEnvelope(terminal);
  const usage = parsedUsage.usage;
  const modelId = typeof meta['modelId'] === 'string' ? meta['modelId'] : undefined;
  return {
    content: accumulator.content,
    usage,
    toolUses: accumulator.toolUses,
    status: outcome === 'cancelled'
      ? 'cancelled'
      : outcome === 'failed'
        ? 'max_steps_reached'
        : 'finished',
    metadata: {
      ...(modelId ? { modelId } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      ...(usage.modelCalls !== undefined ? { modelCalls: usage.modelCalls } : {}),
      ...(usage.apiDurationMs !== undefined ? { apiDurationMs: usage.apiDurationMs } : {}),
      ...(usage.costUsdTicks !== undefined ? { costUsdTicks: usage.costUsdTicks } : {}),
      ...(usage.numTurns !== undefined ? { numTurns: usage.numTurns } : {}),
      ...(usage.modelUsage !== undefined ? { modelUsage: usage.modelUsage } : {}),
      ...(parsedUsage.rawUsage !== undefined ? { rawUsage: parsedUsage.rawUsage } : {}),
    },
  };
}
