
import { createLogger } from '../logger';
import {
  parseFencedBlocks,
  parseNativeToolCalls,
  type LionToolUse,
  type NativeToolCall,
} from './tool-parser';
import type { LionAdapter, LionChatMessage, LionStreamEvent } from './adapters/types';
import type { LionToolSchema } from './tool-registry';
import type { LionStreamTranslator } from './stream-translator';
import { estimateTokens } from './compaction/token-estimate';
import { LLM_ERROR_TABLE } from '../agent-runtime/llm-error';

const logger = createLogger('lion-sdk-runtime');

export const MAX_TOOL_TURNS = 30;
export const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

export interface ToolDispatchResult {
  content: string;
  isError?: boolean;
  displayName?: string;
}

export type LionToolDispatcher = (call: LionToolUse) => Promise<ToolDispatchResult>;

export interface RunLionLoopOptions {
  adapter: LionAdapter;
  model: string;
  initialMessages: LionChatMessage[];
  tools: LionToolSchema[];
  dispatcher: LionToolDispatcher;
  translator: LionStreamTranslator;
  abortSignal?: AbortSignal;
  maxToolTurns?: number;
  maxConsecutiveToolErrors?: number;
  contextWindowTokens?: number;
  compactionThresholdPercent?: number;
  deferTextUntilToolParse?: boolean;
  dropTextWhenToolCalls?: boolean;
}

