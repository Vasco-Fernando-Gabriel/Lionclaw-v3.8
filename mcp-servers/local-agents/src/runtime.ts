import { loadLocalTools, executeLocalTool } from './tool-implementations.js';
import { loadAgentConfig, loadAgentRules, type LocalAgentConfig } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('local-agent-runtime');

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
}

interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaToolSchema {
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

export interface LocalExecutionResult {
  content: string;
  model: string;
  tokensUsed: number;
  toolCalls: Array<{ tool: string; input: string; output: string }>;
  error?: string;
}

export async function executeLocalAgent(
  agentId: string,
  prompt: string,
  context?: string,
): Promise<LocalExecutionResult> {
  const agent = loadAgentConfig(agentId);
  if (!agent || !agent.localConfig) {
    throw new Error(`Agent ${agentId} not found or not a local agent`);
  }

  const { provider, baseUrl, model, temperature, maxTokens } = agent.localConfig;
  const mode = agent.localMode || 'simple';

  let systemPrompt = agent.systemPrompt || '';
  const rules = loadAgentRules(agentId);
  if (rules) {
    systemPrompt = rules + (systemPrompt ? '\n\n' + systemPrompt : '');
  }

  const MAX_CONTEXT_BYTES = 32_000;
  const truncatedContext = context
    ? context.length > MAX_CONTEXT_BYTES
      ? context.substring(0, MAX_CONTEXT_BYTES) + '\n\n[... contexto truncado por limite de tamanho]'
      : context
    : undefined;

  if (context && context.length > MAX_CONTEXT_BYTES) {
    logger.warn(
      { agentId, originalSize: context.length, truncatedTo: MAX_CONTEXT_BYTES },
      'Context truncado para caber na janela do modelo local',
    );
  }

  const fullPrompt = truncatedContext
    ? `## Contexto fornecido pelo orquestrador\n\n${truncatedContext}\n\n## Tarefa\n\n${prompt}`
    : prompt;

  if (mode === 'simple') {
    return executeSimple(baseUrl, model, fullPrompt, systemPrompt, temperature, maxTokens, provider);
  }

  return executeSmart(
    agentId,
    baseUrl,
    model,
    fullPrompt,
    systemPrompt,
    agent.allowedTools,
    temperature,
    maxTokens,
    agent.maxToolRounds || 5,
    provider,
  );
}

export async function executeExternalAgent(
  agentId: string,
  prompt: string,
  context?: string,
): Promise<LocalExecutionResult> {
  const agent = loadAgentConfig(agentId);
  if (!agent || agent.runtime !== 'external' || !agent.externalConfig) {
    throw new Error(`Agent ${agentId} not found or not an external agent`);
  }

  const { provider, baseUrl, model, apiKeyRef, temperature, maxTokens, extraHeaders } = agent.externalConfig;

  const apiKey = process.env[apiKeyRef];
  if (!apiKey) {
    throw new Error(`API key not found for ref "${apiKeyRef}". Configure it in Settings > Vault.`);
  }

  const authHeaders: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    ...extraHeaders,
  };

  let systemPrompt = agent.systemPrompt || '';
  const rules = loadAgentRules(agentId);
  if (rules) {
    systemPrompt = rules + (systemPrompt ? '\n\n' + systemPrompt : '');
  }

  const MAX_CONTEXT_BYTES = 32_000;
  const truncatedContext = context
    ? context.length > MAX_CONTEXT_BYTES
      ? context.substring(0, MAX_CONTEXT_BYTES) + '\n\n[... contexto truncado por limite de tamanho]'
      : context
    : undefined;

  const fullPrompt = truncatedContext
    ? `## Contexto fornecido pelo orquestrador\n\n${truncatedContext}\n\n## Tarefa\n\n${prompt}`
    : prompt;

  const mode = agent.localMode || 'simple';

  if (mode === 'simple') {
    return executeSimpleExternal(baseUrl, model, fullPrompt, systemPrompt, temperature, maxTokens, authHeaders);
  }

  return executeSmartExternal(
    agentId,
    baseUrl,
    model,
    fullPrompt,
    systemPrompt,
    agent.allowedTools,
    temperature,
    maxTokens,
    agent.maxToolRounds || 5,
    authHeaders,
  );
}

