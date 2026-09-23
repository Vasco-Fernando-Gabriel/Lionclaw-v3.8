import { describe, it, expect, vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  CodexLifecycleRegistry,
  MAX_LIVE_OFFICIAL_APP_SERVERS,
  OFFICIAL_APP_SERVER_IDLE_REAP_MS,
  OFFICIAL_APP_SERVER_YOUNG_GRACE_MS,
} from '../lifecycle-registry';
import type { CodexRunHandle, CodexRunSessionKey } from '../types';

interface FakeHandle extends CodexRunHandle {
  closeCalls: number;
}

function fakeHandle(
  key: CodexRunSessionKey,
  opts: {
    status?: CodexRunHandle['status'];
    createdAt?: number;
    lastActivityAt?: number;
    hasStartedTurn?: boolean;
  } = {},
): FakeHandle {
  let s = opts.status ?? 'completed';
  const h = {
    key,
    implementation: 'official-app-server' as const,
    sessionId: 'sess',
    threadId: `thr-${key.runId}`,
    turnId: null,
    createdAt: opts.createdAt,
    lastActivityAt: opts.lastActivityAt,
    hasStartedTurn: opts.hasStartedTurn,
    get status() {
      return s;
    },
    set status(v: CodexRunHandle['status']) {
      s = v;
    },
    send: vi.fn(),
    reply: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockImplementation(async () => {
      h.closeCalls += 1;
      s = 'closed';
    }),
    waitClosed: vi.fn().mockResolvedValue(true),
    forceKillFallback: vi.fn().mockResolvedValue(undefined),
    closeCalls: 0,
  };
  return h as unknown as FakeHandle;
}

function pipeKey(over: Partial<CodexRunSessionKey> = {}): CodexRunSessionKey {
  return {
    surface: 'pipeline',
    ownerKind: 'pipeline',
    mcpProfile: 'pipeline',
    runId: 'r',
    projectId: 'p1',
    ...over,
  };
}

function chatKey(over: Partial<CodexRunSessionKey> = {}): CodexRunSessionKey {
  return {
    surface: 'chat',
    ownerKind: 'chat',
    mcpProfile: 'chat',
    runId: 'rc',
    ownerId: 'owner-1',
    ...over,
  };
}

function fillIdle(reg: CodexLifecycleRegistry, n: number): FakeHandle[] {
  const handles: FakeHandle[] = [];
  for (let i = 0; i < n; i++) {
    const k = pipeKey({ runId: `r-${i}` });
    const h = fakeHandle(k, { status: 'completed', createdAt: i, lastActivityAt: i });
    reg.register(k, h);
    handles.push(h);
  }
  return handles;
}

describe('KI-2 reapForCap (hard cap, machine protection)', () => {
  it('reaps the OLDEST idle non-chat handle and keeps liveCount <= cap', () => {
    const reg = new CodexLifecycleRegistry();
    const cap = 3;
    const handles = fillIdle(reg, cap);
    expect(reg.liveCount()).toBe(cap);

    const reaped = reg.reapForCap(cap);

    expect(reaped).toHaveLength(1);
    expect(reaped[0]).toBe(handles[0]);
    expect(reg.liveCount()).toBe(cap - 1);
  });

  it('reaps multiple oldest handles when well over the cap', () => {
    const reg = new CodexLifecycleRegistry();
    const cap = 2;
    const handles = fillIdle(reg, 5);
    const reaped = reg.reapForCap(cap);
    expect(reg.liveCount()).toBe(cap - 1);
    expect(reaped.map((h) => h.key.runId)).toEqual(['r-0', 'r-1', 'r-2', 'r-3']);
    expect(handles[4].status).not.toBe('closed');
  });

  it('default cap constant is the documented bound', () => {
    expect(MAX_LIVE_OFFICIAL_APP_SERVERS).toBeGreaterThan(0);
    const reg = new CodexLifecycleRegistry();
    fillIdle(reg, MAX_LIVE_OFFICIAL_APP_SERVERS);
    const reaped = reg.reapForCap();
    expect(reaped.length).toBeGreaterThanOrEqual(1);
    expect(reg.liveCount()).toBeLessThan(MAX_LIVE_OFFICIAL_APP_SERVERS);
  });
});

