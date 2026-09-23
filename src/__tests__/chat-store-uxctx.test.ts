import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

let contextUsageImpl: (sessionId: string) => Promise<unknown> = async () => null;
let getContextUsageCalls: string[] = [];

beforeAll(() => {
  (global as unknown as Record<string, unknown>).window = {
    lionclaw: {
      chat: {
        getSessions: async () => [],
        getMessages: async () => [],
        listOpenSessions: async () => [],
        getContextUsage: (sessionId: string) => contextUsageImpl(sessionId),
        send: async () => ({ accepted: true }),
      },
      settings: { get: async () => ({ voiceResponseEnabled: false }) },
      activity: { getBlocks: async () => [] },
      pricing: { calculate: async () => ({ costUsd: null }) },
    },
  };
});

async function getStore() {
  return import('@/stores/chat-store');
}

const SAMPLE_CONTEXT = {
  contextTokens: 120_000,
  contextWindowTokens: 1_000_000,
  compactionThresholdPercent: 80,
  source: 'estimate' as const,
};

async function visible() {
  const { useChatStore, selectVisibleThread } = await getStore();
  return selectVisibleThread(useChatStore.getState());
}

beforeEach(async () => {
  getContextUsageCalls = [];
  contextUsageImpl = async (id: string) => {
    getContextUsageCalls.push(id);
    return null;
  };
  const { useChatStore, createThreadState } = await getStore();
  useChatStore.setState({
    currentSessionId: 's1',
    sessions: [],
    telegramSessions: [],
    openLanes: [],
    threads: { s1: createThreadState({ hydrated: true }) },
    streamingSessionIds: new Set(),
  });
});

describe('UX-CTX-1: submit na mesma sessao preserva a barrinha', () => {
  it('UX-CTX-1: sendMessage (modo normal) NAO zera currentContext', async () => {
    const { useChatStore, createThreadState } = await getStore();
    useChatStore.setState({
      threads: { s1: createThreadState({ hydrated: true, isStreaming: false, currentContext: SAMPLE_CONTEXT }) },
    });

    await useChatStore.getState().sendMessage('oi');

    expect((await visible()).currentContext).toEqual(SAMPLE_CONTEXT);
    expect((await visible()).currentUsage).toBeNull();
    expect((await visible()).isStreaming).toBe(true);
  });

  it('UX-CTX-1: submit em modo queue (isStreaming) tambem preserva currentContext', async () => {
    const { useChatStore, createThreadState } = await getStore();
    useChatStore.setState({
      threads: {
        s1: createThreadState({
          hydrated: true,
          isStreaming: true,
          currentContext: SAMPLE_CONTEXT,
          submittedUserTurnCount: 1,
        }),
      },
    });

    await useChatStore.getState().sendMessage('mais uma');

    expect((await visible()).currentContext).toEqual(SAMPLE_CONTEXT);
    expect((await visible()).queueRemaining).toBe(1);
  });
});

describe('UX-CTX-2: abrir/trocar de sessao hidrata (ou limpa) a barrinha', () => {
  it('UX-CTX-2: selectSession hidrata currentContext do valor persistido', async () => {
    const { useChatStore } = await getStore();
    contextUsageImpl = async (id: string) => {
      getContextUsageCalls.push(id);
      return SAMPLE_CONTEXT;
    };

    await useChatStore.getState().selectSession('s2');

    expect(useChatStore.getState().currentSessionId).toBe('s2');
    expect(getContextUsageCalls).toContain('s2');
    expect((await visible()).currentContext).toEqual(SAMPLE_CONTEXT);
  });

  it('UX-CTX-2: trocar para sessao sem contexto (null) mostra a thread dela sem barrinha; a anterior mantem a sua', async () => {
    const { useChatStore, createThreadState } = await getStore();
    useChatStore.setState({ threads: { s1: createThreadState({ hydrated: true, currentContext: SAMPLE_CONTEXT }) } });
    contextUsageImpl = async (id: string) => {
      getContextUsageCalls.push(id);
      return null;
    };

    await useChatStore.getState().selectSession('s3');

    expect(useChatStore.getState().currentSessionId).toBe('s3');
    expect((await visible()).currentContext).toBeNull();
    expect(useChatStore.getState().threads.s1.currentContext).toEqual(SAMPLE_CONTEXT);
  });

  it('UX-CTX-2: getContextUsage que rejeita degrada para null (nao quebra a troca)', async () => {
    const { useChatStore } = await getStore();
    contextUsageImpl = async () => {
      throw new Error('ipc indisponivel');
    };

    await useChatStore.getState().selectSession('s4');

    expect(useChatStore.getState().currentSessionId).toBe('s4');
    expect((await visible()).currentContext).toBeNull();
    expect((await visible()).hydrated).toBe(true);
  });

  it('UX-CTX-2: selectSession na MESMA sessao e no-op (nao rebusca contexto)', async () => {
    const { useChatStore, createThreadState } = await getStore();
    useChatStore.setState({ threads: { s1: createThreadState({ hydrated: true, currentContext: SAMPLE_CONTEXT }) } });

    await useChatStore.getState().selectSession('s1');

    expect(getContextUsageCalls).not.toContain('s1');
    expect((await visible()).currentContext).toEqual(SAMPLE_CONTEXT);
  });

  it('10.1: thread ja hidratada nao rebusca ao voltar para ela (hidratacao so uma vez)', async () => {
    const { useChatStore } = await getStore();
    await useChatStore.getState().selectSession('s2');
    await useChatStore.getState().selectSession('s1');
    await useChatStore.getState().selectSession('s2');

    expect(getContextUsageCalls.filter((id) => id === 's2')).toHaveLength(1);
    expect(getContextUsageCalls).not.toContain('s1');
  });
});
