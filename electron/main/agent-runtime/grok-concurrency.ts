export class GrokConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrokConcurrencyError';
  }
}

export class GrokQuotaError extends Error {
  readonly retryAfterMs?: number;

  constructor(message: string, options?: { cause?: unknown; retryAfterMs?: number }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'GrokQuotaError';
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export const GROK_QUOTA_MESSAGE =
  'Cota semanal do Grok ou rate limit atingido; consulte Grok Settings > Usage e tente novamente depois.';

export function isGrokQuotaFailure(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    const status = value['status'] ?? value['statusCode'] ?? value['code'];
    if (status === 429 || status === '429') return true;
  }
  const text = (error instanceof Error ? `${error.name} ${error.message}` : String(error)).toLowerCase();
  return (
    text.includes('429') ||
    text.includes('rate limit') ||
    text.includes('rate_limit') ||
    text.includes('too many requests') ||
    text.includes('quota') ||
    text.includes('weekly limit') ||
    text.includes('extra usage')
  );
}

export let GROK_MAX_CONCURRENCY = 3;

export function configureGrokConcurrency(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new GrokConcurrencyError('grok_max_concurrency must be an integer between 1 and 16.');
  }
  GROK_MAX_CONCURRENCY = value;
  drainQueue();
}

export interface GrokSlotRequest {
  signal?: AbortSignal;
  role?: 'parent' | 'child' | 'standalone';
  toolBearing?: boolean;
  parentExecutionId?: string;
  rootExecutionId?: string;
  executionDepth?: number;
}

interface LeaseState {
  role: NonNullable<GrokSlotRequest['role']>;
  toolBearing: boolean;
  rootExecutionId?: string;
  executionDepth?: number;
}

interface Waiter extends LeaseState {
  signal?: AbortSignal;
  parentExecutionId?: string;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

const active = new Set<LeaseState>();
const waiters: Waiter[] = [];

function activeToolParents(): number {
  let count = 0;
  for (const lease of active) {
    if (lease.role === 'parent' && lease.toolBearing) count += 1;
  }
  return count;
}

function canAdmit(state: LeaseState): boolean {
  if (active.size >= GROK_MAX_CONCURRENCY) return false;
  if (state.role === 'child') return true;
  const reserve = activeToolParents() > 0 || (state.role === 'parent' && state.toolBearing) ? 1 : 0;
  return active.size < Math.max(1, GROK_MAX_CONCURRENCY - reserve);
}

function saturatedByOwnAncestry(state: LeaseState): boolean {
  const executionDepth = state.executionDepth;
  if (
    state.role !== 'child' ||
    state.rootExecutionId === undefined ||
    executionDepth === undefined ||
    active.size < GROK_MAX_CONCURRENCY
  )
    return false;
  return [...active].some(
    (lease) =>
      lease.rootExecutionId === state.rootExecutionId &&
      lease.executionDepth !== undefined &&
      lease.executionDepth < executionDepth &&
      lease.toolBearing,
  );
}

function makeLease(state: LeaseState): () => void {
  active.add(state);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active.delete(state);
    drainQueue();
  };
}

function detachAbort(waiter: Waiter): void {
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
}

function nextEligibleIndex(): number {
  const head = waiters[0];
  if (head && canAdmit(head)) return 0;
  if (activeToolParents() > 0 && active.size < GROK_MAX_CONCURRENCY) {
    return waiters.findIndex((waiter) => waiter.role === 'child' && canAdmit(waiter));
  }
  return -1;
}

function drainQueue(): void {
  for (;;) {
    const index = nextEligibleIndex();
    if (index < 0) return;
    const [waiter] = waiters.splice(index, 1);
    detachAbort(waiter);
    waiter.resolve(makeLease(waiter));
  }
}

export function acquireGrokSlot(request: GrokSlotRequest | AbortSignal = {}): Promise<() => void> {
  const options: GrokSlotRequest =
    typeof (request as AbortSignal).aborted === 'boolean' && !('signal' in (request as GrokSlotRequest))
      ? { signal: request as AbortSignal }
      : (request as GrokSlotRequest);
  const signal = options.signal;
  const state: LeaseState = {
    role: options.role ?? 'standalone',
    toolBearing: options.toolBearing ?? false,
    ...(options.rootExecutionId ? { rootExecutionId: options.rootExecutionId } : {}),
    ...(options.executionDepth !== undefined ? { executionDepth: options.executionDepth } : {}),
  };
  if (signal?.aborted) return Promise.reject(new GrokConcurrencyError('Grok slot acquisition aborted'));
  if (saturatedByOwnAncestry(state)) {
    return Promise.reject(
      new GrokConcurrencyError(
        'Grok nested subagent cannot acquire a slot while its own tool-bearing ancestry saturates the pool.',
      ),
    );
  }
  if (canAdmit(state)) return Promise.resolve(makeLease(state));
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      ...state,
      resolve,
      reject,
      ...(signal ? { signal } : {}),
      ...(options.parentExecutionId ? { parentExecutionId: options.parentExecutionId } : {}),
    };
    if (signal) {
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(new GrokConcurrencyError('Grok slot acquisition aborted'));
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    waiters.push(waiter);
  });
}

export function shutdownGrokConcurrency(reason = 'Grok runtime shutdown'): void {
  for (const waiter of waiters.splice(0)) {
    detachAbort(waiter);
    waiter.reject(new GrokConcurrencyError(reason));
  }
}

export function _resetGrokPoolForTests(maxConcurrency = 3): void {
  shutdownGrokConcurrency('Grok concurrency pool reset');
  active.clear();
  GROK_MAX_CONCURRENCY = maxConcurrency;
}

export function _grokPoolStateForTests(): { active: number; queued: number; cap: number; activeToolParents: number } {
  return {
    active: active.size,
    queued: waiters.length,
    cap: GROK_MAX_CONCURRENCY,
    activeToolParents: activeToolParents(),
  };
}
