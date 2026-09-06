
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const resolveKimiBinaryMock = vi.fn<() => Promise<string | null>>();
const isKimiAvailableMock = vi.fn();

vi.mock('../../agent-runtime/kimi-availability', async () => {
  const actual = await vi.importActual<typeof import('../../agent-runtime/kimi-availability')>(
    '../../agent-runtime/kimi-availability',
  );
  return {
    ...actual,
    resolveKimiBinary: () => resolveKimiBinaryMock(),
    isKimiAvailable: () => isKimiAvailableMock(),
  };
});

import {
  KimiAcpDriver,
  KimiAcpRunHandle,
  getKimiAcpDriver,
  shutdownKimiRuntime,
} from '../acp-driver';
import { KimiAuthError, KimiUnavailableError } from '../../agent-runtime/kimi-availability';
import { PERM_DEFAULT_NO_BYPASS } from '../../agent-runtime/permission-profiles';
import { FakeAcpTransport, fakeAcpTransportFactory } from './fake-acp-transport';
import { getKimiBridgeRegistry } from '../mcp-bridge-registry';
import type { CliStreamCallbacks } from '../../agent-runtime/cli-agentic/contract';
import type { KimiAcpRunOptions, KimiAcpMcpServerEntry } from '../types';
import type { KimiMcpBridge } from '../mcp-http-bridge';
import { KimiAcpJsonRpcError, type AcpSpawnConfig } from '../acp-transport';

const SESSION_ID = 'session_test_001';

function sessionNewResult() {
  return {
    sessionId: SESSION_ID,
    configOptions: [
      {
        id: 'model',
        currentValue: 'kimi-code/k3',
        options: [
          { value: 'kimi-code/kimi-for-coding' },
          { value: 'kimi-code/k3' },
        ],
      },
      { id: 'thinking', currentValue: 'on', options: [{ value: 'on' }] },
      {
        id: 'mode',
        currentValue: 'default',
        options: [{ value: 'default' }, { value: 'auto' }, { value: 'yolo' }],
      },
    ],
  };
}

function baseOpts(over: Partial<KimiAcpRunOptions> = {}): KimiAcpRunOptions {
  return {
    workDir: '/tmp/work',
    model: 'kimi-code/kimi-for-coding',
    thinking: true,
    systemPrompt: 'sys',
    surface: 'pipeline',
    ownerKind: 'pipeline',
    runId: 'run-1',
    profile: 'pipeline',
    ...over,
  };
}

function makeResponder(opts: {
  promptResult?: unknown;
  promptDelayMs?: number;
  onPrompt?: () => void;
} = {}) {
  return (method: string): unknown => {
    if (method === 'initialize') return { protocolVersion: 1 };
    if (method === 'session/new') return sessionNewResult();
    if (method === 'session/prompt') {
      opts.onPrompt?.();
      const result = opts.promptResult ?? { stopReason: 'end_turn' };
      if (opts.promptDelayMs) {
        return new Promise((resolve) => setTimeout(() => resolve(result), opts.promptDelayMs));
      }
      return result;
    }
    return {};
  };
}

