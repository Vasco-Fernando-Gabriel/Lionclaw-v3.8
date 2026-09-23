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
  isCodexAvailable: vi.fn().mockResolvedValue({ installed: true, version: '0.140.0', authenticated: true }),
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
import { awaitCodexTurnBarrier, isCodexSessionClosing, resetCodexTurnBarriersForTests } from '../turn-barrier';

const { CodexUnavailableError } = bridge;

class FakeTransport implements AppServerTransport {
  public readonly requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  public killed: string[] = [];
  private notificationHandlers = new Set<(e: AppServerEvent) => void>();
  private errorHandlers = new Set<(e: Error) => void>();
  private exited = false;
  public turnScript: AppServerEvent[] | null = null;
  public interruptResolver: (() => Promise<unknown>) | null = null;
  private turnCounter = 0;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params: params as Record<string, unknown> });
    if (method === 'thread/start') return { threadId: 'thread-fake-1' };
    if (method === 'turn/start') {
      this.turnCounter += 1;
      const turnId = `turn-fake-${this.turnCounter}`;
      if (this.turnScript) {
        const script = this.turnScript;
        this.turnScript = null;
        queueMicrotask(() => {
          for (const e of script) this.emit(e);
        });
      }
      return { turnId };
    }
    if (method === 'turn/interrupt' && this.interruptResolver) return this.interruptResolver();
    return {};
  }

  notify(): void {}

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

  methods(): string[] {
    return this.requests.map((r) => r.method);
  }

  count(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }
}

const OWNER = 'sess-desktop-1';

