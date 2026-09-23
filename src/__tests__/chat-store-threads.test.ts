import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { ChatMessage, OpenChatSession } from '@/types';

interface Calls {
  getMessages: string[];
  getContextUsage: string[];
  getBlocks: string[];
  askResponse: Array<{ id: string }>;
  confirmResponse: Array<{ id: string; approved: boolean }>;
  stop: Array<string | undefined>;
}

const calls: Calls = {
  getMessages: [],
  getContextUsage: [],
  getBlocks: [],
  askResponse: [],
  confirmResponse: [],
  stop: [],
};
let openLanes: OpenChatSession[] = [];
let serverMessages: Record<string, ChatMessage[]> = {};

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

beforeAll(() => {
  (global as unknown as Record<string, unknown>).window = {
    lionclaw: {
      chat: {
        getSessions: async () => [],
        listOpenSessions: async () => openLanes,
        getMessages: async (id: string) => {
          calls.getMessages.push(id);
          return serverMessages[id] ?? [];
        },
        getContextUsage: async (id: string) => {
          calls.getContextUsage.push(id);
          return null;
        },
        send: async () => ({ accepted: true }),
        stop: async (id?: string) => {
          calls.stop.push(id);
        },
        askResponse: async (response: { id: string }) => {
          calls.askResponse.push(response);
        },
        confirmResponse: async (id: string, approved: boolean) => {
          calls.confirmResponse.push({ id, approved });
        },
      },
      settings: { get: async () => ({ voiceResponseEnabled: false }) },
      activity: {
        getBlocks: async (id: string) => {
          calls.getBlocks.push(id);
          return [];
        },
      },
      pricing: { calculate: async () => ({ costUsd: null }) },
    },
  };
});

