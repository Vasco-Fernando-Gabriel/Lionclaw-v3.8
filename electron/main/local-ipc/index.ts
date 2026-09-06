
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger';
import { textProbe } from '../pipeline-shared/text-probe';
import { resolveHelperTokenOwner } from '../helper-identity';
import {
  dispatch,
  type JsonRpcContext,
  type JsonRpcRequest,
  type LocalIpcConnectionIdentity,
} from './jsonrpc-methods';
import {
  listenUnix,
  cleanupUnix,
  ensureRuntimeDir as ensureRuntimeDirUnix,
  getRuntimeDir as getRuntimeDirUnix,
  type UnixListenResult,
} from './platform-unix';
import {
  listenWindows,
  cleanupWindows,
  ensureRuntimeDir as ensureRuntimeDirWindows,
  getRuntimeDir as getRuntimeDirWindows,
  type WindowsListenResult,
} from './platform-windows';

const logger = createLogger('local-ipc');

type ListenResult = UnixListenResult | WindowsListenResult;

interface ServerState {
  server: net.Server;
  address: string;
  transport: 'unix' | 'pipe';
  endpointFile: string;
}

let state: ServerState | null = null;
let windowProvider: (() => BrowserWindow | null) | null = null;
const clientSockets = new Set<net.Socket>();

function destroyClientSockets(): void {
  for (const socket of clientSockets) socket.destroy();
  clientSockets.clear();
}


export function registerWindowProvider(provider: () => BrowserWindow | null): void {
  windowProvider = provider;
}

const connectionStates = new WeakMap<net.Socket, LocalIpcConnectionIdentity>();

function ensureConnectionState(socket: net.Socket): LocalIpcConnectionIdentity {
  let state = connectionStates.get(socket);
  if (!state) {
    state = { authenticatedHelper: false, connectionId: randomUUID() };
    connectionStates.set(socket, state);
  }
  return state;
}

function getContext(connection?: LocalIpcConnectionIdentity): JsonRpcContext {
  return {
    getWindow: () => (windowProvider ? windowProvider() : null),
    connection,
  };
}

function getRuntimeDir(): string {
  return process.platform === 'win32' ? getRuntimeDirWindows() : getRuntimeDirUnix();
}

function getEndpointFilePath(): string {
  return path.join(getRuntimeDir(), 'ipc-endpoint.json');
}

async function writeEndpointFile(transport: 'unix' | 'pipe', address: string): Promise<string> {
  const file = getEndpointFilePath();
  const payload = JSON.stringify({ transport, address });
  await fs.promises.writeFile(file, payload, { encoding: 'utf8' });
  if (process.platform !== 'win32') {
    try {
      await fs.promises.chmod(file, 0o600);
    } catch (err) {
      logger.warn({ err }, 'chmod failed for ipc-endpoint.json (best-effort)');
    }
  }
  return file;
}

async function removeEndpointFile(file: string): Promise<void> {
  try {
    await fs.promises.unlink(file);
  } catch {
  }
}


function handleConnection(socket: net.Socket): void {
  let buffer = '';
  clientSockets.add(socket);
  socket.setEncoding('utf8');
  ensureConnectionState(socket);

  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line.length > 0) {
        void handleLine(socket, line);
      }
      newlineIdx = buffer.indexOf('\n');
    }
  });

  socket.on('error', (err) => {
    logger.warn({ err: err.message }, 'client socket error');
  });
  socket.on('close', () => clientSockets.delete(socket));
}

async function handleLine(socket: net.Socket, line: string): Promise<void> {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(line) as JsonRpcRequest;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const response = {
      jsonrpc: '2.0' as const,
      id: null,
      error: { code: -32700, message: `Parse error: ${message}` },
    };
    writeResponse(socket, response);
    return;
  }
  if (!req || typeof req.method !== 'string') {
    writeResponse(socket, {
      jsonrpc: '2.0',
      id: req && req.id != null ? req.id : null,
      error: { code: -32600, message: 'Invalid Request' },
    });
    return;
  }
  if (req.method === 'handshake') {
    writeResponse(socket, handleHandshake(socket, req));
    return;
  }
  try {
    const response = await dispatch(getContext(connectionStates.get(socket)), req);
    writeResponse(socket, response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeResponse(socket, {
      jsonrpc: '2.0',
      id: req.id ?? null,
      error: { code: -32603, message: `Internal error: ${message}` },
    });
  }
}

function handleHandshake(
  socket: net.Socket,
  req: JsonRpcRequest,
): { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: { code: number; message: string } } {
  const id = req.id ?? null;
  const params = (req.params ?? {}) as { token?: unknown };
  const token = typeof params.token === 'string' ? params.token.trim() : '';
  const connection = ensureConnectionState(socket);

  if (token.length === 0 || token === 'none') {
    logger.debug('handshake sem token (client nao-gated) — conexao segue anonima');
    return { jsonrpc: '2.0', id, result: { ok: true, authenticated: false } };
  }

  const serverId = resolveHelperTokenOwner(token);
  if (serverId) {
    connection.authenticatedHelper = true;
    connection.serverId = serverId;
    logger.info({ authenticated: true, serverId }, 'conexao local-ipc autenticada via handshake (S3b)');
    return { jsonrpc: '2.0', id, result: { ok: true, authenticated: true, serverId } };
  }

  logger.warn(
    { authenticated: connection.authenticatedHelper },
    'handshake com token de helper desconhecido — conexao NAO autenticada',
  );
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32001, message: 'handshake: token de helper desconhecido' },
  };
}

function writeResponse(socket: net.Socket, response: unknown): void {
  try {
    const line = JSON.stringify(response);
    const id = (response as { id?: number | string | null } | null)?.id ?? null;
    logger.debug({ id, probe: textProbe(line) }, '(F8) jsonrpc linha escrita');
    socket.write(line + '\n');
  } catch (err) {
    logger.warn({ err }, 'failed to write response');
  }
}


export async function startLocalIpcServer(): Promise<void> {
  if (state) {
    logger.warn('startLocalIpcServer called while already running - ignoring');
    return;
  }

  if (process.platform === 'win32') {
    await ensureRuntimeDirWindows();
  } else {
    await ensureRuntimeDirUnix();
  }

  const listenResult: ListenResult =
    process.platform === 'win32'
      ? await listenWindows(handleConnection)
      : await listenUnix(handleConnection);

  const endpointFile = await writeEndpointFile(listenResult.transport, listenResult.address);

  state = {
    server: listenResult.server,
    address: listenResult.address,
    transport: listenResult.transport,
    endpointFile,
  };

  logger.info(
    { transport: listenResult.transport, address: listenResult.address, endpointFile },
    'local-ipc server started',
  );
}

export async function stopLocalIpcServer(): Promise<void> {
  if (!state) return;
  const { server, address, transport, endpointFile } = state;
  state = null;
  destroyClientSockets();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    setTimeout(() => resolve(), 2000).unref();
  });

  if (transport === 'unix') {
    await cleanupUnix(address);
  } else {
    await cleanupWindows(address);
  }

  await removeEndpointFile(endpointFile);

  logger.info({ transport, address }, 'local-ipc server stopped');
}

export function getCurrentEndpoint():
  | { transport: 'unix' | 'pipe'; address: string; endpointFile: string }
  | null {
  if (!state) return null;
  return {
    transport: state.transport,
    address: state.address,
    endpointFile: state.endpointFile,
  };
}
