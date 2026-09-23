import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  CliRunHandle,
  CliRunOptions,
  CliAgenticResponse,
  CliStreamCallbacks,
} from '../agent-runtime/cli-agentic/contract';

const mocks = vi.hoisted(() => ({
  calculateCost: vi.fn().mockReturnValue(0.0042),
  getPricingSnapshot: vi.fn((model: string) => ({
    pricingVersion: 'test-pricing',
    model,
    entry: { input: 1, output: 2, cacheRead: 0.5, cacheCreation: 0 },
  })),
}));
const calculateCostMock = mocks.calculateCost;

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../pricing', () => ({
  calculateCost: mocks.calculateCost,
  getPricingSnapshot: mocks.getPricingSnapshot,
}));

vi.mock('../db', () => ({ getSetting: vi.fn().mockReturnValue(undefined) }));

vi.mock('../app-version', () => ({ getAppVersion: () => '1.2.3' }));

vi.mock('which', () => ({ default: vi.fn().mockResolvedValue('/usr/local/bin/kimi') }));

const sdkState = vi.hoisted(() => ({
  loggedIn: true,
}));

vi.mock('@moonshot-ai/kimi-agent-sdk', () => ({
  isLoggedIn: () => sdkState.loggedIn,
}));

vi.mock('../agent-runtime/kimi-availability', async () => {
  const actual = await vi.importActual<typeof import('../agent-runtime/kimi-availability')>(
    '../agent-runtime/kimi-availability',
  );
  return {
    ...actual,
    resolveKimiBinary: vi.fn().mockResolvedValue('/usr/local/bin/kimi'),
    isKimiAvailable: vi.fn(async (model?: string) => ({
      installed: true,
      version: '0.27.0',
      authenticated: sdkState.loggedIn,
      authMode: sdkState.loggedIn ? 'subscription' : 'none',
      managedProviderVerified: sdkState.loggedIn,
      modelAvailable: sdkState.loggedIn && (model === 'kimi-code/kimi-for-coding' || model === 'kimi-code/k3'),
      usable: sdkState.loggedIn,
      availableModels: sdkState.loggedIn ? ['kimi-code/kimi-for-coding'] : [],
    })),
  };
});

type SendImpl = (prompt: string, cb?: CliStreamCallbacks, abortSignal?: AbortSignal) => Promise<CliAgenticResponse>;

const driverState = vi.hoisted(() => ({
  sendImpl: undefined as unknown as SendImpl,
  lastRunOptions: undefined as unknown,
  createRun: undefined as unknown,
  close: undefined as unknown,
}));

vi.mock('../kimi-acp/acp-driver', () => ({
  getKimiAcpDriver: () => ({
    createRun: (opts: CliRunOptions) => (driverState.createRun as (o: CliRunOptions) => Promise<CliRunHandle>)(opts),
  }),
}));

import { kimiExecutor, KimiAuthError, KimiUnavailableError, KimiQuotaError } from '../agent-runtime/kimi-executor';
import { _resetKimiPoolForTests, _kimiPoolStateForTests, acquireKimiSlot } from '../agent-runtime/kimi-concurrency';
import { PERM_BYPASS_NO_GUARD } from '../agent-runtime/permission-profiles';
import type { AgentExecutionRequest } from '../agent-runtime/types';
import type { AgentQueryConfig } from '../agent-config-resolver';
import {
  KimiEffortUnsupportedError,
  normalizeKimiModelSelection,
  resolveKimiStoredEffort,
} from '../../../src/constants/kimi-models';

function defaultResponse(overrides: Partial<CliAgenticResponse> = {}): CliAgenticResponse {
  return {
    content: 'Hello world',
    usage: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 50,
    },
    toolUses: 1,
    status: 'finished',
    ...overrides,
  };
}

