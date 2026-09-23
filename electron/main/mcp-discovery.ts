import { createLogger } from './logger';
import { getSetting, setSetting } from './db';
import { getClaudeSdkProcessOptions } from './pipeline-shared/sdk-bootstrap';
import { SDK_DISALLOWED_TOOLS } from './agent-runtime/sdk-tool-names';

const logger = createLogger('mcp-discovery');

export interface McpServerStatus {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  serverInfo?: {
    name: string;
    version: string;
  };
  error?: string;
  config?: Record<string, unknown>;
  scope?: string;
  tools?: Array<{
    name: string;
    description?: string;
    annotations?: {
      readOnly?: boolean;
      destructive?: boolean;
      openWorld?: boolean;
    };
  }>;
}

let sdkMcpCache: McpServerStatus[] = [];
let discoveryPromise: Promise<void> | null = null;
let lastDiscoveryAt = 0;

const DISABLED_SDK_MCPS_KEY = 'sdk_mcp_disabled';

export async function discoverSDKMcpServers(): Promise<McpServerStatus[]> {
  if (discoveryPromise) return discoveryPromise.then(() => sdkMcpCache);

  if (Date.now() - lastDiscoveryAt < 5 * 60 * 1000 && sdkMcpCache.length > 0) {
    return sdkMcpCache;
  }

  discoveryPromise = _runDiscovery();
  await discoveryPromise;
  discoveryPromise = null;
  return sdkMcpCache;
}

async function _runDiscovery(): Promise<void> {
  try {
    const runtime = (getSetting('orchestrator_runtime') || '').trim();
    if (runtime !== 'claude-sdk') {
      const { recordSystemActivity } = await import('./activity-log');
      logger.info(
        { runtime },
        'MCP discovery pulada: orquestrador nao e claude-sdk (enriquecimento por LLM desligado)',
      );
      recordSystemActivity({
        id: `mcp-discovery-skip-${Date.now()}`,
        label: 'mcp-discovery pulado',
        description: `enriquecimento por LLM desligado: orquestrador nao e claude-sdk (${runtime || 'nao configurado'})`,
      });
      return;
    }

    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const abortController = new AbortController();

    const orchestratorModel = (getSetting('orchestrator_model') || '').trim();
    const q = query({
      prompt: 'List MCP servers',
      options: {
        ...getClaudeSdkProcessOptions(),
        ...(orchestratorModel ? { model: orchestratorModel } : {}),
        settingSources: ['project', 'user'],
        allowedTools: [],
        disallowedTools: [...SDK_DISALLOWED_TOOLS],
        maxTurns: 1,
        abortController,
        env: { ...process.env, MCP_CONNECTION_NONBLOCKING: '0' },
      },
    });

    const statuses = await q.mcpServerStatus();

    sdkMcpCache = statuses as McpServerStatus[];
    lastDiscoveryAt = Date.now();

    logger.info(
      { count: statuses.length, servers: statuses.map((s: McpServerStatus) => s.name) },
      'SDK MCP servers discovered',
    );

    abortController.abort();

    try {
      for await (const _ of q) {
      }
    } catch {}
  } catch (error) {
    logger.error({ error, code: 'MCP-DISCOVERY-FAIL' }, 'MCP discovery failed');
  }
}

export function getCachedSDKMcpServers(): McpServerStatus[] {
  return sdkMcpCache;
}

export async function refreshSDKMcpServers(): Promise<McpServerStatus[]> {
  lastDiscoveryAt = 0;
  return discoverSDKMcpServers();
}

export function getDisabledSDKMcps(): string[] {
  const raw = getSetting(DISABLED_SDK_MCPS_KEY);
  return raw ? JSON.parse(raw) : [];
}

export function setSDKMcpDisabled(serverName: string, disabled: boolean): void {
  const current = new Set(getDisabledSDKMcps());

  if (disabled) {
    current.add(serverName);
  } else {
    current.delete(serverName);
  }

  setSetting(DISABLED_SDK_MCPS_KEY, JSON.stringify([...current]));
  logger.info({ serverName, disabled }, 'SDK MCP toggle updated');
}
