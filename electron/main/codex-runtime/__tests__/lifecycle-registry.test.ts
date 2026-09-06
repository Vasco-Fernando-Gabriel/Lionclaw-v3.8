
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  CodexLifecycleRegistry,
  detectThreadLeak,
  assertValidScope,
  keyMatchesScope,
} from '../lifecycle-registry';
import type { CodexRunHandle, CodexRunSessionKey } from '../types';

function fakeHandle(
  key: CodexRunSessionKey,
  status: CodexRunHandle['status'] = 'running',
): CodexRunHandle & { closeCalls: number } {
  let s = status;
  const h = {
    key,
    implementation: 'official-app-server' as const,
    sessionId: 'sess',
    threadId: `thr-${key.runId}`,
    turnId: null,
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
  return h as unknown as CodexRunHandle & { closeCalls: number };
}

function key(over: Partial<CodexRunSessionKey> = {}): CodexRunSessionKey {
  return {
    surface: 'pipeline',
    ownerKind: 'pipeline',
    mcpProfile: 'pipeline',
    runId: 'r1',
    ...over,
  };
}

describe('CodexLifecycleRegistry register/get/hasActiveRun', () => {
  it('registers and retrieves by key', () => {
    const reg = new CodexLifecycleRegistry();
    const k = key({ runId: 'r-get', projectId: 'p1' });
    const h = fakeHandle(k);
    reg.register(k, h);
    expect(reg.get(k)).toBe(h);
    expect(reg.size()).toBe(1);
  });

  it('register rejects a key without runId', () => {
    const reg = new CodexLifecycleRegistry();
    expect(() => reg.register({ ...key(), runId: '' }, fakeHandle(key()))).toThrow(/runId/);
  });

  it('hasActiveRun true for a running matching run, false once closed', () => {
    const reg = new CodexLifecycleRegistry();
    const k = key({ projectId: 'p9', runId: 'r-active' });
    const h = fakeHandle(k);
    reg.register(k, h);
    expect(reg.hasActiveRun({ projectId: 'p9' })).toBe(true);
    h.status = 'closed';
    expect(reg.hasActiveRun({ projectId: 'p9' })).toBe(false);
  });
});

describe('assertValidScope (SPEC-009 §6.6)', () => {
  it('closeScope({}) is rejected (empty scope)', () => {
    expect(() => assertValidScope({})).toThrow(/empty scope/);
  });

  it('a scope without a boundary field AND without surface/ownerKind is rejected', () => {
    expect(() => assertValidScope({ phaseNumber: 2 })).toThrow(/boundary field/);
  });

  it('a scope with surface only is valid', () => {
    expect(() => assertValidScope({ surface: 'pipeline' })).not.toThrow();
  });

  it('a scope with a boundary field (projectId) only is valid', () => {
    expect(() => assertValidScope({ projectId: 'p1' })).not.toThrow();
  });
});

describe('closeScope semantics', () => {
  it('closeScope(project, phase) does NOT close a chat scope', async () => {
    const reg = new CodexLifecycleRegistry();
    const pipelineKey = key({ projectId: 'p1', phaseNumber: 5, runId: 'r-pipe' });
    const chatKey = key({
      surface: 'chat',
      ownerKind: 'chat',
      mcpProfile: 'chat',
      projectId: 'p1',
      runId: 'r-chat',
    });
    const pipeH = fakeHandle(pipelineKey);
    const chatH = fakeHandle(chatKey);
    reg.register(pipelineKey, pipeH);
    reg.register(chatKey, chatH);

    await reg.closeScope({ surface: 'pipeline', projectId: 'p1', phaseNumber: 5 }, 'phase-boundary');

    expect(pipeH.closeCalls).toBe(1);
    expect(chatH.closeCalls).toBe(0);
    expect(reg.get(chatKey)).toBe(chatH);
    expect(reg.get(pipelineKey)).toBeUndefined();
  });

  it('closeScope of one agent does NOT touch parallel siblings', async () => {
    const reg = new CodexLifecycleRegistry();
    const a = key({ projectId: 'p1', agentId: 'coder', runId: 'r-a' });
    const b = key({ projectId: 'p1', agentId: 'evaluator', runId: 'r-b' });
    const ha = fakeHandle(a);
    const hb = fakeHandle(b);
    reg.register(a, ha);
    reg.register(b, hb);

    await reg.closeScope({ projectId: 'p1', agentId: 'coder', runId: 'r-a' }, 'agent-done');

    expect(ha.closeCalls).toBe(1);
    expect(hb.closeCalls).toBe(0);
    expect(reg.hasActiveRun({ agentId: 'evaluator' })).toBe(true);
  });

  it('hasActiveRunsOutsideScope is true while a sibling lives, false after it closes', async () => {
    const reg = new CodexLifecycleRegistry();
    const target = key({ projectId: 'p1', runId: 'r-target' });
    const sibling = key({ projectId: 'p2', runId: 'r-sibling' });
    reg.register(target, fakeHandle(target));
    const sib = fakeHandle(sibling);
    reg.register(sibling, sib);

    expect(
      reg.hasActiveRunsOutsideScope({ projectId: 'p1', runId: 'r-target', surface: 'pipeline', ownerKind: 'pipeline' }),
    ).toBe(true);
    sib.status = 'closed';
    expect(
      reg.hasActiveRunsOutsideScope({ projectId: 'p1', runId: 'r-target', surface: 'pipeline', ownerKind: 'pipeline' }),
    ).toBe(false);
  });
});

describe('keyMatchesScope', () => {
  it('absent scope fields are wildcards; present fields must equal', () => {
    const k = key({ projectId: 'p1', phaseNumber: 3, runId: 'r1' });
    expect(keyMatchesScope(k, { projectId: 'p1' })).toBe(true);
    expect(keyMatchesScope(k, { projectId: 'p1', phaseNumber: 3 })).toBe(true);
    expect(keyMatchesScope(k, { projectId: 'p2' })).toBe(false);
    expect(keyMatchesScope(k, { phaseNumber: 4 })).toBe(false);
  });
});

describe('T14 detectThreadLeak (no-thread-leak via loaded/list)', () => {
  it('no leak when no owned thread remains loaded', () => {
    const res = detectThreadLeak([{ threadId: 'other' }], ['thr-closed']);
    expect(res.leaked).toBe(false);
    expect(res.staleThreadIds).toEqual([]);
  });

  it('leak detected when an owned thread is still loaded (triggers forceKillFallback)', () => {
    const res = detectThreadLeak(
      [{ threadId: 'thr-closed' }, { threadId: 'other' }],
      ['thr-closed'],
    );
    expect(res.leaked).toBe(true);
    expect(res.staleThreadIds).toEqual(['thr-closed']);
  });

  it('respects a grace window: a recently-loaded owned thread is not yet a leak', () => {
    const now = 10_000;
    const res = detectThreadLeak(
      [{ threadId: 'thr-closed', loadedSince: 9_000 }],
      ['thr-closed'],
      5_000,
      now,
    );
    expect(res.leaked).toBe(false);
  });

  it('past the grace window the owned thread is a leak', () => {
    const now = 20_000;
    const res = detectThreadLeak(
      [{ threadId: 'thr-closed', loadedSince: 9_000 }],
      ['thr-closed'],
      5_000,
      now,
    );
    expect(res.leaked).toBe(true);
  });
});