async function executeSimpleExternal(
  baseUrl: string,
  model: string,
  prompt: string,
  systemPrompt: string,
  temperature?: number,
  maxTokens?: number,
  authHeaders?: Record<string, string>,
): Promise<LocalExecutionResult> {
  const messages: OllamaChatMessage[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const result = await callOllama(
    baseUrl,
    model,
    messages,
    undefined,
    temperature,
    maxTokens,
    'openai-compatible',
    authHeaders,
  );
  return { content: result.content, model: result.model, tokensUsed: result.tokensUsed || 0, toolCalls: [] };
}

async function executeSmartExternal(
  agentId: string,
  baseUrl: string,
  model: string,
  prompt: string,
  systemPrompt: string,
  allowedTools: string[],
  temperature?: number,
  maxTokens?: number,
  maxRounds?: number,
  authHeaders?: Record<string, string>,
): Promise<LocalExecutionResult> {
  const toolSchemas = loadLocalTools(allowedTools);
  const toolCallLog: Array<{ tool: string; input: string; output: string }> = [];
  let totalTokens = 0;

  const messages: OllamaChatMessage[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  for (let round = 0; round < (maxRounds || 5); round++) {
    const result = await callOllama(
      baseUrl,
      model,
      messages,
      toolSchemas,
      temperature,
      maxTokens,
      'openai-compatible',
      authHeaders,
    );
    totalTokens += result.tokensUsed || 0;

    if (!result.toolCalls || result.toolCalls.length === 0) {
      return { content: result.content, model: result.model, tokensUsed: totalTokens, toolCalls: toolCallLog };
    }

    messages.push({ role: 'assistant', content: result.content || '', tool_calls: result.toolCalls });

    for (const call of result.toolCalls) {
      const toolName = call.function.name;
      const toolArgs = call.function.arguments;
      logger.info({ agentId, tool: toolName, round }, 'External agent tool call');

      let toolResult: string;
      try {
        toolResult = await executeLocalTool(toolName, toolArgs);
      } catch (err) {
        toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      toolCallLog.push({
        tool: toolName,
        input: JSON.stringify(toolArgs).substring(0, 500),
        output: toolResult.substring(0, 1000),
      });

      messages.push({ role: 'tool', content: toolResult, ...(call.id ? { tool_call_id: call.id } : {}) });
    }
  }

  return {
    content: '[Limite de rounds de tools atingido]',
    model,
    tokensUsed: totalTokens,
    toolCalls: toolCallLog,
    error: 'max_tool_rounds_reached',
  };
}

async function executeSimple(
  baseUrl: string,
  model: string,
  prompt: string,
  systemPrompt: string,
  temperature?: number,
  maxTokens?: number,
  provider?: string,
): Promise<LocalExecutionResult> {
  const messages: OllamaChatMessage[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const result = await callOllama(baseUrl, model, messages, undefined, temperature, maxTokens, provider);

  return {
    content: result.content,
    model: result.model,
    tokensUsed: result.tokensUsed || 0,
    toolCalls: [],
  };
}

async function executeSmart(
  agentId: string,
  baseUrl: string,
  model: string,
  prompt: string,
  systemPrompt: string,
  allowedTools: string[],
  temperature?: number,
  maxTokens?: number,
  maxRounds?: number,
  provider?: string,
): Promise<LocalExecutionResult> {
  const toolSchemas = loadLocalTools(allowedTools);
  const toolCallLog: Array<{ tool: string; input: string; output: string }> = [];
  let totalTokens = 0;

  const messages: OllamaChatMessage[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  for (let round = 0; round < (maxRounds || 5); round++) {
    const result = await callOllama(baseUrl, model, messages, toolSchemas, temperature, maxTokens, provider);
    totalTokens += result.tokensUsed || 0;

    if (!result.toolCalls || result.toolCalls.length === 0) {
      return {
        content: result.content,
        model: result.model,
        tokensUsed: totalTokens,
        toolCalls: toolCallLog,
      };
    }

    messages.push({
      role: 'assistant',
      content: result.content || '',
      tool_calls: result.toolCalls,
    });

    for (const call of result.toolCalls) {
      const toolName = call.function.name;
      const toolArgs = call.function.arguments;

      logger.info({ agentId, tool: toolName, round }, 'Local agent tool call');

      let toolResult: string;
      try {
        toolResult = await executeLocalTool(toolName, toolArgs);
      } catch (err) {
        toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      toolCallLog.push({
        tool: toolName,
        input: JSON.stringify(toolArgs).substring(0, 500),
        output: toolResult.substring(0, 1000),
      });

      messages.push({
        role: 'tool',
        content: toolResult,
        ...(call.id ? { tool_call_id: call.id } : {}),
      });
    }
  }

  return {
    content: '[Limite de rounds de tools atingido]',
    model,
    tokensUsed: totalTokens,
    toolCalls: toolCallLog,
    error: 'max_tool_rounds_reached',
  };
}

interface OllamaResult {
  content: string;
  model: string;
  tokensUsed: number;
  toolCalls?: OllamaToolCall[];
}

async function callOllama(
  baseUrl: string,
  model: string,
  messages: OllamaChatMessage[],
  tools?: OllamaToolSchema[],
  temperature?: number,
  maxTokens?: number,
  provider?: string,
  authHeaders?: Record<string, string>,
): Promise<OllamaResult> {
  const isOllama = !provider || provider === 'ollama';
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const url = isOllama
    ? `${normalizedBase}/api/chat`
    : normalizedBase.endsWith('/v1')
      ? `${normalizedBase}/chat/completions`
      : `${normalizedBase}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
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
  const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);

  logger.info({ url, model, messageCount: messages.length, hasTools: !!tools }, 'Calling LLM');

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...authHeaders };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${isOllama ? 'Ollama' : 'API'} error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as Record<string, unknown>;

    if (isOllama) {
      const msg = data.message as { content?: string; tool_calls?: OllamaToolCall[] } | undefined;
      return {
        content: msg?.content || '',
        model: (data.model as string) || model,
        tokensUsed: (data.eval_count as number) || 0,
        toolCalls: msg?.tool_calls,
      };
    } else {
      const choices = data.choices as
        | Array<{
            message: { content?: string; tool_calls?: OllamaToolCall[] };
          }>
        | undefined;
      const usage = data.usage as { total_tokens?: number } | undefined;
      return {
        content: choices?.[0]?.message?.content || '',
        model: (data.model as string) || model,
        tokensUsed: usage?.total_tokens || 0,
        toolCalls: choices?.[0]?.message?.tool_calls,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}