function makeKey(over: Partial<CodexRunSessionKey> = {}): CodexRunSessionKey {
  return {
    surface: 'chat',
    ownerKind: 'chat',
    ownerId: OWNER,
    mcpProfile: 'chat',
    runId: 'run-1',
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

function driverWith(...transports: FakeTransport[]): OfficialAppServerDriver {
  let i = 0;
  const factory: AppServerTransportFactory = async () => {
    const t = transports[Math.min(i, transports.length - 1)];
    i += 1;
    return t;
  };
  return new OfficialAppServerDriver(factory);
}

const STARTED_ONLY: AppServerEvent[] = [{ method: 'turn/started', params: { turnId: 'turn-fake-1' } }];
const TERMINAL_INTERRUPTED: AppServerEvent = {
  method: 'turn/completed',
  params: { turn: { status: 'interrupted' } },
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  resetCodexTurnBarriersForTests();
});

describe('7.5/9.2 V8 - barreira de turno do Codex (app-server fake controla a ordem dos eventos)', () => {
  it('AC-21a: abort envia turn/interrupt, aguarda a resposta e o evento terminal; a sessao fica closing ate la; turn/start de T2 NAO sai antes do terminal', async () => {
    const t = new FakeTransport();
    t.turnScript = STARTED_ONLY;
    let resolveInterrupt: () => void = () => {};
    t.interruptResolver = () =>
      new Promise((resolve) => {
        resolveInterrupt = () => resolve({});
      });
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());

    const ac = new AbortController();
    const onText = vi.fn();
    const p1 = handle.send('T1', { onText }, ac.signal);
    await tick();
    expect(handle.turnId).toBe('turn-fake-1');
    expect(isCodexSessionClosing(OWNER)).toBe(false);

    ac.abort();
    await tick();
    expect(t.count('turn/interrupt')).toBe(1);
    expect(t.requests.find((r) => r.method === 'turn/interrupt')?.params).toEqual({
      turnId: 'turn-fake-1',
    });
    expect(isCodexSessionClosing(OWNER)).toBe(true);

    let p1Settled = false;
    void p1.then(() => {
      p1Settled = true;
    });
    resolveInterrupt();
    await tick();
    expect(p1Settled).toBe(false);

    let p2Started = false;
    const p2 = handle.reply('T2').then((res) => {
      p2Started = true;
      return res;
    });
    await tick();
    await tick();
    expect(t.count('turn/start')).toBe(1);
    expect(p2Started).toBe(false);
    expect(isCodexSessionClosing(OWNER)).toBe(true);

    t.emit({ method: 'item/agentMessage/delta', params: { delta: 'parcial' } });
    t.emit(TERMINAL_INTERRUPTED);
    const res1 = await p1;
    expect(res1.status).toBe('failed');
    expect(handle.status).toBe('interrupted');
    expect(res1.content).toBe('parcial');
    expect(onText).toHaveBeenCalledWith('parcial');
    expect(isCodexSessionClosing(OWNER)).toBe(false);

    await tick();
    expect(t.count('turn/start')).toBe(2);
    const methods = t.methods();
    const interruptIdx = methods.indexOf('turn/interrupt');
    const secondStartIdx = methods.lastIndexOf('turn/start');
    expect(interruptIdx).toBeGreaterThan(-1);
    expect(secondStartIdx).toBeGreaterThan(interruptIdx);
    expect(t.count('thread/start')).toBe(1);

    t.emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    const res2 = await p2;
    expect(res2.status).toBe('completed');
    expect(res2.threadId).toBe('thread-fake-1');
  });

  it('AC-21b: apos o terminal T2 inicia; evento atrasado "de T1" (turnId antigo) nao contamina T2 e nenhuma chamada foi aceita no closing', async () => {
    const t = new FakeTransport();
    t.turnScript = STARTED_ONLY;
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());

    const ac = new AbortController();
    const p1 = handle.send('T1', {}, ac.signal);
    await tick();
    ac.abort();
    await tick();
    const closingObserved = isCodexSessionClosing(OWNER);
    t.emit(TERMINAL_INTERRUPTED);
    await p1;

    t.turnScript = [{ method: 'turn/started', params: { turnId: 'turn-fake-2' } }];
    const onText = vi.fn();
    const p2 = handle.reply('T2', { onText });
    await tick();
    expect(handle.turnId).toBe('turn-fake-2');
    expect(closingObserved).toBe(true);
    expect(isCodexSessionClosing(OWNER)).toBe(false);

    t.emit({ method: 'item/agentMessage/delta', params: { turnId: 'turn-fake-1', delta: 'T1-atrasado' } });
    t.emit({ method: 'item/agentMessage/delta', params: { turnId: 'turn-fake-2', delta: 'T2-ok' } });
    t.emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    const res2 = await p2;
    expect(res2.content).toBe('T2-ok');
    expect(onText).not.toHaveBeenCalledWith('T1-atrasado');
    expect(t.count('turn/start')).toBe(2);
    expect(t.methods().indexOf('turn/interrupt')).toBeLessThan(t.methods().lastIndexOf('turn/start'));
  });

  it('AC-21c: fake que nunca emite o terminal: apos codex_turn_settle_ms o handle fecha, o processo morre e o proximo run e um handle novo', async () => {
    const t1 = new FakeTransport();
    t1.turnScript = STARTED_ONLY;
    const t2 = new FakeTransport();
    const driver = driverWith(t1, t2);
    const handle = await driver.createRun(makeOpts({ turnSettleMs: 30 }));

    const ac = new AbortController();
    const p1 = handle.send('T1', {}, ac.signal);
    await tick();
    ac.abort();
    await tick();
    expect(t1.count('turn/interrupt')).toBe(1);
    expect(isCodexSessionClosing(OWNER)).toBe(true);
    expect(t1.killed).toEqual([]);

    const res1 = await p1;
    expect(res1.status).toBe('failed');
    expect(t1.killed).toEqual(['reset-now:turn-settle-timeout']);
    expect(handle.status).toBe('closed');
    expect((handle as unknown as { isClosed(): boolean }).isClosed()).toBe(true);
    expect(isCodexSessionClosing(OWNER)).toBe(false);
    expect(driver.hasActiveRun({ runId: 'run-1' })).toBe(false);

    const sync = driver.toSyncCodexSession(handle);
    expect(sync.isClosed?.()).toBe(true);

    const fresh = await driver.createRun(makeOpts({ key: makeKey({ runId: 'run-2' }) }));
    expect(fresh).not.toBe(handle);
    t2.turnScript = [
      { method: 'turn/started', params: { turnId: 'turn-fake-1' } },
      { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    ];
    await expect(fresh.send('novo')).resolves.toMatchObject({ status: 'completed' });
    expect(t2.count('thread/start')).toBe(1);
  });

  it('V10: awaitCodexTurnBarrier(sessionId) resolve no evento terminal (parada externa confirmada)', async () => {
    const t = new FakeTransport();
    t.turnScript = STARTED_ONLY;
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    const ac = new AbortController();
    const p1 = handle.send('T1', {}, ac.signal);
    await tick();
    ac.abort();
    await tick();
    let barrierDone = false;
    void awaitCodexTurnBarrier(OWNER).then(() => {
      barrierDone = true;
    });
    await tick();
    expect(barrierDone).toBe(false);
    t.emit(TERMINAL_INTERRUPTED);
    await p1;
    await tick();
    expect(barrierDone).toBe(true);
  });

  it('timeout (idle) tambem passa pela barreira: interrupt enviado, promise so assenta no terminal, status timeout', async () => {
    const t = new FakeTransport();
    t.turnScript = STARTED_ONLY;
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts({ idleTimeoutMs: 20 }));
    let settled = false;
    const p1 = handle.send('T1').then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(t.count('turn/interrupt')).toBe(1);
    expect(settled).toBe(false);
    expect(isCodexSessionClosing(OWNER)).toBe(true);
    t.emit({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } });
    const res = await p1;
    expect(res.status).toBe('timeout');
    expect(isCodexSessionClosing(OWNER)).toBe(false);
  });

  it('processo morre DURANTE a barreira: turno assenta (nao rejeita) com o conteudo parcial preservado', async () => {
    const t = new FakeTransport();
    t.turnScript = STARTED_ONLY;
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    const ac = new AbortController();
    const p1 = handle.send('T1', {}, ac.signal);
    await tick();
    t.emit({ method: 'item/agentMessage/delta', params: { delta: 'antes-do-stop' } });
    ac.abort();
    await tick();
    t.failProcess('codex app-server exited (code=137)');
    const res = await p1;
    expect(res.status).toBe('failed');
    expect(handle.status).toBe('interrupted');
    expect(res.content).toBe('antes-do-stop');
    expect(isCodexSessionClosing(OWNER)).toBe(false);
  });

  it('abort ANTES de turn/start sair: nada externo a parar, sem interrupt, assenta na hora', async () => {
    const t = new FakeTransport();
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    const ac = new AbortController();
    ac.abort();
    const res = await handle.send('T1', {}, ac.signal);
    expect(res.status).toBe('failed');
    expect(handle.status).toBe('interrupted');
    expect(t.count('turn/start')).toBe(0);
    expect(t.count('turn/interrupt')).toBe(0);
    expect(isCodexSessionClosing(OWNER)).toBe(false);
  });

  it('ownerKind pipeline: barreira local do handle sem registrar closing por sessao de chat', async () => {
    const t = new FakeTransport();
    t.turnScript = STARTED_ONLY;
    const driver = driverWith(t);
    const handle = await driver.createRun(
      makeOpts({
        key: makeKey({ surface: 'pipeline', ownerKind: 'pipeline', ownerId: 'proj-1', mcpProfile: 'pipeline' }),
      }),
    );
    const ac = new AbortController();
    const p1 = handle.send('T1', {}, ac.signal);
    await tick();
    ac.abort();
    await tick();
    expect(t.count('turn/interrupt')).toBe(1);
    expect(isCodexSessionClosing('proj-1')).toBe(false);
    t.emit(TERMINAL_INTERRUPTED);
    await expect(p1).resolves.toMatchObject({ status: 'failed' });
    expect(handle.status).toBe('interrupted');
  });
});

