
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { callMethod, assertEndpointPresentOrExit } from '../../_shared/local-ipc-client.js';

assertEndpointPresentOrExit();

const server = new McpServer({ name: 'lionclaw-skills', version: '1.0.0' });

server.tool(
  'list_skills',
  'List LionClaw skills available to the main chat.',
  {},
  async () => {
    try {
      const result = await callMethod('list_skills', {});
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
  'load_skill',
  "Load a skill's body as guidance for the current workflow.",
  {
    skill_name: z.string().describe('Name of the skill to load.'),
  },
  async ({ skill_name }) => {
    try {
      const result = await callMethod('load_skill', { skill_name });
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
  console.error('[lionclaw-skills] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[lionclaw-skills] Fatal error:', err);
  process.exit(1);
});
