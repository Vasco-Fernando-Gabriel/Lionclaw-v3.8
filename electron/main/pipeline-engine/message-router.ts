import { autoPhasesOf, loopPhasesOf } from '../../../src/types/pipeline';
import { getPhaseAgentId } from './registry';
import { getDevV2Briefing } from './dev-v2-briefings';

export type PhaseStateArg = {
  continueSessions: Map<string, { alive?: boolean }>;
};
export type ProjectArg = { pipelineType?: string } & object;

export interface MessageRouterEngine {
  handlePhase1Message(projectId: string, message: string, state: PhaseStateArg): Promise<void>;
  handlePhase3Message(projectId: string, message: string, state: PhaseStateArg): Promise<void>;
  handlePhase9Message(projectId: string, message: string, state: PhaseStateArg): Promise<void>;
  handlePhase10Message(projectId: string, message: string, state: PhaseStateArg): Promise<void>;
  handleTechPhaseMessage(
    projectId: string,
    message: string,
    state: PhaseStateArg,
    phaseNumber: number,
    agentId: string,
  ): Promise<void>;
  handlePhase12Message(
    projectId: string,
    message: string,
    state: PhaseStateArg,
    phaseNumber?: number,
    briefing?: string | null,
  ): Promise<void>;

  handleSecurityPhase4Message(
    projectId: string,
    message: string,
    state: PhaseStateArg,
    project: ProjectArg,
  ): Promise<void>;
  handleSecurityPhase5Message(
    projectId: string,
    message: string,
    state: PhaseStateArg,
    project: ProjectArg,
  ): Promise<void>;
  handleSecurityPhase6SpecReviewMessage(
    projectId: string,
    message: string,
    state: PhaseStateArg,
    project: ProjectArg,
  ): Promise<void>;
  handleSecurityPhase7Message(
    projectId: string,
    message: string,
    state: PhaseStateArg,
    project: ProjectArg,
  ): Promise<void>;
  handleSecurityPhase9Message(
    projectId: string,
    message: string,
    state: PhaseStateArg,
    project: ProjectArg,
  ): Promise<void>;

  handleBugPhase1DiscoveryMessage(
    projectId: string,
    message: string,
    state: PhaseStateArg,
    project: ProjectArg,
  ): Promise<void>;
  handleBugPhase3ConsolidationMessage(
    projectId: string,
    message: string,
    state: PhaseStateArg,
    project: ProjectArg,
  ): Promise<void>;
  handleBugPhase5SpecValidatorMessage(
    projectId: string,
    message: string,
    state: PhaseStateArg,
    project: ProjectArg,
  ): Promise<void>;

  handleArchitecturePhase2TriageMessage(
    projectId: string,
    message: string,
    state: PhaseStateArg,
    project: ProjectArg,
  ): Promise<void>;
  handleArchitecturePhase4DecisionMessage(
    projectId: string,
    message: string,
    state: PhaseStateArg,
    project: ProjectArg,
  ): Promise<void>;
  handleArchitecturePhase6SpecValidationMessage(
    projectId: string,
    message: string,
    state: PhaseStateArg,
    project: ProjectArg,
  ): Promise<void>;
  handleArchitecturePhase7SpecEnricherMessage(
    projectId: string,
    message: string,
    state: PhaseStateArg,
    project: ProjectArg,
  ): Promise<void>;

  handlePhase1MessageDevV2(
    projectId: string,
    message: string,
    state: PhaseStateArg,
    briefing: string | null,
  ): Promise<void>;
  handlePhase3MessageDevV2(
    projectId: string,
    message: string,
    state: PhaseStateArg,
    briefing: string | null,
  ): Promise<void>;
  handleDevV2Phase12SpecReview(projectId: string, message: string, state: PhaseStateArg): Promise<void>;
  handleDevV2Phase13SpecEnricher(projectId: string, message: string, state: PhaseStateArg): Promise<void>;

  buildDesignLockPathsBlock(project: ProjectArg): string | null;
}

