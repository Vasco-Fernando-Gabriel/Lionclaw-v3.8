import { ChildProcess, spawn } from 'child_process';
import { Readable } from 'stream';
import { createLogger } from './logger';
import type { OllamaToolSchema } from './ollama-client';
import { getAppVersion } from './app-version';

const logger = createLogger('mcp-tool-bridge');
const STDERR_PREVIEW_CHARS = 500;
const VERBOSE_MCP_BRIDGE = process.env.LIONCLAW_VERBOSE_MCP_BRIDGE === '1';

const BENIGN_STDERR_PATTERNS = [
  /mcp server running on stdio/i,
  /using existing client port/i,
  /discovering oauth server configuration/i,
  /discovered authorization server/i,
  /connecting to remote server/i,
  /using transport strategy/i,
  /connected to remote server/i,
  /local stdio server running/i,
  /proxy established successfully/i,
  /press ctrl\+c to exit/i,
  /"jsonrpc"\s*:\s*"2\.0"/i,
  /"method"\s*:\s*"(initialize|notifications\/initialized|tools\/list)"/i,
  /\[local.*remote\]/i,
  /\[remote.*local\]/i,
  /shutting down/i,
];

const ERRORISH_STDERR_PATTERN =
  /\b(error|exception|failed|failure|denied|unauthorized|invalid|timeout|enoent|eacces)\b/i;

export function classifyMcpStderr(stderr: string): 'debug' | 'warn' {
  const text = stderr.trim();
  if (!text) return 'debug';
  if (ERRORISH_STDERR_PATTERN.test(text)) return 'warn';
  return BENIGN_STDERR_PATTERNS.some((pattern) => pattern.test(text)) ? 'debug' : 'warn';
}

function logMcpStderr(serverId: string, data: Buffer): void {
  const stderr = data.toString().substring(0, STDERR_PREVIEW_CHARS);
  const level = classifyMcpStderr(stderr);
  if (level === 'debug') {
    if (VERBOSE_MCP_BRIDGE) {
      logger.debug({ serverId, stderr }, 'MCP server stderr');
    }
    return;
  }
  logger.warn({ serverId, stderr }, 'MCP server stderr');
}

export interface McpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpServerConnection {
  serverId: string;
  proc: ChildProcess | undefined;
  ownedBySession: boolean;
  stdoutBuf: string;
  pending: Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void }>;
  nextId: number;
  stdin: NodeJS.WritableStream | null;
}

export interface McpSessionClient {
  connections: McpServerConnection[];
}

export interface McpSetupFailure {
  serverId: string;
  error: string;
}

const JSONRPC_TIMEOUT_MS = 10_000;
const INIT_TIMEOUT_MS = 8_000;

function attachStdoutListener(conn: McpServerConnection, readable: Readable): void {
  (readable as Readable).on('data', (chunk: Buffer) => {
    conn.stdoutBuf += chunk.toString();
    const lines = conn.stdoutBuf.split('\n');
    conn.stdoutBuf = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      const id = msg['id'] as number | undefined;
      if (id !== undefined) {
        const cb = conn.pending.get(id);
        if (cb) {
          conn.pending.delete(id);
          if (msg['error']) {
            const errObj = msg['error'] as Record<string, unknown>;
            cb.reject(new Error(`MCP JSON-RPC error: ${errObj['message'] ?? JSON.stringify(errObj)}`));
          } else {
            cb.resolve(msg);
          }
        }
      }
    }
  });
}

function sendJsonRpc(
  conn: McpServerConnection,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number = JSONRPC_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (signal?.aborted) {
    return Promise.reject(new Error(`MCP server ${conn.serverId}: requisicao ${method} cancelada`));
  }
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    if (!conn.stdin) {
      reject(new Error(`MCP server ${conn.serverId}: stdin nao disponivel`));
      return;
    }

    const id = conn.nextId++;
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      if (!conn.pending.delete(id)) return;
      cleanup();
      reject(new Error(`MCP server ${conn.serverId}: requisicao ${method} cancelada`));
    };

    const timer = setTimeout(() => {
      conn.pending.delete(id);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`MCP server ${conn.serverId}: timeout aguardando resposta para ${method} (${timeoutMs}ms)`));
    }, timeoutMs);

    conn.pending.set(id, {
      resolve: (value) => {
        cleanup();
        resolve(value);
      },
      reject: (err) => {
        cleanup();
        reject(err);
      },
    });

    signal?.addEventListener('abort', onAbort, { once: true });

    conn.stdin.write(request + '\n');
  });
}

