import { createLogger } from '../logger';
import type { CodexRunHandle, CodexRunSessionKey } from './types';

const logger = createLogger('codex-runtime:lifecycle-registry');

const SCOPE_BOUNDARY_FIELDS: Array<keyof CodexRunSessionKey> = ['runId', 'projectId', 'ownerId'];

const SCOPE_MATCH_FIELDS: Array<keyof CodexRunSessionKey> = [
  'surface',
  'projectId',
  'phaseNumber',
  'agentId',
  'runId',
  'attemptId',
  'sprintIndex',
  'loopIteration',
  'ownerKind',
  'ownerId',
  'mcpProfile',
];

export const MAX_LIVE_OFFICIAL_APP_SERVERS = 6;

export const OFFICIAL_APP_SERVER_IDLE_REAP_MS = 120_000;

export const OFFICIAL_APP_SERVER_YOUNG_GRACE_MS = 30_000;

export const OFFICIAL_APP_SERVER_IDLE_SWEEP_MS = 60_000;

export interface LoadedThread {
  threadId: string;
  loadedSince?: number;
}

export interface LeakCheckResult {
  leaked: boolean;
  staleThreadIds: string[];
}

export function keyMatchesScope(key: CodexRunSessionKey, scope: Partial<CodexRunSessionKey>): boolean {
  for (const field of SCOPE_MATCH_FIELDS) {
    const scopeVal = scope[field];
    if (scopeVal === undefined) continue;
    if (key[field] !== scopeVal) return false;
  }
  return true;
}

export function assertValidScope(scope: Partial<CodexRunSessionKey>): void {
  const keys = Object.keys(scope) as Array<keyof CodexRunSessionKey>;
  const presentMeaningful = keys.filter((k) => scope[k] !== undefined && scope[k] !== null);
  if (presentMeaningful.length === 0) {
    throw new Error('closeScope: empty scope is forbidden (SPEC-009 §6.6)');
  }
  const hasBoundary = SCOPE_BOUNDARY_FIELDS.some((f) => scope[f] !== undefined);
  const hasSurfaceOrOwnerKind = scope.surface !== undefined || scope.ownerKind !== undefined;
  if (!hasBoundary && !hasSurfaceOrOwnerKind) {
    throw new Error(
      'closeScope: a scope without a boundary field (runId/projectId/ownerId) must include ' +
        'surface or ownerKind (SPEC-009 §6.6)',
    );
  }
}

export class CodexLifecycleRegistry {
  private readonly runs = new Map<string, CodexRunHandle>();

  private storageKey(key: CodexRunSessionKey): string {
    return [
      key.surface,
      key.ownerKind,
      key.mcpProfile,
      key.projectId ?? '',
      key.runId,
      key.phaseNumber ?? '',
      key.agentId ?? '',
      key.attemptId ?? '',
      key.sprintIndex ?? '',
      key.loopIteration ?? '',
      key.ownerId ?? '',
    ].join('|');
  }

  register(key: CodexRunSessionKey, handle: CodexRunHandle): void {
    if (!key.runId) {
      throw new Error('register: CodexRunSessionKey.runId is required');
    }
    this.runs.set(this.storageKey(key), handle);
    logger.debug({ runId: key.runId, surface: key.surface }, 'official run registered');
  }

  get(key: CodexRunSessionKey): CodexRunHandle | undefined {
    return this.runs.get(this.storageKey(key));
  }

  matching(scope: Partial<CodexRunSessionKey>): CodexRunHandle[] {
    const out: CodexRunHandle[] = [];
    for (const handle of this.runs.values()) {
      if (keyMatchesScope(handle.key, scope)) out.push(handle);
    }
    return out;
  }

  takeMatching(scope: Partial<CodexRunSessionKey>): CodexRunHandle[] {
    assertValidScope(scope);
    const matched = this.matching(scope);
    for (const handle of matched) this.remove(handle.key);
    return matched;
  }

  takeAll(): CodexRunHandle[] {
    const handles = [...this.runs.values()];
    this.runs.clear();
    return handles;
  }

  hasActiveRun(scope: Partial<CodexRunSessionKey>): boolean {
    for (const handle of this.runs.values()) {
      if (!keyMatchesScope(handle.key, scope)) continue;
      if (handle.status === 'closed' || handle.status === 'failed') continue;
      return true;
    }
    return false;
  }

  hasActiveRunsOutsideScope(scope: Partial<CodexRunSessionKey>): boolean {
    for (const handle of this.runs.values()) {
      if (handle.status === 'closed' || handle.status === 'failed') continue;
      if (!keyMatchesScope(handle.key, scope)) return true;
    }
    return false;
  }

