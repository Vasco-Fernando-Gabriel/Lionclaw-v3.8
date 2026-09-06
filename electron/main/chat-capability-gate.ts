
import { getSetting } from './db';
import { createLogger } from './logger';
import {
  normalizeChatCapabilityServerId,
  getActiveChatTurnByLane,
  getChatCapabilityTurn,
  resolveEffectiveCapabilities,
  type ChatCapabilityName,
  type ChatCapabilityTurnContext,
} from './chat-capability-context';
import {
  verifyInternalCapabilityLease,
  INTERNAL_CAPABILITY_COORDINATORS,
} from './chat-capability-lease';
import type { McpInvocationContext } from './mcp-invocation-context';

const logger = createLogger('chat-capability-gate');


export const CHAT_CAPABILITY_GATE_MODE_SETTING_KEY = 'chat_capability_gate_mode';

export type ChatCapabilityGateMode = 'shadow' | 'enforce';

export function getChatCapabilityGateMode(): ChatCapabilityGateMode {
  try {
    const raw = (getSetting(CHAT_CAPABILITY_GATE_MODE_SETTING_KEY) ?? '')
      .trim()
      .toLowerCase();
    return raw === 'enforce' ? 'enforce' : 'shadow';
  } catch (err) {
    logger.warn(
      { err },
      'falha ao ler chat_capability_gate_mode; assumindo shadow (fail-safe)',
    );
    return 'shadow';
  }
}


const GATED_SERVER_CAPABILITY: Readonly<Record<string, ChatCapabilityName>> = {
  'lionclaw-pipeline-control': 'pipelineControl',
  'lionclaw-dynamic-workflows': 'dynamicWorkflows',
};

export function getChatCapabilityForServer(
  serverId: string,
): ChatCapabilityName | undefined {
  return GATED_SERVER_CAPABILITY[normalizeChatCapabilityServerId(serverId)];
}

export type ChatCapabilityGateDenyCode =
  | 'chat_capability_pipeline_disabled'
  | 'chat_capability_workflows_disabled'
  | 'chat_capability_no_turn_context'
  | 'chat_capability_lease_invalid';

export type ChatCapabilityGateResult =
  | { ok: true }
  | {
      ok: false;
      code: ChatCapabilityGateDenyCode;
      capability: ChatCapabilityName;
      message: string;
    };

const CAPABILITY_DISABLED_DENIALS: Readonly<
  Record<
    ChatCapabilityName,
    { code: ChatCapabilityGateDenyCode; message: string }
  >
> = {
  pipelineControl: {
    code: 'chat_capability_pipeline_disabled',
    message:
      'Pipeline está desligado para esta sessão. Ligue o chip Pipeline no chat e envie novamente.',
  },
  dynamicWorkflows: {
    code: 'chat_capability_workflows_disabled',
    message:
      'Workflows está desligado para esta sessão. Ligue o chip Workflows no chat e envie novamente.',
  },
};

const NO_TURN_CONTEXT_MESSAGE =
  'Não foi possível resolver o turno de chat ativo para validar esta ação. Reenvie a mensagem no chat.';

const LEASE_INVALID_MESSAGE =
  'Chamada interna (system-event) sem lease de capability válida. Turnos internos só bypassam o gate com lease do coordenador.';


interface DenialInput {
  serverId: string;
  toolName: string;
  capability: ChatCapabilityName;
  code: ChatCapabilityGateDenyCode;
  message: string;
  reason: string;
  mode: ChatCapabilityGateMode;
}

function decideDenial(input: DenialInput): ChatCapabilityGateResult {
  const mode = input.mode;
  const fields = {
    serverId: input.serverId,
    toolName: input.toolName,
    capability: input.capability,
    code: input.code,
    reason: input.reason,
    mode,
  };
  if (mode === 'shadow') {
    logger.warn(
      { ...fields, shadow: true },
      `gate em shadow: negaria ${input.capability} em ${input.serverId}.${input.toolName}`,
    );
    return { ok: true };
  }
  logger.warn(
    fields,
    `gate NEGOU ${input.capability} em ${input.serverId}.${input.toolName}`,
  );
  return {
    ok: false,
    code: input.code,
    capability: input.capability,
    message: input.message,
  };
}

export function failClosedChatCapability(input: {
  serverId: string;
  toolName: string;
  reason: string;
}): ChatCapabilityGateResult {
  const serverId = normalizeChatCapabilityServerId(input.serverId);
  const capability = GATED_SERVER_CAPABILITY[serverId];
  if (capability === undefined) return { ok: true };
  return decideDenial({
    serverId,
    toolName: input.toolName,
    capability,
    code: 'chat_capability_no_turn_context',
    message: NO_TURN_CONTEXT_MESSAGE,
    reason: input.reason,
    mode: getChatCapabilityGateMode(),
  });
}


