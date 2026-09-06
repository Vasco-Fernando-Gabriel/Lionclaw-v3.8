
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  acquireKimiSlot,
  _resetKimiPoolForTests,
  _kimiPoolStateForTests,
  isKimiQuotaFailure,
  KimiConcurrencyError,
  KimiQuotaError,
  KIMI_QUOTA_MESSAGE,
} from '../agent-runtime/kimi-concurrency';

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  _resetKimiPoolForTests(2);
});

describe('bound respected (SPEC-011 §6.8 - N agentes paralelos)', () => {
  it('at most cap granted concurrently; releasing grants exactly one more', async () => {
    const granted: Array<() => void> = [];
    const pending: Array<Promise<() => void>> = [];

    for (let i = 0; i < 5; i++) {
      const p = acquireKimiSlot();
      pending.push(p);
    }

    await tick();
    const settled = await Promise.allSettled(
      pending.map((p) => Promise.race([p, tick().then(() => 'pending' as const)])),
    );
    const resolvedCount = settled.filter((s) => s.status === 'fulfilled' && s.value !== 'pending').length;
    expect(resolvedCount).toBe(2);
    expect(_kimiPoolStateForTests().active).toBe(2);
    expect(_kimiPoolStateForTests().queued).toBe(3);

    granted.push((await pending[0]) as () => void);
    granted.push((await pending[1]) as () => void);

    granted[0]();
    const third = await pending[2];
    expect(typeof third).toBe('function');
    expect(_kimiPoolStateForTests().active).toBe(2);
    expect(_kimiPoolStateForTests().queued).toBe(2);

    granted[1]();
    const fourth = await pending[3];
    fourth();
    third();
    const fifth = await pending[4];
    fifth();

    expect(_kimiPoolStateForTests().active).toBe(0);
    expect(_kimiPoolStateForTests().queued).toBe(0);
  });
});

describe('queue is FIFO, not a hard fail (SPEC-011 §6.8)', () => {
  it('a request beyond cap does NOT reject/throw; it is granted in arrival order', async () => {
    _resetKimiPoolForTests(1);
    const order: number[] = [];

    const r0 = await acquireKimiSlot(); // granted
    const p1 = acquireKimiSlot().then((rel) => {
      order.push(1);
      return rel;
    });
    const p2 = acquireKimiSlot().then((rel) => {
      order.push(2);
      return rel;
    });

    await tick();
    expect(order).toEqual([]); // both queued, neither rejected

    r0(); // free -> p1 granted (FIFO head)
    const rel1 = await p1;
    expect(order).toEqual([1]);

    rel1(); // free -> p2 granted
    const rel2 = await p2;
    expect(order).toEqual([1, 2]);

    rel2();
    expect(_kimiPoolStateForTests().active).toBe(0);
  });
});

describe('admissao reentrante de subagentes Kimi', () => {
  it('reserva capacidade para filho em vez de admitir todos os pais tool-bearing', async () => {
    _resetKimiPoolForTests(3);
    const parentA = await acquireKimiSlot({
      role: 'parent', toolBearing: true, rootExecutionId: 'root-a', executionDepth: 0,
    });
    const parentB = await acquireKimiSlot({
      role: 'parent', toolBearing: true, rootExecutionId: 'root-b', executionDepth: 0,
    });
    const parentC = acquireKimiSlot({
      role: 'parent', toolBearing: true, rootExecutionId: 'root-c', executionDepth: 0,
    });

    await tick();
    expect(_kimiPoolStateForTests()).toEqual({ active: 2, queued: 1, cap: 3, activeToolParents: 2 });

    const childA = await acquireKimiSlot({
      role: 'child', toolBearing: false, parentExecutionId: 'parent-a',
      rootExecutionId: 'root-a', executionDepth: 1,
    });
    expect(_kimiPoolStateForTests().active).toBe(3);

    childA();
    await tick();
    expect(_kimiPoolStateForTests().queued).toBe(1);
    parentA();
    const releaseParentC = await parentC;
    releaseParentC();
    parentB();
    expect(_kimiPoolStateForTests().active).toBe(0);
  });

  it('falha antes da fila quando a propria ancestry tool-bearing satura o pool', async () => {
    _resetKimiPoolForTests(2);
    const parent = await acquireKimiSlot({
      role: 'parent', toolBearing: true, rootExecutionId: 'same-root', executionDepth: 0,
    });
    const child = await acquireKimiSlot({
      role: 'child', toolBearing: true, rootExecutionId: 'same-root', executionDepth: 1,
    });

    await expect(acquireKimiSlot({
      role: 'child', toolBearing: false, rootExecutionId: 'same-root', executionDepth: 2,
    })).rejects.toThrow(/own tool-bearing ancestry saturates/);
    expect(_kimiPoolStateForTests().queued).toBe(0);

    child();
    parent();
  });

  it('cap 1 admite filho cross-runtime e rejeita somente ancestry Kimi ativa', async () => {
    _resetKimiPoolForTests(1);
    const crossRuntimeChild = await acquireKimiSlot({
      role: 'child', rootExecutionId: 'claude-root', executionDepth: 1,
    });
    crossRuntimeChild();
    const parent = await acquireKimiSlot({
      role: 'parent', toolBearing: true, rootExecutionId: 'kimi-root', executionDepth: 0,
    });
    await expect(acquireKimiSlot({
      role: 'child', rootExecutionId: 'kimi-root', executionDepth: 1,
    })).rejects.toBeInstanceOf(KimiConcurrencyError);
    parent();
    expect(_kimiPoolStateForTests().queued).toBe(0);
  });
});

