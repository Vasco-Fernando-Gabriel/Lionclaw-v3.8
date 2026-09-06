
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  APP_SERVER_HANDSHAKE_TIMEOUT_MS,
  OfficialAppServerDriver,
  DEFAULT_IDLE_TIMEOUT_MS,
  type AppServerTransport,
  type AppServerTransportFactory,
} from '../official-app-server-driver';
import type { AppServerEvent } from '../official-event-translator';
import type { CodexRunOptions, CodexRunSessionKey } from '../types';

const { CodexUnavailableError, CodexAuthError } = bridge;

class FakeTransport implements AppServerTransport {
  public readonly requests: Array<{ method: string; params?: unknown }> = [];
  public readonly notifications: Array<{ method: string; params?: unknown }> = [];
  public killed: string[] = [];
  private notificationHandlers = new Set<(e: AppServerEvent) => void>();
  private errorHandlers = new Set<(e: Error) => void>();
  private exited = false;

  public responder: (method: string, params?: unknown) => unknown = () => ({});
  public turnScript: AppServerEvent[] | null = null;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === 'thread/start') {
      return { threadId: 'thread-fake-1' };
    }
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
    return this.responder(method, params);
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
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

  async waitClosed(_timeoutMs: number): Promise<boolean> {
    return this.exited;
  }

  emit(event: AppServerEvent): void {
    for (const h of [...this.notificationHandlers]) h(event);
  }

  failProcess(message: string): void {
    this.exited = true;
    for (const h of [...this.errorHandlers]) h(new CodexUnavailableError(message));
  }
}

function makeKey(over: Partial<CodexRunSessionKey> = {}): CodexRunSessionKey {
  return {
    surface: 'pipeline',
    ownerKind: 'pipeline',
    mcpProfile: 'pipeline',
    runId: 'run-1',
    projectId: 'proj-1',
    ...over,
  };
}

function makeOpts(over: Partial<CodexRunOptions> = {}): CodexRunOptions {
  return {
    key: makeKey(over.key),
    model: 'gpt-5-codex',
    cwd: '/tmp/project',
    systemPrompt: 'sys',
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    reasoningEffort: 'high',
    timeoutMs: 7_200_000,
    ...over,
  };
}

function driverWith(transport: FakeTransport): {
  driver: OfficialAppServerDriver;
  factory: AppServerTransportFactory;
} {
  const factory: AppServerTransportFactory = async () => transport;
  return { driver: new OfficialAppServerDriver(factory), factory };
}

const TEXT_TURN: AppServerEvent[] = [
  { method: 'turn/started', params: { turnId: 'turn-fake-1' } },
  { method: 'item/agentMessage/delta', params: { delta: 'Hello ' } },
  { method: 'item/reasoning/delta', params: { delta: 'pondering' } },
  { method: 'commandExecution/started', params: { callId: 'c1', command: 'ls' } },
  { method: 'commandExecution/completed', params: { callId: 'c1', command: 'ls', exitCode: 0, durationMs: 12 } },
  { method: 'item/agentMessage/delta', params: { delta: 'world' } },
  {
    method: 'thread/tokenUsage/updated',
    params: { usage: { inputTokens: 100, cachedInputTokens: 10, outputTokens: 30, reasoningOutputTokens: 4, totalTokens: 130 } },
  },
  { method: 'turn/completed', params: { status: 'completed' } },
];

