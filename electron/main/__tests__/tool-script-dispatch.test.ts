
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BrowserWindow } from 'electron';

const state = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  bypass: true,
}));

const setupMock = vi.hoisted(() => vi.fn());
const callMock = vi.hoisted(() => vi.fn());
const teardownMock = vi.hoisted(() => vi.fn());
const getMCPConfigForAgentMock = vi.hoisted(() => vi.fn(() => ({ mcpServers: {} })));
const getMcpToolRegistryEntriesMock = vi.hoisted(() => vi.fn(() => []));
const discoverMock = vi.hoisted(() => vi.fn());
const insertAuditEntryMock = vi.hoisted(() => vi.fn());

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

vi.mock('../db', () => ({
  getSetting: vi.fn((key: string) => state.settings[key]),
  setSetting: vi.fn(),
  insertAuditEntry: insertAuditEntryMock,
  getPermissionBypass: vi.fn(() => state.bypass),
}));

vi.mock('../ask-question', () => ({
  sendAskQuestion: vi.fn(),
}));

vi.mock('../repo-profiler', () => ({
  EXCLUDED_FROM_AUDIT_PATTERNS: [],
}));

vi.mock('../pipeline-control-core', () => ({
  isPipelineWriteAction: vi.fn(() => false),
}));

vi.mock('../mcp-manager', () => ({
  getMCPConfigForAgent: getMCPConfigForAgentMock,
  getMcpToolRegistryEntries: getMcpToolRegistryEntriesMock,
  discoverAndSaveMCPTools: discoverMock,
}));

vi.mock('../mcp-tool-bridge', () => ({
  setupMCPsForSession: setupMock,
  callMCPTool: callMock,
  teardownMCPsForSession: teardownMock,
}));

import {
  createToolScriptDispatcher,
  classifyToolScriptCode,
  type CreateToolScriptDispatcherInput,
  type ToolScriptToolCallAudit,
} from '../tool-script/tool-script-dispatch';
import { buildToolScriptEnv, isDeniedEnvKey } from '../tool-script/tool-script-env';
import type {
  ToolScriptDispatchContext,
  ToolScriptRpcDispatcher,
} from '../tool-script/tool-script-types';
import { runToolScript } from '../tool-script/tool-script-engine';
import type { McpInvokeRequest } from '../mcp-invoke';
import {
  requestActionConfirmation,
  resolveConfirmation,
} from '../permission-guard';
import {
  registerChatCapabilityTurn,
  __resetChatCapabilityContextForTests,
} from '../chat-capability-context';