function makeFakeHandle(): { handle: CliRunHandle; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn().mockResolvedValue(undefined);
  const handle: CliRunHandle = {
    send: (prompt, cb, abortSignal) => driverState.sendImpl(prompt, cb, abortSignal),
    reply: (prompt, cb, abortSignal) => driverState.sendImpl(prompt, cb, abortSignal),
    interrupt: vi.fn().mockResolvedValue(undefined),
    close,
    forceKillFallback: vi.fn().mockResolvedValue(undefined),
  };
  return { handle, close };
}

function installFakeDriver(): {
  createRun: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const fake = makeFakeHandle();
  const createRun = vi.fn(async (opts: CliRunOptions): Promise<CliRunHandle> => {
    driverState.lastRunOptions = opts;
    return fake.handle;
  });
  driverState.createRun = createRun;
  driverState.close = fake.close;
  return { createRun, close: fake.close };
}

function makeReq(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    agentId: 'test-kimi-agent',
    prompt: 'Implement the feature',
    cwd: '/tmp/project',
    abortController: new AbortController(),
    permission: PERM_BYPASS_NO_GUARD,
    onText: vi.fn(),
    onThinking: vi.fn(),
    onToolUse: vi.fn(),
    onToolUseComplete: vi.fn(),
    onActivity: vi.fn(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
  return {
    model: 'kimi-code/kimi-for-coding',
    systemPrompt: 'You are a helpful coding agent.',
    runtime: 'kimi',
    effort: 'high',
    thinking: 'adaptive',
    allowedTools: [],
    mcpServers: [],
    maxTurns: undefined,
    thinkingBudget: undefined,
    ...overrides,
  } as AgentQueryConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetKimiPoolForTests(3);
  sdkState.loggedIn = true;
  calculateCostMock.mockReturnValue(0.0042);
  driverState.sendImpl = async (_prompt, cb) => {
    cb?.onText?.('Hello ');
    cb?.onText?.('world');
    cb?.onToolUse?.('Read');
    cb?.onToolUseComplete?.('Read', { is_error: false, output: 'file contents' });
    cb?.onActivity?.();
    return defaultResponse();
  };
  installFakeDriver();
});

