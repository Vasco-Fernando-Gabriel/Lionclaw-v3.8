
import http from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startKimiMcpBridge, type KimiMcpBridge } from '../mcp-http-bridge';
import { getKimiBridgeRegistry } from '../mcp-bridge-registry';
import type { KimiExternalTool } from '../../agent-runtime/kimi-external-tools';


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
    const req = http.request(url, { method: options.method, headers: options.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
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
      res.on('error', () => {
      });
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

async function expectPortRefused(port: number, token: string): Promise<void> {
  await expect(
    request('http://127.0.0.1:' + port + '/mcp', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'initialize', params: {} }),
    }),
  ).rejects.toMatchObject({ code: expect.stringMatching(/^ECONN(REFUSED|RESET)$/) });
}


const SUBAGENT_OUTPUT = 'subagent synthesized result';

function buildFakeTools(): {
  tools: KimiExternalTool[];
  subagentHandler: ReturnType<typeof vi.fn>;
} {
  const subagentHandler = vi.fn(async () => ({ output: SUBAGENT_OUTPUT, message: 'ok' }));
  const subagent: KimiExternalTool = {
    name: 'lion_run_subagent',
    description: 'run a LionClaw subagent',
    parameters: {
      type: 'object',
      properties: { agentId: { type: 'string' }, prompt: { type: 'string' } },
      required: ['agentId', 'prompt'],
    },
    handler: subagentHandler,
  };
  const userQuestion: KimiExternalTool = {
    name: 'lion_ask_user_question',
    description: 'ask the user a question',
    parameters: { type: 'object', properties: { question: { type: 'string' } } },
    handler: vi.fn(async () => ({ output: 'user answered', message: 'ok' })),
  };
  const catalog: KimiExternalTool = {
    name: 'mcp__google_calendar__list_events',
    description: 'list calendar events',
    parameters: { type: 'object', properties: {} },
    handler: vi.fn(async () => ({ output: 'events', message: 'ok' })),
  };
  return { tools: [subagent, userQuestion, catalog], subagentHandler };
}


describe('mcp-http-bridge integration (B6, full proven sequence over loopback)', () => {
  const live: KimiMcpBridge[] = [];

  afterEach(async () => {
    for (const b of live.splice(0)) {
      await b.stop();
    }
    vi.restoreAllMocks();
  });

  it('drives initialize -> notifications -> GET-SSE -> tools/list -> tools/call -> errors -> stop end to end', async () => {
    const { tools, subagentHandler } = buildFakeTools();
    const registry = getKimiBridgeRegistry();
    const sizeBefore = registry.size();

    const bridge = await startKimiMcpBridge({ tools, serverName: 'LionClaw Bridge' });
    live.push(bridge);

    expect(registry.size()).toBe(sizeBefore + 1);

    const parsedUrl = new URL(bridge.url);
    expect(parsedUrl.hostname).toBe('127.0.0.1');
    expect(parsedUrl.hostname).not.toBe('0.0.0.0');
    expect(parsedUrl.pathname).toBe('/mcp');
    const port = portFromUrl(bridge.url);
    expect(port).toBeGreaterThan(0);

    const initRes = await request(bridge.url, {
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
    expect(initRes.status).toBe(200);
    const initParsed = JSON.parse(initRes.body);
    expect(initParsed.result.protocolVersion).toBe('2025-11-25');
    expect(initParsed.result.capabilities.tools).toBeDefined();
    expect(initParsed.result.serverInfo.name).toBe('LionClaw Bridge');
    const sessionId = String(initRes.headers['mcp-session-id'] ?? '');
    expect(sessionId.length).toBeGreaterThan(0);

    const notifRes = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token, { 'Mcp-Session-Id': sessionId }),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(notifRes.status).toBe(202);
    expect(notifRes.body).toBe('');

    const sse = await openSse(bridge.url, authHeaders(bridge.token, { 'Mcp-Session-Id': sessionId }));
    try {
      expect(sse.status).toBe(200);
      expect(sse.contentType).toContain('text/event-stream');
      expect(sse.firstChunk).toContain(': open');
      await new Promise((r) => setImmediate(r));
      expect(sse.res.complete).toBe(false);
    } finally {
      sse.req.destroy();
    }

    const listRes = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token, { 'Mcp-Session-Id': sessionId }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(listRes.status).toBe(200);
    const listParsed = JSON.parse(listRes.body);
    expect(listParsed.result.tools).toHaveLength(tools.length);
    for (const item of listParsed.result.tools) {
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('description');
      expect(item).toHaveProperty('inputSchema');
    }
    expect(listParsed.result.tools.map((t: { name: string }) => t.name)).toEqual(
      tools.map((t) => t.name),
    );

    const callRes = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token, { 'Mcp-Session-Id': sessionId }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'lion_run_subagent', arguments: { agentId: 'x', prompt: 'y' } },
      }),
    });
    expect(callRes.status).toBe(200);
    const callParsed = JSON.parse(callRes.body);
    expect(callParsed.result.content[0].text).toBe(SUBAGENT_OUTPUT);
    expect(subagentHandler).toHaveBeenCalledTimes(1);
    expect(subagentHandler).toHaveBeenCalledWith(
      { agentId: 'x', prompt: 'y' },
      {
        transportCorrelation: { kind: 'mcp-request-id', value: '3' },
        signal: expect.any(AbortSignal),
      },
    );

    const unknownTool = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token, { 'Mcp-Session-Id': sessionId }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'no_such_tool', arguments: {} },
      }),
    });
    expect(unknownTool.status).toBe(200);
    expect(JSON.parse(unknownTool.body).error.code).toBe(-32602);

    const unknownMethod = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token, { 'Mcp-Session-Id': sessionId }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'frobnicate' }),
    });
    expect(unknownMethod.status).toBe(200);
    expect(JSON.parse(unknownMethod.body).error.code).toBe(-32601);

    const noToken = await request(bridge.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'initialize', params: {} }),
    });
    expect(noToken.status).toBe(401);

    const wrongToken = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders('not-the-real-token'),
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }),
    });
    expect(wrongToken.status).toBe(401);

    const rightToken = await request(bridge.url, {
      method: 'POST',
      headers: authHeaders(bridge.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'initialize', params: {} }),
    });
    expect(rightToken.status).toBe(200);

    await bridge.stop();
    await expectPortRefused(port, bridge.token);
    await expect(bridge.stop()).resolves.toBeUndefined();

    expect(registry.size()).toBe(sizeBefore);

    live.splice(live.indexOf(bridge), 1);
  });

  it('stopAll() stops every live bridge and leaves the registry empty', async () => {
    const registry = getKimiBridgeRegistry();
    expect(registry.size()).toBe(0);

    const ports: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { tools } = buildFakeTools();
      const bridge = await startKimiMcpBridge({ tools });
      ports.push(portFromUrl(bridge.url));
    }
    expect(registry.size()).toBe(3);

    await registry.stopAll();
    expect(registry.size()).toBe(0);

    for (const port of ports) {
      await expectPortRefused(port, 'unused-after-stop');
    }
  });
});