beforeEach(() => {
  resolveKimiBinaryMock.mockReset();
  resolveKimiBinaryMock.mockResolvedValue('/home/u/.kimi-code/bin/kimi');
  isKimiAvailableMock.mockReset();
  isKimiAvailableMock.mockResolvedValue({
    installed: true,
    version: '0.15.0',
    authenticated: true,
    authMode: 'subscription',
  });
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('KimiAcpDriver.createRun + handle wiring', () => {
  it('one-shot exige permission explicita e aplica modo default fail-closed', async () => {
    const missingFactory = vi.fn(fakeAcpTransportFactory(new FakeAcpTransport()));
    const missingDriver = new KimiAcpDriver(missingFactory);
    await expect(missingDriver.createRun(baseOpts({ profile: 'one-shot', permission: undefined })))
      .rejects.toThrow(/permission profile fail-closed/);
    expect(missingFactory).not.toHaveBeenCalled();

    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts({
      profile: 'one-shot',
      permission: { mode: 'default', dangerouslySkipPermissions: false },
    }));
    await handle.send('resuma sem tools');
    expect(fake.requests.find((request) => request.method === 'session/set_mode')?.params)
      .toEqual({ sessionId: SESSION_ID, modeId: 'default' });
    await handle.close();
  });

  it('agent-scoped com PERM_DEFAULT_NO_BYPASS usa default e nega Write/Bash', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const handle = await new KimiAcpDriver(fakeAcpTransportFactory(fake)).createRun(baseOpts({
      profile: 'agent-scoped',
      permission: PERM_DEFAULT_NO_BYPASS,
    }));
    await handle.send('leia sem alterar');

    expect(fake.requests.find((request) => request.method === 'session/set_mode')?.params)
      .toEqual({ sessionId: SESSION_ID, modeId: 'default' });

    const options = [
      { optionId: 'approve_once', kind: 'allow_once' },
      { optionId: 'reject', kind: 'reject_once' },
    ];
    fake.pushServerRequest('req-write-default', 'session/request_permission', {
      toolCall: {
        toolCallId: 'write-default',
        rawInput: { variant: 'Write', file_path: '/tmp/work/out.txt', content: 'x' },
      },
      options,
    });
    fake.pushServerRequest('req-bash-default', 'session/request_permission', {
      toolCall: {
        toolCallId: 'bash-default',
        rawInput: { variant: 'Bash', command: 'pwd' },
      },
      options,
    });

    expect(fake.responses).toEqual([
      { id: 'req-write-default', result: { outcome: { outcome: 'selected', optionId: 'reject' } } },
      { id: 'req-bash-default', result: { outcome: { outcome: 'selected', optionId: 'reject' } } },
    ]);
    await handle.close();
  });

  it('rejeita tier explicito em K2.7 boolean-only antes do spawn', async () => {
    const factory = vi.fn(fakeAcpTransportFactory(new FakeAcpTransport()));
    const driver = new KimiAcpDriver(factory);
    await expect(driver.createRun(baseOpts({ effort: 'max' }))).rejects.toThrow(
      /reasoning booleano.*effort explicito/,
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('(a) runs initialize (clientCapabilities:{}) before any session/new', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts());

    expect(fake.requests[0]?.method).toBe('initialize');
    expect(fake.requests[0]?.params).toEqual({ protocolVersion: 1, clientCapabilities: {} });
    expect(fake.requests.some((r) => r.method === 'session/new')).toBe(false);

    await handle.close();
  });

  it('(b)+(c) session/new returns a sessionId (mcpServers passed empty for non-chat); session/prompt sent as prompt:[{type:text,text}]', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts());

    await handle.send('hello world');

    const newReq = fake.requests.find((r) => r.method === 'session/new');
    expect(newReq?.params).toEqual({ cwd: '/tmp/work', mcpServers: [] });

    const promptReq = fake.requests.find((r) => r.method === 'session/prompt');
    expect(promptReq?.params).toEqual({
      sessionId: SESSION_ID,
      prompt: [{ type: 'text', text: 'hello world' }],
    });
    const modelReq = fake.requests.find((r) => r.method === 'session/set_config_option');
    expect(modelReq?.params).toEqual({
      sessionId: SESSION_ID,
      configId: 'model',
      value: 'kimi-code/kimi-for-coding',
    });
    expect(fake.requests.indexOf(modelReq!)).toBeLessThan(fake.requests.indexOf(promptReq!));

    await handle.close();
  });

  it('classifica rejeicao estruturada de auth no session/new', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = (method) => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') {
        throw new KimiAcpJsonRpcError('unauthorized', 401);
      }
      return {};
    };
    const handle = await new KimiAcpDriver(fakeAcpTransportFactory(fake)).createRun(baseOpts());

    await expect(handle.send('go')).rejects.toBeInstanceOf(KimiAuthError);
    await handle.close();
  });

  it('(d) streaming updates map to callbacks; rawInput rides in_progress and is stashed for completed', async () => {
    const fake = new FakeAcpTransport();
    const seen: { texts: string[]; thinking: string[]; tools: string[]; completes: Array<[string, unknown]> } = {
      texts: [],
      thinking: [],
      tools: [],
      completes: [],
    };
    const cb: CliStreamCallbacks = {
      onText: (t) => seen.texts.push(t),
      onThinking: (t) => seen.thinking.push(t),
      onToolUse: (t) => seen.tools.push(t),
      onToolUseComplete: (t, i) => seen.completes.push([t, i]),
    };
    fake.responder = makeResponder({
      promptDelayMs: 10,
      onPrompt: () => {
        fake.pushNotification('session/update', {
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } },
        });
        fake.pushNotification('session/update', {
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'reasoning' } },
        });
        fake.pushNotification('session/update', {
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
        });
        fake.pushNotification('session/update', {
          update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Bash', kind: 'execute', status: 'pending' },
        });
        fake.pushNotification('session/update', {
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'in_progress', rawInput: { cmd: 'echo hi' } },
        });
        fake.pushNotification('session/update', {
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', rawOutput: 'hi' },
        });
      },
    });

    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts());
    const res = await handle.send('go', cb);

    expect(seen.texts).toEqual(['Hello ', 'world']);
    expect(res.content).toBe('Hello world'); // thinking NOT in content
    expect(seen.thinking).toEqual(['reasoning']);
    expect(seen.tools).toEqual(['Bash']);
    expect(res.toolUses).toBe(1);
    expect(seen.completes).toEqual([['Bash', { cmd: 'echo hi' }]]);

    await handle.close();
  });

  it('(e) session/request_permission server request -> auto-reply approve_always via respond', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts());

    fake.pushServerRequest('req-7', 'session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: 'tc-read', rawInput: { variant: 'Read', path: '/tmp/input.txt' } },
      options: [
        { optionId: 'approve_once', kind: 'allow_once' },
        { optionId: 'approve_always', kind: 'allow_always' },
        { optionId: 'reject', kind: 'reject_once' },
      ],
    });

    expect(fake.responses).toEqual([
      { id: 'req-7', result: { outcome: { outcome: 'selected', optionId: 'approve_always' } } },
    ]);

    await handle.close();
  });

  it('bypass aprova request NAO-traduzivel (regressao: reject antes do bypass negava leitura fora do workspace)', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts());

    fake.pushServerRequest('req-untranslatable', 'session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: 'tc-lsdir', rawInput: { variant: 'ListDir', dir: 'C:/Users/x/Projetos/LionAge' } },
      options: [
        { optionId: 'approve_once', kind: 'allow_once' },
        { optionId: 'approve_always', kind: 'allow_always' },
        { optionId: 'reject', kind: 'reject_once' },
      ],
    });

    expect(fake.responses).toEqual([
      { id: 'req-untranslatable', result: { outcome: { outcome: 'selected', optionId: 'approve_always' } } },
    ]);

    await handle.close();
  });

  it('modo guard segue rejeitando request nao-traduzivel (fail-closed preservado)', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const canUseTool = vi.fn(async () => ({ behavior: 'allow' as const }));
    const handle = await new KimiAcpDriver(fakeAcpTransportFactory(fake)).createRun(baseOpts({
      permission: {
        mode: 'default',
        dangerouslySkipPermissions: false,
        canUseTool,
      },
    }));

    fake.pushServerRequest('req-untrans-guard', 'session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: 'tc-lsdir-2', rawInput: { variant: 'ListDir', dir: '/tmp' } },
      options: [
        { optionId: 'approve_once', kind: 'allow_once' },
        { optionId: 'reject', kind: 'reject_once' },
      ],
    });

    expect(canUseTool).not.toHaveBeenCalled();
    expect(fake.responses).toEqual([
      { id: 'req-untrans-guard', result: { outcome: { outcome: 'selected', optionId: 'reject' } } },
    ]);

    await handle.close();
  });

  it('normaliza path, filePath e file_path antes de chamar o permission guard', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const canUseTool = vi.fn(async (
      _toolName: string,
      _input: Record<string, unknown>,
    ) => ({ behavior: 'allow' as const }));
    const handle = await new KimiAcpDriver(fakeAcpTransportFactory(fake)).createRun(baseOpts({
      permission: {
        mode: 'default',
        dangerouslySkipPermissions: false,
        canUseTool,
      },
    }));
    const options = [
      { optionId: 'approve_once', kind: 'allow_once' },
      { optionId: 'reject', kind: 'reject_once' },
    ];

    fake.pushServerRequest('req-write', 'session/request_permission', {
      toolCall: {
        toolCallId: 'write-1',
        rawInput: { variant: 'Write', path: '/tmp/.env', content: 'SECRET=x' },
      },
      options,
    });
    fake.pushServerRequest('req-edit', 'session/request_permission', {
      toolCall: {
        toolCallId: 'edit-1',
        rawInput: {
          variant: 'Edit',
          filePath: '/tmp/key.pem',
          old_string: 'old',
          new_string: 'new',
        },
      },
      options,
    });
    fake.pushServerRequest('req-read', 'session/request_permission', {
      toolCall: {
        toolCallId: 'read-1',
        rawInput: { variant: 'Read', file_path: '/tmp/input.txt' },
      },
      options,
    });

    await vi.waitFor(() => expect(canUseTool).toHaveBeenCalledTimes(3));
    expect(canUseTool.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ path: '/tmp/.env', file_path: '/tmp/.env' }),
      expect.objectContaining({ filePath: '/tmp/key.pem', file_path: '/tmp/key.pem' }),
      expect.objectContaining({ file_path: '/tmp/input.txt' }),
    ]);
    await handle.close();
  });

  it('nega request incompleta mesmo em bypass', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const handle = await new KimiAcpDriver(fakeAcpTransportFactory(fake)).createRun(baseOpts());
    fake.pushServerRequest('req-invalid', 'session/request_permission', {
      options: [
        { optionId: 'approve_always', kind: 'allow_always' },
        { optionId: 'reject', kind: 'reject_once' },
      ],
    });
    expect(fake.responses).toEqual([
      { id: 'req-invalid', result: { outcome: { outcome: 'selected', optionId: 'reject' } } },
    ]);
    await handle.close();
  });

  it('nega aliases de caminho conflitantes, vazios ou nao-string antes do permission guard', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const canUseTool = vi.fn(async () => ({ behavior: 'allow' as const }));
    const handle = await new KimiAcpDriver(fakeAcpTransportFactory(fake)).createRun(baseOpts({
      permission: {
        mode: 'default',
        dangerouslySkipPermissions: false,
        canUseTool,
      },
    }));
    fake.pushServerRequest('req-conflict', 'session/request_permission', {
      toolCall: {
        toolCallId: 'write-conflict',
        rawInput: {
          variant: 'Write',
          file_path: '/tmp/allowed.txt',
          path: '/tmp/.env',
          content: 'SECRET=x',
        },
      },
      options: [
        { optionId: 'approve_once', kind: 'allow_once' },
        { optionId: 'reject', kind: 'reject_once' },
      ],
    });
    const options = [
      { optionId: 'approve_once', kind: 'allow_once' },
      { optionId: 'reject', kind: 'reject_once' },
    ];
    fake.pushServerRequest('req-empty', 'session/request_permission', {
      toolCall: {
        toolCallId: 'write-empty',
        rawInput: { variant: 'Write', file_path: '/tmp/allowed.txt', path: '', content: 'x' },
      },
      options,
    });
    fake.pushServerRequest('req-whitespace', 'session/request_permission', {
      toolCall: {
        toolCallId: 'write-whitespace',
        rawInput: { variant: 'Write', file_path: '/tmp/allowed.txt', filePath: '   ', content: 'x' },
      },
      options,
    });
    fake.pushServerRequest('req-non-string', 'session/request_permission', {
      toolCall: {
        toolCallId: 'write-non-string',
        rawInput: { variant: 'Write', file_path: '/tmp/allowed.txt', path: 42, content: 'x' },
      },
      options,
    });

    expect(canUseTool).not.toHaveBeenCalled();
    expect(fake.responses).toEqual([
      { id: 'req-conflict', result: { outcome: { outcome: 'selected', optionId: 'reject' } } },
      { id: 'req-empty', result: { outcome: { outcome: 'selected', optionId: 'reject' } } },
      { id: 'req-whitespace', result: { outcome: { outcome: 'selected', optionId: 'reject' } } },
      { id: 'req-non-string', result: { outcome: { outcome: 'selected', optionId: 'reject' } } },
    ]);
    await handle.close();
  });

  it('(e2) session/request_permission for AgentSwarm is DENIED (native swarm hangs over ACP); other tools approved', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts());

    fake.pushServerRequest('req-swarm', 'session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: 'tc-sw', title: 'AgentSwarm' },
      options: [
        { optionId: 'approve_once', kind: 'allow_once' },
        { optionId: 'approve_always', kind: 'allow_always' },
        { optionId: 'reject', kind: 'reject_once' },
      ],
    });
    fake.pushServerRequest('req-bash', 'session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: 'tc-bash', title: 'Bash', rawInput: { variant: 'Bash', command: 'pwd' } },
      options: [
        { optionId: 'approve_always', kind: 'allow_always' },
        { optionId: 'reject', kind: 'reject_once' },
      ],
    });

    expect(fake.responses).toEqual([
      { id: 'req-swarm', result: { outcome: { outcome: 'selected', optionId: 'reject' } } },
      { id: 'req-bash', result: { outcome: { outcome: 'selected', optionId: 'approve_always' } } },
    ]);

    await handle.close();
  });

  it('(e3) sets session mode to yolo right after session/new (autonomous, no manual pause)', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts());
    await handle.send('oi'); // session/new is lazy: the first turn triggers it + the mode set

    const idxNew = fake.requests.findIndex((r) => r.method === 'session/new');
    const idxMode = fake.requests.findIndex((r) => r.method === 'session/set_mode');
    expect(idxNew).toBeGreaterThanOrEqual(0);
    expect(idxMode).toBeGreaterThan(idxNew); // mode is set AFTER session/new
    expect(fake.requests[idxMode]?.params).toEqual({ sessionId: SESSION_ID, modeId: 'yolo' });

    await handle.close();
  });

  it('(e4) session/set_mode failure bloqueia o turno em vez de seguir fail-open', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = (method: string) => {
      if (method === 'session/set_mode') throw new Error('mode not supported by this kimi version');
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return sessionNewResult();
      if (method === 'session/prompt') return { stopReason: 'end_turn' };
      return {};
    };
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts());
    await expect(handle.send('go')).rejects.toThrow(/nao aplicou o permission mode/i);
    expect(fake.requests.some((request) => request.method === 'session/prompt')).toBe(false);
    await handle.close();
  });

  it('falha fechado quando session/set_config_option confirma outro modelo', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = (method: string) => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return sessionNewResult();
      if (method === 'session/set_config_option') return { currentValue: 'kimi-code/outro' };
      return {};
    };
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts());
    await expect(handle.send('go')).rejects.toThrow(/modelo inesperado/i);
    expect(fake.requests.some((request) => request.method === 'session/prompt')).toBe(false);
    await handle.close();
  });

  it('falha antes do prompt quando session/new nao atesta model/thinking/mode', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = (method: string) => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return { sessionId: SESSION_ID, configOptions: [] };
      return {};
    };
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts());
    await expect(handle.send('go')).rejects.toThrow(/nao anunciou o modelo/i);
    expect(fake.requests.some((request) => request.method === 'session/prompt')).toBe(false);
    await handle.close();
  });

  it('thinking em ENUM de esforco (CLI novo): seta o tier configurado via set_config_option', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = (method: string, params?: unknown) => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') {
        return {
          sessionId: SESSION_ID,
          configOptions: [
            {
              id: 'model',
              currentValue: 'kimi-code/k3',
              options: [{ value: 'kimi-code/k3' }],
            },
            {
              id: 'thinking',
              currentValue: 'high',
              options: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
            },
            {
              id: 'mode',
              currentValue: 'default',
              options: [{ value: 'default' }, { value: 'yolo' }],
            },
          ],
        };
      }
      if (method === 'session/set_config_option') {
        const p = params as { value?: string } | undefined;
        return { currentValue: p?.value };
      }
      if (method === 'session/prompt') return { stopReason: 'end_turn' };
      return {};
    };
    const handle = await new KimiAcpDriver(fakeAcpTransportFactory(fake)).createRun(baseOpts({
      model: 'kimi-code/k3',
      effort: 'max',
    }));

    await expect(handle.send('go')).resolves.toMatchObject({ status: 'finished' });
    const thinkingSet = fake.requests.find(
      (request) =>
        request.method === 'session/set_config_option' &&
        (request.params as { configId?: string })?.configId === 'thinking',
    );
    expect((thinkingSet?.params as { value?: string })?.value).toBe('max');
    await handle.close();
  });

  it('thinking ENUM sem o tier pedido cai no melhor disponivel (nunca derruba por formato)', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = (method: string, params?: unknown) => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') {
        return {
          sessionId: SESSION_ID,
          configOptions: [
            { id: 'model', currentValue: 'kimi-code/k3', options: [{ value: 'kimi-code/k3' }] },
            { id: 'thinking', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] },
            { id: 'mode', currentValue: 'default', options: [{ value: 'default' }, { value: 'yolo' }] },
          ],
        };
      }
      if (method === 'session/set_config_option') {
        const p = params as { value?: string } | undefined;
        return { currentValue: p?.value };
      }
      if (method === 'session/prompt') return { stopReason: 'end_turn' };
      return {};
    };
    const handle = await new KimiAcpDriver(fakeAcpTransportFactory(fake)).createRun(baseOpts({
      model: 'kimi-code/k3',
      effort: 'max',
    }));

    await expect(handle.send('go')).resolves.toMatchObject({ status: 'finished' });
    const thinkingSet = fake.requests.find(
      (request) =>
        request.method === 'session/set_config_option' &&
        (request.params as { configId?: string })?.configId === 'thinking',
    );
    expect((thinkingSet?.params as { value?: string })?.value).toBe('high');
    await handle.close();
  });

  it('usa session/new e set_config_option como autoridade do modelo', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const handle = await new KimiAcpDriver(fakeAcpTransportFactory(fake)).createRun(baseOpts({
      model: 'kimi-code/k3',
      effort: 'high',
    }));

    await expect(handle.send('go')).resolves.toMatchObject({ status: 'finished' });
    expect(fake.requests.some((request) => request.method === 'session/prompt')).toBe(true);
    await handle.close();
  });

  it('policy guard traduz Read e nega input desconhecido sem promover a bypass', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const canUseTool = vi.fn(async () => ({ behavior: 'allow' as const }));
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts({
      permission: {
        mode: 'default',
        dangerouslySkipPermissions: false,
        canUseTool,
      },
    }));
    fake.pushServerRequest('req-read', 'session/request_permission', {
      toolCall: {
        toolCallId: 'tc-read',
        title: 'Read',
        rawInput: { variant: 'Read', file_path: '/tmp/work/a.ts' },
      },
      options: [
        { optionId: 'allow-once', kind: 'allow_once' },
        { optionId: 'allow-always', kind: 'allow_always' },
        { optionId: 'reject-once', kind: 'reject_once' },
      ],
    });
    await vi.waitFor(() => expect(fake.responses).toHaveLength(1));
    expect(canUseTool).toHaveBeenCalledWith(
      'Read',
      { file_path: '/tmp/work/a.ts' },
      expect.objectContaining({ toolUseID: 'tc-read' }),
    );
    expect(fake.responses[0]).toEqual({
      id: 'req-read',
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    });

    fake.pushServerRequest('req-unknown', 'session/request_permission', {
      toolCall: { toolCallId: 'tc-x', title: 'Unknown', rawInput: { variant: 'RootShell' } },
      options: [{ optionId: 'reject-once', kind: 'reject_once' }],
    });
    expect(fake.responses[1]).toEqual({
      id: 'req-unknown',
      result: { outcome: { outcome: 'selected', optionId: 'reject-once' } },
    });
    expect(canUseTool).toHaveBeenCalledTimes(1);
    await handle.close();
  });

  it('policy guard nega quando o wire oferece apenas allow_always e reject', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const canUseTool = vi.fn(async () => ({ behavior: 'allow' as const }));
    const handle = await new KimiAcpDriver(fakeAcpTransportFactory(fake)).createRun(baseOpts({
      permission: {
        mode: 'default',
        dangerouslySkipPermissions: false,
        canUseTool,
      },
    }));
    const options = [
      { optionId: 'allow-always', kind: 'allow_always' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ];

    for (const id of ['req-first', 'req-second']) {
      fake.pushServerRequest(id, 'session/request_permission', {
        toolCall: {
          toolCallId: `tool-${id}`,
          rawInput: { variant: 'Read', file_path: '/tmp/work/a.ts' },
        },
        options,
      });
    }

    await vi.waitFor(() => expect(fake.responses).toHaveLength(2));
    expect(canUseTool).toHaveBeenCalledTimes(2);
    expect(fake.responses).toEqual([
      { id: 'req-first', result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
      { id: 'req-second', result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
    ]);
    expect(fake.responses.some(({ result }) => JSON.stringify(result).includes('allow-always'))).toBe(false);
    await handle.close();
  });

  describe('contrato CanUseTool do Agent SDK 0.3 (D11)', () => {
    const PERMISSION_OPTIONS = [
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'allow-always', kind: 'allow_always' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ];

    async function runPermissionRequest(
      canUseTool: NonNullable<NonNullable<KimiAcpRunOptions['permission']>['canUseTool']>,
      requestId: string,
      toolCallId: string,
    ) {
      const fake = new FakeAcpTransport();
      fake.responder = makeResponder();
      const handle = await new KimiAcpDriver(fakeAcpTransportFactory(fake)).createRun(baseOpts({
        permission: { mode: 'default', dangerouslySkipPermissions: false, canUseTool },
      }));
      fake.pushServerRequest(requestId, 'session/request_permission', {
        toolCall: {
          toolCallId,
          title: 'Write',
          rawInput: { variant: 'Write', file_path: '/tmp/work/a.ts', content: 'x' },
        },
        options: PERMISSION_OPTIONS,
      });
      await vi.waitFor(() => expect(fake.responses).toHaveLength(1));
      await handle.close();
      return fake;
    }

    it('(a) o guard recebe requestId string nao-vazia e toolUseID', async () => {
      const canUseTool = vi.fn(async () => ({ behavior: 'allow' as const }));
      const fake = await runPermissionRequest(canUseTool, 'req-d11-a', 'tc-a');
      expect(canUseTool).toHaveBeenCalledTimes(1);
      expect(canUseTool).toHaveBeenCalledWith(
        'Write',
        { file_path: '/tmp/work/a.ts', content: 'x' },
        expect.objectContaining({ toolUseID: 'tc-a', requestId: expect.any(String) }),
      );
      const options = (canUseTool.mock.calls[0] as unknown[])[2] as { requestId: string };
      expect(options.requestId.length).toBeGreaterThan(0);
      expect(fake.responses).toEqual([
        { id: 'req-d11-a', result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } },
      ]);
    });

    it('(b) guard resolvendo null NEGA fail-closed (reject, nunca allow)', async () => {
      const canUseTool = vi.fn(async () => null);
      const fake = await runPermissionRequest(canUseTool, 'req-d11-b', 'tc-b');
      expect(canUseTool).toHaveBeenCalledTimes(1);
      expect(fake.responses).toEqual([
        { id: 'req-d11-b', result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
      ]);
    });

    it('(c) deny continua negando', async () => {
      const canUseTool = vi.fn(async () => ({ behavior: 'deny' as const, message: 'vetado' }));
      const fake = await runPermissionRequest(canUseTool, 'req-d11-c', 'tc-c');
      expect(canUseTool).toHaveBeenCalledTimes(1);
      expect(fake.responses).toEqual([
        { id: 'req-d11-c', result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
      ]);
    });
  });

  it('resolve effort e env antes do spawn sem vazar canarios entre runs', async () => {
    const configs: AcpSpawnConfig[] = [];
    const fakes: FakeAcpTransport[] = [];
    const factory = async (config: AcpSpawnConfig) => {
      configs.push(config);
      const fake = new FakeAcpTransport();
      fake.responder = makeResponder();
      fakes.push(fake);
      return fake;
    };
    const previous = process.env['LION_KIMI_SECRET_CANARY'];
    process.env['LION_KIMI_SECRET_CANARY'] = 'must-not-leak';
    try {
      const driver = new KimiAcpDriver(factory);
      const first = await driver.createRun(baseOpts({
        runId: 'k3-low',
        model: 'kimi-code/k3',
        effort: 'low',
        env: {
          PATH: '/safe/bin',
          AWS_SECRET_ACCESS_KEY: 'must-not-leak',
          KIMI_MODEL_THINKING_EFFORT: 'max',
        },
      }));
      const second = await driver.createRun(baseOpts({ runId: 'k27' }));
      expect(configs[0].env['PATH']).toBe('/safe/bin');
      expect(configs[0].env['KIMI_MODEL_THINKING_EFFORT']).toBe('low');
      expect(configs[0].env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
      expect(configs[0].env['LION_KIMI_SECRET_CANARY']).toBeUndefined();
      expect(configs[1].env['KIMI_MODEL_THINKING_EFFORT']).toBeUndefined();
      expect(configs[1].env['KIMI_SHARE_DIR']).toMatch(/[\\/]\.kimi-code$/);
      await first.close();
      await second.close();
    } finally {
      if (previous === undefined) delete process.env['LION_KIMI_SECRET_CANARY'];
      else process.env['LION_KIMI_SECRET_CANARY'] = previous;
    }
  });

  it('(f) end_turn resolves status:finished with zero usage + accumulated content + tool count', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder({
      promptDelayMs: 5,
      onPrompt: () => {
        fake.pushNotification('session/update', {
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
        });
        fake.pushNotification('session/update', {
          update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Read', status: 'pending' },
        });
      },
    });
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts());
    const res = await handle.send('go');

    expect(res.status).toBe('finished');
    expect(res.content).toBe('done');
    expect(res.toolUses).toBe(1);
    expect(res.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    await handle.close();
  });

  it('(g) abort aguarda o terminal, envia session/cancel e resolve status:cancelled', async () => {
    const fake = new FakeAcpTransport();
    const ac = new AbortController();
    fake.responder = makeResponder({
      promptResult: { stopReason: 'cancelled' },
      promptDelayMs: 20,
      onPrompt: () => {
        setTimeout(() => ac.abort(), 5);
      },
    });
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts());
    const res = await handle.send('go', undefined, ac.signal);

    expect(res.status).toBe('cancelled');
    const cancel = fake.notifications.find((n) => n.method === 'session/cancel');
    expect(cancel).toEqual({ method: 'session/cancel', params: { sessionId: SESSION_ID } });
    expect(fake.requests.some((r) => r.method === 'session/cancel')).toBe(false);
    expect(fake.responses).toEqual([]);

    await handle.close();
  });

  it('rejeita e mata o processo quando abort recebe terminal nao-cancelado', async () => {
    const fake = new FakeAcpTransport();
    const ac = new AbortController();
    fake.responder = makeResponder({
      promptResult: { stopReason: 'end_turn' },
      promptDelayMs: 20,
      onPrompt: () => setTimeout(() => ac.abort(), 5),
    });
    const handle = await new KimiAcpDriver(fakeAcpTransportFactory(fake)).createRun(baseOpts());

    await expect(handle.send('go', undefined, ac.signal)).rejects.toThrow(/cancel was not confirmed/);
    expect(fake.killed).toContain('cancel-terminal-mismatch');
    expect(fake.notifications.filter((item) => item.method === 'session/cancel')).toHaveLength(1);
    await handle.close();
  });

  it('mata o processo e rejeita quando o CLI ignora cancel alem do grace period', async () => {
    const fake = new FakeAcpTransport();
    const ac = new AbortController();
    fake.responder = makeResponder({
      promptDelayMs: 1000,
      onPrompt: () => setTimeout(() => ac.abort(), 5),
    });
    const handle = await new KimiAcpDriver(fakeAcpTransportFactory(fake)).createRun(baseOpts({
      cancelGraceMs: 10,
    }));

    await expect(handle.send('go', undefined, ac.signal)).rejects.toThrow(/cancel grace \(10ms\)/);
    expect(fake.killed).toContain('cancel-grace-timeout');
    await handle.close();
  });

  it('(h) transport onError (process exit) -> send() REJECTS KimiUnavailableError', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder({
      promptDelayMs: 1000,
      onPrompt: () => {
        setTimeout(() => fake.triggerError(new Error('kimi acp exited (code=1)')), 5);
      },
    });
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts());

    await expect(handle.send('go')).rejects.toBeInstanceOf(KimiUnavailableError);

    await handle.close();
  });

  it('(i) KI-3 idle backstop: silent turn -> session/cancel NOTIFICATION + REJECTS; timers clear on normal completion', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder({
      promptDelayMs: 5000, // never resolves within the test window
      onPrompt: () => {
        fake.pushNotification('session/update', {
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } },
        });
      },
    });
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts({ idleTimeoutMs: 30 }));

    await expect(handle.send('go')).rejects.toBeInstanceOf(KimiUnavailableError);
    const cancel = fake.notifications.find((n) => n.method === 'session/cancel');
    expect(cancel).toEqual({ method: 'session/cancel', params: { sessionId: SESSION_ID } });
    expect(fake.requests.some((r) => r.method === 'session/cancel')).toBe(false);

    await handle.close();

    const fake2 = new FakeAcpTransport();
    fake2.responder = makeResponder();
    const driver2 = new KimiAcpDriver(fakeAcpTransportFactory(fake2));
    const handle2 = await driver2.createRun(baseOpts({ idleTimeoutMs: 50 }));
    const res = await handle2.send('go');
    expect(res.status).toBe('finished');
    await new Promise((r) => setTimeout(r, 80));
    expect(fake2.notifications.some((n) => n.method === 'session/cancel')).toBe(false);
    await handle2.close();
  });

  it('(k) error notification willRetry:false REJECTS; willRetry:true keeps waiting until a terminal signal', async () => {
    const fakeA = new FakeAcpTransport();
    fakeA.responder = makeResponder({
      promptDelayMs: 5000,
      onPrompt: () => {
        fakeA.pushNotification('error', { error: { code: 'forced_failure' }, willRetry: false });
      },
    });
    const driverA = new KimiAcpDriver(fakeAcpTransportFactory(fakeA));
    const handleA = await driverA.createRun(baseOpts());
    await expect(handleA.send('go')).rejects.toBeInstanceOf(KimiUnavailableError);
    await handleA.close();

    const fakeB = new FakeAcpTransport();
    let resolvePrompt: ((v: unknown) => void) | null = null;
    fakeB.responder = (method: string): unknown => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return sessionNewResult();
      if (method === 'session/prompt') {
        setTimeout(() => {
          fakeB.pushNotification('error', { error: { code: 'transient' }, willRetry: true });
        }, 5);
        return new Promise((resolve) => {
          resolvePrompt = resolve;
          setTimeout(() => resolvePrompt?.({ stopReason: 'end_turn' }), 30);
        });
      }
      return {};
    };
    const driverB = new KimiAcpDriver(fakeAcpTransportFactory(fakeB));
    const handleB = await driverB.createRun(baseOpts({ idleTimeoutMs: 5000 }));
    const res = await handleB.send('go'); // resolves because willRetry:true did NOT settle it
    expect(res.status).toBe('finished');
    await handleB.close();
  });

  it('(l) failure stopReason -> send() REJECTS (not resolve-as-success)', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder({ promptResult: { stopReason: 'refusal' } });
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts());

    await expect(handle.send('go')).rejects.toBeInstanceOf(KimiUnavailableError);

    await handle.close();
  });

  it('(j) close() resolves, kills the transport, and a late session/update after close fires no callback', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const onText = vi.fn();
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts());
    await handle.send('go', { onText });
    onText.mockClear();

    await expect(handle.close()).resolves.toBeUndefined();
    expect(fake.killed.length).toBeGreaterThan(0);

    fake.pushNotification('session/update', {
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } },
    });
    expect(onText).not.toHaveBeenCalled();
  });

  it('close e shutdown concorrentes compartilham o teardown em voo', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    let releaseWait!: (closed: boolean) => void;
    const waitClosed = vi.fn(() => new Promise<boolean>((resolve) => {
      releaseWait = resolve;
    }));
    fake.waitClosed = waitClosed;
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(baseOpts());

    const firstClose = handle.close();
    const secondClose = handle.close();
    expect(secondClose).toBe(firstClose);
    await vi.waitFor(() => expect(waitClosed).toHaveBeenCalledTimes(1));

    const firstShutdown = driver.shutdown();
    const secondShutdown = driver.shutdown();
    expect(secondShutdown).toBe(firstShutdown);
    await expect(driver.createRun(baseOpts())).rejects.toThrow(/shutting down/i);
    let shutdownSettled = false;
    void firstShutdown.then(() => { shutdownSettled = true; });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    releaseWait(true);
    await Promise.all([firstClose, secondClose, firstShutdown, secondShutdown]);
    expect(waitClosed).toHaveBeenCalledTimes(1);
  });

  it('close assenta prompt e session/new pendentes sem esperar os backstops', async () => {
    const promptFake = new FakeAcpTransport();
    promptFake.responder = (method: string): unknown => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return sessionNewResult();
      if (method === 'session/prompt') return new Promise(() => undefined);
      return {};
    };
    const promptHandle = await new KimiAcpDriver(fakeAcpTransportFactory(promptFake)).createRun(baseOpts());
    const sending = promptHandle.send('pendente');
    const sendingRejected = expect(sending).rejects.toThrow(/closed during an active turn/i);
    await vi.waitFor(() => expect(promptFake.requests.some(({ method }) => method === 'session/prompt')).toBe(true));
    await promptHandle.close();
    await sendingRejected;

    const sessionFake = new FakeAcpTransport();
    sessionFake.responder = (method: string): unknown => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return new Promise(() => undefined);
      return {};
    };
    const sessionHandle = await new KimiAcpDriver(fakeAcpTransportFactory(sessionFake)).createRun(baseOpts());
    const creatingSession = sessionHandle.send('pendente');
    const sessionRejected = expect(creatingSession).rejects.toThrow(/closed during an active request/i);
    await vi.waitFor(() => expect(sessionFake.requests.some(({ method }) => method === 'session/new')).toBe(true));
    await sessionHandle.close();
    await sessionRejected;
  });

  it('timeout/rejeicao do handshake fecha o child criado', async () => {
    const timeoutFake = new FakeAcpTransport();
    timeoutFake.responder = () => new Promise(() => undefined);
    const timeoutDriver = new KimiAcpDriver(fakeAcpTransportFactory(timeoutFake));
    await expect(timeoutDriver.createRun(baseOpts({ handshakeTimeoutMs: 5 }))).rejects.toThrow(/timed out/i);
    expect(timeoutFake.killed.length).toBeGreaterThan(0);

    const rejectedFake = new FakeAcpTransport();
    rejectedFake.responder = () => Promise.reject(new Error('initialize rejected'));
    const rejectedDriver = new KimiAcpDriver(fakeAcpTransportFactory(rejectedFake));
    await expect(rejectedDriver.createRun(baseOpts())).rejects.toThrow(/initialize rejected/i);
    expect(rejectedFake.killed.length).toBeGreaterThan(0);
  });
});

