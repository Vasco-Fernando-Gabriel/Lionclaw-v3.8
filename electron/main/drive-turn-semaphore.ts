import { DRIVE_PARALLEL_TURNS_MAX } from './lanes';

export const DRIVE_PARALLEL_TURNS_SETTING_KEY = 'drive_parallel_turns';

export const DEFAULT_DRIVE_PARALLEL_TURNS = 1;

export function readDriveParallelTurns(readSetting: (key: string) => string | undefined): number {
  let raw: number;
  try {
    raw = Number.parseInt(readSetting(DRIVE_PARALLEL_TURNS_SETTING_KEY) || '', 10);
  } catch {
    return DEFAULT_DRIVE_PARALLEL_TURNS;
  }
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_DRIVE_PARALLEL_TURNS;
  return Math.min(raw, DRIVE_PARALLEL_TURNS_MAX);
}

export class DriveTurnAdmissionAbortedError extends Error {
  readonly code = 'drive_admission_aborted' as const;

  constructor() {
    super('drive_admission_aborted: turno de drive descartado enquanto aguardava vaga');
    this.name = 'DriveTurnAdmissionAbortedError';
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class DriveTurnSemaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly readLimit: () => number) {}

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiters.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new DriveTurnAdmissionAbortedError());
    if (this.waiters.length === 0 && this.active < this.readLimit()) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new DriveTurnAdmissionAbortedError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.active < this.readLimit()) {
      const next = this.waiters.shift()!;
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      this.active += 1;
      next.resolve(this.makeRelease());
    }
  }

  resetForTests(): void {
    this.active = 0;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new DriveTurnAdmissionAbortedError());
    }
  }
}