describe('OfficialAppServerDriver - createRun + handshake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.getCodexBinaryStatus.mockResolvedValue({
      installed: true,
      version: '0.140.0',
      authenticated: true,
      appServerSupported: true,
      binaryPath: '/usr/local/bin/codex',
    });
  });

  it('(a) handshake: initialize request then initialized notification, BEFORE any thread RPC', async () => {
    const t = new FakeTransport();
    const { driver } = driverWith(t);
    await driver.createRun(makeOpts());
    expect(t.requests.map((r) => r.method)).toContain('initialize');
    expect(t.notifications.map((n) => n.method)).toContain('initialized');
    expect(t.requests.map((r) => r.method)).not.toContain('thread/start');
    expect(preflight.runOfficialPreFlight).toHaveBeenCalledWith(
      '/tmp/project',
      'proj-1',
      undefined,
    );
  });

  it('(i) null binary -> CodexUnavailableError, no spawn', async () => {
    bridge.getCodexBinaryStatus.mockResolvedValueOnce({
      installed: false,
      version: null,
      authenticated: false,
      appServerSupported: false,
    });
    const t = new FakeTransport();
    const { driver } = driverWith(t);
    await expect(driver.createRun(makeOpts())).rejects.toBeInstanceOf(CodexUnavailableError);
  });

  it('CLI instalada sem app-server falha antes de criar transporte', async () => {
    bridge.getCodexBinaryStatus.mockResolvedValueOnce({
      installed: true,
      version: '0.1.0',
      authenticated: true,
      appServerSupported: false,
      binaryPath: '/usr/local/bin/codex',
      error: 'Codex CLI sem App Server utilizavel',
    });
    const factory = vi.fn(async () => new FakeTransport());
    const driver = new OfficialAppServerDriver(factory);
    await expect(driver.createRun(makeOpts())).rejects.toBeInstanceOf(CodexUnavailableError);
    expect(factory).not.toHaveBeenCalled();
  });

  it('handshake travado expira, mata o processo e nao registra o run', async () => {
    vi.useFakeTimers();
    try {
      const t = new FakeTransport();
      t.responder = (method) => method === 'initialize' ? new Promise(() => undefined) : {};
      const { driver } = driverWith(t);
      const creation = driver.createRun(makeOpts());
      const assertion = expect(creation).rejects.toBeInstanceOf(CodexUnavailableError);
      await vi.advanceTimersByTimeAsync(APP_SERVER_HANDSHAKE_TIMEOUT_MS + 1);
      await assertion;
      expect(t.killed).toContain('reset-now:pre-register-handshake-failed');
      expect(driver.hasActiveRun({ projectId: 'proj-1' })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OfficialAppServerDriver - turn lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('(b,c,d,e,f) send: thread/start -> turn/start (cased policies) -> deltas -> usage -> CodexResponse(8 fields)', async () => {
    const t = new FakeTransport();
    t.turnScript = TEXT_TURN;
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts());

    const onText = vi.fn();
    const onReasoning = vi.fn();
    const onToolUse = vi.fn();
    const res = await handle.send('do it', { onText, onReasoning, onToolUse });

    expect(t.requests.map((r) => r.method)).toContain('thread/start');
    expect(handle.threadId).toBe('thread-fake-1');

    const threadStart = t.requests.find((r) => r.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      cwd: '/tmp/project',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    });
    expect(threadStart?.params).not.toHaveProperty('sandboxPolicy');

    const turnStart = t.requests.find((r) => r.method === 'turn/start');
    expect(turnStart?.params).toMatchObject({
      threadId: 'thread-fake-1',
      input: [{ type: 'text', text: 'sys\n\ndo it' }],
      effort: 'high',
      model: 'gpt-5-codex',
    });
    expect(turnStart?.params).not.toHaveProperty('sandboxPolicy');
    expect(turnStart?.params).not.toHaveProperty('approvalPolicy');

    expect(onText).toHaveBeenCalledWith('Hello ');
    expect(onText).toHaveBeenCalledWith('world');
    expect(onReasoning).toHaveBeenCalledWith('pondering');
    expect(onToolUse).toHaveBeenCalledWith('Bash', expect.objectContaining({ kind: 'bash' }));

    expect(res.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 10,
      outputTokens: 30,
      reasoningOutputTokens: 4,
      totalTokens: 130,
    });

    expect(Object.keys(res).sort()).toEqual(
      [
        'applyPatchFailures',
        'applyPatchFailureSamples',
        'commandsRun',
        'content',
        'filesChanged',
        'status',
        'threadId',
        'usage',
      ].sort(),
    );
    expect(res.content).toBe('Hello world');
    expect(res.status).toBe('completed');
    expect(res.commandsRun).toEqual([{ cmd: 'ls', exitCode: 0, durationMs: 12 }]);
  });


  it('P8a: turn/completed de thread FILHA nao finaliza o turno raiz; so o da raiz finaliza (fixture filho-antes-do-pai)', async () => {
    const t = new FakeTransport();
    t.turnScript = [
      { method: 'turn/started', params: { turnId: 'turn-fake-1' } },
      { method: 'item/agentMessage/delta', params: { delta: 'root-' } },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-child-9', delta: 'CHILD-TEXT' } },
      { method: 'turn/completed', params: { threadId: 'thread-child-9', turn: { status: 'completed' } } },
      { method: 'item/agentMessage/delta', params: { delta: 'done' } },
      {
        method: 'thread/tokenUsage/updated',
        params: { usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 0, totalTokens: 130 } },
      },
      { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    ];
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    const res = await handle.send('go');
    expect(res.status).toBe('completed');
    expect(res.content).toBe('root-done');
    expect(res.content).not.toContain('CHILD-TEXT');
  });

  it('P8a: usage de thread FILHA nao sobrescreve o billing do turno raiz', async () => {
    const t = new FakeTransport();
    t.turnScript = [
      { method: 'turn/started', params: { turnId: 'turn-fake-1' } },
      {
        method: 'thread/tokenUsage/updated',
        params: { usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 0, totalTokens: 130 } },
      },
      {
        method: 'thread/tokenUsage/updated',
        params: { threadId: 'thread-child-9', usage: { inputTokens: 999_999, cachedInputTokens: 0, outputTokens: 999, reasoningOutputTokens: 0, totalTokens: 1_000_998 } },
      },
      { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    ];
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    const res = await handle.send('go');
    expect(res.usage.inputTokens).toBe(100);
    expect(res.usage.outputTokens).toBe(30);
  });

  it('P8a: evento de thread FILHA nao sobrescreve o turnId raiz', async () => {
    const t = new FakeTransport();
    t.turnScript = [
      { method: 'turn/started', params: { turnId: 'turn-fake-1' } },
      { method: 'item/started', params: { threadId: 'thread-child-9', turnId: 'turn-child-7' } },
      { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    ];
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    await handle.send('go');
    expect(handle.turnId).toBe('turn-fake-1');
  });

  it('reply continues on the SAME thread without a new thread/start', async () => {
    const t = new FakeTransport();
    t.turnScript = TEXT_TURN;
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    await handle.send('first');
    const startsAfterFirst = t.requests.filter((r) => r.method === 'thread/start').length;

    t.turnScript = [{ method: 'turn/completed', params: { status: 'completed' } }];
    await handle.reply('second');
    const startsAfterReply = t.requests.filter((r) => r.method === 'thread/start').length;
    expect(startsAfterReply).toBe(startsAfterFirst); // no new thread/start on reply
  });

  it('ALLOWS approvalPolicy:never + sandbox:danger-full-access (LionClaw bypass = full autonomy)', async () => {
    const t = new FakeTransport();
    t.turnScript = TEXT_TURN;
    const { driver } = driverWith(t);
    const handle = await driver.createRun(
      makeOpts({ approvalPolicy: 'never', sandbox: 'danger-full-access' }),
    );
    const res = await handle.send('x');
    expect(res.status).toBe('completed');
    expect(t.requests.map((r) => r.method)).toContain('thread/start');
    const ts = t.requests.find((r) => r.method === 'thread/start');
    expect(ts?.params).toMatchObject({ sandbox: 'danger-full-access' });
  });

  it('(g) AbortSignal -> turn/interrupt cancels the active turn and resolves interrupted', async () => {
    const t = new FakeTransport();
    t.turnScript = [{ method: 'turn/started', params: { turnId: 'turn-fake-1' } }];
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    const ac = new AbortController();
    const p = handle.send('long', {}, ac.signal);
    await Promise.resolve();
    ac.abort();
    const res = await p;
    expect(t.requests.some((r) => r.method === 'turn/interrupt')).toBe(true);
    expect(res.status).toBe('failed');
  });

  it('(j) auth error event -> CodexAuthError', async () => {
    const t = new FakeTransport();
    t.turnScript = [
      { method: 'turn/started', params: { turnId: 'turn-fake-1' } },
      { method: 'turn/failed', params: { reason: 'unauthorized' } },
    ];
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    await expect(handle.send('x')).rejects.toBeInstanceOf(CodexAuthError);
  });

  it('(i) process error during turn -> CodexUnavailableError', async () => {
    const t = new FakeTransport();
    t.turnScript = [{ method: 'turn/started', params: { turnId: 'turn-fake-1' } }];
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    const p = handle.send('x');
    await Promise.resolve();
    t.failProcess('app-server crashed');
    await expect(p).rejects.toBeInstanceOf(CodexUnavailableError);
  });
});

