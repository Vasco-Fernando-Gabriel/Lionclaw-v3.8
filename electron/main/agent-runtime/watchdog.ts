import { TypedProviderError } from './llm-error';

export const WATCHDOG_TIMEOUT_MS = 180_000;

export interface WatchdogHardBackstop {
  limitMs: number;
  onHardTimeout: (info: { elapsedMs: number; timeoutError: TypedProviderError }) => void;
}

export interface WatchdogHandle {
  reset(): void;
  stop(): void;
  wrapOnText(cb?: (chunk: string) => void): (chunk: string) => void;
  wrapOnThinking(cb?: (chunk: string) => void): (chunk: string) => void;
  wrapOnToolUse(cb?: (toolName: string) => void): (toolName: string) => void;
  wrapOnToolUseComplete(cb?: (tool: string, input: unknown) => void): (tool: string, input: unknown) => void;
  wrapOnActivity(cb?: () => void): () => void;
}

export function createWatchdog(
  timeoutMs: number,
  onStalled: (info: { lastChunkAt: number; secondsSinceLastChunk: number }) => void,
  hardBackstop?: WatchdogHardBackstop,
): WatchdogHandle {
  let stopped = false;
  let lastChunkAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;

  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  if (hardBackstop) {
    const startedAt = Date.now();
    hardTimer = setTimeout(() => {
      const elapsedMs = Date.now() - startedAt;
      hardBackstop.onHardTimeout({
        elapsedMs,
        timeoutError: new TypedProviderError('LLM-TIMEOUT', {
          message: `watchdog hard backstop exceeded (${hardBackstop.limitMs}ms)`,
          raw: `elapsedMs=${elapsedMs} limitMs=${hardBackstop.limitMs}`,
        }),
      });
    }, hardBackstop.limitMs);
  }

  const scheduleTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      const secondsSinceLastChunk = Math.round((Date.now() - lastChunkAt) / 1000);
      onStalled({ lastChunkAt, secondsSinceLastChunk });
    }, timeoutMs);
  };

  const reset = (): void => {
    if (stopped) return;
    lastChunkAt = Date.now();
    scheduleTimer();
  };

  const stop = (): void => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (hardTimer !== null) {
      clearTimeout(hardTimer);
      hardTimer = null;
    }
  };

  const wrapOnText =
    (cb?: (chunk: string) => void) =>
    (chunk: string): void => {
      reset();
      cb?.(chunk);
    };

  const wrapOnThinking =
    (cb?: (chunk: string) => void) =>
    (chunk: string): void => {
      reset();
      cb?.(chunk);
    };

  const wrapOnToolUse =
    (cb?: (toolName: string) => void) =>
    (toolName: string): void => {
      reset();
      cb?.(toolName);
    };

  const wrapOnToolUseComplete =
    (cb?: (tool: string, input: unknown) => void) =>
    (tool: string, input: unknown): void => {
      reset();
      cb?.(tool, input);
    };

  const wrapOnActivity = (cb?: () => void) => (): void => {
    reset();
    cb?.();
  };

  scheduleTimer();

  return { reset, stop, wrapOnText, wrapOnThinking, wrapOnToolUse, wrapOnToolUseComplete, wrapOnActivity };
}
