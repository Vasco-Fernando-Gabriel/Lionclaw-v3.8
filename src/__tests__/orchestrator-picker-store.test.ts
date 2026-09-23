import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderStatusEntry } from '@/types';

const listCalls: Array<{ refresh?: boolean } | undefined> = [];
let listResult: ProviderStatusEntry[] | { error: string } = [];

beforeAll(() => {
  (global as unknown as Record<string, unknown>).window = {
    lionclaw: {
      provider: {
        listStatuses: async (opts?: { refresh?: boolean }) => {
          listCalls.push(opts);
          return listResult;
        },
      },
    },
  };
});

async function getStore() {
  const mod = await import('@/stores/orchestrator-picker-store');
  return mod.useOrchestratorPickerStore;
}

beforeEach(async () => {
  const store = await getStore();
  listCalls.length = 0;
  listResult = [];
  store.setState({ phase: 'idle', entries: [], error: null, loadedAt: null });
});

describe('orchestrator-picker-store: snapshot de provider:list-statuses', () => {
  it('load usa o cache do main (sem refresh) e refresh manda refresh:true', async () => {
    const store = await getStore();
    listResult = [{ runtime: 'claude-sdk', provider: 'anthropic', connected: true, available: true, models: [] }];

    await store.getState().load();
    expect(listCalls).toEqual([undefined]);
    expect(store.getState().phase).toBe('ready');
    expect(store.getState().entries).toHaveLength(1);
    expect(store.getState().loadedAt).not.toBeNull();

    await store.getState().refresh();
    expect(listCalls[1]).toEqual({ refresh: true });
  });

  it('erro do main vira phase error com a mensagem, mantendo as entradas anteriores', async () => {
    const store = await getStore();
    store.setState({ entries: [{ runtime: 'codex-sdk', provider: 'codex', connected: true, available: true }] });
    listResult = { error: 'vault indisponivel' };

    const entries = await store.getState().load();
    expect(store.getState().phase).toBe('error');
    expect(store.getState().error).toBe('vault indisponivel');
    expect(entries).toHaveLength(1);
  });
});
