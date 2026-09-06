import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  LocalIpcClient,
  assertEndpointPresentOrExit,
} from '../../_shared/local-ipc-client.js';

assertEndpointPresentOrExit();

const client = new LocalIpcClient({ callTimeoutMs: 30_000 });
const server = new McpServer({ name: 'lionclaw-preview', version: '1.0.0' });

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { ...result({ ok: false, error: message }), isError: true };
}

server.tool(
  'preview_open',
  'Abre um HTML local permitido ou URL localhost no navegador padrão. Use somente quando o usuário pedir ou concordar em ver.',
  {
    target: z.string().describe('Caminho absoluto .html/.htm ou URL http(s) localhost.'),
  },
  async ({ target }) => {
    try { return result(await client.callMethod('preview_open', { target }, { idempotent: false })); }
    catch (error) { return failure(error); }
  },
);

server.tool(
  'preview_capture',
  'Renderiza um HTML local permitido dentro do LionClaw e salva um PNG ao lado do arquivo, sem abrir Chrome nem executar automação externa.',
  {
    target: z.string().describe('Caminho absoluto de um arquivo .html/.htm.'),
    width: z.number().int().min(320).max(3840).optional(),
    height: z.number().int().min(320).max(4096).optional(),
  },
  async ({ target, width, height }) => {
    try {
      return result(await client.callMethod(
        'preview_capture',
        { target, width, height },
        { idempotent: false, timeoutMs: 30_000 },
      ));
    } catch (error) { return failure(error); }
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error('[lionclaw-preview] MCP server running on stdio');
}

main().catch((error) => {
  console.error('[lionclaw-preview] Fatal error:', error);
  process.exit(1);
});
