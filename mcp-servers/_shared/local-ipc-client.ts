import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { StringDecoder } from 'string_decoder';

const IPC_HASH_DEBUG = process.env['LIONCLAW_IPC_HASH_DEBUG'] === '1';

const HELPER_TOKEN_ENV = 'LIONCLAW_HELPER_TOKEN';
const EXTERNAL_CLIENT_ENV = 'LIONCLAW_CLIENT';
const EXTERNAL_CLIENT_DETAIL_ENV = 'LIONCLAW_CLIENT_DETAIL';

export interface ExternalClientIdentity {
  id: string;
  detail?: string | null;
}

export function readEnvExternalClient(): ExternalClientIdentity | null {
  const id = process.env[EXTERNAL_CLIENT_ENV];
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  const detail = process.env[EXTERNAL_CLIENT_DETAIL_ENV];
  return {
    id: id.trim(),
    detail: typeof detail === 'string' && detail.trim().length > 0 ? detail.trim() : null,
  };
}

function probeLine(line: string): { sha256: string; bytes: number } {
  const buf = Buffer.from(line, 'utf8');
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    bytes: buf.length,
  };
}

export type IpcTransport = 'unix' | 'pipe';

export interface IpcEndpoint {
  transport: IpcTransport;
  address: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface LocalIpcClientOptions {
  lionclawHome?: string;

  maxRetries?: number;

  baseBackoffMs?: number;

  maxBackoffMs?: number;

  callTimeoutMs?: number;

  externalClient?: ExternalClientIdentity | null;

  expectedKanbanProtocol?: number;
}

export interface CallOptions {
  idempotent?: boolean;
  timeoutMs?: number;
}

export interface TurnBinding {
  sessionId?: string;
  turnId?: string;
  lane?: string;
}

function readTrimmedEnv(name: string): string | undefined {
  const raw = process.env[name];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

export function readEnvTurnBinding(): TurnBinding {
  const sessionId = readTrimmedEnv('LIONCLAW_MCP_SESSION_ID');
  const turnId = readTrimmedEnv('LIONCLAW_MCP_TURN_ID');
  const lane = readTrimmedEnv('LIONCLAW_MCP_LANE');
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(lane ? { lane } : {}),
  };
}

export function turnBindingFromMeta(extra: unknown): TurnBinding {
  const meta = (extra as { _meta?: { lionclaw?: unknown } } | undefined)?._meta?.lionclaw;
  if (!meta || typeof meta !== 'object') return {};
  const record = meta as Record<string, unknown>;
  const pick = (key: string): string | undefined =>
    typeof record[key] === 'string' && (record[key] as string).trim() ? (record[key] as string).trim() : undefined;
  const sessionId = pick('sessionId');
  const turnId = pick('turnId');
  const lane = pick('lane');
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(lane ? { lane } : {}),
  };
}

