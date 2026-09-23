import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const state = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  bypass: false,
}));

const confirmMock = vi.hoisted(() =>
  vi.fn(async (_getWindow: unknown, _action: unknown): Promise<{ approved: boolean; message?: string }> => ({
    approved: true,
  })),
);

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../db', () => ({
  getSetting: vi.fn((key: string) => state.settings[key]),
  setSetting: vi.fn(),
  insertAuditEntry: vi.fn(),
  getPermissionBypass: vi.fn(() => state.bypass),
}));

vi.mock('../permission-guard', () => ({
  requestActionConfirmation: confirmMock,
  createPermissionGuard: vi.fn(() => vi.fn()),
}));

vi.mock('../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(() => ({ mcpServers: {} })),
  getMcpToolRegistryEntries: vi.fn(() => []),
  discoverAndSaveMCPTools: vi.fn(),
}));

vi.mock('../mcp-tool-bridge', () => ({
  setupMCPsForSession: vi.fn(),
  callMCPTool: vi.fn(),
  teardownMCPsForSession: vi.fn(),
}));

import { createToolScriptDispatcher, type CreateToolScriptDispatcherInput } from '../tool-script/tool-script-dispatch';
import type {
  ToolScriptDispatchContext,
  ToolScriptRpcDispatcher,
  ToolScriptResult,
} from '../tool-script/tool-script-types';
import { runToolScript } from '../tool-script/tool-script-engine';
import { registerChatCapabilityTurn, __resetChatCapabilityContextForTests } from '../chat-capability-context';
import type { AgentPermissionProfile } from '../agent-runtime/types';

