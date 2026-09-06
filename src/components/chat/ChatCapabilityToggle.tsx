import { useEffect, useState } from 'react';
import { Workflow, Waypoints, AlertTriangle, X } from 'lucide-react';
import {
  useChatFeatureTogglesStore,
  CHAT_CAPABILITY_LABELS,
  type ChatCapabilityKey,
} from '@/stores/chat-feature-toggles-store';
import { useChatStore } from '@/stores/chat-store';


interface ChipDef {
  label: string;
  icon: typeof Workflow;
  onClasses: string;
}

const CHIP_DEFS: Record<ChatCapabilityKey, ChipDef> = {
  pipelineControl: {
    label: CHAT_CAPABILITY_LABELS.pipelineControl,
    icon: Workflow,
    onClasses: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20',
  },
  dynamicWorkflows: {
    label: CHAT_CAPABILITY_LABELS.dynamicWorkflows,
    icon: Waypoints,
    onClasses: 'border-violet-500/40 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20',
  },
};

const OFF_CLASSES = 'border-zinc-700 bg-zinc-900 text-zinc-500 hover:text-zinc-300';
const UNAVAILABLE_CLASSES = 'border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20';

type ChipVisualState = 'loading' | 'unavailable' | 'on' | 'off';

const CODEX_DEGRADED_TOOLTIP =
  ' Codex: o gate por turno vale ja; o conjunto de MCP do processo persistente so troca quando o slot recicla.';

interface ChatCapabilityTogglesProps {
  sessionId: string;
  disabled?: boolean;
  isCodexRuntime?: boolean;
}

export function ChatCapabilityToggles({
  sessionId,
  disabled = false,
  isCodexRuntime = false,
}: ChatCapabilityTogglesProps) {
  const hydrate = useChatFeatureTogglesStore((s) => s.hydrate);
  const storeSessionId = useChatFeatureTogglesStore((s) => s.sessionId);
  const toggles = useChatFeatureTogglesStore((s) => s.toggles);
  const loading = useChatFeatureTogglesStore((s) => s.loading);
  const pending = useChatFeatureTogglesStore((s) => s.pending);
  const mcpAvailable = useChatFeatureTogglesStore((s) => s.mcpAvailable);
  const actionError = useChatFeatureTogglesStore((s) => s.actionError);
  const setFeatureToggle = useChatFeatureTogglesStore((s) => s.setFeatureToggle);

  useEffect(() => {
    void hydrate(sessionId);
  }, [sessionId, hydrate]);

  const hydrating = loading || storeSessionId !== sessionId || toggles === null;

  return (
    <>
      {(Object.keys(CHIP_DEFS) as ChatCapabilityKey[]).map((capability) => {
        const isOn = toggles?.[capability] ?? false;
        const isLoading = hydrating || pending[capability];
        const unavailable = !isLoading && isOn && !mcpAvailable[capability];
        const state: ChipVisualState = isLoading
          ? 'loading'
          : unavailable
            ? 'unavailable'
            : isOn
              ? 'on'
              : 'off';
        return (
          <ChatCapabilityChip
            key={capability}
            capability={capability}
            state={state}
            disabled={disabled}
            isCodexRuntime={isCodexRuntime}
            onToggle={() => void setFeatureToggle(capability, !isOn)}
          />
        );
      })}
      {actionError && (
        <span className="text-[10px] text-red-400 truncate min-w-0" title={actionError}>
          {actionError}
        </span>
      )}
    </>
  );
}

interface ChatCapabilityChipProps {
  capability: ChatCapabilityKey;
  state: ChipVisualState;
  disabled: boolean;
  isCodexRuntime: boolean;
  onToggle: () => void;
}

function ChatCapabilityChip({
  capability,
  state,
  disabled,
  isCodexRuntime,
  onToggle,
}: ChatCapabilityChipProps) {
  const def = CHIP_DEFS[capability];
  const Icon = state === 'unavailable' ? AlertTriangle : def.icon;
  const isOn = state === 'on' || state === 'unavailable';

  const stateLabel =
    state === 'loading'
      ? 'carregando'
      : state === 'unavailable'
        ? 'indisponível (MCP global inativo)'
        : state === 'on'
          ? 'ligado'
          : 'desligado';

  const baseTooltip =
    state === 'loading'
      ? `Carregando o estado de ${def.label} desta sessão...`
      : state === 'unavailable'
        ? `${def.label} está ligado nesta sessão, mas o MCP global está inativo: o próximo envio vai SEM ${def.label}. Vale para o próximo envio.`
        : state === 'on'
          ? `${def.label} LIGADO nesta sessão. Vale para o próximo envio. Clique para desligar.`
          : `${def.label} DESLIGADO nesta sessão. Vale para o próximo envio. Clique para ligar.`;
  const tooltip =
    isCodexRuntime && state !== 'loading' ? baseTooltip + CODEX_DEGRADED_TOOLTIP : baseTooltip;

  const colorClasses =
    state === 'unavailable' ? UNAVAILABLE_CLASSES : state === 'on' ? def.onClasses : OFF_CLASSES;

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled || state === 'loading'}
      aria-pressed={isOn}
      aria-label={`${def.label}: ${stateLabel}. Vale para o próximo envio`}
      title={tooltip}
      data-capability={capability}
      data-state={state}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${
        state === 'loading' ? 'animate-pulse' : ''
      } ${colorClasses}`}
    >
      <Icon size={10} />
      {/* <768: icon-only + tooltip (A.8 responsivo) */}
      <span className="hidden md:inline">{def.label}</span>
    </button>
  );
}

export function ChatCapabilityResendAffordance() {
  const capabilityError = useChatFeatureTogglesStore((s) => s.capabilityError);
  const lastSent = useChatFeatureTogglesStore((s) => s.lastSent);
  const [busy, setBusy] = useState(false);

  if (!capabilityError) return null;

  const label = CHAT_CAPABILITY_LABELS[capabilityError.capability];

  const handleEnableAndResend = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const store = useChatFeatureTogglesStore.getState();
      const error = store.capabilityError;
      const payload = store.lastSent;
      if (!error) return;
      const ok = await store.setFeatureToggle(error.capability, true);
      if (!ok) return; // set falhou: mantem a affordance (actionError explica)
      store.clearCapabilityError();
      if (payload) {
        await useChatStore
          .getState()
          .sendMessage(payload.message, payload.agentId, payload.attachments);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="alert"
      className="mb-2 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-center gap-2"
    >
      <AlertTriangle size={13} className="text-amber-400 shrink-0" />
      <span className="text-xs text-amber-300 flex-1 min-w-0 truncate" title={capabilityError.message}>
        {capabilityError.message}
      </span>
      {lastSent && (
        <button
          type="button"
          onClick={() => void handleEnableAndResend()}
          disabled={busy}
          className="px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-medium transition-colors shrink-0 disabled:opacity-50"
        >
          Ligar {label} e reenviar
        </button>
      )}
      <button
        type="button"
        onClick={() => useChatFeatureTogglesStore.getState().clearCapabilityError()}
        aria-label="Dispensar aviso"
        className="p-1 rounded-md text-amber-400/70 hover:text-amber-300 hover:bg-amber-500/10 transition-colors shrink-0"
      >
        <X size={12} />
      </button>
    </div>
  );
}
