import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { LionAdapter, LionStreamEvent, LionStreamRequest } from '../adapters/types';

const dbState = vi.hoisted(() => ({
  session: {
    id: 'sess-title',
    title: 'fallback title',
    type: 'chat',
  },
  messages: [
    {
      id: 1,
      sessionId: 'sess-title',
      role: 'user' as const,
      content: 'quero gerar um excalidraw do fluxo',
      createdAt: '2026-05-18T10:00:00.000Z',
    },
    {
      id: 2,
      sessionId: 'sess-title',
      role: 'assistant' as const,
      content: 'vou criar um desenho com mcp_call',
      createdAt: '2026-05-18T10:00:01.000Z',
    },
  ],
  updateSessionTitle: vi.fn(),
}));

vi.mock('../../db', () => ({
  getSession: vi.fn(() => dbState.session),
  getSessionMessages: vi.fn(() => dbState.messages),
  updateSessionTitle: dbState.updateSessionTitle,
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { maybeGenerateLionSessionTitle } from '../title';

function makeAdapter(
  events: LionStreamEvent[],
  name: LionAdapter['name'] = 'lmstudio',
): {
  adapter: LionAdapter;
  requests: LionStreamRequest[];
} {
  const requests: LionStreamRequest[] = [];
  return {
    requests,
    adapter: {
      name,
      async *streamCompletion(req: LionStreamRequest): AsyncIterable<LionStreamEvent> {
        requests.push(req);
        for (const ev of events) yield ev;
      },
    },
  };
}

function makeWindow() {
  return {
    isDestroyed: () => false,
    webContents: {
      send: vi.fn(),
    },
  };
}

describe('Lion-SDK title generation', () => {
  beforeEach(() => {
    dbState.session.title = 'fallback title';
    dbState.messages = dbState.messages.slice(0, 2);
    dbState.updateSessionTitle.mockClear();
  });

  it('uses the same Lion-SDK model selected for chat to generate the first title', async () => {
    const { adapter, requests } = makeAdapter([{ type: 'text', delta: '"Excalidraw MCP Preview."' }, { type: 'done' }]);
    const win = makeWindow();

    await maybeGenerateLionSessionTitle({
      sessionId: 'sess-title',
      adapter,
      model: 'qwen/qwen3.6-27b',
      getWindow: () => win as never,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe('qwen/qwen3.6-27b');
    expect(requests[0]!.tools).toEqual([]);
    expect(requests[0]!.extra).toEqual({ max_tokens: 60, temperature: 0.2 });
    expect(dbState.updateSessionTitle).toHaveBeenCalledWith('sess-title', 'Excalidraw MCP Preview');
    expect(win.webContents.send).toHaveBeenCalledWith('chat:sessions-updated');
  });

  it('uses temperature 1 for Kimi title generation', async () => {
    const { adapter, requests } = makeAdapter(
      [{ type: 'text', delta: 'Onboarding LionClaw' }, { type: 'done' }],
      'openai-compatible',
    );

    await maybeGenerateLionSessionTitle({
      sessionId: 'sess-title',
      adapter,
      model: 'kimi-k2.6',
      getWindow: () => null,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.extra).toEqual({ max_tokens: 60, temperature: 1 });
  });

  it('does not replace an existing title after the first assistant turn', async () => {
    dbState.messages = [
      ...dbState.messages,
      {
        id: 3,
        sessionId: 'sess-title',
        role: 'user' as const,
        content: 'continua',
        createdAt: '2026-05-18T10:00:02.000Z',
      },
      {
        id: 4,
        sessionId: 'sess-title',
        role: 'assistant' as const,
        content: 'continuando',
        createdAt: '2026-05-18T10:00:03.000Z',
      },
    ];
    const { adapter, requests } = makeAdapter([{ type: 'text', delta: 'Novo titulo' }, { type: 'done' }]);

    await maybeGenerateLionSessionTitle({
      sessionId: 'sess-title',
      adapter,
      model: 'qwen/qwen3.6-27b',
      getWindow: () => null,
    });

    expect(requests).toHaveLength(0);
    expect(dbState.updateSessionTitle).not.toHaveBeenCalled();
  });
});
