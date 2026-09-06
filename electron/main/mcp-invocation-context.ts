
export type McpInvocationSurface =
  | 'chat'
  | 'pipeline'
  | 'harness'
  | 'enrich'
  | 'system-event';

export interface McpInvocationContext {
  surface: McpInvocationSurface;
  sessionId?: string;
  turnId?: string;
  internalLeaseToken?: string;
  driveProjectId?: string;
  driveTurnId?: string;
}
