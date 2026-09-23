import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  translateEvent,
  finalizeResponse,
  createAccumulator,
  normalizeUsage,
  sandboxToWire,
  sandboxFromWire,
  approvalToWire,
  approvalFromWire,
} from '../official-event-translator';
import type { AppServerEvent, TurnOutcome, TranslatorAccumulator } from '../official-event-translator';
import type { CodexResponse } from '../types';

const FIX = path.join(__dirname, '__fixtures__', 'app-server');

function loadFixture(name: string): AppServerEvent[] {
  const raw = fs.readFileSync(path.join(FIX, `${name}.jsonl`), 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AppServerEvent);
}

interface Recorder {
  text: string[];
  reasoning: string[];
  toolUse: Array<{ tool: string; meta?: unknown }>;
  toolUseComplete: Array<{ tool: string; result: unknown }>;
  activity: number;
  unknown: AppServerEvent[];
}

function makeRecorder(): { rec: Recorder; cb: Parameters<typeof translateEvent>[2] } {
  const rec: Recorder = {
    text: [],
    reasoning: [],
    toolUse: [],
    toolUseComplete: [],
    activity: 0,
    unknown: [],
  };
  return {
    rec,
    cb: {
      callbacks: {
        onText: (c: string) => rec.text.push(c),
        onReasoning: (c: string) => rec.reasoning.push(c),
        onToolUse: (tool: string, meta?: unknown) => rec.toolUse.push({ tool, meta }),
        onToolUseComplete: (tool: string, result: unknown) => rec.toolUseComplete.push({ tool, result }),
        onActivity: () => {
          rec.activity += 1;
        },
      },
      onUnknownEvent: (e: AppServerEvent) => rec.unknown.push(e),
    },
  };
}

function replay(
  name: string,
  outcome: TurnOutcome = 'completed',
): { rec: Recorder; acc: TranslatorAccumulator; response: CodexResponse } {
  const events = loadFixture(name);
  const { rec, cb } = makeRecorder();
  const acc = createAccumulator();
  for (const ev of events) translateEvent(ev, acc, cb);
  const response = finalizeResponse(acc, outcome);
  return { rec, acc, response };
}

describe('official-event-translator golden fixtures', () => {
  it('text-delta -> onText, content accumulates, status completed', () => {
    const { rec, response } = replay('text-delta');
    expect(rec.text).toEqual(['Hello ', 'world']);
    expect(response.content).toBe('Hello world');
    expect(response.threadId).toBe('thread-text-1');
    expect(response.status).toBe('completed');
    expect(rec.activity).toBe(4);
  });

  it('reasoning-delta is AUDIT-ONLY: onReasoning fires but content is NOT mutated by it', () => {
    const { rec, response } = replay('reasoning-delta');
    expect(rec.reasoning).toEqual(['thinking about the plan']);
    expect(response.content).toBe('done');
  });

  it('command-exec -> onToolUse/onToolUseComplete + commandsRun entry', () => {
    const { rec, response } = replay('command-exec');
    expect(rec.toolUse).toHaveLength(1);
    expect(rec.toolUse[0].tool).toBe('Bash');
    expect(rec.toolUse[0].meta).toMatchObject({ kind: 'bash' });
    expect(rec.toolUseComplete).toHaveLength(1);
    expect(rec.toolUseComplete[0]).toMatchObject({
      tool: 'Bash',
      result: { command: 'npm test', exitCode: 0, durationMs: 4200 },
    });
    expect(response.commandsRun).toEqual([{ cmd: 'npm test', exitCode: 0, durationMs: 4200 }]);
  });

  it('file-change -> filesChanged + apply-patch-failure sample', () => {
    const { response } = replay('file-change');
    expect(response.filesChanged).toEqual(['src/index.ts', 'src/util.ts']);
    expect(response.applyPatchFailures).toBe(1);
    expect(response.applyPatchFailureSamples).toHaveLength(1);
    expect(response.applyPatchFailureSamples[0]).toMatchObject({
      source: 'tool-output',
      text: 'Failed to find expected lines',
    });
  });

  it('dynamic-tool -> onToolUse/onToolUseComplete', () => {
    const { rec } = replay('dynamic-tool');
    expect(rec.toolUse[0].tool).toBe('search_web');
    expect(rec.toolUseComplete[0]).toMatchObject({ tool: 'search_web', result: { ok: true } });
  });

  it('mcp-tool -> onToolUse/onToolUseComplete with mcp kind', () => {
    const { rec } = replay('mcp-tool');
    expect(rec.toolUse[0].tool).toBe('knowledge-base.search');
    expect(rec.toolUse[0].meta).toMatchObject({ kind: 'mcp' });
    expect(rec.toolUseComplete[0]).toMatchObject({
      tool: 'knowledge-base.search',
      result: { hits: 3 },
    });
  });

  it('token-usage -> calculable CodexTokenUsage, all 5 fields', () => {
    const { response } = replay('token-usage');
    expect(response.usage).toEqual({
      inputTokens: 1200,
      cachedInputTokens: 300,
      outputTokens: 450,
      reasoningOutputTokens: 120,
      totalTokens: 1650,
    });
  });

  it('unknown-event is logged and does NOT break the run', () => {
    const { rec, response } = replay('unknown-event');
    expect(rec.unknown.map((e) => e.method)).toEqual(['plan_update']);
    expect(response.content).toBe('after unknown');
    expect(response.status).toBe('completed');
  });

  it('auth-required resolves status:auth_required (the FOURTH union value, not the throw path)', () => {
    const { acc, response } = replay('auth-required', 'auth_required');
    expect(acc.authRequired).toBe(true);
    expect(response.status).toBe('auth_required');
  });

  it('timeout: a turn aborted by the T4b timer resolves status:timeout', () => {
    const events = loadFixture('timeout');
    const { cb } = makeRecorder();
    const acc = createAccumulator();
    for (const ev of events) translateEvent(ev, acc, cb);
    acc.timedOut = true;
    const response = finalizeResponse(acc, 'timeout');
    expect(response.status).toBe('timeout');
    expect(response.content).toBe('working');
  });
});

