import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import {
  runToolScript,
  applyStdoutOverflowPolicy,
  TOOL_SCRIPT_OVERFLOW_DIRNAME,
} from '../tool-script/tool-script-engine';
import { buildToolScriptEnv } from '../tool-script/tool-script-env';
import { executeLocalTool } from '../local-tool-executor';
import { registerChatCapabilityTurn, __resetChatCapabilityContextForTests } from '../chat-capability-context';
import type { ToolScriptEngineDeps } from '../tool-script/tool-script-types';

function resolveTestPython(): string | undefined {
  for (const candidate of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
const TEST_PYTHON = resolveTestPython();
const hasPython = TEST_PYTHON !== undefined;

const SESSION_ID = 's4-sess';
const TURN_ID = 's4-turn';

let tmpCwd = '';

beforeEach(() => {
  vi.clearAllMocks();
  state.bypass = true;
  __resetChatCapabilityContextForTests();
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcts-s4-'));
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

afterEach(() => {
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

function runReal(code: string, depsOverrides: Partial<ToolScriptEngineDeps> = {}) {
  const dispatchRpc = createToolScriptDispatcher({
    code,
    getWindow: () => null,
    abortSignal: new AbortController().signal,
  });
  return runToolScript(
    { code, sessionId: SESSION_ID, turnId: TURN_ID, abortSignal: new AbortController().signal },
    {
      dispatchRpc,
      buildEnv: buildToolScriptEnv,
      pythonPath: TEST_PYTHON,
      ...depsOverrides,
    },
  );
}

function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

(hasPython ? describe : describe.skip)('AC-B2 - contexto cresce ~stdout, nao ~soma dos reads', () => {
  it('3 read_file de ~3k tok cada + print("ok") -> retorno ao modelo mede ~o print', async () => {
    const fileNames = ['a.txt', 'b.txt', 'c.txt'];
    for (const name of fileNames) {
      fs.writeFileSync(path.join(tmpCwd, name), `conteudo-${name}-`.repeat(800).slice(0, 12_000));
    }

    const code = [
      'from lionclaw_tools import read_file',
      'total = 0',
      `for name in ${JSON.stringify(fileNames)}:`,
      '    total += len(read_file(name))',
      'assert total > 30000',
      'print("ok")',
    ].join('\n');

    const result = await runReal(code);

    expect(result.exitCode).toBe(0);
    expect(result.toolCallCount).toBe(3);
    expect(result.stdout.trim()).toBe('ok');
    expect(result.stdoutTruncated).toBe(false);

    const returnedTokens = estTokens(result.stdout) + estTokens(result.stderr);
    const filesTokens = fileNames.reduce(
      (acc, name) => acc + estTokens(fs.readFileSync(path.join(tmpCwd, name), 'utf8')),
      0,
    );
    expect(filesTokens).toBeGreaterThan(8_000);
    expect(returnedTokens).toBeLessThan(100);
    expect(result.stdout).not.toContain('conteudo-a.txt');
  }, 30_000);
});

(hasPython ? describe : describe.skip)('AC-B9 - overflow do stdout (e2e)', () => {
  it('stdout > cap -> head+nota+tail; completo persistido no cwd; read_file do path funciona; gitignore criado', async () => {
    const code = ['import sys', 'sys.stdout.write("HEAD-MARK-" + ("a" * 20000) + "-TAIL-MARK")'].join('\n');

    const result = await runReal(code, { maxStdoutBytes: 2_000 });

    expect(result.exitCode).toBe(0);
    expect(result.stdoutTruncated).toBe(true);

    expect(result.stdout.startsWith('HEAD-MARK-')).toBe(true);
    expect(result.stdout.endsWith('-TAIL-MARK')).toBe(true);
    expect(result.stdout).toMatch(/\.\.\.\[\d+ bytes omitidos, resto em .+\]\.\.\./);

    expect(result.persistedPath).toBeDefined();
    const persistedPath = result.persistedPath as string;
    expect(persistedPath.startsWith(path.join(tmpCwd, TOOL_SCRIPT_OVERFLOW_DIRNAME) + path.sep)).toBe(true);
    expect(result.stdout).toContain(persistedPath);

    const persisted = fs.readFileSync(persistedPath, 'utf8');
    expect(persisted.length).toBe('HEAD-MARK-'.length + 20_000 + '-TAIL-MARK'.length);
    expect(persisted.startsWith('HEAD-MARK-')).toBe(true);
    expect(persisted.endsWith('-TAIL-MARK')).toBe(true);

    const read = await executeLocalTool('Read', { file_path: persistedPath }, tmpCwd);
    expect(read.isError).toBe(false);
    expect(read.result).toContain('HEAD-MARK-');
    expect(read.result.endsWith('-TAIL-MARK')).toBe(true);

    const gitignore = fs.readFileSync(path.join(tmpCwd, TOOL_SCRIPT_OVERFLOW_DIRNAME, '.gitignore'), 'utf8');
    expect(gitignore.split('\n').some((l) => l.trim() === '*')).toBe(true);
  }, 30_000);

  it('stdout <= cap: nada persiste, sem nota, persistedPath ausente', async () => {
    const result = await runReal('print("curto")', { maxStdoutBytes: 2_000 });
    expect(result.stdout).toBe('curto\n');
    expect(result.stdoutTruncated).toBe(false);
    expect(result.persistedPath).toBeUndefined();
    expect(fs.existsSync(path.join(tmpCwd, TOOL_SCRIPT_OVERFLOW_DIRNAME))).toBe(false);
  }, 30_000);
});

describe.skipIf(hasPython)('Tool Script S4 e2e (SKIP: python3 ausente)', () => {
  it('anotado para o smoke do dono', () => {
    expect(hasPython).toBe(false);
  });
});

describe('applyStdoutOverflowPolicy (unit, sem python)', () => {
  it('head 40% + tail 60% do cap, nota com N omitidos e o path', () => {
    const full = Buffer.from(`${'H'.repeat(500)}${'M'.repeat(9_000)}${'T'.repeat(500)}`);
    const outcome = applyStdoutOverflowPolicy(full, full.length, 1_000, tmpCwd);

    expect(outcome.persistedPath).toBeDefined();
    expect(outcome.text.startsWith('H'.repeat(400))).toBe(true);
    expect(outcome.text.endsWith('T'.repeat(500))).toBe(true);
    const match = outcome.text.match(/\.\.\.\[(\d+) bytes omitidos, resto em (.+)\]\.\.\./);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(10_000 - 1_000);
    expect(match?.[2]).toBe(outcome.persistedPath);

    const persisted = fs.readFileSync(outcome.persistedPath as string);
    expect(persisted.equals(full)).toBe(true);
  });

  it('gitignore idempotente: segunda execucao nao duplica o `*`', () => {
    const full = Buffer.from('x'.repeat(5_000));
    applyStdoutOverflowPolicy(full, full.length, 1_000, tmpCwd);
    applyStdoutOverflowPolicy(full, full.length, 1_000, tmpCwd);

    const gitignorePath = path.join(tmpCwd, TOOL_SCRIPT_OVERFLOW_DIRNAME, '.gitignore');
    const lines = fs
      .readFileSync(gitignorePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() === '*');
    expect(lines).toHaveLength(1);

    const files = fs.readdirSync(path.join(tmpCwd, TOOL_SCRIPT_OVERFLOW_DIRNAME)).filter((f) => f !== '.gitignore');
    expect(files).toHaveLength(2);
  });

  it('gitignore existente sem `*` recebe append (nao sobrescreve o conteudo)', () => {
    const dir = path.join(tmpCwd, TOOL_SCRIPT_OVERFLOW_DIRNAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'algo-custom\n');

    const full = Buffer.from('x'.repeat(5_000));
    applyStdoutOverflowPolicy(full, full.length, 1_000, tmpCwd);

    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(content).toContain('algo-custom');
    expect(content.split('\n').some((l) => l.trim() === '*')).toBe(true);
  });

  it('falha de persistencia degrada para head+tail com nota SEM path (best-effort)', () => {
    const blocker = path.join(tmpCwd, 'arquivo-plano');
    fs.writeFileSync(blocker, 'x');
    const badCwd = path.join(blocker, 'sub');

    const full = Buffer.from('y'.repeat(5_000));
    const outcome = applyStdoutOverflowPolicy(full, full.length, 1_000, badCwd);

    expect(outcome.persistedPath).toBeUndefined();
    expect(outcome.text).toContain('bytes omitidos; persistencia do stdout completo falhou');
    expect(outcome.text.startsWith('y'.repeat(400))).toBe(true);
    expect(outcome.text.endsWith('y'.repeat(600))).toBe(true);
  });
});
