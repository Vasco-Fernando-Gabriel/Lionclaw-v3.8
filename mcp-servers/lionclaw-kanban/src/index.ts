
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  LocalIpcClient,
  assertEndpointPresentOrExit,
  type CallOptions,
} from '../../_shared/local-ipc-client.js';

assertEndpointPresentOrExit();

const client = new LocalIpcClient();

const server = new McpServer({ name: 'lionclaw-kanban', version: '1.0.0' });

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

async function proxy(
  method: string,
  params: Record<string, unknown>,
  options: CallOptions = {},
): Promise<ToolResult> {
  try {
    const result = await client.callMethod(method, params, options);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
      isError: true,
    };
  }
}

const WRITE: CallOptions = { idempotent: false };

const cardContentFields = {
  type: z
    .string()
    .nullable()
    .optional()
    .describe('Card type: Bug | Feature | Debito tecnico | Chore (accents/case are normalized; unrecognized becomes empty + warning).'),
  priority: z
    .string()
    .nullable()
    .optional()
    .describe('Priority: Critica | Alta | Media | Baixa (normalized; unrecognized becomes empty + warning).'),
  complexity: z
    .string()
    .nullable()
    .optional()
    .describe('Complexity: Baixa | Media | Alta (normalized).'),
  severity: z
    .string()
    .nullable()
    .optional()
    .describe('Bug severity: S1 | S2 | S3 | S4.'),
  problem: z.string().nullable().optional().describe('Problem statement.'),
  acceptance_criteria: z.string().nullable().optional().describe('Acceptance criteria.'),
  reproduction: z.string().nullable().optional().describe('Numbered reproduction steps (bugs).'),
  acceptance_tests: z.string().nullable().optional().describe('Acceptance tests "when X, then Y" (features).'),
  commit_url: z.string().nullable().optional().describe('Commit/PR URL of the delivery.'),
  doc_ref: z.string().nullable().optional().describe('Spec/doc reference: path relative to the repo or URL.'),
  start_date: z.string().nullable().optional().describe('Start date (ISO yyyy-mm-dd).'),
  due_date: z.string().nullable().optional().describe('Due date (ISO yyyy-mm-dd).'),
  body: z.string().nullable().optional().describe('Free markdown body.'),
};

server.tool(
  'board_create',
  'Create a Kanban board for a REGISTERED local repository (one board per repository). Refuses only: prefix already used, repository already has a board, repository not found.',
  {
    name: z.string().optional().describe('Board name (defaults to the repository name, with a warning).'),
    prefix: z
      .string()
      .describe('Immutable card id prefix, 2-4 uppercase letters (e.g. "LC" -> cards LC-1, LC-2...). Must be unique across boards.'),
    repository_id: z.string().optional().describe('Id of the registered local repository.'),
    repo_path: z.string().optional().describe('Alternative to repository_id: absolute path of the registered repository.'),
  },
  async (args) => proxy('kanban_board_create', args, WRITE),
);

server.tool(
  'board_list',
  'List all Kanban boards with per-column card counts (Backlog / Desenvolvimento / Testes / Done).',
  {},
  async () => proxy('kanban_board_list', {}),
);

server.tool(
  'card_create',
  'Create a card. ONLY title is required; everything else is optional (missing quality fields come back as warnings, never errors). Born in Backlog unless column says otherwise.',
  {
    board: z.string().describe('Board prefix (e.g. "LC") or board id.'),
    title: z.string().describe('Card title (the only required field).'),
    column: z
      .string()
      .optional()
      .describe('Birth column: Backlog | Desenvolvimento | Testes | Done (default Backlog; unrecognized -> Backlog + warning).'),
    ...cardContentFields,
  },
  async (args) => proxy('kanban_card_create', args, WRITE),
);

server.tool(
  'card_get',
  'Get one card in full: all fields, attachments and the event timeline (created/moved/delivered/edited/reopened/archived..., with actor and reason).',
  {
    board: z.string().describe('Board prefix or id.'),
    local_id: z.number().describe('Card number within the board (the N of "LC-N").'),
  },
  async (args) => proxy('kanban_card_get', args),
);

