import crypto from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LocalIpcClient, assertEndpointPresentOrExit, readEnvTurnBinding } from '../../_shared/local-ipc-client.js';
import { gatewayToolArgsSchema } from './tool-args.js';

assertEndpointPresentOrExit();

const client = new LocalIpcClient({ callTimeoutMs: 5 * 60_000 });

const SURFACE: 'claude-sdk' | 'claude-compat-sdk' | 'codex-sdk' =
  process.env['LIONCLAW_MCP_SURFACE'] === 'claude-compat-sdk'
    ? 'claude-compat-sdk'
    : process.env['LIONCLAW_MCP_SURFACE'] === 'codex-sdk'
      ? 'codex-sdk'
      : 'claude-sdk';

const LANE: string | undefined = (() => {
  const raw = process.env['LIONCLAW_MCP_LANE'];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
})();

const ENV_BINDING = readEnvTurnBinding();

const SESSION_ID = ENV_BINDING.sessionId ?? `gateway-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

const TURN_RESET_IDLE_MS = 120_000;
let turnCounter = 1;
let lastInvokeAt = 0;

function syntheticTurnId(): string {
  const now = Date.now();
  if (lastInvokeAt > 0 && now - lastInvokeAt > TURN_RESET_IDLE_MS) {
    turnCounter += 1;
  }
  lastInvokeAt = now;
  return String(turnCounter);
}

function currentTurnId(): string | undefined {
  if (ENV_BINDING.turnId) return ENV_BINDING.turnId;
  if (ENV_BINDING.sessionId) return undefined;
  return syntheticTurnId();
}

const server = new McpServer({ name: 'gateway', version: '1.0.0' });

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function toToolResult(raw: unknown): ToolResult {
  const r = (raw ?? {}) as { content?: unknown; isError?: unknown };
  const text = typeof r.content === 'string' ? r.content : JSON.stringify(raw ?? null);
  return {
    content: [{ type: 'text' as const, text }],
    ...(r.isError === true ? { isError: true } : {}),
  };
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

server.tool(
  'mcp_invoke',
  'Executa uma tool de um servidor MCP do LionClaw. O catalogo (servidores e tools disponiveis) esta no system prompt; em duvida sobre os args, consulte mcp_schema antes.',
  {
    server: z.string().describe('ID do servidor MCP (cabecalho do catalogo no system prompt).'),
    tool: z.string().describe('Nome exato da tool como listada no catalogo.'),
    args: gatewayToolArgsSchema.optional().describe('Argumentos da tool (objeto JSON conforme o schema da tool).'),
  },
  async ({ server: serverId, tool, args }) => {
    try {
      const turnId = currentTurnId();
      const result = await client.callMethod(
        'mcp_invoke',
        {
          server: serverId,
          tool,
          args: args ?? {},
          surface: SURFACE,
          sessionId: SESSION_ID,
          ...(turnId !== undefined ? { turnId } : {}),
          ...(LANE !== undefined ? { lane: LANE } : {}),
        },
        { idempotent: false },
      );
      return toToolResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`Erro no gateway MCP ao invocar ${tool} em ${serverId}: ${msg}`);
    }
  },
);

server.tool(
  'mcp_schema',
  'Retorna o contrato completo (input schema) de uma tool do catalogo MCP do system prompt, antes de invoca-la com mcp_invoke.',
  {
    server: z.string().describe('ID do servidor MCP (cabecalho do catalogo no system prompt).'),
    tool: z.string().describe('Nome exato da tool como listada no catalogo.'),
  },
  async ({ server: serverId, tool }) => {
    try {
      const result = await client.callMethod('mcp_get_schema', {
        server: serverId,
        tool,
        surface: SURFACE,
        ...(LANE !== undefined ? { lane: LANE } : {}),
      });
      return toToolResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`Erro no gateway MCP ao consultar o schema de ${tool} em ${serverId}: ${msg}`);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[gateway] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[gateway] Fatal error:', err);
  process.exit(1);
});
