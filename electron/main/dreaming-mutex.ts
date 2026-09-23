export type DreamingMutexRelease = () => void;

export class DreamingMutexCancelledError extends Error {
  readonly code = 'dreaming_mutex_cancelled' as const;

  constructor() {
    super('Espera pelo mutex do dreaming cancelada');
    this.name = 'DreamingMutexCancelledError';
  }
}

interface Waiter {
  grant: (release: DreamingMutexRelease) => void;
  cancel: (err: Error) => void;
  cancelled: boolean;
}

let held = false;
const waiters: Waiter[] = [];

function makeRelease(): DreamingMutexRelease {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    let next = waiters.shift();
    while (next && next.cancelled) next = waiters.shift();
    if (next) {
      next.grant(makeRelease());
      return;
    }
    held = false;
  };
}

export function isDreamingMutexHeld(): boolean {
  return held;
}

export function dreamingMutexQueueLength(): number {
  return waiters.filter((w) => !w.cancelled).length;
}

export function tryAcquireDreamingMutex(): DreamingMutexRelease | null {
  if (held) return null;
  held = true;
  return makeRelease();
}

export function acquireDreamingMutex(opts?: { signal?: AbortSignal }): Promise<DreamingMutexRelease> {
  if (opts?.signal?.aborted) return Promise.reject(new DreamingMutexCancelledError());
  if (!held) {
    held = true;
    return Promise.resolve(makeRelease());
  }
  return new Promise<DreamingMutexRelease>((resolve, reject) => {
    const waiter: Waiter = {
      grant: (release) => {
        opts?.signal?.removeEventListener('abort', onAbort);
        resolve(release);
      },
      cancel: (err) => {
        opts?.signal?.removeEventListener('abort', onAbort);
        reject(err);
      },
      cancelled: false,
    };
    function onAbort(): void {
      waiter.cancelled = true;
      const idx = waiters.indexOf(waiter);
      if (idx >= 0) waiters.splice(idx, 1);
      waiter.cancel(new DreamingMutexCancelledError());
    }
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    waiters.push(waiter);
  });
}

export function resetDreamingMutexForTests(): void {
  held = false;
  waiters.splice(0, waiters.length);
}
