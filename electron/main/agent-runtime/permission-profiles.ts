import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { AgentPermissionProfile } from './types';

export const PERM_BYPASS_NO_GUARD: AgentPermissionProfile = {
  mode: 'bypassPermissions',
  dangerouslySkipPermissions: true,
};

export const PERM_DEFAULT_WITH_GUARD = (
  guard: CanUseTool,
): AgentPermissionProfile => ({
  mode: 'default',
  dangerouslySkipPermissions: false,
  canUseTool: guard,
});

export const PERM_DEFAULT_NO_BYPASS: AgentPermissionProfile = {
  mode: 'default',
  dangerouslySkipPermissions: false,
};
