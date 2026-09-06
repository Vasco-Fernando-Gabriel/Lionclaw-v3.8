
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createLmStudioAdapter } from '../adapters/lmstudio';
import type { LionStreamEvent } from '../adapters/types';

const realFetch = globalThis.fetch;
const servers: Server[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const server of servers.splice(0)) {
    server.close();
  }
});

function sseLine(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n`;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString('utf8');
  }
  return body;
}

async function startSseServer(
  lines: string[],
  onRequest?: (body: Record<string, unknown>, req: IncomingMessage) => void | Promise<void>,
): Promise<string> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestBody = JSON.parse(await readRequestBody(req)) as Record<string, unknown>;
    await onRequest?.(requestBody, req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const line of lines) {
      res.write(line);
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return `http://127.0.0.1:${address.port}`;
}

async function collect(adapter: ReturnType<typeof createLmStudioAdapter>): Promise<LionStreamEvent[]> {
  const out: LionStreamEvent[] = [];
  for await (const ev of adapter.streamCompletion({
    model: 'qwen2.5-7b',
    messages: [{ role: 'user', content: 'hi' }],
  })) {
    out.push(ev);
  }
  return out;
}

describe('LM Studio adapter - S5.2 usage emission', () => {
  it('emits usage event when final SSE chunk includes usage (AC-002-2)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('LM Studio adapter should not use fetch body timeout path');
    }) as unknown as typeof globalThis.fetch;
    const baseUrl = await startSseServer([
      sseLine({ choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }] }),
      sseLine({ choices: [{}], usage: { prompt_tokens: 20, completion_tokens: 15 } }),
      'data: [DONE]\n',
    ]);

    const adapter = createLmStudioAdapter({ baseUrl });
    const events = await collect(adapter);

    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);

    const u = usageEvents[0] as { type: 'usage'; usage: { inputTokens: number; outputTokens: number } };
    expect(u.usage.inputTokens).toBe(20);
    expect(u.usage.outputTokens).toBe(15);
  });

  it('request body includes stream_options.include_usage=true', async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    const baseUrl = await startSseServer(['data: [DONE]\n'], (body) => {
      capturedBodies.push(body);
    });

    const adapter = createLmStudioAdapter({ baseUrl });
    await collect(adapter);

    const capturedBody = capturedBodies[0];
    expect(capturedBody).toBeDefined();
    if (!capturedBody) throw new Error('request body was not captured');
    expect(capturedBody.stream_options).toEqual({ include_usage: true });
  });

  it('does not require apiKey (LM Studio is local)', async () => {
    const baseUrl = await startSseServer(['data: [DONE]\n']);

    const adapter = createLmStudioAdapter({ baseUrl });
    const events = await collect(adapter);
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(0);
  });

  it('emits usage event before done event in event order', async () => {
    const baseUrl = await startSseServer([
      sseLine({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }),
      sseLine({ choices: [{}], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
      'data: [DONE]\n',
    ]);

    const adapter = createLmStudioAdapter({ baseUrl });
    const events = await collect(adapter);

    const usageIdx = events.findIndex((e) => e.type === 'usage');
    const doneIdx = events.findIndex((e) => e.type === 'done');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(usageIdx);
  });
});
