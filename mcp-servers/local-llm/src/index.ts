import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

type Provider = 'ollama' | 'lmstudio' | 'openai-compatible';

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function chatOllama(baseUrl: string, model: string, prompt: string, systemPrompt?: string, temperature?: number, maxTokens?: number): Promise<{ content: string; model: string; tokensUsed?: number }> {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const body: Record<string, unknown> = { model, messages, stream: false };
  if (temperature !== undefined) body.options = { ...(body.options as Record<string, unknown> || {}), temperature };
  if (maxTokens !== undefined) body.options = { ...(body.options as Record<string, unknown> || {}), num_predict: maxTokens };

  const response = await fetchWithTimeout(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama error ${response.status}: ${text}`);
  }

  const data = await response.json() as Record<string, unknown>;
  const message = data.message as { content: string } | undefined;
  const evalCount = data.eval_count as number | undefined;

  return {
    content: message?.content || '',
    model: (data.model as string) || model,
    tokensUsed: evalCount,
  };
}

async function chatOpenAICompatible(baseUrl: string, model: string, prompt: string, systemPrompt?: string, temperature?: number, maxTokens?: number): Promise<{ content: string; model: string; tokensUsed?: number }> {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const body: Record<string, unknown> = { model, messages };
  if (temperature !== undefined) body.temperature = temperature;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;

  const response = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  const data = await response.json() as Record<string, unknown>;
  const choices = data.choices as Array<{ message: { content: string } }> | undefined;
  const usage = data.usage as { total_tokens?: number } | undefined;

  return {
    content: choices?.[0]?.message?.content || '',
    model: (data.model as string) || model,
    tokensUsed: usage?.total_tokens,
  };
}

async function listModelsOllama(baseUrl: string): Promise<Array<{ name: string; size: string; modified: string }>> {
  const response = await fetchWithTimeout(`${baseUrl}/api/tags`, { method: 'GET' }, 15000);
  if (!response.ok) throw new Error(`Ollama error ${response.status}`);

  const data = await response.json() as { models?: Array<{ name: string; size: number; modified_at: string }> };
  return (data.models || []).map((m) => ({
    name: m.name,
    size: formatBytes(m.size),
    modified: m.modified_at,
  }));
}

async function listModelsOpenAI(baseUrl: string): Promise<Array<{ name: string; size: string; modified: string }>> {
  const response = await fetchWithTimeout(`${baseUrl}/v1/models`, { method: 'GET' }, 15000);
  if (!response.ok) throw new Error(`API error ${response.status}`);

  const data = await response.json() as { data?: Array<{ id: string; created?: number }> };
  return (data.data || []).map((m) => ({
    name: m.id,
    size: 'N/A',
    modified: m.created ? new Date(m.created * 1000).toISOString() : 'N/A',
  }));
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}


const server = new McpServer({
  name: 'local-llm',
  version: '1.0.0',
});

server.tool(
  'local_llm_chat',
  'Envia um prompt para um modelo local (Ollama, LM Studio, ou OpenAI-compatible) e retorna a resposta',
  {
    provider: z.enum(['ollama', 'lmstudio', 'openai-compatible']).describe('Provider do modelo local'),
    baseUrl: z.string().describe('URL base do provider (ex: http://localhost:11434)'),
    model: z.string().describe('Nome do modelo (ex: llama3:8b, mistral, deepseek-coder)'),
    prompt: z.string().describe('Prompt/mensagem para enviar ao modelo'),
    systemPrompt: z.string().optional().describe('System prompt opcional'),
    temperature: z.number().min(0).max(2).optional().describe('Temperature (0-2, default 0.7)'),
    maxTokens: z.number().optional().describe('Max tokens na resposta'),
  },
  async ({ provider, baseUrl, model, prompt, systemPrompt, temperature, maxTokens }) => {
    try {
      let result: { content: string; model: string; tokensUsed?: number };

      if (provider === 'ollama') {
        result = await chatOllama(baseUrl, model, prompt, systemPrompt, temperature, maxTokens);
      } else {
        result = await chatOpenAICompatible(baseUrl, model, prompt, systemPrompt, temperature, maxTokens);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[local-llm] Chat error: ${msg}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'local_llm_list_models',
  'Lista modelos disponiveis no provider local',
  {
    provider: z.enum(['ollama', 'lmstudio', 'openai-compatible']).describe('Provider do modelo local'),
    baseUrl: z.string().describe('URL base do provider'),
  },
  async ({ provider, baseUrl }) => {
    try {
      let models: Array<{ name: string; size: string; modified: string }>;

      if (provider === 'ollama') {
        models = await listModelsOllama(baseUrl);
      } else {
        models = await listModelsOpenAI(baseUrl);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ models }) }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[local-llm] List models error: ${msg}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'local_llm_health',
  'Verifica se o provider local esta rodando e acessivel',
  {
    provider: z.enum(['ollama', 'lmstudio', 'openai-compatible']).describe('Provider do modelo local'),
    baseUrl: z.string().describe('URL base do provider'),
  },
  async ({ provider, baseUrl }) => {
    try {
      if (provider === 'ollama') {
        const response = await fetchWithTimeout(`${baseUrl}/api/version`, { method: 'GET' }, 10000);
        if (!response.ok) throw new Error(`Status ${response.status}`);
        const data = await response.json() as { version?: string };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ healthy: true, version: data.version }) }],
        };
      } else {
        const response = await fetchWithTimeout(`${baseUrl}/v1/models`, { method: 'GET' }, 10000);
        if (!response.ok) throw new Error(`Status ${response.status}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ healthy: true }) }],
        };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[local-llm] Health check error: ${msg}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ healthy: false, error: msg }) }],
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[local-llm] MCP server running on stdio');
}

main().catch((error) => {
  console.error('[local-llm] Fatal error:', error);
  process.exit(1);
});