describe('kimi-executor dispatch end-to-end (SPEC-011 §6.1)', () => {
  it('returns the correct AgentExecutionResult shape and calls createRun+close once', async () => {
    const res = await kimiExecutor.run(makeReq(), makeConfig());

    expect(res.runtime).toBe('kimi');
    expect(res.provider).toBe('kimi');
    expect(res.model).toBe('kimi-code/kimi-for-coding');
    expect(res.output).toBe('Hello world');
    expect(res.metrics.inputTokens).toBe(1000);
    expect(res.metrics.outputTokens).toBe(500);
    expect(res.metrics.cacheReadTokens).toBe(200);
    expect(res.metrics.cacheCreationTokens).toBe(50);
    expect(res.metrics.toolUses).toBe(1);
    expect(res.metrics.apiRequests).toBe(1);
    expect(driverState.createRun as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(driverState.close as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(_kimiPoolStateForTests().active).toBe(0);
  });

  it('callbacks fire through the driver handle send (onText/onToolUse/onToolUseComplete/onActivity)', async () => {
    const req = makeReq();
    await kimiExecutor.run(req, makeConfig());

    expect(req.onText).toHaveBeenCalledWith('Hello ');
    expect(req.onText).toHaveBeenCalledWith('world');
    expect(req.onToolUse).toHaveBeenCalledWith('Read');
    expect(req.onToolUseComplete).toHaveBeenCalledWith('Read', {
      is_error: false,
      output: 'file contents',
    });
    expect(req.onActivity).toHaveBeenCalled();
  });

  it('passes config.model + a one-shot profile + abortSignal THROUGH to createRun', async () => {
    await kimiExecutor.run(makeReq(), makeConfig({ model: 'kimi-code/kimi-for-coding' }));

    const opts = driverState.lastRunOptions as {
      model: string;
      profile: string;
      surface: string;
      ownerKind: string;
      systemPrompt: string;
      abortSignal?: AbortSignal;
      mcpServers?: unknown[];
    };
    expect(opts.model).toBe('kimi-code/kimi-for-coding');
    expect(opts.profile).toBe('one-shot');
    expect(opts.surface).toBe('agent');
    expect(opts.ownerKind).toBe('agent');
    expect(opts.systemPrompt).toBe('');
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
    expect((driverState.lastRunOptions as { effort?: string }).effort).toBeUndefined();
  });

  it('a pipeline-injected projectId yields a pipeline profile + pipeline surface', async () => {
    await kimiExecutor.run(makeReq({ projectId: 'proj-9' }), makeConfig());
    await kimiExecutor.run(makeReq({ projectId: 'proj-9' }), makeConfig());

    const runOptions = (driverState.createRun as ReturnType<typeof vi.fn>).mock.calls.map(
      ([options]) =>
        options as {
          profile: string;
          surface: string;
          ownerKind: string;
          projectId?: string;
          runId: string;
        },
    );
    const opts = runOptions[0]!;
    const second = runOptions[1]!;
    expect(opts.profile).toBe('pipeline');
    expect(opts.surface).toBe('pipeline');
    expect(opts.ownerKind).toBe('pipeline');
    expect(opts.projectId).toBe('proj-9');
    expect(opts.runId).toMatch(/^kimi-exec-[0-9a-f-]{36}$/);
    expect(second.runId).toMatch(/^kimi-exec-[0-9a-f-]{36}$/);
    expect(second.runId).not.toBe(opts.runId);
  });

  it('aplica effort Kimi herdado model-aware e repassa a permission policy ao driver', async () => {
    const req = makeReq({
      inheritedEffort: { claude: 'high', codex: 'high', kimi: 'low' },
    });
    await kimiExecutor.run(req, makeConfig({ model: 'kimi-code/k3', effort: 'high' }));
    const opts = driverState.lastRunOptions as {
      model: string;
      effort?: string;
      permission?: unknown;
    };
    expect(opts.model).toBe('kimi-code/k3');
    expect(opts.effort).toBe('low');
    expect(opts.permission).toBe(req.permission);
  });

  it('rejeita override explicito de effort no K2.7 boolean-only antes de criar o run', async () => {
    const req = makeReq({ effortOverride: 'high' });

    await expect(
      kimiExecutor.run(req, makeConfig({ model: 'kimi-code/kimi-for-coding', effort: 'low' })),
    ).rejects.toBeInstanceOf(KimiEffortUnsupportedError);

    expect(driverState.createRun as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(_kimiPoolStateForTests().active).toBe(0);
  });

  it('aplica override explicito de effort no K3 tiered', async () => {
    await kimiExecutor.run(makeReq({ effortOverride: 'low' }), makeConfig({ model: 'kimi-code/k3', effort: 'max' }));

    expect((driverState.lastRunOptions as { effort?: string }).effort).toBe('low');
  });

  it('mantem effort herdado degradavel no K2.7 boolean-only', async () => {
    await kimiExecutor.run(
      makeReq({ inheritedEffort: { claude: 'high', codex: 'high', kimi: 'low' } }),
      makeConfig({ model: 'kimi-code/kimi-for-coding', effort: 'max' }),
    );

    expect((driverState.lastRunOptions as { effort?: string }).effort).toBeUndefined();
  });
});

describe('Kimi UI model-aware helpers', () => {
  it('refresh preserva K3 e corrige apenas slug fora do catalogo', () => {
    expect(normalizeKimiModelSelection('kimi-code/k3')).toBe('kimi-code/k3');
    expect(normalizeKimiModelSelection('kimi-code/removido')).toBe('kimi-code/kimi-for-coding');
  });

  it('K2.7 fica boolean-only e K3 restringe effort a low/high/max', () => {
    expect(resolveKimiStoredEffort('kimi-code/kimi-for-coding', 'high')).toBeUndefined();
    expect(resolveKimiStoredEffort('kimi-code/k3', 'medium')).toBe('max');
    expect(resolveKimiStoredEffort('kimi-code/k3', 'low')).toBe('low');
  });
});

describe('kimi-executor cost (SPEC-011 §7, decision 8)', () => {
  it('subscription: costEstimationKind set + costUsd>0 + cost priced via remapped kimi-k2.7-code while result model stays kimi-code/kimi-for-coding', async () => {
    sdkState.loggedIn = true;

    const res = await kimiExecutor.run(makeReq(), makeConfig({ model: 'kimi-code/kimi-for-coding' }));

    expect(res.metadata?.costEstimationKind).toBe('subscription-equivalent-payg');
    expect(res.metadata?.costSource).toBe('calculated');
    expect(res.metrics.costUsd).toBeGreaterThan(0);
    expect(res.metrics.costStatus).toBe('known');
    expect(res.metrics.tokenStatus).toBe('reported');
    expect(res.model).toBe('kimi-code/kimi-for-coding');
    expect(res.metadata?.pricingSnapshot).toEqual(
      expect.objectContaining({
        pricingVersion: 'test-pricing',
        model: 'kimi-k2.7-code',
      }),
    );
    expect(res.metadata?.modelUsage).toEqual({
      'kimi-k2.7-code': {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 50,
        costUSD: 0.0042,
        modelCalls: 1,
      },
    });
    expect(calculateCostMock).toHaveBeenCalledWith('kimi-k2.7-code', 1000, 500, 200, 50);
  });

  it('subscription zero-usage defensive: costStatus unknown + tokenStatus not_reported + reason, flag present', async () => {
    sdkState.loggedIn = true;
    driverState.sendImpl = async (_prompt, cb) => {
      cb?.onText?.('produced some text');
      return defaultResponse({
        content: 'produced some text',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        toolUses: 0,
      });
    };

    const res = await kimiExecutor.run(makeReq(), makeConfig());

    expect(res.metrics.costStatus).toBe('unknown');
    expect(res.metrics.tokenStatus).toBe('not_reported');
    expect(res.metrics.costUnknownReason).toBe('no-usage-reported');
    expect(res.metrics.costUsd).toBe(0);
    expect(res.metadata?.costEstimationKind).toBe('subscription-equivalent-payg');
  });

  it('subscription usage unilateral permanece unknown/not_reported', async () => {
    sdkState.loggedIn = true;
    driverState.sendImpl = async () =>
      defaultResponse({
        content: 'resposta parcial',
        usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 20, cacheCreationTokens: 0 },
        toolUses: 0,
      });

    const res = await kimiExecutor.run(makeReq(), makeConfig());

    expect(res.metrics).toEqual(
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        costStatus: 'unknown',
        tokenStatus: 'not_reported',
        costUnknownReason: 'no-usage-reported',
      }),
    );
    expect(calculateCostMock).not.toHaveBeenCalled();
  });

  it('turno somente-tool sem usage permanece unknown/not_reported', async () => {
    sdkState.loggedIn = true;
    driverState.sendImpl = async () =>
      defaultResponse({
        content: '',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        toolUses: 1,
      });

    const res = await kimiExecutor.run(makeReq(), makeConfig());

    expect(res.error).toBeUndefined();
    expect(res.metrics).toEqual(
      expect.objectContaining({
        toolUses: 1,
        costUsd: 0,
        costStatus: 'unknown',
        tokenStatus: 'not_reported',
        costUnknownReason: 'no-usage-reported',
      }),
    );
    expect(calculateCostMock).not.toHaveBeenCalled();
  });
});

