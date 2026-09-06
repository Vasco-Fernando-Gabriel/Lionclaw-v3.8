import { create } from 'zustand';
import type { ChatAttachment, ChatFeatureToggles, MCPServerConfig } from '@/types';


export type ChatCapabilityKey = keyof ChatFeatureToggles;

export const CHAT_CAPABILITY_LABELS: Record<ChatCapabilityKey, string> = {
  pipelineControl: 'Pipeline',
  dynamicWorkflows: 'Workflows',
};

const CAPABILITY_ERROR_CODES: Record<string, ChatCapabilityKey> = {
  chat_capability_pipeline_disabled: 'pipelineControl',
  chat_capability_workflows_disabled: 'dynamicWorkflows',
};

export function capabilityForServerId(id: string): ChatCapabilityKey | undefined {
  const norm = id.trim().toLowerCase();
  if (norm === 'lionclaw-pipeline-control' || norm === 'pipeline-control') return 'pipelineControl';
  if (norm === 'lionclaw-dynamic-workflows' || norm === 'dynamic-workflows') return 'dynamicWorkflows';
  return undefined;
}

export function computeMcpAvailability(
  servers: MCPServerConfig[],
): Record<ChatCapabilityKey, boolean> {
  const available: Record<ChatCapabilityKey, boolean> = {
    pipelineControl: false,
    dynamicWorkflows: false,
  };
  for (const server of servers) {
    const capability = capabilityForServerId(server.id);
    if (capability && server.isActive) available[capability] = true;
  }
  return available;
}

interface LastSentPayload {
  sessionId: string | null;
  message: string;
  agentId?: string;
  attachments?: ChatAttachment[];
}

interface ChatFeatureTogglesState {
  sessionId: string | null;
  toggles: ChatFeatureToggles | null;
  loading: boolean;
  pending: Record<ChatCapabilityKey, boolean>;
  mcpAvailable: Record<ChatCapabilityKey, boolean>;
  actionError: string | null;
  capabilityError: { capability: ChatCapabilityKey; message: string } | null;
  lastSent: LastSentPayload | null;

  hydrate: (sessionId: string) => Promise<void>;
  setFeatureToggle: (capability: ChatCapabilityKey, value: boolean) => Promise<boolean>;
  snapshotForSend: (sessionId: string | null) => ChatFeatureToggles | undefined;
  recordSend: (payload: LastSentPayload) => void;
  handleCapabilityError: (code: string | undefined, message: string | undefined) => boolean;
  clearCapabilityError: () => void;
}

const PENDING_NONE: Record<ChatCapabilityKey, boolean> = Object.freeze({
  pipelineControl: false,
  dynamicWorkflows: false,
});

let hydrationSeq = 0;

export const useChatFeatureTogglesStore = create<ChatFeatureTogglesState>((set, get) => ({
  sessionId: null,
  toggles: null,
  loading: false,
  pending: { ...PENDING_NONE },
  mcpAvailable: { pipelineControl: true, dynamicWorkflows: true },
  actionError: null,
  capabilityError: null,
  lastSent: null,

  hydrate: async (sessionId: string) => {
    const seq = ++hydrationSeq;
    set({
      sessionId,
      toggles: null,
      loading: true,
      pending: { ...PENDING_NONE },
      actionError: null,
      capabilityError: null,
    });

    const [togglesResult, mcpResult] = await Promise.allSettled([
      window.lionclaw.chat.getFeatureToggles(sessionId),
      window.lionclaw.mcp.list(),
    ]);

    if (seq !== hydrationSeq || get().sessionId !== sessionId) return;

    const next: Partial<ChatFeatureTogglesState> = { loading: false };
    if (togglesResult.status === 'fulfilled' && togglesResult.value.ok) {
      next.toggles = togglesResult.value.toggles;
    }
    if (mcpResult.status === 'fulfilled' && Array.isArray(mcpResult.value)) {
      next.mcpAvailable = computeMcpAvailability(mcpResult.value);
    }
    set(next);
  },

  setFeatureToggle: async (capability, value) => {
    const { sessionId, pending } = get();
    if (!sessionId || pending[capability]) return false;
    set((s) => ({ pending: { ...s.pending, [capability]: true }, actionError: null }));
    try {
      const result = await window.lionclaw.chat.setFeatureToggles(sessionId, {
        [capability]: value,
      });
      if (get().sessionId !== sessionId) return false;
      if (result.ok) {
        set((s) => ({ toggles: result.toggles, pending: { ...s.pending, [capability]: false } }));
        return true;
      }
      set((s) => ({
        pending: { ...s.pending, [capability]: false },
        actionError: result.error,
      }));
      return false;
    } catch (err) {
      if (get().sessionId === sessionId) {
        set((s) => ({
          pending: { ...s.pending, [capability]: false },
          actionError: `Falha ao salvar o toggle: ${err instanceof Error ? err.message : String(err)}`,
        }));
      }
      return false;
    }
  },

  snapshotForSend: (sessionId) => {
    const s = get();
    if (!sessionId || s.sessionId !== sessionId || s.loading || !s.toggles) return undefined;
    return {
      pipelineControl: s.toggles.pipelineControl && s.mcpAvailable.pipelineControl,
      dynamicWorkflows: s.toggles.dynamicWorkflows && s.mcpAvailable.dynamicWorkflows,
    };
  },

  recordSend: (payload) => {
    set({ lastSent: payload, capabilityError: null });
  },

  handleCapabilityError: (code, message) => {
    if (!code) return false;
    const capability = CAPABILITY_ERROR_CODES[code];
    if (!capability) return false;
    const label = CHAT_CAPABILITY_LABELS[capability];
    set({
      capabilityError: {
        capability,
        message:
          message
          || `${label} está desligado para esta sessão. Ligue o chip ${label} no chat e envie novamente.`,
      },
    });
    return true;
  },

  clearCapabilityError: () => set({ capabilityError: null }),
}));
