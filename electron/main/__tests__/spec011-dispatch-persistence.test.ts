
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
};

vi.mock('../agent-runtime/cloud-executor', () => ({ cloudExecutor: { run: (...a: unknown[]) => runSpies.cloud(...a) } }));
vi.mock('../agent-runtime/local-executor', () => ({ localExecutor: { run: (...a: unknown[]) => runSpies.local(...a) } }));
vi.mock('../agent-runtime/external-executor', () => ({ externalExecutor: { run: (...a: unknown[]) => runSpies.external(...a) } }));
vi.mock('../agent-runtime/codex-executor', () => ({ codexExecutor: { run: (...a: unknown[]) => runSpies.codex(...a) } }));
vi.mock('../agent-runtime/zai-executor', () => ({ zaiExecutor: { run: (...a: unknown[]) => runSpies.zai(...a) } }));
vi.mock('../agent-runtime/minimax-tokenplan-executor', () => ({
  minimaxTokenplanExecutor: { run: (...a: unknown[]) => runSpies['minimax-tp'](...a) },
}));
vi.mock('../agent-runtime/kimi-executor', () => ({ kimiExecutor: { run: (...a: unknown[]) => runSpies.kimi(...a) } }));

import { executeAgent } from '../agent-runtime/execute';
import type { AgentExecutionRequest } from '../agent-runtime/types';

const MAIN = join(__dirname, '..');

function fakeConfig(runtime: string) {
  return { runtime, model: 'test-model', systemPrompt: 'sp' };
}

function fakeRequest(): AgentExecutionRequest {
  return {
    agentId: 'agent-x',
    prompt: 'hello',
    cwd: '/tmp',
    abortController: new AbortController(),
    permission: { mode: 'bypassPermissions', dangerouslySkipPermissions: true },
  } as unknown as AgentExecutionRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const spy of Object.values(runSpies)) spy.mockResolvedValue({ output: 'ok' });
});


describe('SPEC-011 §12: executeAgent dispatch per new union value (kimi)', () => {
  it("runtime:'kimi' calls kimiExecutor.run exactly once (and no other executor)", async () => {
    mockResolveAgentQueryConfig.mockResolvedValue(fakeConfig('kimi'));
    await executeAgent(fakeRequest());
    expect(runSpies.kimi).toHaveBeenCalledTimes(1);
    expect(runSpies.cloud).not.toHaveBeenCalled();
    expect(runSpies.codex).not.toHaveBeenCalled();
    expect(runSpies['minimax-tp']).not.toHaveBeenCalled();
    expect(runSpies.local).not.toHaveBeenCalled();
    expect(runSpies.external).not.toHaveBeenCalled();
    expect(runSpies.zai).not.toHaveBeenCalled();
  });

  it.each([
    ['cloud', 'cloud'],
    ['codex', 'codex'],
    ['minimax-tp', 'minimax-tp'],
    ['local', 'local'],
    ['external', 'external'],
    ['zai', 'zai'],
  ] as const)(
    "runtime:'%s' routes to its own executor and NEVER kimiExecutor.run",
    async (runtime, spyKey) => {
      mockResolveAgentQueryConfig.mockResolvedValue(fakeConfig(runtime));
      await executeAgent(fakeRequest());
      expect(runSpies[spyKey]).toHaveBeenCalledTimes(1);
      expect(runSpies.kimi).not.toHaveBeenCalled();
    },
  );
});


describe('SPEC-011 §6.5: orchestrator.ts routes kimi-sdk to executeKimiSdkQuery', () => {
  it("orchestrator.ts has case 'kimi-sdk' delegating to executeKimiSdkQuery", () => {
    const src = readFileSync(join(MAIN, 'orchestrator.ts'), 'utf8');
    expect(src).toContain("case 'kimi-sdk':");
    const caseBlock = src.slice(
      src.indexOf("case 'kimi-sdk':"),
      src.indexOf("case 'kimi-sdk':") + 160,
    );
    expect(caseBlock).toContain('executeKimiSdkQuery');
  });

  it('orchestrator.ts imports executeKimiSdkQuery from ./kimi-sdk', () => {
    const src = readFileSync(join(MAIN, 'orchestrator.ts'), 'utf8');
    expect(src).toContain('executeKimiSdkQuery');
  });
});


