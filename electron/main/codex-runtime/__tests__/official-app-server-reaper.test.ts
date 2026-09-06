
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const bridge = vi.hoisted(() => ({
  getCodexBinaryStatus: vi.fn().mockResolvedValue({
    installed: true,
    version: '0.140.0',
    authenticated: true,
    appServerSupported: true,
    binaryPath: '/usr/local/bin/codex',
  }),
  isCodexAvailable: vi
    .fn()
    .mockResolvedValue({ installed: true, version: '0.140.0', authenticated: true }),
  CodexUnavailableError: class CodexUnavailableError extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'CodexUnavailableError';
    }
  },
  CodexAuthError: class CodexAuthError extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'CodexAuthError';
    }
  },
}));
vi.mock('../binary', () => ({
  getCodexBinaryStatus: bridge.getCodexBinaryStatus,
  isCodexAvailable: bridge.isCodexAvailable,
}));
vi.mock('../errors', () => ({
  CodexUnavailableError: bridge.CodexUnavailableError,
  CodexAuthError: bridge.CodexAuthError,
}));

const preflight = vi.hoisted(() => ({
  runOfficialPreFlight: vi.fn().mockReturnValue({ status: 'not-windows' }),
  resetOfficialPreparedRepos: vi.fn(),
}));
vi.mock('../windows-preflight', () => preflight);

vi.mock('../../app-version', () => ({ getAppVersion: () => '9.9.9' }));

import {
  OfficialAppServerDriver,
  type AppServerTransport,
  type AppServerTransportFactory,
} from '../official-app-server-driver';
import type { AppServerEvent } from '../official-event-translator';
import type { CodexRunOptions, CodexRunSessionKey } from '../types';
import { MAX_LIVE_OFFICIAL_APP_SERVERS } from '../lifecycle-registry';

const CAP = MAX_LIVE_OFFICIAL_APP_SERVERS;

