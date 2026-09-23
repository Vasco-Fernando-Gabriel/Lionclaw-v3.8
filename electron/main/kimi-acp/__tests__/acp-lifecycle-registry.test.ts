import { describe, it, expect, vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  KimiAcpLifecycleRegistry,
  MAX_LIVE_KIMI_ACP_PROCESSES,
  KIMI_ACP_IDLE_REAP_MS,
  KIMI_ACP_YOUNG_GRACE_MS,
} from '../acp-lifecycle-registry';
import type { KimiAcpRunSessionKey, KimiAcpRegistrableHandle } from '../types';

type FakeHandle = KimiAcpRegistrableHandle & { closeCalls: number };

function fakeHandle(
  key: KimiAcpRunSessionKey,
  over: Partial<Pick<KimiAcpRegistrableHandle, 'status' | 'createdAt' | 'lastActivityAt' | 'hasStartedTurn'>> = {},
): FakeHandle {
  let s: KimiAcpRegistrableHandle['status'] = over.status ?? 'running';
  const h: FakeHandle = {
    key,
    get status() {
      return s;
    },
    set status(v: KimiAcpRegistrableHandle['status']) {
      s = v;
    },
    createdAt: over.createdAt,
    lastActivityAt: over.lastActivityAt,
    hasStartedTurn: over.hasStartedTurn,
    close: vi.fn().mockImplementation(async () => {
      h.closeCalls += 1;
      s = 'closed';
    }),
    closeCalls: 0,
  };
  return h;
}

function key(over: Partial<KimiAcpRunSessionKey> = {}): KimiAcpRunSessionKey {
  return {
    surface: 'pipeline',
    ownerKind: 'pipeline',
    runId: 'r1',
    ...over,
  };
}

function chatKey(over: Partial<KimiAcpRunSessionKey> = {}): KimiAcpRunSessionKey {
  return {
    surface: 'chat',
    ownerKind: 'chat',
    runId: 'rc',
    ...over,
  };
}

describe('KimiAcpLifecycleRegistry register/get/matching/remove/liveCount', () => {
  it('rejeita identidade viva duplicada em vez de substituir o handle existente', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const runKey = key({ projectId: 'p1', agentId: 'coder', runId: 'exec-1' });
    const parent = fakeHandle(runKey, { status: 'running', hasStartedTurn: true });
    reg.register(runKey, parent);

    expect(() => reg.register(runKey, fakeHandle(runKey))).toThrow(/duplicate live Kimi ACP run identity/i);
    expect(reg.get(runKey)).toBe(parent);
  });

  it('registers and retrieves by key', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const k = key({ runId: 'r-get', projectId: 'p1' });
    const h = fakeHandle(k);
    reg.register(k, h);
    expect(reg.get(k)).toBe(h);
    expect(reg.size()).toBe(1);
    expect(reg.liveCount()).toBe(1);
  });

  it('register rejects a key without runId', () => {
    const reg = new KimiAcpLifecycleRegistry();
    expect(() => reg.register({ ...key(), runId: '' }, fakeHandle(key()))).toThrow(/runId/);
  });

  it('matching returns handles whose key satisfies a partial scope', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const a = key({ projectId: 'p1', agentId: 'coder', runId: 'r-a' });
    const b = key({ projectId: 'p1', agentId: 'evaluator', runId: 'r-b' });
    const c = key({ projectId: 'p2', runId: 'r-c' });
    reg.register(a, fakeHandle(a));
    reg.register(b, fakeHandle(b));
    reg.register(c, fakeHandle(c));
    expect(reg.matching({ projectId: 'p1' })).toHaveLength(2);
    expect(reg.matching({ projectId: 'p1', agentId: 'coder' })).toHaveLength(1);
    expect(reg.matching({ projectId: 'p2' })).toHaveLength(1);
  });

  it('remove drops a handle and liveCount excludes closed/failed', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const k = key({ projectId: 'p9', runId: 'r-rm' });
    const h = fakeHandle(k);
    reg.register(k, h);
    expect(reg.liveCount()).toBe(1);
    h.status = 'closed';
    expect(reg.liveCount()).toBe(0);
    expect(reg.size()).toBe(1);
    reg.remove(k, h);
    expect(reg.size()).toBe(0);
    expect(reg.get(k)).toBeUndefined();
  });

  it('remove compare-and-delete preserva o dono quando outro handle fecha com a mesma chave', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const k = key({ projectId: 'p9', runId: 'r-collision' });
    const owner = fakeHandle(k);
    const colliding = fakeHandle(k);
    reg.register(k, owner);

    expect(reg.remove(k, colliding)).toBe(false);
    expect(reg.get(k)).toBe(owner);
    expect(reg.remove(k, owner)).toBe(true);
    expect(reg.get(k)).toBeUndefined();
  });

  it('hasActiveRun true for a running matching run, false once closed', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const k = key({ projectId: 'p9', runId: 'r-active' });
    const h = fakeHandle(k);
    reg.register(k, h);
    expect(reg.hasActiveRun({ projectId: 'p9' })).toBe(true);
    h.status = 'closed';
    expect(reg.hasActiveRun({ projectId: 'p9' })).toBe(false);
  });

  it('clear empties the registry', () => {
    const reg = new KimiAcpLifecycleRegistry();
    reg.register(key({ runId: 'r-x' }), fakeHandle(key({ runId: 'r-x' })));
    expect(reg.size()).toBe(1);
    reg.clear();
    expect(reg.size()).toBe(0);
  });
});