server.tool(
  'card_query',
  'Query cards. Without board it spans ALL boards (cross-board summary in one call). Filters combine (AND). Returns cards ordered by column, then priority, then creation date.',
  {
    board: z.string().optional().describe('Board prefix or id; omit for all boards.'),
    column: z.string().optional().describe('Filter by column (Backlog | Desenvolvimento | Testes | Done).'),
    type: z.string().optional().describe('Filter by type (Bug | Feature | Debito tecnico | Chore).'),
    priority: z.string().optional().describe('Filter by priority (Critica | Alta | Media | Baixa).'),
    severity: z.string().optional().describe('Filter by severity (S1-S4).'),
    text: z.string().optional().describe('Text search over id ("LC-26"), title, problem and body.'),
    due_before: z.string().optional().describe('Cards with due_date strictly before this ISO date.'),
    stalled_days: z
      .number()
      .optional()
      .describe('Cards sitting in their current column for at least N days.'),
    archived: z.boolean().optional().describe('true = only archived cards; default only active.'),
  },
  async (args) => proxy('kanban_card_query', args),
);

server.tool(
  'card_update',
  'Update card fields (patch: only the fields you pass change; pass null to clear a field). archived: true/false is the archive/unarchive path. Completeness warnings come back informative, never blocking.',
  {
    board: z.string().describe('Board prefix or id.'),
    local_id: z.number().describe('Card number within the board.'),
    title: z.string().optional().describe('New title.'),
    ...cardContentFields,
    archived: z.boolean().optional().describe('true archives, false unarchives (reversible; logs the event).'),
  },
  async (args) => proxy('kanban_card_update', args, WRITE),
);

server.tool(
  'card_move',
  'Move a card to another column. NEVER blocks a transition: moving to Done without commit or backwards without reason just returns warnings. Moving to Desenvolvimento sets start_date if empty. Backwards out of Done logs a "reopened" event.',
  {
    board: z.string().describe('Board prefix or id.'),
    local_id: z.number().describe('Card number within the board.'),
    to_column: z
      .string()
      .describe('Target column: Backlog | Desenvolvimento | Testes | Done (closed set; unrecognized is the one real refusal).'),
    reason: z.string().optional().describe('Reason for the move (recommended when moving backwards).'),
  },
  async (args) => proxy('kanban_card_move', args, WRITE),
);

server.tool(
  'card_deliver',
  'Formal delivery of a card: commit (URL or hash) is REQUIRED for this tool (a bare hash is resolved to a URL via the repo remote; without a resolvable remote the raw hash is stored + warning). Moves to Testes by default (or to_column) and logs a "delivered" event with the commit in the reason. To move to Done without commit use card_move (free, just warns).',
  {
    board: z.string().describe('Board prefix or id.'),
    local_id: z.number().describe('Card number within the board.'),
    commit: z.string().describe('Commit URL or hash (required; the central argument of this tool).'),
    to_column: z.string().optional().describe('Target column of the delivery: Testes (default) or Done.'),
  },
  async (args) => proxy('kanban_card_deliver', args, WRITE),
);

server.tool(
  'card_delete',
  'Delete a card. Default ARCHIVES (reversible via card_update archived:false). hard:true really deletes (events + attachments + files gone) - only under explicit owner order.',
  {
    board: z.string().describe('Board prefix or id.'),
    local_id: z.number().describe('Card number within the board.'),
    hard: z.boolean().optional().describe('true = irreversible hard delete; default archives.'),
  },
  async (args) => proxy('kanban_card_delete', args, WRITE),
);

server.tool(
  'card_attach',
  'Attach a local file to a card: the file is COPIED into the LionClaw kanban store (outside the repo). Refuses only nonexistent path or real IO failure. Files over 25MB copy normally + warning.',
  {
    board: z.string().describe('Board prefix or id.'),
    local_id: z.number().describe('Card number within the board.'),
    file_path: z.string().describe('Absolute path of the existing local file to copy.'),
  },
  async (args) => proxy('kanban_card_attach', args, WRITE),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[lionclaw-kanban] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[lionclaw-kanban] Fatal error:', err);
  process.exit(1);
});