describe('getKimiAcpDriver singleton (AC-S5.2)', () => {
  it('returns the SAME instance across calls', () => {
    expect(getKimiAcpDriver()).toBe(getKimiAcpDriver());
  });

  it('compartilha shutdown concorrente, bloqueia create e recria o singleton depois', async () => {
    const current = getKimiAcpDriver();
    let releaseShutdown!: () => void;
    const shutdownSpy = vi.spyOn(KimiAcpDriver.prototype, 'shutdown').mockImplementation(
      () => new Promise<void>((resolve) => { releaseShutdown = resolve; }),
    );

    const first = shutdownKimiRuntime();
    const second = shutdownKimiRuntime();
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
    expect(() => getKimiAcpDriver()).toThrow(/shutting down/i);
    releaseShutdown();
    await Promise.all([first, second]);
    shutdownSpy.mockRestore();

    const replacement = getKimiAcpDriver();
    expect(replacement).not.toBe(current);
    await shutdownKimiRuntime();
  });
});

describe('createRun runs KI-2 reaping BEFORE register (AC-S5.3)', () => {
  it('colisao forcada nao desregistra o handle antigo e shutdown ainda o encontra', async () => {
    const transports: FakeAcpTransport[] = [];
    const driver = new KimiAcpDriver(async () => {
      const fake = new FakeAcpTransport();
      fake.responder = makeResponder();
      transports.push(fake);
      return fake;
    });
    const opts = baseOpts({
      surface: 'pipeline',
      ownerKind: 'pipeline',
      projectId: 'p-collision',
      agentId: 'coder',
      runId: 'forced-collision',
    });

    const original = await driver.createRun(opts) as KimiAcpRunHandle;
    await expect(driver.createRun(opts)).rejects.toThrow(/duplicate live Kimi ACP run identity/i);

    expect(driver._registrySizeForTests()).toBe(1);
    expect(original.status).toBe('idle');
    await driver.shutdown();
    expect(original.status).toBe('closed');
    expect(driver._registrySizeForTests()).toBe(0);
    expect(transports).toHaveLength(2);
    expect(transports.every((transport) => transport.killed.length > 0)).toBe(true);
  });

  it('mantem pai e filho da mesma agent separados; close do filho preserva o pai e shutdown fecha o restante', async () => {
    const transports: FakeAcpTransport[] = [];
    const driver = new KimiAcpDriver(async () => {
      const fake = new FakeAcpTransport();
      fake.responder = makeResponder();
      transports.push(fake);
      return fake;
    });
    const common = {
      surface: 'pipeline' as const,
      ownerKind: 'pipeline' as const,
      projectId: 'p1',
      agentId: 'coder',
    };
    const parent = await driver.createRun(baseOpts({ ...common, runId: 'exec-parent' }));
    const child = await driver.createRun(baseOpts({ ...common, runId: 'exec-child' }));

    expect(driver._registrySizeForTests()).toBe(2);
    await child.close();
    expect(driver._registrySizeForTests()).toBe(1);
    expect((parent as KimiAcpRunHandle).status).not.toBe('closed');

    await driver.shutdown();
    expect(driver._registrySizeForTests()).toBe(0);
    expect((parent as KimiAcpRunHandle).status).toBe('closed');
    expect((child as KimiAcpRunHandle).status).toBe('closed');
    expect(transports.every((transport) => transport.killed.length > 0)).toBe(true);
  });

  it('reaps the prior same-scope idle handle before registering the new one', async () => {
    const tf = async () => {
      const fake = new FakeAcpTransport();
      fake.responder = makeResponder();
      return fake;
    };
    const driver = new KimiAcpDriver(tf);

    const sameScope = baseOpts({
      surface: 'pipeline',
      ownerKind: 'pipeline',
      projectId: 'p1',
      ownerId: 'o1',
      runId: 'run-A',
    });
    const handleA = (await driver.createRun(sameScope)) as KimiAcpRunHandle;
    await handleA.send('go');
    expect(handleA.status).toBe('completed');

    const handleB = (await driver.createRun(
      baseOpts({
        surface: 'pipeline',
        ownerKind: 'pipeline',
        projectId: 'p1',
        ownerId: 'o1',
        runId: 'run-B',
      }),
    )) as KimiAcpRunHandle;

    await new Promise((r) => setTimeout(r, 0));
    expect(handleA.status).toBe('closed');
    expect(handleB.status).toBe('idle');

    await handleB.close();
    await driver.shutdown();
  });

  it('createRun aborts before start when the signal is already aborted', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = makeResponder();
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const ac = new AbortController();
    ac.abort();
    await expect(driver.createRun(baseOpts({ abortSignal: ac.signal }))).rejects.toBeInstanceOf(
      KimiUnavailableError,
    );
  });

  it('createRun throws when the binary is not resolvable', async () => {
    resolveKimiBinaryMock.mockResolvedValueOnce(null);
    const fake = new FakeAcpTransport();
    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    await expect(driver.createRun(baseOpts())).rejects.toBeInstanceOf(KimiUnavailableError);
  });
});

