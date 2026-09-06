
import { createLogger } from '../logger';
import type { CodexMcpProfile, CodexSurface } from './types';

const logger = createLogger('codex-runtime:mcp-profiles');

export const CHAT_LION_HELPERS = [
  'lionclaw-agents',
  'lionclaw-skills',
  'lionclaw-user-question',
  'pipeline-control',
  'repo-graph',
] as const;

export interface McpProfileInput {
  profile: CodexMcpProfile;
  surface: CodexSurface;
  projectId?: string;
  allowedMcpServerIds?: string[];
  allowedMcpToolNames?: string[];
  chatActiveMcpServerIds?: string[];
  codexLionOnlyServerIds?: string[];
}

export interface ResolvedMcpProfile {
  profile: CodexMcpProfile;
  useUserCodexConfig: boolean;
  dedicatedProfile?: string;
  mcpServerIds: string[];
  mcpToolNames: string[];
  includeLionHelpers: boolean;
  includeCodexLionOnly: boolean;
  sandbox: 'workspace-write' | 'read-only';
  warnings: string[];
}

function dedicatedProfileName(profile: CodexMcpProfile, projectId?: string): string {
  const proj = projectId ? projectId.replace(/[^a-zA-Z0-9_-]/g, '_') : 'noproject';
  return `lionclaw-${profile}-${proj}`;
}

export function resolveMcpProfile(input: McpProfileInput): ResolvedMcpProfile {
  const warnings: string[] = [];

  switch (input.profile) {
    case 'chat': {
      const mcpServerIds = [
        ...(input.chatActiveMcpServerIds ?? []),
        ...(input.codexLionOnlyServerIds ?? []),
      ];
      return {
        profile: 'chat',
        useUserCodexConfig: true,
        dedicatedProfile: undefined,
        mcpServerIds,
        mcpToolNames: [],
        includeLionHelpers: true,
        includeCodexLionOnly: true,
        sandbox: 'workspace-write',
        warnings,
      };
    }

    case 'pipeline': {
      return {
        profile: 'pipeline',
        useUserCodexConfig: false,
        dedicatedProfile: dedicatedProfileName('pipeline', input.projectId),
        mcpServerIds: [],
        mcpToolNames: [],
        includeLionHelpers: false,
        includeCodexLionOnly: false,
        sandbox: 'workspace-write',
        warnings,
      };
    }

    case 'agent-scoped': {
      const serverIds = input.allowedMcpServerIds ?? [];
      const toolNames = input.allowedMcpToolNames ?? [];
      if (serverIds.length === 0 && toolNames.length === 0) {
        const msg =
          'agent-scoped profile resolved with an empty allowlist; run continues with ZERO MCP';
        warnings.push(msg);
        logger.warn(
          { surface: input.surface, projectId: input.projectId },
          msg,
        );
      }
      return {
        profile: 'agent-scoped',
        useUserCodexConfig: false,
        dedicatedProfile: dedicatedProfileName('agent-scoped', input.projectId),
        mcpServerIds: [...serverIds],
        mcpToolNames: [...toolNames],
        includeLionHelpers: false,
        includeCodexLionOnly: false,
        sandbox: 'workspace-write',
        warnings,
      };
    }

    case 'one-shot': {
      return {
        profile: 'one-shot',
        useUserCodexConfig: false,
        dedicatedProfile: dedicatedProfileName('one-shot', input.projectId),
        mcpServerIds: [],
        mcpToolNames: [],
        includeLionHelpers: false,
        includeCodexLionOnly: false,
        sandbox: 'read-only',
        warnings,
      };
    }

    default: {
      const _never: never = input.profile;
      throw new Error(`unhandled MCP profile: ${String(_never)}`);
    }
  }
}
