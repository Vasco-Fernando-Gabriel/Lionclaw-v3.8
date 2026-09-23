import { create } from 'zustand';
import { useErrorToastStore } from './error-toast-store';

export interface McpDistStalePayload {
  servers: string[];
  command: string;
}

interface McpDistStaleState {
  stale: McpDistStalePayload | null;
  apply: (payload: McpDistStalePayload | null) => void;
  init: () => () => void;
}

export const MCP_DIST_STALE_TITLE = 'MCPs desatualizados';

export function mcpDistStaleBody(payload: McpDistStalePayload): string {
  return `Rode ${payload.command} para recompilar: ${payload.servers.join(', ')}.`;
}

let noticedSignature: string | null = null;

export function _resetMcpDistStaleForTests(): void {
  noticedSignature = null;
}

export const useMcpDistStaleStore = create<McpDistStaleState>((set) => ({
  stale: null,

  apply: (payload) => {
    if (!payload || payload.servers.length === 0) {
      set({ stale: null });
      return;
    }
    const servers = [...payload.servers].sort();
    const next = { servers, command: payload.command };
    set({ stale: next });
    const signature = `${payload.command}|${servers.join(',')}`;
    if (noticedSignature === signature) return;
    noticedSignature = signature;
    useErrorToastStore.getState().pushNotice(MCP_DIST_STALE_TITLE, {
      tone: 'warning',
      body: mcpDistStaleBody(next),
      persist: true,
      source: 'mcp',
    });
  },

  init: () => {
    const unsubscribe = window.lionclaw.mcp.onDistStale((payload) => {
      useMcpDistStaleStore.getState().apply(payload);
    });
    window.lionclaw.mcp
      .getDistStale()
      .then((payload) => useMcpDistStaleStore.getState().apply(payload))
      .catch((err: unknown) => {
        console.error('mcp:get-dist-stale failed:', err);
      });
    return unsubscribe;
  },
}));