function resolveTurnContextForGate(
  context: McpInvocationContext,
): ChatCapabilityTurnContext | undefined {
  if (context.sessionId && context.turnId) {
    return getChatCapabilityTurn({
      sessionId: context.sessionId,
      turnId: context.turnId,
    });
  }
  const active = getActiveChatTurnByLane('desktop');
  if (!active) return undefined;
  return getChatCapabilityTurn(active);
}

function verifyLeaseFields(input: {
  token: string | undefined;
  coordinator: string | undefined;
  driveProjectId: string | undefined;
  driveTurnId: string | undefined;
  serverId: string;
  toolName: string;
  dryRun: boolean;
}): boolean {
  if (!input.token || !input.driveProjectId || !input.driveTurnId) return false;
  if (input.coordinator !== undefined) {
    return verifyInternalCapabilityLease({
      token: input.token,
      coordinator: input.coordinator,
      driveProjectId: input.driveProjectId,
      driveTurnId: input.driveTurnId,
      serverId: input.serverId,
      toolName: input.toolName,
      dryRun: input.dryRun,
    });
  }
  for (const coordinator of INTERNAL_CAPABILITY_COORDINATORS) {
    if (
      verifyInternalCapabilityLease({
        token: input.token,
        coordinator,
        driveProjectId: input.driveProjectId,
        driveTurnId: input.driveTurnId,
        serverId: input.serverId,
        toolName: input.toolName,
        dryRun: input.dryRun,
        denyLogLevel: 'debug',
      })
    ) {
      return true;
    }
  }
  logger.warn(
    {
      serverId: input.serverId,
      toolName: input.toolName,
      driveProjectId: input.driveProjectId,
      driveTurnId: input.driveTurnId,
    },
    'lease interna NEGADA: nenhum coordinator da enum fechada validou (fallback de iteracao)',
  );
  return false;
}


export interface AssertChatCapabilityInput {
  serverId: string;
  toolName: string;
  context: McpInvocationContext;
}

export function assertChatCapability(
  input: AssertChatCapabilityInput,
): ChatCapabilityGateResult {
  const serverId = normalizeChatCapabilityServerId(input.serverId);
  const capability = GATED_SERVER_CAPABILITY[serverId];
  if (capability === undefined) return { ok: true };

  const surface = input.context.surface;
  if (surface === 'pipeline' || surface === 'harness' || surface === 'enrich') {
    return { ok: true };
  }

  const mode = getChatCapabilityGateMode();
  const leaseDryRun = mode === 'shadow';

  const turnContext = resolveTurnContextForGate(input.context);

  if (surface === 'system-event') {
    const leaseValid = verifyLeaseFields({
      token: input.context.internalLeaseToken ?? turnContext?.internalLeaseToken,
      coordinator: turnContext?.leaseCoordinator,
      driveProjectId:
        input.context.driveProjectId ?? turnContext?.driveProjectId,
      driveTurnId: input.context.driveTurnId ?? turnContext?.driveTurnId,
      serverId,
      toolName: input.toolName,
      dryRun: leaseDryRun,
    });
    if (leaseValid) return { ok: true };
    return decideDenial({
      serverId,
      toolName: input.toolName,
      capability,
      code: 'chat_capability_lease_invalid',
      message: LEASE_INVALID_MESSAGE,
      reason: 'system-event-sem-lease-valida',
      mode,
    });
  }

  if (turnContext === undefined) {
    return decideDenial({
      serverId,
      toolName: input.toolName,
      capability,
      code: 'chat_capability_no_turn_context',
      message: NO_TURN_CONTEXT_MESSAGE,
      reason: 'no-turn-context',
      mode,
    });
  }

  const lease =
    turnContext.origin === 'system-event'
      ? {
          valid: verifyLeaseFields({
            token:
              input.context.internalLeaseToken ??
              turnContext.internalLeaseToken,
            coordinator: turnContext.leaseCoordinator,
            driveProjectId:
              input.context.driveProjectId ?? turnContext.driveProjectId,
            driveTurnId: input.context.driveTurnId ?? turnContext.driveTurnId,
            serverId,
            toolName: input.toolName,
            dryRun: leaseDryRun,
          }),
          capability,
        }
      : undefined;

  const effective = resolveEffectiveCapabilities({
    sessionToggles: turnContext.capabilities,
    origin: turnContext.origin,
    ...(lease !== undefined ? { lease } : {}),
  });

  if (effective[capability] === true) return { ok: true };

  const denial = CAPABILITY_DISABLED_DENIALS[capability];
  return decideDenial({
    serverId,
    toolName: input.toolName,
    capability,
    code: denial.code,
    message: denial.message,
    reason: 'capability-efetiva-off',
    mode,
  });
}