async function getStores() {
  const chat = await import('@/stores/chat-store');
  const toast = await import('@/stores/error-toast-store');
  return { ...chat, useErrorToastStore: toast.useErrorToastStore };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function thread(id: string) {
  const { useChatStore, selectThread } = await getStores();
  return selectThread(useChatStore.getState(), id);
}

beforeEach(async () => {
  const { useChatStore, createThreadState, useErrorToastStore } = await getStores();
  calls.getMessages = [];
  calls.getContextUsage = [];
  calls.getBlocks = [];
  calls.askResponse = [];
  calls.confirmResponse = [];
  calls.stop = [];
  serverMessages = {};
  openLanes = [lane('a', 1, { title: 'Primeira' }), lane('b', 2, { title: 'Bug do login' })];
  useErrorToastStore.getState().clearToasts();
  useChatStore.setState({
    sessions: [],
    openLanes,
    compactingSessionIds: new Set(),
    compactions: {},
    currentSessionId: 'a',
    threads: {
      a: createThreadState({ hydrated: true, isStreaming: true, submittedUserTurnCount: 1 }),
      b: createThreadState({ hydrated: true, isStreaming: true, submittedUserTurnCount: 1 }),
    },
    streamingSessionIds: new Set(['a', 'b']),
  });
});

describe('AC-19 / 10.1: chunks da lane nao visivel sao bufferizados na thread dela', () => {
  it('text, tool_call, tool_result, activity, usage, context_usage, artifact e done de B ficam em B; A intacta', async () => {
    const { useChatStore } = await getStores();
    const emit = useChatStore.getState().handleStreamChunk;

    emit({ type: 'text', content: 'ola ', sessionId: 'b' });
    emit({ type: 'text', content: 'mundo', sessionId: 'b' });
    emit({ type: 'tool_call', tool: 'Bash', toolCallId: 't1', input: { command: 'ls' }, sessionId: 'b' });
    emit({ type: 'tool_result', tool: 'Bash', toolCallId: 't1', result: 'ok', sessionId: 'b' });
    emit({
      type: 'activity',
      sessionId: 'b',
      activity: { id: 'act1', kind: 'tool', phase: 'start', label: 'Bash', status: 'running' },
    });
    emit({
      type: 'usage',
      sessionId: 'b',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        runtime: 'claude-sdk',
        provider: 'anthropic',
        model: 'x',
        costStatus: 'known',
        tokenStatus: 'reported',
        costUsd: 0.01,
      },
    });
    emit({
      type: 'context_usage',
      sessionId: 'b',
      contextUsage: { contextTokens: 100, contextWindowTokens: 1000, compactionThresholdPercent: 70 },
    });
    emit({
      type: 'artifact',
      sessionId: 'b',
      artifact: { id: 'art1', type: 'html', title: 'x', toolName: 'y', data: {} },
    });
    await wait(40);

    const b = await thread('b');
    expect(b.streamingContent).toBe('ola mundo');
    expect(b.streamTimeline.length).toBeGreaterThan(0);
    expect(b.toolCalls).toEqual([expect.objectContaining({ id: 't1', status: 'done', result: 'ok' })]);
    expect(b.activities.map((x) => x.id)).toEqual(['act1']);
    expect(b.currentUsage?.inputTokens).toBe(10);
    expect(b.currentContext?.contextTokens).toBe(100);
    expect(b.artifacts.map((x) => x.id)).toEqual(['art1']);
    expect(b.streamTurnStartedAt).not.toBeNull();

    const a = await thread('a');
    expect(a.streamingContent).toBe('');
    expect(a.toolCalls).toEqual([]);
    expect(a.activities).toEqual([]);
    expect(a.currentUsage).toBeNull();
    expect(a.currentContext).toBeNull();
    expect(a.artifacts).toEqual([]);
    expect(a.isStreaming).toBe(true);
    expect(useChatStore.getState().currentSessionId).toBe('a');

    emit({ type: 'done', sessionId: 'b', queueRemaining: 0 });
    await wait(0);

    const bDone = await thread('b');
    expect(bDone.isStreaming).toBe(false);
    expect(bDone.messages).toHaveLength(1);
    expect(bDone.messages[0].role).toBe('assistant');
    expect(bDone.messages[0].content).toBe('ola mundo');
    expect(bDone.messages[0].metadata?.artifacts?.map((x) => x.id)).toEqual(['art1']);
    expect(bDone.streamingContent).toBe('');
    expect(bDone.assistantTurnCount).toBe(1);
    expect(useChatStore.getState().streamingSessionIds).toEqual(new Set(['a']));
    expect((await thread('a')).isStreaming).toBe(true);
  });

  it('selectSession(B) so troca o ponteiro: mensagens bufferizadas aparecem sem reload e nada de A e zerado', async () => {
    const { useChatStore } = await getStores();
    const emit = useChatStore.getState().handleStreamChunk;
    emit({ type: 'text', content: 'resposta de B', sessionId: 'b' });
    await wait(40);
    emit({ type: 'done', sessionId: 'b' });
    await wait(0);
    emit({ type: 'text', content: 'A ainda streamando', sessionId: 'a' });
    await wait(40);

    await useChatStore.getState().selectSession('b');

    expect(useChatStore.getState().currentSessionId).toBe('b');
    expect(calls.getMessages).toEqual([]);
    expect(calls.getContextUsage).toEqual([]);
    const { selectVisibleThread } = await getStores();
    const visible = selectVisibleThread(useChatStore.getState());
    expect(visible.messages.map((m) => m.content)).toEqual(['resposta de B']);
    expect((await thread('a')).streamingContent).toBe('A ainda streamando');
    expect((await thread('a')).isStreaming).toBe(true);
  });

  it('thread nunca carregada hidrata UMA vez ao ser selecionada e preserva o que chegou por chunk', async () => {
    const { useChatStore } = await getStores();
    useChatStore.setState((state) => {
      const { b: _, ...threads } = state.threads;
      return { threads };
    });
    serverMessages.b = [{ id: 7, sessionId: 'b', role: 'user', content: 'pergunta', createdAt: '' }];
    const emit = useChatStore.getState().handleStreamChunk;
    emit({
      type: 'assistant_pushed',
      sessionId: 'b',
      message: { id: 9_000_000_000_000_001, sessionId: 'b', role: 'assistant', content: 'push', createdAt: '' },
    });
    emit({ type: 'text', content: 'parcial', sessionId: 'b' });
    await wait(40);

    await useChatStore.getState().selectSession('b');
    expect(calls.getMessages).toEqual(['b']);
    expect((await thread('b')).hydrated).toBe(true);
    expect((await thread('b')).messages.map((m) => m.content)).toEqual(['pergunta', 'push']);
    expect((await thread('b')).streamingContent).toBe('parcial');

    await useChatStore.getState().selectSession('a');
    await useChatStore.getState().selectSession('b');
    expect(calls.getMessages).toEqual(['b']);
  });

  it('error de B nao altera isStreaming de A e registra lastError so em B', async () => {
    const { useChatStore, useErrorToastStore } = await getStores();
    useChatStore.getState().handleStreamChunk({ type: 'error', sessionId: 'b', code: 'LLM-NET', error: 'rede' });

    expect((await thread('a')).isStreaming).toBe(true);
    expect((await thread('a')).lastError).toBeNull();
    expect((await thread('b')).isStreaming).toBe(false);
    expect((await thread('b')).lastError?.code).toBe('LLM-NET');
    expect(useChatStore.getState().streamingSessionIds).toEqual(new Set(['a']));
    expect(useErrorToastStore.getState().toasts[0].title).toBe('Lane 2: Bug do login: erro no turno');
  });

  it('dreaming_status e repo_graph sao roteados pela sessao do chunk', async () => {
    const { useChatStore } = await getStores();
    const repo = await import('@/stores/repo-graph-store');
    useChatStore.getState().handleStreamChunk({ type: 'dreaming_status', sessionId: 'b', isDreaming: true });
    expect((await thread('b')).isDreaming).toBe(true);
    expect((await thread('a')).isDreaming).toBe(false);

    useChatStore.getState().handleStreamChunk({
      type: 'repo_graph',
      sessionId: 'b',
      repoGraph: { sessionId: 'b', repositoryId: 'r1', status: 'ready', used: true, source: 'orchestrator-mcp' },
    });
    expect(repo.selectRepoGraphSession(repo.useRepoGraphStore.getState(), 'b').usedInTurn).toBe(true);
    expect(repo.selectRepoGraphSession(repo.useRepoGraphStore.getState(), 'a').usedInTurn).toBe(false);
  });
});