  remove(key: CodexRunSessionKey): void {
    this.runs.delete(this.storageKey(key));
  }

  async closeScope(scope: Partial<CodexRunSessionKey>, reason: string): Promise<CodexRunHandle[]> {
    const matched = this.takeMatching(scope);
    for (const handle of matched) {
      try {
        await handle.close();
      } catch (err) {
        logger.warn(
          {
            reason,
            runId: handle.key.runId,
            threadId: handle.threadId,
            turnId: handle.turnId,
            status: handle.status,
            err: (err as Error).message,
          },
          'closeScope: handle close() failed; relying on forceKillFallback backstop',
        );
      }
    }
    return matched;
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

  private isReapSafe(handle: CodexRunHandle, now: number = Date.now()): boolean {
    if (handle.status === 'running') return false;
    if (handle.key.ownerKind === 'chat') return false;
    if (handle.hasStartedTurn === false) {
      const born = handle.createdAt;
      if (typeof born !== 'number' || now - born < OFFICIAL_APP_SERVER_YOUNG_GRACE_MS) return false;
    }
    return true;
  }

  private ageStamp(handle: CodexRunHandle): number {
    return handle.createdAt ?? handle.lastActivityAt ?? 0;
  }

  private detach(handle: CodexRunHandle): void {
    this.remove(handle.key);
  }

  reapSameScope(incoming: CodexRunSessionKey): CodexRunHandle[] {
    const reaped: CodexRunHandle[] = [];
    for (const handle of this.runs.values()) {
      const k = handle.key;
      if (handle.status === 'closed' || handle.status === 'failed') continue;
      if (handle.status === 'running') continue;
      if (handle.hasStartedTurn === false) continue;
      const sameScope =
        incoming.ownerKind === 'chat'
          ? k.ownerKind === 'chat' && !!incoming.ownerId && k.ownerId === incoming.ownerId
          : k.ownerKind !== 'chat' &&
            k.surface === incoming.surface &&
            k.projectId === incoming.projectId &&
            k.ownerKind === incoming.ownerKind &&
            k.mcpProfile === incoming.mcpProfile &&
            k.ownerId === incoming.ownerId;
      if (!sameScope) continue;
      if (this.storageKey(k) === this.storageKey(incoming)) continue;
      this.detach(handle);
      reaped.push(handle);
    }
    return reaped;
  }

  reapForCap(cap: number = MAX_LIVE_OFFICIAL_APP_SERVERS, now: number = Date.now()): CodexRunHandle[] {
    const reaped: CodexRunHandle[] = [];
    const candidates = [...this.runs.values()]
      .filter((h) => h.status !== 'closed' && h.status !== 'failed' && this.isReapSafe(h, now))
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
        'KI-2 cap: reaped oldest idle official app-server handle(s) to stay under cap',
      );
    }
    return reaped;
  }

  reapIdle(idleMs: number = OFFICIAL_APP_SERVER_IDLE_REAP_MS, now: number = Date.now()): CodexRunHandle[] {
    const reaped: CodexRunHandle[] = [];
    for (const handle of [...this.runs.values()]) {
      if (handle.status === 'closed' || handle.status === 'failed') continue;
      if (!this.isReapSafe(handle, now)) continue;
      const last = handle.lastActivityAt ?? handle.createdAt;
      if (typeof last !== 'number') continue;
      if (now - last < idleMs) continue;
      this.detach(handle);
      reaped.push(handle);
    }
    if (reaped.length > 0) {
      logger.warn(
        { idleMs, reaped: reaped.length, liveAfter: this.liveCount() },
        'KI-2 idle reaper: reaped idle official app-server handle(s)',
      );
    }
    return reaped;
  }
}

export function detectThreadLeak(
  loadedThreads: LoadedThread[],
  ownedThreadIds: string[],
  graceWindowMs = 0,
  now: number = Date.now(),
): LeakCheckResult {
  const owned = new Set(ownedThreadIds.filter(Boolean));
  const staleThreadIds: string[] = [];
  for (const t of loadedThreads) {
    if (!owned.has(t.threadId)) continue;
    if (graceWindowMs > 0 && typeof t.loadedSince === 'number') {
      if (now - t.loadedSince < graceWindowMs) continue;
    }
    staleThreadIds.push(t.threadId);
  }
  return { leaked: staleThreadIds.length > 0, staleThreadIds };
}
