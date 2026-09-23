import { create } from 'zustand';
import type { ChatAttachment, ChatFeatureToggles, MCPServerConfig } from '@/types';

export type ChatCapabilityKey = keyof ChatFeatureToggles;

export const CHAT_CAPABILITY_LABELS: Record<ChatCapabilityKey, string> = {
  swarm: 'Swarm',
  pipelineControl: 'Pipeline',
  dynamicWorkflows: 'Workflows',
};

const CAPABILITY_ERROR_CODES: Record<string, ChatCapabilityKey> = {
  chat_capability_swarm_disabled: 'swarm',
  chat_capability_pipeline_disabled: 'pipelineControl',
  chat_capability_workflows_disabled: 'dynamicWorkflows',
};

export function capabilityForServerId(id: string): ChatCapabilityKey | undefined {
  const norm = id.trim().toLowerCase();
  if (norm === 'lionclaw-swarm' || norm === 'swarm') return 'swarm';
  if (norm === 'lionclaw-pipeline-control' || norm === 'pipeline-control') return 'pipelineControl';
  if (norm === 'lionclaw-dynamic-workflows' || norm === 'dynamic-workflows') return 'dynamicWorkflows';
  return undefined;
}

export function computeMcpAvailability(servers: MCPServerConfig[]): Record<ChatCapabilityKey, boolean> {
  const available: Record<ChatCapabilityKey, boolean> = {
    swarm: false,
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

export interface ChatFeatureTogglesSlot {
  toggles: ChatFeatureToggles | null;
  loading: boolean;
  pending: Record<ChatCapabilityKey, boolean>;
  actionError: string | null;
  capabilityError: { capability: ChatCapabilityKey; message: string } | null;
  lastSent: LastSentPayload | null;
  hydrationSeq: number;
}

interface ChatFeatureTogglesState {
  sessions: Record<string, ChatFeatureTogglesSlot>;
  mcpAvailable: Record<ChatCapabilityKey, boolean>;

  hydrate: (sessionId: string) => Promise<void>;
  setFeatureToggle: (sessionId: string, capability: ChatCapabilityKey, value: boolean) => Promise<boolean>;
  snapshotForSend: (sessionId: string | null) => ChatFeatureToggles | undefined;
  recordSend: (payload: LastSentPayload) => void;
  handleCapabilityError: (sessionId: string, code: string | undefined, message: string | undefined) => boolean;
  clearCapabilityError: (sessionId: string) => void;
}

const PENDING_NONE: Record<ChatCapabilityKey, boolean> = Object.freeze({
  pipelineControl: false,
  dynamicWorkflows: false,
  swarm: false,
});

export function createFeatureTogglesSlot(over: Partial<ChatFeatureTogglesSlot> = {}): ChatFeatureTogglesSlot {
  return {
    toggles: null,
    loading: false,
    pending: { ...PENDING_NONE },
    actionError: null,
    capabilityError: null,
    lastSent: null,
    hydrationSeq: 0,
    ...over,
  };
}

export const EMPTY_FEATURE_TOGGLES_SLOT: ChatFeatureTogglesSlot = createFeatureTogglesSlot();

export function selectFeatureToggles(
  state: Pick<ChatFeatureTogglesState, 'sessions'>,
  sessionId: string | null | undefined,
): ChatFeatureTogglesSlot {
  if (!sessionId) return EMPTY_FEATURE_TOGGLES_SLOT;
  return state.sessions[sessionId] ?? EMPTY_FEATURE_TOGGLES_SLOT;
}

export function useFeatureToggles(sessionId: string | null | undefined): ChatFeatureTogglesSlot {
  return useChatFeatureTogglesStore((state) => selectFeatureToggles(state, sessionId));
}

let hydrationCounter = 0;

export const useChatFeatureTogglesStore = create<ChatFeatureTogglesState>((set, get) => {
  const patchSlot = (
    sessionId: string,
    patch: Partial<ChatFeatureTogglesSlot> | ((slot: ChatFeatureTogglesSlot) => Partial<ChatFeatureTogglesSlot>),
  ): void => {
    set((state) => {
      const current = state.sessions[sessionId] ?? createFeatureTogglesSlot();
      const delta = typeof patch === 'function' ? patch(current) : patch;
      return { sessions: { ...state.sessions, [sessionId]: { ...current, ...delta } } };
    });
  };

  return {
    sessions: {},
    mcpAvailable: { pipelineControl: true, dynamicWorkflows: true, swarm: true },

    hydrate: async (sessionId: string) => {
      hydrationCounter += 1;
      const seq = hydrationCounter;
      patchSlot(sessionId, {
        toggles: null,
        loading: true,
        pending: { ...PENDING_NONE },
        actionError: null,
        capabilityError: null,
        hydrationSeq: seq,
      });

      const [togglesResult, mcpResult] = await Promise.allSettled([
        window.lionclaw.chat.getFeatureToggles(sessionId),
        window.lionclaw.mcp.list(),
      ]);

      if (get().sessions[sessionId]?.hydrationSeq !== seq) return;

      const next: Partial<ChatFeatureTogglesSlot> = { loading: false };
      if (togglesResult.status === 'fulfilled' && togglesResult.value.ok) {
        next.toggles = { ...togglesResult.value.toggles, swarm: togglesResult.value.toggles.swarm === true };
      }
      if (mcpResult.status === 'fulfilled' && Array.isArray(mcpResult.value)) {
        set({ mcpAvailable: computeMcpAvailability(mcpResult.value) });
      }
      patchSlot(sessionId, next);
    },

    setFeatureToggle: async (sessionId, capability, value) => {
      const slot = selectFeatureToggles(get(), sessionId);
      if (slot.pending[capability]) return false;
      const seq = slot.hydrationSeq;
      patchSlot(sessionId, (s) => ({ pending: { ...s.pending, [capability]: true }, actionError: null }));
      try {
        const result = await window.lionclaw.chat.setFeatureToggles(sessionId, {
          [capability]: value,
        });
        if (get().sessions[sessionId]?.hydrationSeq !== seq) return false;
        if (result.ok) {
          patchSlot(sessionId, (s) => ({ toggles: result.toggles, pending: { ...s.pending, [capability]: false } }));
          return true;
        }
        patchSlot(sessionId, (s) => ({
          pending: { ...s.pending, [capability]: false },
          actionError: result.error,
        }));
        return false;
      } catch (err) {
        if (get().sessions[sessionId]?.hydrationSeq === seq) {
          patchSlot(sessionId, (s) => ({
            pending: { ...s.pending, [capability]: false },
            actionError: `Falha ao salvar o toggle: ${err instanceof Error ? err.message : String(err)}`,
          }));
        }
        return false;
      }
    },

    snapshotForSend: (sessionId) => {
      if (!sessionId) return undefined;
      const slot = get().sessions[sessionId];
      if (!slot || slot.loading || !slot.toggles) return undefined;
      const { mcpAvailable } = get();
      return {
        swarm: slot.toggles.swarm === true && mcpAvailable.swarm,
        pipelineControl: slot.toggles.pipelineControl && mcpAvailable.pipelineControl,
        dynamicWorkflows: slot.toggles.dynamicWorkflows && mcpAvailable.dynamicWorkflows,
      };
    },

    recordSend: (payload) => {
      if (!payload.sessionId) return;
      patchSlot(payload.sessionId, { lastSent: payload, capabilityError: null });
    },

    handleCapabilityError: (sessionId, code, message) => {
      if (!code) return false;
      const capability = CAPABILITY_ERROR_CODES[code];
      if (!capability) return false;
      const label = CHAT_CAPABILITY_LABELS[capability];
      patchSlot(sessionId, {
        capabilityError: {
          capability,
          message:
            message || `${label} está desligado para esta sessão. Ligue o chip ${label} no chat e envie novamente.`,
        },
      });
      return true;
    },

    clearCapabilityError: (sessionId) => patchSlot(sessionId, { capabilityError: null }),
  };
});
