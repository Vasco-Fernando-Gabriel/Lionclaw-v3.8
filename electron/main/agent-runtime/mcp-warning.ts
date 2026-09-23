import { createLogger } from '../logger';

const logger = createLogger('mcp-warning');

const warnedAgents = new Set<string>();

export function warnMcpToolsDroppedOnce(args: {
  agentId: string;
  runtime: string;
  provider: string;
  allowedTools: string[];
}): void {
  const droppedTools = args.allowedTools.filter((t) => t.startsWith('mcp__'));
  if (droppedTools.length === 0) return;

  const key = `${args.runtime}:${args.agentId}`;
  if (warnedAgents.has(key)) return;
  warnedAgents.add(key);

  logger.warn(
    {
      agentId: args.agentId,
      runtime: args.runtime,
      provider: args.provider,
      droppedTools,
    },
    `Runtime ${args.runtime} nao suporta MCP tools; ${droppedTools.length} tools dropadas para o agente`,
  );
}

export function warnOncePerAgent(agentId: string, reasonKey: string, payload: Record<string, unknown>): void {
  const key = `${reasonKey}:${agentId}`;
  if (warnedAgents.has(key)) return;
  warnedAgents.add(key);
  logger.warn(payload, reasonKey);
}

export function __resetWarnedAgentsForTests(): void {
  warnedAgents.clear();
}
