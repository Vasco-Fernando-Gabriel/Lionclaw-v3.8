import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import type { AgentExecutionRequest } from './types';
export function swarmSdkHooks(req: AgentExecutionRequest): { PreToolUse: HookCallbackMatcher[] } {
  return {
    PreToolUse: [
      {
        hooks: [
          async (event, id, options) => {
            if (event.hook_event_name !== 'PreToolUse') return {};
            const input =
              event.tool_input && typeof event.tool_input === 'object' && !Array.isArray(event.tool_input)
                ? (event.tool_input as Record<string, unknown>)
                : {};
            const result = await req.permission.canUseTool?.(event.tool_name, input, {
              signal: options.signal,
              toolUseID: id ?? event.tool_use_id,
              requestId: `swarm-hook:${id ?? event.tool_use_id}`,
            });
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: result?.behavior === 'allow' ? 'allow' : 'deny',
                ...(result?.behavior === 'deny' ? { permissionDecisionReason: result.message } : {}),
              },
            };
          },
        ],
      },
    ],
  };
}