describe('OfficialAppServerDriver - T4b timeout enforcement', () => {
  beforeEach(() => vi.clearAllMocks());

  it('idle timeout: an idle turn is interrupted at idleTimeoutMs, resolves status:timeout', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.turnScript = [{ method: 'turn/started', params: { turnId: 'turn-fake-1' } }];
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts({ idleTimeoutMs: 50, timeoutMs: 10_000 }));
    const p = handle.send('idle');
    await vi.advanceTimersByTimeAsync(60);
    const res = await p;
    expect(res.status).toBe('timeout');
    expect(t.requests.some((r) => r.method === 'turn/interrupt')).toBe(true);
    vi.useRealTimers();
  });

  it('hard timeout: a runaway turn is interrupted at timeoutMs, resolves status:timeout', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts({ timeoutMs: 100 }));
    t.turnScript = [{ method: 'turn/started', params: { turnId: 'turn-fake-1' } }];
    const p = handle.send('runaway');
    await vi.advanceTimersByTimeAsync(40);
    t.emit({ method: 'item/agentMessage/delta', params: { delta: 'x' } });
    await vi.advanceTimersByTimeAsync(80);
    const res = await p;
    expect(res.status).toBe('timeout');
    vi.useRealTimers();
  });

  it('KI-3 default idle backstop: a wedged turn with NO idleTimeoutMs times out (not the 2h hard cap)', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.turnScript = [{ method: 'turn/started', params: { turnId: 'turn-wedge' } }];
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts({ idleTimeoutMs: undefined }));
    const p = handle.send('wedge');
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS + 10);
    const res = await p;
    expect(res.status).toBe('timeout');
    expect(t.requests.some((r) => r.method === 'turn/interrupt')).toBe(true);
    expect(handle.status).not.toBe('running');
    vi.useRealTimers();
  });

  it('timers clear on a normal turn/completed (no late timeout fires)', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.turnScript = TEXT_TURN;
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts({ idleTimeoutMs: 1000, timeoutMs: 2000 }));
    const p = handle.send('quick');
    await vi.advanceTimersByTimeAsync(1); // let the microtask-scripted events flush
    const res = await p;
    expect(res.status).toBe('completed');
    await vi.advanceTimersByTimeAsync(5000);
    expect(res.status).toBe('completed');
    vi.useRealTimers();
  });
});