describe('kimi-executor no-auth (SPEC-011 §6.7)', () => {
  it('not logged in => KimiAuthError, no run created, no $0 result (no api-key fallback)', async () => {
    sdkState.loggedIn = false;

    await expect(kimiExecutor.run(makeReq(), makeConfig())).rejects.toBeInstanceOf(KimiAuthError);
    expect(driverState.createRun as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(_kimiPoolStateForTests().active).toBe(0);
  });
});

describe('kimi-executor cancel (SPEC-011 §8, §4.2, §6.1 deferral #5)', () => {
  it('abort mid-stream => run rejects (cancel classification wins), handle.close() still called', async () => {
    const req = makeReq();
    driverState.sendImpl = async (_prompt, cb) => {
      cb?.onText?.('partial');
      req.abortController.abort();
      throw new KimiUnavailableError('kimi acp turn idle-timeout (no progress)');
    };

    await expect(kimiExecutor.run(req, makeConfig())).rejects.toBeInstanceOf(KimiUnavailableError);
    expect(driverState.close as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(_kimiPoolStateForTests().active).toBe(0);
  });

  it('already aborted before start => throws and never creates a run', async () => {
    const req = makeReq();
    req.abortController.abort();

    await expect(kimiExecutor.run(req, makeConfig())).rejects.toBeInstanceOf(KimiUnavailableError);
    expect(driverState.createRun as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe('kimi-executor KI-3 wedge/error => phase FAILS (AC-S6.1b, SPEC §8.4)', () => {
  it('driver send() REJECTS (idle-timeout) => executor THROWS, does NOT return a success result, slot released, handle closed', async () => {
    driverState.sendImpl = async () => {
      throw new KimiUnavailableError('kimi acp turn idle-timeout (no progress for 1200000ms)');
    };

    const result = kimiExecutor.run(makeReq(), makeConfig());
    await expect(result).rejects.toBeInstanceOf(KimiUnavailableError);
    await expect(result).rejects.toThrow(/idle-timeout/);
    expect(driverState.close as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(_kimiPoolStateForTests().active).toBe(0);
  });

  it('driver send() REJECTS (error notification) => executor THROWS (phase retries)', async () => {
    driverState.sendImpl = async () => {
      throw new KimiUnavailableError('kimi acp error notification: model_error');
    };

    await expect(kimiExecutor.run(makeReq(), makeConfig())).rejects.toBeInstanceOf(KimiUnavailableError);
    expect(_kimiPoolStateForTests().active).toBe(0);
  });
});

describe('kimi-executor quota degradation (SPEC-011 §6.8 G-08)', () => {
  it('429/rate-limit error => throws KimiQuotaError, slot released, no silent $0', async () => {
    driverState.sendImpl = async () => {
      throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
    };

    await expect(kimiExecutor.run(makeReq(), makeConfig())).rejects.toBeInstanceOf(KimiQuotaError);
    expect(_kimiPoolStateForTests().active).toBe(0);
    const release = await acquireKimiSlot();
    expect(typeof release).toBe('function');
    release();
    expect(driverState.close as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it('a generic (non-quota) error propagates as-is (not wrapped in KimiQuotaError)', async () => {
    driverState.sendImpl = async () => {
      throw new Error('disk full');
    };

    await expect(kimiExecutor.run(makeReq(), makeConfig())).rejects.toThrow('disk full');
    expect(_kimiPoolStateForTests().active).toBe(0);
  });
});

describe('kimi-executor slot ordering (SPEC-011 §6.8)', () => {
  it('acquires a slot BEFORE createRun (queued run holds no subprocess)', async () => {
    _resetKimiPoolForTests(1);
    const blockingRelease = await acquireKimiSlot();
    expect(_kimiPoolStateForTests().active).toBe(1);

    const runPromise = kimiExecutor.run(makeReq(), makeConfig());

    await Promise.resolve();
    await Promise.resolve();
    expect(driverState.createRun as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

    blockingRelease();
    await runPromise;
    expect(driverState.createRun as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(_kimiPoolStateForTests().active).toBe(0);
  });
});
