
import { createLogger } from '../logger';

const logger = createLogger('kimi-concurrency');

export let KIMI_MAX_CONCURRENCY = 3;

export class KimiConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KimiConcurrencyError';
  }
}

export class KimiQuotaError extends Error {
  readonly retryAfterMs?: number;
  constructor(message: string, options?: { cause?: unknown; retryAfterMs?: number }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'KimiQuotaError';
    if (options?.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

export const KIMI_QUOTA_MESSAGE =
  'Cota Kimi esgotada ou rate limit atingido; tente de novo apos a janela de quota renovar.';

export function isKimiQuotaFailure(err: unknown): boolean {
  if (err === null || err === undefined) return false;

  if (typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    const status = obj['status'] ?? obj['statusCode'] ?? obj['code'];
    if (status === 429 || status === '429') return true;
  }

  const haystack = (() => {
    if (typeof err === 'string') return err;
    if (err instanceof Error) return `${err.name} ${err.message}`;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  })().toLowerCase();

  return (
    haystack.includes('429') ||
    haystack.includes('rate limit') ||
    haystack.includes('rate_limit') ||
    haystack.includes('ratelimit') ||
    haystack.includes('too many requests') ||
    haystack.includes('quota')
  );
}


export interface KimiSlotRequest {
  signal?: AbortSignal;
  role?: 'parent' | 'child' | 'standalone';
  toolBearing?: boolean;
  parentExecutionId?: string;
  rootExecutionId?: string;
  executionDepth?: number;
}

interface LeaseState {
  role: NonNullable<KimiSlotRequest['role']>;
  toolBearing: boolean;
  rootExecutionId?: string;
  executionDepth?: number;
}

interface QueuedWaiter extends LeaseState {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
  parentExecutionId?: string;
}

const activeLeases = new Set<LeaseState>();
const waiters: QueuedWaiter[] = [];

function activeToolParents(): number {
  let count = 0;
  for (const lease of activeLeases) {
    if (lease.role === 'parent' && lease.toolBearing) count++;
  }
  return count;
}

function canAdmit(state: LeaseState): boolean {
  if (activeLeases.size >= KIMI_MAX_CONCURRENCY) return false;
  if (state.role === 'child') return true;
  const reserve = activeToolParents() > 0 || (state.role === 'parent' && state.toolBearing) ? 1 : 0;
  return activeLeases.size < Math.max(1, KIMI_MAX_CONCURRENCY - reserve);
}

function saturatedByOwnAncestry(state: LeaseState): boolean {
  const executionDepth = state.executionDepth;
  if (
    state.role !== 'child'
    || state.rootExecutionId === undefined
    || executionDepth === undefined
    || activeLeases.size < KIMI_MAX_CONCURRENCY
  ) return false;
  return [...activeLeases].some((lease) => (
    lease.rootExecutionId === state.rootExecutionId
    && lease.executionDepth !== undefined
    && lease.executionDepth < executionDepth
    && lease.toolBearing
  ));
}

function makeRelease(state: LeaseState): () => void {
  activeLeases.add(state);
  let released = false;
  return () => {
    if (released) return; // idempotent
    released = true;
    activeLeases.delete(state);
    handOffToNextWaiter();
  };
}

function handOffToNextWaiter(): void {
  for (;;) {
    const head = waiters[0];
    let index = head && canAdmit(head) ? 0 : -1;
    if (index < 0 && activeToolParents() > 0 && activeLeases.size < KIMI_MAX_CONCURRENCY) {
      index = waiters.findIndex((waiter) => waiter.role === 'child' && canAdmit(waiter));
    }
    if (index < 0) return;
    const [next] = waiters.splice(index, 1);
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener('abort', next.onAbort);
    }
    next.resolve(makeRelease(next));
  }
}

export function acquireKimiSlot(request: KimiSlotRequest | AbortSignal = {}): Promise<() => void> {
  const options: KimiSlotRequest = typeof (request as AbortSignal).aborted === 'boolean'
    && !('signal' in (request as KimiSlotRequest))
    ? { signal: request as AbortSignal }
    : request as KimiSlotRequest;
  const signal = options.signal;
  const state: LeaseState = {
    role: options.role ?? 'standalone',
    toolBearing: options.toolBearing ?? false,
    ...(options.rootExecutionId ? { rootExecutionId: options.rootExecutionId } : {}),
    ...(options.executionDepth !== undefined ? { executionDepth: options.executionDepth } : {}),
  };
  if (signal?.aborted) {
    return Promise.reject(new KimiConcurrencyError('kimi slot acquisition aborted'));
  }
  if (saturatedByOwnAncestry(state)) {
    return Promise.reject(new KimiConcurrencyError(
      'Kimi nested subagent cannot acquire a slot while its own tool-bearing ancestry saturates the pool.',
    ));
  }
  if (canAdmit(state)) return Promise.resolve(makeRelease(state));

  return new Promise<() => void>((resolve, reject) => {
    const waiter: QueuedWaiter = {
      ...state,
      resolve,
      reject,
      ...(signal ? { signal } : {}),
      ...(options.parentExecutionId ? { parentExecutionId: options.parentExecutionId } : {}),
    };
    if (signal) {
      const onAbort = (): void => {
        const idx = waiters.indexOf(waiter);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new KimiConcurrencyError('kimi slot acquisition aborted'));
      };
      waiter.onAbort = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
    }
    waiters.push(waiter);
    logger.debug(
      { activeSlots: activeLeases.size, queued: waiters.length, cap: KIMI_MAX_CONCURRENCY },
      'kimi slot queued (pool at ceiling)',
    );
  });
}

export function shutdownKimiConcurrency(reason = 'Kimi runtime shutdown'): void {
  for (const waiter of waiters.splice(0)) {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.reject(new Error(reason));
  }
}

export function _resetKimiPoolForTests(maxConcurrency?: number): void {
  shutdownKimiConcurrency('kimi pool reset');
  activeLeases.clear();
  if (maxConcurrency !== undefined) {
    KIMI_MAX_CONCURRENCY = maxConcurrency;
  }
}

export function _kimiPoolStateForTests(): { active: number; queued: number; cap: number; activeToolParents: number } {
  return {
    active: activeLeases.size,
    queued: waiters.length,
    cap: KIMI_MAX_CONCURRENCY,
    activeToolParents: activeToolParents(),
  };
}
