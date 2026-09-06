
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const state = vi.hoisted(() => ({ bypass: true }));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../db', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  insertAuditEntry: vi.fn(),
  getPermissionBypass: vi.fn(() => state.bypass),
}));
vi.mock('../ask-question', () => ({ sendAskQuestion: vi.fn() }));
vi.mock('../repo-profiler', () => ({ EXCLUDED_FROM_AUDIT_PATTERNS: [] }));
vi.mock('../pipeline-control-core', () => ({ isPipelineWriteAction: vi.fn(() => false) }));
vi.mock('../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(() => ({})),
  getMcpToolRegistryEntries: vi.fn(() => []),
  discoverAndSaveMCPTools: vi.fn(),
}));
vi.mock('../mcp-tool-bridge', () => ({
  setupMCPsForSession: vi.fn(),
  callMCPTool: vi.fn(),
  teardownMCPsForSession: vi.fn(),
}));

import { createToolScriptDispatcher } from '../tool-script/tool-script-dispatch';
import { runToolScript } from '../tool-script/tool-script-engine';
import { buildToolScriptEnv } from '../tool-script/tool-script-env';
import {
  registerChatCapabilityTurn,
  __resetChatCapabilityContextForTests,
} from '../chat-capability-context';

function resolveTestPython(): string | undefined {
  for (const candidate of [
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
const TEST_PYTHON = resolveTestPython();
const hasPython = TEST_PYTHON !== undefined;

const SESSION_ID = 'e2e-sess';
const TURN_ID = 'e2e-turn';

let tmpCwd = '';

beforeEach(() => {
  vi.clearAllMocks();
  state.bypass = true;
  __resetChatCapabilityContextForTests();
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcts-e2e-'));
  registerChatCapabilityTurn({
    surface: 'chat',
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    capabilities: { pipelineControl: false, dynamicWorkflows: false },
    cwd: tmpCwd,
    permissionProfile: { mode: 'default', dangerouslySkipPermissions: false },
    allowedServerIds: [],
  });
});

function runReal(code: string, abortSignal: AbortSignal) {
  const dispatchRpc = createToolScriptDispatcher({
    code,
    getWindow: () => null,
    abortSignal,
  });
  return runToolScript(
    { code, sessionId: SESSION_ID, turnId: TURN_ID, abortSignal },
    { dispatchRpc, buildEnv: buildToolScriptEnv, pythonPath: TEST_PYTHON },
  );
}

(hasPython ? describe : describe.skip)('Tool Script e2e vivo (engine + dispatcher + python3 reais)', () => {
  it('AC-B3: encadeia A->B numa unica execucao; so o stdout final volta', async () => {
    const code = [
      'from lionclaw_tools import run_command',
      'a = run_command("echo hello").strip()',
      'b = run_command("echo " + a + "-world").strip()',
      'print(b)',
    ].join('\n');

    const result = await runReal(code, new AbortController().signal);

    expect(result.exitCode).toBe(0);
    expect(result.aborted).toBe(false);
    expect(result.toolCallCount).toBe(2);
    expect(result.stdout.trim()).toBe('hello-world');
  }, 30_000);

  it('AC-B8 fio: abortar o signal do desktopLane mata python + neto do run_command (resolve rapido)', async () => {
    const code = [
      'from lionclaw_tools import run_command',
      'run_command("sleep 30")',
      'print("should-not-reach")',
    ].join('\n');

    const controller = new AbortController();
    const startedAt = Date.now();
    const promise = runReal(code, controller.signal);

    await new Promise((r) => setTimeout(r, 900));
    controller.abort();

    const result = await promise;
    const elapsed = Date.now() - startedAt;

    expect(result.aborted).toBe(true);
    expect(result.stdout).not.toContain('should-not-reach');
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);
});

describe.skipIf(hasPython)('Tool Script e2e vivo (SKIP: python3 ausente)', () => {
  it('anotado para o smoke do dono', () => {
    expect(hasPython).toBe(false);
  });
});