describe('10.4: popups por thread, um modal global por vez, FIFO entre lanes', () => {
  it('confirm de B rotulado "Lane 2: <titulo>" enquanto A esta visivel; responder libera so B e o proximo da fila aparece', async () => {
    const { useChatStore, selectNextPopup } = await getStores();
    useChatStore.getState().enqueueConfirmation({
      id: 'c-b',
      tool: 'Bash',
      description: 'rm',
      input: {},
      risk: 'high',
      sessionId: 'b',
      title: 'Bug do login',
    });
    useChatStore
      .getState()
      .enqueueConfirmation({ id: 'c-a', tool: 'Write', description: 'w', input: {}, risk: 'medium', sessionId: 'a' });
    useChatStore
      .getState()
      .enqueueConfirmation({ id: 'c-b', tool: 'Bash', description: 'dup', input: {}, risk: 'high', sessionId: 'b' });

    expect((await thread('b')).pendingConfirmations.map((p) => p.action.id)).toEqual(['c-b']);
    expect((await thread('a')).pendingConfirmations.map((p) => p.action.id)).toEqual(['c-a']);

    const first = selectNextPopup(useChatStore.getState());
    expect(first?.kind).toBe('confirm');
    expect(first?.sessionId).toBe('b');
    expect(first?.label).toBe('Lane 2: Bug do login');
    expect(useChatStore.getState().currentSessionId).toBe('a');

    await useChatStore.getState().resolveConfirmation('c-b', true);
    expect(calls.confirmResponse).toEqual([{ id: 'c-b', approved: true }]);
    expect((await thread('b')).pendingConfirmations).toEqual([]);
    expect((await thread('a')).pendingConfirmations).toHaveLength(1);

    const second = selectNextPopup(useChatStore.getState());
    expect(second?.kind).toBe('confirm');
    expect(second?.sessionId).toBe('a');
    expect(second?.label).toBe('Lane 1: Primeira');

    await useChatStore.getState().resolveConfirmation('c-a', false);
    expect(selectNextPopup(useChatStore.getState())).toBeNull();
  });

  it('ask_question entra na thread do chunk.sessionId (mensagem inline + fila) e responder libera so aquela lane', async () => {
    const { useChatStore, selectNextPopup } = await getStores();
    const request = {
      id: 'q-b',
      questions: [{ question: 'Qual?', header: 'H', options: [{ label: 'x', description: '' }] }],
      sessionId: 'b',
      title: 'Bug do login',
    };
    useChatStore.getState().handleStreamChunk({ type: 'ask_question', sessionId: 'b', askRequest: request });
    useChatStore.getState().enqueueAskQuestion(request);

    expect((await thread('b')).messages.map((m) => m.messageType)).toEqual(['ask_question']);
    expect((await thread('b')).pendingAskQuestions.map((q) => q.request.id)).toEqual(['q-b']);
    expect((await thread('a')).messages).toEqual([]);
    expect((await thread('a')).pendingAskQuestions).toEqual([]);

    const popup = selectNextPopup(useChatStore.getState());
    expect(popup?.kind).toBe('ask');
    expect(popup?.label).toBe('Lane 2: Bug do login');

    useChatStore
      .getState()
      .enqueueConfirmation({ id: 'c-a', tool: 'Write', description: 'w', input: {}, risk: 'medium', sessionId: 'a' });
    expect(selectNextPopup(useChatStore.getState())?.kind).toBe('ask');

    await useChatStore.getState().resolveAskQuestion({ id: 'q-b', answers: { Qual: 'x' } });
    expect(calls.askResponse).toEqual([{ id: 'q-b', answers: { Qual: 'x' } }]);
    expect((await thread('b')).pendingAskQuestions).toEqual([]);
    expect(selectNextPopup(useChatStore.getState())?.kind).toBe('confirm');
    expect(selectNextPopup(useChatStore.getState())?.sessionId).toBe('a');
  });

  it('P2-2 (RM7): popup sem sessionId vai ao balde "Origem sem lane", nunca a lane visivel; lane desconhecida usa o titulo', async () => {
    const { useChatStore, selectNextPopup, NO_LANE_BUCKET } = await getStores();
    useChatStore
      .getState()
      .enqueueConfirmation({ id: 'c-vis', tool: 'Bash', description: 'x', input: {}, risk: 'medium' });
    expect((await thread('a')).pendingConfirmations).toEqual([]);
    expect((await thread(NO_LANE_BUCKET)).pendingConfirmations.map((p) => p.action.id)).toEqual(['c-vis']);
    const popup = selectNextPopup(useChatStore.getState());
    expect(popup?.sessionId).toBe(NO_LANE_BUCKET);
    expect(popup?.label).toBe('Origem sem lane');

    await useChatStore.getState().resolveConfirmation('c-vis', false);
    expect((await thread(NO_LANE_BUCKET)).pendingConfirmations).toEqual([]);

    useChatStore
      .getState()
      .enqueueAskQuestion({ id: 'q-nolane', questions: [{ question: 'Q', header: 'H', options: [] }] });
    expect((await thread(NO_LANE_BUCKET)).pendingAskQuestions.map((q) => q.request.id)).toEqual(['q-nolane']);
    expect(selectNextPopup(useChatStore.getState())?.label).toBe('Origem sem lane');
    await useChatStore.getState().resolveAskQuestion({ id: 'q-nolane', answers: {} });

    useChatStore.getState().enqueueConfirmation({
      id: 'c-zz',
      tool: 'Bash',
      description: 'x',
      input: {},
      risk: 'medium',
      sessionId: 'zz',
      title: 'Antiga',
    });
    expect(selectNextPopup(useChatStore.getState())?.label).toBe('Outra conversa: Antiga');
  });

  it('P3-1: o rotulo usa o laneBadge do payload antes de openLanes', async () => {
    const { useChatStore, selectNextPopup } = await getStores();
    useChatStore.getState().enqueueConfirmation({
      id: 'c-badge',
      tool: 'Bash',
      description: 'x',
      input: {},
      risk: 'medium',
      sessionId: 'zz',
      title: 'Fechada',
      laneBadge: 2,
    });
    expect(selectNextPopup(useChatStore.getState())?.label).toBe('Lane 2: Fechada');
    await useChatStore.getState().resolveConfirmation('c-badge', false);

    useChatStore
      .getState()
      .enqueueConfirmation({ id: 'c-lane', tool: 'Bash', description: 'x', input: {}, risk: 'medium', sessionId: 'b' });
    expect(selectNextPopup(useChatStore.getState())?.label).toBe('Lane 2: Bug do login');
  });
});

