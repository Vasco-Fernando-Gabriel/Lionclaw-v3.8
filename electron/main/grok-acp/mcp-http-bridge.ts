import crypto from 'crypto';
import http from 'http';
import type { AddressInfo, Socket } from 'net';
import type { GrokExternalTool } from '../agent-runtime/grok-session-config';
import type { GrokAcpMcpServerEntry } from './types';

const MCP_PATH = '/mcp';
const PROTOCOL_VERSION = '2025-11-25';
const STOP_FALLBACK_MS = 2_000;
export const GROK_MCP_MAX_BODY_BYTES = 1024 * 1024;
export const GROK_MCP_MAX_ERROR_CHARS = 512;

export interface GrokMcpBridgeConfig {
  tools: GrokExternalTool[];
  serverName?: string;
  serverId?: string;
}

export interface GrokMcpBridge {
  readonly url: string;
  readonly token: string;
  readonly bridgeId: string;
  readonly mcpServerEntry: GrokAcpMcpServerEntry;
  stop(): Promise<void>;
}

const liveBridges = new Map<string, GrokMcpBridge>();

function writeJson(
  response: http.ServerResponse,
  status: number,
  value: Record<string, unknown>,
  headers?: Record<string, string>,
): void {
  response.writeHead(status, { 'Content-Type': 'application/json', ...(headers ?? {}) });
  response.end(JSON.stringify(value));
}

function authorized(request: http.IncomingMessage, token: string): boolean {
  const value = request.headers['authorization'];
  const header = Array.isArray(value) ? value[0] : value;
  return typeof header === 'string' && header.startsWith('Bearer ') && header.slice(7) === token;
}

function schema(tool: GrokExternalTool): Record<string, unknown> {
  return Object.keys(tool.parameters).length > 0 ? tool.parameters : { type: 'object', properties: {} };
}

function safeToolError(error: unknown): string {
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
  return safe.length <= GROK_MCP_MAX_ERROR_CHARS ? safe : `${safe.slice(0, GROK_MCP_MAX_ERROR_CHARS - 1)}…`;
}

async function invokeTool(
  tool: GrokExternalTool,
  args: Record<string, unknown>,
  transportCorrelation: { kind: 'mcp-request-id'; value: string } | undefined,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const result = await tool.handler(args, {
      ...(transportCorrelation ? { transportCorrelation } : {}),
      ...(signal ? { signal } : {}),
    });
    return { content: [{ type: 'text', text: result.output }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `bridge tool error: ${safeToolError(error)}` }],
      isError: true,
    };
  }
}

function rejectPayloadTooLarge(request: http.IncomingMessage, response: http.ServerResponse): void {
  request.pause();
  response.once('finish', () => request.destroy());
  writeJson(
    response,
    413,
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'request body too large' },
    },
    { Connection: 'close' },
  );
}

async function settleBounded(promises: readonly Promise<unknown>[]): Promise<void> {
  if (promises.length === 0) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(finish, STOP_FALLBACK_MS);
    timer.unref?.();
    void Promise.allSettled(promises).then(() => {
      clearTimeout(timer);
      finish();
    });
  });
}

const GROK_MCP_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

