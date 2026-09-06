import { createLogger } from './logger';
import { executeLocalTool, executeToolDispatch } from './local-tool-executor';
import type { LocalLLMProvider, ExternalProvider, LLMProvider } from '../../src/types';
import type { McpServerSpec, McpSessionClient } from './mcp-tool-bridge';

export type { LocalLLMProvider, ExternalProvider, LLMProvider };

const logger = createLogger('local-llm');

const TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeL2(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vec;
  return vec.map((v) => v / magnitude);
}

export async function checkOllamaAvailable(
  baseUrl: string,
  model: string,
  provider: LocalLLMProvider = 'ollama',
  authHeaders?: Record<string, string>,
): Promise<{ available: boolean; models: string[] }> {
  try {
    if (provider === 'ollama') {
      const res = await fetchWithTimeout(`${baseUrl}/api/tags`, { method: 'GET' });
      if (!res.ok) return { available: false, models: [] };
      const json = (await res.json()) as { models: Array<{ name: string }> };
      const models = json.models?.map((m) => m.name) ?? [];
      const available = models.some((m) => m.startsWith(model.split(':')[0]));
      return { available, models };
    } else {
      const res = await fetchWithTimeout(`${baseUrl}/v1/models`, {
        method: 'GET',
        headers: { ...authHeaders },
      });
      if (!res.ok) return { available: false, models: [] };
      const json = (await res.json()) as { data?: Array<{ id: string }> };
      const models = json.data?.map((m) => m.id) ?? [];
      const available = models.some((m) => m === model || m.includes(model));
      return { available, models };
    }
  } catch {
    return { available: false, models: [] };
  }
}

async function tryGenerateEmbedding(
  baseUrl: string,
  model: string,
  text: string,
): Promise<number[] | null> {
  const res = await fetchWithTimeout(`${baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.substring(0, 200)}`);
  }
  const json = (await res.json()) as { embedding?: number[]; error?: string };
  if (json.error) throw new Error(`Ollama error: ${json.error}`);
  if (!Array.isArray(json.embedding)) throw new Error('No embedding in response');
  return normalizeL2(json.embedding);
}