export interface RunLionLoopResult {
  finalText: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  transcript: LionChatMessage[];
  ok: boolean;
  errorReason?: 'abort' | 'max-turns' | 'max-tool-errors' | 'adapter-error';
  lastContextTokens?: number;
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function displayNameForToolCall(call: LionToolUse): string {
  if (call.name === 'mcp_call') {
    const serverId = stringField(call.input, 'server_id');
    const tool = stringField(call.input, 'tool');
    if (serverId && tool) return `mcp:${serverId}.${tool}`;
  }
  return call.name || 'unknown';
}

function toolUseToNativeToolCall(call: LionToolUse, original?: NativeToolCall): NativeToolCall {
  const originalArgs = original?.function?.arguments;
  return {
    ...(typeof original?.index === 'number' ? { index: original.index } : {}),
    id: call.id,
    type: 'function',
    function: {
      name: original?.function?.name || call.name || 'unknown',
      arguments: originalArgs !== undefined ? originalArgs : JSON.stringify(call.input ?? {}),
    },
    ...(original?.providerMetadata ? { providerMetadata: original.providerMetadata } : {}),
  };
}

export async function runLionLoop(opts: RunLionLoopOptions): Promise<RunLionLoopResult> {
  const maxToolTurns = opts.maxToolTurns ?? MAX_TOOL_TURNS;
  const maxConsecutiveToolErrors = opts.maxConsecutiveToolErrors ?? MAX_CONSECUTIVE_TOOL_ERRORS;
  const transcript: LionChatMessage[] = [...opts.initialMessages];

  let finalText = '';
  let aggregateUsage = { inputTokens: 0, outputTokens: 0 };
  let lastContextTokens = 0;
  let toolTurn = 0;
  let consecutiveToolErrors = 0;

  while (true) {
    if (opts.abortSignal?.aborted) {
      opts.translator.emitError(new Error('Lion-SDK: requisicao abortada.'));
      return finalize(false, 'abort');
    }

    let assistantText = '';
    let assistantReasoningContent = '';
    let nativeCallsAccum: NativeToolCall[] = [];
    let turnUsage = { inputTokens: 0, outputTokens: 0 };
    let adapterErrored: string | null = null;
    const nativeToolCallsByParsedId = new Map<string, NativeToolCall>();

    emitPromptContextEstimate();

    try {
      for await (const ev of opts.adapter.streamCompletion({
        model: opts.model,
        messages: transcript,
        tools: opts.tools,
        abortSignal: opts.abortSignal,
      })) {
        if (opts.abortSignal?.aborted) {
          opts.translator.emitError(new Error('Lion-SDK: requisicao abortada.'));
          return finalize(false, 'abort');
        }
        handleEvent(ev);
      }
    } catch (e) {
      adapterErrored = (e as Error).message;
    }

    function handleEvent(ev: LionStreamEvent): void {
      switch (ev.type) {
        case 'text':
          assistantText += ev.delta;
          if (!opts.deferTextUntilToolParse) {
            opts.translator.emitText(ev.delta);
          }
          break;
        case 'reasoning':
          assistantReasoningContent += ev.delta;
          break;
        case 'tool_call_delta':
          nativeCallsAccum.push(...ev.toolCalls);
          break;
        case 'content_block':
          for (const b of ev.blocks) {
            if (b.type === 'text' && typeof b.text === 'string') {
              assistantText += b.text;
              if (!opts.deferTextUntilToolParse) {
                opts.translator.emitText(b.text);
              }
            }
            if ((b.type === 'reasoning' || b.type === 'thinking') && typeof b.text === 'string') {
              assistantReasoningContent += b.text;
            }
            if (b.type === 'tool_use' && typeof b.name === 'string') {
              nativeCallsAccum.push({
                id: b.id,
                type: 'function',
                function: {
                  name: b.name,
                  arguments: (b.input && typeof b.input === 'object') ? (b.input as Record<string, unknown>) : {},
                },
              });
            }
          }
          break;
        case 'usage':
          turnUsage.inputTokens += ev.usage.inputTokens;
          turnUsage.outputTokens += ev.usage.outputTokens;
          aggregateUsage.inputTokens += ev.usage.inputTokens;
          aggregateUsage.outputTokens += ev.usage.outputTokens;
          opts.translator.emitUsage({
            inputTokens: aggregateUsage.inputTokens,
            outputTokens: aggregateUsage.outputTokens,
          });
          lastContextTokens = turnUsage.inputTokens + turnUsage.outputTokens;
          emitPromptContextUsage(turnUsage.inputTokens + turnUsage.outputTokens, 'provider');
          break;
        case 'error':
          adapterErrored = ev.error;
          break;
        case 'done':
          break;
      }
    }


    if (adapterErrored) {
      logger.warn({
        adapter: opts.adapter.name,
        model: opts.model,
        error: adapterErrored,
        toolTurn,
        transcriptLength: transcript.length,
      }, 'Lion-SDK adapter returned error');
      opts.translator.emitError(new Error(adapterErrored));
      return finalize(false, 'adapter-error');
    }

    let calls: LionToolUse[] = [];
    if (nativeCallsAccum.length > 0) {
      const parsedNativeCalls = parseNativeToolCalls(nativeCallsAccum);
      parsedNativeCalls.forEach((call, index) => {
        nativeToolCallsByParsedId.set(
          call.id,
          toolUseToNativeToolCall(call, nativeCallsAccum[index]),
        );
      });
      calls.push(...parsedNativeCalls);
    }
    let cleanedText = assistantText;
    if (/```lion_tool_use/i.test(assistantText)) {
      const fenced = parseFencedBlocks(assistantText);
      cleanedText = fenced.remainingText;
      calls.push(...fenced.calls);
    }

    const transcriptAssistantContent = calls.length > 0 && opts.dropTextWhenToolCalls
      ? ''
      : cleanedText;
    transcript.push({
      role: 'assistant',
      content: transcriptAssistantContent,
      ...(assistantReasoningContent.length > 0 ? { reasoning_content: assistantReasoningContent } : {}),
      tool_calls: calls.length > 0
        ? calls.map((call) => nativeToolCallsByParsedId.get(call.id) ?? toolUseToNativeToolCall(call))
        : undefined,
    });

    if (calls.length === 0) {
      finalText = cleanedText;
      if (opts.deferTextUntilToolParse) {
        opts.translator.emitText(cleanedText);
      }
      if (
        cleanedText.trim() === '' &&
        toolTurn === 0 &&
        assistantReasoningContent.length === 0
      ) {
        opts.translator.emitError(
          new Error(`[LLM-EMPTY] ${LLM_ERROR_TABLE['LLM-EMPTY'].userMessage} (model ${opts.model})`),
        );
      }
      opts.translator.emitDone();
      return finalize(true);
    }

    toolTurn++;
    if (toolTurn > maxToolTurns) {
      opts.translator.emitError(new Error(`Lion-SDK: limite de ${maxToolTurns} rounds de tool atingido.`));
      return finalize(false, 'max-turns');
    }

    for (const call of calls) {
      const displayName = displayNameForToolCall(call);
      opts.translator.emitToolCall(call.id, displayName, call.input);

      if (call.isError) {
        const errMsg = call.errorMessage ?? 'tool call invalida';
        opts.translator.emitToolResult(call.id, displayName, errMsg, true);
        transcript.push({
          role: 'tool',
          content: errMsg,
          tool_call_id: call.id,
          name: displayName,
        });
        consecutiveToolErrors++;
        if (consecutiveToolErrors >= maxConsecutiveToolErrors) {
          opts.translator.emitError(new Error(`Lion-SDK: ${maxConsecutiveToolErrors} erros consecutivos de tool. Abortando.`));
          return finalize(false, 'max-tool-errors');
        }
        continue;
      }

      let result: ToolDispatchResult;
      try {
        result = await opts.dispatcher(call);
      } catch (e) {
        const errMsg = (e as Error).message;
        opts.translator.emitToolResult(call.id, displayName, `Tool dispatch falhou: ${errMsg}`, true);
        transcript.push({
          role: 'tool',
          content: `Tool dispatch falhou: ${errMsg}`,
          tool_call_id: call.id,
          name: displayName,
        });
        consecutiveToolErrors++;
        if (consecutiveToolErrors >= maxConsecutiveToolErrors) {
          opts.translator.emitError(new Error(`Lion-SDK: ${maxConsecutiveToolErrors} erros consecutivos de tool. Abortando.`));
          return finalize(false, 'max-tool-errors');
        }
        continue;
      }

      const label = result.displayName ?? displayName;
      opts.translator.emitToolResult(call.id, label, result.content, !!result.isError);
      transcript.push({
        role: 'tool',
        content: result.content,
        tool_call_id: call.id,
        name: label,
      });
      if (result.isError) {
        consecutiveToolErrors++;
        if (consecutiveToolErrors >= maxConsecutiveToolErrors) {
          opts.translator.emitError(new Error(`Lion-SDK: ${maxConsecutiveToolErrors} erros consecutivos de tool. Abortando.`));
          return finalize(false, 'max-tool-errors');
        }
      } else {
        consecutiveToolErrors = 0;
      }
    }
  }

  function finalize(ok: boolean, errorReason?: RunLionLoopResult['errorReason']): RunLionLoopResult {
    return {
      finalText,
      usage: aggregateUsage,
      transcript,
      ok,
      errorReason,
      lastContextTokens,
    };
  }

  function estimateCurrentPromptTokens(): number {
    const messageTokens = transcript.reduce((total, msg) => {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
      const toolCalls = msg.tool_calls ? JSON.stringify(msg.tool_calls) : '';
      const toolName = msg.name ? ` ${msg.name}` : '';
      return total + estimateTokens(`${msg.role}${toolName}\n${content}\n${reasoning}\n${toolCalls}`);
    }, 0);
    const toolSchemaTokens = opts.tools.length > 0
      ? estimateTokens(JSON.stringify(opts.tools))
      : 0;
    return messageTokens + toolSchemaTokens;
  }

  function emitPromptContextEstimate(): void {
    emitPromptContextUsage(estimateCurrentPromptTokens(), 'estimate');
  }

  function emitPromptContextUsage(
    contextTokens: number,
    source: 'estimate' | 'provider',
  ): void {
    const contextWindowTokens = opts.contextWindowTokens;
    if (!contextWindowTokens || contextWindowTokens <= 0) return;
    opts.translator.emitContextUsage({
      contextTokens: Math.max(0, Math.floor(contextTokens)),
      contextWindowTokens,
      compactionThresholdPercent: opts.compactionThresholdPercent ?? 70,
      source,
    });
  }
}

export { logger as lionRuntimeLogger };
