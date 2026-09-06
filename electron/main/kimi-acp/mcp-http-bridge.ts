
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Socket } from 'net';
import type { KimiExternalTool } from '../agent-runtime/kimi-external-tools';
import type { KimiAcpMcpServerEntry } from './types';
import { callTool, redactKimiBridgeError, toListItem } from './mcp-bridge-tools';
import { getKimiBridgeRegistry } from './mcp-bridge-registry';
import { createLogger } from '../logger';

const logger = createLogger('kimi-acp:mcp-http-bridge');

const BRIDGE_TOKEN_PROBE_PENDING = false;

const DEFAULT_PROTOCOL_VERSION = '2025-11-25';

const BRIDGE_PATH = '/mcp';

const STOP_FALLBACK_MS = 2000;
export const KIMI_MCP_MAX_BODY_BYTES = 1024 * 1024;

const TOKEN_HEADER_NAMES = ['authorization', 'x-lionclaw-bridge-token'] as const;

const ENTRY_TOKEN_HEADER_NAME = 'Authorization';

export interface KimiMcpBridgeConfig {
  tools: KimiExternalTool[];
  serverName?: string;
  serverId?: string;
}

export interface KimiMcpBridge {
  readonly url: string;
  readonly token: string;
  readonly mcpServerEntry: KimiAcpMcpServerEntry;
  readonly bridgeId: string;
  stop(): Promise<void>;
}

interface BridgeSession {
  initialized: boolean;
  sse: http.ServerResponse | null;
}

interface InFlightToolCall {
  controller: AbortController;
  promise: Promise<void>;
}

function readTokenHeader(req: http.IncomingMessage): string | undefined {
  for (const name of TOKEN_HEADER_NAMES) {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  const header = readTokenHeader(req);
  if (header === undefined) {
    return BRIDGE_TOKEN_PROBE_PENDING;
  }
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  return presented === token;
}

function writeJsonRpc(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) });
  res.end(payload);
}

function rejectPayloadTooLarge(req: http.IncomingMessage, res: http.ServerResponse): void {
  req.pause();
  res.once('finish', () => req.destroy());
  writeJsonRpc(res, 413, {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message: 'request body too large' },
  }, { Connection: 'close' });
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

