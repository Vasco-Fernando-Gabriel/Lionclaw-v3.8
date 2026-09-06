
import { describe, it, expect, vi } from 'vitest';


vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  app: { on: vi.fn() },
}));

vi.mock('../db', () => ({
  getHarnessProject: vi.fn(),
  getAgent: vi.fn(),
  getDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: vi.fn(() => []), run: vi.fn(), get: vi.fn() })) })),
  savePipelinePhaseMetrics: vi.fn(),
  savePipelineMessage: vi.fn(),
  getPipelinePhaseMessages: vi.fn().mockReturnValue([]),
  getPipelinePhaseMessagesAsChatHistory: vi.fn().mockReturnValue([]),
  getPipelineMetrics: vi.fn().mockReturnValue({ phases: [] }),
  getHarnessSprints: vi.fn().mockReturnValue([]),
  updateHarnessProject: vi.fn(),
  updateHarnessSprint: vi.fn(),
  insertHarnessRound: vi.fn(),
  updateHarnessRound: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock('../agent-runtime', () => ({
  executeAgent: vi.fn(),
}));

vi.mock('../pipeline-shared/persist', () => ({
  persistMessage: vi.fn(),
  persistHarnessRound: { insert: vi.fn(), update: vi.fn() },
}));

vi.mock('../pipeline-shared/sdk-bootstrap', () => ({
  ensureNodeInPath: vi.fn(),
  getClaudeCodeExecutablePath: () => '/tmp/claude-cli.js',
}));



describe('SPEC-006 §11.1 + BUG 3 F4 — costSource switch', () => {
  function mapRuntimeToCostMetaMirror(
    runtime: 'cloud' | 'local' | 'external' | 'codex' | 'zai' | 'minimax-tp',
    metadata?: { costSource?: 'sdk_total_cost_usd' | 'sdk_model_usage' | 'calculated' },
  ): { costSource: string; runtimeUsed: string } {
    switch (runtime) {
      case 'cloud': {
        const sdkReported =
          metadata?.costSource === 'sdk_total_cost_usd' ||
          metadata?.costSource === 'sdk_model_usage';
        return { costSource: sdkReported ? 'sdk_anthropic' : 'calculated', runtimeUsed: 'cloud' };
      }
      case 'codex':
        return { costSource: 'calculated', runtimeUsed: 'codex' };
      case 'zai':
        return { costSource: 'calculated', runtimeUsed: 'zai' };
      case 'local':
        return { costSource: 'calculated', runtimeUsed: 'local' };
      case 'external':
        return { costSource: 'reported', runtimeUsed: 'external' };
      case 'minimax-tp':
        return { costSource: 'calculated', runtimeUsed: 'minimax-tp' };
    }
  }

  it('minimax-tp returns { costSource: calculated, runtimeUsed: minimax-tp }', () => {
    expect(mapRuntimeToCostMetaMirror('minimax-tp')).toEqual({
      costSource: 'calculated',
      runtimeUsed: 'minimax-tp',
    });
  });

  it('cloud with SDK-reported cost (F2 total_cost_usd) returns sdk_anthropic', () => {
    expect(mapRuntimeToCostMetaMirror('cloud', { costSource: 'sdk_total_cost_usd' })).toEqual({
      costSource: 'sdk_anthropic',
      runtimeUsed: 'cloud',
    });
    expect(mapRuntimeToCostMetaMirror('cloud', { costSource: 'sdk_model_usage' })).toEqual({
      costSource: 'sdk_anthropic',
      runtimeUsed: 'cloud',
    });
  });

  it('cloud with calculateCost fallback (abort/crash sem result) returns calculated', () => {
    expect(mapRuntimeToCostMetaMirror('cloud', { costSource: 'calculated' })).toEqual({
      costSource: 'calculated',
      runtimeUsed: 'cloud',
    });
    expect(mapRuntimeToCostMetaMirror('cloud')).toEqual({
      costSource: 'calculated',
      runtimeUsed: 'cloud',
    });
  });

  it('zai returns calculated (BUG 3 F4 — fallback_zero era rotulo obsoleto)', () => {
    expect(mapRuntimeToCostMetaMirror('zai')).toEqual({
      costSource: 'calculated',
      runtimeUsed: 'zai',
    });
  });

  it('local returns calculated (regression guard)', () => {
    expect(mapRuntimeToCostMetaMirror('local')).toEqual({
      costSource: 'calculated',
      runtimeUsed: 'local',
    });
  });

  it('external returns reported (regression guard)', () => {
    expect(mapRuntimeToCostMetaMirror('external')).toEqual({
      costSource: 'reported',
      runtimeUsed: 'external',
    });
  });

  it('codex returns calculated + runtimeUsed codex (BUG 3 F4 / 3.1 item 4)', () => {
    expect(mapRuntimeToCostMetaMirror('codex')).toEqual({
      costSource: 'calculated',
      runtimeUsed: 'codex',
    });
  });
});


