import { deriveMcpGatewayDisplayName } from './mcp-display';
import { emptyResponseExecutionError } from './agent-runtime/llm-error';
import type { AgentExecutionError } from './agent-runtime/llm-error';

export interface StreamMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  toolUses: number;
  apiRequests: number;
}

export interface StreamCallbacks {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolUse?: (toolName: string) => void;
  onToolUseComplete?: (toolName: string, input: unknown) => void;
  onMessageStart?: (usage: { inputBase: number; cacheRead: number; cacheCreation: number }) => void;
  onMessageDelta?: (outputTokens: number) => void;
  onMessageStop?: () => void;
  onResult?: (text: string) => void;
  onRawEvent?: (event: Record<string, unknown>) => void;
  shouldAbort?: () => boolean;
}

export interface StreamModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

export interface StreamProcessorResult {
  output: string;
  metrics: StreamMetrics;
  accumulatedText: string;
  textBlocks: string[];
  totalCostUsd?: number;
  modelUsage?: Record<string, StreamModelUsage>;
  sessionIds?: string[];
  resultError?: AgentExecutionError;
}

export async function processAgentStream(
  stream: AsyncIterable<Record<string, unknown>>,
  callbacks: StreamCallbacks,
): Promise<StreamProcessorResult> {
  const metrics: StreamMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolUses: 0,
    apiRequests: 0,
  };
  let output = '';
  let accumulatedText = '';
  let currentBlock = '';
  const textBlocks: string[] = [];
  let currentToolName: string | null = null;
  let currentToolInputJson = '';

  interface RequestUsage {
    inputBase: number;
    cacheRead: number;
    cacheCreation: number;
    output: number;
  }
  const usageByRequest = new Map<string, RequestUsage>();
  const startClaimedIds = new Set<string>();
  let currentRequestKey: string | null = null;
  let syntheticSeq = 0;

  const entryFor = (key: string): RequestUsage => {
    let entry = usageByRequest.get(key);
    if (!entry) {
      entry = { inputBase: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
      usageByRequest.set(key, entry);
    }
    return entry;
  };
  const maxMergeUsage = (key: string, usage: Record<string, number>): void => {
    const entry = entryFor(key);
    entry.inputBase = Math.max(entry.inputBase, usage['input_tokens'] ?? 0);
    entry.cacheRead = Math.max(entry.cacheRead, usage['cache_read_input_tokens'] ?? 0);
    entry.cacheCreation = Math.max(entry.cacheCreation, usage['cache_creation_input_tokens'] ?? 0);
    entry.output = Math.max(entry.output, usage['output_tokens'] ?? 0);
  };

  let resultFloor: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  } | null = null;
  let totalCostUsd: number | undefined;
  let modelUsage: Record<string, StreamModelUsage> | undefined;
  const sessionIds = new Set<string>();
  const captureSessionId = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) sessionIds.add(value);
  };

  for await (const msg of stream) {
    if (callbacks.shouldAbort?.()) break;

    if ((msg as { type: string }).type === 'stream_event') {
      const event = (msg as { event: Record<string, unknown> }).event;

      if (event.type === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown>;
        if (delta.type === 'text_delta') {
          const text = delta.text as string;
          accumulatedText += text;
          currentBlock += text;
          callbacks.onText?.(text);
        } else if (delta.type === 'thinking_delta') callbacks.onThinking?.(delta.thinking as string);
        else if (delta.type === 'input_json_delta') {
          const partial = delta.partial_json as string;
          if (partial) currentToolInputJson += partial;
        }
      }

      if (event.type === 'content_block_start') {
        const block = event.content_block as Record<string, unknown>;
        if (block?.type === 'tool_use') {
          metrics.toolUses++;
          currentToolName = block.name as string;
          currentToolInputJson = '';
          const initialInput = block.input;
          if (initialInput && typeof initialInput === 'object' && Object.keys(initialInput as object).length > 0) {
            currentToolInputJson = JSON.stringify(initialInput);
          }
          callbacks.onToolUse?.(block.name as string);
        }
      }

      if (event.type === 'content_block_stop') {
        if (currentBlock) {
          textBlocks.push(currentBlock);
          currentBlock = '';
        }
        if (currentToolName !== null) {
          let parsedInput: unknown = null;
          if (currentToolInputJson) {
            try {
              parsedInput = JSON.parse(currentToolInputJson);
            } catch {
              const match = currentToolInputJson.match(/\{[\s\S]*\}$/);
              if (match) {
                try {
                  parsedInput = JSON.parse(match[0]);
                } catch {
                  parsedInput = null;
                }
              }
            }
          }
          const mappedToolName = deriveMcpGatewayDisplayName(currentToolName, parsedInput) ?? currentToolName;
          callbacks.onToolUseComplete?.(mappedToolName, parsedInput);
          currentToolName = null;
          currentToolInputJson = '';
        }
      }

      if (event.type === 'message_start') {
        metrics.apiRequests++;
        const msgData = event.message as Record<string, unknown> | undefined;
        const rawId = msgData?.['id'];
        const reliableId = typeof rawId === 'string' && rawId.length > 0 && !startClaimedIds.has(rawId) ? rawId : null;
        if (reliableId !== null) startClaimedIds.add(reliableId);
        currentRequestKey = reliableId ?? `synthetic:start:${++syntheticSeq}`;
        entryFor(currentRequestKey);
        const usage = msgData?.usage as Record<string, number> | undefined;
        if (usage) {
          maxMergeUsage(currentRequestKey, usage);
          const inputBase = usage['input_tokens'] ?? 0;
          const cacheRead = usage['cache_read_input_tokens'] ?? 0;
          const cacheCreation = usage['cache_creation_input_tokens'] ?? 0;
          callbacks.onMessageStart?.({ inputBase, cacheRead, cacheCreation });
        }
      }

      if (event.type === 'message_delta') {
        const usage = event.usage as Record<string, number> | undefined;
        if (usage) {
          const out = usage['output_tokens'] ?? 0;
          if (currentRequestKey === null) {
            currentRequestKey = `synthetic:delta:${++syntheticSeq}`;
          }
          const entry = entryFor(currentRequestKey);
          entry.output = Math.max(entry.output, out);
          callbacks.onMessageDelta?.(out);
        }
      }

      if (event.type === 'message_stop') callbacks.onMessageStop?.();

      callbacks.onRawEvent?.(event);
    }

    if ((msg as { type: string }).type === 'assistant') {
      const message = (msg as Record<string, unknown>)['message'] as Record<string, unknown> | undefined;
      const usage = message?.['usage'] as Record<string, number> | undefined;
      if (usage) {
        const rawId = message?.['id'];
        const key =
          typeof rawId === 'string' && rawId.length > 0
            ? rawId
            : (currentRequestKey ?? `synthetic:assistant:${++syntheticSeq}`);
        maxMergeUsage(key, usage);
      }
    }

    if ((msg as { type: string }).type === 'system') {
      const rec = msg as Record<string, unknown>;
      if (rec['subtype'] === 'init') captureSessionId(rec['session_id']);
    }

    if ((msg as { type: string }).type === 'result') {
      const rec = msg as Record<string, unknown>;
      output = (rec['result'] as string) ?? '';
      const rUsage = rec['usage'] as Record<string, number> | undefined;
      if (rUsage) {
        const rCacheRead = rUsage['cache_read_input_tokens'] || 0;
        const rCacheCreation = rUsage['cache_creation_input_tokens'] || 0;
        const rInput = (rUsage['input_tokens'] || 0) + rCacheRead + rCacheCreation;
        const rOutput = rUsage['output_tokens'] || 0;
        resultFloor = resultFloor
          ? {
              input: Math.max(resultFloor.input, rInput),
              output: Math.max(resultFloor.output, rOutput),
              cacheRead: Math.max(resultFloor.cacheRead, rCacheRead),
              cacheCreation: Math.max(resultFloor.cacheCreation, rCacheCreation),
            }
          : { input: rInput, output: rOutput, cacheRead: rCacheRead, cacheCreation: rCacheCreation };
      }
      const rawCost = rec['total_cost_usd'];
      if (typeof rawCost === 'number' && Number.isFinite(rawCost)) {
        totalCostUsd = rawCost;
      }
      const rawModelUsage = rec['modelUsage'];
      if (rawModelUsage && typeof rawModelUsage === 'object') {
        const parsed: Record<string, StreamModelUsage> = {};
        for (const [model, u] of Object.entries(rawModelUsage as Record<string, unknown>)) {
          if (!u || typeof u !== 'object') continue;
          const fields = u as Record<string, unknown>;
          const num = (k: string): number =>
            typeof fields[k] === 'number' && Number.isFinite(fields[k] as number) ? (fields[k] as number) : 0;
          parsed[model] = {
            inputTokens: num('inputTokens'),
            outputTokens: num('outputTokens'),
            cacheReadInputTokens: num('cacheReadInputTokens'),
            cacheCreationInputTokens: num('cacheCreationInputTokens'),
            costUSD: num('costUSD'),
          };
        }
        if (Object.keys(parsed).length > 0) modelUsage = parsed;
      }
      captureSessionId(rec['session_id']);
      callbacks.onResult?.(output);
    }
  }

  for (const entry of usageByRequest.values()) {
    metrics.inputTokens += entry.inputBase + entry.cacheRead + entry.cacheCreation;
    metrics.cacheReadTokens += entry.cacheRead;
    metrics.cacheCreationTokens += entry.cacheCreation;
    metrics.outputTokens += entry.output;
  }
  if (resultFloor) {
    metrics.inputTokens = Math.max(metrics.inputTokens, resultFloor.input);
    metrics.outputTokens = Math.max(metrics.outputTokens, resultFloor.output);
    metrics.cacheReadTokens = Math.max(metrics.cacheReadTokens, resultFloor.cacheRead);
    metrics.cacheCreationTokens = Math.max(metrics.cacheCreationTokens, resultFloor.cacheCreation);
  }

  if (currentBlock) {
    textBlocks.push(currentBlock);
  }

  if (!output && accumulatedText) {
    output = accumulatedText;
  }

  const aborted = callbacks.shouldAbort?.() === true;
  const resultError = emptyResponseExecutionError({
    content: output,
    toolUses: metrics.toolUses,
    aborted,
  });

  return {
    output,
    metrics,
    accumulatedText,
    textBlocks,
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    ...(modelUsage !== undefined ? { modelUsage } : {}),
    ...(sessionIds.size > 0 ? { sessionIds: Array.from(sessionIds) } : {}),
    ...(resultError !== undefined ? { resultError } : {}),
  };
}
