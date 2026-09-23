import http from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KIMI_MCP_MAX_BODY_BYTES, startKimiMcpBridge, type KimiMcpBridge } from '../mcp-http-bridge';
import { getKimiBridgeRegistry } from '../mcp-bridge-registry';
import type { KimiExternalTool } from '../../agent-runtime/kimi-external-tools';

function fakeTool(name: string): KimiExternalTool {
  return {
    name,
    description: 'fake ' + name,
    parameters: { type: 'object', properties: {} },
    handler: vi.fn(async () => ({ output: 'unused-in-b1', message: 'ok' })),
  };
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  url: string,
  options: { method: 'POST' | 'GET'; headers?: Record<string, string>; body?: string },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request(url, { method: options.method, headers: options.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        settled = true;
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

function openSse(
  url: string,
  headers: Record<string, string>,
): Promise<{
  status: number;
  contentType: string;
  firstChunk: string;
  req: http.ClientRequest;
  res: http.IncomingMessage;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      res.once('data', (c: Buffer) => {
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          firstChunk: c.toString('utf8'),
          req,
          res,
        });
      });
      res.on('error', () => {});
    });
    req.on('error', reject);
    req.end();
  });
}

function authHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(extra ?? {}) };
}

function portFromUrl(url: string): number {
  return Number(new URL(url).port);
}

