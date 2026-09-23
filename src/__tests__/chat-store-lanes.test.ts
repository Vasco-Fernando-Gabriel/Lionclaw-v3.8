import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { ChatClearResult, ChatSession, OpenChatSession } from '@/types';

interface Calls {
  send: Array<{ message: string; options: Record<string, unknown> | undefined }>;
  stop: Array<string | undefined>;
  clear: Array<{ sessionId: string; opts: { force?: boolean } | undefined }>;
  createSession: number;
}

const calls: Calls = { send: [], stop: [], clear: [], createSession: 0 };
let openLanes: OpenChatSession[] = [];
let listOpenSessionsError: string | null = null;
let sessions: ChatSession[] = [];
let clearResult: ChatClearResult = {
  ok: true,
  sessionId: 'a',
  newSessionId: 'a2',
  warnings: [],
  pausedDriveProjectIds: [],
};
let nextCreatedId = 'created-1';

function lane(id: string, laneBadge: number, over: Partial<OpenChatSession> = {}): OpenChatSession {
  return {
    id,
    laneBadge,
    title: `Lane ${laneBadge}`,
    orchestrator: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-sonnet-4-6' },
    messageCount: 2,
    lastUserMessageAt: '2026-09-08T10:00:00.000Z',
    createdAt: '2026-09-08T09:00:00.000Z',
    updatedAt: '2026-09-08T10:00:00.000Z',
    state: 'idle',
    drive: null,
    ...over,
  };
}

function session(id: string, over: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    status: 'active',
    type: 'chat',
    createdAt: '2026-09-08T09:00:00.000Z',
    updatedAt: '2026-09-08T10:00:00.000Z',
    ...over,
  };
}

