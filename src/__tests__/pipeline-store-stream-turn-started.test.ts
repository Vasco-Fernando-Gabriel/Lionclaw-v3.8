import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('zustand/middleware', async () => {
  const actual = await vi.importActual<typeof import('zustand/middleware')>('zustand/middleware');
  return {
    ...actual,
    persist: (initializer: unknown) => initializer,
    createJSONStorage: () => undefined,
  };
});

beforeAll(() => {
  (global as unknown as Record<string, unknown>).window = { lionclaw: { pipeline: {} } };
});

async function getStore() {
  return import('@/stores/pipeline-store');
}

describe('nextStreamTurnStartedAt (helper puro, I4)', () => {
  it('transicao false->true (ou estado inexistente) marca o agora', async () => {
    const { nextStreamTurnStartedAt } = await getStore();
    expect(nextStreamTurnStartedAt(undefined, 1000)).toBe(1000);
    expect(nextStreamTurnStartedAt({ isStreaming: false, streamTurnStartedAt: null }, 1000)).toBe(1000);
    expect(nextStreamTurnStartedAt({ isStreaming: false, streamTurnStartedAt: 42 }, 1000)).toBe(1000);
  });

  it('turno corrente em streaming preserva o marcador; backfill so quando null', async () => {
    const { nextStreamTurnStartedAt } = await getStore();
    expect(nextStreamTurnStartedAt({ isStreaming: true, streamTurnStartedAt: 42 }, 1000)).toBe(42);
    expect(nextStreamTurnStartedAt({ isStreaming: true, streamTurnStartedAt: null }, 1000)).toBe(1000);
  });
});

describe('streamTurnStartedAt (pipeline-store, I4)', () => {
  it('_appendStreamText na transicao false->true seta uma vez; appends seguintes preservam', async () => {
    const { usePipelineStore } = await getStore();
    const store = usePipelineStore.getState();

    const before = Date.now();
    store._appendStreamText('proj-a', 'ola');
    const after = Date.now();

    const ps1 = usePipelineStore.getState().projectStates.get('proj-a');
    expect(ps1?.isStreaming).toBe(true);
    expect(ps1?.streamTurnStartedAt).not.toBeNull();
    expect(ps1?.streamTurnStartedAt as number).toBeGreaterThanOrEqual(before);
    expect(ps1?.streamTurnStartedAt as number).toBeLessThanOrEqual(after);

    store._appendStreamText('proj-a', ' mundo');
    const ps2 = usePipelineStore.getState().projectStates.get('proj-a');
    expect(ps2?.streamTurnStartedAt).toBe(ps1?.streamTurnStartedAt);
  });

  it('_finalizeAssistantMessage (done) LIMPA o marcador e derruba isStreaming (W4)', async () => {
    const { usePipelineStore } = await getStore();
    const store = usePipelineStore.getState();

    store._appendStreamText('proj-b', 'conteudo');
    expect(usePipelineStore.getState().projectStates.get('proj-b')?.streamTurnStartedAt).not.toBeNull();

    store._finalizeAssistantMessage('proj-b');
    const ps = usePipelineStore.getState().projectStates.get('proj-b');
    expect(ps?.isStreaming).toBe(false);
    expect(ps?.streamTurnStartedAt).toBeNull();
  });

  it('done sem conteudo (early return) tambem limpa', async () => {
    const { usePipelineStore } = await getStore();
    const store = usePipelineStore.getState();

    store._setProjectState('proj-c', { isStreaming: true, streamTurnStartedAt: 1234 });
    store._finalizeAssistantMessage('proj-c');

    const ps = usePipelineStore.getState().projectStates.get('proj-c');
    expect(ps?.isStreaming).toBe(false);
    expect(ps?.streamTurnStartedAt).toBeNull();
  });

  it('turno NOVO apos done reinicia do novo inicio real (regressao 5)', async () => {
    const { usePipelineStore } = await getStore();
    const store = usePipelineStore.getState();

    store._setProjectState('proj-d', { isStreaming: true, streamTurnStartedAt: 1234 });
    store._finalizeAssistantMessage('proj-d');

    const before = Date.now();
    store._appendStreamText('proj-d', 'fase seguinte');
    const ps = usePipelineStore.getState().projectStates.get('proj-d');
    expect(ps?.streamTurnStartedAt as number).toBeGreaterThanOrEqual(before);
  });

  it('_handleStreamError limpa o marcador', async () => {
    const { usePipelineStore } = await getStore();
    const store = usePipelineStore.getState();

    store._appendStreamText('proj-e', 'andando');
    store._handleStreamError('proj-e', 'falhou');

    const ps = usePipelineStore.getState().projectStates.get('proj-e');
    expect(ps?.isStreaming).toBe(false);
    expect(ps?.streamTurnStartedAt).toBeNull();
    expect(ps?.error).toBe('falhou');
  });

  it('_appendAgentStream (coder/evaluator) tambem marca o inicio do turno', async () => {
    const { usePipelineStore } = await getStore();
    const store = usePipelineStore.getState();

    const before = Date.now();
    store._appendAgentStream('proj-f', 'coder', { type: 'text', content: 'implementando' });
    const ps1 = usePipelineStore.getState().projectStates.get('proj-f');
    expect(ps1?.isStreaming).toBe(true);
    expect(ps1?.streamTurnStartedAt as number).toBeGreaterThanOrEqual(before);

    store._appendAgentStream('proj-f', 'evaluator', { type: 'text', content: 'avaliando' });
    const ps2 = usePipelineStore.getState().projectStates.get('proj-f');
    expect(ps2?.streamTurnStartedAt).toBe(ps1?.streamTurnStartedAt);
  });
});