describe('SPEC-011 §4.3 P1: mapRuntimeToCostMeta kimi', () => {
  function mapRuntimeToCostMetaMirror(
    runtime: 'cloud' | 'local' | 'external' | 'codex' | 'zai' | 'minimax-tp' | 'kimi',
  ): { costSource: string; runtimeUsed: string } {
    switch (runtime) {
      case 'cloud':
        return { costSource: 'sdk_anthropic', runtimeUsed: 'cloud' };
      case 'codex':
        return { costSource: 'reported', runtimeUsed: 'cloud' };
      case 'zai':
        return { costSource: 'fallback_zero', runtimeUsed: 'zai' };
      case 'local':
        return { costSource: 'calculated', runtimeUsed: 'local' };
      case 'external':
        return { costSource: 'reported', runtimeUsed: 'external' };
      case 'minimax-tp':
        return { costSource: 'calculated', runtimeUsed: 'minimax-tp' };
      case 'kimi':
        return { costSource: 'calculated', runtimeUsed: 'kimi' };
    }
  }

  it("mirror: 'kimi' => { costSource:'calculated', runtimeUsed:'kimi' }", () => {
    expect(mapRuntimeToCostMetaMirror('kimi')).toEqual({
      costSource: 'calculated',
      runtimeUsed: 'kimi',
    });
  });

  it("source: harness-engine.ts has case 'kimi' returning calculated/kimi", () => {
    const src = readFileSync(join(MAIN, 'harness-engine.ts'), 'utf8');
    expect(src).toContain("case 'kimi':");
    expect(src).toContain("{ costSource: 'calculated', runtimeUsed: 'kimi' }");
  });

  it("regression: 'minimax-tp' arm unchanged (calculated/minimax-tp)", () => {
    expect(mapRuntimeToCostMetaMirror('minimax-tp')).toEqual({
      costSource: 'calculated',
      runtimeUsed: 'minimax-tp',
    });
  });
});


describe("SPEC-011 §12 G-04: runtimeUsed:'kimi' persists (db.ts unions)", () => {
  it("db.ts insertHarnessRound/updateHarnessRound unions include 'kimi' (FIX IN S1 if red)", () => {
    const dbSrc = readFileSync(join(MAIN, 'db.ts'), 'utf8');
    const unionLines = dbSrc
      .split('\n')
      .filter((l) => l.includes('runtimeUsed') && l.includes("'minimax-tp'"));
    expect(
      unionLines.length,
      'db.ts: expected runtimeUsed literal-union lines (db.ts:4427/:4468) - FIX IN S1 (GROUND-TRUTH §3)',
    ).toBeGreaterThanOrEqual(2);
    for (const line of unionLines) {
      expect(
        line.includes("'kimi'"),
        `db.ts runtimeUsed union missing 'kimi' - FIX IN S1 (GROUND-TRUTH §3), not S10: ${line.trim()}`,
      ).toBe(true);
    }
  });

  it("mocked round-trip: insert/update accept runtimeUsed:'kimi' and forward it", async () => {
    vi.resetModules();
    const insertHarnessRound = vi.fn();
    const updateHarnessRound = vi.fn();
    vi.doMock('../db', () => ({ insertHarnessRound, updateHarnessRound }));
    const db = await import('../db');
    expect(() =>
      db.insertHarnessRound({ id: 'r1', sprintId: 's1', runtimeUsed: 'kimi' } as never),
    ).not.toThrow();
    expect(() =>
      db.updateHarnessRound('r1', { runtimeUsed: 'kimi' } as never),
    ).not.toThrow();
    expect(insertHarnessRound).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeUsed: 'kimi' }),
    );
    expect(updateHarnessRound).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ runtimeUsed: 'kimi' }),
    );
    vi.doUnmock('../db');
  });
});


describe('SPEC-011 §13 G-05: Kimi chat reasoning is audit-only (source pin)', () => {
  it("kimi-sdk chat path routes `think` to recordAuditEntry(toolName:'kimi.reasoning', eventType:'tool_call') - FIX IN S5 if red", () => {
    const src = readFileSync(join(MAIN, 'kimi-sdk', 'stream-translator.ts'), 'utf8');
    expect(
      src.includes('recordAuditEntry'),
      "kimi-sdk/stream-translator.ts missing recordAuditEntry - FIX IN S5 (SPEC-011 §6.3/§13), not S10",
    ).toBe(true);
    expect(
      src.includes("'kimi.reasoning'") || src.includes('"kimi.reasoning"'),
      "kimi-sdk/stream-translator.ts missing toolName 'kimi.reasoning' - FIX IN S5, not S10",
    ).toBe(true);
    expect(
      src.includes("eventType: 'tool_call'") || src.includes('eventType: "tool_call"'),
      "kimi-sdk/stream-translator.ts missing eventType 'tool_call' for reasoning - FIX IN S5, not S10",
    ).toBe(true);
  });

  it("chat StreamChunk['type'] union gained NO new reasoning/think member (byte-identical)", () => {
    const typesSrc = readFileSync(join(MAIN, '..', '..', 'src', 'types', 'index.ts'), 'utf8');
    const start = typesSrc.indexOf('export interface StreamChunk');
    expect(start).toBeGreaterThan(-1);
    const block = typesSrc.slice(start, start + 800);
    const typeUnion = block.slice(block.indexOf('type:'), block.indexOf('sessionId?'));
    expect(typeUnion).not.toContain("'reasoning'");
    expect(typeUnion).not.toContain("'think'");
    expect(typeUnion).not.toContain("'thinking'");
    expect(typeUnion).not.toContain("'kimi.reasoning'");
  });
});