async function initializeAndDiscoverTools(
  conn: McpServerConnection,
  signal?: AbortSignal,
): Promise<McpToolDescriptor[]> {
  await sendJsonRpc(
    conn,
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'lionclaw', version: getAppVersion() },
    },
    undefined,
    signal,
  );

  conn.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const toolsResponse = await sendJsonRpc(conn, 'tools/list', {}, undefined, signal);
  const result = toolsResponse['result'] as Record<string, unknown> | undefined;
  const rawTools = result?.['tools'];

  if (!Array.isArray(rawTools)) return [];

  return rawTools
    .map((t: unknown) => {
      const tool = t as Record<string, unknown>;
      return {
        name: (tool['name'] as string) ?? '',
        description: (tool['description'] as string) ?? undefined,
        inputSchema: (tool['inputSchema'] as McpToolDescriptor['inputSchema']) ?? undefined,
      };
    })
    .filter((t) => t.name !== '');
}

export function mcpToolToOpenAISchema(serverId: string, mcpTool: McpToolDescriptor): OllamaToolSchema {
  const properties = mcpTool.inputSchema?.properties ?? {};
  const required = mcpTool.inputSchema?.required;

  const schema: OllamaToolSchema = {
    type: 'function',
    function: {
      name: `mcp__${serverId}__${mcpTool.name}`,
      description: mcpTool.description ?? `Tool ${mcpTool.name} do servidor MCP ${serverId}`,
      parameters: {
        type: 'object',
        properties,
        ...(required && required.length > 0 ? { required } : {}),
      },
    },
  };

  return schema;
}

async function spawnTemporaryMCPServer(
  serverId: string,
  spec: McpServerSpec,
  signal?: AbortSignal,
): Promise<McpServerConnection> {
  if (signal?.aborted) throw new Error(`MCP server ${serverId}: setup cancelado antes do spawn`);
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...(spec.env ?? {}) };

  const proc = spawn(spec.command, spec.args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const conn: McpServerConnection = {
    serverId,
    proc,
    ownedBySession: true,
    stdoutBuf: '',
    pending: new Map(),
    nextId: 1,
    stdin: proc.stdin,
  };

  proc.stderr?.on('data', (data: Buffer) => {
    logMcpStderr(serverId, data);
  });

  proc.on('error', (err) => {
    logger.error({ serverId, err }, 'MCP temporary process error');
    for (const [, cb] of conn.pending) {
      cb.reject(new Error(`MCP server ${serverId} process error: ${err.message}`));
    }
    conn.pending.clear();
  });

  proc.on('exit', (code) => {
    if (VERBOSE_MCP_BRIDGE) {
      logger.debug({ serverId, code }, 'MCP temporary process exited');
    }
    for (const [, cb] of conn.pending) {
      cb.reject(new Error(`MCP server ${serverId} exited unexpectedly (code ${code})`));
    }
    conn.pending.clear();
  });

  if (!proc.stdout) {
    proc.kill();
    throw new Error(`MCP server ${serverId}: stdout nao disponivel apos spawn`);
  }

  attachStdoutListener(conn, proc.stdout as Readable);

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`MCP server ${serverId}: timeout aguardando inicio do processo`));
      }, INIT_TIMEOUT_MS);

      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`MCP server ${serverId}: setup cancelado`));
      };

      proc.on('spawn', () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      });

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  } catch (err) {
    proc.kill();
    throw err;
  }

  if (VERBOSE_MCP_BRIDGE) {
    logger.debug({ serverId, command: spec.command }, 'MCP temporary server spawned');
  }
  return conn;
}