describe('OfficialAppServerDriver - KI-3 ErrorNotification (the REAL turn-error terminal signal)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('error(willRetry:false) resolves status:failed IMMEDIATELY (not the idle/hard cap)', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.turnScript = [
      { method: 'turn/started', params: { turnId: 'turn-err' } },
      {
        method: 'error',
        params: { error: 'contextWindowExceeded', threadId: 'thr', turnId: 'turn-err', willRetry: false },
      },
    ];
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts({}));
    const p = handle.send('huge prompt');
    await vi.advanceTimersByTimeAsync(1); // flush scripted events only; NO long timer advance
    const res = await p;
    expect(res.status).toBe('failed');
    expect(handle.status).not.toBe('running'); // left 'running' -> the KI-2 reaper can reclaim it
    vi.useRealTimers();
  });

  it('error(willRetry:true) does NOT kill the turn; a retry that completes resolves normally', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.turnScript = [
      { method: 'turn/started', params: { turnId: 'turn-retry' } },
      { method: 'error', params: { error: 'serverOverloaded', threadId: 'thr', turnId: 'turn-retry', willRetry: true } },
    ];
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts({}));
    const p = handle.send('retry me');
    await vi.advanceTimersByTimeAsync(1); // the willRetry error must NOT settle the turn
    t.emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    const res = await p;
    expect(res.status).toBe('completed');
    vi.useRealTimers();
  });

  it('error(unauthorized) rejects with CodexAuthError (matches the auth throw path)', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.turnScript = [
      { method: 'turn/started', params: { turnId: 'turn-auth' } },
      { method: 'error', params: { error: 'unauthorized', threadId: 'thr', turnId: 'turn-auth', willRetry: false } },
    ];
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts({}));
    const p = handle.send('whoami');
    const assertion = expect(p).rejects.toBeInstanceOf(CodexAuthError);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    vi.useRealTimers();
  });
});

