import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { ChatSession, OpenChatSession, SessionOrchestrator } from '@/types';

interface Calls {
  send: Array<{ message: string; options: Record<string, unknown> | undefined }>;
  setOrchestrator: Array<{ sessionId: string; selection: SessionOrchestrator }>;
  pricing: Array<Record<string, unknown>>;
}

const calls: Calls = { send: [], setOrchestrator: [], pricing: [] };
let openLanes: OpenChatSession[] = [];
let sessions: ChatSession[] = [];
let setOrchestratorResult:
  | { ok: true; orchestrator: SessionOrchestrator }
  | { error: string; code: 'provider_locked' | 'invalid_selection' | 'model_not_in_provider' | 'effort_not_supported' }
  | null = null;
const contextBySession: Record<
  string,
  { contextTokens: number; contextWindowTokens: number; compactionThresholdPercent: number; source: 'estimate' }
> = {};

function lane(id: string, laneBadge: number, over: Partial<OpenChatSession> = {}): OpenChatSession {
  return {
    id,
    laneBadge,
    title: `Lane ${laneBadge}`,
    orchestrator: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-5', effort: 'high' },
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
        getContextUsage: async (sessionId: string) => contextBySession[sessionId] ?? null,
        listOpenSessions: async () => openLanes,
        createSession: async () => ({ error: 'nao usado', code: 'lanes_full' }),
        send: async (message: string, options?: Record<string, unknown>) => {
          calls.send.push({ message, options });
          return { accepted: true };
        },
        stop: async () => {},
        setSessionOrchestrator: async (sessionId: string, selection: SessionOrchestrator) => {
          calls.setOrchestrator.push({ sessionId, selection });
          return setOrchestratorResult ?? { ok: true, orchestrator: selection };
        },
        deleteSession: async () => ({ success: true }),
      },
      settings: {
        get: async () => ({
          voiceResponseEnabled: false,
          orchestratorRuntime: 'lion-sdk',
          orchestratorProvider: 'ollama',
          orchestratorModel: 'global-model',
          orchestratorOpenAiCompatPreset: 'custom',
        }),
      },
      activity: {
        getBlocks: async () => [],
      },
      pricing: {
        calculate: async (input: Record<string, unknown>) => {
          calls.pricing.push(input);
          return { costUsd: 0.5 };
        },
      },
    },
  };
});

async function getStores() {
  const chat = await import('@/stores/chat-store');
  const toast = await import('@/stores/error-toast-store');
  return {
    useChatStore: chat.useChatStore,
    selectLaneOrchestrator: chat.selectLaneOrchestrator,
    selectVisibleThread: chat.selectVisibleThread,
    useErrorToastStore: toast.useErrorToastStore,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  const { useChatStore, useErrorToastStore } = await getStores();
  calls.send = [];
  calls.setOrchestrator = [];
  calls.pricing = [];
  openLanes = [];
  sessions = [];
  setOrchestratorResult = null;
  for (const key of Object.keys(contextBySession)) delete contextBySession[key];
  useErrorToastStore.getState().clearToasts();
  useChatStore.setState({
    sessions: [],
    openLanes: [],
    compactingSessionIds: new Set(),
    compactions: {},
    currentSessionId: null,
    threads: {},
    streamingSessionIds: new Set(),
  });
});

describe('AC-10 lado UI: lane com mensagens troca modelo/effort na hora e o provider fica travado', () => {
  it('setLaneOrchestrator manda so modelo/effort do mesmo provider e atualiza openLanes/sessions', async () => {
    const { useChatStore } = await getStores();
    openLanes = [lane('a', 1)];
    sessions = [session('a', { laneBadge: 1, orchestrator: openLanes[0].orchestrator })];
    useChatStore.setState({ openLanes, sessions, currentSessionId: 'a' });

    const ok = await useChatStore.getState().setLaneOrchestrator('a', {
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      effort: 'max',
    });

    expect(ok).toBe(true);
    expect(calls.setOrchestrator).toEqual([
      {
        sessionId: 'a',
        selection: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'max' },
      },
    ]);
    expect(useChatStore.getState().openLanes[0].orchestrator).toEqual({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      effort: 'max',
    });
    expect(useChatStore.getState().sessions[0].orchestrator?.model).toBe('claude-sonnet-4-6');
  });

  it('chat.send carrega { model, effort } do estado atual da lane', async () => {
    const { useChatStore } = await getStores();
    openLanes = [
      lane('a', 1, {
        orchestrator: { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-6-astra', effort: 'xhigh' },
      }),
    ];
    sessions = [session('a', { laneBadge: 1 })];
    useChatStore.setState({ openLanes, sessions, currentSessionId: 'a' });

    await useChatStore.getState().sendMessage('oi');

    expect(calls.send).toHaveLength(1);
    expect(calls.send[0].options).toMatchObject({ sessionId: 'a', model: 'gpt-6-astra', effort: 'xhigh' });
  });

  it('trocar de provider com mensagens: o main recusa provider_locked e vira toast tipado', async () => {
    const { useChatStore, useErrorToastStore } = await getStores();
    openLanes = [lane('a', 1)];
    sessions = [session('a', { laneBadge: 1 })];
    useChatStore.setState({ openLanes, sessions, currentSessionId: 'a' });
    setOrchestratorResult = { error: 'A lane ja tem mensagens: o provider esta travado.', code: 'provider_locked' };

    const ok = await useChatStore.getState().setLaneOrchestrator('a', {
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-6-astra',
    });
    await flush();

    expect(ok).toBe(false);
    expect(useChatStore.getState().openLanes[0].orchestrator?.provider).toBe('anthropic');
    const toasts = useErrorToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('Provider travado');
    expect(toasts[0].body).toContain('provider esta travado');
  });
});