export async function startGrokMcpBridge(config: GrokMcpBridgeConfig): Promise<GrokMcpBridge> {
  if (config.tools.length === 0) throw new Error('Cannot start a Grok MCP bridge without tools.');
  const serverName = config.serverName ?? 'lionclaw';
  const serverId = config.serverId ?? 'lionbridge';
  if (!GROK_MCP_NAME_PATTERN.test(serverName)) {
    throw new Error(`Grok MCP bridge server name fora do padrao aceito pelo CLI: "${serverName}"`);
  }
  for (const tool of config.tools) {
    if (tool.name.includes('__')) {
      throw new Error(`Tool do bridge usa namespace MCP aninhado nao aceito pelo Grok: "${tool.name}"`);
    }
    const qualified = `${serverName}__${tool.name}`;
    if (!GROK_MCP_NAME_PATTERN.test(qualified)) {
      throw new Error(`Tool do bridge seria descartada pelo Grok (nome qualificado invalido): "${qualified}"`);
    }
  }
  const token = crypto.randomBytes(32).toString('hex');
  const bridgeId = crypto.randomUUID();
  const tools = new Map(config.tools.map((tool) => [tool.name, tool]));
  const sockets = new Set<Socket>();
  const streams = new Set<http.ServerResponse>();
  const inFlightTools = new Set<{
    controller: AbortController;
    promise: Promise<void>;
  }>();
  let stopping = false;
  let stopPromise: Promise<void> | null = null;

  const server = http.createServer((request, response) => {
    if (!authorized(request, token)) {
      writeJson(response, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } });
      return;
    }
    if ((request.url ?? '').split('?')[0] !== MCP_PATH) {
      writeJson(response, 404, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'not found' } });
      return;
    }
    if (request.method === 'GET') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      response.write(': open\n\n');
      streams.add(response);
      response.once('close', () => streams.delete(response));
      return;
    }
    if (request.method === 'DELETE') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'POST') {
      writeJson(response, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'method not allowed' } });
      return;
    }
    const declaredLength = request.headers['content-length'];
    if (
      typeof declaredLength === 'string' &&
      /^\d+$/.test(declaredLength) &&
      Number(declaredLength) > GROK_MCP_MAX_BODY_BYTES
    ) {
      rejectPayloadTooLarge(request, response);
      return;
    }
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      receivedBytes += chunk.length;
      if (receivedBytes > GROK_MCP_MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        rejectPayloadTooLarge(request, response);
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', () => {
      if (!response.headersSent)
        writeJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    });
    request.once('end', () => {
      if (tooLarge) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        writeJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        return;
      }
      const id = message['id'] ?? null;
      const method = typeof message['method'] === 'string' ? message['method'] : '';
      const params =
        message['params'] && typeof message['params'] === 'object'
          ? (message['params'] as Record<string, unknown>)
          : {};
      if (method === 'initialize') {
        const protocolVersion =
          typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : PROTOCOL_VERSION;
        writeJson(
          response,
          200,
          {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: serverName, version: '1.0.0' },
            },
          },
          { 'Mcp-Session-Id': crypto.randomUUID() },
        );
        return;
      }
      if (method === 'notifications/initialized') {
        response.writeHead(202);
        response.end();
        return;
      }
      if (method === 'tools/list') {
        writeJson(response, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [...tools.values()].map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: schema(tool),
            })),
          },
        });
        return;
      }
      if (method === 'tools/call') {
        const name = typeof params['name'] === 'string' ? params['name'] : '';
        const tool = tools.get(name);
        if (!tool) {
          writeJson(response, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } });
          return;
        }
        const args =
          params['arguments'] && typeof params['arguments'] === 'object'
            ? (params['arguments'] as Record<string, unknown>)
            : {};
        if (stopping) {
          writeJson(response, 200, {
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: 'bridge is stopping' },
          });
          return;
        }
        const call = {
          controller: new AbortController(),
          promise: Promise.resolve(),
        };
        call.promise = invokeTool(
          tool,
          args,
          typeof id === 'string' || typeof id === 'number' ? { kind: 'mcp-request-id', value: String(id) } : undefined,
          call.controller.signal,
        )
          .then((result) => {
            if (!response.destroyed && !response.writableEnded && !response.headersSent) {
              writeJson(response, 200, { jsonrpc: '2.0', id, result });
            }
          })
          .finally(() => inFlightTools.delete(call));
        inFlightTools.add(call);
        return;
      }
      writeJson(response, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    });
  });

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const url = await new Promise<string>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address === 'string') {
        reject(new Error('Grok MCP bridge did not receive a TCP address.'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}${MCP_PATH}`);
    });
  });

  const mcpServerEntry: GrokAcpMcpServerEntry = {
    id: serverId,
    name: serverName,
    type: 'http',
    url,
    headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    env: [],
  };

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      liveBridges.delete(bridgeId);
      for (const call of inFlightTools) {
        call.controller.abort(new Error('Grok MCP bridge stopped'));
      }
      try {
        await settleBounded([...inFlightTools].map((call) => call.promise));
      } finally {
        for (const stream of streams) {
          try {
            stream.end();
          } catch {
            /* best effort */
          }
        }
        streams.clear();
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, STOP_FALLBACK_MS);
          timer.unref?.();
          server.close(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    })();
    return stopPromise;
  };

  const bridge: GrokMcpBridge = { url, token, bridgeId, mcpServerEntry, stop };
  liveBridges.set(bridgeId, bridge);
  return bridge;
}

export async function stopAllGrokMcpBridges(): Promise<void> {
  await Promise.allSettled([...liveBridges.values()].map((bridge) => bridge.stop()));
  liveBridges.clear();
}

export function _grokBridgeCountForTests(): number {
  return liveBridges.size;
}