describe('mcp-http-bridge (B1 skeleton)', () => {
  const live: KimiMcpBridge[] = [];

  afterEach(async () => {
    for (const b of live.splice(0)) {
      await b.stop();
    }
  });

  async function start(tools: KimiExternalTool[] = [fakeTool('lion_run_subagent')]): Promise<KimiMcpBridge> {
    const b = await startKimiMcpBridge({ tools });
    live.push(b);
    return b;
  }

  it('binds 127.0.0.1 on an OS-assigned port and exposes a token + entry', async () => {
    const bridge = await start();
    const parsed = new URL(bridge.url);
    expect(parsed.hostname).toBe('127.0.0.1');
    expect(parsed.hostname).not.toBe('0.0.0.0');
    expect(parsed.pathname).toBe('/mcp');
    expect(Number(parsed.port)).toBeGreaterThan(0);
    expect(bridge.token).toMatch(/^[0-9a-f]{64}$/);
    expect(bridge.bridgeId).toMatch(/[0-9a-f-]{36}/);
    expect(bridge.mcpServerEntry).toMatchObject({
      id: 'lionbridge',
      name: 'LionClaw Bridge',
      type: 'http',
      url: bridge.url,
      env: [],
    });
    expect(bridge.mcpServerEntry.headers).toEqual([{ name: 'Authorization', value: 'Bearer ' + bridge.token }]);
  });

  it('throws when started with an empty tool set (no-bridge profile)', async () => {
    await expect(startKimiMcpBridge({ tools: [] })).rejects.toThrow(/empty tool set/);
  });

  it('answers initialize with protocolVersion 2025-11-25, tools capability, and an Mcp-Session-Id', async () => {
    const bridge = await start();
    const res = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'kimi-code', version: '0.0.0' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.result.protocolVersion).toBe('2025-11-25');
    expect(parsed.result.capabilities.tools).toBeDefined();
    expect(parsed.result.serverInfo.name).toBe('LionClaw Bridge');
    expect(res.headers['mcp-session-id']).toBeTruthy();
  });

  it('echoes the client protocolVersion when present', async () => {
    const bridge = await start();
    const res = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    });
    expect(JSON.parse(res.body).result.protocolVersion).toBe('2025-06-18');
  });

  it('acks notifications/initialized with 202 and an empty body', async () => {
    const bridge = await start();
    const init = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const sessionId = String(init.headers['mcp-session-id']);
    const res = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token, { 'Mcp-Session-Id': sessionId }),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
    expect(res.body).toBe('');
  });

  it('opens the GET SSE stream (text/event-stream, ": open"), kept idle within a tick', async () => {
    const bridge = await start();
    const sse = await openSse(bridge.url, authHeaders(bridge.token));
    try {
      expect(sse.status).toBe(200);
      expect(sse.contentType).toContain('text/event-stream');
      expect(sse.firstChunk).toContain(': open');
      await new Promise((r) => setImmediate(r));
      expect(sse.res.complete).toBe(false);
    } finally {
      sse.req.destroy();
    }
  });

  it('replies -32601 for an unknown method', async () => {
    const bridge = await start();
    const res = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'frobnicate' }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).error.code).toBe(-32601);
  });

  it('replies 400 / -32700 for a malformed POST body and never crashes', async () => {
    const bridge = await start();
    const res = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token),
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(-32700);
  });

  it('tools/list returns every materialized tool as {name, description, inputSchema} (B2)', async () => {
    const tools = [fakeTool('lion_run_subagent'), fakeTool('mcp__google_calendar__list_events')];
    const bridge = await start(tools);
    const list = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(list.status).toBe(200);
    const parsed = JSON.parse(list.body);
    expect(parsed.result.tools).toHaveLength(tools.length);
    for (const item of parsed.result.tools) {
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('description');
      expect(item).toHaveProperty('inputSchema');
    }
    expect(parsed.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'lion_run_subagent',
      'mcp__google_calendar__list_events',
    ]);
  });

  it('tools/call routes to the in-process handler with the args and returns its output (B2)', async () => {
    const handler = vi.fn(async () => ({ output: 'handler-said-this', message: 'ok' }));
    const tool: KimiExternalTool = {
      name: 'lion_run_subagent',
      description: 'fake lion_run_subagent',
      parameters: { type: 'object', properties: {} },
      handler,
    };
    const bridge = await start([tool]);
    const call = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'lion_run_subagent', arguments: { agentId: 'x', prompt: 'y' } },
      }),
    });
    expect(call.status).toBe(200);
    const parsed = JSON.parse(call.body);
    expect(parsed.result.content[0].text).toBe('handler-said-this');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      { agentId: 'x', prompt: 'y' },
      {
        transportCorrelation: { kind: 'mcp-request-id', value: '2' },
        signal: expect.any(AbortSignal),
      },
    );
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
    const tool: KimiExternalTool = {
      name: 'lion_wait',
      description: 'wait',
      parameters: { type: 'object', properties: {} },
      handler: vi.fn(async (_params, context) => {
        started();
        context?.signal?.addEventListener('abort', aborted, { once: true });
        await releasePromise;
        return { output: 'stopped', message: 'ok' };
      }),
    };
    const bridge = await start([tool]);
    const call = request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'lion_wait', arguments: {} },
      }),
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
    const bridge = await start([
      {
        name: 'lion_never_settles',
        description: 'never settles',
        parameters: { type: 'object', properties: {} },
        handler: vi.fn(async (_params, context) => {
          started();
          context?.signal?.addEventListener('abort', aborted, { once: true });
          await new Promise<void>(() => undefined);
          return { output: 'unreachable', message: 'unreachable' };
        }),
      },
    ]);
    const call = request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'lion_never_settles', arguments: {} },
      }),
    });
    void call.catch(() => undefined);
    await startedPromise;

    const startedAt = Date.now();
    await Promise.all([bridge.stop(), abortedPromise]);

    expect(Date.now() - startedAt).toBeLessThan(3_500);
    await call.catch(() => undefined);
  }, 5_000);

  it('tools/call with an unknown name replies -32602 with the name in the message (B2)', async () => {
    const bridge = await start([fakeTool('lion_run_subagent')]);
    const call = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'does_not_exist', arguments: {} },
      }),
    });
    expect(call.status).toBe(200);
    const parsed = JSON.parse(call.body);
    expect(parsed.error.code).toBe(-32602);
    expect(parsed.error.message).toContain('does_not_exist');
  });

  it('rejects a request with NO token header (401)', async () => {
    const bridge = await start();
    const res = await request(bridge.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe(-32001);
  });

  it('rejects a WRONG token (401) and accepts the correct token (200)', async () => {
    const bridge = await start();
    const wrong = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders('deadbeef-not-the-token'),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(wrong.status).toBe(401);
    const right = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
    });
    expect(right.status).toBe(200);
  });

  it('accepts the token under the x-lionclaw-bridge-token header too (defensive union)', async () => {
    const bridge = await start();
    const res = await request(bridge.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lionclaw-Bridge-Token': bridge.token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(200);
  });

  it('returns 404 for a non /mcp path', async () => {
    const bridge = await start();
    const wrongPath = bridge.url.replace('/mcp', '/other');
    const res = await request(wrongPath, {
      method: 'POST',
      headers: authHeaders(bridge.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(404);
  });

  it('rejeita Content-Length acima de 1 MiB com 413', async () => {
    const bridge = await start();
    const res = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token, {
        'Content-Length': String(KIMI_MCP_MAX_BODY_BYTES + 1),
      }),
      body: '{}',
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toMatchObject({ error: { message: 'request body too large' } });
  });

  it('rejeita corpo chunked acima de 1 MiB com 413', async () => {
    const bridge = await start();
    const res = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token),
      body: 'x'.repeat(KIMI_MCP_MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toMatchObject({ error: { message: 'request body too large' } });
  });

  it('stop() releases the port (ECONNREFUSED afterwards) and is idempotent', async () => {
    const bridge = await startKimiMcpBridge({ tools: [fakeTool('lion_run_subagent')] });
    const port = portFromUrl(bridge.url);
    expect(port).toBeGreaterThan(0);
    const firstStop = bridge.stop();
    const secondStop = bridge.stop();
    expect(secondStop).toBe(firstStop);
    await Promise.all([firstStop, secondStop]);
    await expect(
      request('http://127.0.0.1:' + port + '/mcp', {
        method: 'POST',
        headers: authHeaders(bridge.token),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await expect(bridge.stop()).resolves.toBeUndefined();
  });

  it('stop() destroys a kept-alive idle SSE socket (no hang)', async () => {
    const bridge = await startKimiMcpBridge({ tools: [fakeTool('lion_run_subagent')] });
    const port = portFromUrl(bridge.url);
    const sse = await openSse(bridge.url, authHeaders(bridge.token));
    expect(sse.firstChunk).toContain(': open');
    await bridge.stop();
    await expect(
      request('http://127.0.0.1:' + port + '/mcp', {
        method: 'POST',
        headers: authHeaders(bridge.token),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    sse.req.destroy();
  });
});

describe('mcp-http-bridge (B3 registry + security over loopback)', () => {
  const live: KimiMcpBridge[] = [];

  afterEach(async () => {
    for (const b of live.splice(0)) {
      await b.stop();
    }
  });

  async function start(tools: KimiExternalTool[] = [fakeTool('lion_run_subagent')]): Promise<KimiMcpBridge> {
    const b = await startKimiMcpBridge({ tools });
    live.push(b);
    return b;
  }

  it('start registers the bridge (size +1) and stop() deregisters it (size back)', async () => {
    const registry = getKimiBridgeRegistry();
    const before = registry.size();
    const bridge = await startKimiMcpBridge({ tools: [fakeTool('lion_run_subagent')] });
    expect(registry.size()).toBe(before + 1);
    await bridge.stop();
    expect(registry.size()).toBe(before);
    await bridge.stop();
    expect(registry.size()).toBe(before);
  });

  it('getKimiBridgeRegistry().stopAll() stops a registered live bridge (port ECONNREFUSED)', async () => {
    const registry = getKimiBridgeRegistry();
    const bridge = await startKimiMcpBridge({ tools: [fakeTool('lion_run_subagent')] });
    const port = portFromUrl(bridge.url);
    expect(registry.size()).toBeGreaterThan(0);
    await registry.stopAll();
    expect(registry.size()).toBe(0);
    await expect(
      request('http://127.0.0.1:' + port + '/mcp', {
        method: 'POST',
        headers: authHeaders(bridge.token),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await expect(bridge.stop()).resolves.toBeUndefined();
  });

  it('GET SSE with NO token is rejected 401 (the stream is token-gated)', async () => {
    const bridge = await start();
    const res = await request(bridge.url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe(-32001);
  });

  it('GET SSE with a WRONG token is rejected 401', async () => {
    const bridge = await start();
    const res = await request(bridge.url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', Authorization: 'Bearer not-the-token' },
    });
    expect(res.status).toBe(401);
  });

  it('after stop() the tracked SSE socket is torn down and the bind host is 127.0.0.1', async () => {
    const bridge = await start();
    expect(new URL(bridge.url).hostname).toBe('127.0.0.1');
    const sse = await openSse(bridge.url, authHeaders(bridge.token));
    expect(sse.res.destroyed).toBe(false);
    const torndown = new Promise<void>((resolve) => {
      if (sse.res.destroyed || sse.res.complete) {
        resolve();
        return;
      }
      sse.res.once('close', () => resolve());
      sse.res.once('end', () => resolve());
    });
    await bridge.stop();
    await torndown;
    expect(sse.res.destroyed || sse.res.complete).toBe(true);
    sse.req.destroy();
  });
});
