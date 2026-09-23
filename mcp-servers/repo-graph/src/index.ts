import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LocalIpcClient, assertEndpointPresentOrExit, withTurnBinding } from '../../_shared/local-ipc-client.js';

assertEndpointPresentOrExit();

const client = new LocalIpcClient({ callTimeoutMs: 60 * 1000 });

const server = new McpServer({ name: 'repo-graph', version: '1.0.0' });

const DOMAIN_PREFIX = '[Estrutura de codigo do repositorio ativo da conversa]';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

async function proxy(method: string, params: Record<string, unknown>, extra?: unknown): Promise<ToolResult> {
  try {
    const result = await client.callMethod(method, withTurnBinding(params, extra));
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
      isError: true,
    };
  }
}

server.tool(
  'repo_graph_status',
  `${DOMAIN_PREFIX} State of the code graph of the active repository of this conversation (status, indexed commit, staleness, stats). Use to check the graph before relying on it.`,
  {},
  async (extra) => proxy('repo_graph_status', {}, extra),
);

server.tool(
  'repo_graph_search',
  `${DOMAIN_PREFIX} Search symbols (functions, classes, methods, types, routes, components) and files in the code graph of the active repository. Use this BEFORE bulk Glob/Grep/Read or Bash search.`,
  {
    term: z.string().describe('Search term (symbol or file name, full-text).'),
    kind: z.string().optional().describe('Optional symbol kind filter (e.g. function, class, method, type).'),
    limit: z.number().int().positive().optional().describe('Max results (default 20).'),
  },
  async ({ term, kind, limit }, extra) => proxy('repo_graph_search', { term, kind, limit }, extra),
);

server.tool(
  'repo_graph_minimal_context',
  `${DOMAIN_PREFIX} Compact context (top files + symbols + rendered markdown, max 10KB) for a task in the active repository. Use to ground yourself or to build a short context for a subagent without MCP access.`,
  {
    task: z.string().describe('Short description of the task/question to gather context for.'),
  },
  async ({ task }, extra) => proxy('repo_graph_minimal_context', { task }, extra),
);

server.tool(
  'repo_graph_impact',
  `${DOMAIN_PREFIX} Blast radius of a symbol in the active repository: what is affected (direct and transitive) when it changes.`,
  {
    symbol: z.string().describe('Symbol name to analyze.'),
    depth: z.number().int().positive().optional().describe('Traversal depth (default 2).'),
  },
  async ({ symbol, depth }, extra) => proxy('repo_graph_impact', { symbol, depth }, extra),
);

server.tool(
  'repo_graph_node',
  `${DOMAIN_PREFIX} Details of a single symbol by EXACT name in the active repository (kind, file, lines, signature).`,
  {
    name: z.string().describe('Exact symbol name.'),
  },
  async ({ name }, extra) => proxy('repo_graph_node', { name }, extra),
);

server.tool(
  'repo_graph_callers',
  `${DOMAIN_PREFIX} Who calls a symbol in the active repository (incoming call edges).`,
  {
    symbol: z.string().describe('Symbol name.'),
    limit: z.number().int().positive().optional().describe('Max results (default 20).'),
  },
  async ({ symbol, limit }, extra) => proxy('repo_graph_callers', { symbol, limit }, extra),
);

server.tool(
  'repo_graph_callees',
  `${DOMAIN_PREFIX} What a symbol calls in the active repository (outgoing call edges).`,
  {
    symbol: z.string().describe('Symbol name.'),
    limit: z.number().int().positive().optional().describe('Max results (default 20).'),
  },
  async ({ symbol, limit }, extra) => proxy('repo_graph_callees', { symbol, limit }, extra),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[repo-graph] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[repo-graph] Fatal error:', err);
  process.exit(1);
});
