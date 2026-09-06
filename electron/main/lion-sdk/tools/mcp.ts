
import { callMCPTool, type McpSessionClient } from '../../mcp-tool-bridge';
import { createLogger } from '../../logger';
import type { McpInvokeResult } from '../../mcp-invoke';

const logger = createLogger('lion-sdk-mcp');

export interface McpCallInput {
  server_id: string;
  tool: string;
  args?: Record<string, unknown>;
}

export interface McpCallWrapperContext {
  sessionId: string;
  turnId: string;
  allowedServerIds: string[];
}

export async function lionMcpCallViaWrapper(
  input: McpCallInput,
  ctx: McpCallWrapperContext,
): Promise<McpInvokeResult> {
  if (!input || typeof input.server_id !== 'string' || input.server_id.length === 0) {
    return { content: 'mcp_call: server_id obrigatorio.', isError: true, displayName: 'mcp_call' };
  }
  if (typeof input.tool !== 'string' || input.tool.length === 0) {
    return { content: 'mcp_call: tool obrigatorio.', isError: true, displayName: 'mcp_call' };
  }
  const { invokeMcpTool } = await import('../../mcp-invoke');
  return invokeMcpTool({
    serverId: input.server_id,
    toolName: input.tool,
    args: input.args ?? {},
    surface: 'lion-sdk',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    allowedServerIds: ctx.allowedServerIds,
    context: { surface: 'chat' },
  });
}

export interface McpCallResult {
  ok: boolean;
  prefixedName?: string;
  content?: string;
  error?: string;
}

export function buildPrefixedMcpName(serverId: string, tool: string): string {
  return `mcp__${serverId}__${tool}`;
}

function isEmptyMcpResult(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return (
    typeof value === 'object' &&
    (value as { isError?: unknown }).isError === true &&
    (value as { code?: unknown }).code === 'MCP-EMPTY'
  );
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    const v = value as { content?: Array<{ type?: string; text?: string }> } & Record<string, unknown>;
    if (Array.isArray(v.content)) {
      const parts = v.content
        .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
        .filter((s) => s.length > 0);
      if (parts.length > 0) return parts.join('\n');
    }
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function lionMcpCall(
  client: McpSessionClient,
  input: McpCallInput,
): Promise<McpCallResult> {
  if (!input || typeof input.server_id !== 'string' || input.server_id.length === 0) {
    return { ok: false, error: 'mcp_call: server_id obrigatorio.' };
  }
  if (typeof input.tool !== 'string' || input.tool.length === 0) {
    return { ok: false, error: 'mcp_call: tool obrigatorio.' };
  }
  const prefixedName = buildPrefixedMcpName(input.server_id, input.tool);

  const { assertChatCapability } = await import('../../chat-capability-gate');
  const gate = assertChatCapability({
    serverId: input.server_id,
    toolName: input.tool,
    context: { surface: 'chat' },
  });
  if (!gate.ok) {
    return { ok: false, prefixedName, error: gate.message };
  }

  const hasConnection = client.connections.some((c) => c.serverId === input.server_id);
  if (!hasConnection) {
    return {
      ok: false,
      prefixedName,
      error: `mcp_call: nenhum MCP ativo com server_id=${input.server_id}`,
    };
  }

  try {
    const result = await callMCPTool(client, prefixedName, input.args ?? {});
    if (isEmptyMcpResult(result)) {
      return {
        ok: false,
        prefixedName,
        error: `MCP-EMPTY: tool ${input.tool} do servidor ${input.server_id} retornou resposta vazia. Tente de novo ou verifique o servidor MCP correspondente.`,
      };
    }
    return {
      ok: true,
      prefixedName,
      content: stringifyContent(result),
    };
  } catch (e) {
    logger.warn({ err: e, prefixedName }, 'mcp_call falhou');
    return {
      ok: false,
      prefixedName,
      error: `mcp_call falhou: ${(e as Error).message}`,
    };
  }
}