beforeAll(() => {
  (global as unknown as Record<string, unknown>).window = {
    lionclaw: {
      chat: {
        getSessions: async () => sessions,
        getMessages: async () => [],
        getContextUsage: async () => null,
        listOpenSessions: async () => (listOpenSessionsError ? { error: listOpenSessionsError } : openLanes),
        createSession: async () => {
          calls.createSession += 1;
          const created = lane(nextCreatedId, openLanes.length + 1, { messageCount: 0, lastUserMessageAt: null });
          openLanes = [...openLanes, created];
          return { session: created };
        },
        send: async (message: string, options?: Record<string, unknown>) => {
          calls.send.push({ message, options });
          return { accepted: true };
        },
        stop: async (sessionId?: string) => {
          calls.stop.push(sessionId);
        },
        clear: async (sessionId: string, opts?: { force?: boolean }) => {
          calls.clear.push({ sessionId, opts });
          return clearResult;
        },
        clearCancel: async (sessionId: string) => ({ ok: true, sessionId }),
        deleteSession: async () => ({ success: true }),
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

async function getStores() {
  const chat = await import('@/stores/chat-store');
  const toast = await import('@/stores/error-toast-store');
  return {
    useChatStore: chat.useChatStore,
    createThreadState: chat.createThreadState,
    selectThread: chat.selectThread,
    useErrorToastStore: toast.useErrorToastStore,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function thread(id: string) {
  const { useChatStore, selectThread } = await getStores();
  return selectThread(useChatStore.getState(), id);
}

beforeEach(async () => {
  const { useChatStore, useErrorToastStore } = await getStores();
  calls.send = [];
  calls.stop = [];
  calls.clear = [];
  calls.createSession = 0;
  openLanes = [];
  listOpenSessionsError = null;
  sessions = [];
  nextCreatedId = 'created-1';
  clearResult = { ok: true, sessionId: 'a', newSessionId: 'a2', warnings: [], pausedDriveProjectIds: [] };
  useErrorToastStore.getState().clearToasts();
  useChatStore.setState({
    sessions: [],
    openLanes: [],
    compactingSessionIds: new Set(),
    compactions: {},
    newChatDialogOpen: false,
    currentSessionId: null,
    threads: {},
    streamingSessionIds: new Set(),
    onboardingAutostartSessionId: null,
  });
});

describe('5.3: sendMessage cria a lane antes do primeiro envio e sempre manda sessionId', () => {
  it('sem lane nenhuma: chama chat:create-session e envia com o sessionId criado', async () => {
    const { useChatStore } = await getStores();
    await useChatStore.getState().sendMessage('Ola! Vamos comecar.');

    expect(calls.createSession).toBe(1);
    expect(calls.send).toHaveLength(1);
    expect(calls.send[0].options?.sessionId).toBe('created-1');
    expect(useChatStore.getState().currentSessionId).toBe('created-1');
    expect((await thread('created-1')).messages[0]?.sessionId).toBe('created-1');
  });

  it('com lane visivel: nao cria e envia o sessionId da lane', async () => {
    const { useChatStore } = await getStores();
    openLanes = [lane('a', 1)];
    sessions = [session('a', { laneBadge: 1 })];
    useChatStore.setState({ openLanes, sessions, currentSessionId: 'a' });

    await useChatStore.getState().sendMessage('oi');

    expect(calls.createSession).toBe(0);
    expect(calls.send[0].options?.sessionId).toBe('a');
  });

  it('currentSessionId null com lane existente: seleciona a mais recente em vez de criar outra', async () => {
    const { useChatStore } = await getStores();
    openLanes = [lane('a', 1, { lastUserMessageAt: '2026-09-01T00:00:00.000Z' }), lane('b', 2)];

    await useChatStore.getState().sendMessage('oi');

    expect(calls.createSession).toBe(0);
    expect(calls.send[0].options?.sessionId).toBe('b');
  });

  it('P2-2 (5.3/RM7): sessao visivel "aberta sem lane" recusa com lane_required, sem criar lane nem enviar', async () => {
    const { useChatStore, useErrorToastStore } = await getStores();
    sessions = [session('old', { laneBadge: null })];
    useChatStore.setState({ sessions, currentSessionId: 'old' });

    await useChatStore.getState().sendMessage('oi');

    expect(calls.createSession).toBe(0);
    expect(calls.send).toHaveLength(0);
    expect(useChatStore.getState().currentSessionId).toBe('old');
    expect((await thread('old')).isStreaming).toBe(false);
    const toasts = useErrorToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('Conversa aberta sem lane');
  });

  it('P2-4 (RM7): listOpenSessions com { error } mantem openLanes anterior e avisa', async () => {
    const { useChatStore, useErrorToastStore } = await getStores();
    const previous = [lane('a', 1)];
    useChatStore.setState({ openLanes: previous });
    listOpenSessionsError = 'SQLITE_BUSY';

    const result = await useChatStore.getState().loadOpenLanes();

    expect(result).toBe(previous);
    expect(useChatStore.getState().openLanes).toBe(previous);
    const toasts = useErrorToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('Nao foi possivel carregar as lanes: SQLITE_BUSY');
  });

  it('ack recusado com codigo tipado vira toast e nao deixa isStreaming preso', async () => {
    const { useChatStore, useErrorToastStore } = await getStores();
    openLanes = [lane('a', 1)];
    useChatStore.setState({ openLanes, currentSessionId: 'a' });
    const w = (global as unknown as { window: { lionclaw: { chat: Record<string, unknown> } } }).window;
    const original = w.lionclaw.chat.send;
    w.lionclaw.chat.send = async () => ({
      accepted: false,
      code: 'session_clearing',
      error: 'Esta lane esta em Clear.',
    });
    try {
      await useChatStore.getState().sendMessage('oi');
      expect((await thread('a')).isStreaming).toBe(false);
      expect(useChatStore.getState().streamingSessionIds.has('a')).toBe(false);
      const toasts = useErrorToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].title).toBe('Lane em Clear');
    } finally {
      w.lionclaw.chat.send = original;
    }
  });

  it('stopStreaming envia o sessionId da lane visivel (ou o pedido) e para SO aquela thread', async () => {
    const { useChatStore, createThreadState } = await getStores();
    useChatStore.setState({
      currentSessionId: 'a',
      threads: { a: createThreadState({ isStreaming: true }), b: createThreadState({ isStreaming: true }) },
      streamingSessionIds: new Set(['a', 'b']),
    });
    await useChatStore.getState().stopStreaming();
    expect(calls.stop).toEqual(['a']);
    expect((await thread('a')).isStreaming).toBe(false);
    expect((await thread('b')).isStreaming).toBe(true);

    await useChatStore.getState().stopStreaming('b');
    expect(calls.stop).toEqual(['a', 'b']);
    expect((await thread('b')).isStreaming).toBe(false);
    expect(useChatStore.getState().streamingSessionIds.size).toBe(0);
  });
});

describe('AC-9 / 6.9: compactingSessionIds por sessao', () => {
  it('compaction:active com sessionId marca so aquela lane; isActive false limpa', async () => {
    const { useChatStore, createThreadState } = await getStores();
    useChatStore.setState({ threads: { b: createThreadState() } });
    useChatStore
      .getState()
      .setCompactionActive({ isActive: true, sessionId: 'b', phase: 'queued', modelLabel: 'haiku' });
    expect(useChatStore.getState().compactingSessionIds.has('b')).toBe(true);
    expect(useChatStore.getState().compactingSessionIds.has('a')).toBe(false);
    expect(useChatStore.getState().compactions.b).toEqual({ phase: 'queued', modelLabel: 'haiku', source: 'lionclaw' });
    expect((await thread('b')).isCompacting).toBe(true);
    expect((await thread('b')).compactionPhase).toBe('queued');
    expect((await thread('b')).compactionModelLabel).toBe('haiku');

    useChatStore
      .getState()
      .setCompactionActive({ isActive: true, sessionId: 'b', phase: 'running', modelLabel: 'haiku' });
    expect(useChatStore.getState().compactions.b?.phase).toBe('running');
    expect((await thread('b')).compactionPhase).toBe('running');

    useChatStore.getState().setCompactionActive({ isActive: false, sessionId: 'b' });
    expect(useChatStore.getState().compactingSessionIds.size).toBe(0);
    expect(useChatStore.getState().compactions.b).toBeUndefined();
    expect((await thread('b')).isCompacting).toBe(false);
  });

  it('chunk compacting de OUTRA lane nao afeta a visivel (isReadOnly por lane)', async () => {
    const { useChatStore, createThreadState } = await getStores();
    useChatStore.setState({ currentSessionId: 'a', threads: { a: createThreadState(), b: createThreadState() } });
    useChatStore.getState().handleStreamChunk({ type: 'compacting', sessionId: 'b', isCompacting: true });
    const state = useChatStore.getState();
    expect(state.compactingSessionIds.has('b')).toBe(true);
    expect(state.compactingSessionIds.has('a')).toBe(false);
    expect(state.compactions.b?.source).toBe('sdk');
    expect((await thread('a')).isCompacting).toBe(false);
    expect((await thread('b')).isCompacting).toBe(true);

    useChatStore.getState().handleStreamChunk({ type: 'compacting', sessionId: 'b', isCompacting: false });
    expect(useChatStore.getState().compactingSessionIds.size).toBe(0);
  });

  it('cancelClear remove a lane do conjunto', async () => {
    const { useChatStore } = await getStores();
    useChatStore.getState().setCompactionActive({ isActive: true, sessionId: 'b', phase: 'queued' });
    await useChatStore.getState().cancelClear('b');
    expect(useChatStore.getState().compactingSessionIds.has('b')).toBe(false);
  });
});

describe('AC-19: error de outra sessao nao derruba isStreaming da visivel', () => {
  it('chunk error com sessionId diferente vira toast rotulado, encerra so a thread B e mantem A streamando', async () => {
    const { useChatStore, useErrorToastStore, createThreadState } = await getStores();
    useChatStore.setState({
      openLanes: [lane('a', 1), lane('b', 2, { title: 'Bug do login' })],
      currentSessionId: 'a',
      threads: {
        a: createThreadState({ isStreaming: true, submittedUserTurnCount: 1, assistantTurnCount: 0 }),
        b: createThreadState({ isStreaming: true, submittedUserTurnCount: 1, assistantTurnCount: 0 }),
      },
      streamingSessionIds: new Set(['a', 'b']),
    });

    useChatStore.getState().handleStreamChunk({ type: 'error', sessionId: 'b', code: 'LLM-EMPTY', error: 'vazio' });

    expect((await thread('a')).isStreaming).toBe(true);
    expect((await thread('a')).lastAssistantTurnEvent).toBeNull();
    expect((await thread('a')).lastError).toBeNull();
    expect((await thread('b')).isStreaming).toBe(false);
    expect((await thread('b')).lastAssistantTurnEvent?.status).toBe('error');
    expect((await thread('b')).lastError?.code).toBe('LLM-EMPTY');
    expect(useChatStore.getState().streamingSessionIds.has('a')).toBe(true);
    expect(useChatStore.getState().streamingSessionIds.has('b')).toBe(false);
    const toasts = useErrorToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('Lane 2: Bug do login: erro no turno');
  });

  it('chunk error da sessao visivel continua encerrando o turno', async () => {
    const { useChatStore, createThreadState } = await getStores();
    useChatStore.setState({
      currentSessionId: 'a',
      threads: { a: createThreadState({ isStreaming: true, submittedUserTurnCount: 1, assistantTurnCount: 0 }) },
    });
    useChatStore.getState().handleStreamChunk({ type: 'error', sessionId: 'a', error: 'x' });
    expect((await thread('a')).isStreaming).toBe(false);
  });
});

describe('10.2: chunk session de outra lane nao sequestra a tela', () => {
  it('usuario na lane B: session de A nao muda currentSessionId e marca A como streamando', async () => {
    const { useChatStore } = await getStores();
    openLanes = [lane('a', 1), lane('b', 2)];
    useChatStore.setState({ openLanes, currentSessionId: 'b' });

    useChatStore.getState().handleStreamChunk({ type: 'session', content: 'a', sessionId: 'a' });
    await flush();

    expect(useChatStore.getState().currentSessionId).toBe('b');
    expect((await thread('a')).isStreaming).toBe(true);
    expect(useChatStore.getState().streamingSessionIds.has('a')).toBe(true);
  });

  it('session de lane desconhecida recarrega openLanes sem trocar a tela', async () => {
    const { useChatStore } = await getStores();
    useChatStore.setState({ openLanes: [lane('b', 2)], currentSessionId: 'b' });
    openLanes = [lane('b', 2), lane('c', 1)];

    useChatStore.getState().handleStreamChunk({ type: 'session', content: 'c', sessionId: 'c' });
    await flush();

    expect(useChatStore.getState().currentSessionId).toBe('b');
    expect(useChatStore.getState().openLanes.map((l) => l.id)).toEqual(['b', 'c']);
  });

  it('currentSessionId null: session e aceito e seleciona a lane', async () => {
    const { useChatStore } = await getStores();
    openLanes = [lane('a', 1)];
    useChatStore.getState().handleStreamChunk({ type: 'session', content: 'a', sessionId: 'a' });
    await flush();
    expect(useChatStore.getState().currentSessionId).toBe('a');
    expect(useChatStore.getState().streamingSessionIds.has('a')).toBe(true);
  });
});

describe('10.1 / 10.5: isStreaming por thread; a visivel nao herda o estado da outra', () => {
  it('envia em A, seleciona B, A termina -> thread A idle, thread B nunca esteve streamando', async () => {
    const { useChatStore } = await getStores();
    openLanes = [lane('a', 1), lane('b', 2)];
    useChatStore.setState({ openLanes, currentSessionId: 'a' });

    await useChatStore.getState().sendMessage('oi A');
    expect((await thread('a')).isStreaming).toBe(true);
    expect(useChatStore.getState().streamingSessionIds.has('a')).toBe(true);

    await useChatStore.getState().selectSession('b');
    expect((await thread('a')).isStreaming).toBe(true);
    expect((await thread('b')).isStreaming).toBe(false);

    useChatStore.getState().handleStreamChunk({ type: 'done', sessionId: 'a', queueRemaining: 0 });
    await flush();

    const state = useChatStore.getState();
    expect(state.currentSessionId).toBe('b');
    expect((await thread('a')).isStreaming).toBe(false);
    expect((await thread('a')).streamTurnStartedAt).toBeNull();
    expect(state.streamingSessionIds.size).toBe(0);
  });

  it('error da lane em streaming enquanto outra e visivel zera SO a thread dela e vira toast rotulado', async () => {
    const { useChatStore, useErrorToastStore, createThreadState } = await getStores();
    useChatStore.setState({
      openLanes: [lane('a', 1), lane('b', 2)],
      currentSessionId: 'b',
      threads: { a: createThreadState({ isStreaming: true, streamTurnStartedAt: 123 }) },
      streamingSessionIds: new Set(['a']),
    });

    useChatStore.getState().handleStreamChunk({ type: 'error', sessionId: 'a', error: 'boom' });

    expect((await thread('a')).isStreaming).toBe(false);
    expect((await thread('a')).streamTurnStartedAt).toBeNull();
    expect(useChatStore.getState().streamingSessionIds.has('a')).toBe(false);
    expect(useErrorToastStore.getState().toasts[0].title).toBe('Lane 1: Lane 1: erro no turno');
  });

  it('cada lane tem a propria fila: envio em B enquanto A roda nao entra na fila de A', async () => {
    const { useChatStore } = await getStores();
    openLanes = [lane('a', 1), lane('b', 2)];
    useChatStore.setState({ openLanes, currentSessionId: 'a' });
    await useChatStore.getState().sendMessage('oi A');
    await useChatStore.getState().selectSession('b');
    await useChatStore.getState().sendMessage('oi B');

    expect(calls.send[1].options?.sessionId).toBe('b');
    expect((await thread('b')).isStreaming).toBe(true);
    expect((await thread('b')).queueRemaining).toBe(0);
    expect((await thread('a')).queueRemaining).toBe(0);
    expect(useChatStore.getState().streamingSessionIds).toEqual(new Set(['a', 'b']));

    await useChatStore.getState().sendMessage('segunda em B');
    expect((await thread('b')).queueRemaining).toBe(1);
    expect((await thread('b')).submittedUserTurnCount).toBe(2);

    useChatStore.getState().handleStreamChunk({ type: 'done', sessionId: 'b', queueRemaining: 1 });
    await flush();
    expect((await thread('b')).isStreaming).toBe(true);
    expect((await thread('b')).queueRemaining).toBe(1);

    useChatStore.getState().handleStreamChunk({ type: 'session', content: 'b', sessionId: 'b' });
    await flush();
    expect((await thread('b')).queueRemaining).toBe(0);
    expect((await thread('a')).isStreaming).toBe(true);
  });

  it('isDreaming e por thread: selectSession e createLane nao apagam o da lane anterior', async () => {
    const { useChatStore, createThreadState } = await getStores();
    useChatStore.setState({
      currentSessionId: 'a',
      threads: { a: createThreadState({ isDreaming: true, hydrated: true }) },
    });
    await useChatStore.getState().selectSession('b');
    expect((await thread('b')).isDreaming).toBe(false);
    expect((await thread('a')).isDreaming).toBe(true);

    await useChatStore.getState().createLane();
    expect((await thread('created-1')).isDreaming).toBe(false);
    expect((await thread('a')).isDreaming).toBe(true);
  });
});

describe('P3-3 (10.7): autostart do onboarding so na primeira lane', () => {
  it('segunda chamada nao reenvia; o sessionId da lane fica guardado', async () => {
    const { useChatStore } = await getStores();
    await useChatStore.getState().runOnboardingAutostart('Ola! Vamos comecar.');
    expect(calls.send).toHaveLength(1);
    expect(useChatStore.getState().onboardingAutostartSessionId).toBe('created-1');

    await useChatStore.getState().createLane();
    await useChatStore.getState().runOnboardingAutostart('Ola! Vamos comecar.');
    expect(calls.send).toHaveLength(1);

    useChatStore.getState().resetOnboardingAutostart();
    expect(useChatStore.getState().onboardingAutostartSessionId).toBeNull();
  });
});

describe('6.6: selecao apos o Clear so se a encerrada era a visivel', () => {
  it('Clear da lane visivel seleciona a conversa nova', async () => {
    const { useChatStore, useErrorToastStore, createThreadState } = await getStores();
    openLanes = [lane('a', 1), lane('b', 2)];
    useChatStore.setState({
      openLanes,
      currentSessionId: 'a',
      threads: {
        a: createThreadState({
          hydrated: true,
          messages: [{ id: 1, sessionId: 'a', role: 'user', content: 'x', createdAt: '' }],
        }),
      },
    });

    const result = await useChatStore.getState().clearLane('a');
    await flush();

    expect(result.ok).toBe(true);
    expect(calls.clear).toEqual([{ sessionId: 'a', opts: undefined }]);
    expect(useChatStore.getState().currentSessionId).toBe('a2');
    expect((await thread('a2')).messages).toHaveLength(0);
    expect(useChatStore.getState().threads.a).toBeUndefined();
    const toasts = useErrorToastStore.getState().toasts;
    expect(toasts[0].title).toBe('Lane 1: Lane 1: Clear concluido');
    expect(toasts[0].tone).toBe('success');
  });

  it('Clear de outra lane nao muda a tela', async () => {
    const { useChatStore, createThreadState } = await getStores();
    openLanes = [lane('a', 1), lane('b', 2)];
    clearResult = { ok: true, sessionId: 'b', newSessionId: 'b2', warnings: [], pausedDriveProjectIds: [] };
    const msgs = [{ id: 1, sessionId: 'a', role: 'user' as const, content: 'x', createdAt: '' }];
    useChatStore.setState({
      openLanes,
      currentSessionId: 'a',
      threads: { a: createThreadState({ hydrated: true, messages: msgs }) },
    });

    await useChatStore.getState().clearLane('b');

    expect(useChatStore.getState().currentSessionId).toBe('a');
    expect((await thread('a')).messages).toBe(msgs);
  });

  it('Clear concluido com avisos lista os passos (D3) e forca chega ao main', async () => {
    const { useChatStore, useErrorToastStore } = await getStores();
    openLanes = [lane('a', 1)];
    clearResult = {
      ok: true,
      sessionId: 'a',
      newSessionId: 'a2',
      warnings: [
        { step: 'embeddings', detail: '3 chunks sem vetor' },
        { step: 'graph', detail: 'mgraph off' },
      ],
      pausedDriveProjectIds: ['p1'],
    };
    useChatStore.setState({ openLanes, currentSessionId: 'z' });

    await useChatStore.getState().clearLane('a', { force: true });

    expect(calls.clear[0].opts).toEqual({ force: true });
    const toasts = useErrorToastStore.getState().toasts;
    expect(toasts[0].title).toBe('Lane 1: Lane 1: Clear concluido com avisos');
    expect(toasts[0].body).toContain('embeddings: 3 chunks sem vetor');
    expect(toasts[0].body).toContain('graph: mgraph off');
    expect(toasts[1].title).toBe('Drive pausado');
  });

  it('Clear recusado mantem a lane visivel e mostra a causa', async () => {
    const { useChatStore, useErrorToastStore } = await getStores();
    openLanes = [lane('a', 1)];
    clearResult = { ok: false, code: 'session_busy', error: 'turno em voo' };
    useChatStore.setState({ openLanes, currentSessionId: 'a' });

    const result = await useChatStore.getState().clearLane('a');

    expect(result.ok).toBe(false);
    expect(useChatStore.getState().currentSessionId).toBe('a');
    expect(useErrorToastStore.getState().toasts[0].title).toBe('Lane ocupada');
  });
});

describe('5.5a: startNewChat aplica a regra do Novo Chat sobre openLanes do main', () => {
  it('0 lanes cria; 1 vazia seleciona; N abre o popup', async () => {
    const { useChatStore } = await getStores();

    await useChatStore.getState().startNewChat();
    expect(calls.createSession).toBe(1);
    expect(calls.clear).toHaveLength(0);
    expect(useChatStore.getState().currentSessionId).toBe('created-1');

    openLanes = [lane('empty', 1, { messageCount: 0, lastUserMessageAt: null })];
    useChatStore.setState({ currentSessionId: null });
    await useChatStore.getState().startNewChat();
    expect(calls.createSession).toBe(1);
    expect(useChatStore.getState().currentSessionId).toBe('empty');

    openLanes = [lane('a', 1), lane('b', 2)];
    await useChatStore.getState().startNewChat();
    expect(calls.createSession).toBe(1);
    expect(useChatStore.getState().newChatDialogOpen).toBe(true);
  });

  it('1 lane com mensagens cria a Lane 2', async () => {
    const { useChatStore } = await getStores();
    openLanes = [lane('a', 1)];
    await useChatStore.getState().startNewChat();
    expect(calls.createSession).toBe(1);
    expect(calls.clear).toHaveLength(0);
    expect(useChatStore.getState().openLanes.map((l) => l.laneBadge)).toEqual([1, 2]);
  });

  it('N lanes sem disponivel = aviso, sem popup e sem create', async () => {
    const { useChatStore, useErrorToastStore } = await getStores();
    openLanes = [lane('a', 1, { state: 'streaming' }), lane('b', 2, { messageCount: 0 })];
    await useChatStore.getState().startNewChat();
    expect(calls.createSession).toBe(0);
    expect(useChatStore.getState().newChatDialogOpen).toBe(false);
    expect(useErrorToastStore.getState().toasts[0].title).toBe('Novo Chat indisponivel');
  });
});

describe('chat:session-updated alimenta so a lane afetada', () => {
  it('atualiza a lane existente, a thread dela, e remove quando laneBadge vira null', async () => {
    const { useChatStore, createThreadState } = await getStores();
    useChatStore.setState({
      openLanes: [lane('a', 1), lane('b', 2)],
      sessions: [session('a', { laneBadge: 1 })],
      threads: { a: createThreadState({ messageCount: 2 }) },
    });

    useChatStore.getState().applySessionUpdated({
      sessionId: 'a',
      laneBadge: 1,
      orchestrator: { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-5.5' },
      messageCount: 9,
      state: 'streaming',
    });
    const a = useChatStore.getState().openLanes.find((l) => l.id === 'a');
    expect(a?.messageCount).toBe(9);
    expect(a?.state).toBe('streaming');
    expect(a?.orchestrator?.runtime).toBe('codex-sdk');
    expect(useChatStore.getState().sessions[0].orchestrator?.model).toBe('gpt-5.5');
    expect((await thread('a')).messageCount).toBe(9);
    expect((await thread('a')).orchestrator?.model).toBe('gpt-5.5');

    useChatStore
      .getState()
      .applySessionUpdated({ sessionId: 'a', laneBadge: null, orchestrator: null, messageCount: 9, state: 'idle' });
    expect(useChatStore.getState().openLanes.map((l) => l.id)).toEqual(['b']);
  });
});
