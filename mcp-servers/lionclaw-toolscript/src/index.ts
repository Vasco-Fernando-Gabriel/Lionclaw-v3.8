import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LocalIpcClient, assertEndpointPresentOrExit, withTurnBinding } from '../../_shared/local-ipc-client.js';

assertEndpointPresentOrExit();

const client = new LocalIpcClient({ callTimeoutMs: 15 * 60 * 1000 });

const server = new McpServer({ name: 'lionclaw-toolscript', version: '1.0.0' });

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const RUN_TOOL_SCRIPT_DESCRIPTION = [
  'Rode um script Python que chama as tools do LionClaw via RPC; apenas o stdout volta ao seu contexto.',
  '',
  'Use quando: 3+ tool calls com logica entre elas; filtrar/reduzir outputs grandes antes de entrarem no contexto; branching (o resultado de uma chamada decide a proxima); loops sobre arquivos ou itens.',
  'Use tool call normal quando: chamada unica sem processamento; precisar VER o resultado inteiro e raciocinar sobre ele; fluxo interativo com o usuario.',
  '',
  'Como usar: escreva o script Python em `code`. Importe as tools com `from lionclaw_tools import read_file, grep` (importe so o que usar) e imprima o resultado final no stdout com print(). Resultados intermediarios ficam no processo do script e NAO entram no contexto.',
  '',
  'Tools (argumentos posicionais ou nomeados; retornam string; erro vira ToolError capturavel com try/except):',
  '- read_file(path, offset=None, limit=None)',
  '- write_file(path, content)',
  '- edit(path, old_string, new_string)',
  '- grep(pattern, path=None, glob=None)',
  '- search_files(pattern, path=None)',
  '- run_command(command, timeout_ms=None)',
  '- mcp_invoke(server_id, tool_name, args=None)',
  '',
  'Built-ins: json_parse(text), shell_quote(value), retry(fn, attempts=3, delay=1.0, backoff=2.0).',
  '',
  'Limites: 5min de execucao, stdout 50KB (excedente e truncado), 50 tool calls.',
].join('\n');

server.tool(
  'run_tool_script',
  RUN_TOOL_SCRIPT_DESCRIPTION,
  {
    code: z.string().describe('Script Python que importa de lionclaw_tools e imprime o resultado no stdout.'),
  },
  async ({ code }, extra): Promise<ToolResult> => {
    try {
      const result = await client.callMethod('run_tool_script', withTurnBinding({ code }, extra), {
        idempotent: false,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[lionclaw-toolscript] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[lionclaw-toolscript] Fatal error:', err);
  process.exit(1);
});