describe('AC-11 lado UI: lane vazia aceita outro provider; erro tipado vira toast', () => {
  it('lane vazia (messageCount 0, idle): setSessionOrchestrator recebe o provider novo e o estado troca', async () => {
    const { useChatStore } = await getStores();
    openLanes = [lane('a', 1, { messageCount: 0, lastUserMessageAt: null })];
    sessions = [session('a', { laneBadge: 1 })];
    useChatStore.setState({ openLanes, sessions, currentSessionId: 'a' });

    const ok = await useChatStore.getState().setLaneOrchestrator('a', {
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
    });

    expect(ok).toBe(true);
    expect(calls.setOrchestrator[0].selection).toEqual({
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
    });
    expect(useChatStore.getState().openLanes[0].orchestrator?.runtime).toBe('codex-sdk');
  });

  it.each([
    ['model_not_in_provider', 'Modelo fora do provider da lane'],
    ['effort_not_supported', 'Effort nao suportado pelo modelo'],
    ['invalid_selection', 'Selecao invalida'],
  ] as const)('%s vira toast com titulo tipado', async (code, title) => {
    const { useChatStore, useErrorToastStore } = await getStores();
    openLanes = [lane('a', 1, { messageCount: 0 })];
    useChatStore.setState({ openLanes, currentSessionId: 'a' });
    setOrchestratorResult = { error: `falha ${code}`, code };

    const ok = await useChatStore.getState().setLaneOrchestrator('a', {
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'x',
    });

    expect(ok).toBe(false);
    const toast = useErrorToastStore.getState().toasts[0];
    expect(toast.title).toBe(title);
    expect(toast.body).toContain(`falha ${code}`);
  });
});

describe('AC-13 lado UI: chip, barra de contexto e custo seguem a lane visivel', () => {
  it('duas lanes com modelos diferentes: selectLaneOrchestrator e currentContext trocam com a lane visivel', async () => {
    const { useChatStore, selectLaneOrchestrator, selectVisibleThread } = await getStores();
    openLanes = [
      lane('a', 1, {
        orchestrator: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-5', effort: 'high' },
      }),
      lane('b', 2, {
        orchestrator: { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-6-astra', effort: 'xhigh' },
      }),
    ];
    sessions = [session('a', { laneBadge: 1 }), session('b', { laneBadge: 2 })];
    contextBySession.a = {
      contextTokens: 10,
      contextWindowTokens: 1_000_000,
      compactionThresholdPercent: 70,
      source: 'estimate',
    };
    contextBySession.b = {
      contextTokens: 20,
      contextWindowTokens: 400_000,
      compactionThresholdPercent: 60,
      source: 'estimate',
    };
    useChatStore.setState({ openLanes, sessions });

    await useChatStore.getState().selectSession('a');
    expect(selectLaneOrchestrator(useChatStore.getState(), 'a')?.model).toBe('claude-opus-5');
    expect(selectVisibleThread(useChatStore.getState()).orchestrator?.model).toBe('claude-opus-5');
    expect(selectVisibleThread(useChatStore.getState()).currentContext?.contextWindowTokens).toBe(1_000_000);

    await useChatStore.getState().selectSession('b');
    expect(selectLaneOrchestrator(useChatStore.getState(), 'b')?.model).toBe('gpt-6-astra');
    expect(selectVisibleThread(useChatStore.getState()).orchestrator?.model).toBe('gpt-6-astra');
    expect(selectVisibleThread(useChatStore.getState()).currentContext?.contextWindowTokens).toBe(400_000);
    expect(selectVisibleThread(useChatStore.getState()).currentContext?.compactionThresholdPercent).toBe(60);
    expect(useChatStore.getState().threads.a.currentContext?.contextWindowTokens).toBe(1_000_000);
  });

  it('custo fallback (usage sem runtime/provider) usa o orquestrador da lane, nunca o setting global', async () => {
    const { useChatStore, selectVisibleThread } = await getStores();
    openLanes = [lane('b', 2, { orchestrator: { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-6-astra' } })];
    useChatStore.setState({ openLanes, currentSessionId: 'b' });

    useChatStore.getState().handleStreamChunk({
      type: 'usage',
      sessionId: 'b',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    await flush();
    await flush();

    expect(calls.pricing).toHaveLength(1);
    expect(calls.pricing[0]).toMatchObject({ runtime: 'codex-sdk', provider: 'codex', model: 'gpt-6-astra' });
    expect(selectVisibleThread(useChatStore.getState()).currentUsage?.costUsd).toBe(0.5);
  });

  it('usage sem lane resolvida nao cai no setting global (nenhum calculo)', async () => {
    const { useChatStore } = await getStores();
    useChatStore.setState({ openLanes: [], sessions: [], currentSessionId: 'zz' });

    useChatStore.getState().handleStreamChunk({
      type: 'usage',
      sessionId: 'zz',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    await flush();

    expect(calls.pricing).toHaveLength(0);
  });
});
