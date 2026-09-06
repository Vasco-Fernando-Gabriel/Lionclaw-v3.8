import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { buildGrokChildEnv } from '../../agent-runtime/grok-availability';
import { GrokAcpDriver, buildGrokAgentArgv } from '../acp-driver';
import { buildLinuxSandboxPtyInvocation } from '../acp-transport';
import { GrokAuthError, GrokBackendError, GrokJsonRpcError, GrokProcessError } from '../errors';
import { FakeGrokAcpTransport, fakeGrokTransportFactory } from './fake-acp-transport';

function normalScript() {
  return new FakeGrokAcpTransport({
    onRequest: async (method, _params, transport) => {
      if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
      if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
      if (method === 'session/new') return { sessionId: 's1', models: { currentModelId: 'grok-4.5' } };
      if (method === 'session/prompt') {
        transport.emitNotification('session/update', {
          update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'r' } },
        });
        transport.emitNotification('session/update', {
          update: { sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } },
        });
        return {
          stopReason: 'end_turn',
          _meta: {
            modelId: 'grok-4.5',
            usage: { inputTokens: 10, outputTokens: 2, reasoningTokens: 1, modelCalls: 1, costUsdTicks: 100 },
          },
        };
      }
      throw new Error(`unexpected ${method}`);
    },
  });
}

