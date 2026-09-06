
import { vi } from 'vitest';
import type { AcpTransport, AcpSpawnConfig } from '../acp-transport';
import type { AcpNotification } from '../types';

export class FakeAcpTransport implements AcpTransport {
  public readonly requests: Array<{ method: string; params?: unknown }> = [];
  public readonly notifications: Array<{ method: string; params?: unknown }> = [];
  public readonly responses: Array<{ id: unknown; result: unknown }> = [];
  public readonly killed: string[] = [];

  private readonly notificationHandlers = new Set<(n: AcpNotification) => void>();
  private readonly serverRequestHandlers = new Set<
    (id: unknown, method: string, params: Record<string, unknown>) => void
  >();
  private readonly errorHandlers = new Set<(err: Error) => void>();
  private closed = false;

  public responder: (method: string, params?: unknown) => unknown = () => ({});

  public readonly killSpy = vi.fn();
  public readonly waitClosedSpy = vi.fn();

  request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (this.closed) {
      return Promise.reject(new Error('fake acp transport closed'));
    }
    try {
      return Promise.resolve(this.responder(method, params)).then((result) => {
        if (
          method === 'session/set_config_option' &&
          result && typeof result === 'object' && Object.keys(result as object).length === 0
        ) {
          const input = params as { value?: unknown } | undefined;
          return { currentValue: input?.value };
        }
        return result;
      });
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }

  respond(id: unknown, result: unknown): void {
    this.responses.push({ id, result });
  }

  onNotification(handler: (n: AcpNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(
    handler: (id: unknown, method: string, params: Record<string, unknown>) => void,
  ): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  onError(handler: (err: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  kill(reason: string): void {
    this.killed.push(reason);
    this.killSpy(reason);
    this.closed = true;
  }

  waitClosed(timeoutMs: number): Promise<boolean> {
    this.waitClosedSpy(timeoutMs);
    return Promise.resolve(this.closed);
  }


  pushNotification(method: string, params: Record<string, unknown>): void {
    const n: AcpNotification = { method, params };
    for (const h of this.notificationHandlers) h(n);
  }

  pushServerRequest(id: unknown, method: string, params: Record<string, unknown>): void {
    for (const h of this.serverRequestHandlers) h(id, method, params);
  }

  triggerError(err: Error): void {
    this.closed = true;
    for (const h of this.errorHandlers) h(err);
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export function fakeAcpTransportFactory(
  fake: FakeAcpTransport,
): (config: AcpSpawnConfig) => Promise<AcpTransport> {
  return async (_config: AcpSpawnConfig) => fake;
}
