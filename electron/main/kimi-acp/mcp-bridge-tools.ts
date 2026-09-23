import type { KimiExternalTool } from '../agent-runtime/kimi-external-tools';

export const KIMI_MCP_MAX_ERROR_CHARS = 512;

export function redactKimiBridgeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\bBearer\s+[^\s"'`,;]+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:["']?(?:api[_-]?key|token|secret|password|authorization)["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\b[A-Za-z]:\\[^\s"'`,;]+/g, '[REDACTED_PATH]')
    .replace(/(^|[\s("'`])\/(?:home|Users|root|tmp|var\/folders)\/[^\s"'`,;]+/g, '$1[REDACTED_PATH]')
    .trim();
  const safe = redacted || 'tool execution failed';
  return safe.length <= KIMI_MCP_MAX_ERROR_CHARS ? safe : `${safe.slice(0, KIMI_MCP_MAX_ERROR_CHARS - 1)}…`;
}

export interface McpToolListItem {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

export function toListItem(tool: KimiExternalTool): McpToolListItem {
  const params = tool.parameters;
  const hasSchema = params !== null && typeof params === 'object' && Object.keys(params).length > 0;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: hasSchema ? params : EMPTY_OBJECT_SCHEMA,
  };
}

export async function callTool(
  tool: KimiExternalTool,
  args: Record<string, unknown>,
  context?: Parameters<KimiExternalTool['handler']>[1],
): Promise<McpToolCallResult> {
  try {
    const result = context ? await tool.handler(args, context) : await tool.handler(args);
    return {
      content: [
        {
          type: 'text',
          text: result.isError ? `bridge tool error: ${redactKimiBridgeError(result.output)}` : result.output,
        },
      ],
      ...(result.isError ? { isError: true } : {}),
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `bridge tool error: ${redactKimiBridgeError(err)}` }],
      isError: true,
    };
  }
}