describe('KI-2 reapIdle (slow backstop)', () => {
  it('reaps a non-running, idle, non-chat handle past the idle window', () => {
    const reg = new CodexLifecycleRegistry();
    const k = pipeKey({ runId: 'r-idle' });
    const h = fakeHandle(k, { status: 'completed', lastActivityAt: 0 });
    reg.register(k, h);
    const now = OFFICIAL_APP_SERVER_IDLE_REAP_MS + 1;
    const reaped = reg.reapIdle(OFFICIAL_APP_SERVER_IDLE_REAP_MS, now);
    expect(reaped).toContain(h);
    expect(reg.liveCount()).toBe(0);
  });

  it('does NOT reap a handle whose activity is recent (inside the idle window)', () => {
    const reg = new CodexLifecycleRegistry();
    const k = pipeKey({ runId: 'r-fresh' });
    const h = fakeHandle(k, { status: 'completed', lastActivityAt: 1000 });
    reg.register(k, h);
    const now = 1000 + OFFICIAL_APP_SERVER_IDLE_REAP_MS - 1;
    const reaped = reg.reapIdle(OFFICIAL_APP_SERVER_IDLE_REAP_MS, now);
    expect(reaped).toEqual([]);
    expect(reg.liveCount()).toBe(1);
  });

  it('does NOT idle-reap an unstamped handle (no liveness data -> left to the cap)', () => {
    const reg = new CodexLifecycleRegistry();
    const k = pipeKey({ runId: 'r-unstamped' });
    const h = fakeHandle(k, { status: 'completed' });
    reg.register(k, h);
    const reaped = reg.reapIdle(OFFICIAL_APP_SERVER_IDLE_REAP_MS, 10_000_000);
    expect(reaped).toEqual([]);
  });
});

describe('KI-2 SAFETY (the part you must not get wrong)', () => {
  it('idle reaper NEVER reaps a running (in-flight turn) handle', () => {
    const reg = new CodexLifecycleRegistry();
    const k = pipeKey({ runId: 'r-running' });
    const h = fakeHandle(k, { status: 'running', lastActivityAt: 0 });
    reg.register(k, h);
    const reaped = reg.reapIdle(OFFICIAL_APP_SERVER_IDLE_REAP_MS, 10_000_000);
    expect(reaped).toEqual([]);
    expect(h.status).toBe('running');
    expect(reg.liveCount()).toBe(1);
  });

  it('cap reaper NEVER reaps a running handle (safety wins over the cap)', () => {
    const reg = new CodexLifecycleRegistry();
    const cap = 2;
    const a = fakeHandle(pipeKey({ runId: 'r-a' }), { status: 'running', createdAt: 0 });
    const b = fakeHandle(pipeKey({ runId: 'r-b' }), { status: 'running', createdAt: 1 });
    const c = fakeHandle(pipeKey({ runId: 'r-c' }), { status: 'running', createdAt: 2 });
    reg.register(a.key, a);
    reg.register(b.key, b);
    reg.register(c.key, c);
    const reaped = reg.reapForCap(cap);
    expect(reaped).toEqual([]);
    expect(reg.liveCount()).toBe(3);
  });

  it('NEVER reaps the active chat handle via cap or idle sweep', () => {
    const reg = new CodexLifecycleRegistry();
    const ck = chatKey({ runId: 'r-chat' });
    const chat = fakeHandle(ck, { status: 'completed', createdAt: 0, lastActivityAt: 0 });
    reg.register(ck, chat);
    fillIdle(reg, 4);

    const capReaped = reg.reapForCap(2);
    expect(capReaped).not.toContain(chat);
    expect(chat.status).not.toBe('closed');

    const idleReaped = reg.reapIdle(OFFICIAL_APP_SERVER_IDLE_REAP_MS, 10_000_000);
    expect(idleReaped).not.toContain(chat);
    expect(chat.status).not.toBe('closed');
  });
});