describe('isAvailable (contract-mandated delegate)', () => {
  it('maps isKimiAvailable() onto the contract shape (version null -> undefined)', async () => {
    isKimiAvailableMock.mockResolvedValueOnce({
      installed: true,
      version: null,
      authenticated: true,
      authMode: 'subscription',
    });
    const driver = new KimiAcpDriver();
    const a = await driver.isAvailable();
    expect(a).toEqual({
      installed: true,
      authenticated: true,
      authMode: 'subscription',
      version: undefined,
    });
  });
});

describe('KimiAcpDriver.shutdown() reaps registered MCP bridges (AC-B3.4 backstop)', () => {
  function fakeBridge(bridgeId: string, stop: () => Promise<void>): KimiMcpBridge {
    const url = 'http://127.0.0.1:54000/mcp';
    const mcpServerEntry: KimiAcpMcpServerEntry = {
      id: 'lionbridge',
      name: 'LionClaw Bridge',
      type: 'http',
      url,
      headers: [{ name: 'Authorization', value: 'Bearer tok-' + bridgeId }],
      env: [],
    };
    return { url, token: 'tok-' + bridgeId, mcpServerEntry, bridgeId, stop };
  }

  it('a registered live bridge is stopped by driver.shutdown() (no real kimi process)', async () => {
    const registry = getKimiBridgeRegistry();
    await registry.stopAll(); // clean baseline (singleton may carry bridges from earlier suites)

    const stop = vi.fn(async () => undefined);
    registry.register(fakeBridge('b-shutdown', stop));
    expect(registry.size()).toBe(1);

    const driver = new KimiAcpDriver(fakeAcpTransportFactory(new FakeAcpTransport()));
    await driver.shutdown();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);
  });
});
