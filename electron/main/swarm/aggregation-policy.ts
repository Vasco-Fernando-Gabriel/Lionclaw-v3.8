import type { CanUseTool, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

export const SWARM_AGGREGATION_TOOLS = ['Read', 'Grep', 'Glob'] as const;
export function isSwarmAggregationTool(name: string): boolean {
  return (SWARM_AGGREGATION_TOOLS as readonly string[]).includes(name);
}
export const swarmAggregationGuard: CanUseTool = async (name, input) =>
  isSwarmAggregationTool(name)
    ? { behavior: 'allow', updatedInput: input }
    : {
        behavior: 'deny',
        message: 'Agregação Swarm permite somente leitura e busca; ferramentas de controle e escrita estão bloqueadas.',
      };

const aggregationHooks: { PreToolUse: HookCallbackMatcher[] } = {
  PreToolUse: [
    {
      hooks: [
        async (event) => {
          if (event.hook_event_name !== 'PreToolUse') return {};
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: isSwarmAggregationTool(event.tool_name) ? 'allow' : 'deny',
              permissionDecisionReason: 'Agregação Swarm permite somente Read/Grep/Glob.',
            },
          };
        },
      ],
    },
  ],
};

export function swarmAggregationSdkOptions() {
  return {
    tools: [...SWARM_AGGREGATION_TOOLS],
    allowedTools: [] as string[],
    settingSources: [] as [],
    mcpServers: {},
    agents: {},
    canUseTool: swarmAggregationGuard,
    hooks: aggregationHooks,
  };
}