describe('P1-1 (10.1/AC-19): hidratacao nao duplica mensagens que chegaram por chunk antes da selecao', () => {
  it('chunks em B antes de abrir + servidor com as mesmas mensagens: sem duplicata (servidor vence)', async () => {
    const { useChatStore } = await getStores();
    useChatStore.setState((state) => {
      const { b: _, ...threads } = state.threads;
      return { threads };
    });
    await useChatStore.getState().sendMessage('pergunta em B', undefined, undefined, 'b');
    const emit = useChatStore.getState().handleStreamChunk;
    emit({ type: 'session', content: 'b', sessionId: 'b' });
    emit({ type: 'text', content: 'resposta de B', sessionId: 'b' });
    await wait(40);
    emit({ type: 'done', sessionId: 'b' });
    await wait(0);
    expect((await thread('b')).messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'pergunta em B'],
      ['assistant', 'resposta de B'],
    ]);

    serverMessages.b = [
      { id: 1, sessionId: 'b', role: 'user', content: 'antiga', createdAt: '' },
      { id: 2, sessionId: 'b', role: 'user', content: 'pergunta em B', createdAt: '' },
      { id: 3, sessionId: 'b', role: 'assistant', content: 'resposta de B', createdAt: '' },
    ];
    await useChatStore.getState().selectSession('b');
    expect(calls.getMessages).toEqual(['b']);
    expect((await thread('b')).messages.map((m) => [m.id, m.role, m.content])).toEqual([
      [1, 'user', 'antiga'],
      [2, 'user', 'pergunta em B'],
      [3, 'assistant', 'resposta de B'],
    ]);
  });

  it('servidor ainda sem a ultima user local: ela e preservada na cauda', async () => {
    const { useChatStore } = await getStores();
    useChatStore.setState((state) => {
      const { b: _, ...threads } = state.threads;
      return { threads };
    });
    await useChatStore.getState().sendMessage('ainda nao persistida', undefined, undefined, 'b');
    serverMessages.b = [{ id: 1, sessionId: 'b', role: 'user', content: 'antiga', createdAt: '' }];
    await useChatStore.getState().selectSession('b');
    expect((await thread('b')).messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'antiga'],
      ['user', 'ainda nao persistida'],
    ]);
  });
});