export async function startKimiMcpBridge(config: KimiMcpBridgeConfig): Promise<KimiMcpBridge> {
  if (config.tools.length === 0) {
    throw new Error('startKimiMcpBridge: refusing to start a bridge for an empty tool set (no-bridge profile)');
  }

  const serverName = config.serverName ?? 'LionClaw Bridge';
  const serverId = config.serverId ?? 'lionbridge';
  const token = crypto.randomBytes(32).toString('hex');
  const bridgeId = crypto.randomUUID();

  const tools = new Map<string, KimiExternalTool>();
  for (const tool of config.tools) {
    tools.set(tool.name, tool);
  }

  const sessions = new Map<string, BridgeSession>();
  const sockets = new Set<Socket>();
  const inFlightTools = new Set<InFlightToolCall>();
  let stopping = false;
  let stopPromise: Promise<void> | null = null;

  function onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!isAuthorized(req, token)) {
      writeJsonRpc(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } });
      return;
    }

    const reqPath = (req.url ?? '').split('?')[0];
    if (reqPath !== BRIDGE_PATH) {
      writeJsonRpc(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'not found' } });
      return;
    }

    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': open\n\n');
      const sessionId = headerString(req.headers['mcp-session-id']);
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          session.sse = res;
        } else {
          sessions.set(sessionId, { initialized: false, sse: res });
        }
      }
      return;
    }

    if (req.method === 'POST') {
      const contentLengthHeader = headerString(req.headers['content-length']);
      const contentLength = contentLengthHeader === undefined ? null : Number(contentLengthHeader);
      if (contentLength !== null && Number.isFinite(contentLength) && contentLength > KIMI_MCP_MAX_BODY_BYTES) {
        rejectPayloadTooLarge(req, res);
        return;
      }
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      let rejected = false;
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        receivedBytes += chunk.length;
        if (receivedBytes > KIMI_MCP_MAX_BODY_BYTES) {
          rejected = true;
          rejectPayloadTooLarge(req, res);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (rejected) return;
        const raw = Buffer.concat(chunks).toString('utf8');
        let msg: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
        try {
          msg = JSON.parse(raw) as typeof msg;
        } catch {
          writeJsonRpc(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
          return;
        }
        routePost(req, res, msg);
      });
      req.on('error', () => {
        if (!res.headersSent) {
          writeJsonRpc(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        }
      });
      return;
    }

    writeJsonRpc(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'method not allowed' } });
  }

  function routePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    msg: { id?: unknown; method?: unknown; params?: Record<string, unknown> },
  ): void {
    const method = typeof msg.method === 'string' ? msg.method : '';
    const id = msg.id ?? null;

    if (method === 'initialize') {
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, { initialized: false, sse: null });
      const params = msg.params ?? {};
      const clientVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
      writeJsonRpc(
        res,
        200,
        {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: clientVersion ?? DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: serverName, version: '1.0.0' },
          },
        },
        { 'Mcp-Session-Id': sessionId },
      );
      return;
    }

    if (method === 'notifications/initialized') {
      const sessionId = headerString(req.headers['mcp-session-id']);
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          session.initialized = true;
        }
      }
      res.writeHead(202);
      res.end();
      return;
    }

    if (method === 'tools/list') {
      writeJsonRpc(res, 200, {
        jsonrpc: '2.0',
        id,
        result: { tools: [...tools.values()].map(toListItem) },
      });
      return;
    }

    if (method === 'tools/call') {
      const params = msg.params ?? {};
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = tools.get(name);
      if (!tool) {
        writeJsonRpc(res, 200, {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'unknown tool: ' + name },
        });
        return;
      }
      const rawArgs = params.arguments;
      const args: Record<string, unknown> =
        rawArgs !== null && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};
      if (stopping) {
        writeJsonRpc(res, 200, {
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: 'bridge is stopping' },
        });
        return;
      }
      const call: InFlightToolCall = {
        controller: new AbortController(),
        promise: Promise.resolve(),
      };
      call.promise = callTool(tool, args, {
        ...(typeof id === 'string' || typeof id === 'number'
          ? { transportCorrelation: { kind: 'mcp-request-id' as const, value: String(id) } }
          : {}),
        signal: call.controller.signal,
      }).then(
        (result) => {
          if (!res.destroyed && !res.writableEnded && !res.headersSent) {
            writeJsonRpc(res, 200, { jsonrpc: '2.0', id, result });
          }
        },
        (err: unknown) => {
          if (!res.destroyed && !res.writableEnded && !res.headersSent) {
            writeJsonRpc(res, 200, {
              jsonrpc: '2.0',
              id,
              error: { code: -32603, message: `bridge tool error: ${redactKimiBridgeError(err)}` },
            });
          }
        },
      ).finally(() => inFlightTools.delete(call));
      inFlightTools.add(call);
      return;
    }

    writeJsonRpc(res, 200, {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'method not found: ' + method },
    });
  }

  const server = http.createServer(onRequest);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const url = await new Promise<string>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address === 'string') {
        reject(new Error('startKimiMcpBridge: server.address() did not return an AddressInfo'));
        return;
      }
      resolve('http://127.0.0.1:' + address.port + BRIDGE_PATH);
    });
  });

  const mcpServerEntry: KimiAcpMcpServerEntry = {
    id: serverId,
    name: serverName,
    type: 'http',
    url,
    headers: [{ name: ENTRY_TOKEN_HEADER_NAME, value: 'Bearer ' + token }],
    env: [],
  };

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      getKimiBridgeRegistry().remove(bridgeId);
      for (const call of inFlightTools) {
        call.controller.abort(new Error('Kimi MCP bridge stopped'));
      }
      try {
        await settleBounded([...inFlightTools].map((call) => call.promise));
      } finally {
        for (const session of sessions.values()) {
          if (session.sse && !session.sse.writableEnded) {
            try {
              session.sse.end();
            } catch {
            }
          }
        }
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            resolve();
          };
          const timer = setTimeout(finish, STOP_FALLBACK_MS);
          timer.unref?.();
          server.close(() => {
            clearTimeout(timer);
            finish();
          });
          for (const socket of sockets) {
            try {
              socket.destroy();
            } catch {
            }
          }
          sockets.clear();
        });
      }
      const address = server.address() as AddressInfo | null;
      logger.debug({ bridgeId, port: address && typeof address !== 'string' ? address.port : null }, 'kimi mcp bridge stopped');
    })();
    return stopPromise;
  }

  const bridge: KimiMcpBridge = {
    url,
    token,
    mcpServerEntry,
    bridgeId,
    stop,
  };

  getKimiBridgeRegistry().register(bridge);

  logger.debug({ bridgeId, url, toolCount: config.tools.length }, 'kimi mcp bridge started');

  return bridge;
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
