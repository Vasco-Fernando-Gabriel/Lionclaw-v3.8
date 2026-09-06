import type { GrokAcpRegistrableHandle, GrokAcpRunSessionKey } from './types';

function storageKey(key: GrokAcpRunSessionKey): string {
  return [
    key.surface,
    key.ownerKind,
    key.runId,
    key.projectId ?? '',
    key.agentId ?? '',
    key.ownerId ?? '',
  ].join('|');
}

function matches(key: GrokAcpRunSessionKey, scope: Partial<GrokAcpRunSessionKey>): boolean {
  const fields: Array<keyof GrokAcpRunSessionKey> = [
    'surface',
    'ownerKind',
    'runId',
    'projectId',
    'agentId',
    'ownerId',
  ];
  return fields.every((field) => scope[field] === undefined || scope[field] === key[field]);
}

export class GrokAcpLifecycleRegistry {
  private readonly handles = new Map<string, GrokAcpRegistrableHandle>();

  register(handle: GrokAcpRegistrableHandle): void {
    if (!handle.key.runId) throw new Error('Grok ACP runId is required');
    this.handles.set(storageKey(handle.key), handle);
  }

  remove(key: GrokAcpRunSessionKey): void {
    this.handles.delete(storageKey(key));
  }

  matching(scope: Partial<GrokAcpRunSessionKey>): GrokAcpRegistrableHandle[] {
    return [...this.handles.values()].filter((handle) => matches(handle.key, scope));
  }

  size(): number {
    return this.handles.size;
  }

  idleHandles(idleMs: number, now = Date.now()): GrokAcpRegistrableHandle[] {
    return [...this.handles.values()].filter((handle) => {
      if (handle.status === 'running' || handle.status === 'closed' || handle.status === 'failed') return false;
      if (!handle.hasStartedTurn && now - handle.createdAt < 30_000) return false;
      return now - handle.lastActivityAt >= idleMs;
    });
  }

  async closeMatching(scope: Partial<GrokAcpRunSessionKey>): Promise<void> {
    const handles = this.matching(scope);
    await Promise.allSettled(handles.map((handle) => handle.close()));
  }

  async closeAll(): Promise<void> {
    await this.closeMatching({});
    this.handles.clear();
  }
}