describe('OfficialAppServerDriver - close + leak check + sync adapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('(h) async close(): interrupt(if running) -> unsubscribe -> archive -> loaded/list -> kill', async () => {
    const t = new FakeTransport();
    t.turnScript = TEXT_TURN;
    t.responder = (method) => {
      if (method === 'thread/loaded/list') return { threads: [] };
      return {};
    };
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    await handle.send('do');
    await handle.close();

    const methods = t.requests.map((r) => r.method);
    expect(methods).toContain('thread/unsubscribe');
    expect(methods).toContain('thread/archive'); // pipeline ownerKind => ephemeral archive
    expect(methods).toContain('thread/loaded/list');
    expect(t.killed.length).toBeGreaterThan(0); // dedicated process killed at scope boundary
    expect(handle.status).toBe('closed');
  });

  it('loaded/list reports a still-loaded owned thread => forceKillFallback runs', async () => {
    const t = new FakeTransport();
    t.turnScript = TEXT_TURN;
    t.responder = (method) => {
      if (method === 'thread/loaded/list') return { threads: [{ threadId: 'thread-fake-1' }] };
      return {};
    };
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    await handle.send('do');
    const killsBefore = t.killed.length;
    await handle.close();
    expect(t.killed.length).toBeGreaterThan(killsBefore);
  });

  it('sync-close adapter: close(): void returns undefined, invalidates threadId, kills process, ignores late events', async () => {
    const t = new FakeTransport();
    t.turnScript = TEXT_TURN;
    const { driver } = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    await handle.send('do');

    const adapter = driver.toSyncCodexSession(handle);
    expect(adapter.threadId).toBe('thread-fake-1');

    const ret = adapter.close();
    expect(ret).toBeUndefined();
    expect(typeof (ret as unknown as { then?: unknown })?.then).not.toBe('function');
    expect(t.killed.length).toBeGreaterThan(0);
    t.emit({ method: 'item/agentMessage/delta', params: { delta: 'LATE' } });
    expect(handle.status).toBe('closed');
  });

  it('hasActiveRun / closeScope route through the registry', async () => {
    const t = new FakeTransport();
    t.turnScript = TEXT_TURN;
    t.responder = (m) => (m === 'thread/loaded/list' ? { threads: [] } : {});
    const { driver } = driverWith(t);
    await driver.createRun(makeOpts());
    expect(driver.hasActiveRun({ projectId: 'proj-1' })).toBe(true);
    await driver.closeScope({ surface: 'pipeline', projectId: 'proj-1' }, 'phase-boundary');
    expect(driver.hasActiveRun({ projectId: 'proj-1' })).toBe(false);
  });

  it('resetProjectNow mata apenas os processos pipeline do projeto alvo', async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const transports = [first, second];
    const driver = new OfficialAppServerDriver(async () => transports.shift()!);
    await driver.createRun(makeOpts({ key: makeKey({ projectId: 'proj-1', runId: 'run-1' }) }));
    await driver.createRun(makeOpts({ key: makeKey({ projectId: 'proj-2', runId: 'run-2' }) }));

    driver.resetProjectNow('proj-1', 'project-reset');

    expect(first.killed).toContain('reset-now:project-reset');
    expect(second.killed).toEqual([]);
    expect(driver.hasActiveRun({ projectId: 'proj-1' })).toBe(false);
    expect(driver.hasActiveRun({ projectId: 'proj-2' })).toBe(true);
    await driver.shutdown();
  });

  it('closeAll remove todos do registry e continua fechando os irmaos', async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const transports = [first, second];
    const driver = new OfficialAppServerDriver(async () => transports.shift()!);
    await driver.createRun(makeOpts({ key: makeKey({ projectId: 'proj-1', runId: 'run-1' }) }));
    await driver.createRun(makeOpts({ key: makeKey({ projectId: 'proj-2', runId: 'run-2' }) }));

    await driver.closeAll('auth-refresh');

    expect(first.killed.length).toBeGreaterThan(0);
    expect(second.killed.length).toBeGreaterThan(0);
    expect(driver.hasActiveRun({ surface: 'pipeline' })).toBe(false);
  });
});