describe('slot always released (T13 release-on-throw/cancel)', () => {
  it('idempotent release: double-release does not shrink the pool', async () => {
    _resetKimiPoolForTests(2);
    const rel = await acquireKimiSlot();
    expect(_kimiPoolStateForTests().active).toBe(1);
    rel();
    rel(); // no-op
    expect(_kimiPoolStateForTests().active).toBe(0);

    const a = await acquireKimiSlot();
    const b = await acquireKimiSlot();
    expect(_kimiPoolStateForTests().active).toBe(2);
    a();
    b();
  });

  it('a worker that throws still releases its slot (pool returns to capacity)', async () => {
    _resetKimiPoolForTests(1);
    const rel = await acquireKimiSlot();
    try {
      throw new Error('worker blew up');
    } catch {
      rel();
    }
    expect(_kimiPoolStateForTests().active).toBe(0);
    const next = await acquireKimiSlot();
    expect(typeof next).toBe('function');
    next();
  });
});

describe('abort while queued (T13 cancel semantics)', () => {
  it('aborting a queued waiter rejects the wait, removes the entry, never consumes a slot later', async () => {
    _resetKimiPoolForTests(1);
    const rel = await acquireKimiSlot(); // hold the only slot

    const controller = new AbortController();
    const queued = acquireKimiSlot(controller.signal);

    await tick();
    expect(_kimiPoolStateForTests().queued).toBe(1);

    controller.abort();
    await expect(queued).rejects.toThrow(/aborted/);
    expect(_kimiPoolStateForTests().queued).toBe(0);

    rel();
    expect(_kimiPoolStateForTests().active).toBe(0);
    expect(_kimiPoolStateForTests().queued).toBe(0);
  });

  it('acquire with an already-aborted signal rejects immediately and consumes no slot', async () => {
    _resetKimiPoolForTests(2);
    const controller = new AbortController();
    controller.abort();
    await expect(acquireKimiSlot(controller.signal)).rejects.toThrow(/aborted/);
    expect(_kimiPoolStateForTests().active).toBe(0);
  });
});

describe('quota classification + degradation never stalls (SPEC-011 §6.8 G-08)', () => {
  it('isKimiQuotaFailure detects quota/429 shapes and rejects generic errors', () => {
    expect(isKimiQuotaFailure(new Error('429 Too Many Requests'))).toBe(true);
    expect(isKimiQuotaFailure(new Error('rate limit exceeded'))).toBe(true);
    expect(isKimiQuotaFailure(new Error('rate_limit_exceeded'))).toBe(true);
    expect(isKimiQuotaFailure(new Error('Quota exhausted for this period'))).toBe(true);
    expect(isKimiQuotaFailure({ status: 429, message: 'too many requests' })).toBe(true);
    expect(isKimiQuotaFailure({ statusCode: 429 })).toBe(true);

    expect(isKimiQuotaFailure(new Error('disk full'))).toBe(false);
    expect(isKimiQuotaFailure(new Error('connection refused'))).toBe(false);
    expect(isKimiQuotaFailure(null)).toBe(false);
    expect(isKimiQuotaFailure(undefined)).toBe(false);
    expect(isKimiQuotaFailure({ status: 500 })).toBe(false);
  });

  it('KimiQuotaError carries the clear message + optional retryAfterMs', () => {
    const e = new KimiQuotaError(KIMI_QUOTA_MESSAGE, { retryAfterMs: 60000 });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('KimiQuotaError');
    expect(e.message).toBe(KIMI_QUOTA_MESSAGE);
    expect(e.retryAfterMs).toBe(60000);
  });

  it('a quota-failing worker releases its slot so the next queued worker proceeds (no deadlock)', async () => {
    _resetKimiPoolForTests(1);
    const rel0 = await acquireKimiSlot();
    const p1 = acquireKimiSlot();

    await tick();
    expect(_kimiPoolStateForTests().queued).toBe(1);

    try {
      throw Object.assign(new Error('429'), { status: 429 });
    } catch (err) {
      expect(isKimiQuotaFailure(err)).toBe(true);
      rel0();
    }

    const rel1 = await p1;
    expect(typeof rel1).toBe('function');
    rel1();
    expect(_kimiPoolStateForTests().active).toBe(0);
  });
});