describe('P2-2 (RM7): chunk sem sessionId e descartado com toast tipado', () => {
  it('nao cai na thread visivel; toast stream_session_missing uma vez por minuto', async () => {
    const { useChatStore, useErrorToastStore, _resetStreamSessionMissingThrottleForTests } = await getStores();
    _resetStreamSessionMissingThrottleForTests();
    const emit = useChatStore.getState().handleStreamChunk;
    emit({ type: 'text', content: 'orfao' });
    emit({ type: 'error', code: 'LLM-NET', error: 'sem lane' });
    await wait(40);

    expect((await thread('a')).streamingContent).toBe('');
    expect((await thread('a')).isStreaming).toBe(true);
    expect((await thread('a')).lastError).toBeNull();
    const toasts = useErrorToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].code).toBe('stream_session_missing');
  });
});

describe('P2-1 (glossario/10.2): sessoes dw-drive-* nao sao conversas desktop', () => {
  it('chunk session de sessao que nao e lane aberta nunca seleciona; a thread e registrada', async () => {
    const { useChatStore } = await getStores();
    openLanes = [];
    useChatStore.setState({ currentSessionId: null, openLanes: [] });
    useChatStore
      .getState()
      .handleStreamChunk({ type: 'session', content: 'dw-drive-run1', sessionId: 'dw-drive-run1' });
    await wait(0);
    expect(useChatStore.getState().currentSessionId).toBeNull();
    expect((await thread('dw-drive-run1')).isStreaming).toBe(true);

    openLanes = [lane('a', 1, { title: 'Primeira' })];
    useChatStore.setState({ openLanes });
    useChatStore.getState().handleStreamChunk({ type: 'session', content: 'a', sessionId: 'a' });
    await wait(0);
    expect(useChatStore.getState().currentSessionId).toBe('a');
  });

  it('isDesktopSession exclui dw-drive-* da sidebar', async () => {
    const { isDesktopSession } = await getStores();
    const base = {
      type: 'chat' as const,
      status: 'active' as const,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      createdAt: '',
      updatedAt: '',
    };
    expect(isDesktopSession({ ...base, id: 'lane-a' })).toBe(true);
    expect(isDesktopSession({ ...base, id: 'dw-drive-run1' })).toBe(false);
  });
});