function resolveTestPython(): string {
  for (const candidate of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'python3';
}
const TEST_PYTHON = resolveTestPython();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let testCwd: string;
let turnCounter = 0;

const GUARD_PROFILE: AgentPermissionProfile = {
  mode: 'default',
  dangerouslySkipPermissions: false,
};
const BYPASS_PROFILE: AgentPermissionProfile = {
  mode: 'bypassPermissions',
  dangerouslySkipPermissions: true,
};

interface RunScriptOptions {
  profile?: AgentPermissionProfile;
  enabledTools?: readonly string[];
  overrides?: CreateToolScriptDispatcherInput['overrides'];
}

async function runScript(code: string, opts: RunScriptOptions = {}): Promise<ToolScriptResult> {
  turnCounter++;
  const sessionId = `sess-eg-${turnCounter}`;
  const turnId = `turn-eg-${turnCounter}`;
  registerChatCapabilityTurn(
    {
      surface: 'chat',
      sessionId,
      turnId,
      capabilities: { pipelineControl: false, dynamicWorkflows: false },
      cwd: testCwd,
      permissionProfile: opts.profile ?? GUARD_PROFILE,
      allowedServerIds: [],
    },
    60_000,
  );
  const dispatcher = createToolScriptDispatcher({
    code,
    getWindow: () => null,
    abortSignal: new AbortController().signal,
    ...(opts.enabledTools !== undefined ? { enabledTools: opts.enabledTools } : {}),
    ...(opts.overrides !== undefined ? { overrides: opts.overrides } : {}),
  });
  return runToolScript(
    { code, sessionId, turnId, abortSignal: new AbortController().signal },
    {
      dispatchRpc: dispatcher,
      pythonPath: TEST_PYTHON,
      timeoutMs: 15_000,
      rpcTimeoutMs: 6_000,
    },
  );
}

function makeCtx(overrides: Partial<ToolScriptDispatchContext> = {}): ToolScriptDispatchContext {
  return {
    sessionId: 'sess-direct',
    turnId: 'turn-direct',
    cwd: testCwd,
    permissionProfile: GUARD_PROFILE,
    allowedServerIds: [],
    capabilities: { pipelineControl: false, dynamicWorkflows: false },
    pauseTimeout: vi.fn(),
    resumeTimeout: vi.fn(),
    ...overrides,
  };
}

let rpcId = 0;
function call(
  dispatcher: ToolScriptRpcDispatcher,
  tool: string,
  args: Record<string, unknown>,
  ctx: ToolScriptDispatchContext,
): Promise<string> {
  rpcId++;
  return dispatcher({ id: rpcId, tool, args }, ctx);
}

beforeEach(() => {
  state.settings = {};
  state.bypass = false;
  confirmMock.mockReset();
  confirmMock.mockResolvedValue({ approved: true });
  __resetChatCapabilityContextForTests();
  testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ts-eg-'));
});

afterEach(() => {
  __resetChatCapabilityContextForTests();
  fs.rmSync(testCwd, { recursive: true, force: true });
});

describe('AC-B4: script 100% read-only', () => {
  it('bypass OFF, so read_file/grep/search_files -> NENHUM popup e roda', async () => {
    fs.writeFileSync(path.join(testCwd, 'dado.txt'), 'conteudo-lido-abc\n');
    const result = await runScript(
      [
        'from lionclaw_tools import read_file, grep, search_files',
        'print(read_file("dado.txt").strip())',
        'print("achou" if "dado.txt" in search_files("*.txt") else "nao-achou")',
      ].join('\n'),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('conteudo-lido-abc\nachou\n');
    expect(confirmMock).not.toHaveBeenCalled();
  }, 20_000);
});

describe('AC-B4: script mutante com bypass OFF', () => {
  it('dispara UM popup com preview do codigo; aprovado roda inteiro sem popup por acao', async () => {
    const code = [
      'from lionclaw_tools import run_command',
      'print(run_command("echo primeira").strip())',
      'print(run_command("echo segunda").strip())',
    ].join('\n');
    const result = await runScript(code);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('primeira\nsegunda\n');
    expect(result.toolCallCount).toBe(2);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const action = confirmMock.mock.calls[0][1] as {
      tool: string;
      description: string;
      input: { script: string; tools: string[] };
      risk: string;
    };
    expect(action.tool).toBe('run_tool_script');
    expect(action.risk).toBe('high');
    expect(action.description).toContain('run_command');
    expect(action.input.script).toContain('run_command("echo primeira")');
    expect(action.input.tools).toEqual(['run_command']);
  }, 20_000);

  it('negado -> NENHUMA tool executa (nem a primeira, nem as seguintes); popup unico', async () => {
    confirmMock.mockResolvedValue({ approved: false, message: 'Acao negada pelo usuario' });
    const result = await runScript(
      [
        'from lionclaw_tools import write_file, ToolError',
        'try:',
        '    write_file("m1.txt", "x")',
        '    print("rodou1")',
        'except ToolError:',
        '    print("negado1")',
        'try:',
        '    write_file("m2.txt", "x")',
        '    print("rodou2")',
        'except ToolError:',
        '    print("negado2")',
      ].join('\n'),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('negado1\nnegado2\n');
    expect(fs.existsSync(path.join(testCwd, 'm1.txt'))).toBe(false);
    expect(fs.existsSync(path.join(testCwd, 'm2.txt'))).toBe(false);
    expect(confirmMock).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('mcp_invoke no codigo tambem classifica mutante: popup antes, invoke depois', async () => {
    const invokeMcp = vi.fn(async () => ({ content: 'resposta-mcp', displayName: 'd' }));
    const result = await runScript(
      ['from lionclaw_tools import mcp_invoke', 'print(mcp_invoke("gmail", "send_email", {"to": "x"}))'].join('\n'),
      { overrides: { invokeMcp } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('resposta-mcp\n');
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(invokeMcp).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.invocationCallOrder[0]).toBeLessThan(invokeMcp.mock.invocationCallOrder[0]);
  }, 20_000);
});

describe('AC-B4: bypass', () => {
  it('setting permission:bypass ON (default do app) -> script mutante SEM popup', async () => {
    state.bypass = true;
    const result = await runScript(
      ['from lionclaw_tools import run_command', 'print(run_command("echo livre").strip())'].join('\n'),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('livre\n');
    expect(confirmMock).not.toHaveBeenCalled();
  }, 20_000);

  it('profile bypass do turno (pipeline/harness) -> SEM popup mesmo com setting OFF', async () => {
    state.bypass = false;
    const result = await runScript(
      ['from lionclaw_tools import run_command', 'print(run_command("echo perfil-bypass").strip())'].join('\n'),
      { profile: BYPASS_PROFILE },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('perfil-bypass\n');
    expect(confirmMock).not.toHaveBeenCalled();
  }, 20_000);
});

describe('integracao com o relogio do S1 (AC-B9 parcial)', () => {
  it('pauseTimeout antes do popup e resumeTimeout depois da decisao', async () => {
    const ordem: string[] = [];
    confirmMock.mockImplementation(async () => {
      await sleep(80);
      ordem.push('confirmacao-resolvida');
      return { approved: true };
    });
    const dispatcher = createToolScriptDispatcher({
      code: 'from lionclaw_tools import run_command\nrun_command("echo x")',
      getWindow: () => null,
      abortSignal: new AbortController().signal,
    });
    const ctx = makeCtx({
      pauseTimeout: vi.fn(() => ordem.push('pause')),
      resumeTimeout: vi.fn(() => ordem.push('resume')),
    });

    const saida = await call(dispatcher, 'run_command', { command: 'echo x' }, ctx);
    expect(saida).toBe('x\n');
    expect(ordem).toEqual(['pause', 'confirmacao-resolvida', 'resume']);
    expect(ctx.pauseTimeout).toHaveBeenCalledTimes(1);
    expect(ctx.resumeTimeout).toHaveBeenCalledTimes(1);
  });

  it('abort do turno com popup PENDENTE rejeita a espera e rebalanceia o relogio', async () => {
    confirmMock.mockImplementation(() => new Promise(() => {}));
    const abortController = new AbortController();
    const dispatcher = createToolScriptDispatcher({
      code: 'from lionclaw_tools import write_file\nwrite_file("m.txt", "x")',
      getWindow: () => null,
      abortSignal: abortController.signal,
    });
    const ctx = makeCtx();

    const pendente = call(dispatcher, 'write_file', { path: 'm.txt', content: 'x' }, ctx);
    await sleep(50);
    abortController.abort();

    await expect(pendente).rejects.toThrow(/abortada \(stop do turno\)/);
    expect(ctx.pauseTimeout).toHaveBeenCalledTimes(1);
    expect(ctx.resumeTimeout).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(testCwd, 'm.txt'))).toBe(false);
  });
});

describe('escalacao: RPC mutante num script classificado read-only', () => {
  it('read-only nao pede popup; frame mutante forjado ESCALA para a confirmacao', async () => {
    const dispatcher = createToolScriptDispatcher({
      code: 'from lionclaw_tools import read_file\nprint(read_file("dado.txt"))',
      getWindow: () => null,
      abortSignal: new AbortController().signal,
    });
    const ctx = makeCtx();
    fs.writeFileSync(path.join(testCwd, 'dado.txt'), 'ok');

    await call(dispatcher, 'read_file', { path: 'dado.txt' }, ctx);
    expect(confirmMock).not.toHaveBeenCalled();

    const saida = await call(dispatcher, 'write_file', { path: 'escalado.txt', content: 'x' }, ctx);
    expect(saida).toMatch(/sucesso/);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(testCwd, 'escalado.txt'))).toBe(true);
  });

  it('escalacao negada bloqueia o frame mutante mas memoiza UMA decisao', async () => {
    confirmMock.mockResolvedValue({ approved: false });
    const dispatcher = createToolScriptDispatcher({
      code: 'print("sem tools")',
      getWindow: () => null,
      abortSignal: new AbortController().signal,
    });
    const ctx = makeCtx();

    await expect(call(dispatcher, 'write_file', { path: 'a.txt', content: 'x' }, ctx)).rejects.toThrow(
      /negado pelo guard de entrada/,
    );
    await expect(call(dispatcher, 'run_command', { command: 'echo x' }, ctx)).rejects.toThrow(
      /negado pelo guard de entrada/,
    );
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(testCwd, 'a.txt'))).toBe(false);
  });
});