describe('reapForCap', () => {
  it('reaps the OLDEST idle non-chat handles until STRICTLY under cap', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const now = 1_000_000;
    for (let i = 0; i < MAX_LIVE_KIMI_ACP_PROCESSES + 1; i++) {
      const k = key({ runId: `r-${i}`, projectId: `p${i}` });
      reg.register(k, fakeHandle(k, { status: 'idle', hasStartedTurn: true, createdAt: now - (1000 - i) }));
    }
    expect(reg.liveCount()).toBe(MAX_LIVE_KIMI_ACP_PROCESSES + 1);
    const reaped = reg.reapForCap(MAX_LIVE_KIMI_ACP_PROCESSES, now);
    expect(reaped).toHaveLength(2);
    expect(reaped.map((h) => h.key.runId)).toEqual(['r-0', 'r-1']);
    expect(reg.liveCount()).toBe(MAX_LIVE_KIMI_ACP_PROCESSES - 1);
  });

  it('reaps NOTHING when all live handles are running or chat (safety wins over the cap)', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const now = 2_000_000;
    for (let i = 0; i < MAX_LIVE_KIMI_ACP_PROCESSES; i++) {
      const k = key({ runId: `run-${i}`, projectId: `p${i}` });
      reg.register(k, fakeHandle(k, { status: 'running', hasStartedTurn: true, createdAt: now - 5000 }));
    }
    const ck = chatKey({ runId: 'rc', ownerId: 'u1' });
    reg.register(ck, fakeHandle(ck, { status: 'idle', hasStartedTurn: true, createdAt: now - 9000 }));
    expect(reg.liveCount()).toBe(MAX_LIVE_KIMI_ACP_PROCESSES + 1);
    const reaped = reg.reapForCap(MAX_LIVE_KIMI_ACP_PROCESSES, now);
    expect(reaped).toHaveLength(0);
    expect(reg.liveCount()).toBe(MAX_LIVE_KIMI_ACP_PROCESSES + 1);
  });
});

