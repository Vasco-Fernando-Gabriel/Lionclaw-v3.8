import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { callMethod, assertEndpointPresentOrExit } from '../../_shared/local-ipc-client.js';

assertEndpointPresentOrExit();

const server = new McpServer({ name: 'lionclaw-user-question', version: '1.0.0' });

const optionSchema = z.object({
  label: z.string(),
  description: z.string(),
});

const questionSchema = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  multiSelect: z.boolean().optional(),
  options: z.array(optionSchema),
});

server.tool(
  'ask_user_question',
  'Ask the user one or more questions and wait for the response.',
  {
    questions: z.array(questionSchema).describe('One or more questions to ask the user.'),
  },
  async ({ questions }) => {
    try {
      const result = await callMethod('ask_user_question', { questions });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
  console.error('[lionclaw-user-question] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[lionclaw-user-question] Fatal error:', err);
  process.exit(1);
});
