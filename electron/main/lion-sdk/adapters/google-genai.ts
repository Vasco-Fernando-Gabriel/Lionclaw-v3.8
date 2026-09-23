import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Content,
  type FunctionCall,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
} from '@google/genai';

import { createLogger } from '../../logger';
import type { NativeToolCall } from '../tool-parser';
import type { LionAdapter, LionChatMessage, LionStreamEvent, LionStreamRequest } from './types';
import { buildGoogleToolConfig } from './google-genai-schema';
import { normalizeGoogleGenAiError } from './google-genai-errors';

const logger = createLogger('lion-adapter-google-genai');

function parseToolArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === 'string' && args.length > 0) {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
    return { _raw: args };
  }
  return {};
}

function looksLikeToolError(content: string): boolean {
  if (!content) return false;
  const trimmed = content.trimStart();
  if (trimmed.startsWith('exit=')) {
    const m = /^exit=(\d+)/.exec(trimmed);
    if (m && m[1] !== '0') return true;
    return false;
  }
  return false;
}

interface ToGeminiContentsResult {
  systemInstruction?: string;
  contents: Content[];
}

function toGeminiContents(messages: LionChatMessage[]): ToGeminiContentsResult {
  const systemParts: string[] = [];
  const contents: Content[] = [];
  let pendingFunctionResponseParts: Part[] = [];

  const flushFunctionResponses = () => {
    if (pendingFunctionResponseParts.length === 0) return;
    contents.push({
      role: 'user',
      parts: pendingFunctionResponseParts,
    });
    pendingFunctionResponseParts = [];
  };

  const toolCallNamesById = new Map<string, string>();

  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string' && m.content.length > 0) {
        systemParts.push(m.content);
      }
      continue;
    }

    if (m.role === 'user') {
      flushFunctionResponses();
      contents.push({
        role: 'user',
        parts: [{ text: m.content ?? '' }],
      });
      continue;
    }

    if (m.role === 'assistant') {
      flushFunctionResponses();
      const parts: Part[] = [];
      const hasText = typeof m.content === 'string' && m.content.length > 0;
      if (hasText) {
        parts.push({ text: m.content });
      }
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          const name = tc.function?.name;
          if (!name) continue;
          const id = tc.id;
          if (id) toolCallNamesById.set(id, name);
          const args = parseToolArgs(tc.function?.arguments);
          const fnCall: FunctionCall = {
            ...(id ? { id } : {}),
            name,
            args,
          };
          const fnPart: Part = { functionCall: fnCall };
          const thoughtSignature = tc.providerMetadata?.googleGenAi?.thoughtSignature;
          if (thoughtSignature) {
            fnPart.thoughtSignature = thoughtSignature;
          }
          parts.push(fnPart);
        }
      }
      if (parts.length === 0) continue;
      contents.push({ role: 'model', parts });
      continue;
    }

    if (m.role === 'tool') {
      const callId = m.tool_call_id ?? '';
      const name = callId ? (toolCallNamesById.get(callId) ?? m.name ?? '') : (m.name ?? '');
      const content = m.content ?? '';
      const responseObj: Record<string, unknown> = looksLikeToolError(content)
        ? { error: content }
        : { output: content };
      const fnResp = {
        ...(callId ? { id: callId } : {}),
        ...(name ? { name } : {}),
        response: responseObj,
      };
      pendingFunctionResponseParts.push({ functionResponse: fnResp });
      continue;
    }
  }

  flushFunctionResponses();

  return {
    systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    contents,
  };
}

function collectToolCallsFromChunk(
  chunk: GenerateContentResponse,
  turnIndex: number,
  startCallIndex: number,
): NativeToolCall[] {
  const out: NativeToolCall[] = [];

  const seen = new Set<FunctionCall>();
  const candidate = chunk.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const fn = part.functionCall;
      if (!fn || !fn.name) continue;
      seen.add(fn);
      const callIndex = startCallIndex + out.length;
      const id = fn.id && fn.id.length > 0 ? fn.id : `gemini_call_${turnIndex}_${callIndex}`;
      const args = fn.args && typeof fn.args === 'object' ? fn.args : {};
      out.push({
        index: callIndex,
        id,
        type: 'function',
        function: {
          name: fn.name,
          arguments: JSON.stringify(args),
        },
        ...(part.thoughtSignature
          ? {
              providerMetadata: {
                googleGenAi: { thoughtSignature: part.thoughtSignature },
              },
            }
          : {}),
      });
    }
  }

  const convenience = chunk.functionCalls;
  if (Array.isArray(convenience)) {
    for (const fn of convenience) {
      if (!fn || !fn.name) continue;
      if (seen.has(fn)) continue;
      const callIndex = startCallIndex + out.length;
      const id = fn.id && fn.id.length > 0 ? fn.id : `gemini_call_${turnIndex}_${callIndex}`;
      const args = fn.args && typeof fn.args === 'object' ? fn.args : {};
      out.push({
        index: callIndex,
        id,
        type: 'function',
        function: {
          name: fn.name,
          arguments: JSON.stringify(args),
        },
      });
    }
  }

  return out;
}