export async function setupMCPsForSession(
  servers: Record<string, McpServerSpec>,
  opts?: { signal?: AbortSignal },
): Promise<{ client: McpSessionClient; tools: OllamaToolSchema[]; failures: McpSetupFailure[] }> {
  const serverEntries = Object.entries(servers);
  if (serverEntries.length === 0) {
    return { client: { connections: [] }, tools: [], failures: [] };
  }

  const connections: McpServerConnection[] = [];
  const allTools: OllamaToolSchema[] = [];
  const failures: McpSetupFailure[] = [];

  for (const [serverId, spec] of serverEntries) {
    let conn: McpServerConnection | undefined;
    try {
      if (VERBOSE_MCP_BRIDGE) {
        logger.debug({ serverId }, 'Setting up MCP server for session');
      }

      conn = await spawnTemporaryMCPServer(serverId, spec, opts?.signal);

      const tools = await initializeAndDiscoverTools(conn, opts?.signal);
      connections.push(conn);
      if (VERBOSE_MCP_BRIDGE) {
        logger.debug({ serverId, toolCount: tools.length }, 'MCP tools discovered');
      }

      for (const tool of tools) {
        allTools.push(mcpToolToOpenAISchema(serverId, tool));
      }
    } catch (err) {
      logger.error({ serverId, err }, 'Failed to setup MCP server for session, skipping');
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ serverId, error: message });
      if (conn) {
        try {
          conn.proc?.kill();
        } catch {
          /* processo já encerrou */
        }
        for (const [, pending] of conn.pending) {
          pending.reject(new Error(`MCP server ${serverId} indisponível: ${message}`));
        }
        conn.pending.clear();
      }
    }
  }

  const client: McpSessionClient = { connections };
  logger.debug({ serverCount: connections.length, toolCount: allTools.length }, 'MCP session setup complete');

  return { client, tools: allTools, failures };
}

export async function teardownMCPsForSession(client: McpSessionClient): Promise<void> {
  for (const conn of client.connections) {
    if (conn.ownedBySession && conn.proc) {
      try {
        conn.proc.kill();
        if (VERBOSE_MCP_BRIDGE) {
          logger.debug({ serverId: conn.serverId }, 'MCP session process killed');
        }
      } catch (err) {
        logger.warn({ serverId: conn.serverId, err }, 'Error killing MCP session process');
      }
    }
    for (const [, cb] of conn.pending) {
      cb.reject(new Error(`MCP session torn down: ${conn.serverId}`));
    }
    conn.pending.clear();
  }

  logger.debug({ count: client.connections.length }, 'MCP session teardown complete');
}

export async function callMCPTool(
  client: McpSessionClient,
  toolName: string,
  args: unknown,
  opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    binding?: { sessionId: string; turnId: string; lane?: string };
  },
): Promise<unknown> {
  const parts = toolName.split('__');
  if (parts.length < 3 || parts[0] !== 'mcp') {
    throw new Error(`callMCPTool: nome de tool invalido (esperado mcp__<server>__<tool>): ${toolName}`);
  }

  const serverId = parts[1];
  const actualToolName = parts.slice(2).join('__');

  const conn = client.connections.find((c) => c.serverId === serverId);
  if (!conn) {
    throw new Error(`callMCPTool: nenhuma conexao ativa para servidor ${serverId}`);
  }

  logger.debug({ serverId, toolName: actualToolName }, 'Calling MCP tool');

  const response = await sendJsonRpc(
    conn,
    'tools/call',
    {
      name: actualToolName,
      arguments: args ?? {},
      ...(opts?.binding ? { _meta: { lionclaw: { ...opts.binding } } } : {}),
    },
    opts?.timeoutMs,
    opts?.signal,
  );

  const result = response['result'] as Record<string, unknown> | undefined;

  return normalizeMcpToolCallResult(result, { serverId, toolName: actualToolName });
}

export interface McpEmptyErrorResult {
  isError: true;
  code: 'MCP-EMPTY';
  content: Array<{ type: 'text'; text: string }>;
}

export function isMcpEmptyErrorResult(value: unknown): value is McpEmptyErrorResult {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { isError?: unknown }).isError === true &&
    (value as { code?: unknown }).code === 'MCP-EMPTY'
  );
}

export function normalizeMcpToolCallResult(result: unknown, ctx: { serverId: string; toolName: string }): unknown {
  if (result !== null && result !== undefined) return result;
  const empty: McpEmptyErrorResult = {
    isError: true,
    code: 'MCP-EMPTY',
    content: [
      {
        type: 'text',
        text: `MCP-EMPTY: tool ${ctx.toolName} do servidor ${ctx.serverId} retornou resposta vazia. Tente de novo ou verifique o servidor MCP correspondente.`,
      },
    ],
  };
  logger.warn(
    { serverId: ctx.serverId, toolName: ctx.toolName, code: 'MCP-EMPTY' },
    'MCP tools/call returned empty result',
  );
  return empty;
}