describe('KI-2 young-handle grace (the owner concurrency invariant: pipe + chat at once)', () => {
  it('cap reaper NEVER reaps a freshly-spawned handle that has not sent its first turn (burst safety)', () => {
    const reg = new CodexLifecycleRegistry();
    const cap = 2;
    const now = 1_000_000;
    const a = fakeHandle(pipeKey({ runId: 'r-a' }), { status: 'idle', createdAt: now, hasStartedTurn: false });
    const b = fakeHandle(pipeKey({ runId: 'r-b' }), { status: 'idle', createdAt: now, hasStartedTurn: false });
    const c = fakeHandle(pipeKey({ runId: 'r-c' }), { status: 'idle', createdAt: now, hasStartedTurn: false });
    reg.register(a.key, a);
    reg.register(b.key, b);
    reg.register(c.key, c);

    const reaped = reg.reapForCap(cap, now);
    expect(reaped).toEqual([]);
    expect(reg.liveCount()).toBe(3);
    expect(a.status).toBe('idle');
    expect(b.status).toBe('idle');
    expect(c.status).toBe('idle');
  });

  it('cap reaper DOES reap a never-started handle once it is older than the young grace (no abandoned-spawn leak)', () => {
    const reg = new CodexLifecycleRegistry();
    const cap = 1;
    const now = 1_000_000;
    const stale = fakeHandle(pipeKey({ runId: 'r-stale' }), {
      status: 'idle',
      createdAt: now - OFFICIAL_APP_SERVER_YOUNG_GRACE_MS - 1, // past the grace => abandoned
      hasStartedTurn: false,
    });
    const young = fakeHandle(pipeKey({ runId: 'r-young' }), {
      status: 'idle',
      createdAt: now, // inside the grace => protected
      hasStartedTurn: false,
    });
    reg.register(stale.key, stale);
    reg.register(young.key, young);

    const reaped = reg.reapForCap(cap, now);
    expect(reaped).toContain(stale);
    expect(reaped).not.toContain(young);
    expect(reg.get(young.key)).toBe(young);
  });

  it('young grace constant is shorter than the idle window (a started handle is reaped on the idle path)', () => {
    expect(OFFICIAL_APP_SERVER_YOUNG_GRACE_MS).toBeGreaterThan(0);
    expect(OFFICIAL_APP_SERVER_YOUNG_GRACE_MS).toBeLessThan(OFFICIAL_APP_SERVER_IDLE_REAP_MS);
  });
});

