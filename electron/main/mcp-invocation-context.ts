export type McpInvocationSurface = 'chat' | 'pipeline' | 'harness' | 'enrich' | 'system-event';

export type McpInvocationLane = 'desktop' | 'telegram' | 'cron';

export interface McpInvocationContext {
  surface: McpInvocationSurface;
  sessionId?: string;
  turnId?: string;
  lane?: McpInvocationLane;
  internalLeaseToken?: string;
  driveProjectId?: string;
  driveTurnId?: string;
}

export interface McpInvocationTurnBinding {
  sessionId: string;
  turnId: string;
  lane?: McpInvocationLane;
}

export function chatInvocationContext(binding: McpInvocationTurnBinding | undefined): McpInvocationContext {
  return binding
    ? {
        surface: 'chat',
        sessionId: binding.sessionId,
        turnId: binding.turnId,
        ...(binding.lane ? { lane: binding.lane } : {}),
      }
    : { surface: 'chat' };
}

export function turnBindingFromContext(
  context: McpInvocationContext | undefined,
): McpInvocationTurnBinding | undefined {
  if (!context?.sessionId || !context.turnId) return undefined;
  return {
    sessionId: context.sessionId,
    turnId: context.turnId,
    ...(context.lane ? { lane: context.lane } : {}),
  };
}
