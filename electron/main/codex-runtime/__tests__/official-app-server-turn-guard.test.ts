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
  CodexTurnInFlightError,
  type AppServerTransport,
  type AppServerTransportFactory,
} from '../official-app-server-driver';
import type { AppServerEvent } from '../official-event-translator';
import type { CodexRunOptions, CodexRunSessionKey } from '../types';

const { CodexUnavailableError } = bridge;

class FakeTransport implements AppServerTransport {
  public readonly requests: Array<{ method: string; params?: unknown }> = [];
  public killed: string[] = [];
  private notificationHandlers = new Set<(e: AppServerEvent) => void>();
  private errorHandlers = new Set<(e: Error) => void>();
  private exited = false;

  public failNextThreadStart: Error | null = null;
  public failNextTurnStart: Error | null = null;
  public turnScript: AppServerEvent[] | null = null;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === 'thread/start') {
      if (this.failNextThreadStart) {
        const err = this.failNextThreadStart;
        this.failNextThreadStart = null;
        throw err;
      }
      return { threadId: 'thread-fake-1' };
    }
    if (method === 'turn/start') {
      if (this.failNextTurnStart) {
        const err = this.failNextTurnStart;
        this.failNextTurnStart = null;
        throw err;
      }
      if (this.turnScript) {
        const script = this.turnScript;
        this.turnScript = null;
        queueMicrotask(() => {
          for (const e of script) this.emit(e);
        });
      }
      return { turnId: 'turn-fake-1' };
    }
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

function driverWith(transport: FakeTransport): OfficialAppServerDriver {
  const factory: AppServerTransportFactory = async () => transport;
  return new OfficialAppServerDriver(factory);
}

const COMPLETED_TURN: AppServerEvent[] = [
  { method: 'turn/started', params: { turnId: 'turn-fake-1' } },
  { method: 'turn/completed', params: { turn: { status: 'completed' } } },
];

function guardHeld(handle: unknown): boolean {
  return (handle as { turnGuardHeld: boolean }).turnGuardHeld;
}