describe('KI-2 reapSameScope (reap-on-register overwrite leak, PRODUCTION key shape)', () => {
  it('closes a prior IDLE handle for the same production scope (surface+project+ownerKind+mcpProfile)', () => {
    const reg = new CodexLifecycleRegistry();
    const oldKey = pipeKey({ runId: 'r-old' });
    const old = fakeHandle(oldKey, { status: 'completed' });
    reg.register(oldKey, old);

    const incoming = pipeKey({ runId: 'r-new' });
    const reaped = reg.reapSameScope(incoming);

    expect(reaped).toContain(old);
    expect(reg.get(oldKey)).toBeUndefined();
  });

  it('does NOT reap a freshly-spawned same-scope sibling that has not started its first turn (idle-window race)', () => {
    const reg = new CodexLifecycleRegistry();
    const sibling = pipeKey({ runId: 'r-sibling' });
    const a = fakeHandle(sibling, { status: 'idle', hasStartedTurn: false });
    reg.register(sibling, a);

    const incoming = pipeKey({ runId: 'r-second' });
    const reaped = reg.reapSameScope(incoming);

    expect(reaped).toEqual([]);
    expect(reg.get(sibling)).toBe(a);
    expect(a.status).toBe('idle');
  });

  it('STILL reaps a prior same-scope handle that already ran a turn (overwrite-leak target unchanged)', () => {
    const reg = new CodexLifecycleRegistry();
    const prior = pipeKey({ runId: 'r-prior' });
    const old = fakeHandle(prior, { status: 'completed', hasStartedTurn: true });
    reg.register(prior, old);

    const incoming = pipeKey({ runId: 'r-new' });
    const reaped = reg.reapSameScope(incoming);

    expect(reaped).toContain(old);
    expect(reg.get(prior)).toBeUndefined();
  });

  it('does NOT reap a same-scope handle that is still running (in-flight)', () => {
    const reg = new CodexLifecycleRegistry();
    const oldKey = pipeKey({ runId: 'r-old' });
    const old = fakeHandle(oldKey, { status: 'running' });
    reg.register(oldKey, old);

    const incoming = pipeKey({ runId: 'r-new' });
    const reaped = reg.reapSameScope(incoming);

    expect(reaped).toEqual([]);
    expect(reg.get(oldKey)).toBe(old);
  });

  it('reaps an IDLE prior same-project handle but spares a RUNNING same-project sibling', () => {
    const reg = new CodexLifecycleRegistry();
    const idle = pipeKey({ runId: 'r-idle' });
    const running = pipeKey({ runId: 'r-running' });
    reg.register(idle, fakeHandle(idle, { status: 'completed' }));
    reg.register(running, fakeHandle(running, { status: 'running' }));

    const incoming = pipeKey({ runId: 'r-new' });
    const reaped = reg.reapSameScope(incoming);

    expect(reaped.map((h) => h.key.runId)).toEqual(['r-idle']);
    expect(reg.get(idle)).toBeUndefined();
    expect(reg.get(running)).toBeDefined();
  });

  it('does NOT touch a different production scope (different project / surface / mcpProfile)', () => {
    const reg = new CodexLifecycleRegistry();
    const sameProject = pipeKey({ runId: 'r-a' });
    const diffProject = pipeKey({ runId: 'r-b', projectId: 'p2' });
    const diffSurface = pipeKey({ runId: 'r-c', surface: 'one-shot', mcpProfile: 'one-shot' });
    reg.register(sameProject, fakeHandle(sameProject, { status: 'completed' }));
    reg.register(diffProject, fakeHandle(diffProject, { status: 'completed' }));
    reg.register(diffSurface, fakeHandle(diffSurface, { status: 'completed' }));

    const incoming = pipeKey({ runId: 'r-a2' });
    const reaped = reg.reapSameScope(incoming);

    expect(reaped.map((h) => h.key.runId)).toEqual(['r-a']);
    expect(reg.get(diffProject)).toBeDefined();
    expect(reg.get(diffSurface)).toBeDefined();
  });

  it('chat scope reaps an older idle chat handle for the same ownerId, never a running one', () => {
    const reg = new CodexLifecycleRegistry();
    const oldChat = chatKey({ runId: 'r-old', ownerId: 'owner-X' });
    const runningChat = chatKey({ runId: 'r-run', ownerId: 'owner-X' });
    const otherOwner = chatKey({ runId: 'r-other', ownerId: 'owner-Y' });
    reg.register(oldChat, fakeHandle(oldChat, { status: 'completed' }));
    reg.register(runningChat, fakeHandle(runningChat, { status: 'running' }));
    reg.register(otherOwner, fakeHandle(otherOwner, { status: 'completed' }));

    const incoming = chatKey({ runId: 'r-newchat', ownerId: 'owner-X' });
    const reaped = reg.reapSameScope(incoming);

    expect(reaped.map((h) => h.key.runId)).toEqual(['r-old']);
    expect(reg.get(runningChat)).toBeDefined();
    expect(reg.get(otherOwner)).toBeDefined();
  });
});
