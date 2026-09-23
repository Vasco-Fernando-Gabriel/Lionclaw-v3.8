import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LocalIpcClient, assertEndpointPresentOrExit } from '../../_shared/local-ipc-client.js';

assertEndpointPresentOrExit();

const client = new LocalIpcClient({ callTimeoutMs: 30_000 });
const server = new McpServer({ name: 'lionclaw-telegram', version: '1.0.0' });

server.tool(
  'telegram_notify',
  'Envia uma mensagem proativa para o Telegram do dono. So funciona quando o icone do Telegram no chat esta ARMADO; se estiver desarmado ou offline, retorna um resultado estruturado e nao envia.',
  {
    message: z.string().min(1).describe('Texto da mensagem para o Telegram do dono.'),
  },
  async ({ message }) => {
    try {
      const result = await client.callMethod('telegram_notify', { message }, { idempotent: false });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ sent: false, error }) }],
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[lionclaw-telegram] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[lionclaw-telegram] Fatal error:', err);
  process.exit(1);
});
