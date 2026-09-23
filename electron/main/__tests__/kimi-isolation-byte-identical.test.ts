import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentExecutionResult } from '../agent-runtime/types';

const H = vi.hoisted(() => {
  type Rt = 'cloud' | 'local' | 'external' | 'codex' | 'zai' | 'minimax-tp';
  const makeExecutor = (runtime: Rt) => ({
    run: vi.fn(async () => ({
      output: `output-${runtime}`,
      metrics: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        toolUses: 0,
        apiRequests: 0,
        costUsd: 0,
        durationMs: 0,
      },
      model: 'mock-model',
      runtime,
      provider: 'mock',
    })),
  });
  return {
    cloudExecutor: makeExecutor('cloud'),
    localExecutor: makeExecutor('local'),
    externalExecutor: makeExecutor('external'),
    codexExecutor: makeExecutor('codex'),
    zaiExecutor: makeExecutor('zai'),
    minimaxTokenplanExecutor: makeExecutor('minimax-tp'),
    kimiRun: vi.fn(async () => {
      const err = new Error('kimi-executor not yet implemented');
      err.name = 'KimiUnavailableError';
      throw err;
    }),
    state: { mockRuntime: 'cloud' as Rt | 'kimi' },
  };
});

const cloudExecutor = H.cloudExecutor;
const localExecutor = H.localExecutor;
const externalExecutor = H.externalExecutor;
const codexExecutor = H.codexExecutor;
const zaiExecutor = H.zaiExecutor;
const minimaxTokenplanExecutor = H.minimaxTokenplanExecutor;
const kimiRun = H.kimiRun;

vi.mock('../agent-runtime/cloud-executor', () => ({ cloudExecutor: H.cloudExecutor }));
vi.mock('../agent-runtime/local-executor', () => ({ localExecutor: H.localExecutor }));
vi.mock('../agent-runtime/external-executor', () => ({ externalExecutor: H.externalExecutor }));
vi.mock('../agent-runtime/codex-executor', () => ({ codexExecutor: H.codexExecutor }));
vi.mock('../agent-runtime/zai-executor', () => ({ zaiExecutor: H.zaiExecutor }));
vi.mock('../agent-runtime/minimax-tokenplan-executor', () => ({
  minimaxTokenplanExecutor: H.minimaxTokenplanExecutor,
}));
vi.mock('../agent-runtime/kimi-executor', () => ({ kimiExecutor: { run: H.kimiRun } }));

vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: vi.fn(async () => ({
    runtime: H.state.mockRuntime,
    model: 'mock-model',
    systemPrompt: 'x',
  })),
}));

vi.mock('../agent-runtime/watchdog', () => ({
  WATCHDOG_TIMEOUT_MS: 180_000,
  createWatchdog: () => ({
    reset: () => {},
    stop: () => {},
    wrapOnText: (cb?: unknown) => cb ?? (() => {}),
    wrapOnThinking: (cb?: unknown) => cb ?? (() => {}),
    wrapOnToolUse: (cb?: unknown) => cb ?? (() => {}),
    wrapOnToolUseComplete: (cb?: unknown) => cb ?? (() => {}),
    wrapOnActivity: (cb?: unknown) => cb ?? (() => {}),
  }),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { executeAgent } from '../agent-runtime/execute';

function baseReq() {
  return {
    agentId: 'agent-x',
    prompt: 'hi',
    cwd: '/tmp',
    abortController: new AbortController(),
    permission: { mode: 'bypassPermissions', dangerouslySkipPermissions: true },
  } as unknown as Parameters<typeof executeAgent>[0];
}

type ExistingRuntime = Exclude<AgentExecutionResult['runtime'], 'kimi' | 'grok' | 'cursor'>;
const EXISTING_RUNTIMES: ExistingRuntime[] = ['cloud', 'local', 'external', 'codex', 'zai', 'minimax-tp'];

const EXECUTOR_BY_RUNTIME: Record<string, { run: ReturnType<typeof vi.fn> }> = {
  cloud: cloudExecutor,
  local: localExecutor,
  external: externalExecutor,
  codex: codexExecutor,
  zai: zaiExecutor,
  'minimax-tp': minimaxTokenplanExecutor,
};

describe('kimi isolation - existing runtimes route unchanged (SPEC-011 §0.1)', () => {
  beforeEach(() => {
    kimiRun.mockClear();
    for (const ex of Object.values(EXECUTOR_BY_RUNTIME)) ex.run.mockClear();
  });

  for (const rt of EXISTING_RUNTIMES) {
    it(`runtime '${rt}' reaches its own executor and NEVER kimiExecutor`, async () => {
      H.state.mockRuntime = rt;
      const res = await executeAgent(baseReq());
      expect(res.runtime).toBe(rt);
      expect(EXECUTOR_BY_RUNTIME[rt].run).toHaveBeenCalledTimes(1);
      for (const other of EXISTING_RUNTIMES) {
        if (other === rt) continue;
        expect(EXECUTOR_BY_RUNTIME[other].run).not.toHaveBeenCalled();
      }
      expect(kimiRun).not.toHaveBeenCalled();
    });
  }
});

describe('kimi isolation - kimi branch entered ONLY for runtime=kimi (SPEC-011 §6.1)', () => {
  beforeEach(() => {
    kimiRun.mockClear();
    for (const ex of Object.values(EXECUTOR_BY_RUNTIME)) ex.run.mockClear();
  });

  it("runtime 'kimi' reaches kimiExecutor (which throws the S1 stub error)", async () => {
    H.state.mockRuntime = 'kimi';
    await expect(executeAgent(baseReq())).rejects.toThrow('kimi-executor not yet implemented');
    expect(kimiRun).toHaveBeenCalledTimes(1);
    for (const ex of Object.values(EXECUTOR_BY_RUNTIME)) {
      expect(ex.run).not.toHaveBeenCalled();
    }
  });
});