const FATAL_FINISH_REASONS = new Set<string>([
  'SAFETY',
  'RECITATION',
  'LANGUAGE',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'MALFORMED_FUNCTION_CALL',
  'IMAGE_SAFETY',
  'UNEXPECTED_TOOL_CALL',
]);

export interface GoogleGenAiAdapterOptions {
  apiKey: string;
}

export function createGoogleGenAiAdapter(opts: GoogleGenAiAdapterOptions): LionAdapter {
  const ai = new GoogleGenAI({
    vertexai: true,
    apiKey: opts.apiKey,
  });

  let turnIndex = 0;

  const adapter: LionAdapter = {
    name: 'vertex-ai',
    async *streamCompletion(req: LionStreamRequest): AsyncIterable<LionStreamEvent> {
      if (!opts.apiKey || opts.apiKey.length === 0) {
        yield { type: 'error', error: 'Vertex Gemini adapter requer apiKey.' };
        return;
      }

      const localTurn = ++turnIndex;

      const { systemInstruction, contents } = toGeminiContents(req.messages);

      const tools = buildGoogleToolConfig(req.tools);

      const config: GenerateContentConfig = {};
      if (systemInstruction) config.systemInstruction = systemInstruction;
      if (tools) {
        config.tools = tools;
        config.toolConfig = {
          functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
        };
      }
      if (req.abortSignal) {
        config.abortSignal = req.abortSignal;
      }

      let stream: AsyncGenerator<GenerateContentResponse>;
      try {
        stream = await ai.models.generateContentStream({
          model: req.model,
          contents,
          config,
        });
      } catch (e) {
        const normalized = normalizeGoogleGenAiError(e);
        logger.warn({ code: normalized.code, status: normalized.status }, 'Vertex Gemini stream initialization failed');
        yield { type: 'error', error: normalized.userMessage };
        return;
      }

      let anyTextEmitted = false;
      let anyFunctionCall = false;
      let anyErrorEmitted = false;
      let sawFinishReason = false;
      let totalToolCallsEmitted = 0;

      try {
        for await (const chunk of stream) {
          if (req.abortSignal?.aborted) {
            anyErrorEmitted = true;
            yield { type: 'error', error: 'Vertex Gemini: stream abortado' };
            return;
          }

          const blockReason = chunk.promptFeedback?.blockReason;
          if (blockReason) {
            const normalized = normalizeGoogleGenAiError({
              promptFeedback: { blockReason },
            });
            anyErrorEmitted = true;
            yield { type: 'error', error: normalized.userMessage };
            return;
          }

          const textDelta = chunk.text;
          if (typeof textDelta === 'string' && textDelta.length > 0) {
            anyTextEmitted = true;
            yield { type: 'text', delta: textDelta };
          }

          const toolCalls = collectToolCallsFromChunk(chunk, localTurn, totalToolCallsEmitted);
          if (toolCalls.length > 0) {
            anyFunctionCall = true;
            totalToolCallsEmitted += toolCalls.length;
            yield { type: 'tool_call_delta', toolCalls };
          }

          const um = chunk.usageMetadata;
          if (um) {
            const inputTokens = (um.promptTokenCount ?? 0) + (um.toolUsePromptTokenCount ?? 0);
            const outputTokens = (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0);
            if (inputTokens > 0 || outputTokens > 0) {
              yield {
                type: 'usage',
                usage: { inputTokens, outputTokens },
              };
            }
          }

          const candidate = chunk.candidates?.[0];
          const finishReason = candidate?.finishReason;
          if (finishReason) {
            sawFinishReason = true;
            const reasonStr = String(finishReason).toUpperCase();
            if (FATAL_FINISH_REASONS.has(reasonStr)) {
              const normalized = normalizeGoogleGenAiError({
                finishReason: reasonStr,
              });
              anyErrorEmitted = true;
              yield { type: 'error', error: normalized.userMessage };
              return;
            }
          }
        }
      } catch (e) {
        const err = e as Error;
        if (err?.name === 'AbortError' || req.abortSignal?.aborted) {
          anyErrorEmitted = true;
          yield { type: 'error', error: 'Vertex Gemini: stream abortado' };
          return;
        }
        const normalized = normalizeGoogleGenAiError(e);
        logger.warn({ code: normalized.code, status: normalized.status }, 'Vertex Gemini stream iteration failed');
        anyErrorEmitted = true;
        yield { type: 'error', error: normalized.userMessage };
        return;
      }

      if (!anyTextEmitted && !anyFunctionCall && !anyErrorEmitted && !sawFinishReason) {
        yield { type: 'error', error: 'Gemini returned empty response.' };
        return;
      }

      yield { type: 'done' };
    },
  };

  return adapter;
}