export async function generateEmbedding(
  baseUrl: string,
  model: string,
  text: string,
  retries = 2,
): Promise<number[] | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await tryGenerateEmbedding(baseUrl, model, text);
    } catch (err) {
      const isLastAttempt = attempt === retries;
      if (isLastAttempt) {
        logger.error({ err, model, attempt }, 'Embedding generation failed after retries');
        return null;
      }
      logger.warn({ err, model, attempt }, 'Embedding attempt failed, retrying...');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

export async function generateEmbeddings(
  baseUrl: string,
  model: string,
  texts: string[],
): Promise<(number[] | null)[]> {
  return Promise.all(texts.map((t) => generateEmbedding(baseUrl, model, t)));
}

export async function ollamaChat(
  baseUrl: string,
  model: string,
  prompt: string,
  provider: LocalLLMProvider = 'ollama',
): Promise<string> {
  const isOllama = provider === 'ollama';
  const trimmed = baseUrl.replace(/\/+$/, '');
  const url = isOllama
    ? `${trimmed}/api/chat`
    : (trimmed.endsWith('/v1') ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`);

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  };

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM chat HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as Record<string, unknown>;

  let content: string | undefined;
  if (isOllama) {
    const msg = json.message as { content?: string } | undefined;
    content = msg?.content;
  } else {
    const choices = json.choices as Array<{ message: { content?: string } }> | undefined;
    content = choices?.[0]?.message?.content;
  }

  if (!content) throw new Error('Empty response from LLM chat');
  return content;
}


export interface OllamaToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
}

interface OllamaChatApiResponse {
  model: string;
  message?: {
    content?: string;
    reasoning_content?: string;
    tool_calls?: OllamaToolCall[];
  };
  eval_count?: number;
  prompt_eval_count?: number;
  done?: boolean;
  reported_cost_usd?: number;
  cache_hit_tokens?: number;
}

export interface OllamaToolCallRecord {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
}

export interface OllamaChatResult {
  content: string;
  model: string;
  tokensUsed: number;
  promptTokens: number;
  toolCalls: OllamaToolCallRecord[];
  cacheHitTokens?: number;
  reportedCostUsd?: number;
  apiRequests: number;
  usageReported?: boolean;
}

export interface OllamaChatWithToolsOptions {
  maxRounds?: number;
  temperature?: number;
  cwd?: string;
  onText?: (chunk: string) => void;
  onTextDelta?: (chunk: string) => void;
  onToolUse?: (record: OllamaToolCallRecord) => void;
  provider?: LLMProvider;
  authHeaders?: Record<string, string>;
  maxTokens?: number;
  streaming?: boolean;
  priorMessages?: OllamaChatMessage[];
  extraBodyParams?: Partial<Record<string, unknown>>;
  mcpServers?: Record<string, McpServerSpec>;
}

const CHAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos

async function fetchChatNonStreaming(
  baseUrl: string,
  messages: OllamaChatMessage[],
  model: string,
  tools: OllamaToolSchema[] | undefined,
  temperature: number | undefined,
  provider: LLMProvider,
  authHeaders?: Record<string, string>,
  maxTokens?: number,
  extraBodyParams?: Partial<Record<string, unknown>>,
): Promise<OllamaChatApiResponse> {
  const isOllama = provider === 'ollama';
  const trimmed = baseUrl.replace(/\/+$/, '');
  const url = isOllama
    ? `${trimmed}/api/chat`
    : (trimmed.endsWith('/v1') ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`);

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    ...(extraBodyParams ?? {}),
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  if (provider === 'openrouter') {
    body.provider = { allow_fallbacks: true };
  }

  if (isOllama) {
    const options: Record<string, unknown> = {};
    if (temperature !== undefined) options.temperature = temperature;
    if (maxTokens !== undefined) options.num_predict = maxTokens;
    if (Object.keys(options).length > 0) body.options = options;
  } else {
    if (temperature !== undefined) body.temperature = temperature;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${isOllama ? 'Ollama' : provider} ${url} HTTP ${res.status}: ${text.substring(0, 300)}`);
    }

    if (isOllama) {
      return (await res.json()) as OllamaChatApiResponse;
    }

    const data = await res.json() as Record<string, unknown>;
    const choices = data.choices as Array<{
      message: {
        content?: string;
        reasoning_content?: string;
        tool_calls?: Array<{ id?: string; function: { name: string; arguments: string | Record<string, unknown> } }>;
      }
    }> | undefined;
    const usage = data.usage as {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cost?: number;                    // OpenRouter: custo real cobrado em USD
      prompt_cache_hit_tokens?: number; // DeepSeek: tokens servidos do cache
      cache_hit_tokens?: number;        // MiniMax: tokens servidos do cache
    } | undefined;

    const rawToolCalls = choices?.[0]?.message?.tool_calls;
    const toolCalls: OllamaToolCall[] | undefined = rawToolCalls?.map((tc) => ({
      id: tc.id,
      function: {
        name: tc.function.name,
        arguments: typeof tc.function.arguments === 'string'
          ? (() => { try { return JSON.parse(tc.function.arguments as string); } catch { return {}; } })()
          : tc.function.arguments,
      },
    }));

    return {
      model: (data.model as string) || model,
      message: {
        content: choices?.[0]?.message?.content,
        reasoning_content: choices?.[0]?.message?.reasoning_content,
        tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      },
      eval_count: usage?.completion_tokens ?? usage?.total_tokens,
      prompt_eval_count: usage?.prompt_tokens,
      cache_hit_tokens: usage?.prompt_cache_hit_tokens ?? usage?.cache_hit_tokens,
      reported_cost_usd: usage?.cost,
      done: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchChatStreamingWithTools(
  baseUrl: string,
  messages: OllamaChatMessage[],
  model: string,
  tools: OllamaToolSchema[] | undefined,
  temperature: number | undefined,
  provider: LLMProvider,
  authHeaders?: Record<string, string>,
  maxTokens?: number,
  onTextDelta?: (chunk: string) => void,
  extraBodyParams?: Partial<Record<string, unknown>>,
): Promise<OllamaChatApiResponse> {
  const url = baseUrl.replace(/\/+$/, '').endsWith('/v1')
    ? `${baseUrl.replace(/\/+$/, '')}/chat/completions`
    : `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(extraBodyParams ?? {}),
  };

  if (tools && tools.length > 0) body.tools = tools;
  if (temperature !== undefined) body.temperature = temperature;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;

  if (provider === 'openrouter') {
    body.provider = { allow_fallbacks: true };
  }

  logger.info(
    {
      url,
      model,
      provider,
      toolCount: tools?.length ?? 0,
      toolNames: tools?.map((t) => t.function.name) ?? [],
      firstToolSample: tools?.[0],
      bodyKeys: Object.keys(body),
      messageCount: messages.length,
    },
    'External request: outbound body summary',
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${provider} ${url} HTTP ${res.status}: ${text.substring(0, 300)}`);
    }

    if (!res.body) throw new Error('Response body is null');

    let accumulatedContent = '';
    let accumulatedReasoningContent = '';
    let sawReasoningContent = false;
    const accumulatedToolCalls: Array<{
      id?: string;
      type?: string;
      function: { name: string; arguments: string };
    }> = [];
    let usage:
      | {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          cost?: number;
          prompt_cache_hit_tokens?: number;
          cache_hit_tokens?: number;
        }
      | undefined;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (event.usage) {
          usage = event.usage as typeof usage;
        }

        const choices = event.choices as Array<{
          delta?: {
            content?: string;
            reasoning_content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }> | undefined;

        const choice = choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (!delta) continue;

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          accumulatedContent += delta.content;
          if (onTextDelta) onTextDelta(delta.content);
        }

        if (typeof delta.reasoning_content === 'string') {
          sawReasoningContent = true;
          accumulatedReasoningContent += delta.reasoning_content;
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tcDelta of delta.tool_calls) {
            const idx = tcDelta.index ?? 0;
            if (!accumulatedToolCalls[idx]) {
              accumulatedToolCalls[idx] = { function: { name: '', arguments: '' } };
            }
            const slot = accumulatedToolCalls[idx];
            if (tcDelta.id) slot.id = tcDelta.id;
            if (tcDelta.type) slot.type = tcDelta.type;
            if (tcDelta.function?.name) slot.function.name += tcDelta.function.name;
            if (tcDelta.function?.arguments) slot.function.arguments += tcDelta.function.arguments;
          }
        }
      }
    }

    const toolCalls: OllamaToolCall[] | undefined =
      accumulatedToolCalls.length > 0
        ? accumulatedToolCalls.map((tc) => ({
            id: tc.id,
            function: {
              name: tc.function.name,
              arguments: (() => {
                try {
                  return JSON.parse(tc.function.arguments) as Record<string, unknown>;
                } catch {
                  return {};
                }
              })(),
            },
          }))
        : undefined;

    logger.info(
      {
        model,
        provider,
        contentLen: accumulatedContent.length,
        contentPreview: accumulatedContent.slice(0, 200),
        toolCallsRequested: toolCalls?.length ?? 0,
        toolCallNames: toolCalls?.map((tc) => tc.function.name) ?? [],
        usagePresent: !!usage,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
      },
      'External request: stream finished, response summary',
    );

    return {
      model,
      message: {
        content: accumulatedContent,
        reasoning_content: sawReasoningContent ? accumulatedReasoningContent : undefined,
        tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      },
      eval_count: usage?.completion_tokens ?? usage?.total_tokens,
      prompt_eval_count: usage?.prompt_tokens,
      cache_hit_tokens: usage?.prompt_cache_hit_tokens ?? usage?.cache_hit_tokens,
      reported_cost_usd: usage?.cost,
      done: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function ollamaChatWithTools(
  baseUrl: string,
  model: string,
  systemPrompt: string,
  prompt: string,
  tools: OllamaToolSchema[],
  options: OllamaChatWithToolsOptions = {},
): Promise<OllamaChatResult> {
  const {
    maxRounds = 10,
    temperature,
    cwd = process.cwd(),
    onText,
    onTextDelta,
    onToolUse,
    provider = 'ollama',
    authHeaders,
    maxTokens,
    streaming = false,
    mcpServers,
    extraBodyParams,
  } = options;

  let mcpClient: McpSessionClient | undefined;
  let mcpTools: OllamaToolSchema[] = [];

  if (mcpServers && Object.keys(mcpServers).length > 0) {
    const { setupMCPsForSession } = await import('./mcp-tool-bridge');
    const setup = await setupMCPsForSession(mcpServers);
    mcpClient = setup.client;
    mcpTools = setup.tools;
    logger.info({ mcpToolCount: mcpTools.length }, 'MCP tools merged into session');
  }

  const allTools: OllamaToolSchema[] = [...tools, ...mcpTools];

  const messages: OllamaChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  if (options.priorMessages && options.priorMessages.length > 0) {
    messages.push(...options.priorMessages);
  }
  messages.push({ role: 'user', content: prompt });

  const toolCallLog: OllamaToolCallRecord[] = [];
  let totalOutputTokens = 0;
  let totalPromptTokens = 0;
  let totalCacheHitTokens = 0;
  let totalReportedCostUsd = 0;
  let roundCount = 0;
  let finalContent = '';
  let finalModel = model;
  let anyUsageReported = false;

  logger.info(
    { model, baseUrl, provider, tools: allTools.map((t) => t.function.name), maxRounds },
    'ollamaChatWithTools started',
  );

  try {
    for (let round = 0; round < maxRounds; round++) {
      const apiResponse = streaming
        ? await fetchChatStreamingWithTools(
            baseUrl,
            messages,
            model,
            allTools,
            temperature,
            provider,
            authHeaders,
            maxTokens,
            onTextDelta,
            extraBodyParams,
          )
        : await fetchChatNonStreaming(
            baseUrl,
            messages,
            model,
            allTools,
            temperature,
            provider,
            authHeaders,
            maxTokens,
            extraBodyParams,
          );

      roundCount += 1;
      totalOutputTokens += apiResponse.eval_count ?? 0;
      totalPromptTokens += apiResponse.prompt_eval_count ?? 0;
      totalCacheHitTokens += apiResponse.cache_hit_tokens ?? 0;
      totalReportedCostUsd += apiResponse.reported_cost_usd ?? 0;
      finalModel = apiResponse.model || model;
      if (apiResponse.eval_count !== undefined || apiResponse.prompt_eval_count !== undefined) {
        anyUsageReported = true;
      }

      const msgContent = apiResponse.message?.content ?? '';
      const toolCalls = apiResponse.message?.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        finalContent = msgContent;
        if (onText && msgContent) {
          onText(msgContent);
        }
        logger.info({ round, model: finalModel }, 'ollamaChatWithTools finished (no more tool calls)');
        break;
      }

      const toolCallsWithIds = toolCalls.map((tc, i) => ({
        ...tc,
        id: tc.id ?? `call_${tc.function.name}_${Date.now()}_${i}`,
      }));

      if (provider === 'ollama') {
        messages.push({
          role: 'assistant',
          content: msgContent,
          tool_calls: toolCallsWithIds,
        });
      } else {
        const assistantMessage: OllamaChatMessage = {
          role: 'assistant',
          content: msgContent || null,
          tool_calls: toolCallsWithIds.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: JSON.stringify(tc.function.arguments),
            },
          })),
        } as unknown as OllamaChatMessage;
        if (apiResponse.message?.reasoning_content !== undefined) {
          assistantMessage.reasoning_content = apiResponse.message.reasoning_content;
        }
        messages.push({
          ...assistantMessage,
        });
      }

      for (const call of toolCallsWithIds) {
        const toolName = call.function.name;
        const toolArgs = call.function.arguments;

        logger.info({ tool: toolName, round }, 'Executing tool call');

        let toolOutput: string;
        let toolIsError: boolean;

        if (mcpClient) {
          try {
            const dispatchResult = await executeToolDispatch(toolName, toolArgs, cwd, mcpClient);
            if (
              dispatchResult !== null &&
              typeof dispatchResult === 'object' &&
              'result' in (dispatchResult as Record<string, unknown>) &&
              'isError' in (dispatchResult as Record<string, unknown>)
            ) {
              const r = dispatchResult as { result: string; isError: boolean };
              toolOutput = r.result;
              toolIsError = r.isError;
            } else {
              toolOutput = typeof dispatchResult === 'string'
                ? dispatchResult
                : JSON.stringify(dispatchResult);
              toolIsError = false;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            toolOutput = `Error ao executar tool ${toolName}: ${msg}`;
            toolIsError = true;
          }
        } else {
          const toolResult = await executeLocalTool(toolName, toolArgs, cwd);
          toolOutput = toolResult.result;
          toolIsError = toolResult.isError;
        }

        const record: OllamaToolCallRecord = {
          tool: toolName,
          input: toolArgs,
          output: toolOutput,
          isError: toolIsError,
        };
        toolCallLog.push(record);

        if (onToolUse) {
          onToolUse(record);
        }

        messages.push({
          role: 'tool',
          content: toolOutput,
          tool_call_id: call.id,
        });
      }

      if (round === maxRounds - 1) {
        logger.warn({ model, maxRounds }, 'Max rounds reached, forcing final response without tools');
        const finalResponse = streaming
          ? await fetchChatStreamingWithTools(
              baseUrl,
              messages,
              model,
              undefined,
              temperature,
              provider,
              authHeaders,
              maxTokens,
              onTextDelta,
              extraBodyParams,
            )
          : await fetchChatNonStreaming(
              baseUrl,
              messages,
              model,
              undefined,
              temperature,
              provider,
              authHeaders,
              maxTokens,
              extraBodyParams,
            );
        roundCount += 1;
        finalContent = finalResponse.message?.content ?? '[Limite de rounds atingido sem resposta final]';
        totalOutputTokens += finalResponse.eval_count ?? 0;
        totalPromptTokens += finalResponse.prompt_eval_count ?? 0;
        totalCacheHitTokens += finalResponse.cache_hit_tokens ?? 0;
        totalReportedCostUsd += finalResponse.reported_cost_usd ?? 0;
        if (finalResponse.eval_count !== undefined || finalResponse.prompt_eval_count !== undefined) {
          anyUsageReported = true;
        }
        if (onText && finalContent) {
          onText(finalContent);
        }
      }
    }
  } finally {
    if (mcpClient) {
      const { teardownMCPsForSession } = await import('./mcp-tool-bridge');
      await teardownMCPsForSession(mcpClient);
    }
  }

  return {
    content: finalContent,
    model: finalModel,
    tokensUsed: totalOutputTokens,
    promptTokens: totalPromptTokens,
    toolCalls: toolCallLog,
    cacheHitTokens: totalCacheHitTokens > 0 ? totalCacheHitTokens : undefined,
    reportedCostUsd: totalReportedCostUsd > 0 ? totalReportedCostUsd : undefined,
    apiRequests: roundCount,
    usageReported: anyUsageReported,
  };
}


export type OllamaStreamChunkType = 'text' | 'tool_call' | 'done';

export interface OllamaStreamChunk {
  type: OllamaStreamChunkType;
  text?: string;
  toolCall?: {
    name: string;
    arguments: Record<string, unknown>;
    id?: string;
  };
  done?: {
    model: string;
    tokensUsed: number;
    promptTokens: number;
  };
}

interface OllamaStreamApiChunk {
  model?: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
  eval_count?: number;
  prompt_eval_count?: number;
}

export interface OllamaChatStreamOptions {
  systemPrompt?: string;
  temperature?: number;
  tools?: OllamaToolSchema[];
  signal?: AbortSignal;
  provider?: LocalLLMProvider;
}

export async function* ollamaChatStream(
  baseUrl: string,
  model: string,
  prompt: string,
  options: OllamaChatStreamOptions = {},
): AsyncGenerator<OllamaStreamChunk> {
  const { systemPrompt, temperature, tools, signal, provider = 'ollama' } = options;
  const isOllama = provider === 'ollama';

  const messages: OllamaChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const url = isOllama ? `${baseUrl}/api/chat` : `${baseUrl}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  if (isOllama) {
    const ollamaOptions: Record<string, unknown> = {};
    if (temperature !== undefined) ollamaOptions.temperature = temperature;
    if (Object.keys(ollamaOptions).length > 0) body.options = ollamaOptions;
  } else {
    if (temperature !== undefined) body.temperature = temperature;
  }

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), CHAT_TIMEOUT_MS);

  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === 'AbortError') {
      yield { type: 'done', done: { model, tokensUsed: 0, promptTokens: 0 } };
      return;
    }
    throw err;
  }

  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    throw new Error(`${isOllama ? 'Ollama' : provider} stream HTTP ${res.status}: ${text.substring(0, 300)}`);
  }

  const body_ = res.body;
  if (!body_) {
    clearTimeout(timer);
    throw new Error('LLM response has no body');
  }

  const reader = body_.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finalModel = model;
  let totalOutputTokens = 0;
  let totalPromptTokens = 0;

  try {
    if (isOllama) {
      yield* parseOllamaNDJSONStream(reader, decoder, buffer, finalModel, totalOutputTokens, totalPromptTokens);
    } else {
      yield* parseOpenAISSEStream(reader, decoder, buffer, finalModel, totalOutputTokens, totalPromptTokens);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

async function* parseOllamaNDJSONStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: string,
  finalModel: string,
  totalOutputTokens: number,
  totalPromptTokens: number,
): AsyncGenerator<OllamaStreamChunk> {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let chunk: OllamaStreamApiChunk;
      try {
        chunk = JSON.parse(trimmed) as OllamaStreamApiChunk;
      } catch {
        logger.warn({ line: trimmed }, 'Failed to parse stream line');
        continue;
      }

      if (chunk.model) finalModel = chunk.model;
      if (chunk.eval_count) totalOutputTokens = chunk.eval_count;
      if (chunk.prompt_eval_count) totalPromptTokens = chunk.prompt_eval_count;

      const textContent = chunk.message?.content;
      if (textContent) {
        yield { type: 'text', text: textContent };
      }

      const toolCalls = chunk.message?.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        for (const call of toolCalls) {
          yield {
            type: 'tool_call',
            toolCall: {
              name: call.function.name,
              arguments: call.function.arguments,
              ...(call.id ? { id: call.id } : {}),
            },
          };
        }
      }

      if (chunk.done) break;
    }
  }

  yield {
    type: 'done',
    done: { model: finalModel, tokensUsed: totalOutputTokens, promptTokens: totalPromptTokens },
  };
}

