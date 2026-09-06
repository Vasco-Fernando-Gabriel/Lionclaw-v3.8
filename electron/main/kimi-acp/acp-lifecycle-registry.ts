
import { createLogger } from '../logger';
import type { KimiAcpRunSessionKey, KimiAcpRegistrableHandle } from './types';

const logger = createLogger('kimi-acp:lifecycle-registry');

export const MAX_LIVE_KIMI_ACP_PROCESSES = 6;

export const KIMI_ACP_IDLE_REAP_MS = 120_000;

export const KIMI_ACP_YOUNG_GRACE_MS = 30_000;

export const KIMI_ACP_IDLE_SWEEP_MS = 60_000;

export class KimiAcpLifecycleRegistry {
  private readonly runs = new Map<string, KimiAcpRegistrableHandle>();

  private storageKey(key: KimiAcpRunSessionKey): string {
    return [
      key.surface,
      key.ownerKind,
      key.runId,
      key.projectId ?? '',
      key.agentId ?? '',
      key.ownerId ?? '',
    ].join('|');
  }

  private keyMatchesScope(
    key: KimiAcpRunSessionKey,
    scope: Partial<KimiAcpRunSessionKey>,
  ): boolean {
    const fields: Array<keyof KimiAcpRunSessionKey> = [
      'surface',
      'ownerKind',
      'runId',
      'projectId',
      'agentId',
      'ownerId',
    ];
    for (const field of fields) {
      const scopeVal = scope[field];
      if (scopeVal === undefined) continue;
      if (key[field] !== scopeVal) return false;
    }
    return true;
  }

  register(key: KimiAcpRunSessionKey, handle: KimiAcpRegistrableHandle): void {
    if (!key.runId) {
      throw new Error('register: KimiAcpRunSessionKey.runId is required');
    }
    const storageKey = this.storageKey(key);
    if (this.runs.has(storageKey)) {
      throw new Error(`register: duplicate live Kimi ACP run identity: ${key.runId}`);
    }
    this.runs.set(storageKey, handle);
    logger.debug({ runId: key.runId, surface: key.surface }, 'kimi acp run registered');
  }

  get(key: KimiAcpRunSessionKey): KimiAcpRegistrableHandle | undefined {
    return this.runs.get(this.storageKey(key));
  }

  matching(scope: Partial<KimiAcpRunSessionKey>): KimiAcpRegistrableHandle[] {
    const out: KimiAcpRegistrableHandle[] = [];
    for (const handle of this.runs.values()) {
      if (this.keyMatchesScope(handle.key, scope)) out.push(handle);
    }
    return out;
  }

  hasActiveRun(scope: Partial<KimiAcpRunSessionKey>): boolean {
    for (const handle of this.runs.values()) {
      if (!this.keyMatchesScope(handle.key, scope)) continue;
      if (handle.status === 'closed' || handle.status === 'failed') continue;
      return true;
    }
    return false;
  }

  hasActiveRunsOutsideScope(scope: Partial<KimiAcpRunSessionKey>): boolean {
    for (const handle of this.runs.values()) {
      if (handle.status === 'closed' || handle.status === 'failed') continue;
      if (!this.keyMatchesScope(handle.key, scope)) return true;
    }
    return false;
  }

  remove(key: KimiAcpRunSessionKey, handle: KimiAcpRegistrableHandle): boolean {
    const storageKey = this.storageKey(key);
    if (this.runs.get(storageKey) !== handle) return false;
    return this.runs.delete(storageKey);
  }

  size(): number {
    return this.runs.size;
  }

  liveCount(): number {
    let n = 0;
    for (const handle of this.runs.values()) {
      if (handle.status === 'closed' || handle.status === 'failed') continue;
      n += 1;
    }
    return n;
  }

  clear(): void {
    this.runs.clear();
  }


  private isReapSafe(handle: KimiAcpRegistrableHandle, now: number = Date.now()): boolean {
    if (handle.status === 'running') return false; // in-flight turn
    if (handle.key.ownerKind === 'chat') return false; // active chat handle (closes itself per turn)
    if (handle.hasStartedTurn === false) {
      const born = handle.createdAt;
      if (typeof born !== 'number' || now - born < KIMI_ACP_YOUNG_GRACE_MS) return false;
    }
    return true;
  }

  private ageStamp(handle: KimiAcpRegistrableHandle): number {
    return handle.createdAt ?? handle.lastActivityAt ?? 0;
  }

  private detach(handle: KimiAcpRegistrableHandle): void {
    this.remove(handle.key, handle);
  }

  reapSameScope(incoming: KimiAcpRunSessionKey): KimiAcpRegistrableHandle[] {
    const reaped: KimiAcpRegistrableHandle[] = [];
    for (const handle of this.runs.values()) {
      const k = handle.key;
      if (handle.status === 'closed' || handle.status === 'failed') continue;
      if (handle.status === 'running') continue; // never kill an in-flight turn
      if (handle.hasStartedTurn === false) continue; // freshly-spawned sibling, not yet sent
      const sameScope =
        incoming.ownerKind === 'chat'
          ? k.ownerKind === 'chat' && !!incoming.ownerId && k.ownerId === incoming.ownerId
          : k.ownerKind !== 'chat' &&
            k.surface === incoming.surface &&
            k.projectId === incoming.projectId &&
            k.ownerKind === incoming.ownerKind &&
            k.ownerId === incoming.ownerId;
      if (!sameScope) continue;
      if (this.storageKey(k) === this.storageKey(incoming)) continue;
      this.detach(handle);
      reaped.push(handle);
    }
    return reaped;
  }

  reapForCap(
    cap: number = MAX_LIVE_KIMI_ACP_PROCESSES,
    now: number = Date.now(),
  ): KimiAcpRegistrableHandle[] {
    const reaped: KimiAcpRegistrableHandle[] = [];
    const candidates = [...this.runs.values()]
      .filter(
        (h) => h.status !== 'closed' && h.status !== 'failed' && this.isReapSafe(h, now),
      )
      .sort((a, b) => this.ageStamp(a) - this.ageStamp(b));
    let idx = 0;
    while (this.liveCount() >= cap && idx < candidates.length) {
      const handle = candidates[idx++];
      this.detach(handle);
      reaped.push(handle);
    }
    if (reaped.length > 0) {
      logger.warn(
        { cap, reaped: reaped.length, liveAfter: this.liveCount() },
        'KI-2 cap: reaped oldest idle kimi acp handle(s) to stay under cap',
      );
    }
    return reaped;
  }

  reapIdle(
    idleMs: number = KIMI_ACP_IDLE_REAP_MS,
    now: number = Date.now(),
  ): KimiAcpRegistrableHandle[] {
    const reaped: KimiAcpRegistrableHandle[] = [];
    for (const handle of [...this.runs.values()]) {
      if (handle.status === 'closed' || handle.status === 'failed') continue;
      if (!this.isReapSafe(handle, now)) continue;
      const last = handle.lastActivityAt ?? handle.createdAt;
      if (typeof last !== 'number') continue; // no liveness data => leave it to the cap
      if (now - last < idleMs) continue;
      this.detach(handle);
      reaped.push(handle);
    }
    if (reaped.length > 0) {
      logger.warn(
        { idleMs, reaped: reaped.length, liveAfter: this.liveCount() },
        'KI-2 idle reaper: reaped idle kimi acp handle(s)',
      );
    }
    return reaped;
  }
}