describe('BUG 4 - guard one-in-flight do handle (send/reply)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dois reply() concorrentes: o segundo rejeita e o onText do turno ativo NUNCA duplica', async () => {
    const t = new FakeTransport();
    t.turnScript = COMPLETED_TURN;
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    await handle.send('primeiro turno');

    t.turnScript = [{ method: 'turn/started', params: { turnId: 'turn-fake-1' } }];
    const onText = vi.fn();
    const pA = handle.reply('turno A', { onText });

    const onTextB = vi.fn();
    await expect(handle.reply('turno B', { onText: onTextB })).rejects.toBeInstanceOf(CodexTurnInFlightError);
    expect(onTextB).not.toHaveBeenCalled();

    t.emit({ method: 'item/agentMessage/delta', params: { delta: 'Ent' } });
    t.emit({ method: 'item/agentMessage/delta', params: { delta: 'endido' } });
    t.emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    const res = await pA;
    expect(res.content).toBe('Entendido');
    expect(onText).toHaveBeenCalledTimes(2);
    expect(onText).toHaveBeenNthCalledWith(1, 'Ent');
    expect(onText).toHaveBeenNthCalledWith(2, 'endido');

    t.turnScript = COMPLETED_TURN;
    await expect(handle.reply('turno C')).resolves.toMatchObject({ status: 'completed' });
  });

  it('dois send() INICIAIS concorrentes: o segundo rejeita (janela do await thread/start)', async () => {
    const t = new FakeTransport();
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());

    t.turnScript = COMPLETED_TURN;
    const pA = handle.send('send A');
    await expect(handle.send('send B')).rejects.toBeInstanceOf(CodexTurnInFlightError);
    await pA;
    expect(t.requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
  });

  it('liberacao no erro de thread/start: a falha inicial NAO bloqueia o handle permanentemente', async () => {
    const t = new FakeTransport();
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());

    t.failNextThreadStart = new CodexUnavailableError('thread/start exploded');
    await expect(handle.send('vai falhar')).rejects.toBeInstanceOf(CodexUnavailableError);
    expect(guardHeld(handle)).toBe(false);

    t.turnScript = COMPLETED_TURN;
    await expect(handle.send('agora vai')).resolves.toMatchObject({ status: 'completed' });
  });

  it('liberacao no erro de turn/start', async () => {
    const t = new FakeTransport();
    t.turnScript = COMPLETED_TURN;
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    await handle.send('primeiro');

    t.failNextTurnStart = new Error('turn/start exploded');
    await expect(handle.reply('vai falhar')).rejects.toBeInstanceOf(CodexUnavailableError);
    expect(guardHeld(handle)).toBe(false);

    t.turnScript = COMPLETED_TURN;
    await expect(handle.reply('agora vai')).resolves.toMatchObject({ status: 'completed' });
  });

  it('liberacao no abort: o proximo turno passa depois que o turno abortado assenta', async () => {
    const t = new FakeTransport();
    t.turnScript = [{ method: 'turn/started', params: { turnId: 'turn-fake-1' } }];
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());

    const ac = new AbortController();
    const pA = handle.send('longo', {}, ac.signal);
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(guardHeld(handle)).toBe(true);
    t.emit({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } });
    await pA;
    expect(guardHeld(handle)).toBe(false);

    t.turnScript = COMPLETED_TURN;
    await expect(handle.reply('seguinte')).resolves.toMatchObject({ status: 'completed' });
  });

  it('liberacao na excecao de runTurn (processo morto no meio do turno)', async () => {
    const t = new FakeTransport();
    t.turnScript = [{ method: 'turn/started', params: { turnId: 'turn-fake-1' } }];
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());

    const pA = handle.send('vai morrer');
    await new Promise((r) => setTimeout(r, 0));
    t.failProcess('app-server crashed');
    await expect(pA).rejects.toBeInstanceOf(CodexUnavailableError);
    expect(guardHeld(handle)).toBe(false);
  });

  it('liberacao no close() (async e sync-adapter): guard nunca fica preso', async () => {
    const t = new FakeTransport();
    t.turnScript = [{ method: 'turn/started', params: { turnId: 'turn-fake-1' } }];
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());

    void handle.send('em voo');
    await new Promise((r) => setTimeout(r, 0));
    expect(guardHeld(handle)).toBe(true);
    await handle.close();
    expect(guardHeld(handle)).toBe(false);

    const t2 = new FakeTransport();
    t2.turnScript = [{ method: 'turn/started', params: { turnId: 'turn-fake-1' } }];
    const driver2 = driverWith(t2);
    const handle2 = await driver2.createRun(makeOpts({ key: makeKey({ runId: 'run-2' }) }));
    void handle2.send('em voo');
    await new Promise((r) => setTimeout(r, 0));
    expect(guardHeld(handle2)).toBe(true);
    driver2.toSyncCodexSession(handle2).close();
    expect(guardHeld(handle2)).toBe(false);
  });
});

describe('BUG 4 hardening - scoping por turnId (item/* de turno orfao)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('item/agentMessage/delta de turnId DIFERENTE do raiz nao acumula, nao vira onText e nao rouba o turnId', async () => {
    const t = new FakeTransport();
    t.turnScript = [{ method: 'turn/started', params: { turnId: 'turn-fake-1' } }];
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());

    const onText = vi.fn();
    const p = handle.send('go', { onText });
    await new Promise((r) => setTimeout(r, 0));
    expect(handle.turnId).toBe('turn-fake-1');

    t.emit({
      method: 'item/agentMessage/delta',
      params: { turnId: 'turn-orphan-9', delta: 'ORPHAN' },
    });
    expect(handle.turnId).toBe('turn-fake-1');

    t.emit({
      method: 'item/agentMessage/delta',
      params: { turnId: 'turn-fake-1', delta: 'raiz-' },
    });
    t.emit({ method: 'item/agentMessage/delta', params: { delta: 'ok' } });
    t.emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });

    const res = await p;
    expect(res.content).toBe('raiz-ok');
    expect(res.content).not.toContain('ORPHAN');
    expect(onText).toHaveBeenCalledTimes(2);
    expect(onText).not.toHaveBeenCalledWith('ORPHAN');
  });
});