interface OpenAIStreamDelta {
  role?: string;
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAIStreamChunk {
  model?: string;
  choices?: Array<{ delta: OpenAIStreamDelta; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

async function* parseOpenAISSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: string,
  finalModel: string,
  totalOutputTokens: number,
  totalPromptTokens: number,
): AsyncGenerator<OllamaStreamChunk> {
  const toolCallAccumulator = new Map<number, { id?: string; name: string; args: string }>();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;

      const dataPrefix = 'data: ';
      const jsonStr = trimmed.startsWith(dataPrefix) ? trimmed.slice(dataPrefix.length) : trimmed;

      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(jsonStr) as OpenAIStreamChunk;
      } catch {
        logger.warn({ line: trimmed }, 'Failed to parse OpenAI stream line');
        continue;
      }

      if (chunk.model) finalModel = chunk.model;
      if (chunk.usage) {
        totalOutputTokens = chunk.usage.completion_tokens ?? chunk.usage.total_tokens ?? 0;
        totalPromptTokens = chunk.usage.prompt_tokens ?? 0;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        yield { type: 'text', text: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallAccumulator.get(tc.index);
          if (existing) {
            if (tc.function?.arguments) existing.args += tc.function.arguments;
          } else {
            toolCallAccumulator.set(tc.index, {
              id: tc.id,
              name: tc.function?.name ?? '',
              args: tc.function?.arguments ?? '',
            });
          }
        }
      }

      const finishReason = chunk.choices?.[0]?.finish_reason;
      if (finishReason === 'tool_calls' || finishReason === 'stop') {
        for (const [, tc] of toolCallAccumulator) {
          if (tc.name) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.args); } catch { /* empty */ }
            yield {
              type: 'tool_call',
              toolCall: { name: tc.name, arguments: args, ...(tc.id ? { id: tc.id } : {}) },
            };
          }
        }
        toolCallAccumulator.clear();
      }
    }
  }

  for (const [, tc] of toolCallAccumulator) {
    if (tc.name) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.args); } catch { /* empty */ }
      yield {
        type: 'tool_call',
        toolCall: { name: tc.name, arguments: args, ...(tc.id ? { id: tc.id } : {}) },
      };
    }
  }

  yield {
    type: 'done',
    done: { model: finalModel, tokensUsed: totalOutputTokens, promptTokens: totalPromptTokens },
  };
}
