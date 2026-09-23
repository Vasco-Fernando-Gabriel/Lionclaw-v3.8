import { createSwarmProcessOwner } from '../agent-runtime/swarm-process';

import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { KimiUnavailableError } from '../agent-runtime/kimi-availability';
import { createLogger } from '../logger';
import { DETACH_FOR_TREE_KILL, killProcessTree } from '../kill-process-tree';
import type { AcpNotification } from './types';

const logger = createLogger('kimi-acp:transport');

export class KimiAcpJsonRpcError extends Error {
  constructor(
    message: string,
    public readonly code?: string | number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'KimiAcpJsonRpcError';
  }
}

export interface AcpTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (n: AcpNotification) => void): () => void;
  onServerRequest(handler: (id: unknown, method: string, params: Record<string, unknown>) => void): () => void;
  respond(id: unknown, result: unknown): void;
  onError(handler: (err: Error) => void): () => void;
  kill(reason: string): void;
  waitClosed(timeoutMs: number): Promise<boolean>;
}

export interface AcpSpawnConfig {
  swarmSupervised?: boolean;
  swarmOwnerDirectory?: string;
  binary: string;
  cwd: string;
  env: Record<string, string>;
}

export type AcpTransportFactory = (config: AcpSpawnConfig) => Promise<AcpTransport>;

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

class StdioAcpTransport implements AcpTransport {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly notificationHandlers = new Set<(n: AcpNotification) => void>();
  private readonly serverRequestHandlers = new Set<
    (id: unknown, method: string, params: Record<string, unknown>) => void
  >();
  private readonly errorHandlers = new Set<(err: Error) => void>();
  private buffer = '';
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr.on('data', () => {});
    child.on('exit', (code) => {
      this.fail(new KimiUnavailableError(`kimi acp exited (code=${String(code)})`));
    });
    child.on('error', (err) => {
      this.fail(new KimiUnavailableError(`kimi acp process error: ${err.message}`));
    });
  }

  private fail(err: Error): void {
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    for (const h of this.errorHandlers) h(err);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        logger.warn({ line: line.slice(0, 200) }, 'unparseable kimi acp line ignored');
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = msg['id'];
    if (typeof id === 'number' && this.pending.has(id)) {
      const entry = this.pending.get(id)!;
      this.pending.delete(id);
      if (msg['error']) {
        const errObj = asRec(msg['error']);
        entry.reject(
          new KimiAcpJsonRpcError(
            typeof errObj['message'] === 'string' ? errObj['message'] : 'kimi acp JSON-RPC error',
            typeof errObj['code'] === 'string' || typeof errObj['code'] === 'number' ? errObj['code'] : undefined,
            errObj['data'],
          ),
        );
      } else {
        entry.resolve(msg['result']);
      }
      return;
    }
    const method = typeof msg['method'] === 'string' ? (msg['method'] as string) : '';
    if (!method) return;
    if (msg['id'] !== undefined && msg['result'] === undefined && msg['error'] === undefined) {
      for (const h of this.serverRequestHandlers) h(msg['id'], method, asRec(msg['params']));
      return;
    }
    const notification: AcpNotification = {
      method,
      params: asRec(msg['params']),
    };
    for (const h of this.notificationHandlers) h(notification);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new KimiUnavailableError('kimi acp transport closed'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (err) {
        this.pending.delete(id);
        reject(new KimiUnavailableError(`kimi acp write failed: ${(err as Error).message}`));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {}
  }

  respond(id: unknown, result: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    } catch {}
  }

  onNotification(handler: (n: AcpNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(handler: (id: unknown, method: string, params: Record<string, unknown>) => void): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  onError(handler: (err: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  kill(reason: string): void {
    if (this.closed) return;
    logger.info({ reason }, 'killing kimi acp process');
    try {
      killProcessTree(this.child, 'SIGKILL');
    } catch {}
  }

  waitClosed(timeoutMs: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

export const defaultAcpTransportFactory: AcpTransportFactory = async (config) => {
  const useShell = process.platform === 'win32' && config.binary.toLowerCase().endsWith('.cmd');
  const child = config.swarmSupervised
    ? createSwarmProcessOwner(config.swarmOwnerDirectory).spawnProcess({
        command: config.binary,
        args: ['acp'],
        cwd: config.cwd,
        env: config.env,
        signal: new AbortController().signal,
      })
    : (spawn(config.binary, ['acp'], {
        cwd: config.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: useShell,
        detached: DETACH_FOR_TREE_KILL,
        env: config.env,
      }) as ChildProcessWithoutNullStreams);
  return new StdioAcpTransport(child);
};
