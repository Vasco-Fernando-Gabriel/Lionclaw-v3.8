export const DEFAULT_CODEX_SESSION_WAIT_MS = 30_000;

export const CODEX_SESSION_WAIT_MS_SETTING_KEY = 'codex_session_wait_ms';

export class CodexSessionsExhaustedError extends Error {
  readonly code = 'codex_sessions_exhausted' as const;

  constructor(max: number, waitedMs: number) {
    super(
      `codex_sessions_exhausted: todas as ${max} threads Codex em cache estao com turno em voo; ` +
        `nenhuma pode ser fechada e nenhuma ficou ociosa em ${waitedMs} ms. Tente de novo em instantes.`,
    );
    this.name = 'CodexSessionsExhaustedError';
  }
}

export interface CodexSessionSlotDeps {
  max: number;
  listCachedOldestFirst: () => string[];
  isTurnInFlight: (sessionId: string) => boolean;
  evict: (sessionId: string, reason: string) => void;
}

export function pickIdleCodexSessionToEvict(
  cachedOldestFirst: readonly string[],
  isTurnInFlight: (sessionId: string) => boolean,
): string | null {
  for (const sessionId of cachedOldestFirst) {
    if (!isTurnInFlight(sessionId)) return sessionId;
  }
  return null;
}

export function readCodexSessionWaitMs(readSetting: (key: string) => string | undefined): number {
  const raw = Number.parseInt(readSetting(CODEX_SESSION_WAIT_MS_SETTING_KEY) || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CODEX_SESSION_WAIT_MS;
}

export class CodexSessionSlotGate {
  private readonly waiters = new Set<() => void>();

  constructor(private readonly deps: CodexSessionSlotDeps) {}

  enforceCap(reason: string): void {
    while (this.deps.listCachedOldestFirst().length > this.deps.max) {
      const victim = pickIdleCodexSessionToEvict(this.deps.listCachedOldestFirst(), this.deps.isTurnInFlight);
      if (victim === null) return;
      this.deps.evict(victim, reason);
    }
  }

  tryReserve(sessionId: string, reason: string): boolean {
    const cached = this.deps.listCachedOldestFirst();
    if (cached.includes(sessionId) || cached.length < this.deps.max) return true;
    const victim = pickIdleCodexSessionToEvict(cached, this.deps.isTurnInFlight);
    if (victim === null) return false;
    this.deps.evict(victim, reason);
    return true;
  }

  async reserve(sessionId: string, waitMs: number, reason: string): Promise<void> {
    if (this.tryReserve(sessionId, reason)) return;
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    let wake: () => void = () => {};
    const onTimeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), waitMs);
      timer.unref?.();
    });
    try {
      while (true) {
        const freed = new Promise<'freed'>((resolve) => {
          wake = () => resolve('freed');
          this.waiters.add(wake);
        });
        const outcome = await Promise.race([freed, onTimeout]);
        this.waiters.delete(wake);
        if (outcome === 'timeout') {
          throw new CodexSessionsExhaustedError(this.deps.max, Date.now() - startedAt);
        }
        if (this.tryReserve(sessionId, reason)) return;
      }
    } finally {
      this.waiters.delete(wake);
      if (timer) clearTimeout(timer);
    }
  }

  notifySlotFreed(): void {
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const wake of pending) wake();
  }

  hasWaiters(): boolean {
    return this.waiters.size > 0;
  }
}