describe('T9 enum casing translation', () => {
  it('sandbox internal <-> wire round-trips with the golden-pinned casing', () => {
    expect(sandboxToWire('workspace-write')).toBe('workspaceWrite');
    expect(sandboxToWire('read-only')).toBe('readOnly');
    expect(sandboxToWire('danger-full-access')).toBe('dangerFullAccess');
    expect(sandboxFromWire('workspaceWrite')).toBe('workspace-write');
    expect(sandboxFromWire('readOnly')).toBe('read-only');
    expect(sandboxFromWire('dangerFullAccess')).toBe('danger-full-access');
    for (const v of ['workspace-write', 'read-only', 'danger-full-access'] as const) {
      expect(sandboxFromWire(sandboxToWire(v))).toBe(v);
    }
  });

  it('approval internal <-> wire round-trips', () => {
    expect(approvalToWire('never')).toBe('never');
    expect(approvalToWire('on-request')).toBe('onRequest');
    expect(approvalToWire('auto-edit')).toBe('autoEdit');
    expect(approvalFromWire('never')).toBe('never');
    expect(approvalFromWire('onRequest')).toBe('on-request');
    expect(approvalFromWire('autoEdit')).toBe('auto-edit');
  });

  it('unknown enum throws (never passed blindly to the wire)', () => {
    expect(() => sandboxToWire('bogus' as never)).toThrow();
    expect(() => sandboxFromWire('bogus')).toThrow();
    expect(() => approvalFromWire('bogus')).toThrow();
  });
});

describe('T11 usage normalization edge cases', () => {
  it('accepts the SDK Usage snake_case shape and computes a total when absent', () => {
    const usage = normalizeUsage({
      input_tokens: 100,
      cached_input_tokens: 10,
      output_tokens: 40,
      reasoning_output_tokens: 5,
    });
    expect(usage.inputTokens).toBe(100);
    expect(usage.cachedInputTokens).toBe(10);
    expect(usage.outputTokens).toBe(40);
    expect(usage.reasoningOutputTokens).toBe(5);
    expect(usage.totalTokens).toBe(140);
  });

  it('missing/garbage fields normalize to zero', () => {
    const usage = normalizeUsage(undefined);
    expect(usage).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    });
  });
});

describe('T12 status union mapping', () => {
  it('failed outcome -> status failed', () => {
    const acc = createAccumulator('t');
    acc.failed = true;
    expect(finalizeResponse(acc, 'failed').status).toBe('failed');
  });

  it('interrupted outcome -> status failed', () => {
    const acc = createAccumulator('t');
    expect(finalizeResponse(acc, 'interrupted').status).toBe('failed');
  });

  it('auth precedence over timeout/failed', () => {
    const acc = createAccumulator('t');
    acc.authRequired = true;
    acc.timedOut = true;
    expect(finalizeResponse(acc, 'failed').status).toBe('auth_required');
  });
});
