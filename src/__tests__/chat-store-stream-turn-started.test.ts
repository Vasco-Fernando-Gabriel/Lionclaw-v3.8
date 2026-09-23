import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { ActivityTurnBlock } from '@/types';

let blocksBySession: Record<string, ActivityTurnBlock[]> = {};

beforeAll(() => {
  (global as unknown as Record<string, unknown>).window = {
    lionclaw: {
      chat: {
        getSessions: async () => [],
        getMessages: async () => [],
        listOpenSessions: async () => [],
      },
      settings: {
        get: async () => ({ voiceResponseEnabled: false }),
      },
      activity: {
        getBlocks: async (sessionId: string) => blocksBySession[sessionId] ?? [],
      },
      pricing: {
        calculate: async () => ({ costUsd: null }),
      },
    },
  };
});

async function getStore() {
  const mod = await import('@/stores/chat-store');
  return mod;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function setThread(
  sessionId: string,
  over: Parameters<typeof import('@/stores/chat-store').createThreadState>[0],
) {
  const { useChatStore, createThreadState } = await getStore();
  useChatStore.setState((state) => ({
    threads: { ...state.threads, [sessionId]: createThreadState({ hydrated: true, ...over }) },
  }));
}

async function thread(sessionId = 's1') {
  const { useChatStore } = await getStore();
  return useChatStore.getState().threads[sessionId];
}

beforeEach(async () => {
  const { useChatStore, createThreadState } = await getStore();
  blocksBySession = {};
  useChatStore.setState({
    currentSessionId: 's1',
    threads: { s1: createThreadState({ hydrated: true }) },
    streamingSessionIds: new Set(),
  });
});

describe('streamTurnStartedAt (chat-store, I4)', () => {
  it('primeiro chunk de texto do turno (campo null) seta o marcador; segundo chunk preserva', async () => {
    const { useChatStore } = await getStore();
    await setThread('s1', { isStreaming: true });

    const before = Date.now();
    useChatStore.getState().handleStreamChunk({ type: 'text', content: 'oi', sessionId: 's1' });
    const after = Date.now();

    const first = (await thread()).streamTurnStartedAt;
    expect(first).not.toBeNull();
    expect(first as number).toBeGreaterThanOrEqual(before);
    expect(first as number).toBeLessThanOrEqual(after);

    useChatStore.getState().handleStreamChunk({ type: 'text', content: 'mais', sessionId: 's1' });
    expect((await thread()).streamTurnStartedAt).toBe(first);
  });

  it('turno pode abrir com tool_call ou activity, mesmo marcador, set unico', async () => {
    const { useChatStore } = await getStore();
    await setThread('s1', { isStreaming: true });

    useChatStore.getState().handleStreamChunk({ type: 'tool_call', tool: 'Bash', input: {}, sessionId: 's1' });
    const viaTool = (await thread()).streamTurnStartedAt;
    expect(viaTool).not.toBeNull();

    useChatStore.getState().handleStreamChunk({
      type: 'activity',
      sessionId: 's1',
      activity: { id: 'a1', kind: 'tool', phase: 'start', label: 'Bash', status: 'running' },
    });
    expect((await thread()).streamTurnStartedAt).toBe(viaTool);
  });

  it('chunk atrasado com turno NAO streaming nao seta o marcador (guard)', async () => {
    const { useChatStore } = await getStore();
    await setThread('s1', { isStreaming: false });

    useChatStore.getState().handleStreamChunk({ type: 'text', content: 'tarde', sessionId: 's1' });
    expect((await thread()).streamTurnStartedAt).toBeNull();
  });

  it('done LIMPA o marcador (decisao W4: sem congelar, sem lastTurnDurationMs)', async () => {
    const { useChatStore } = await getStore();
    await setThread('s1', {
      isStreaming: true,
      streamTurnStartedAt: 1234,
      submittedUserTurnCount: 1,
      assistantTurnCount: 0,
    });

    useChatStore.getState().handleStreamChunk({ type: 'done', sessionId: 's1' });
    await flush();

    expect((await thread()).streamTurnStartedAt).toBeNull();
    expect((await thread()).isStreaming).toBe(false);
  });

  it('done em queue mode (queueRemaining>0) tambem limpa; proximo turno re-marca no primeiro chunk (regressao 5)', async () => {
    const { useChatStore } = await getStore();
    await setThread('s1', {
      isStreaming: true,
      streamTurnStartedAt: 1234,
      submittedUserTurnCount: 2,
      assistantTurnCount: 0,
    });

    useChatStore.getState().handleStreamChunk({ type: 'done', sessionId: 's1', queueRemaining: 1 });
    await flush();

    expect((await thread()).streamTurnStartedAt).toBeNull();
    expect((await thread()).isStreaming).toBe(true);
    expect((await thread()).queueRemaining).toBe(1);

    const before = Date.now();
    useChatStore.getState().handleStreamChunk({ type: 'text', content: 'turno 2', sessionId: 's1' });
    const started = (await thread()).streamTurnStartedAt;
    expect(started).not.toBeNull();
    expect(started as number).toBeGreaterThanOrEqual(before);
  });

  it('error limpa o marcador', async () => {
    const { useChatStore } = await getStore();
    await setThread('s1', {
      isStreaming: true,
      streamTurnStartedAt: 1234,
      submittedUserTurnCount: 1,
      assistantTurnCount: 0,
    });

    useChatStore.getState().handleStreamChunk({ type: 'error', sessionId: 's1', error: 'boom' });

    expect((await thread()).streamTurnStartedAt).toBeNull();
    expect((await thread()).isStreaming).toBe(false);
  });

  it('drive_paused preserva isStreaming + marcador (C-08: escalate/pausa do drive)', async () => {
    const { useChatStore } = await getStore();
    await setThread('s1', { isStreaming: true, streamTurnStartedAt: 1234 });

    useChatStore.getState().handleStreamChunk({ type: 'drive_paused', sessionId: 's1' });

    expect((await thread()).isStreaming).toBe(true);
    expect((await thread()).drivePaused).toBe(true);
    expect((await thread()).streamTurnStartedAt).toBe(1234);
  });

  it('drive_paused de OUTRA sessao afeta so a thread dela (filtro de sessao)', async () => {
    const { useChatStore } = await getStore();
    await setThread('s1', { isStreaming: true, streamTurnStartedAt: 1234 });
    await setThread('s_outra', { isStreaming: true, streamTurnStartedAt: 99 });
    useChatStore.setState({ streamingSessionIds: new Set(['s1', 's_outra']) });

    useChatStore.getState().handleStreamChunk({ type: 'drive_paused', sessionId: 's_outra' });

    expect((await thread()).isStreaming).toBe(true);
    expect((await thread()).streamTurnStartedAt).toBe(1234);
    expect((await thread('s_outra')).isStreaming).toBe(true);
    expect((await thread('s_outra')).streamTurnStartedAt).toBe(99);
    expect((await thread('s_outra')).drivePaused).toBe(true);
    expect((await thread()).drivePaused).toBe(false);
    expect(useChatStore.getState().streamingSessionIds.has('s1')).toBe(true);
    expect(useChatStore.getState().streamingSessionIds.has('s_outra')).toBe(true);
  });
});

describe('streaming coalescido e lifecycle de tools', () => {
  it('done forca flush sincrono de todos os deltas pendentes', async () => {
    const { useChatStore } = await getStore();
    await setThread('s1', { isStreaming: true, submittedUserTurnCount: 1 });
    for (let index = 0; index < 100; index += 1) {
      useChatStore.getState().handleStreamChunk({ type: 'text', content: String(index % 10), sessionId: 's1' });
    }
    useChatStore.getState().handleStreamChunk({ type: 'done', content: 's1', sessionId: 's1' });
    await flush();
    const message = (await thread()).messages.at(-1);
    expect(message?.content).toHaveLength(100);
  });

  it('tool_result encerra a chamada correta mesmo com o turno ainda streaming', async () => {
    const { useChatStore } = await getStore();
    await setThread('s1', { isStreaming: true });
    useChatStore.getState().handleStreamChunk({
      type: 'tool_call',
      tool: 'Bash',
      toolCallId: 'tool-1',
      input: { command: 'pwd' },
      sessionId: 's1',
    });
    useChatStore.getState().handleStreamChunk({
      type: 'tool_result',
      tool: 'Bash',
      toolCallId: 'tool-1',
      result: 'ok',
      sessionId: 's1',
    });
    expect((await thread()).isStreaming).toBe(true);
    expect((await thread()).toolCalls).toEqual([
      expect.objectContaining({ id: 'tool-1', tool: 'Bash', status: 'done', result: 'ok' }),
    ]);
  });

  it('resultado legado sem id casa a ultima chamada running do mesmo nome', async () => {
    const { useChatStore } = await getStore();
    await setThread('s1', { isStreaming: true });
    useChatStore.getState().handleStreamChunk({ type: 'tool_call', tool: 'Read', input: { n: 1 }, sessionId: 's1' });
    useChatStore.getState().handleStreamChunk({ type: 'tool_call', tool: 'Read', input: { n: 2 }, sessionId: 's1' });
    useChatStore.getState().handleStreamChunk({ type: 'tool_result', tool: 'Read', result: 'ok', sessionId: 's1' });
    expect((await thread()).toolCalls.map((call) => call.status)).toEqual(['running', 'done']);
  });
});

describe('deriveTurnStartedAt (rehidratacao, I4)', () => {
  it('deriva o MENOR startedAt entre atividades com status running', async () => {
    const { deriveTurnStartedAt } = await getStore();
    const t1 = '2026-06-09T10:00:05.000Z';
    const t2 = '2026-06-09T10:00:01.000Z';
    const t3 = '2026-06-09T09:59:00.000Z';

    const result = deriveTurnStartedAt([
      { id: 'a', kind: 'tool', label: 'Bash', status: 'running', startedAt: t1 },
      { id: 'b', kind: 'subagent', label: 'coder', status: 'running', startedAt: t2 },
      { id: 'c', kind: 'tool', label: 'Read', status: 'done', startedAt: t3 },
    ]);
    expect(result).toBe(Date.parse(t2));
  });

  it('ignora running sem startedAt ou com timestamp invalido; null quando nada vivo', async () => {
    const { deriveTurnStartedAt } = await getStore();
    expect(
      deriveTurnStartedAt([
        { id: 'a', kind: 'tool', label: 'Bash', status: 'running' },
        { id: 'b', kind: 'tool', label: 'Read', status: 'running', startedAt: 'nao-e-data' },
        { id: 'c', kind: 'tool', label: 'Edit', status: 'stopped', startedAt: '2026-06-09T10:00:00.000Z' },
      ]),
    ).toBeNull();
    expect(deriveTurnStartedAt([])).toBeNull();
  });

  it('rehidratacao via chunk session com turno vivo preservado deriva o inicio das atividades running', async () => {
    const { useChatStore } = await getStore();
    const startedIso = '2026-06-09T10:00:00.000Z';
    await setThread('new', {
      streamTurnStartedAt: null,
      activities: [{ id: 'live1', kind: 'subagent', label: 'orquestrador', status: 'running', startedAt: startedIso }],
    });

    useChatStore.getState().handleStreamChunk({ type: 'session', content: 'new', sessionId: 'new' });
    await flush();

    expect(useChatStore.getState().currentSessionId).toBe('s1');
    expect((await thread('new')).isStreaming).toBe(true);
    expect((await thread('new')).streamTurnStartedAt).toBe(Date.parse(startedIso));
  });
});