describe('10.5: composer por thread (queueRemaining, Parar, isCompacting)', () => {
  it('queueRemaining sobe no envio com turno em voo e e reconciliado por done/session da propria lane', async () => {
    const { useChatStore } = await getStores();
    await useChatStore.getState().sendMessage('segunda em A');
    expect((await thread('a')).queueRemaining).toBe(1);
    expect((await thread('b')).queueRemaining).toBe(0);

    useChatStore.getState().handleStreamChunk({ type: 'done', sessionId: 'b', queueRemaining: 0 });
    await wait(0);
    expect((await thread('a')).queueRemaining).toBe(1);

    useChatStore.getState().handleStreamChunk({ type: 'done', sessionId: 'a', queueRemaining: 1 });
    await wait(0);
    expect((await thread('a')).isStreaming).toBe(true);
    useChatStore.getState().handleStreamChunk({ type: 'session', content: 'a', sessionId: 'a' });
    expect((await thread('a')).queueRemaining).toBe(0);
  });

  it('Parar age so na thread pedida e zera a fila dela', async () => {
    const { useChatStore } = await getStores();
    await useChatStore.getState().sendMessage('fila em A');
    await useChatStore.getState().stopStreaming('a');
    expect(calls.stop).toEqual(['a']);
    expect((await thread('a')).isStreaming).toBe(false);
    expect((await thread('a')).queueRemaining).toBe(0);
    expect((await thread('a')).lastAssistantTurnEvent?.status).toBe('stopped');
    expect((await thread('b')).isStreaming).toBe(true);
  });

  it('attachments e scrollPinnedToBottom vivem por thread', async () => {
    const { useChatStore } = await getStores();
    useChatStore
      .getState()
      .setThreadAttachments('b', [
        { id: 'x', type: 'image', filename: 'f.png', mimeType: 'image/png', data: '', size: 1 },
      ]);
    useChatStore.getState().setScrollPinned('b', false);
    expect((await thread('b')).attachments).toHaveLength(1);
    expect((await thread('b')).scrollPinnedToBottom).toBe(false);
    expect((await thread('a')).attachments).toHaveLength(0);
    expect((await thread('a')).scrollPinnedToBottom).toBe(true);

    useChatStore.getState().setThreadAttachments('b', (prev) => prev.filter((att) => att.id !== 'x'));
    expect((await thread('b')).attachments).toHaveLength(0);
  });

  it('activitiesPanelOpen e reconcileDanglingActivities miram a thread pedida (default: visivel)', async () => {
    const { useChatStore } = await getStores();
    useChatStore.getState().handleStreamChunk({
      type: 'activity',
      sessionId: 'b',
      activity: { id: 'act', kind: 'tool', phase: 'start', label: 'Bash', status: 'running' },
    });
    useChatStore.getState().toggleActivitiesPanel(false, 'b');
    expect((await thread('b')).activitiesPanelOpen).toBe(false);
    expect((await thread('a')).activitiesPanelOpen).toBe(true);

    useChatStore.getState().reconcileDanglingActivities('stopped');
    expect((await thread('b')).activities[0].status).toBe('running');
    useChatStore.getState().reconcileDanglingActivities('stopped', 'b');
    expect((await thread('b')).activities[0].status).toBe('stopped');
  });
});
