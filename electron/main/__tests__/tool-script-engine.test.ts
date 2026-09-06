
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  runToolScript,
  isToolScriptAvailable,
  getToolScriptPythonPath,
  createToolScriptSocketPath,
  buildDefaultToolScriptEnv,
  __resetToolScriptPythonDetectionForTests,
} from '../tool-script/tool-script-engine';
import {
  ToolScriptError,
  type ToolScriptEngineDeps,
  type ToolScriptRpcCall,
  type ToolScriptRpcDispatcher,
  type ToolScriptDispatchContext,
} from '../tool-script/tool-script-types';
import {
  generateLionclawToolsStub,
  assertValidStubToolName,
} from '../tool-script/tool-script-python-stub';
import {
  registerChatCapabilityTurn,
  __resetChatCapabilityContextForTests,
  type ChatCapabilityTurnContextInput,
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

async function waitFor(
  cond: () => boolean,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(intervalMs);
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

interface RecordedCall {
  id: number;
  tool: string;
  args: Record<string, unknown>;
  sessionId: string;
}

function makeFakeDispatch(
  impl: (call: ToolScriptRpcCall, ctx: ToolScriptDispatchContext) => Promise<string> | string,
): { calls: RecordedCall[]; dispatch: ToolScriptRpcDispatcher } {
  const calls: RecordedCall[] = [];
  const dispatch: ToolScriptRpcDispatcher = async (call, ctx) => {
    calls.push({ id: call.id, tool: call.tool, args: call.args, sessionId: ctx.sessionId });
    return impl(call, ctx);
  };
  return { calls, dispatch };
}

let testCwd: string;
let turnCounter = 0;

function registerTurn(
  overrides: Partial<ChatCapabilityTurnContextInput> = {},
): { sessionId: string; turnId: string } {
  turnCounter++;
  const sessionId = overrides.sessionId ?? `sess-ts-${turnCounter}`;
  const turnId = overrides.turnId ?? `turn-ts-${turnCounter}`;
  registerChatCapabilityTurn(
    {
      surface: 'chat',
      capabilities: { pipelineControl: false, dynamicWorkflows: false },
      cwd: testCwd,
      permissionProfile: { mode: 'default', dangerouslySkipPermissions: false },
      allowedServerIds: ['lionclaw-pipeline-control'],
      ...overrides,
      sessionId,
      turnId,
    },
    60_000,
  );
  return { sessionId, turnId };
}

function makeDeps(
  dispatch: ToolScriptRpcDispatcher,
  overrides: Partial<ToolScriptEngineDeps> = {},
): ToolScriptEngineDeps {
  return {
    dispatchRpc: dispatch,
    pythonPath: TEST_PYTHON,
    timeoutMs: 8_000,
    rpcTimeoutMs: 2_000,
    ...overrides,
  };
}

async function run(
  code: string,
  dispatch: ToolScriptRpcDispatcher,
  overrides: Partial<ToolScriptEngineDeps> = {},
  abortSignal?: AbortSignal,
) {
  const { sessionId, turnId } = registerTurn();
  return runToolScript(
    {
      code,
      sessionId,
      turnId,
      abortSignal: abortSignal ?? new AbortController().signal,
    },
    makeDeps(dispatch, overrides),
  );
}

beforeEach(() => {
  __resetChatCapabilityContextForTests();
  testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ts-test-cwd-'));
});

afterEach(() => {
  __resetChatCapabilityContextForTests();
  fs.rmSync(testCwd, { recursive: true, force: true });
});


describe('so stdout volta', () => {
  it('resultado de RPC intermediaria NAO aparece no retorno; so o print final', async () => {
    const { calls, dispatch } = makeFakeDispatch(() => 'CONTEUDO-INTERMEDIARIO-9f8e7d');
    const result = await run(
      [
        'from lionclaw_tools import read_file',
        'dados = read_file("/etc/fake.txt")',
        'print("resultado-final")',
      ].join('\n'),
      dispatch,
    );

    expect(result.stdout).toBe('resultado-final\n');
    expect(result.stdout).not.toContain('CONTEUDO-INTERMEDIARIO');
    expect(result.exitCode).toBe(0);
    expect(result.toolCallCount).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('read_file');
    expect(calls[0].args).toEqual({ path: '/etc/fake.txt' });
  });
});


describe('caps de stdout/stderr', () => {
  it('acima do cap MARCA; stdout vira head 40% + nota + tail 60% com persist (B.6/S4); stderr trunca simples', async () => {
    const { dispatch } = makeFakeDispatch(() => '');
    const result = await run(
      [
        'import sys',
        'sys.stdout.write("A" * 1000)',
        'sys.stderr.write("B" * 500)',
      ].join('\n'),
      dispatch,
      { maxStdoutBytes: 200, maxStderrBytes: 100 },
    );

    expect(result.stdout.startsWith('A'.repeat(80))).toBe(true);
    expect(result.stdout.endsWith('A'.repeat(120))).toBe(true);
    expect(result.stdout).toMatch(/\.\.\.\[\d+ bytes omitidos, resto em .+\]\.\.\./);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.persistedPath).toBeDefined();
    expect(
      (result.persistedPath as string).startsWith(
        path.join(testCwd, '.lionclaw', 'tool-script') + path.sep,
      ),
    ).toBe(true);
    expect(fs.readFileSync(result.persistedPath as string, 'utf8')).toBe('A'.repeat(1000));
    expect(result.stderr).toBe('B'.repeat(100));
    expect(result.stderrTruncated).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('abaixo do cap nao trunca nem marca (nem persiste)', async () => {
    const { dispatch } = makeFakeDispatch(() => '');
    const result = await run('print("curto")', dispatch, {
      maxStdoutBytes: 200,
      maxStderrBytes: 100,
    });
    expect(result.stdout).toBe('curto\n');
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
    expect(result.persistedPath).toBeUndefined();
  });
});


describe('abort (AC-B8, metade motor)', () => {
  it('abortSignal mata o process group inteiro, incluindo neto (sleep 30)', async () => {
    const { dispatch } = makeFakeDispatch(() => '');
    const abortController = new AbortController();
    const { sessionId, turnId } = registerTurn();

    const promise = runToolScript(
      {
        code: [
          'import os, subprocess, time',
          'p = subprocess.Popen(["/bin/sleep", "30"])',
          'with open("pids.txt", "w") as f:',
          '    f.write("%d %d" % (os.getpid(), p.pid))',
          'time.sleep(30)',
        ].join('\n'),
        sessionId,
        turnId,
        abortSignal: abortController.signal,
      },
      makeDeps(dispatch),
    );

    const pidsFile = path.join(testCwd, 'pids.txt');
    await waitFor(() => {
      if (!fs.existsSync(pidsFile)) return false;
      return fs.readFileSync(pidsFile, 'utf8').trim().split(' ').length === 2;
    });
    const [pyPid, grandchildPid] = fs
      .readFileSync(pidsFile, 'utf8')
      .trim()
      .split(' ')
      .map((raw) => Number.parseInt(raw, 10));

    abortController.abort();
    const result = await promise;

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    await waitFor(() => isProcessDead(pyPid), 3_000);
    await waitFor(() => isProcessDead(grandchildPid), 3_000);
    expect(() => process.kill(-pyPid, 0)).toThrow();
  });

  it('signal ja abortado antes do spawn devolve aborted sem rodar nada', async () => {
    const { calls, dispatch } = makeFakeDispatch(() => '');
    const abortController = new AbortController();
    abortController.abort();
    const result = await run(
      'print("nunca roda")',
      dispatch,
      { pythonPath: '/caminho/inexistente/python3' },
      abortController.signal,
    );
    expect(result.aborted).toBe(true);
    expect(result.stdout).toBe('');
    expect(result.toolCallCount).toBe(0);
    expect(calls).toHaveLength(0);
  });
});


describe('AC-B3: encadeamento de tools sem round-trip', () => {
  it('tool A alimenta o argumento da tool B; retorno = so o stdout final', async () => {
    const { calls, dispatch } = makeFakeDispatch((call) => {
      if (call.tool === 'read_file') return 'conteudo: TOKEN-ENCADEADO-42';
      if (call.tool === 'grep') return `MATCH:${String(call.args.pattern)}`;
      throw new Error(`tool inesperada: ${call.tool}`);
    });

    const result = await run(
      [
        'from lionclaw_tools import read_file, grep',
        'bruto = read_file("/tmp/entrada.txt")',
        'token = bruto.split(":")[-1].strip()',
        'print(grep(token, "/tmp"))',
      ].join('\n'),
      dispatch,
    );

    expect(calls).toHaveLength(2);
    expect(calls[0].tool).toBe('read_file');
    expect(calls[1].tool).toBe('grep');
    expect(calls[1].args.pattern).toBe('TOKEN-ENCADEADO-42');
    expect(calls[0].id).not.toBe(calls[1].id);
    expect(result.toolCallCount).toBe(2);
    expect(result.stdout).toBe('MATCH:TOKEN-ENCADEADO-42\n');
    expect(result.stdout).not.toContain('conteudo:');
    expect(result.exitCode).toBe(0);
  });
});


describe('socket path', () => {
  it('fica em os.tmpdir() com menos de 100 bytes (limite de 104 do macOS)', () => {
    const socketPath = createToolScriptSocketPath();
    expect(Buffer.byteLength(socketPath, 'utf8')).toBeLessThan(100);
    expect(socketPath.startsWith(os.tmpdir())).toBe(true);
    expect(socketPath.endsWith('.sock')).toBe(true);
  });

  it('e unico por execucao', () => {
    expect(createToolScriptSocketPath()).not.toBe(createToolScriptSocketPath());
  });
});


describe('timeout global pausavel (AC-B9 parcial)', () => {
  it('pauseTimeout durante a RPC segura o relogio: script sobrevive e completa', async () => {
    const { dispatch } = makeFakeDispatch(async (_call, ctx) => {
      ctx.pauseTimeout();
      await sleep(2_500);
      ctx.resumeTimeout();
      return 'RESULTADO-LENTO';
    });

    const result = await run(
      ['from lionclaw_tools import read_file', 'print(read_file("/x"))'].join('\n'),
      dispatch,
      { timeoutMs: 1_500, rpcTimeoutMs: 10_000 },
    );

    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('RESULTADO-LENTO\n');
  });

  it('sem pause, script que estoura o teto global e morto com timedOut', async () => {
    const { dispatch } = makeFakeDispatch(() => '');
    const result = await run('import time\ntime.sleep(20)', dispatch, {
      timeoutMs: 700,
    });
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.exitCode).toBe(-1);
  });
});


describe('correlacao concorrente por id', () => {
  it('4 threads simultaneas recebem cada uma o SEU resultado', async () => {
    const delays: Record<string, number> = {
      '/f0': 450,
      '/f1': 300,
      '/f2': 150,
      '/f3': 0,
    };
    const { calls, dispatch } = makeFakeDispatch(async (call) => {
      const p = String(call.args.path);
      await sleep(delays[p] ?? 0);
      return `V:${p}`;
    });

    const result = await run(
      [
        'import threading',
        'from lionclaw_tools import read_file',
        'results = {}',
        'def worker(i):',
        '    results[i] = read_file("/f%d" % i)',
        'threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]',
        'for t in threads:',
        '    t.start()',
        'for t in threads:',
        '    t.join()',
        'for i in range(4):',
        '    print("%d=%s" % (i, results[i]))',
      ].join('\n'),
      dispatch,
      { rpcTimeoutMs: 5_000 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('0=V:/f0\n1=V:/f1\n2=V:/f2\n3=V:/f3\n');
    expect(result.toolCallCount).toBe(4);
    const ids = new Set(calls.map((c) => c.id));
    expect(ids.size).toBe(4);
  });
});


describe('token por execucao', () => {
  it('frame com token invalido nao e processado nem respondido', async () => {
    const { calls, dispatch } = makeFakeDispatch(() => 'NUNCA');
    const result = await run(
      [
        'import json, socket',
        'import lionclaw_tools as lt',
        's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
        's.settimeout(1.0)',
        's.connect(lt._SOCKET_PATH)',
        'frame = {"id": 1, "tool": "read_file", "args": {}, "token": "token-errado"}',
        's.sendall((json.dumps(frame) + "\\n").encode("utf-8"))',
        'try:',
        '    s.recv(4096)',
        '    print("RESPOSTA-RECEBIDA")',
        'except socket.timeout:',
        '    print("FRAME-DESCARTADO")',
        'finally:',
        '    s.close()',
      ].join('\n'),
      dispatch,
      { rpcTimeoutMs: 600 },
    );

    expect(result.stdout).toBe('FRAME-DESCARTADO\n');
    expect(result.toolCallCount).toBe(0);
    expect(calls).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });
});


describe('fail-closed do turn-context', () => {
  it('sem turn-context registrado -> erro claro, sem spawn', async () => {
    const { calls, dispatch } = makeFakeDispatch(() => '');
    const attempt = runToolScript(
      {
        code: 'print("nao roda")',
        sessionId: 'sess-fantasma',
        turnId: 'turn-fantasma',
        abortSignal: new AbortController().signal,
      },
      makeDeps(dispatch, { pythonPath: '/caminho/inexistente/python3' }),
    );
    await expect(attempt).rejects.toBeInstanceOf(ToolScriptError);
    await expect(attempt).rejects.toMatchObject({ code: 'turn-context-missing' });
    expect(calls).toHaveLength(0);
  });

  it('turn-context SEM os campos da Fase B -> erro claro listando os campos', async () => {
    const { calls, dispatch } = makeFakeDispatch(() => '');
    registerChatCapabilityTurn(
      {
        surface: 'chat',
        sessionId: 'sess-fase-a',
        turnId: 'turn-fase-a',
        capabilities: { pipelineControl: true, dynamicWorkflows: true },
      },
      60_000,
    );
    const attempt = runToolScript(
      {
        code: 'print("nao roda")',
        sessionId: 'sess-fase-a',
        turnId: 'turn-fase-a',
        abortSignal: new AbortController().signal,
      },
      makeDeps(dispatch, { pythonPath: '/caminho/inexistente/python3' }),
    );
    await expect(attempt).rejects.toMatchObject({ code: 'turn-context-incomplete' });
    await expect(attempt).rejects.toThrow(/cwd, permissionProfile, allowedServerIds/);
    expect(calls).toHaveLength(0);
  });
});


describe('limite de tool calls', () => {
  it('RPC alem do limite responde erro, o processo morre e os flags marcam', async () => {
    const { calls, dispatch } = makeFakeDispatch(() => 'ok');
    const result = await run(
      [
        'import sys',
        'from lionclaw_tools import read_file, ToolError',
        'for i in range(10):',
        '    try:',
        '        read_file("/f%d" % i)',
        '        print("ok%d" % i)',
        '        sys.stdout.flush()',
        '    except ToolError as e:',
        '        print("erro-limite")',
        '        sys.stdout.flush()',
      ].join('\n'),
      dispatch,
      { maxToolCalls: 3 },
    );

    expect(result.toolCallCount).toBe(3);
    expect(result.toolCallLimitExceeded).toBe(true);
    expect(calls).toHaveLength(3);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.stdout).toContain('ok0');
    expect(result.stdout).toContain('ok2');
    expect(result.exitCode).toBe(-1);
  });
});


describe('erro de tool no script', () => {
  it('throw do dispatcher vira ToolError capturavel; nao capturado vira traceback', async () => {
    const { dispatch } = makeFakeDispatch(() => {
      throw new Error('falha-simulada-da-tool');
    });

    const capturado = await run(
      [
        'from lionclaw_tools import read_file, ToolError',
        'try:',
        '    read_file("/quebra")',
        'except ToolError as e:',
        '    print("capturado:%s" % e)',
      ].join('\n'),
      dispatch,
    );
    expect(capturado.stdout).toBe('capturado:falha-simulada-da-tool\n');
    expect(capturado.exitCode).toBe(0);

    const naoCapturado = await run(
      ['from lionclaw_tools import read_file', 'read_file("/quebra")'].join('\n'),
      dispatch,
    );
    expect(naoCapturado.exitCode).toBe(1);
    expect(naoCapturado.stderr).toContain('ToolError');
    expect(naoCapturado.stderr).toContain('falha-simulada-da-tool');
  });
});


describe('built-ins do stub', () => {
  it('json_parse/shell_quote/retry funcionam; retry reexecuta a tool', async () => {
    let instavelTentativas = 0;
    const { calls, dispatch } = makeFakeDispatch(() => {
      instavelTentativas++;
      if (instavelTentativas < 3) throw new Error('instabilidade transitoria');
      return 'terceira-vez';
    });

    const result = await run(
      [
        'from lionclaw_tools import json_parse, shell_quote, retry, read_file',
        'print(json_parse(\'{"a": 41}\')["a"] + 1)',
        'print(shell_quote("a b"))',
        'print(retry(lambda: read_file("/instavel"), attempts=3, delay=0.01))',
      ].join('\n'),
      dispatch,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("42\n'a b'\nterceira-vez\n");
    expect(calls).toHaveLength(3);
  });
});


describe('execucoes paralelas', () => {
  it('duas execucoes simultaneas nao se cruzam (socket/temp/token proprios)', async () => {
    const fakeA = makeFakeDispatch(async () => {
      await sleep(150);
      return 'resA';
    });
    const fakeB = makeFakeDispatch(async () => {
      await sleep(50);
      return 'resB';
    });
    const turnA = registerTurn();
    const turnB = registerTurn();

    const script = (prefix: string): string =>
      [
        'from lionclaw_tools import read_file',
        `print("${prefix}-" + read_file("/x"))`,
      ].join('\n');

    const [resultA, resultB] = await Promise.all([
      runToolScript(
        { code: script('A'), ...turnA, abortSignal: new AbortController().signal },
        makeDeps(fakeA.dispatch),
      ),
      runToolScript(
        { code: script('B'), ...turnB, abortSignal: new AbortController().signal },
        makeDeps(fakeB.dispatch),
      ),
    ]);

    expect(resultA.stdout).toBe('A-resA\n');
    expect(resultB.stdout).toBe('B-resB\n');
    expect(fakeA.calls).toHaveLength(1);
    expect(fakeB.calls).toHaveLength(1);
    expect(fakeA.calls[0].sessionId).toBe(turnA.sessionId);
    expect(fakeB.calls[0].sessionId).toBe(turnB.sessionId);
  });
});


describe('limpeza em finally', () => {
  it('temp dirs e sockets da execucao sao removidos ao fim', async () => {
    const prevTmp = process.env.TMPDIR;
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'tsclean-'));
    process.env.TMPDIR = isolated;
    try {
      const countArtifacts = (): number =>
        fs
          .readdirSync(isolated)
          .filter((name) => name.startsWith('lc-toolscript-') || /^lcts-.*\.sock$/.test(name))
          .length;

      const before = countArtifacts();
      const { dispatch } = makeFakeDispatch(() => '');
      await run('print("limpo")', dispatch);
      expect(countArtifacts()).toBe(before);
    } finally {
      if (prevTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmp;
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
});


describe('env do filho', () => {
  it('default nao vaza variaveis fora da allowlist; buildEnv injetado prevalece', async () => {
    process.env.LIONCLAW_FAKE_SECRET_S1 = 'nao-pode-vazar';
    try {
      const { dispatch } = makeFakeDispatch(() => '');
      const semSecret = await run(
        [
          'import os',
          'print(os.environ.get("LIONCLAW_FAKE_SECRET_S1", "ausente"))',
        ].join('\n'),
        dispatch,
      );
      expect(semSecret.stdout).toBe('ausente\n');

      const comMarker = await run(
        ['import os', 'print(os.environ.get("LIONCLAW_MARKER_S1", "ausente"))'].join('\n'),
        dispatch,
        {
          buildEnv: () => ({
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            LIONCLAW_MARKER_S1: 'veio-do-deps',
          }),
        },
      );
      expect(comMarker.stdout).toBe('veio-do-deps\n');
    } finally {
      delete process.env.LIONCLAW_FAKE_SECRET_S1;
    }
  });

  it('buildDefaultToolScriptEnv nao copia variaveis arbitrarias do main', () => {
    process.env.LIONCLAW_FAKE_SECRET_S1 = 'nao-pode-vazar';
    try {
      const env = buildDefaultToolScriptEnv();
      expect(env.LIONCLAW_FAKE_SECRET_S1).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.LIONCLAW_FAKE_SECRET_S1;
    }
  });
});


describe('isToolScriptAvailable', () => {
  it('detecta python3 por caminho explicito e expoe o binario para o spawn', () => {
    __resetToolScriptPythonDetectionForTests();
    expect(isToolScriptAvailable()).toBe(true);
    const pythonPath = getToolScriptPythonPath();
    expect(pythonPath).toBeDefined();
    expect(fs.existsSync(pythonPath as string)).toBe(true);
    expect(getToolScriptPythonPath()).toBe(pythonPath);
  });
});


describe('gerador do stub Python', () => {
  it('variante unix usa AF_UNIX; variante tcp usa loopback (fallback win32)', () => {
    const unix = generateLionclawToolsStub({
      transport: { kind: 'unix', socketPath: '/tmp/lcts-abc.sock' },
      token: 'tok',
      enabledTools: ['read_file'],
      clientTimeoutSeconds: 2,
    });
    expect(unix).toContain('AF_UNIX');
    expect(unix).toContain('/tmp/lcts-abc.sock');
    expect(unix).not.toContain('create_connection');

    const tcp = generateLionclawToolsStub({
      transport: { kind: 'tcp', host: '127.0.0.1', port: 4567 },
      token: 'tok',
      enabledTools: ['read_file'],
      clientTimeoutSeconds: 2,
    });
    expect(tcp).toContain('create_connection');
    expect(tcp).toContain('_PORT = 4567');
    expect(tcp).not.toContain('AF_UNIX');
  });

  it('token e socket ficam NO ARQUIVO gerado, e cada tool habilitada vira funcao', () => {
    const stub = generateLionclawToolsStub({
      transport: { kind: 'unix', socketPath: '/tmp/lcts-x.sock' },
      token: 'segredo-por-execucao',
      enabledTools: ['read_file', 'run_command'],
      clientTimeoutSeconds: 2,
    });
    expect(stub).toContain('_TOKEN = "segredo-por-execucao"');
    expect(stub).toContain('def read_file(');
    expect(stub).toContain('def run_command(');
    expect(stub).not.toContain('def write_file(');
    expect(stub).toContain('def json_parse(');
    expect(stub).toContain('def shell_quote(');
    expect(stub).toContain('def retry(');
  });

  it('rejeita nome de tool que nao e identificador Python ou colide com built-in', () => {
    expect(() => assertValidStubToolName('nome-invalido')).toThrow(/identificador/);
    expect(() => assertValidStubToolName('1abc')).toThrow(/identificador/);
    expect(() => assertValidStubToolName('_privada')).toThrow(/colide/);
    expect(() => assertValidStubToolName('retry')).toThrow(/colide/);
    expect(() => assertValidStubToolName('read_file')).not.toThrow();
  });
});