describe('7.5 - modelo por turno (AC-10, parte do driver)', () => {
  it('setModel antes do reply: turn/start leva o modelo novo, sem thread/start novo e com o MESMO threadId; thread/start nunca amarra modelo (F18)', async () => {
    const t = new FakeTransport();
    t.turnScript = [
      { method: 'turn/started', params: { turnId: 'turn-fake-1' } },
      { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    ];
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts({ model: 'gpt-5-codex' }));
    const first = await handle.send('T1');
    expect(first.threadId).toBe('thread-fake-1');

    const threadStart = t.requests.find((r) => r.method === 'thread/start');
    expect(threadStart?.params).not.toHaveProperty('model');
    expect(t.requests.filter((r) => r.method === 'turn/start')[0]?.params?.['model']).toBe('gpt-5-codex');

    const sync = driver.toSyncCodexSession(handle);
    sync.setModel?.('gpt-5.5');
    t.turnScript = [
      { method: 'turn/started', params: { turnId: 'turn-fake-2' } },
      { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    ];
    const second = await sync.reply('T2');
    expect(second.threadId).toBe('thread-fake-1');
    expect(t.count('thread/start')).toBe(1);
    const starts = t.requests.filter((r) => r.method === 'turn/start');
    expect(starts).toHaveLength(2);
    expect(starts[1]?.params?.['model']).toBe('gpt-5.5');
    expect(starts[1]?.params?.['threadId']).toBe('thread-fake-1');
  });
});
