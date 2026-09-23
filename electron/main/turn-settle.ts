import { getInFlightDesktopTurn } from './in-flight-desktop-session';

export type ExternalStopWaiter = () => Promise<void>;

export type ExternalStopRuntime =
  'claude-sdk' | 'claude-compat-sdk' | 'codex-sdk' | 'kimi-sdk' | 'grok-sdk' | 'cursor-sdk' | 'lion-sdk';

interface ExternalStopEntry {
  runtime: ExternalStopRuntime;
  waiter: ExternalStopWaiter;
}

const externalStopWaiters = new Map<string, ExternalStopEntry>();

export function registerExternalStopWaiter(
  sessionId: string,
  runtime: ExternalStopRuntime,
  waiter: ExternalStopWaiter,
): void {
  externalStopWaiters.set(sessionId, { runtime, waiter });
}

export function awaitExternalStop(sessionId: string): Promise<void> {
  const entry = externalStopWaiters.get(sessionId);
  if (!entry) return Promise.resolve();
  const consume = (): void => {
    if (externalStopWaiters.get(sessionId) === entry) externalStopWaiters.delete(sessionId);
  };
  return entry.waiter().then(consume, consume);
}

export type TurnSettleOutcome = { settled: true } | { settled: false; reason: 'timeout' };

export const DEFAULT_CLEAR_FORCE_SETTLE_MS = 30_000;

export async function awaitTurnSettled(
  sessionId: string,
  timeoutMs: number,
  deps: {
    getTurn?: (sessionId: string) => Promise<void> | null;
    awaitExternal?: (sessionId: string) => Promise<void>;
  } = {},
): Promise<TurnSettleOutcome> {
  const getTurn = deps.getTurn ?? getInFlightDesktopTurn;
  const awaitExternal = deps.awaitExternal ?? awaitExternalStop;
  const turn = getTurn(sessionId);
  const work = (async () => {
    if (turn) await turn;
    await awaitExternal(sessionId);
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<TurnSettleOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false, reason: 'timeout' }), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.then((): TurnSettleOutcome => ({ settled: true })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function resetExternalStopWaitersForTests(): void {
  externalStopWaiters.clear();
}
