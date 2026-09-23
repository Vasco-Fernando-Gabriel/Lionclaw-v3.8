import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  awaitTurnSettled,
  awaitExternalStop,
  registerExternalStopWaiter,
  resetExternalStopWaitersForTests,
} from '../turn-settle';
import { setInFlightDesktopTurn, clearInFlightDesktopTurn, getInFlightDesktopTurn } from '../in-flight-desktop-session';
import {
  awaitCodexTurnBarrier,
  beginCodexTurnBarrier,
  isCodexSessionClosing,
  resetCodexTurnBarriersForTests,
} from '../codex-runtime/turn-barrier';

beforeEach(() => {
  resetExternalStopWaitersForTests();
  resetCodexTurnBarriersForTests();
  clearInFlightDesktopTurn('s1');
});

describe('V10: awaitTurnSettled = promise do executeQuery assentada E parada externa confirmada', () => {
  it('sem turno em voo e sem hook de executor assenta imediatamente', async () => {
    await expect(awaitTurnSettled('s1', 50)).resolves.toEqual({ settled: true });
  });

  it('turno em voo que assenta (mesmo rejeitando) + hook do executor resolvido = settled', async () => {
    let finishTurn: () => void = () => {};
    setInFlightDesktopTurn(
      's1',
      new Promise<void>((_, reject) => {
        finishTurn = () => reject(new Error('abortado'));
      }),
    );
    let engineExit: () => void = () => {};
    registerExternalStopWaiter(
      's1',
      'claude-sdk',
      () =>
        new Promise<void>((resolve) => {
          engineExit = resolve;
        }),
    );

    const settle = awaitTurnSettled('s1', 1_000);
    finishTurn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    engineExit();
    await expect(settle).resolves.toEqual({ settled: true });
  });

  it('turno que nao assenta no prazo = timeout (Clear falha com turn_did_not_settle)', async () => {
    setInFlightDesktopTurn('s1', new Promise<void>(() => {}));
    await expect(awaitTurnSettled('s1', 20)).resolves.toEqual({ settled: false, reason: 'timeout' });
  });

  it('executor cujo processo externo nao para no prazo = timeout mesmo com a promise assentada', async () => {
    setInFlightDesktopTurn('s1', Promise.resolve());
    registerExternalStopWaiter('s1', 'claude-sdk', () => new Promise<void>(() => {}));
    await expect(awaitTurnSettled('s1', 20)).resolves.toEqual({ settled: false, reason: 'timeout' });
    await expect(awaitTurnSettled('s1', 20)).resolves.toEqual({ settled: false, reason: 'timeout' });
    registerExternalStopWaiter('s1', 'claude-sdk', () => Promise.resolve());
    await expect(awaitExternalStop('s1')).resolves.toBeUndefined();
  });

  it('P2-1: o waiter sobrevive ao finally do executor e so e consumido depois de assentar', async () => {
    const waiter = vi.fn(() => Promise.resolve());
    registerExternalStopWaiter('s1', 'claude-sdk', waiter);
    let finishTurn: () => void = () => {};
    setInFlightDesktopTurn(
      's1',
      new Promise<void>((resolve) => {
        finishTurn = resolve;
      }),
    );
    const settle = awaitTurnSettled('s1', 1_000);
    finishTurn();
    await expect(settle).resolves.toEqual({ settled: true });
    expect(waiter).toHaveBeenCalledTimes(1);
    await awaitExternalStop('s1');
    expect(waiter).toHaveBeenCalledTimes(1);
  });

  it('P2-1 codex: barreira atrasada apos o executor terminar; awaitTurnSettled so resolve no evento terminal', async () => {
    registerExternalStopWaiter('s1', 'codex-sdk', () => awaitCodexTurnBarrier('s1'));
    let finishExecutor: () => void = () => {};
    setInFlightDesktopTurn(
      's1',
      new Promise<void>((resolve) => {
        finishExecutor = resolve;
      }),
    );
    const release = beginCodexTurnBarrier('s1');
    finishExecutor();
    await new Promise((resolve) => setTimeout(resolve, 0));

    let resolved = false;
    const settle = awaitTurnSettled('s1', 1_000).then((outcome) => {
      resolved = true;
      return outcome;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);
    expect(isCodexSessionClosing('s1')).toBe(true);

    release();
    await expect(settle).resolves.toEqual({ settled: true });
    expect(isCodexSessionClosing('s1')).toBe(false);
  });

  it('codex: waiter registrado sobre a barreira de turno so assenta no evento terminal (fim da barreira)', async () => {
    setInFlightDesktopTurn('s1', Promise.resolve());
    registerExternalStopWaiter('s1', 'codex-sdk', () => awaitCodexTurnBarrier('s1'));
    const release = beginCodexTurnBarrier('s1');
    expect(isCodexSessionClosing('s1')).toBe(true);
    await expect(awaitTurnSettled('s1', 20)).resolves.toEqual({ settled: false, reason: 'timeout' });
    const settle = awaitTurnSettled('s1', 1_000);
    release();
    expect(isCodexSessionClosing('s1')).toBe(false);
    await expect(settle).resolves.toEqual({ settled: true });
  });

  it('registro por sessao: getInFlightDesktopTurn devolve null apos clear', () => {
    setInFlightDesktopTurn('s1', Promise.resolve());
    expect(getInFlightDesktopTurn('s1')).not.toBeNull();
    clearInFlightDesktopTurn('s1');
    expect(getInFlightDesktopTurn('s1')).toBeNull();
  });
});