function resolveTestPython(): string {
  for (const candidate of [
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'python3';
}
const TEST_PYTHON = resolveTestPython();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error('waitFor: condicao nao satisfeita no prazo');
}

function isProcessDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

let testCwd: string;

function makeCtx(
  overrides: Partial<ToolScriptDispatchContext> = {},
): ToolScriptDispatchContext {
  return {
    sessionId: 'sess-disp',
    turnId: 'turn-disp',
    cwd: testCwd,
    permissionProfile: { mode: 'default', dangerouslySkipPermissions: false },
    allowedServerIds: ['lionclaw-pipeline-control', 'gmail'],
    capabilities: { pipelineControl: false, dynamicWorkflows: false },
    pauseTimeout: vi.fn(),
    resumeTimeout: vi.fn(),
    ...overrides,
  };
}

function makeDispatcher(
  overrides: Partial<CreateToolScriptDispatcherInput> = {},
): ToolScriptRpcDispatcher {
  return createToolScriptDispatcher({
    code: 'from lionclaw_tools import run_command, write_file, mcp_invoke',
    getWindow: () => null,
    abortSignal: new AbortController().signal,
    ...overrides,
  });
}

let rpcId = 0;
function call(
  dispatcher: ToolScriptRpcDispatcher,
  tool: string,
  args: Record<string, unknown>,
  ctx: ToolScriptDispatchContext = makeCtx(),
): Promise<string> {
  rpcId++;
  return dispatcher({ id: rpcId, tool, args }, ctx);
}

beforeEach(() => {
  state.settings = {};
  state.bypass = true;
  __resetChatCapabilityContextForTests();
  vi.clearAllMocks();
  testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ts-disp-'));
});

afterEach(() => {
  __resetChatCapabilityContextForTests();
  fs.rmSync(testCwd, { recursive: true, force: true });
});


describe('gate server-side do nome da tool', () => {
  it('tool desconhecida e rejeitada sem executar', async () => {
    const dispatcher = makeDispatcher();
    await expect(call(dispatcher, 'tool_inventada', {})).rejects.toThrow(
      /desconhecida ou desabilitada/,
    );
  });

  it('tool conhecida mas FORA do enabled set e rejeitada sem efeito', async () => {
    const dispatcher = makeDispatcher({
      code: 'from lionclaw_tools import read_file',
      enabledTools: ['read_file'],
    });
    const alvo = path.join(testCwd, 'nunca.txt');
    await expect(
      call(dispatcher, 'write_file', { path: alvo, content: 'x' }),
    ).rejects.toThrow(/desconhecida ou desabilitada/);
    expect(fs.existsSync(alvo)).toBe(false);
  });
});


describe('file ops via executeLocalTool (executor REAL, cwd temp)', () => {
  it('write_file -> read_file -> edit -> grep -> search_files encadeiam pelo mapeamento', async () => {
    const dispatcher = makeDispatcher();

    const escrito = await call(dispatcher, 'write_file', {
      path: 'dados.txt',
      content: 'linha-um\nmarcador-xyz\n',
    });
    expect(escrito).toMatch(/sucesso/);
    expect(fs.existsSync(path.join(testCwd, 'dados.txt'))).toBe(true);

    const lido = await call(dispatcher, 'read_file', { path: 'dados.txt' });
    expect(lido).toContain('marcador-xyz');

    await call(dispatcher, 'edit', {
      path: 'dados.txt',
      old_string: 'linha-um',
      new_string: 'linha-editada',
    });
    const relido = await call(dispatcher, 'read_file', {
      path: path.join(testCwd, 'dados.txt'),
    });
    expect(relido).toContain('linha-editada');

    const grepado = await call(dispatcher, 'grep', { pattern: 'marcador-xyz' });
    expect(grepado).toContain('dados.txt');

    const achados = await call(dispatcher, 'search_files', { pattern: '*.txt' });
    expect(achados).toContain('dados.txt');
  });

  it('path fora do cwd e bloqueado pela validacao do executor (erro vira throw)', async () => {
    const dispatcher = makeDispatcher();
    await expect(
      call(dispatcher, 'read_file', { path: '/etc/hosts' }),
    ).rejects.toThrow(/fora da raiz do projeto/);
  });

  it('argumento obrigatorio ausente e erro claro sem executar', async () => {
    const dispatcher = makeDispatcher();
    await expect(call(dispatcher, 'read_file', {})).rejects.toThrow(
      /read_file: argumento obrigatorio/,
    );
    await expect(call(dispatcher, 'grep', {})).rejects.toThrow(
      /grep: argumento obrigatorio/,
    );
  });

  it('read_file de conteudo binario (byte NUL) da erro claro, nao mojibake (B.2.1)', async () => {
    const dispatcher = makeDispatcher({
      code: 'from lionclaw_tools import read_file',
      enabledTools: ['read_file'],
    });
    fs.writeFileSync(
      path.join(testCwd, 'imagem.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a, 0x00, 0xff]),
    );
    await expect(call(dispatcher, 'read_file', { path: 'imagem.png' })).rejects.toThrow(
      /binario nao suportado/,
    );

    fs.writeFileSync(path.join(testCwd, 'texto.txt'), 'ola mundo\nacentos: cao\n');
    const lido = await call(dispatcher, 'read_file', { path: 'texto.txt' });
    expect(lido).toContain('ola mundo');
  });
});


describe('run_command assincrono', () => {
  it('roda um comando simples e devolve o stdout', async () => {
    const dispatcher = makeDispatcher();
    const saida = await call(dispatcher, 'run_command', { command: 'echo ola-mundo' });
    expect(saida).toBe('ola-mundo\n');
  });

  it('exit code != 0 NAO vira excecao: volta anotado com stderr', async () => {
    const dispatcher = makeDispatcher();
    const saida = await call(dispatcher, 'run_command', {
      command: 'echo parcial; echo falhou >&2; exit 3',
    });
    expect(saida).toContain('parcial');
    expect(saida).toContain('[stderr]');
    expect(saida).toContain('falhou');
    expect(saida).toContain('[exit code: 3]');
  });

  it('nao bloqueia o event loop enquanto o comando roda', async () => {
    const dispatcher = makeDispatcher();
    const pendente = call(dispatcher, 'run_command', { command: 'sleep 0.4' });
    const inicio = Date.now();
    await sleep(30);
    expect(Date.now() - inicio).toBeLessThan(250);
    await pendente;
  });

  it('timeout por RPC mata o process group e rejeita com erro claro', async () => {
    const dispatcher = makeDispatcher({
      overrides: { runCommandTimeoutMs: 300 },
    });
    const inicio = Date.now();
    await expect(
      call(dispatcher, 'run_command', { command: 'sleep 5' }),
    ).rejects.toThrow(/timeout de 300ms/);
    expect(Date.now() - inicio).toBeLessThan(3_000);
  });

  it('abort do turno mata o comando em voo (< 5s) e o RPC rejeita', async () => {
    const abortController = new AbortController();
    const dispatcher = makeDispatcher({ abortSignal: abortController.signal });
    const pidFile = path.join(testCwd, 'pid.txt');
    const pendente = call(dispatcher, 'run_command', {
      command: `echo $$ > ${pidFile}; sleep 5`,
    });
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim().length > 0);
    const shPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);

    const inicio = Date.now();
    abortController.abort();
    await expect(pendente).rejects.toThrow(/abortado \(stop do turno\)/);
    expect(Date.now() - inicio).toBeLessThan(2_000);
    await waitFor(() => isProcessDead(shPid), 3_000);
  });

  it('signal ja abortado rejeita sem spawnar', async () => {
    const abortController = new AbortController();
    abortController.abort();
    const dispatcher = makeDispatcher({ abortSignal: abortController.signal });
    const marker = path.join(testCwd, 'nunca-roda.txt');
    await expect(
      call(dispatcher, 'run_command', { command: `touch ${marker}` }),
    ).rejects.toThrow(/abortado/);
    await sleep(100);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('env do run_command vem da denylist: chave-armadilha ausente, PATH presente', async () => {
    process.env.FAKE_API_KEY = 'segredo-dispatch';
    try {
      const dispatcher = makeDispatcher();
      const saida = await call(dispatcher, 'run_command', { command: 'env' });
      expect(saida).not.toContain('FAKE_API_KEY');
      expect(saida).not.toContain('segredo-dispatch');
      expect(saida).toMatch(/^PATH=|\nPATH=/);
      expect(saida).toMatch(/^HOME=|\nHOME=/);
    } finally {
      delete process.env.FAKE_API_KEY;
    }
  });
});


describe('AC-B7: anti-recursao', () => {
  it('serverId direto lionclaw-toolscript e rejeitado sem executar', async () => {
    const dispatcher = makeDispatcher();
    await expect(
      call(dispatcher, 'mcp_invoke', {
        server_id: 'lionclaw-toolscript',
        tool_name: 'run_tool_script',
        args: { code: 'print(1)' },
      }),
    ).rejects.toThrow(/recursivo bloqueado/);
    expect(setupMock).not.toHaveBeenCalled();
    expect(callMock).not.toHaveBeenCalled();
  });

  it('nome materializado mcp__lionclaw-toolscript__run_tool_script e rejeitado', async () => {
    const dispatcher = makeDispatcher();
    await expect(
      call(dispatcher, 'mcp_invoke', {
        server_id: 'gmail',
        tool_name: 'mcp__lionclaw-toolscript__run_tool_script',
        args: {},
      }),
    ).rejects.toThrow(/recursivo bloqueado/);
    expect(setupMock).not.toHaveBeenCalled();
  });

  it('variacao de caixa/espacos no serverId nao fura a checagem', async () => {
    const dispatcher = makeDispatcher();
    await expect(
      call(dispatcher, 'mcp_invoke', {
        server_id: '  LionClaw-ToolScript ',
        tool_name: 'qualquer',
        args: {},
      }),
    ).rejects.toThrow(/recursivo bloqueado/);
  });
});


describe('mcp_invoke propaga o McpInvocationContext do turno', () => {
  it('monta o McpInvokeRequest completo (surface chat, ids do turno, escopo)', async () => {
    const invokeMcp = vi.fn(async (_req: McpInvokeRequest) => ({
      content: 'ok-mcp',
      displayName: 'd',
    }));
    const dispatcher = makeDispatcher({ overrides: { invokeMcp } });
    const ctx = makeCtx({ sessionId: 'sess-prop', turnId: 'turn-prop' });

    const resultado = await call(
      dispatcher,
      'mcp_invoke',
      { server_id: 'gmail', tool_name: 'search_messages', args: { q: 'x' } },
      ctx,
    );

    expect(resultado).toBe('ok-mcp');
    expect(invokeMcp).toHaveBeenCalledTimes(1);
    expect(invokeMcp.mock.calls[0][0]).toMatchObject({
      serverId: 'gmail',
      toolName: 'search_messages',
      args: { q: 'x' },
      surface: 'chat',
      sessionId: 'sess-prop',
      turnId: 'turn-prop',
      allowedServerIds: ['lionclaw-pipeline-control', 'gmail'],
      context: { surface: 'chat', sessionId: 'sess-prop', turnId: 'turn-prop' },
    });
    expect(ctx.pauseTimeout).not.toHaveBeenCalled();
  });

  it('isError do wrapper vira throw (ToolError capturavel no script)', async () => {
    const invokeMcp = vi.fn(async () => ({
      content: 'erro do servidor remoto',
      isError: true,
      displayName: 'd',
    }));
    const dispatcher = makeDispatcher({ overrides: { invokeMcp } });
    await expect(
      call(dispatcher, 'mcp_invoke', { server_id: 'gmail', tool_name: 'fetch_x', args: {} }),
    ).rejects.toThrow(/erro do servidor remoto/);
  });
});


describe('AC-B6: capability gate em ENFORCE dentro do script', () => {
  it('Pipeline=false bloqueia mcp_invoke(lionclaw-pipeline-control) sem spawn', async () => {
    state.settings['chat_capability_gate_mode'] = 'enforce';
    registerChatCapabilityTurn(
      {
        surface: 'chat',
        sessionId: 'sess-b6',
        turnId: 'turn-b6',
        capabilities: { pipelineControl: false, dynamicWorkflows: false },
        cwd: testCwd,
        permissionProfile: { mode: 'default', dangerouslySkipPermissions: false },
        allowedServerIds: ['lionclaw-pipeline-control'],
      },
      60_000,
    );
    const dispatcher = makeDispatcher();
    const ctx = makeCtx({
      sessionId: 'sess-b6',
      turnId: 'turn-b6',
      allowedServerIds: ['lionclaw-pipeline-control'],
    });

    await expect(
      call(
        dispatcher,
        'mcp_invoke',
        { server_id: 'lionclaw-pipeline-control', tool_name: 'pipeline_list', args: {} },
        ctx,
      ),
    ).rejects.toThrow(/Pipeline está desligado/);
    expect(setupMock).not.toHaveBeenCalled();
    expect(callMock).not.toHaveBeenCalled();
  });

  it('server fora do escopo da sessao e negado pelo wrapper central (isError -> throw)', async () => {
    registerChatCapabilityTurn(
      {
        surface: 'chat',
        sessionId: 'sess-b6-esc',
        turnId: 'turn-b6-esc',
        capabilities: { pipelineControl: false, dynamicWorkflows: false },
        cwd: testCwd,
        permissionProfile: { mode: 'default', dangerouslySkipPermissions: false },
        allowedServerIds: ['gmail'],
      },
      60_000,
    );
    const dispatcher = makeDispatcher();
    const ctx = makeCtx({
      sessionId: 'sess-b6-esc',
      turnId: 'turn-b6-esc',
      allowedServerIds: ['gmail'],
    });
    await expect(
      call(
        dispatcher,
        'mcp_invoke',
        { server_id: 'youtube', tool_name: 'search_videos', args: {} },
        ctx,
      ),
    ).rejects.toThrow(/fora do escopo desta sessao/);
    expect(setupMock).not.toHaveBeenCalled();
  });
});


describe('AC-B5: env sem segredos nos DOIS canais (e2e com o motor do S1)', () => {
  it('run_command(env) e os.environ nao expoem chaves; PATH/HOME presentes', async () => {
    process.env.FAKE_API_KEY = 'segredo-vault-falso';
    process.env.GH_TOKEN = 'xxx-gh-token';
    try {
      registerChatCapabilityTurn(
        {
          surface: 'chat',
          sessionId: 'sess-b5',
          turnId: 'turn-b5',
          capabilities: { pipelineControl: false, dynamicWorkflows: false },
          cwd: testCwd,
          permissionProfile: { mode: 'default', dangerouslySkipPermissions: false },
          allowedServerIds: [],
        },
        60_000,
      );
      const dispatcher = makeDispatcher({
        code: 'from lionclaw_tools import run_command',
      });
      const result = await runToolScript(
        {
          code: [
            'import os',
            'from lionclaw_tools import run_command',
            "out = run_command('env')",
            "print('CMD_FAKE:', 'FAKE_API_KEY' in out)",
            "print('CMD_GH:', 'GH_TOKEN' in out)",
            "print('CMD_PATH:', 'PATH=' in out)",
            "print('OSENV_FAKE:', os.environ.get('FAKE_API_KEY', 'ausente'))",
            "print('OSENV_GH:', os.environ.get('GH_TOKEN', 'ausente'))",
            "print('OSENV_HOME:', 'HOME' in os.environ)",
            "print('OSENV_PATH:', 'PATH' in os.environ)",
          ].join('\n'),
          sessionId: 'sess-b5',
          turnId: 'turn-b5',
          abortSignal: new AbortController().signal,
        },
        {
          dispatchRpc: dispatcher,
          pythonPath: TEST_PYTHON,
          buildEnv: () => buildToolScriptEnv(),
          timeoutMs: 15_000,
          rpcTimeoutMs: 6_000,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('CMD_FAKE: False');
      expect(result.stdout).toContain('CMD_GH: False');
      expect(result.stdout).toContain('CMD_PATH: True');
      expect(result.stdout).toContain('OSENV_FAKE: ausente');
      expect(result.stdout).toContain('OSENV_GH: ausente');
      expect(result.stdout).toContain('OSENV_HOME: True');
      expect(result.stdout).toContain('OSENV_PATH: True');
      expect(result.stdout).not.toContain('segredo-vault-falso');
      expect(result.stdout).not.toContain('xxx-gh-token');
    } finally {
      delete process.env.FAKE_API_KEY;
      delete process.env.GH_TOKEN;
    }
  }, 30_000);
});


describe('seam de auditoria onToolCall', () => {
  it('emite uma entrada por RPC com displayName real (ok e falha)', async () => {
    const entries: ToolScriptToolCallAudit[] = [];
    const invokeMcp = vi.fn(async () => ({ content: 'ok', displayName: 'd' }));
    const dispatcher = makeDispatcher({
      onToolCall: (entry) => entries.push(entry),
      overrides: { invokeMcp },
    });

    fs.writeFileSync(path.join(testCwd, 'a.txt'), 'conteudo');
    await call(dispatcher, 'read_file', { path: 'a.txt' });
    const comandoLongo = `echo ${'x'.repeat(120)}`;
    await call(dispatcher, 'run_command', { command: comandoLongo });
    await call(dispatcher, 'mcp_invoke', {
      server_id: 'gmail',
      tool_name: 'send_email',
      args: {},
    });
    await expect(call(dispatcher, 'tool_inventada', {})).rejects.toThrow();

    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({
      tool: 'read_file',
      displayName: `read_file ${path.join(testCwd, 'a.txt')}`,
      ok: true,
      sessionId: 'sess-disp',
      turnId: 'turn-disp',
    });
    expect(entries[1].displayName).toMatch(/^run_command echo x+\.\.\.$/);
    expect(entries[1].displayName.length).toBeLessThan(comandoLongo.length);
    expect(entries[2].displayName).toBe('mcp__gmail__send_email');
    expect(entries[3].ok).toBe(false);
    expect(entries[3].error).toMatch(/desconhecida ou desabilitada/);
  });

  it('hook que lanca NAO derruba a RPC', async () => {
    const dispatcher = makeDispatcher({
      onToolCall: () => {
        throw new Error('hook quebrado');
      },
    });
    const saida = await call(dispatcher, 'run_command', { command: 'echo resiliente' });
    expect(saida).toBe('resiliente\n');
  });
});


describe('buildToolScriptEnv / isDeniedEnvKey (B.7)', () => {
  it('remove chaves-armadilha e preserva operacionais', () => {
    const base: NodeJS.ProcessEnv = {
      HOME: '/Users/x',
      PATH: '/usr/bin',
      LANG: 'pt_BR.UTF-8',
      LC_ALL: 'pt_BR.UTF-8',
      TMPDIR: '/tmp',
      TERM: 'xterm',
      USER: 'x',
      SHELL: '/bin/zsh',
      LOGNAME: 'x',
      PWD: '/Users/x',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      FOO_API_KEY: 'a',
      GH_TOKEN: 'b',
      MY_SECRET: 'c',
      ANTHROPIC_API_KEY: 'd',
      ANTHROPIC_BASE_URL: 'e',
      OPENAI_ORG: 'f',
      KEYTAR_SERVICE: 'g',
      VAULT_ADDR: 'h',
      DB_PASSWORD: 'i',
      DATABASE_URL: 'postgres://user:pass@host/db',
      STRIPE_KEY: 'j',
      GH_PAT: 'k',
      LIONCLAW_HELPER_TOKEN: 'l',
      AWS_ACCESS_KEY_ID: 'm',
      GOOGLE_APPLICATION_CREDENTIALS: '/x.json',
      npm_config__authToken: 'n',
      MEU_APP_QUALQUER: 'passa',
    };
    const env = buildToolScriptEnv(base);

    for (const preservada of [
      'HOME',
      'PATH',
      'LANG',
      'LC_ALL',
      'TMPDIR',
      'TERM',
      'USER',
      'SHELL',
      'LOGNAME',
      'PWD',
      'SSH_AUTH_SOCK',
      'MEU_APP_QUALQUER',
    ]) {
      expect(env[preservada], preservada).toBe(base[preservada]);
    }
    for (const removida of [
      'FOO_API_KEY',
      'GH_TOKEN',
      'MY_SECRET',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'OPENAI_ORG',
      'KEYTAR_SERVICE',
      'VAULT_ADDR',
      'DB_PASSWORD',
      'DATABASE_URL',
      'STRIPE_KEY',
      'GH_PAT',
      'LIONCLAW_HELPER_TOKEN',
      'AWS_ACCESS_KEY_ID',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'npm_config__authToken',
    ]) {
      expect(env[removida], removida).toBeUndefined();
    }
  });

  it('isDeniedEnvKey e case-insensitive e preserva prefixos operacionais', () => {
    expect(isDeniedEnvKey('minha_api_key')).toBe(true);
    expect(isDeniedEnvKey('LC_CTYPE')).toBe(false);
    expect(isDeniedEnvKey('XDG_CONFIG_HOME')).toBe(false);
    expect(isDeniedEnvKey('PATH')).toBe(false);
    expect(isDeniedEnvKey('NODE_AUTH')).toBe(true);
    expect(isDeniedEnvKey('SENTRY_DSN')).toBe(true);
  });

  it('default parte de process.env', () => {
    process.env.LIONTEST_ENV_PROBE_TOKEN = 'x';
    process.env.LIONTEST_ENV_PROBE_OK = 'y';
    try {
      const env = buildToolScriptEnv();
      expect(env.LIONTEST_ENV_PROBE_TOKEN).toBeUndefined();
      expect(env.LIONTEST_ENV_PROBE_OK).toBe('y');
    } finally {
      delete process.env.LIONTEST_ENV_PROBE_TOKEN;
      delete process.env.LIONTEST_ENV_PROBE_OK;
    }
  });
});


describe('requestActionConfirmation (export aditivo, mecanismo REAL)', () => {
  function makeWindow(): { win: BrowserWindow; send: ReturnType<typeof vi.fn> } {
    const send = vi.fn();
    const win = { webContents: { send } } as unknown as BrowserWindow;
    return { win, send };
  }

  it('envia pelo canal chat:confirm-request e resolve approved=true no aceite', async () => {
    const { win, send } = makeWindow();
    const promessa = requestActionConfirmation(() => win, {
      tool: 'acao-generica',
      description: 'confirmar acao',
      input: { a: 1 },
      risk: 'high',
    });
    await waitFor(() => send.mock.calls.length === 1);
    const [channel, action] = send.mock.calls[0] as [string, { id: string; tool: string }];
    expect(channel).toBe('chat:confirm-request');
    expect(action.tool).toBe('acao-generica');
    resolveConfirmation(action.id, true);
    await expect(promessa).resolves.toEqual({ approved: true });
    expect(insertAuditEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'confirm_response', approved: true }),
    );
  });

  it('negacao resolve approved=false com a mensagem do guard', async () => {
    const { win, send } = makeWindow();
    const promessa = requestActionConfirmation(() => win, {
      tool: 'acao-generica',
      description: 'confirmar acao',
      input: {},
      risk: 'medium',
    });
    await waitFor(() => send.mock.calls.length === 1);
    const [, action] = send.mock.calls[0] as [string, { id: string }];
    resolveConfirmation(action.id, false);
    await expect(promessa).resolves.toEqual({
      approved: false,
      message: 'Acao negada pelo usuario',
    });
  });

  it('sem janela disponivel -> approved=false (fail-closed)', async () => {
    await expect(
      requestActionConfirmation(() => null, {
        tool: 'acao-generica',
        description: 'sem janela',
        input: {},
        risk: 'high',
      }),
    ).resolves.toEqual({
      approved: false,
      message: 'Janela nao disponivel para confirmacao',
    });
  });
});


describe('classifyToolScriptCode', () => {
  it('so read-only -> nao mutante; mutante habilitada no codigo -> mutante', () => {
    expect(
      classifyToolScriptCode(
        'from lionclaw_tools import read_file, grep\nprint(read_file("/x"))',
        ['read_file', 'grep', 'run_command'],
      ),
    ).toEqual({ mutating: false, matchedTools: [] });

    expect(
      classifyToolScriptCode('from lionclaw_tools import run_command', [
        'read_file',
        'run_command',
      ]),
    ).toEqual({ mutating: true, matchedTools: ['run_command'] });
  });

  it('tool mutante DESABILITADA nao classifica; word boundary evita falso match', () => {
    expect(
      classifyToolScriptCode('run_command("x")', ['read_file']).mutating,
    ).toBe(false);
    expect(classifyToolScriptCode('print("edited")', ['edit']).mutating).toBe(false);
    expect(classifyToolScriptCode('edit("a", "b", "c")', ['edit']).mutating).toBe(true);
  });
});
