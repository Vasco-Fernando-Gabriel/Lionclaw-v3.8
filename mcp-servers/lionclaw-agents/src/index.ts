/**
 * lionclaw-agents MCP server.
 *
 * SPEC-001 §11.6 / SP-7.2.
 *
 * Exposes three tools to the orchestrator (Codex / Lion-SDK):
 *   - `list_agents`: list active LionClaw subagents available to the main chat.
 *   - `agent_details`: full profile of ONE subagent by id (lazy expansion of
 *     the compact prompt index — SPEC telegram-cron-compaction 13.3).
 *   - `call_agent`: dispatch a subagent. Preserves the subagent's configured
 *     runtime (cloud / codex / local / external).
 *
 * All tools proxy to the LionClaw main process via the local IPC server.
 * No direct DB or filesystem access from this process.
 *
 * On startup, if the IPC endpoint file is missing the server exits with
 * code 1 (boot-order safeguard; S8 fixes the order).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { callMethod, assertEndpointPresentOrExit } from '../../_shared/local-ipc-client.js';

assertEndpointPresentOrExit();

const server = new McpServer({ name: 'lionclaw-agents', version: '1.0.0' });

server.tool(
  'list_agents',
  'List active LionClaw subagents available to the main chat.',
  {},
  async () => {
    try {
      const result = await callMethod('list_agents', {});
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result) },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    }
  },
);

// SPEC telegram-cron-compaction 13.3: proxy do method jsonrpc `agent_details`.
// Id inexistente/inativo volta `{ error }` no result (padrao IPC do main).
server.tool(
  'agent_details',
  'Full profile of one LionClaw subagent by id: integral description, runtime, model, allowed tools, skills, knowledge-base docs, squad, chat eligibility. Use it when the one-line summary in the prompt index is not enough to decide a delegation.',
  {
    agent_id: z.string().describe('Subagent id (from list_agents or the prompt index).'),
  },
  async ({ agent_id }) => {
    try {
      const result = await callMethod('agent_details', { agent_id });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result) },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'call_agent',
  "Dispatch a subagent. Preserves the subagent's configured runtime (cloud/codex/local/external).",
  {
    agent_id: z.string().describe('Subagent id.'),
    task: z.string().describe('Task description for the subagent.'),
    context: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Free-form structured context for the subagent.'),
    expected_output: z
      .string()
      .optional()
      .describe('Optional description of the expected output shape.'),
  },
  async ({ agent_id, task, context, expected_output }) => {
    try {
      const result = await callMethod('call_agent', {
        agent_id,
        task,
        context,
        expected_output,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result) },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[lionclaw-agents] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[lionclaw-agents] Fatal error:', err);
  process.exit(1);
});
