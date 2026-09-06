
export const MCP_GATEWAY_SERVER_ID = 'gateway';

export const CODEX_GATEWAY_SERVER_ID = 'lionclaw-gateway';

export const CODEX_GATEWAY_INVOKE_TOOL_NAME = 'mcp_invoke';
export const CODEX_GATEWAY_SCHEMA_TOOL_NAME = 'mcp_schema';

export const GATEWAY_INVOKE_TOOL_NAME = 'mcp__gateway__mcp_invoke';

export const GATEWAY_SCHEMA_TOOL_NAME = 'mcp__gateway__mcp_schema';

export const MCP_REAL_TOOL_DISPLAY_RE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;

function isGatewayMetaTool(toolName: string | undefined | null): boolean {
  return toolName === GATEWAY_INVOKE_TOOL_NAME || toolName === GATEWAY_SCHEMA_TOOL_NAME;
}

export function deriveMcpGatewayDisplayName(
  toolName: string | undefined | null,
  input: unknown,
): string | null {
  if (!isGatewayMetaTool(toolName)) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const rec = input as Record<string, unknown>;
  const server = typeof rec['server'] === 'string' ? rec['server'].trim() : '';
  const tool = typeof rec['tool'] === 'string' ? rec['tool'].trim() : '';
  if (!server || !tool) return null;
  const mapped = `mcp__${server}__${tool}`;
  return MCP_REAL_TOOL_DISPLAY_RE.test(mapped) ? mapped : null;
}
