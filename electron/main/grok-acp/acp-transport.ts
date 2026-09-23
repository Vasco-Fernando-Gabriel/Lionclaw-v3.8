import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import which from 'which';
import { createLogger } from '../logger';
import { DETACH_FOR_TREE_KILL, killProcessTree } from '../kill-process-tree';
import { shellEscapePOSIX } from '../shell-escape';
import { GrokJsonRpcError, GrokProcessError } from './errors';
import type { GrokAcpNotification } from './types';

const logger = createLogger('grok-acp:transport');
export const GROK_ACP_MAX_LINE_BYTES = 2 * 1024 * 1024;
export const GROK_ACP_MAX_FOREIGN_LINES = 32;

export interface GrokAcpRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GrokAcpTransport {
  request(method: string, params?: unknown, options?: GrokAcpRequestOptions): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  respond(id: unknown, result: unknown): void;
  onNotification(handler: (value: GrokAcpNotification) => void): () => void;
  onServerRequest(handler: (id: unknown, method: string, params: Record<string, unknown>) => void): () => void;
  onError(handler: (error: Error) => void): () => void;
  kill(reason: string): void;
  waitClosed(timeoutMs: number): Promise<boolean>;
}

export interface GrokAcpSpawnConfig {
  binary: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export type GrokAcpTransportFactory = (config: GrokAcpSpawnConfig) => Promise<GrokAcpTransport>;

export function buildLinuxSandboxPtyInvocation(
  config: GrokAcpSpawnConfig,
  scriptBinary: string,
): { executable: string; args: string[] } {
  const command = `stty raw -echo && exec ${[config.binary, ...config.args].map(shellEscapePOSIX).join(' ')} 2>/dev/null`;
  return {
    executable: scriptBinary,
    args: ['--quiet', '--return', '--flush', '--echo', 'never', '--command', command, '/dev/null'],
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export class StdioGrokAcpTransport implements GrokAcpTransport {
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private processExited = false;
  private terminalErrorSent = false;
  private foreignLines = 0;
  private readonly pending = new Map<
    number,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      cleanup: () => void;
    }
  >();
  private readonly notifications = new Set<(value: GrokAcpNotification) => void>();
  private readonly requests = new Set<(id: unknown, method: string, params: Record<string, unknown>) => void>();
  private readonly errors = new Set<(error: Error) => void>();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly maxLineBytes = GROK_ACP_MAX_LINE_BYTES,
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    child.stderr.on('data', () => undefined);
    child.once('error', (error) => this.fail(new GrokProcessError(`grok ACP process error: ${error.message}`)));
    child.once('exit', (code, signal) => {
      this.processExited = true;
      this.fail(new GrokProcessError(`grok ACP exited (code=${String(code)}, signal=${String(signal)})`));
    });
  }

  private consume(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer += chunk.toString('utf8');
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const rawLine = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(rawLine, 'utf8') > this.maxLineBytes) {
        this.terminateProtocolError(`Grok ACP NDJSON line exceeded ${this.maxLineBytes} bytes.`);
        return;
      }
      const line = rawLine.trim();
      if (!line) continue;
      if (!line.startsWith('{')) {
        this.foreignLines += 1;
        logger.warn(
          { preview: line.slice(0, 200), count: this.foreignLines },
          'ignorando linha fora do protocolo no stream ACP do Grok',
        );
        if (this.foreignLines > GROK_ACP_MAX_FOREIGN_LINES) {
          this.terminateProtocolError(
            `Grok ACP stream excedeu ${GROK_ACP_MAX_FOREIGN_LINES} linhas fora do protocolo.`,
          );
          return;
        }
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('JSON-RPC envelope is not an object');
        }
        this.dispatch(parsed as Record<string, unknown>);
      } catch (error) {
        this.terminateProtocolError(
          `Invalid Grok ACP NDJSON line (${Buffer.byteLength(line, 'utf8')} bytes): ${(error as Error).message}`,
        );
        return;
      }
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxLineBytes) {
      this.terminateProtocolError(`Grok ACP NDJSON buffer exceeded ${this.maxLineBytes} bytes without newline.`);
    }
  }

  private terminateProtocolError(message: string): void {
    const error = new GrokProcessError(message);
    logger.warn({ message }, 'terminating invalid Grok ACP transport');
    try {
      killProcessTree(this.child, 'SIGKILL');
    } catch {
      /* best effort */
    }
    this.fail(error);
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = message['id'];
    if (
      typeof id === 'number' &&
      this.pending.has(id) &&
      (Object.prototype.hasOwnProperty.call(message, 'result') ||
        Object.prototype.hasOwnProperty.call(message, 'error'))
    ) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      pending.cleanup();
      if (message['error'] !== undefined) {
        const error = record(message['error']);
        const code = typeof error['code'] === 'number' || typeof error['code'] === 'string' ? error['code'] : undefined;
        pending.reject(
          new GrokJsonRpcError(typeof error['message'] === 'string' ? error['message'] : 'Grok ACP JSON-RPC error', {
            method: pending.method,
            ...(code !== undefined ? { code } : {}),
            ...(Object.prototype.hasOwnProperty.call(error, 'data') ? { data: error['data'] } : {}),
          }),
        );
      } else {
        pending.resolve(message['result']);
      }
      return;
    }

    const method = typeof message['method'] === 'string' ? message['method'] : '';
    if (!method) return;
    const params = record(message['params']);
    if (message['id'] !== undefined && message['result'] === undefined && message['error'] === undefined) {
      for (const handler of this.requests) handler(message['id'], method, params);
      return;
    }
    for (const handler of this.notifications) handler({ method, params });
  }

  private fail(error: Error): void {
    if (this.terminalErrorSent) return;
    this.terminalErrorSent = true;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    for (const handler of this.errors) handler(error);
  }

  request(method: string, params?: unknown, options: GrokAcpRequestOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new GrokProcessError('Grok ACP transport is closed'));
    if (options.signal?.aborted) {
      return Promise.reject(new GrokProcessError(`Grok ACP request ${method} aborted before send.`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        if (!this.pending.delete(id)) return;
        cleanup();
        const error = new GrokProcessError(`Grok ACP request ${method} aborted.`);
        this.kill(`request-abort:${method}`);
        this.fail(error);
        reject(error);
      };
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      this.pending.set(id, { method, resolve, reject, cleanup });
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          cleanup();
          const error = new GrokProcessError(`Grok ACP request ${method} timed out after ${options.timeoutMs}ms.`);
          this.kill(`request-timeout:${method}`);
          this.fail(error);
          reject(error);
        }, options.timeoutMs);
        timer.unref?.();
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(new GrokProcessError(`Grok ACP write failed: ${(error as Error).message}`));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {}
  }

  respond(id: unknown, result: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    } catch {}
  }

  onNotification(handler: (value: GrokAcpNotification) => void): () => void {
    this.notifications.add(handler);
    return () => this.notifications.delete(handler);
  }

  onServerRequest(handler: (id: unknown, method: string, params: Record<string, unknown>) => void): () => void {
    this.requests.add(handler);
    return () => this.requests.delete(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    this.errors.add(handler);
    return () => this.errors.delete(handler);
  }

  kill(reason: string): void {
    if (this.closed) return;
    logger.debug({ reason }, 'terminating Grok ACP child');
    try {
      killProcessTree(this.child, 'SIGKILL');
    } catch {}
  }

  waitClosed(timeoutMs: number): Promise<boolean> {
    if (this.processExited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

export const defaultGrokAcpTransportFactory: GrokAcpTransportFactory = async (config) => {
  const sandboxedLinux = process.platform === 'linux' && config.args.includes('--sandbox');
  let executable = config.binary;
  let args = config.args;
  if (sandboxedLinux) {
    let scriptBinary: string;
    try {
      scriptBinary = await which('script');
    } catch (error) {
      throw new GrokProcessError(
        'O utilitario script (util-linux) e obrigatorio para aplicar o sandbox Grok em processo ACP sem terminal.',
        { cause: error },
      );
    }
    ({ executable, args } = buildLinuxSandboxPtyInvocation(config, scriptBinary));
  }
  const useShell = process.platform === 'win32' && executable.toLowerCase().endsWith('.cmd');
  const child = spawn(executable, args, {
    cwd: config.cwd,
    env: config.env,
    shell: useShell,
    detached: DETACH_FOR_TREE_KILL,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  return new StdioGrokAcpTransport(child);
};