describe('Grok ACP driver', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lion-grok-driver-'));
    process.env['LIONCLAW_TEST_HOME'] = home;
  });

  afterEach(() => {
    delete process.env['LIONCLAW_TEST_HOME'];
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('mantem ordem global -> agent flags -> stdio', () => {
    expect(buildGrokAgentArgv({
      model: 'grok-4.5',
      effort: 'low',
      sandbox: 'workspace',
      permission: { mode: 'bypassPermissions', dangerouslySkipPermissions: true },
    })).toEqual([
      '--no-auto-update', '--no-subagents', '--no-memory', '--sandbox', 'workspace',
      'agent', '--no-leader', '--model', 'grok-4.5', '--effort', 'low', '--always-approve', 'stdio',
    ]);
  });

  it('monta o PTY Linux sem echo e escapa binario/args antes do shell do script', () => {
    const invocation = buildLinuxSandboxPtyInvocation({
      binary: "/tmp/grok';touch /tmp/injected;'",
      args: ['--sandbox', 'profile with spaces', 'agent', 'stdio'],
      cwd: home,
      env: {},
    }, '/usr/bin/script');
    expect(invocation.executable).toBe('/usr/bin/script');
    expect(invocation.args).toContain('never');
    const command = invocation.args[invocation.args.indexOf('--command') + 1];
    expect(command).toContain("'\\''");
    expect(command).toContain("'profile with spaces'");
    expect(command?.endsWith(' 2>/dev/null')).toBe(true);
    expect(command?.startsWith('stty raw -echo && exec ')).toBe(true);
  });

  it('autentica somente cached_token, transmite stream e preserva usage', async () => {
    const transport = normalScript();
    const captured: Array<{ args: string[]; cwd: string; env: Record<string, string> }> = [];
    const attestSession = vi.fn(async () => {
      expect(transport.requests.some(({ method }) => method === 'session/new')).toBe(true);
      expect(transport.requests.some(({ method }) => method === 'session/prompt')).toBe(false);
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport, (config) => {
      captured.push({ args: config.args, cwd: config.cwd, env: config.env });
    }));
    const onText = vi.fn();
    const onThinking = vi.fn();
    const handle = await driver.createRun({
      workDir: home,
      processCwd: path.join(home, 'neutral'),
      model: 'grok-4.5',
      effort: 'high',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
      attestSession,
    });
    const response = await handle.send('ola', { onText, onThinking });
    expect(response.content).toBe('ok');
    expect(response.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
    expect(onText).toHaveBeenCalledWith('ok');
    expect(onThinking).toHaveBeenCalledWith('r');
    expect(transport.requests[1]).toEqual({
      method: 'authenticate',
      params: { methodId: 'cached_token', _meta: { headless: true } },
    });
    expect(captured[0].env).not.toHaveProperty('XAI_API_KEY');
    expect(captured[0].cwd).toBe(path.join(home, 'neutral'));
    expect(transport.requests[2]).toEqual({
      method: 'session/new',
      params: { cwd: home, mcpServers: [] },
    });
    expect(attestSession).toHaveBeenCalledWith('s1');
    await handle.close();
    expect(transport.killed).toBe(true);
  });

  it('mata e aguarda o child quando initialize estoura deadline ou e abortado', async () => {
    const timed = new FakeGrokAcpTransport({
      onRequest: async () => new Promise(() => undefined),
    });
    const timedDriver = new GrokAcpDriver(fakeGrokTransportFactory(timed));
    await expect(timedDriver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
      handshakeTimeoutMs: 5,
    })).rejects.toThrow(/timed out/);
    expect(timed.killed).toBe(true);

    const aborted = new FakeGrokAcpTransport({
      onRequest: async () => new Promise(() => undefined),
    });
    const controller = new AbortController();
    const abortedDriver = new GrokAcpDriver(fakeGrokTransportFactory(aborted));
    const starting = abortedDriver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
      abortSignal: controller.signal,
    });
    await vi.waitFor(() => expect(aborted.requests).toHaveLength(1));
    controller.abort();
    await expect(starting).rejects.toThrow(/aborted/);
    expect(aborted.killed).toBe(true);
  });

  it('compartilha o teardown concorrente e bloqueia novos runs ate o child fechar', async () => {
    const transport = normalScript();
    let releaseWait!: (closed: boolean) => void;
    const waitClosed = vi.fn(() => new Promise<boolean>((resolve) => {
      releaseWait = resolve;
    }));
    transport.waitClosed = waitClosed;
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
    });

    const first = driver.shutdown();
    const second = driver.shutdown();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(waitClosed).toHaveBeenCalledTimes(1));
    await expect(driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
    })).rejects.toThrow(/shutting down/i);
    releaseWait(true);
    await Promise.all([first, second]);
    expect(waitClosed).toHaveBeenCalledTimes(1);
  });

  it('faz chamadas concorrentes de close aguardarem o mesmo teardown', async () => {
    const transport = normalScript();
    let releaseWait!: (closed: boolean) => void;
    transport.waitClosed = vi.fn(() => new Promise<boolean>((resolve) => {
      releaseWait = resolve;
    }));
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const handle = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
    });

    const first = handle.close();
    const second = handle.close();
    expect(second).toBe(first);
    let settled = false;
    void second.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseWait(true);
    await Promise.all([first, second]);
    expect(transport.waitClosed).toHaveBeenCalledTimes(1);
  });

  it('fecha createRun em voo quando shutdown cruza o handshake', async () => {
    let releaseAuth!: (value: unknown) => void;
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') {
          return new Promise((resolve) => { releaseAuth = resolve; });
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const starting = driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
    });
    await vi.waitFor(() => expect(releaseAuth).toBeTypeOf('function'));

    const stopping = driver.shutdown();
    await vi.waitFor(() => expect(transport.killed).toBe(true));
    const rejected = expect(starting).rejects.toThrow(/shutting down/i);
    releaseAuth({ authenticated: true, subscription: { active: true } });
    await rejected;
    await stopping;
    expect(driver._registrySizeForTests()).toBe(0);
  });

  it('nao mascara timeout de authenticate como GrokAuthError', async () => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        return new Promise(() => undefined);
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const error = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
      handshakeTimeoutMs: 5,
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GrokProcessError);
    expect(error).not.toBeInstanceOf(GrokAuthError);
    expect(transport.killed).toBe(true);
  });

  it('classifica rejeicao estruturada de cached_token como GrokAuthError', async () => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        throw new GrokJsonRpcError('token expired', {
          method,
          code: 401,
          data: { reason: 'auth_required' },
        });
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    await expect(driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
    })).rejects.toBeInstanceOf(GrokAuthError);
  });

  it.each([
    ['resposta vazia', {}],
    ['authenticated sem metadado', { authenticated: true }],
    ['metadado legado', { authenticated: true, subscription: { active: true } }],
  ])('aceita sucesso do authenticate sem exigir shape privado: %s', async (_label, auth) => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return auth;
        throw new Error(`unexpected ${method}`);
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const handle = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
    });
    await handle.close();
    expect(transport.killed).toBe(true);
  });

  it('rejeita assinatura explicitamente inativa', async () => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: false } };
        throw new Error(`unexpected ${method}`);
      },
    });
    await expect(new GrokAcpDriver(fakeGrokTransportFactory(transport)).createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
    })).rejects.toBeInstanceOf(GrokAuthError);
    expect(transport.killed).toBe(true);
  });

  it('rejeita resposta contraditoria com authenticated=false e assinatura ativa', async () => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: false, subscription: { active: true } };
        throw new Error(`unexpected ${method}`);
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    await expect(driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
    })).rejects.toBeInstanceOf(GrokAuthError);
    expect(transport.killed).toBe(true);
  });

  it('falha fechado quando session/new nao atesta o modelo efetivo', async () => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { sessionId: 'sem-modelo' };
        throw new Error(`unexpected ${method}`);
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const handle = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
    });
    await expect(handle.send('ola')).rejects.toThrow(/did not attest the effective model/);
    await handle.close();
  });

  it('falha fechado quando session/new retorna campos de modelo conflitantes', async () => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') {
          return {
            sessionId: 'modelo-conflitante',
            modelId: 'grok-4.5',
            models: { currentModelId: 'grok-internal' },
          };
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const handle = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
    });
    await expect(handle.send('ola')).rejects.toThrow(/conflicting effective model attestations/);
    expect(transport.requests.map(({ method }) => method)).not.toContain('session/prompt');
    await handle.close();
  });

  it('falha fechado quando o terminal troca o modelo atestado', async () => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { sessionId: 'model-swap', models: { currentModelId: 'grok-4.5' } };
        if (method === 'session/prompt') {
          return {
            stopReason: 'end_turn',
            _meta: { modelId: 'grok-internal', usage: { inputTokens: 1, outputTokens: 1 } },
          };
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const handle = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
    });
    const error = await handle.send('ola').catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GrokBackendError);
    expect((error as Error).message).toMatch(/terminal response selected model/);
    await handle.close();
  });

  it('falha fechado quando o terminal omite a atestacao de modelo', async () => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { sessionId: 'terminal-sem-modelo', models: { currentModelId: 'grok-4.5' } };
        if (method === 'session/prompt') {
          return { stopReason: 'end_turn', _meta: { usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const handle = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
    });
    await expect(handle.send('ola')).rejects.toThrow(/terminal response did not attest/);
    await handle.close();
  });

  it('falha fechado quando modelUsage atribui consumo a outro modelo', async () => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { sessionId: 'usage-swap', models: { currentModelId: 'grok-4.5' } };
        if (method === 'session/prompt') {
          return {
            stopReason: 'end_turn',
            _meta: {
              modelId: 'grok-4.5',
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                modelUsage: {
                  'grok-internal': {
                    inputTokens: 1,
                    outputTokens: 1,
                    cachedReadTokens: 0,
                    reasoningTokens: 0,
                  },
                },
              },
            },
          };
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const handle = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
    });
    await expect(handle.send('ola')).rejects.toThrow(/terminal usage reported model/);
    await handle.close();
  });

  it('aceita o alias de usage "<modelo>-build" da rota de assinatura', async () => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { sessionId: 'usage-alias', models: { currentModelId: 'grok-4.5' } };
        if (method === 'session/prompt') {
          return {
            stopReason: 'end_turn',
            _meta: {
              modelId: 'grok-4.5',
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                modelUsage: {
                  'grok-4.5-build': {
                    inputTokens: 1,
                    outputTokens: 1,
                    cachedReadTokens: 0,
                    reasoningTokens: 0,
                  },
                },
              },
            },
          };
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const handle = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
    });
    const response = await handle.send('ola');
    expect((response as { status?: string }).status).not.toBe('error');
    await handle.close();
  });

  it.each(['session/new', 'session/prompt', 'notification:error'] as const)(
    'classifica perda estruturada de auth em %s como GrokAuthError',
    async (failurePoint) => {
      const transport = new FakeGrokAcpTransport({
        onRequest: async (method, _params, fake) => {
          if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
          if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
          if (method === 'session/new') {
            if (failurePoint === 'session/new') {
              throw new GrokJsonRpcError('token expired', {
                method,
                code: 401,
                data: { reason: 'auth_required' },
              });
            }
            return { sessionId: 'auth-loss', models: { currentModelId: 'grok-4.5' } };
          }
          if (method === 'session/prompt') {
            if (failurePoint === 'session/prompt') {
              throw new GrokJsonRpcError('login required', {
                method,
                code: -32001,
                data: { status: 401 },
              });
            }
            fake.emitNotification('error', {
              willRetry: false,
              error: { code: 401, message: 'cached token expired', data: { reason: 'token_expired' } },
            });
            return new Promise(() => undefined);
          }
          return {};
        },
      });
      const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
      const handle = await driver.createRun({
        workDir: home,
        model: 'grok-4.5',
        effort: 'medium',
        thinking: true,
        systemPrompt: '',
        executable: '/fake/grok',
        env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
      });
      await expect(handle.send('ola')).rejects.toBeInstanceOf(GrokAuthError);
      await handle.close();
    },
  );

  it('traduz permission request para o guard e allow-once', async () => {
    const guard = vi.fn(async () => ({ behavior: 'allow' as const }));
    const assertWorkspaceUnchanged = vi.fn();
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method, _params, fake) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { sessionId: 's2', models: { currentModelId: 'grok-4.5' } };
        if (method === 'session/prompt') {
          fake.emitServerRequest(9, 'session/request_permission', {
            sessionId: 's2',
            toolCall: { toolCallId: 'tool-1', title: 'write', rawInput: { variant: 'Write', file_path: '/tmp/x', content: 'x' } },
            options: [
              { kind: 'allow_once', optionId: 'allow-once' },
              { kind: 'reject_once', optionId: 'reject-once' },
            ],
          });
          await Promise.resolve();
          return { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        return {};
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const handle = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
      permission: { mode: 'default', dangerouslySkipPermissions: false, canUseTool: guard },
      assertWorkspaceUnchanged,
    });
    await handle.send('edite');
    expect(guard).toHaveBeenCalledWith(
      'Write',
      { file_path: '/tmp/x', content: 'x' },
      expect.objectContaining({ toolUseID: 'tool-1' }),
    );
    expect(assertWorkspaceUnchanged).toHaveBeenCalledTimes(4);
    expect(transport.responses).toContainEqual({
      id: 9,
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    });
    await handle.close();
  });

  it('guard nega quando o wire oferece apenas allow_always e reject', async () => {
    const guard = vi.fn(async () => ({ behavior: 'allow' as const }));
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method, _params, fake) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { sessionId: 'always-only', models: { currentModelId: 'grok-4.5' } };
        if (method === 'session/prompt') {
          const options = [
            { kind: 'allow_always', optionId: 'allow-always' },
            { kind: 'reject_once', optionId: 'reject-once' },
          ];
          for (const id of [31, 32]) {
            fake.emitServerRequest(id, 'session/request_permission', {
              toolCall: {
                toolCallId: `tool-${id}`,
                rawInput: { variant: 'Read', file_path: '/tmp/x' },
              },
              options,
            });
          }
          return { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        return {};
      },
    });
    const handle = await new GrokAcpDriver(fakeGrokTransportFactory(transport)).createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
      permission: { mode: 'default', dangerouslySkipPermissions: false, canUseTool: guard },
    });

    await handle.send('leia');
    await vi.waitFor(() => expect(transport.responses).toHaveLength(2));
    expect(guard).toHaveBeenCalledTimes(2);
    expect(transport.responses).toEqual([
      { id: 31, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
      { id: 32, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
    ]);
    expect(transport.responses.some(({ result }) => JSON.stringify(result).includes('allow-always'))).toBe(false);
    await handle.close();
  });

  describe('contrato CanUseTool do Agent SDK 0.3 (D11)', () => {
    function permissionTransport(
      sessionId: string,
      requestId: number,
      toolCallId: string,
    ): FakeGrokAcpTransport {
      return new FakeGrokAcpTransport({
        onRequest: async (method, _params, fake) => {
          if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
          if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
          if (method === 'session/new') return { sessionId, models: { currentModelId: 'grok-4.5' } };
          if (method === 'session/prompt') {
            fake.emitServerRequest(requestId, 'session/request_permission', {
              sessionId,
              toolCall: { toolCallId, title: 'write', rawInput: { variant: 'Write', file_path: '/tmp/x', content: 'x' } },
              options: [
                { kind: 'allow_once', optionId: 'allow-once' },
                { kind: 'reject_once', optionId: 'reject-once' },
              ],
            });
            await Promise.resolve();
            return { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', usage: { inputTokens: 1, outputTokens: 1 } } };
          }
          return {};
        },
      });
    }

    async function runWithGuard(transport: FakeGrokAcpTransport, guard: CanUseTool) {
      const handle = await new GrokAcpDriver(fakeGrokTransportFactory(transport)).createRun({
        workDir: home,
        model: 'grok-4.5',
        effort: 'medium',
        thinking: true,
        systemPrompt: '',
        executable: '/fake/grok',
        env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
        permission: { mode: 'default', dangerouslySkipPermissions: false, canUseTool: guard },
      });
      await handle.send('edite');
      await vi.waitFor(() => expect(transport.responses).toHaveLength(1));
      await handle.close();
    }

    it('(a) o guard recebe requestId string nao-vazia e toolUseID', async () => {
      const guard = vi.fn(async () => ({ behavior: 'allow' as const }));
      const transport = permissionTransport('d11-a', 91, 'tool-a');
      await runWithGuard(transport, guard);
      expect(guard).toHaveBeenCalledTimes(1);
      expect(guard).toHaveBeenCalledWith(
        'Write',
        { file_path: '/tmp/x', content: 'x' },
        expect.objectContaining({ toolUseID: 'tool-a', requestId: expect.any(String) }),
      );
      const options = (guard.mock.calls[0] as unknown[])[2] as { requestId: string };
      expect(options.requestId.length).toBeGreaterThan(0);
      expect(transport.responses).toEqual([
        { id: 91, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } },
      ]);
    });

    it('(b) guard resolvendo null NEGA fail-closed (reject, nunca allow)', async () => {
      const guard = vi.fn(async () => null);
      const transport = permissionTransport('d11-b', 92, 'tool-b');
      await runWithGuard(transport, guard);
      expect(guard).toHaveBeenCalledTimes(1);
      expect(transport.responses).toEqual([
        { id: 92, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
      ]);
    });

    it('(c) deny continua negando', async () => {
      const guard = vi.fn(async () => ({ behavior: 'deny' as const, message: 'vetado' }));
      const transport = permissionTransport('d11-c', 93, 'tool-c');
      await runWithGuard(transport, guard);
      expect(guard).toHaveBeenCalledTimes(1);
      expect(transport.responses).toEqual([
        { id: 93, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
      ]);
    });
  });

  it('canonicaliza UseTool (MCP) para mcp__{server}__{tool} antes do guard', async () => {
    const guard = vi.fn(async () => ({ behavior: 'allow' as const }));
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method, _params, fake) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { sessionId: 'use-tool', models: { currentModelId: 'grok-4.5' } };
        if (method === 'session/prompt') {
          fake.emitServerRequest(41, 'session/request_permission', {
            toolCall: {
              toolCallId: 'call-mcp-1',
              kind: 'other',
              title: 'lionclaw__mcp_invoke',
              rawInput: {
                variant: 'UseTool',
                tool_name: 'lionclaw__mcp_invoke',
                tool_input: { server: 'lionclaw-pipeline-control', tool: 'pipeline_list' },
              },
            },
            options: [
              { kind: 'allow_once', optionId: 'allow-once' },
              { kind: 'reject_once', optionId: 'reject-once' },
            ],
          });
          fake.emitServerRequest(42, 'session/request_permission', {
            toolCall: {
              toolCallId: 'call-mcp-2',
              rawInput: { variant: 'UseTool', tool_name: 'sem-separador' },
            },
            options: [
              { kind: 'allow_once', optionId: 'allow-once' },
              { kind: 'reject_once', optionId: 'reject-once' },
            ],
          });
          return { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        return {};
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const handle = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
      permission: { mode: 'default', dangerouslySkipPermissions: false, canUseTool: guard },
    });

    await handle.send('invoque a tool');
    await vi.waitFor(() => expect(transport.responses.filter((r) => r.id === 41 || r.id === 42)).toHaveLength(2));
    expect(guard).toHaveBeenCalledWith(
      'mcp__lionclaw__mcp_invoke',
      { server: 'lionclaw-pipeline-control', tool: 'pipeline_list' },
      expect.objectContaining({ toolUseID: 'call-mcp-1' }),
    );
    const r41 = transport.responses.find((r) => r.id === 41);
    expect(JSON.stringify(r41)).toContain('allow-once');
    const r42 = transport.responses.find((r) => r.id === 42);
    expect(JSON.stringify(r42)).toContain('reject-once');
    await handle.close();
  });

  it('canonicaliza todas as variants nativas oficiais 0.2.103 antes do guard', async () => {
    const guard = vi.fn(async () => ({ behavior: 'allow' as const }));
    const fixtures = [
      ['Read', { variant: 'read_file', path: '/tmp/read.ts' }],
      ['Write', { variant: 'write_file', file_path: '/tmp/write.ts', content: 'x' }],
      ['Edit', { variant: 'search_replace', filePath: '/tmp/edit.ts', old_string: 'a', new_string: 'b' }],
      ['Bash', { variant: 'run_terminal_cmd', cmd: 'npm test' }],
      ['Glob', { variant: 'list_dir', path: '/tmp' }],
      ['Grep', { variant: 'grep', pattern: 'needle', path: '/tmp' }],
      ['WebSearch', { variant: 'web_search', query: 'LionClaw' }],
      ['WebFetch', { variant: 'web_fetch', url: 'https://example.com' }],
    ] as const;
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method, _params, fake) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { sessionId: 'native-tools', models: { currentModelId: 'grok-4.5' } };
        if (method === 'session/prompt') {
          fixtures.forEach(([, rawInput], index) => fake.emitServerRequest(index + 1, 'session/request_permission', {
            toolCall: { toolCallId: `tool-${index + 1}`, rawInput },
            options: [
              { kind: 'allow_once', optionId: 'allow-once' },
              { kind: 'reject_once', optionId: 'reject-once' },
            ],
          }));
          return { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        return {};
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const handle = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
      permission: { mode: 'default', dangerouslySkipPermissions: false, canUseTool: guard },
    });

    await handle.send('use tools');
    await vi.waitFor(() => expect(guard).toHaveBeenCalledTimes(fixtures.length));
    const calls = guard.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
    expect(calls.map((call) => call[0])).toEqual(fixtures.map(([name]) => name));
    expect(calls[0]![1]).toMatchObject({ path: '/tmp/read.ts', file_path: '/tmp/read.ts' });
    expect(calls[2]![1]).toMatchObject({ filePath: '/tmp/edit.ts', file_path: '/tmp/edit.ts' });
    expect(calls[3]![1]).toMatchObject({ cmd: 'npm test', command: 'npm test' });
    expect(transport.responses).toHaveLength(fixtures.length);
    expect(transport.responses.every(({ result }) => JSON.stringify(result).includes('allow-once'))).toBe(true);
    await handle.close();
  });

  it('nega variants desconhecidas e aliases de path invalidos antes do guard', async () => {
    const guard = vi.fn(async () => ({ behavior: 'allow' as const }));
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method, _params, fake) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { sessionId: 's-unknown', models: { currentModelId: 'grok-4.5' } };
        if (method === 'session/prompt') {
          const options = [
            { kind: 'allow_once', optionId: 'allow-once' },
            { kind: 'reject_once', optionId: 'reject-once' },
          ];
          fake.emitServerRequest(20, 'session/request_permission', {
            sessionId: 's-unknown',
            toolCall: { toolCallId: 'tool-overwrite', title: 'write', rawInput: { variant: 'Overwrite' } },
            options,
          });
          fake.emitServerRequest(21, 'session/request_permission', {
            sessionId: 's-unknown',
            toolCall: { toolCallId: 'tool-title', title: 'Write', rawInput: { file_path: '/tmp/x' } },
            options,
          });
          fake.emitServerRequest(23, 'session/request_permission', {
            sessionId: 's-unknown',
            toolCall: { title: 'Write', rawInput: { variant: 'Write', file_path: '/tmp/x' } },
            options,
          });
          fake.emitServerRequest(24, 'session/request_permission', {
            sessionId: 's-unknown',
            toolCall: {
              toolCallId: 'tool-conflicting-paths',
              rawInput: {
                variant: 'Write',
                file_path: '/tmp/allowed.txt',
                path: '/tmp/other.txt',
                content: 'x',
              },
            },
            options,
          });
          fake.emitServerRequest(25, 'session/request_permission', {
            sessionId: 's-unknown',
            toolCall: {
              toolCallId: 'tool-empty-path',
              rawInput: { variant: 'Write', file_path: '/tmp/allowed.txt', path: '', content: 'x' },
            },
            options,
          });
          fake.emitServerRequest(26, 'session/request_permission', {
            sessionId: 's-unknown',
            toolCall: {
              toolCallId: 'tool-whitespace-path',
              rawInput: { variant: 'Write', file_path: '/tmp/allowed.txt', filePath: '   ', content: 'x' },
            },
            options,
          });
          fake.emitServerRequest(27, 'session/request_permission', {
            sessionId: 's-unknown',
            toolCall: {
              toolCallId: 'tool-non-string-path',
              rawInput: { variant: 'Write', file_path: '/tmp/allowed.txt', path: 42, content: 'x' },
            },
            options,
          });
          await Promise.resolve();
          return { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        return {};
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const handle = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
      permission: { mode: 'default', dangerouslySkipPermissions: false, canUseTool: guard },
    });
    await handle.send('tente');
    await vi.waitFor(() => expect(transport.responses).toHaveLength(7));
    expect(guard).not.toHaveBeenCalled();
    expect(transport.responses).toEqual([
      { id: 20, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
      { id: 21, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
      { id: 23, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
      { id: 24, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
      { id: 25, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
      { id: 26, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
      { id: 27, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
    ]);
    await handle.close();
  });

  it('auto-aprova variant desconhecida quando o perfil usa bypass (32dbc28)', async () => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method, _params, fake) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { sessionId: 's-bypass-unknown', models: { currentModelId: 'grok-4.5' } };
        if (method === 'session/prompt') {
          fake.emitServerRequest(22, 'session/request_permission', {
            sessionId: 's-bypass-unknown',
            toolCall: { toolCallId: 'tool-unknown', title: 'write', rawInput: { variant: 'Overwrite' } },
            options: [
              { kind: 'allow_always', optionId: 'allow-always' },
              { kind: 'reject_once', optionId: 'reject-once' },
            ],
          });
          await Promise.resolve();
          return { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        return {};
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const handle = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
      permission: { mode: 'bypassPermissions', dangerouslySkipPermissions: true },
    });
    await handle.send('tente');
    await vi.waitFor(() => expect(transport.responses).toHaveLength(1));
    expect(transport.responses[0]).toEqual({
      id: 22,
      result: { outcome: { outcome: 'selected', optionId: 'allow-always' } },
    });
    await handle.close();
  });

  it('rehash bloqueia permissao mesmo no perfil bypass', async () => {
    const assertWorkspaceUnchanged = vi.fn(() => {
      if (assertWorkspaceUnchanged.mock.calls.length === 3) throw new Error('snapshot changed');
    });
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method, _params, fake) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { sessionId: 's-bypass', models: { currentModelId: 'grok-4.5' } };
        if (method === 'session/prompt') {
          fake.emitServerRequest(10, 'session/request_permission', {
            sessionId: 's-bypass',
            toolCall: { toolCallId: 'tool-bypass', title: 'write', rawInput: { variant: 'Write' } },
            options: [
              { kind: 'allow_always', optionId: 'allow-always' },
              { kind: 'reject_once', optionId: 'reject-once' },
            ],
          });
          await Promise.resolve();
          return { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        return {};
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const handle = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
      permission: { mode: 'bypassPermissions', dangerouslySkipPermissions: true },
      assertWorkspaceUnchanged,
    });
    await handle.send('edite');
    expect(transport.responses).toContainEqual({
      id: 10,
      result: { outcome: { outcome: 'selected', optionId: 'reject-once' } },
    });
    expect(transport.responses).not.toContainEqual({
      id: 10,
      result: { outcome: { outcome: 'selected', optionId: 'allow-always' } },
    });
    await handle.close();
  });

  it('envia session/cancel exatamente uma vez e aguarda terminal cancelado', async () => {
    let resolvePrompt: ((value: unknown) => void) | undefined;
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { sessionId: 's3', models: { currentModelId: 'grok-4.5' } };
        if (method === 'session/prompt') {
          return new Promise((resolve) => { resolvePrompt = resolve; });
        }
        throw new Error(`unexpected ${method}`);
      },
      onNotify: (method) => {
        if (method === 'session/cancel') {
          resolvePrompt?.({
            stopReason: 'cancelled',
            cancellationCategory: 'MidTurnAbort',
            _meta: { modelId: 'grok-4.5' },
          });
        }
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const handle = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
    });
    const abort = new AbortController();
    const responsePromise = handle.send('pare', {}, abort.signal);
    await vi.waitFor(() => expect(resolvePrompt).toBeTypeOf('function'));
    abort.abort();
    abort.abort();
    const response = await responsePromise;
    expect(response.status).toBe('cancelled');
    expect(transport.notificationsSent.filter(({ method }) => method === 'session/cancel')).toHaveLength(1);
    await handle.close();
    expect(transport.notificationsSent.filter(({ method }) => method === 'session/cancel')).toHaveLength(1);
  });

  it('rejeita e mata o processo quando abort recebe terminal nao-cancelado', async () => {
    let resolvePrompt: ((value: unknown) => void) | undefined;
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { sessionId: 'cancel-mismatch', models: { currentModelId: 'grok-4.5' } };
        if (method === 'session/prompt') return new Promise((resolve) => { resolvePrompt = resolve; });
        throw new Error(`unexpected ${method}`);
      },
      onNotify: (method) => {
        if (method === 'session/cancel') {
          resolvePrompt?.({ stopReason: 'end_turn', _meta: { modelId: 'grok-4.5' } });
        }
      },
    });
    const handle = await new GrokAcpDriver(fakeGrokTransportFactory(transport)).createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
    });
    const abort = new AbortController();
    const response = handle.send('pare', {}, abort.signal);
    await vi.waitFor(() => expect(resolvePrompt).toBeTypeOf('function'));
    abort.abort();

    await expect(response).rejects.toThrow(/cancel was not confirmed/);
    expect(transport.killed).toBe(true);
    expect(transport.notificationsSent.filter(({ method }) => method === 'session/cancel')).toHaveLength(1);
    await handle.close();
  });

  it('nao envia session/prompt quando abort ocorre ao concluir session/new', async () => {
    const abort = new AbortController();
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { sessionId: 'abort-before-prompt', models: { currentModelId: 'grok-4.5' } };
        throw new Error(`unexpected ${method}`);
      },
    });
    const handle = await new GrokAcpDriver(fakeGrokTransportFactory(transport)).createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
      attestSession: async () => abort.abort(),
    });
    await expect(handle.send('nao execute', {}, abort.signal)).rejects.toThrow(/aborted before session\/prompt/);
    expect(transport.requests.map(({ method }) => method)).not.toContain('session/prompt');
    expect(transport.notificationsSent.map(({ method }) => method)).not.toContain('session/cancel');
    await handle.close();
  });

  it('mata o child quando session/cancel nao termina dentro da grace', async () => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { sessionId: 'cancel-ignored', models: { currentModelId: 'grok-4.5' } };
        if (method === 'session/prompt') return new Promise(() => undefined);
        throw new Error(`unexpected ${method}`);
      },
    });
    const driver = new GrokAcpDriver(fakeGrokTransportFactory(transport));
    const handle = await driver.createRun({
      workDir: home,
      model: 'grok-4.5',
      effort: 'medium',
      thinking: true,
      systemPrompt: '',
      executable: '/fake/grok',
      env: buildGrokChildEnv(path.join(home, 'runtime', 'grok-home'), {}),
      cancelGraceMs: 5,
    });
    const abort = new AbortController();
    const response = handle.send('pare', {}, abort.signal);
    await vi.waitFor(() => expect(
      transport.requests.some(({ method }) => method === 'session/prompt'),
    ).toBe(true));
    const rejected = expect(response).rejects.toThrow(/cancel grace \(5ms\)/);
    abort.abort();
    await rejected;
    expect(transport.killed).toBe(true);
    expect(transport.notificationsSent.filter(({ method }) => method === 'session/cancel')).toHaveLength(1);
    await handle.close();
  });
});