export interface RouterDispatchCtx {
  engine: MessageRouterEngine;
  projectId: string;
  message: string;
  state: PhaseStateArg;
  project: ProjectArg;
  resolveTechAgentId: (phase: number) => string;
}

export type RouterOutcome = 'routed' | 'refused' | 'none';

interface ConversationHandlerDescriptor {
  invoke: (ctx: RouterDispatchCtx) => Promise<void>;
  refuseChat?: boolean;
}

const DEV_V2_BRIEFING_PHASES = new Set([1, 2, 3, 8, 9, 11, 15]);
const DEV_V2_LOCK_PREFIX_PHASES = new Set([8, 9, 10, 11]);

function devV2Briefing(ctx: RouterDispatchCtx, phase: number): string | null {
  if (!DEV_V2_BRIEFING_PHASES.has(phase)) return null;
  const agentId = getPhaseAgentId(phase, ctx.project);
  return agentId ? getDevV2Briefing(agentId) : null;
}

function devV2LockPrefix(ctx: RouterDispatchCtx, phase: number): string {
  const lockPathsBlock = ctx.engine.buildDesignLockPathsBlock(ctx.project);
  const sessionEntry = ctx.state.continueSessions.get(`phase${phase}`);
  const isFirstTurn = !sessionEntry?.alive;
  return lockPathsBlock && DEV_V2_LOCK_PREFIX_PHASES.has(phase) && isFirstTurn ? `${lockPathsBlock}\n\n` : '';
}

function devV2TechInvoke(phase: number, withBriefing: boolean): (ctx: RouterDispatchCtx) => Promise<void> {
  return (ctx) => {
    const briefing = withBriefing ? devV2Briefing(ctx, phase) : null;
    const lockPrefix = devV2LockPrefix(ctx, phase);
    const body = briefing ? `${briefing}\n\n${ctx.message}` : ctx.message;
    return ctx.engine.handleTechPhaseMessage(
      ctx.projectId,
      `${lockPrefix}${body}`,
      ctx.state,
      phase,
      ctx.resolveTechAgentId(phase),
    );
  };
}

const DEV_FEATURE_ROUTES: Record<number, ConversationHandlerDescriptor> = {
  1: { invoke: (c) => c.engine.handlePhase1Message(c.projectId, c.message, c.state) },
  3: { invoke: (c) => c.engine.handlePhase3Message(c.projectId, c.message, c.state) },
  5: { invoke: (c) => c.engine.handleTechPhaseMessage(c.projectId, c.message, c.state, 5, c.resolveTechAgentId(5)) },
  6: { invoke: (c) => c.engine.handleTechPhaseMessage(c.projectId, c.message, c.state, 6, c.resolveTechAgentId(6)) },
  7: { invoke: (c) => c.engine.handleTechPhaseMessage(c.projectId, c.message, c.state, 7, c.resolveTechAgentId(7)) },
  8: { invoke: (c) => c.engine.handleTechPhaseMessage(c.projectId, c.message, c.state, 8, c.resolveTechAgentId(8)) },
  9: { invoke: (c) => c.engine.handlePhase9Message(c.projectId, c.message, c.state) },
  10: { invoke: (c) => c.engine.handlePhase10Message(c.projectId, c.message, c.state) },
  12: { invoke: (c) => c.engine.handlePhase12Message(c.projectId, c.message, c.state) },
};

const SECURITY_ROUTES: Record<number, ConversationHandlerDescriptor> = {
  4: { invoke: (c) => c.engine.handleSecurityPhase4Message(c.projectId, c.message, c.state, c.project) },
  5: { invoke: (c) => c.engine.handleSecurityPhase5Message(c.projectId, c.message, c.state, c.project) },
  6: { invoke: (c) => c.engine.handleSecurityPhase6SpecReviewMessage(c.projectId, c.message, c.state, c.project) },
  7: { invoke: (c) => c.engine.handleSecurityPhase7Message(c.projectId, c.message, c.state, c.project) },
  9: { invoke: (c) => c.engine.handleSecurityPhase9Message(c.projectId, c.message, c.state, c.project) },
};

