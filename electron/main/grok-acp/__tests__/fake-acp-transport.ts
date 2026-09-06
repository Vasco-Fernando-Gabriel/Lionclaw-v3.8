import type {
  GrokAcpTransport,
  GrokAcpTransportFactory,
  GrokAcpRequestOptions,
  GrokAcpSpawnConfig,
} from '../acp-transport';
import { GrokProcessError } from '../errors';
import type { GrokAcpNotification } from '../types';

export interface FakeGrokScript {
  onRequest?: (method: string, params: unknown, transport: FakeGrokAcpTransport) => unknown | Promise<unknown>;
  onNotify?: (method: string, params: unknown, transport: FakeGrokAcpTransport) => void;
}

export class FakeGrokAcpTransport implements GrokAcpTransport {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notificationsSent: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ id: unknown; result: unknown }> = [];
  killed = false;
  private readonly notifications = new Set<(value: GrokAcpNotification) => void>();
  private readonly serverRequests = new Set<(
    id: unknown,
    method: string,
    params: Record<string, unknown>,
  ) => void>();
  private readonly errors = new Set<(error: Error) => void>();

  constructor(private readonly script: FakeGrokScript = {}) {}

  async request(method: string, params?: unknown, options: GrokAcpRequestOptions = {}): Promise<unknown> {
    this.requests.push({ method, params });
    const operation = Promise.resolve(this.script.onRequest
      ? this.script.onRequest(method, params, this)
      : {});
    if (options.timeoutMs === undefined && options.signal === undefined) return operation;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.kill();
        reject(error);
      };
      const onAbort = (): void => fail(new GrokProcessError(`Grok ACP request ${method} aborted.`));
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(
          () => fail(new GrokProcessError(`Grok ACP request ${method} timed out after ${options.timeoutMs}ms.`)),
          options.timeoutMs,
        );
        timer.unref?.();
      }
      void operation.then(
        (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))),
      );
    });
  }

  notify(method: string, params?: unknown): void {
    this.notificationsSent.push({ method, params });
    this.script.onNotify?.(method, params, this);
  }

  respond(id: unknown, result: unknown): void {
    this.responses.push({ id, result });
  }

  onNotification(handler: (value: GrokAcpNotification) => void): () => void {
    this.notifications.add(handler);
    return () => this.notifications.delete(handler);
  }

  onServerRequest(
    handler: (id: unknown, method: string, params: Record<string, unknown>) => void,
  ): () => void {
    this.serverRequests.add(handler);
    return () => this.serverRequests.delete(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    this.errors.add(handler);
    return () => this.errors.delete(handler);
  }

  kill(): void {
    this.killed = true;
  }

  waitClosed(): Promise<boolean> {
    return Promise.resolve(true);
  }

  emitNotification(method: string, params: Record<string, unknown>): void {
    for (const handler of this.notifications) handler({ method, params });
  }

  emitServerRequest(id: unknown, method: string, params: Record<string, unknown>): void {
    for (const handler of this.serverRequests) handler(id, method, params);
  }

  emitError(error: Error): void {
    for (const handler of this.errors) handler(error);
  }
}

export function fakeGrokTransportFactory(
  transport: FakeGrokAcpTransport,
  capture?: (config: GrokAcpSpawnConfig) => void,
): GrokAcpTransportFactory {
  return async (config) => {
    capture?.(config);
    return transport;
  };
}
