import { describe, it, expect, beforeAll, beforeEach } from 'vitest';


beforeAll(() => {
  (global as unknown as Record<string, unknown>).window = {
    lionclaw: {
      chat: {
        getSessions: async () => [],
        getMessages: async () => [],
      },
      settings: {
        get: async () => ({ voiceResponseEnabled: false }),
      },
      activity: {
        getBlocks: async () => [],
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

beforeEach(async () => {
  const { useChatStore } = await getStore();
  useChatStore.setState({
    currentSessionId: 's1',
    messages: [],
    streamingContent: '',
    isStreaming: false,
    streamTurnStartedAt: null,
    submittedUserTurnCount: 0,
    assistantTurnCount: 0,
    toolCalls: [],
    artifacts: [],
    activities: [],
  });
});

describe('streamTurnStartedAt (chat-store, I4)', () => {
  it('primeiro chunk de texto do turno (campo null) seta o marcador; segundo chunk preserva', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({ isStreaming: true });

    const before = Date.now();
    useChatStore.getState().handleStreamChunk({ type: 'text', content: 'oi', sessionId: 's1' });
    const after = Date.now();

    const first = useChatStore.getState().streamTurnStartedAt;
    expect(first).not.toBeNull();
    expect(first as number).toBeGreaterThanOrEqual(before);
    expect(first as number).toBeLessThanOrEqual(after);

    useChatStore.getState().handleStreamChunk({ type: 'text', content: 'mais', sessionId: 's1' });
    expect(useChatStore.getState().streamTurnStartedAt).toBe(first);
  });

  it('turno pode abrir com tool_call ou activity — mesmo marcador, set unico', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({ isStreaming: true });

    useChatStore.getState().handleStreamChunk({ type: 'tool_call', tool: 'Bash', input: {}, sessionId: 's1' });
    const viaTool = useChatStore.getState().streamTurnStartedAt;
    expect(viaTool).not.toBeNull();

    useChatStore.getState().handleStreamChunk({
      type: 'activity',
      sessionId: 's1',
      activity: { id: 'a1', kind: 'tool', phase: 'start', label: 'Bash', status: 'running' },
    });
    expect(useChatStore.getState().streamTurnStartedAt).toBe(viaTool);
  });

  it('chunk atrasado com turno NAO streaming nao seta o marcador (guard)', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({ isStreaming: false });

    useChatStore.getState().handleStreamChunk({ type: 'text', content: 'tarde', sessionId: 's1' });
    expect(useChatStore.getState().streamTurnStartedAt).toBeNull();
  });

  it('done LIMPA o marcador (decisao W4: sem congelar, sem lastTurnDurationMs)', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({
      isStreaming: true,
      streamTurnStartedAt: 1234,
      submittedUserTurnCount: 1,
      assistantTurnCount: 0,
    });

    useChatStore.getState().handleStreamChunk({ type: 'done', sessionId: 's1' });
    await flush();

    expect(useChatStore.getState().streamTurnStartedAt).toBeNull();
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('done em queue mode (queueRemaining>0) tambem limpa — proximo turno re-marca no primeiro chunk (regressao 5)', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({
      isStreaming: true,
      streamTurnStartedAt: 1234,
      submittedUserTurnCount: 2,
      assistantTurnCount: 0,
    });

    useChatStore.getState().handleStreamChunk({ type: 'done', sessionId: 's1', queueRemaining: 1 });
    await flush();

    expect(useChatStore.getState().streamTurnStartedAt).toBeNull();
    expect(useChatStore.getState().isStreaming).toBe(true);

    const before = Date.now();
    useChatStore.getState().handleStreamChunk({ type: 'text', content: 'turno 2', sessionId: 's1' });
    const started = useChatStore.getState().streamTurnStartedAt;
    expect(started).not.toBeNull();
    expect(started as number).toBeGreaterThanOrEqual(before);
  });

  it('error limpa o marcador', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({
      isStreaming: true,
      streamTurnStartedAt: 1234,
      submittedUserTurnCount: 1,
      assistantTurnCount: 0,
    });

    useChatStore.getState().handleStreamChunk({ type: 'error', error: 'boom' });

    expect(useChatStore.getState().streamTurnStartedAt).toBeNull();
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('drive_paused limpa isStreaming + marcador (C-08: escalate/pausa do drive)', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({
      isStreaming: true,
      streamTurnStartedAt: 1234,
    });

    useChatStore.getState().handleStreamChunk({ type: 'drive_paused', sessionId: 's1' });

    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().streamTurnStartedAt).toBeNull();
  });

  it('drive_paused de OUTRA sessao e ignorado (filtro de sessao)', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({
      currentSessionId: 's1',
      isStreaming: true,
      streamTurnStartedAt: 1234,
    });

    useChatStore.getState().handleStreamChunk({ type: 'drive_paused', sessionId: 's_outra' });

    expect(useChatStore.getState().isStreaming).toBe(true);
    expect(useChatStore.getState().streamTurnStartedAt).toBe(1234);
  });
});