const ARCHITECTURE_ROUTES: Record<number, ConversationHandlerDescriptor> = {
  2: { invoke: (c) => c.engine.handleArchitecturePhase2TriageMessage(c.projectId, c.message, c.state, c.project) },
  4: { invoke: (c) => c.engine.handleArchitecturePhase4DecisionMessage(c.projectId, c.message, c.state, c.project) },
  6: {
    invoke: (c) => c.engine.handleArchitecturePhase6SpecValidationMessage(c.projectId, c.message, c.state, c.project),
  },
  7: {
    invoke: (c) => c.engine.handleArchitecturePhase7SpecEnricherMessage(c.projectId, c.message, c.state, c.project),
  },
  9: { invoke: (c) => c.engine.handlePhase12Message(c.projectId, c.message, c.state, 9) },
};

const BUG_ROUTES: Record<number, ConversationHandlerDescriptor> = {
  1: { invoke: (c) => c.engine.handleBugPhase1DiscoveryMessage(c.projectId, c.message, c.state, c.project) },
  3: { invoke: (c) => c.engine.handleBugPhase3ConsolidationMessage(c.projectId, c.message, c.state, c.project) },
  5: { invoke: (c) => c.engine.handleBugPhase5SpecValidatorMessage(c.projectId, c.message, c.state, c.project) },
  7: { invoke: (c) => c.engine.handlePhase12Message(c.projectId, c.message, c.state, 7) },
};

const DEV_V2_ROUTES: Record<number, ConversationHandlerDescriptor> = {
  1: { invoke: (c) => c.engine.handlePhase1MessageDevV2(c.projectId, c.message, c.state, devV2Briefing(c, 1)) },
  3: { invoke: (c) => c.engine.handlePhase3MessageDevV2(c.projectId, c.message, c.state, devV2Briefing(c, 3)) },
  5: { invoke: async () => {}, refuseChat: true },
  8: { invoke: devV2TechInvoke(8, true) },
  9: { invoke: devV2TechInvoke(9, true) },
  10: { invoke: devV2TechInvoke(10, false) },
  11: { invoke: devV2TechInvoke(11, true) },
  12: { invoke: (c) => c.engine.handleDevV2Phase12SpecReview(c.projectId, c.message, c.state) },
  13: { invoke: (c) => c.engine.handleDevV2Phase13SpecEnricher(c.projectId, c.message, c.state) },
  15: {
    invoke: (c) => {
      const briefing = devV2Briefing(c, 15);
      return c.engine.handlePhase12Message(
        c.projectId,
        briefing ? `${briefing}\n\n${c.message}` : c.message,
        c.state,
        15,
      );
    },
  },
};

function routesForType(pipelineType: string | undefined): Record<number, ConversationHandlerDescriptor> {
  if (pipelineType === 'architecture-review') return ARCHITECTURE_ROUTES;
  if (pipelineType === 'security') return SECURITY_ROUTES;
  if (pipelineType === 'development-v2') return DEV_V2_ROUTES;
  if (pipelineType === 'bug') return BUG_ROUTES;
  return DEV_FEATURE_ROUTES;
}

export function resolveConversationDescriptor(
  pipelineType: string | undefined,
  phase: number,
): ConversationHandlerDescriptor | undefined {
  return routesForType(pipelineType)[phase];
}

export async function dispatchConversationMessage(ctx: RouterDispatchCtx, phase: number): Promise<RouterOutcome> {
  const descriptor = resolveConversationDescriptor(ctx.project.pipelineType, phase);
  if (!descriptor) return 'none';
  if (descriptor.refuseChat) return 'refused';
  await descriptor.invoke(ctx);
  return 'routed';
}

export function isPureConversationPhase(phase: number, project: { pipelineType?: string } | undefined): boolean {
  const type = project?.pipelineType;
  return !autoPhasesOf(type).has(phase) && !loopPhasesOf(type).has(phase);
}
