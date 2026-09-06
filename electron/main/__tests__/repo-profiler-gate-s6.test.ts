
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const getSettingMock = vi.fn();
vi.mock('../db', () => ({
  getSetting: (k: string) => getSettingMock(k),
}));

const recordSystemActivityMock = vi.fn();
vi.mock('../activity-log', () => ({
  recordSystemActivity: (arg: unknown) => recordSystemActivityMock(arg),
}));

const queryMock = vi.fn((_args: unknown) => {
  throw new Error('repo-profiler NAO deveria chamar query() com orquestrador != claude-sdk');
});
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: unknown) => queryMock(args),
}));

vi.mock('../stream-processor', () => ({
  processAgentStream: vi.fn(async () => ({ output: '{}' })),
}));

import { runRepoProfiler } from '../repo-profiler';

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-profiler-gate-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
  }
});

describe('repo-profiler capability-gate (SPEC 4.4)', () => {
  it('orquestrador != claude-sdk -> pula o agente, registra skip e preserva a heuristica', async () => {
    getSettingMock.mockImplementation((k: string) =>
      k === 'orchestrator_runtime' ? 'codex-sdk' : '',
    );

    const onText = vi.fn();
    const manifest = await runRepoProfiler(tmpDir, { onText, onDone: vi.fn() });

    expect(queryMock).not.toHaveBeenCalled();
    expect(recordSystemActivityMock).toHaveBeenCalledTimes(1);
    const arg = recordSystemActivityMock.mock.calls[0][0] as { label: string; description: string };
    expect(arg.label).toContain('repo-profiler');
    expect(arg.description).toContain('codex-sdk');
    expect(manifest.language).toBe('unknown');
    expect(manifest.framework).toBe('unknown');
  });
});