import fs from 'fs';
import path from 'path';

describe('SPEC-006 §11.1 — harness-engine.ts source verification', () => {
  it('harness-engine.ts has case minimax-tp returning costSource: calculated', () => {
    const harnessEnginePath = path.join(__dirname, '..', 'harness-engine.ts');
    const source = fs.readFileSync(harnessEnginePath, 'utf-8');

    expect(source).toContain("case 'minimax-tp':");
    expect(source).toContain("{ costSource: 'calculated', runtimeUsed: 'minimax-tp' }");
  });

  it('harness-engine.ts labels match BUG 3 F4 (zai/codex calculated, codex runtime)', () => {
    const harnessEnginePath = path.join(__dirname, '..', 'harness-engine.ts');
    const source = fs.readFileSync(harnessEnginePath, 'utf-8');
    expect(source).toContain('SPEC-006');
    const zaiBlock = source.slice(
      source.indexOf("case 'zai':"),
      source.indexOf("case 'zai':") + 120,
    );
    expect(zaiBlock).toContain("costSource: 'calculated'");
    expect(zaiBlock).not.toContain('fallback_zero');
    const codexBlock = source.slice(
      source.indexOf("case 'codex':"),
      source.indexOf("case 'codex':") + 120,
    );
    expect(codexBlock).toContain("{ costSource: 'calculated', runtimeUsed: 'codex' }");
  });
});


describe('SPEC-006 Sprint 2.4.2 — execute.ts dispatch source verification', () => {
  it('execute.ts imports minimaxTokenplanExecutor', () => {
    const executePath = path.join(__dirname, '..', 'agent-runtime', 'execute.ts');
    const source = fs.readFileSync(executePath, 'utf-8');
    expect(source).toContain("import { minimaxTokenplanExecutor } from './minimax-tokenplan-executor'");
  });

  it("execute.ts has case 'minimax-tp' delegating to minimaxTokenplanExecutor.run", () => {
    const executePath = path.join(__dirname, '..', 'agent-runtime', 'execute.ts');
    const source = fs.readFileSync(executePath, 'utf-8');

    expect(source).toContain("case 'minimax-tp':");
    const caseBlock = source.slice(
      source.indexOf("case 'minimax-tp':"),
      source.indexOf("case 'minimax-tp':") + 120,
    );
    expect(caseBlock).toContain('minimaxTokenplanExecutor.run');
    expect(caseBlock).not.toContain('ainda nao tem executor implementado');
  });

  it('execute.ts retains exhaustiveness guard (default: never)', () => {
    const executePath = path.join(__dirname, '..', 'agent-runtime', 'execute.ts');
    const source = fs.readFileSync(executePath, 'utf-8');
    expect(source).toContain('_exhaustive: never');
  });

  it('execute.ts does not import from zai-executor (no cross-contamination)', () => {
    const minimaxTpPath = path.join(__dirname, '..', 'agent-runtime', 'minimax-tokenplan-executor.ts');
    const source = fs.readFileSync(minimaxTpPath, 'utf-8');
    expect(source).not.toContain("from './zai-executor'");
    expect(source).not.toContain('from "../agent-runtime/zai-executor"');
    expect(source).not.toContain('lion-sdk');
  });
});