class FakeTransport implements AppServerTransport {
  public readonly requests: Array<{ method: string; params?: unknown }> = [];
  public killed: string[] = [];
  private notificationHandlers = new Set<(e: AppServerEvent) => void>();
  private errorHandlers = new Set<(e: Error) => void>();
  private exited = false;
  public turnScript: AppServerEvent[] | null = null;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === 'thread/start') return { threadId: `thr-${Math.random()}` };
    if (method === 'turn/start') {
      if (this.turnScript) {
        const script = this.turnScript;
        this.turnScript = null;
        queueMicrotask(() => {
          for (const e of script) this.emit(e);
        });
      }
      return { turnId: 'turn-fake-1' };
    }
    if (method === 'thread/loaded/list') return { threads: [] };
    return {};
  }

  notify(): void {
  }

  onNotification(handler: (e: AppServerEvent) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onError(handler: (e: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  kill(reason: string): void {
    this.killed.push(reason);
    this.exited = true;
  }

  async waitClosed(): Promise<boolean> {
    return this.exited;
  }

  emit(event: AppServerEvent): void {
    for (const h of [...this.notificationHandlers]) h(event);
  }
}

const COMPLETED: AppServerEvent[] = [
  { method: 'turn/started', params: { turnId: 'turn-fake-1' } },
  { method: 'turn/completed', params: { status: 'completed' } },
];

function makeOpts(key: Partial<CodexRunSessionKey>): CodexRunOptions {
  return {
    key: {
      surface: 'pipeline',
      ownerKind: 'pipeline',
      mcpProfile: 'pipeline',
      runId: 'r',
      projectId: 'p1',
      ...key,
    },
    model: 'gpt-5-codex',
    cwd: '/tmp/project',
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    reasoningEffort: 'high',
    timeoutMs: 7_200_000,
  };
}

function recordingDriver(): {
  driver: OfficialAppServerDriver;
  transports: FakeTransport[];
} {
  const transports: FakeTransport[] = [];
  const factory: AppServerTransportFactory = async () => {
    const t = new FakeTransport();
    transports.push(t);
    return t;
  };
  return { driver: new OfficialAppServerDriver(factory), transports };
}

async function runToCompletion(
  driver: OfficialAppServerDriver,
  transports: FakeTransport[],
  key: Partial<CodexRunSessionKey>,
): Promise<void> {
  const before = transports.length;
  const handle = await driver.createRun(makeOpts(key));
  transports[before].turnScript = COMPLETED;
  await handle.send('go');
  expect(handle.status).toBe('completed');
}

describe('OfficialAppServerDriver KI-2 cap wiring', () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  it('createRun beyond the cap reaps the OLDEST idle handle (kills its dedicated process)', async () => {
    const { driver, transports } = recordingDriver();
    for (let i = 0; i < CAP; i++) {
      await runToCompletion(driver, transports, { runId: `r-${i}`, projectId: `p-${i}` });
    }
    expect(driver.hasActiveRun({ projectId: 'p-0' })).toBe(true);
    const killedBefore = transports[0].killed.length;

    await driver.createRun(makeOpts({ runId: 'r-over', projectId: 'p-over' }));
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget close() run

    expect(transports[0].killed.length).toBeGreaterThan(killedBefore);
    expect(driver.hasActiveRun({ projectId: 'p-over' })).toBe(true);
    await driver.shutdown();
  });

  it('a RUNNING in-flight handle survives a cap-triggering createRun', async () => {
    const { driver, transports } = recordingDriver();
    const h0 = await driver.createRun(makeOpts({ runId: 'r-run', projectId: 'p-run' }));
    transports[0].turnScript = [{ method: 'turn/started', params: { turnId: 'turn-fake-1' } }];
    const inflight = h0.send('long'); // do NOT await: stays running
    await Promise.resolve();
    expect(h0.status).toBe('running');

    for (let i = 0; i < CAP; i++) {
      await runToCompletion(driver, transports, { runId: `r-${i}`, projectId: `p-${i}` });
    }
    const h0KillsBefore = transports[0].killed.length;

    await driver.createRun(makeOpts({ runId: 'r-over', projectId: 'p-over' }));
    await new Promise((r) => setTimeout(r, 0));

    expect(transports[0].killed.length).toBe(h0KillsBefore);
    expect(h0.status).toBe('running');

    transports[0].emit({ method: 'turn/completed', params: { status: 'completed' } });
    await inflight;
    await driver.shutdown();
  });

  it('the active chat handle survives a cap-triggering createRun', async () => {
    const { driver, transports } = recordingDriver();
    await runToCompletion(driver, transports, {
      surface: 'chat',
      ownerKind: 'chat',
      mcpProfile: 'chat',
      runId: 'r-chat',
      ownerId: 'owner-1',
    });
    const chatTransport = transports[0];
    const chatKillsBefore = chatTransport.killed.length;

    for (let i = 0; i < CAP; i++) {
      await runToCompletion(driver, transports, { runId: `r-${i}`, projectId: `p-${i}` });
    }
    await driver.createRun(makeOpts({ runId: 'r-over', projectId: 'p-over' }));
    await new Promise((r) => setTimeout(r, 0));

    expect(chatTransport.killed.length).toBe(chatKillsBefore);
    await driver.shutdown();
  });
});

describe('OfficialAppServerDriver KI-2 reap-on-register same scope', () => {
  it('a second run for the same PRODUCTION scope (surface+project+ownerKind+mcpProfile) reaps the first idle one', async () => {
    const { driver, transports } = recordingDriver();
    await runToCompletion(driver, transports, { runId: 'r-old', projectId: 'p1' });
    const oldTransport = transports[0];
    const oldKills = oldTransport.killed.length;

    await driver.createRun(makeOpts({ runId: 'r-new', projectId: 'p1' }));
    await new Promise((r) => setTimeout(r, 0));

    expect(oldTransport.killed.length).toBeGreaterThan(oldKills);
    await driver.shutdown();
  });

  it('does NOT reap a freshly-created same-scope sibling that has not yet sent its first turn (idle-window race)', async () => {
    const { driver, transports } = recordingDriver();

    const a = await driver.createRun(makeOpts({ runId: 'r-a', projectId: 'p1' }));
    const aTransport = transports[0];
    const aKillsBefore = aTransport.killed.length;
    expect(a.status).toBe('idle');

    const b = await driver.createRun(makeOpts({ runId: 'r-b', projectId: 'p1' }));
    await new Promise((r) => setTimeout(r, 0)); // let any fire-and-forget close() run

    expect(aTransport.killed.length).toBe(aKillsBefore);
    expect(a.status).toBe('idle');
    expect(driver.hasActiveRun({ runId: 'r-a' })).toBe(true);
    expect(driver.hasActiveRun({ runId: 'r-b' })).toBe(true);

    transports[0].turnScript = COMPLETED;
    await a.send('go-a');
    expect(a.status).toBe('completed');
    transports[1].turnScript = COMPLETED;
    await b.send('go-b');
    expect(b.status).toBe('completed');

    await driver.shutdown();
  });
});

describe('OfficialAppServerDriver KI-2 idle reaper timer lifecycle', () => {
  it('arms a single interval on first createRun and clears it on shutdown', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { driver, transports } = recordingDriver();

    const setBefore = setSpy.mock.calls.length;
    await runToCompletion(driver, transports, { runId: 'r-0', projectId: 'p-0' });
    await runToCompletion(driver, transports, { runId: 'r-1', projectId: 'p-1' });
    expect(setSpy.mock.calls.length - setBefore).toBe(1);

    const clearBefore = clearSpy.mock.calls.length;
    await driver.shutdown();
    expect(clearSpy.mock.calls.length).toBeGreaterThan(clearBefore);

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('the wired idle reap kills an idle handle process (the interval callback path)', async () => {
    const { driver, transports } = recordingDriver();
    await runToCompletion(driver, transports, { runId: 'r-idle', projectId: 'p-idle' });
    const idleTransport = transports[0];
    const killsBefore = idleTransport.killed.length;

    const reg = (driver as unknown as {
      registry: import('../lifecycle-registry').CodexLifecycleRegistry;
    }).registry;
    const reaped = reg.reapIdle(120_000, Date.now() + 200_000);
    for (const h of reaped) await (h as { close: () => Promise<void> }).close();

    expect(idleTransport.killed.length).toBeGreaterThan(killsBefore);
    await driver.shutdown();
  });
});
