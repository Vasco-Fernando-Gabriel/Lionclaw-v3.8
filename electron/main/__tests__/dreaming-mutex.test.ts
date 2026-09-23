import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquireDreamingMutex,
  tryAcquireDreamingMutex,
  isDreamingMutexHeld,
  dreamingMutexQueueLength,
  resetDreamingMutexForTests,
  DreamingMutexCancelledError,
} from '../dreaming-mutex';

beforeEach(() => {
  resetDreamingMutexForTests();
});

describe('D6/RM10: mutex global do dreaming', () => {
  it('desktop acquire e FIFO: o segundo so entra depois do primeiro liberar', async () => {
    const order: string[] = [];
    const releaseA = await acquireDreamingMutex();
    order.push('a-in');
    const bPromise = acquireDreamingMutex().then((release) => {
      order.push('b-in');
      return release;
    });
    const cPromise = acquireDreamingMutex().then((release) => {
      order.push('c-in');
      return release;
    });
    await Promise.resolve();
    expect(order).toEqual(['a-in']);
    expect(dreamingMutexQueueLength()).toBe(2);

    releaseA();
    const releaseB = await bPromise;
    expect(order).toEqual(['a-in', 'b-in']);
    expect(isDreamingMutexHeld()).toBe(true);

    releaseB();
    const releaseC = await cPromise;
    expect(order).toEqual(['a-in', 'b-in', 'c-in']);
    releaseC();
    expect(isDreamingMutexHeld()).toBe(false);
  });

  it('Telegram tryAcquire nunca bloqueia: null com o mutex ocupado, release com ele livre', async () => {
    const release = await acquireDreamingMutex();
    expect(tryAcquireDreamingMutex()).toBeNull();
    release();
    const own = tryAcquireDreamingMutex();
    expect(own).not.toBeNull();
    expect(isDreamingMutexHeld()).toBe(true);
    own!();
    expect(isDreamingMutexHeld()).toBe(false);
  });

  it('espera cancelada sai da fila sem herdar o mutex (Clear queued cancelado)', async () => {
    const releaseA = await acquireDreamingMutex();
    const abort = new AbortController();
    const waiting = acquireDreamingMutex({ signal: abort.signal });
    abort.abort();
    await expect(waiting).rejects.toBeInstanceOf(DreamingMutexCancelledError);
    expect(dreamingMutexQueueLength()).toBe(0);
    releaseA();
    expect(isDreamingMutexHeld()).toBe(false);
  });

  it('release e idempotente', async () => {
    const release = await acquireDreamingMutex();
    release();
    release();
    expect(isDreamingMutexHeld()).toBe(false);
  });
});
