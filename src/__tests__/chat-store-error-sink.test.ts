import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

beforeAll(() => {
  (global as unknown as Record<string, unknown>).window = {
    lionclaw: {
      chat: {
        getSessions: async () => [],
        getMessages: async () => [],
        deleteSession: async () => ({ success: false, error: 'db is locked' }),
        listOpenSessions: async () => [],
        clear: async () => ({
          ok: false,
          code: 'COMPACT-SUMMARY-FAILED',
          error: 'summarizer returned empty response',
        }),
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
    useErrorToastStore: toast.useErrorToastStore,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  const { useChatStore, useErrorToastStore, createThreadState } = await getStores();
  useErrorToastStore.getState().clearToasts();
  useChatStore.setState({
    currentSessionId: 's1',
    threads: { s1: createThreadState({ hydrated: true }) },
    streamingSessionIds: new Set(),
  });
});

describe('AC-B8: falhas de deleteSession/compactSession no sink universal', () => {
  it('AC-B8: deleteSession que falha empurra toast no sink universal (antes: so console.error)', async () => {
    const { useChatStore, useErrorToastStore } = await getStores();

    await useChatStore.getState().deleteSession('s1');

    const toasts = useErrorToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('Falha ao apagar a conversa');
    expect(toasts[0].body).toBe('db is locked');
    expect(toasts[0].source).toBe('chat');
  });

  it('AC-B8: clearLane recusado pelo main empurra toast com a causa (D3, sem silencio)', async () => {
    const { useChatStore, useErrorToastStore } = await getStores();

    const result = await useChatStore.getState().clearLane('s1');
    expect(result.ok).toBe(false);

    const toasts = useErrorToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('Clear recusado: sumarizador falhou');
    expect(toasts[0].code).toBe('LLM-EMPTY');
    expect(toasts[0].detail).toBe('summarizer returned empty response');
    expect(toasts[0].source).toBe('chat');
  });

  it('AC-B8: clearLane que LANCA (erro de IPC) tambem aparece no sink universal', async () => {
    const { useChatStore, useErrorToastStore } = await getStores();
    const w = (global as unknown as { window: { lionclaw: { chat: Record<string, unknown> } } }).window;
    const original = w.lionclaw.chat.clear;
    w.lionclaw.chat.clear = async () => {
      throw new Error('IPC channel closed');
    };
    try {
      const result = await useChatStore.getState().clearLane('s1');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('clear_failed');

      const toasts = useErrorToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].title).toBe('Clear falhou');
    } finally {
      w.lionclaw.chat.clear = original;
    }
  });
});

describe('AC-B9b: turno vazio por falha de provider (chunk LLM-EMPTY do SB-2)', () => {
  it('AC-B9b: chunk error LLM-EMPTY encerra o turno com o fallback e NAO cria bolha muda', async () => {
    const { useChatStore, createThreadState } = await getStores();
    useChatStore.setState({
      threads: { s1: createThreadState({ isStreaming: true, submittedUserTurnCount: 1, assistantTurnCount: 0 }) },
    });

    useChatStore.getState().handleStreamChunk({
      type: 'error',
      sessionId: 's1',
      code: 'LLM-EMPTY',
      error: 'O agente terminou sem resposta.',
    });

    const thread = useChatStore.getState().threads.s1;
    expect(thread.isStreaming).toBe(false);
    expect(thread.lastAssistantTurnEvent?.status).toBe('error');
    expect(thread.lastAssistantTurnEvent?.error).toBe('O agente terminou sem resposta.');
    expect(thread.messages).toHaveLength(0);
    expect(thread.lastError?.code).toBe('LLM-EMPTY');
  });
});

describe('AC-B9c: turno vazio LEGITIMO (empty-ok) nao gera alarme falso', () => {
  it('AC-B9c: done sem chunk de erro NAO registra erro nem empurra toast', async () => {
    const { useChatStore, useErrorToastStore, createThreadState } = await getStores();
    useChatStore.setState({
      threads: {
        s1: createThreadState({
          isStreaming: true,
          streamingContent: '',
          submittedUserTurnCount: 1,
          assistantTurnCount: 0,
        }),
      },
    });

    useChatStore.getState().handleStreamChunk({ type: 'done', sessionId: 's1' });
    await flush();

    const thread = useChatStore.getState().threads.s1;
    expect(thread.isStreaming).toBe(false);
    expect(thread.lastAssistantTurnEvent?.status ?? 'none').not.toBe('error');
    expect(thread.lastError).toBeNull();
    expect(useErrorToastStore.getState().toasts).toHaveLength(0);
  });
});
