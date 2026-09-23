import { describe, it, expect, beforeEach } from 'vitest';
import { useErrorToastStore } from '@/stores/error-toast-store';
import { MCP_DIST_STALE_TITLE, _resetMcpDistStaleForTests, useMcpDistStaleStore } from '@/stores/mcp-dist-stale-store';

let listener: ((payload: { servers: string[]; command: string }) => void) | null = null;
let bootPayload: { servers: string[]; command: string } | null = null;

beforeEach(() => {
  listener = null;
  bootPayload = null;
  _resetMcpDistStaleForTests();
  useMcpDistStaleStore.setState({ stale: null });
  useErrorToastStore.getState().clearToasts();
  (globalThis as unknown as { window: unknown }).window = {
    lionclaw: {
      mcp: {
        getDistStale: async () => bootPayload,
        onDistStale: (cb: (payload: { servers: string[]; command: string }) => void) => {
          listener = cb;
          return () => {
            listener = null;
          };
        },
      },
    },
  };
});

describe('P2-3: mcp:dist-stale chega ao usuario (toast persistente + estado para o banner)', () => {
  it('init consulta o estado no boot e escuta o evento; o toast e persistente e lista comando e servidores', async () => {
    bootPayload = { servers: ['kanban', 'gateway'], command: 'npm run build:mcps' };
    const cleanup = useMcpDistStaleStore.getState().init();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useMcpDistStaleStore.getState().stale).toEqual({
      servers: ['gateway', 'kanban'],
      command: 'npm run build:mcps',
    });
    const toasts = useErrorToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe(MCP_DIST_STALE_TITLE);
    expect(toasts[0].persist).toBe(true);
    expect(toasts[0].body).toContain('npm run build:mcps');
    expect(toasts[0].body).toContain('gateway, kanban');

    listener?.({ servers: ['gateway', 'kanban'], command: 'npm run build:mcps' });
    expect(useErrorToastStore.getState().toasts).toHaveLength(1);

    listener?.({ servers: ['gateway', 'kanban', 'skills'], command: 'npm run build:mcps' });
    expect(useErrorToastStore.getState().toasts).toHaveLength(2);
    expect(useMcpDistStaleStore.getState().stale?.servers).toEqual(['gateway', 'kanban', 'skills']);

    cleanup();
    expect(listener).toBeNull();
  });

  it('payload nulo ou vazio limpa o estado sem toast', () => {
    useMcpDistStaleStore.getState().apply({ servers: [], command: 'npm run build:mcps' });
    expect(useMcpDistStaleStore.getState().stale).toBeNull();
    useMcpDistStaleStore.getState().apply(null);
    expect(useMcpDistStaleStore.getState().stale).toBeNull();
    expect(useErrorToastStore.getState().toasts).toHaveLength(0);
  });
});
