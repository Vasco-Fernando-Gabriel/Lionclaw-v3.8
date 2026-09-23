import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import type { GrokExternalTool } from '../../agent-runtime/grok-session-config';
import {
  _grokBridgeCountForTests,
  GROK_MCP_MAX_BODY_BYTES,
  GROK_MCP_MAX_ERROR_CHARS,
  startGrokMcpBridge,
  stopAllGrokMcpBridges,
} from '../mcp-http-bridge';

function postRaw(
  url: string,
  token: string,
  chunks: string[],
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    let settled = false;
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      },
      (response) => {
        const responseChunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => responseChunks.push(chunk));
        response.on('end', () => {
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(responseChunks).toString('utf8')) as Record<string, unknown>,
          });
        });
      },
    );
    request.once('error', (error) => {
      if (!settled) reject(error);
    });
    chunks.forEach((chunk) => request.write(chunk));
    request.end();
  });
}

function post(
  url: string,
  token: string,
  body: Record<string, unknown>,
  authorization = `Bearer ${token}`,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          }),
        );
      },
    );
    request.once('error', reject);
    request.end(JSON.stringify(body));
  });
}

describe('Grok MCP bridge', () => {
  afterEach(() => stopAllGrokMcpBridges());

  it('expoe exatamente as tools e encaminha call no shape HTTP aceito', async () => {
    let correlatedContext: Parameters<GrokExternalTool['handler']>[1];
    const bridge = await startGrokMcpBridge({
      tools: [
        {
          name: 'lion_echo',
          description: 'echo',
          parameters: { type: 'object', properties: { text: { type: 'string' } } },
          handler: async (params, context) => {
            correlatedContext = context;
            return { output: String(params['text']), message: 'ok' };
          },
        },
      ],
    });
    expect(bridge.mcpServerEntry).toMatchObject({
      id: 'lionbridge',
      type: 'http',
      headers: [{ name: 'Authorization', value: `Bearer ${bridge.token}` }],
      env: [],
    });
    const list = await post(bridge.url, bridge.token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ result: { tools: [{ name: 'lion_echo' }] } });
    const call = await post(bridge.url, bridge.token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'lion_echo', arguments: { text: 'ola' } },
    });
    expect(call.body).toMatchObject({ result: { content: [{ type: 'text', text: 'ola' }] } });
    expect(correlatedContext).toMatchObject({
      transportCorrelation: { kind: 'mcp-request-id', value: '2' },
      signal: expect.any(AbortSignal),
    });
    expect(correlatedContext?.toolUseId).toBeUndefined();
    const bareToken = await post(
      bridge.url,
      bridge.token,
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      bridge.token,
    );
    expect(bareToken.status).toBe(401);
    const firstStop = bridge.stop();
    const secondStop = bridge.stop();
    expect(secondStop).toBe(firstStop);
    await Promise.all([firstStop, secondStop]);
    expect(_grokBridgeCountForTests()).toBe(0);
  });

  it('redige e trunca erros de tool antes de devolve-los ao modelo', async () => {
    const bridge = await startGrokMcpBridge({
      tools: [
        {
          name: 'lion_fail',
          description: 'fail',
          parameters: { type: 'object', properties: {} },
          handler: async () => {
            throw new Error(
              `Bearer bearer-secret token=token-secret https://user:pass@example.com/private /home/user/private.txt C:\\Users\\user\\secret.txt ${'x'.repeat(1_000)}`,
            );
          },
        },
      ],
    });
    const call = await post(bridge.url, bridge.token, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'lion_fail', arguments: {} },
    });
    const result = call.body['result'] as { content: Array<{ text: string }>; isError: boolean };
    const text = result.content[0]!.text;
    expect(result.isError).toBe(true);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('bearer-secret');
    expect(text).not.toContain('token-secret');
    expect(text).not.toContain('user:pass');
    expect(text).not.toContain('/home/user');
    expect(text).not.toContain('C:\\Users');
    expect(text.length).toBeLessThanOrEqual('bridge tool error: '.length + GROK_MCP_MAX_ERROR_CHARS);
    expect(text.endsWith('…')).toBe(true);
  });

  it('stop aborta e aguarda tools em voo antes de fechar a bridge', async () => {
    let release!: () => void;
    let started!: () => void;
    let aborted!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const abortedPromise = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = await startGrokMcpBridge({
      tools: [
        {
          name: 'lion_wait',
          description: 'wait',
          parameters: { type: 'object', properties: {} },
          handler: async (_params, context) => {
            started();
            context?.signal?.addEventListener('abort', aborted, { once: true });
            await releasePromise;
            return { output: 'stopped', message: 'ok' };
          },
        },
      ],
    });
    const call = post(bridge.url, bridge.token, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'lion_wait', arguments: {} },
    });
    await startedPromise;

    let stopSettled = false;
    const stopping = bridge.stop().then(() => {
      stopSettled = true;
    });
    await abortedPromise;
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    release();
    const [response] = await Promise.all([call, stopping]);
    expect(response.status).toBe(200);
    expect(stopSettled).toBe(true);
  });

  it('stop fecha bounded mesmo quando o handler ignora o abort', async () => {
    let started!: () => void;
    let aborted!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const abortedPromise = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const bridge = await startGrokMcpBridge({
      tools: [
        {
          name: 'lion_never_settles',
          description: 'never settles',
          parameters: { type: 'object', properties: {} },
          handler: async (_params, context) => {
            started();
            context?.signal?.addEventListener('abort', aborted, { once: true });
            await new Promise<void>(() => undefined);
            return { output: 'unreachable', message: 'unreachable' };
          },
        },
      ],
    });
    const call = post(bridge.url, bridge.token, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'lion_never_settles', arguments: {} },
    });
    void call.catch(() => undefined);
    await startedPromise;

    const startedAt = Date.now();
    await Promise.all([bridge.stop(), abortedPromise]);

    expect(Date.now() - startedAt).toBeLessThan(3_500);
    await call.catch(() => undefined);
    expect(_grokBridgeCountForTests()).toBe(0);
  }, 5_000);

  it('falha fechado com nome de server/tool fora do padrao aceito pelo Grok', async () => {
    await expect(
      startGrokMcpBridge({
        tools: [
          { name: 'ok_tool', description: 'x', parameters: {}, handler: async () => ({ output: '', message: '' }) },
        ],
        serverName: 'LionClaw Bridge',
      }),
    ).rejects.toThrow(/fora do padrao aceito pelo CLI/);
    await expect(
      startGrokMcpBridge({
        tools: [
          {
            name: 'nome com espaco',
            description: 'x',
            parameters: {},
            handler: async () => ({ output: '', message: '' }),
          },
        ],
      }),
    ).rejects.toThrow(/nome qualificado invalido/);
    await expect(
      startGrokMcpBridge({
        tools: [
          {
            name: 'mcp__skills__load_skill',
            description: 'x',
            parameters: {},
            handler: async () => ({ output: '', message: '' }),
          },
        ],
      }),
    ).rejects.toThrow(/namespace MCP aninhado/);
  });

  it('rejeita Content-Length acima do limite antes de ler o corpo', async () => {
    const bridge = await startGrokMcpBridge({
      tools: [
        {
          name: 'lion_echo',
          description: 'echo',
          parameters: { type: 'object', properties: {} },
          handler: async () => ({ output: 'ok', message: 'ok' }),
        },
      ],
    });
    const response = await postRaw(bridge.url, bridge.token, ['{}'], {
      'Content-Length': String(GROK_MCP_MAX_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ error: { message: 'request body too large' } });
  });

  it('rejeita corpo chunked que ultrapassa o limite acumulado', async () => {
    const bridge = await startGrokMcpBridge({
      tools: [
        {
          name: 'lion_echo',
          description: 'echo',
          parameters: { type: 'object', properties: {} },
          handler: async () => ({ output: 'ok', message: 'ok' }),
        },
      ],
    });
    const response = await postRaw(bridge.url, bridge.token, ['x'.repeat(GROK_MCP_MAX_BODY_BYTES), 'x']);
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ error: { message: 'request body too large' } });
  });
});