describe('streaming coalescido e lifecycle de tools', () => {
  it('done força flush síncrono de todos os deltas pendentes', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({ isStreaming: true, submittedUserTurnCount: 1 });
    for (let index = 0; index < 100; index += 1) {
      useChatStore.getState().handleStreamChunk({ type: 'text', content: String(index % 10), sessionId: 's1' });
    }
    useChatStore.getState().handleStreamChunk({ type: 'done', content: 's1', sessionId: 's1' });
    await flush();
    const message = useChatStore.getState().messages.at(-1);
    expect(message?.content).toHaveLength(100);
  });

  it('tool_result encerra a chamada correta mesmo com o turno ainda streaming', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({ isStreaming: true });
    useChatStore.getState().handleStreamChunk({
      type: 'tool_call', tool: 'Bash', toolCallId: 'tool-1', input: { command: 'pwd' }, sessionId: 's1',
    });
    useChatStore.getState().handleStreamChunk({
      type: 'tool_result', tool: 'Bash', toolCallId: 'tool-1', result: 'ok', sessionId: 's1',
    });
    expect(useChatStore.getState().isStreaming).toBe(true);
    expect(useChatStore.getState().toolCalls).toEqual([
      expect.objectContaining({ id: 'tool-1', tool: 'Bash', status: 'done', result: 'ok' }),
    ]);
  });

  it('resultado legado sem id casa a última chamada running do mesmo nome', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({ isStreaming: true });
    useChatStore.getState().handleStreamChunk({ type: 'tool_call', tool: 'Read', input: { n: 1 }, sessionId: 's1' });
    useChatStore.getState().handleStreamChunk({ type: 'tool_call', tool: 'Read', input: { n: 2 }, sessionId: 's1' });
    useChatStore.getState().handleStreamChunk({ type: 'tool_result', tool: 'Read', result: 'ok', sessionId: 's1' });
    expect(useChatStore.getState().toolCalls.map((call) => call.status)).toEqual(['running', 'done']);
  });
});

describe('deriveTurnStartedAt (rehidratacao, I4)', () => {
  it('deriva o MENOR startedAt entre atividades com status running', async () => {
    const { deriveTurnStartedAt } = await getStore();
    const t1 = '2026-06-09T10:00:05.000Z';
    const t2 = '2026-06-09T10:00:01.000Z'; // menor
    const t3 = '2026-06-09T09:59:00.000Z'; // menor ainda, mas NAO running

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
    useChatStore.setState({
      currentSessionId: 'old',
      streamTurnStartedAt: null,
      activities: [
        { id: 'live1', kind: 'subagent', label: 'orquestrador', status: 'running', startedAt: startedIso },
      ],
    });

    useChatStore.getState().handleStreamChunk({ type: 'session', content: 'new' });
    await flush();

    expect(useChatStore.getState().currentSessionId).toBe('new');
    expect(useChatStore.getState().streamTurnStartedAt).toBe(Date.parse(startedIso));
  });
});
