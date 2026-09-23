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
import {
  createAccumulator,
  finalizeResponse,
  extractCodexErrorCode,
  extractCodexErrorDetail,
  type AppServerEvent,
} from '../official-event-translator';
import { codexTurnFailureError, TypedProviderError } from '../../agent-runtime/llm-error';
import type { CodexRunOptions, CodexRunSessionKey } from '../types';

const { CodexAuthError } = bridge;

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

describe('SB-4 extractCodexErrorCode', () => {
  it('AC-B11: ErrorNotification com error string retorna a string', () => {
    expect(extractCodexErrorCode({ method: 'error', params: { error: 'usageLimitExceeded' } })).toBe(
      'usageLimitExceeded',
    );
  });

  it('AC-B11: ErrorNotification com enum-variant serde retorna a chave', () => {
    expect(
      extractCodexErrorCode({
        method: 'error',
        params: { willRetry: false, error: { usageLimitExceeded: {} } },
      }),
    ).toBe('usageLimitExceeded');
  });

  it('AC-B11: turn/completed com turn.error.code retorna o code', () => {
    expect(
      extractCodexErrorCode({
        method: 'turn/completed',
        params: { turn: { status: 'failed', error: { code: 'serverOverloaded' } } },
      }),
    ).toBe('serverOverloaded');
  });

  it('AC-B11: turn.error so com message (sem code) retorna undefined', () => {
    expect(
      extractCodexErrorCode({
        method: 'turn/completed',
        params: { turn: { error: { message: 'boom' } } },
      }),
    ).toBeUndefined();
  });

  it('AC-B11: evento sem params retorna undefined', () => {
    expect(extractCodexErrorCode({ method: 'error' })).toBeUndefined();
  });
});

describe('SB-4 finalizeResponse errorCode gating (AC-B11 [INV])', () => {
  it('AC-B11: status completed e byte-identico — a chave errorCode NAO existe', () => {
    const acc = createAccumulator('t-1');
    acc.content = 'ok';
    const res = finalizeResponse(acc, 'completed');
    expect(res).toEqual({
      threadId: 't-1',
      content: 'ok',
      filesChanged: [],
      commandsRun: [],
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
      status: 'completed',
      applyPatchFailures: 0,
      applyPatchFailureSamples: [],
    });
    expect('errorCode' in res).toBe(false);
  });

  it('AC-B11: completed mesmo com acc.errorCode residual NAO ganha a chave', () => {
    const acc = createAccumulator('t-1');
    acc.errorCode = 'usageLimitExceeded';
    const res = finalizeResponse(acc, 'completed');
    expect('errorCode' in res).toBe(false);
  });

  it('AC-B11: auth_required NUNCA ganha errorCode (G3)', () => {
    const acc = createAccumulator('t-1');
    acc.authRequired = true;
    acc.errorCode = 'unauthorized';
    const res = finalizeResponse(acc, 'auth_required');
    expect(res.status).toBe('auth_required');
    expect('errorCode' in res).toBe(false);
  });

  it('AC-B11: failed com acc.errorCode propaga o code', () => {
    const acc = createAccumulator('t-1');
    acc.failed = true;
    acc.errorCode = 'usageLimitExceeded';
    const res = finalizeResponse(acc, 'failed');
    expect(res.status).toBe('failed');
    expect(res.errorCode).toBe('usageLimitExceeded');
  });

  it('AC-B11: timeout com acc.errorCode propaga o code', () => {
    const acc = createAccumulator('t-1');
    acc.timedOut = true;
    acc.errorCode = 'serverOverloaded';
    const res = finalizeResponse(acc, 'timeout');
    expect(res.status).toBe('timeout');
    expect(res.errorCode).toBe('serverOverloaded');
  });
});

