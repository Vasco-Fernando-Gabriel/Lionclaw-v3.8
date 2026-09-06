
import { createLogger } from '../../logger';
import type { McpInvocationContext } from '../../mcp-invocation-context';
import type {
  CursorToolDispatchContext,
  CursorToolDispatcher,
  CursorToolInvocation,
} from './sidecar-manager';

const logger = createLogger('cursor-tool-dispatch');

export type CursorToolHandler = (
  invocation: CursorToolInvocation,
  ctx: CursorToolDispatchContext,
) => Promise<string>;

export function composeCursorToolDispatchers(
  handlers: Record<string, CursorToolHandler>,
): CursorToolDispatcher {
  return async (invocation, ctx) => {
    const handler = handlers[invocation.toolName];
    if (!handler) {
      throw new Error(
        `Tool "${invocation.toolName}" nao registrada no despacho do runtime Cursor. ` +
          `Tools disponiveis: ${Object.keys(handlers).join(', ') || '(nenhuma)'}`,
      );
    }
    return handler(invocation, ctx);
  };
}


export interface CursorMcpInvokeScope {
  surface: string;
  sessionId: string;
  allowedServerIds: readonly string[];
  getTurnId: () => string;
  context?: McpInvocationContext;
}

interface McpInvokeArgs {
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

function parseMcpInvokeArgs(raw: Record<string, unknown>): McpInvokeArgs {
  const server = typeof raw['server'] === 'string' ? raw['server'].trim() : '';
  const tool = typeof raw['tool'] === 'string' ? raw['tool'].trim() : '';
  if (!server || !tool) {
    throw new Error(
      'Argumentos invalidos para invocacao MCP: esperado { server: string, tool: string, args?: object }',
    );
  }
  const argsRaw = raw['args'];
  const args =
    argsRaw && typeof argsRaw === 'object' && !Array.isArray(argsRaw)
      ? (argsRaw as Record<string, unknown>)
      : {};
  return { server, tool, args };
}

export function createMcpInvokeToolHandler(scope: CursorMcpInvokeScope): CursorToolHandler {
  return async (invocation, ctx) => {
    const parsed = parseMcpInvokeArgs(invocation.args);
    logger.debug(
      { executionId: invocation.executionId, server: parsed.server, tool: parsed.tool },
      'Invocacao MCP originada de customTool cursor',
    );
    const { invokeMcpTool } = await import('../../mcp-invoke');
    const result = await invokeMcpTool({
      serverId: parsed.server,
      toolName: parsed.tool,
      args: parsed.args,
      surface: scope.surface,
      sessionId: scope.sessionId,
      turnId: scope.getTurnId(),
      allowedServerIds: [...scope.allowedServerIds],
      ...(scope.context !== undefined ? { context: scope.context } : {}),
      signal: ctx.signal,
    });
    return result.content;
  };
}
