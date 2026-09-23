import { describe, expect, it } from 'vitest';
import type { AcpTransport, AcpTransportFactory } from '../acp-transport';
import { probeKimiProvider } from '../provider-probe';

function transportFactory(responder: (method: string) => unknown): {
  factory: AcpTransportFactory;
  methods: string[];
  killed: { value: boolean };
} {
  const methods: string[] = [];
  const killed = { value: false };
  const transport: AcpTransport = {
    request: async (method) => {
      methods.push(method);
      return responder(method);
    },
    notify: () => undefined,
    onNotification: () => () => undefined,
    onServerRequest: () => () => undefined,
    respond: () => undefined,
    onError: () => () => undefined,
    kill: () => {
      killed.value = true;
    },
    waitClosed: async () => true,
  };
  return { factory: async () => transport, methods, killed };
}

describe('probeKimiProvider', () => {
  it('usa initialize e session/new como autoridade sem enviar prompt', async () => {
    const fake = transportFactory((method) => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') {
        return {
          sessionId: 'probe-session',
          configOptions: [
            {
              id: 'model',
              currentValue: 'kimi-code/kimi-for-coding',
              options: [
                { value: 'kimi-code/kimi-for-coding' },
                { value: 'kimi-code/kimi-for-coding-highspeed' },
                { value: 'kimi-code/k3' },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected ${method}`);
    });

    await expect(
      probeKimiProvider({
        binary: '/fake/kimi',
        home: '/tmp/kimi-home',
        cwd: '/tmp/project',
        transportFactory: fake.factory,
      }),
    ).resolves.toMatchObject({
      ok: true,
      currentModel: 'kimi-code/kimi-for-coding',
      availableModels: ['kimi-code/kimi-for-coding', 'kimi-code/k3'],
    });
    expect(fake.methods).toEqual(['initialize', 'session/new']);
    expect(fake.killed.value).toBe(true);
  });

  it('falha quando a sessao nao anuncia modelo suportado', async () => {
    const fake = transportFactory((method) =>
      method === 'initialize'
        ? { protocolVersion: 1 }
        : {
            sessionId: 'probe-session',
            configOptions: [{ id: 'model', currentValue: 'outro', options: [{ value: 'outro' }] }],
          },
    );

    await expect(
      probeKimiProvider({
        binary: '/fake/kimi',
        home: '/tmp/kimi-home',
        cwd: '/tmp/project',
        transportFactory: fake.factory,
      }),
    ).resolves.toMatchObject({ ok: false, availableModels: [] });
    expect(fake.killed.value).toBe(true);
  });
});