describe('reapIdle', () => {
  it('reaps a handle idle past KIMI_ACP_IDLE_REAP_MS', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const now = 5_000_000;
    const k = key({ runId: 'r-idle', projectId: 'p1' });
    reg.register(
      k,
      fakeHandle(k, {
        status: 'idle',
        hasStartedTurn: true,
        lastActivityAt: now - (KIMI_ACP_IDLE_REAP_MS + 1),
      }),
    );
    const reaped = reg.reapIdle(KIMI_ACP_IDLE_REAP_MS, now);
    expect(reaped).toHaveLength(1);
    expect(reaped[0].key.runId).toBe('r-idle');
    expect(reg.liveCount()).toBe(0);
  });

  it('never reaps a running handle even if its last activity is old', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const now = 5_000_000;
    const k = key({ runId: 'r-run', projectId: 'p1' });
    reg.register(
      k,
      fakeHandle(k, {
        status: 'running',
        hasStartedTurn: true,
        lastActivityAt: now - (KIMI_ACP_IDLE_REAP_MS + 10_000),
      }),
    );
    expect(reg.reapIdle(KIMI_ACP_IDLE_REAP_MS, now)).toHaveLength(0);
    expect(reg.liveCount()).toBe(1);
  });

  it('never reaps a chat handle even if idle past the threshold', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const now = 5_000_000;
    const ck = chatKey({ runId: 'rc', ownerId: 'u1' });
    reg.register(
      ck,
      fakeHandle(ck, {
        status: 'idle',
        hasStartedTurn: true,
        lastActivityAt: now - (KIMI_ACP_IDLE_REAP_MS + 10_000),
      }),
    );
    expect(reg.reapIdle(KIMI_ACP_IDLE_REAP_MS, now)).toHaveLength(0);
    expect(reg.liveCount()).toBe(1);
  });

  it('does not idle-reap a handle with no liveness stamps (left to the cap)', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const now = 5_000_000;
    const k = key({ runId: 'r-nostamp', projectId: 'p1' });
    reg.register(k, fakeHandle(k, { status: 'idle', hasStartedTurn: true }));
    expect(reg.reapIdle(KIMI_ACP_IDLE_REAP_MS, now)).toHaveLength(0);
    expect(reg.liveCount()).toBe(1);
  });
});

describe('young-grace (idle-window guard)', () => {
  it('a hasStartedTurn===false handle younger than the grace is NOT reaped by cap', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const now = 7_000_000;
    for (let i = 0; i < MAX_LIVE_KIMI_ACP_PROCESSES; i++) {
      const k = key({ runId: `r-old-${i}`, projectId: `p${i}` });
      reg.register(k, fakeHandle(k, { status: 'idle', hasStartedTurn: true, createdAt: now - 50_000 }));
    }
    const youngKey = key({ runId: 'r-young', projectId: 'pY' });
    reg.register(
      youngKey,
      fakeHandle(youngKey, {
        status: 'idle',
        hasStartedTurn: false,
        createdAt: now - (KIMI_ACP_YOUNG_GRACE_MS - 1),
      }),
    );
    expect(reg.liveCount()).toBe(MAX_LIVE_KIMI_ACP_PROCESSES + 1);
    const reaped = reg.reapForCap(MAX_LIVE_KIMI_ACP_PROCESSES, now);
    expect(reaped.map((h) => h.key.runId)).not.toContain('r-young');
    expect(reaped.length).toBeGreaterThanOrEqual(1);
    expect(reg.get(youngKey)).toBeDefined();
  });

  it('a hasStartedTurn===false handle younger than the grace is NOT reaped by idle', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const now = 7_000_000;
    const youngKey = key({ runId: 'r-young', projectId: 'pY' });
    reg.register(
      youngKey,
      fakeHandle(youngKey, {
        status: 'idle',
        hasStartedTurn: false,
        createdAt: now - (KIMI_ACP_YOUNG_GRACE_MS - 1),
      }),
    );
    expect(reg.reapIdle(KIMI_ACP_IDLE_REAP_MS, now)).toHaveLength(0);
    expect(reg.liveCount()).toBe(1);
  });

  it('the same unsent handle past the grace IS reapable', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const now = 7_000_000;
    const youngKey = key({ runId: 'r-aged', projectId: 'pY' });
    reg.register(
      youngKey,
      fakeHandle(youngKey, {
        status: 'idle',
        hasStartedTurn: false,
        createdAt: now - (KIMI_ACP_YOUNG_GRACE_MS + 1),
        lastActivityAt: now - (KIMI_ACP_IDLE_REAP_MS + 1),
      }),
    );
    expect(reg.reapForCap(0, now)).toHaveLength(1);
    expect(reg.liveCount()).toBe(0);
  });
});

