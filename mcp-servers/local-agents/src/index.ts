import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { executeLocalAgent, executeExternalAgent } from './runtime.js';
import { loadAllLocalAgents, loadAllExternalAgents, checkOllamaHealth } from './config.js';

const server = new McpServer({ name: 'local-agents', version: '2.0.0' });

server.tool(
  'run_local_agent',
  'Executa um agente local (Ollama) com tool-use loop. Use para delegar tarefas aos agentes locais disponiveis.',
  {
    agentId: z.string().describe('ID do agente local (ex: "writer", "researcher")'),
    prompt: z.string().describe('A tarefa ou pergunta para o agente'),
    context: z.string().optional().describe(
      'Contexto adicional: dados de arquivos lidos, resultados de buscas, ou qualquer info relevante. ' +
      'Use isso para passar ao agente dados que ele precisaria buscar sozinho.'
    ),
  },
  async ({ agentId, prompt, context }) => {
    try {
      const result = await executeLocalAgent(agentId, prompt, context);

      const metadata = {
        model: result.model,
        tokensUsed: result.tokensUsed,
        toolCalls: result.toolCalls.length,
        mode: result.toolCalls.length > 0 ? 'smart' : 'simple',
      };

      return {
        content: [
          { type: 'text' as const, text: result.content },
          { type: 'text' as const, text: `\n\n---\n[local-agent-metadata]: ${JSON.stringify(metadata)}` },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Erro no agente local "${agentId}": ${msg}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'run_external_agent',
  'Executa um agente externo (OpenRouter, OpenAI, etc) via API. Use para delegar tarefas aos agentes externos disponiveis.',
  {
    agentId: z.string().describe('ID do agente externo (ex: "backend-developer")'),
    prompt: z.string().describe('A tarefa ou pergunta para o agente'),
    context: z.string().optional().describe(
      'Contexto adicional: dados de arquivos lidos, resultados de buscas, ou qualquer info relevante.',
    ),
  },
  async ({ agentId, prompt, context }) => {
    try {
      const result = await executeExternalAgent(agentId, prompt, context);

      const metadata = {
        model: result.model,
        tokensUsed: result.tokensUsed,
        toolCalls: result.toolCalls.length,
        runtime: 'external',
      };

      return {
        content: [
          { type: 'text' as const, text: result.content },
          { type: 'text' as const, text: `\n\n---\n[external-agent-metadata]: ${JSON.stringify(metadata)}` },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Erro no agente externo "${agentId}": ${msg}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'local_agents_health',
  'Verifica status do Ollama e lista agentes locais disponiveis',
  {},
  async () => {
    const agents = loadAllLocalAgents();
    const healthy = await checkOllamaHealth();
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          healthy,
          agents: agents.map(a => ({
            id: a.id,
            name: a.name,
            model: a.localConfig?.model,
            mode: a.localMode || 'simple',
          })),
        }),
      }],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[local-agents] MCP server v2 running on stdio');
}

main().catch((error) => {
  console.error('[local-agents] Fatal error:', error);
  process.exit(1);
});