describe('SB-4 driver errorCode wiring (AC-B11/AC-B12)', () => {
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

  it('AC-B12: ramo (a) — ErrorNotification usageLimitExceeded resolve failed + errorCode', async () => {
    const t = new FakeTransport();
    t.turnScript = [
      { method: 'turn/started', params: { turnId: 'turn-fake-1' } },
      {
        method: 'error',
        params: { willRetry: false, error: { usageLimitExceeded: {} } },
      },
    ];
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    const res = await handle.send('do it', {});
    expect(res.status).toBe('failed');
    expect(res.errorCode).toBe('usageLimitExceeded');
  });

  it('AC-B11: ramo (b) — turn/completed com turn.error resolve failed + errorCode', async () => {
    const t = new FakeTransport();
    t.turnScript = [
      { method: 'turn/started', params: { turnId: 'turn-fake-1' } },
      {
        method: 'turn/completed',
        params: { turn: { status: 'failed', error: { code: 'serverOverloaded' } } },
      },
    ];
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    const res = await handle.send('do it', {});
    expect(res.status).toBe('failed');
    expect(res.errorCode).toBe('serverOverloaded');
  });

  it('AC-B11 [INV]: turno completed segue sem errorCode (caminho feliz intacto)', async () => {
    const t = new FakeTransport();
    t.turnScript = [
      { method: 'turn/started', params: { turnId: 'turn-fake-1' } },
      { method: 'item/agentMessage/delta', params: { delta: 'hello' } },
      { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    ];
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    const res = await handle.send('do it', {});
    expect(res.status).toBe('completed');
    expect(res.content).toBe('hello');
    expect('errorCode' in res).toBe(false);
  });

  it('AC-B11: error unauthorized CONTINUA CodexAuthError (G3), nao failed+errorCode', async () => {
    const t = new FakeTransport();
    t.turnScript = [
      { method: 'turn/started', params: { turnId: 'turn-fake-1' } },
      { method: 'error', params: { willRetry: false, error: 'unauthorized' } },
    ];
    const driver = driverWith(t);
    const handle = await driver.createRun(makeOpts());
    await expect(handle.send('do it', {})).rejects.toBeInstanceOf(CodexAuthError);
  });
});

describe('SB-4 codexTurnFailureError (AC-B12)', () => {
  it('AC-B12: usageLimitExceeded classifica LLM-QUOTA acionavel', () => {
    const err = codexTurnFailureError({
      status: 'failed',
      errorCode: 'usageLimitExceeded',
      model: 'gpt-5.5',
    });
    expect(err).toBeInstanceOf(TypedProviderError);
    expect(err.code).toBe('LLM-QUOTA');
    expect(err.userMessage.length).toBeGreaterThan(0);
    expect(err.suggestedAction.length).toBeGreaterThan(0);
  });

  it('AC-B12: serverOverloaded classifica LLM-OVERLOADED-529', () => {
    const err = codexTurnFailureError({ status: 'failed', errorCode: 'serverOverloaded' });
    expect(err.code).toBe('LLM-OVERLOADED-529');
  });

  it('AC-B11: timeout sem errorCode classifica LLM-TIMEOUT', () => {
    const err = codexTurnFailureError({ status: 'timeout' });
    expect(err.code).toBe('LLM-TIMEOUT');
  });

  it('AC-B11: failed sem sinal algum cai em LLM-UNKNOWN (nunca chuta categoria)', () => {
    const err = codexTurnFailureError({ status: 'failed' });
    expect(err.code).toBe('LLM-UNKNOWN');
  });
});

describe('erro embrulhado em tagged union do app-server', () => {
  const WRAPPED: AppServerEvent = {
    method: 'turn/completed',
    params: {
      turn: {
        status: 'failed',
        error: {
          codexErrorInfo: {
            message: 'You have hit your usage limit for this model.',
            details: 'resets at 14:00',
          },
        },
      },
    },
  };

  it('o code desce na tag e nao para no embrulho', () => {
    expect(extractCodexErrorCode(WRAPPED)).toBe('codexErrorInfo');
  });

  it('o detalhe humano e extraido de dentro do embrulho', () => {
    const detail = extractCodexErrorDetail(WRAPPED);
    expect(detail).toContain('usage limit');
    expect(detail).toContain('resets at 14:00');
  });

  it('code aninhado vira caminho pontuado', () => {
    expect(
      extractCodexErrorCode({
        method: 'error',
        params: { error: { codexErrorInfo: { code: 'rateLimited' } } },
      }),
    ).toBe('codexErrorInfo.rateLimited');
  });

  it('payload sem message nenhuma cai no JSON cru em vez de sumir', () => {
    const detail = extractCodexErrorDetail({
      method: 'error',
      params: { error: { weirdShape: { a: 1 } } },
    });
    expect(detail).toBe('{"weirdShape":{"a":1}}');
  });

  it('evento sem erro nao inventa detalhe', () => {
    expect(extractCodexErrorDetail({ method: 'error' })).toBeUndefined();
  });

  it('finalizeResponse propaga errorDetail so em falha', () => {
    const acc = createAccumulator('t1');
    acc.errorDetail = 'boom';
    acc.failed = true;
    expect(finalizeResponse(acc, 'failed').errorDetail).toBe('boom');
    const ok = createAccumulator('t1');
    ok.errorDetail = 'boom';
    expect(finalizeResponse(ok, 'completed').errorDetail).toBeUndefined();
  });
});
