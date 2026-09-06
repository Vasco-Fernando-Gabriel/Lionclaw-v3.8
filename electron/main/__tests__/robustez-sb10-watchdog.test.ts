
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWatchdog, WATCHDOG_TIMEOUT_MS } from '../agent-runtime/watchdog';
import { TypedProviderError } from '../agent-runtime/llm-error';

describe('SB-10 watchdog hard-backstop (AC-B25)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC-B25: sem opt-in, o default nao muda — so o warn de stall dispara, nunca hard-timeout', () => {
    const onStalled = vi.fn();
    const watchdog = createWatchdog(WATCHDOG_TIMEOUT_MS, onStalled);

    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(60_000);
      watchdog.reset();
    }
    expect(onStalled).not.toHaveBeenCalled();

    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS + 1);
    expect(onStalled).toHaveBeenCalledTimes(1);

    watchdog.stop();
  });

  it('AC-B25: com opt-in, o teto ABSOLUTO dispara mesmo com progresso continuo (reset nao adia)', () => {
    const onStalled = vi.fn();
    const onHardTimeout = vi.fn();
    const watchdog = createWatchdog(WATCHDOG_TIMEOUT_MS, onStalled, {
      limitMs: 10 * 60_000,
      onHardTimeout,
    });

    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(60_000);
      watchdog.reset();
    }
    expect(onStalled).not.toHaveBeenCalled();
    expect(onHardTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000 + 1);
    expect(onHardTimeout).toHaveBeenCalledTimes(1);
    const info = onHardTimeout.mock.calls[0][0] as {
      elapsedMs: number;
      timeoutError: TypedProviderError;
    };
    expect(info.elapsedMs).toBeGreaterThanOrEqual(10 * 60_000);
    expect(info.timeoutError).toBeInstanceOf(TypedProviderError);
    expect(info.timeoutError.code).toBe('LLM-TIMEOUT');
    expect(info.timeoutError.userMessage.length).toBeGreaterThan(0);

    watchdog.stop();
  });

  it('AC-B25: stop() cancela o hard-backstop junto com o timer de stall', () => {
    const onStalled = vi.fn();
    const onHardTimeout = vi.fn();
    const watchdog = createWatchdog(WATCHDOG_TIMEOUT_MS, onStalled, {
      limitMs: 5_000,
      onHardTimeout,
    });

    watchdog.stop();
    vi.advanceTimersByTime(60 * 60_000);

    expect(onStalled).not.toHaveBeenCalled();
    expect(onHardTimeout).not.toHaveBeenCalled();
  });

  it('AC-B25: wrappers de progresso continuam resetando so o timer de stall', () => {
    const onStalled = vi.fn();
    const onHardTimeout = vi.fn();
    const watchdog = createWatchdog(1_000, onStalled, {
      limitMs: 3_500,
      onHardTimeout,
    });
    const onText = watchdog.wrapOnText(undefined);

    vi.advanceTimersByTime(900);
    onText('chunk');
    vi.advanceTimersByTime(900);
    onText('chunk');
    vi.advanceTimersByTime(900);
    onText('chunk');
    expect(onStalled).not.toHaveBeenCalled();

    vi.advanceTimersByTime(900);
    expect(onHardTimeout).toHaveBeenCalledTimes(1);

    watchdog.stop();
  });
});