export function withTurnBinding(params: Record<string, unknown>, extra?: unknown): Record<string, unknown> {
  return { ...readEnvTurnBinding(), ...turnBindingFromMeta(extra), ...params };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface PendingCall {
  id: number;
  method: string;
  params: unknown;
  idempotent: boolean;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  retried: boolean;
}

function defaultLionclawHome(): string {
  return path.join(os.homedir(), '.lionclaw');
}

function endpointFilePath(lionclawHome: string): string {
  return path.join(lionclawHome, 'runtime', 'ipc-endpoint.json');
}

export function readEndpoint(lionclawHome: string = defaultLionclawHome()): IpcEndpoint {
  const file = endpointFilePath(lionclawHome);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read IPC endpoint config at ${file}: ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in IPC endpoint config at ${file}: ${message}`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { transport?: unknown }).transport !== 'string' ||
    typeof (parsed as { address?: unknown }).address !== 'string'
  ) {
    throw new Error(`Malformed IPC endpoint config at ${file}: expected { transport, address }`);
  }
  const transport = (parsed as { transport: string }).transport;
  if (transport !== 'unix' && transport !== 'pipe') {
    throw new Error(`Unknown IPC transport "${transport}" in ${file}`);
  }
  return {
    transport,
    address: (parsed as { address: string }).address,
  };
}

export function endpointFileExists(lionclawHome: string = defaultLionclawHome()): boolean {
  return fs.existsSync(endpointFilePath(lionclawHome));
}

export class LocalIpcClient {
  private readonly lionclawHome: string;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly callTimeoutMs: number;
  private readonly externalClient: ExternalClientIdentity | null;
  private readonly expectedKanbanProtocol: number | null;
  private readonly handshakePending = new Set<number>();
  private handshakeFailure: string | null = null;

  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private closed = false;

  constructor(opts: LocalIpcClientOptions = {}) {
    this.lionclawHome = opts.lionclawHome ?? defaultLionclawHome();
    this.maxRetries = opts.maxRetries ?? 5;
    this.baseBackoffMs = opts.baseBackoffMs ?? 200;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.callTimeoutMs = opts.callTimeoutMs ?? 60_000;
    this.externalClient = opts.externalClient === undefined ? readEnvExternalClient() : opts.externalClient;
    this.expectedKanbanProtocol = opts.expectedKanbanProtocol ?? null;
  }

  close(): void {
    this.closed = true;
    for (const pc of this.pending.values()) {
      clearTimeout(pc.timer);
      pc.reject(new Error('LocalIpcClient closed'));
    }
    this.pending.clear();
    if (this.socket) {
      try {
        this.socket.end();
      } catch {}
      this.socket = null;
    }
  }

  async callMethod(method: string, params: unknown = {}, options: CallOptions = {}): Promise<unknown> {
    if (this.closed) {
      throw new Error('LocalIpcClient is closed');
    }
    return await this.dispatchCall(method, params, false, {
      idempotent: options.idempotent ?? true,
      timeoutMs: options.timeoutMs ?? this.callTimeoutMs,
    });
  }

  private async dispatchCall(
    method: string,
    params: unknown,
    isRetry: boolean,
    options: Required<CallOptions>,
  ): Promise<unknown> {
    const socket = await this.ensureConnected();
    if (this.handshakeFailure) throw new Error(this.handshakeFailure);
    const id = this.nextId++;
    const boundParams = isPlainObject(params) ? { ...readEnvTurnBinding(), ...params } : params;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params: boundParams };

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC call ${method} (id=${id}) timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);

      const pc: PendingCall = {
        id,
        method,
        params,
        idempotent: options.idempotent,
        timeoutMs: options.timeoutMs,
        resolve,
        reject,
        timer,
        retried: isRetry,
      };
      this.pending.set(id, pc);

      try {
        socket.write(JSON.stringify(request) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        const message = err instanceof Error ? err.message : String(err);
        reject(new Error(`Failed to write RPC request: ${message}`));
      }
    });
  }

  private async ensureConnected(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) {
      return this.socket;
    }
    if (this.connecting) {
      return await this.connecting;
    }
    this.connecting = this.connectWithBackoff();
    try {
      const sock = await this.connecting;
      return sock;
    } finally {
      this.connecting = null;
    }
  }

  private async connectWithBackoff(): Promise<net.Socket> {
    let attempt = 0;
    let lastErr: unknown = null;
    while (attempt <= this.maxRetries) {
      try {
        const endpoint = readEndpoint(this.lionclawHome);
        const socket = await this.openSocket(endpoint.address);
        this.attachSocketHandlers(socket);
        this.socket = socket;
        this.buffer = '';
        this.sendHandshake(socket);
        return socket;
      } catch (err) {
        lastErr = err;
        attempt++;
        if (attempt > this.maxRetries) break;
        const backoff = Math.min(this.baseBackoffMs * Math.pow(2, attempt - 1), this.maxBackoffMs);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`Failed to connect to local IPC after ${this.maxRetries} retries: ${message}`);
  }

  private sendHandshake(socket: net.Socket): void {
    const token = process.env[HELPER_TOKEN_ENV];
    if (typeof token === 'string' && token.trim().length > 0) {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'handshake',
        params: { token },
      };
      try {
        socket.write(JSON.stringify(request) + '\n');
      } catch {}
      return;
    }
    if (!this.externalClient) return;
    this.handshakeFailure = null;
    const id = this.nextId++;
    this.handshakePending.add(id);
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method: 'handshake',
      params: {
        client: this.externalClient.id,
        ...(this.externalClient.detail ? { clientDetail: this.externalClient.detail } : {}),
      },
    };
    try {
      socket.write(JSON.stringify(request) + '\n');
    } catch {
      this.handshakePending.delete(id);
    }
  }

  private applyExternalHandshakeResponse(response: JsonRpcResponse): void {
    let failure: string | null = null;
    if (response.error) {
      failure = `handshake recusado pelo LionClaw: ${response.error.message}`;
    } else if (this.expectedKanbanProtocol !== null) {
      const result = isPlainObject(response.result) ? response.result : {};
      const remote = result['kanbanProtocol'];
      if (remote !== this.expectedKanbanProtocol) {
        failure =
          `protocolo do kanban incompativel: LionClaw ${String(remote ?? 'desconhecido')}, ` +
          `cliente ${this.expectedKanbanProtocol}; atualize o LionClaw ou o MCP`;
      }
    }
    if (!failure) return;
    this.handshakeFailure = failure;
    for (const pc of this.pending.values()) {
      clearTimeout(pc.timer);
      pc.reject(new Error(failure));
    }
    this.pending.clear();
  }

  private openSocket(address: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(address);
      const onError = (err: Error) => {
        sock.removeListener('connect', onConnect);
        reject(err);
      };
      const onConnect = () => {
        sock.removeListener('error', onError);
        sock.setEncoding('utf8');
        resolve(sock);
      };
      sock.once('error', onError);
      sock.once('connect', onConnect);
    });
  }

  private attachSocketHandlers(socket: net.Socket): void {
    const decoder = new StringDecoder('utf8');
    socket.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      this.buffer += text;
      let nl = this.buffer.indexOf('\n');
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line.length > 0) {
          this.handleLine(line);
        }
        nl = this.buffer.indexOf('\n');
      }
    });

    socket.on('error', () => {});

    socket.on('close', () => {
      this.handleSocketClosed();
    });
  }

  private handleLine(line: string): void {
    if (IPC_HASH_DEBUG) {
      // eslint-disable-next-line no-console
      console.error(`[lionclaw-ipc-hash] line-read ${JSON.stringify(probeLine(line))}`);
    }
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    const id = typeof response.id === 'number' ? response.id : null;
    if (id == null) return;
    if (this.handshakePending.has(id)) {
      this.handshakePending.delete(id);
      this.applyExternalHandshakeResponse(response);
      return;
    }
    const pc = this.pending.get(id);
    if (!pc) return;
    this.pending.delete(id);
    clearTimeout(pc.timer);
    if (response.error) {
      pc.reject(new Error(`RPC error ${response.error.code}: ${response.error.message}`));
    } else {
      pc.resolve(response.result);
    }
  }

  private handleSocketClosed(): void {
    const wasSocket = this.socket;
    this.socket = null;
    this.buffer = '';
    this.handshakePending.clear();
    if (this.closed) {
      return;
    }
    if (!wasSocket) return;

    const toRetry: PendingCall[] = [];
    const toFail: Array<{ pc: PendingCall; error: Error }> = [];
    for (const pc of this.pending.values()) {
      if (!pc.idempotent) {
        toFail.push({
          pc,
          error: new Error(
            `RPC call ${pc.method} (id=${pc.id}): socket closed before response; ` +
              'a operacao PODE ter completado no servidor - use pipeline_inspect antes de repetir',
          ),
        });
      } else if (pc.retried) {
        toFail.push({
          pc,
          error: new Error(`RPC call ${pc.method} (id=${pc.id}) failed after retry: socket closed`),
        });
      } else {
        toRetry.push(pc);
      }
    }
    this.pending.clear();

    for (const { pc, error } of toFail) {
      clearTimeout(pc.timer);
      pc.reject(error);
    }

    for (const pc of toRetry) {
      clearTimeout(pc.timer);
      void this.retryPendingCall(pc);
    }
  }

  private async retryPendingCall(pc: PendingCall): Promise<void> {
    try {
      const result = await this.dispatchCall(pc.method, pc.params, true, {
        idempotent: pc.idempotent,
        timeoutMs: pc.timeoutMs,
      });
      pc.resolve(result);
    } catch (err) {
      pc.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

let sharedClient: LocalIpcClient | null = null;

export function getSharedClient(opts: LocalIpcClientOptions = {}): LocalIpcClient {
  if (!sharedClient) {
    sharedClient = new LocalIpcClient(opts);
  }
  return sharedClient;
}

export async function callMethod(name: string, params: unknown = {}, options: CallOptions = {}): Promise<unknown> {
  return await getSharedClient().callMethod(name, params, options);
}

export function assertEndpointPresentOrExit(
  lionclawHome: string = defaultLionclawHome(),
  logger: (line: string) => void = (line) => {
    // eslint-disable-next-line no-console
    console.error(line);
  },
): void {
  const file = endpointFilePath(lionclawHome);
  if (!fs.existsSync(file)) {
    logger(`[lionclaw-mcp] IPC endpoint config not found at ${file}. ` + `Start LionClaw main process first.`);
    process.exit(1);
  }
}