describe('reapSameScope', () => {
  it('reaps a prior idle same-scope handle on a new register', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const priorKey = key({ runId: 'r-prior', projectId: 'p1', ownerId: 'o1' });
    const prior = fakeHandle(priorKey, { status: 'idle', hasStartedTurn: true, createdAt: 1000 });
    reg.register(priorKey, prior);

    const incoming = key({ runId: 'r-new', projectId: 'p1', ownerId: 'o1' });
    const reaped = reg.reapSameScope(incoming);
    expect(reaped).toHaveLength(1);
    expect(reaped[0].key.runId).toBe('r-prior');
    expect(reg.get(priorKey)).toBeUndefined();
  });

  it('never reaps a running same-scope handle', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const priorKey = key({ runId: 'r-prior', projectId: 'p1', ownerId: 'o1' });
    reg.register(priorKey, fakeHandle(priorKey, { status: 'running', hasStartedTurn: true }));
    const incoming = key({ runId: 'r-new', projectId: 'p1', ownerId: 'o1' });
    expect(reg.reapSameScope(incoming)).toHaveLength(0);
    expect(reg.get(priorKey)).toBeDefined();
  });

  it('never reaps a fresh unsent sibling (hasStartedTurn===false idle-window guard)', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const siblingKey = key({ runId: 'r-sib', projectId: 'p1', ownerId: 'o1' });
    reg.register(siblingKey, fakeHandle(siblingKey, { status: 'idle', hasStartedTurn: false }));
    const incoming = key({ runId: 'r-new', projectId: 'p1', ownerId: 'o1' });
    expect(reg.reapSameScope(incoming)).toHaveLength(0);
    expect(reg.get(siblingKey)).toBeDefined();
  });

  it('does not reap a different-scope idle handle', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const otherKey = key({ runId: 'r-other', projectId: 'p2', ownerId: 'o1' });
    reg.register(otherKey, fakeHandle(otherKey, { status: 'idle', hasStartedTurn: true, createdAt: 1 }));
    const incoming = key({ runId: 'r-new', projectId: 'p1', ownerId: 'o1' });
    expect(reg.reapSameScope(incoming)).toHaveLength(0);
    expect(reg.get(otherKey)).toBeDefined();
  });

  it('chat scope reaps a prior idle chat handle of the same ownerId only', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const priorChat = chatKey({ runId: 'rc-prior', ownerId: 'u1' });
    const otherOwnerChat = chatKey({ runId: 'rc-other', ownerId: 'u2' });
    reg.register(priorChat, fakeHandle(priorChat, { status: 'idle', hasStartedTurn: true, createdAt: 1 }));
    reg.register(otherOwnerChat, fakeHandle(otherOwnerChat, { status: 'idle', hasStartedTurn: true, createdAt: 1 }));
    const incoming = chatKey({ runId: 'rc-new', ownerId: 'u1' });
    const reaped = reg.reapSameScope(incoming);
    expect(reaped).toHaveLength(1);
    expect(reaped[0].key.runId).toBe('rc-prior');
    expect(reg.get(otherOwnerChat)).toBeDefined();
  });
});

describe('hasActiveRunsOutsideScope', () => {
  it('true while an out-of-scope sibling lives, false after it closes', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const target = key({ projectId: 'p1', runId: 'r-target' });
    const sibling = key({ projectId: 'p2', runId: 'r-sibling' });
    reg.register(target, fakeHandle(target));
    const sib = fakeHandle(sibling);
    reg.register(sibling, sib);
    const scope = { surface: 'pipeline' as const, ownerKind: 'pipeline' as const, projectId: 'p1', runId: 'r-target' };
    expect(reg.hasActiveRunsOutsideScope(scope)).toBe(true);
    sib.status = 'closed';
    expect(reg.hasActiveRunsOutsideScope(scope)).toBe(false);
  });

  it('false when every live handle is in scope', () => {
    const reg = new KimiAcpLifecycleRegistry();
    const k = key({ projectId: 'p1', runId: 'r-only' });
    reg.register(k, fakeHandle(k));
    const scope = { surface: 'pipeline' as const, ownerKind: 'pipeline' as const, projectId: 'p1', runId: 'r-only' };
    expect(reg.hasActiveRunsOutsideScope(scope)).toBe(false);
  });
});
