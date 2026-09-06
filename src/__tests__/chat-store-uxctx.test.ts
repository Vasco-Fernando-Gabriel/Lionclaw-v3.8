import { describe, it, expect, beforeAll, beforeEach } from 'vitest';


let contextUsageImpl: (sessionId: string) => Promise<unknown> = async () => null;
let getContextUsageCalls: string[] = [];

beforeAll(() => {
  (global as unknown as Record<string, unknown>).window = {
    lionclaw: {
      chat: {
        getSessions: async () => [],
        getMessages: async () => [],
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

beforeEach(async () => {
  getContextUsageCalls = [];
  contextUsageImpl = async (id: string) => {
    getContextUsageCalls.push(id);
    return null;
  };
  const { useChatStore } = await getStore();
  useChatStore.setState({
    currentSessionId: 's1',
    sessions: [],
    telegramSessions: [],
    messages: [],
    streamingContent: '',
    isStreaming: false,
    currentUsage: null,
    currentContext: null,
    toolCalls: [],
    artifacts: [],
    activities: [],
    submittedUserTurnCount: 0,
    streamTurnStartedAt: null,
  });
});

describe('UX-CTX-1: submit na mesma sessao preserva a barrinha', () => {
  it('UX-CTX-1: sendMessage (modo normal) NAO zera currentContext', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({ isStreaming: false, currentContext: SAMPLE_CONTEXT });

    await useChatStore.getState().sendMessage('oi');

    expect(useChatStore.getState().currentContext).toEqual(SAMPLE_CONTEXT);
    expect(useChatStore.getState().currentUsage).toBeNull();
    expect(useChatStore.getState().isStreaming).toBe(true);
  });

  it('UX-CTX-1: submit em modo queue (isStreaming) tambem preserva currentContext', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({ isStreaming: true, currentContext: SAMPLE_CONTEXT, submittedUserTurnCount: 1 });

    await useChatStore.getState().sendMessage('mais uma');

    expect(useChatStore.getState().currentContext).toEqual(SAMPLE_CONTEXT);
  });
});

describe('UX-CTX-2: abrir/trocar de sessao hidrata (ou limpa) a barrinha', () => {
  it('UX-CTX-2: selectSession hidrata currentContext do valor persistido', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({ currentSessionId: 's1', currentContext: null });
    contextUsageImpl = async (id: string) => {
      getContextUsageCalls.push(id);
      return SAMPLE_CONTEXT;
    };

    await useChatStore.getState().selectSession('s2');

    expect(useChatStore.getState().currentSessionId).toBe('s2');
    expect(getContextUsageCalls).toContain('s2');
    expect(useChatStore.getState().currentContext).toEqual(SAMPLE_CONTEXT);
  });

  it('UX-CTX-2: trocar para sessao sem contexto (null) LIMPA a barrinha', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({ currentSessionId: 's1', currentContext: SAMPLE_CONTEXT });
    contextUsageImpl = async (id: string) => {
      getContextUsageCalls.push(id);
      return null; // janela desconhecida / sessao ainda sem tokens
    };

    await useChatStore.getState().selectSession('s3');

    expect(useChatStore.getState().currentSessionId).toBe('s3');
    expect(useChatStore.getState().currentContext).toBeNull();
  });

  it('UX-CTX-2: getContextUsage que rejeita degrada para null (nao quebra a troca)', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({ currentSessionId: 's1', currentContext: SAMPLE_CONTEXT });
    contextUsageImpl = async () => {
      throw new Error('ipc indisponivel');
    };

    await useChatStore.getState().selectSession('s4');

    expect(useChatStore.getState().currentSessionId).toBe('s4');
    expect(useChatStore.getState().currentContext).toBeNull();
  });

  it('UX-CTX-2: selectSession na MESMA sessao e no-op (nao rebusca contexto)', async () => {
    const { useChatStore } = await getStore();
    useChatStore.setState({ currentSessionId: 's1', currentContext: SAMPLE_CONTEXT });

    await useChatStore.getState().selectSession('s1');

    expect(getContextUsageCalls).not.toContain('s1');
    expect(useChatStore.getState().currentContext).toEqual(SAMPLE_CONTEXT);
  });
});
