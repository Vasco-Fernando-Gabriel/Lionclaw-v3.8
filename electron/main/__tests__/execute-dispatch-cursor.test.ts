import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockResolveAgentQueryConfig = vi.fn();
vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: (...args: unknown[]) => mockResolveAgentQueryConfig(...args),
}));

vi.mock('../agent-runtime/watchdog', () => ({
  WATCHDOG_TIMEOUT_MS: 180_000,
  createWatchdog: () => ({
    wrapOnText: (cb: unknown) => cb,
    wrapOnThinking: (cb: unknown) => cb,
    wrapOnToolUse: (cb: unknown) => cb,
    wrapOnToolUseComplete: (cb: unknown) => cb,
    wrapOnActivity: (cb: unknown) => cb,
    stop: vi.fn(),
  }),
}));

const runSpies = {
  cloud: vi.fn(),
  local: vi.fn(),
  external: vi.fn(),
  codex: vi.fn(),
  zai: vi.fn(),
  'minimax-tp': vi.fn(),
  kimi: vi.fn(),
  grok: vi.fn(),
  cursor: vi.fn(),
};

vi.mock('../agent-runtime/cloud-executor', () => ({
  cloudExecutor: { run: (...a: unknown[]) => runSpies.cloud(...a) },
}));
vi.mock('../agent-runtime/local-executor', () => ({
  localExecutor: { run: (...a: unknown[]) => runSpies.local(...a) },
}));
vi.mock('../agent-runtime/external-executor', () => ({
  externalExecutor: { run: (...a: unknown[]) => runSpies.external(...a) },
}));
vi.mock('../agent-runtime/codex-executor', () => ({
  codexExecutor: { run: (...a: unknown[]) => runSpies.codex(...a) },
}));
vi.mock('../agent-runtime/zai-executor', () => ({ zaiExecutor: { run: (...a: unknown[]) => runSpies.zai(...a) } }));
vi.mock('../agent-runtime/minimax-tokenplan-executor', () => ({
  minimaxTokenplanExecutor: { run: (...a: unknown[]) => runSpies['minimax-tp'](...a) },
}));
vi.mock('../agent-runtime/kimi-executor', () => ({ kimiExecutor: { run: (...a: unknown[]) => runSpies.kimi(...a) } }));
vi.mock('../agent-runtime/grok-executor', () => ({ grokExecutor: { run: (...a: unknown[]) => runSpies.grok(...a) } }));
vi.mock('../agent-runtime/cursor-executor', () => ({
  cursorExecutor: { run: (...a: unknown[]) => runSpies.cursor(...a) },
}));

import { executeAgent } from '../agent-runtime/execute';
import type { AgentExecutionRequest } from '../agent-runtime/types';

const MAIN = join(__dirname, '..');

function fakeConfig(runtime: string) {
  return { runtime, model: 'test-model', systemPrompt: 'sp', allowedTools: [] };
}

function fakeRequest(): AgentExecutionRequest {
  return {
    agentId: 'agent-x',
    prompt: 'hello',
    cwd: 'C:/tmp',
    abortController: new AbortController(),
    permission: { mode: 'bypassPermissions', dangerouslySkipPermissions: true },
  } as unknown as AgentExecutionRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const spy of Object.values(runSpies)) spy.mockResolvedValue({ output: 'ok' });
});

describe('E8: executeAgent despacha runtime cursor para cursorExecutor', () => {
  it("runtime:'cursor' chama cursorExecutor.run exatamente uma vez (e nenhum outro executor)", async () => {
    mockResolveAgentQueryConfig.mockResolvedValue(fakeConfig('cursor'));
    await executeAgent(fakeRequest());
    expect(runSpies.cursor).toHaveBeenCalledTimes(1);
    for (const [key, spy] of Object.entries(runSpies)) {
      if (key === 'cursor') continue;
      expect(spy, `executor '${key}' nao pode rodar num despacho cursor`).not.toHaveBeenCalled();
    }
  });

  it('o request repassado ao cursorExecutor preserva prompt/permission do caller', async () => {
    mockResolveAgentQueryConfig.mockResolvedValue(fakeConfig('cursor'));
    const req = fakeRequest();
    await executeAgent(req);
    const [passedReq, passedConfig] = runSpies.cursor.mock.calls[0] as [AgentExecutionRequest, { runtime: string }];
    expect(passedReq.prompt).toBe('hello');
    expect(passedReq.permission).toBe(req.permission);
    expect(passedConfig.runtime).toBe('cursor');
  });

  it.each([
    ['cloud', 'cloud'],
    ['local', 'local'],
    ['external', 'external'],
    ['codex', 'codex'],
    ['zai', 'zai'],
    ['minimax-tp', 'minimax-tp'],
    ['kimi', 'kimi'],
    ['grok', 'grok'],
  ] as const)(
    "runtime:'%s' roteia para o proprio executor e NUNCA para cursorExecutor.run",
    async (runtime, spyKey) => {
      mockResolveAgentQueryConfig.mockResolvedValue(fakeConfig(runtime));
      await executeAgent(fakeRequest());
      expect(runSpies[spyKey]).toHaveBeenCalledTimes(1);
      expect(runSpies.cursor).not.toHaveBeenCalled();
    },
  );
});

describe('E8: execute.ts source pin do despacho cursor', () => {
  const source = readFileSync(join(MAIN, 'agent-runtime', 'execute.ts'), 'utf8');

  it('importa cursorExecutor de ./cursor-executor', () => {
    expect(source).toContain("import { cursorExecutor } from './cursor-executor'");
  });

  it("tem case 'cursor' delegando a cursorExecutor.run", () => {
    expect(source).toContain("case 'cursor':");
    const caseBlock = source.slice(source.indexOf("case 'cursor':"), source.indexOf("case 'cursor':") + 120);
    expect(caseBlock).toContain('cursorExecutor.run');
  });

  it('mantem o exhaustiveness guard (default: never)', () => {
    expect(source).toContain('_exhaustive: never');
  });
});

describe('E8: harness-engine mapRuntimeToCostMeta cursor', () => {
  it("harness-engine.ts tem case 'cursor' retornando { costSource: 'calculated', runtimeUsed: 'cursor' }", () => {
    const source = readFileSync(join(MAIN, 'harness-engine.ts'), 'utf8');
    expect(source).toContain("case 'cursor':");
    const idx = source.indexOf("case 'cursor':");
    const caseBlock = source.slice(idx, idx + 300);
    expect(caseBlock).toContain("{ costSource: 'calculated', runtimeUsed: 'cursor' }");
  });
});
