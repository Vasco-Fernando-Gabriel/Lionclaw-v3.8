import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  LocalIpcClient,
  assertEndpointPresentOrExit,
  withTurnBinding,
  type CallOptions,
} from '../../_shared/local-ipc-client.js';
import { normalizeApproveMetadata } from '../../_shared/approve-metadata.js';

assertEndpointPresentOrExit();

const client = new LocalIpcClient({ callTimeoutMs: 35 * 60 * 1000 });

const LANE: string | undefined = (() => {
  const raw = process.env['LIONCLAW_MCP_LANE'];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
})();

const PIPELINE_TYPES = ['development', 'development-v2', 'security', 'feature', 'architecture-review', 'bug'] as const;

const server = new McpServer({ name: 'lionclaw-pipeline-control', version: '1.0.0' });

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

async function proxy(
  method: string,
  params: Record<string, unknown>,
  options: CallOptions = {},
  extra?: unknown,
): Promise<ToolResult> {
  try {
    const result = await client.callMethod(
      method,
      withTurnBinding({ ...params, ...(LANE !== undefined ? { lane: LANE } : {}) }, extra),
      options,
    );
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
      isError: true,
    };
  }
}

server.tool(
  'pipeline_list',
  'List all pipeline projects (id, name, type, current phase, status). Use before creating or driving.',
  {},
  async (extra) => proxy('pipeline_list', {}, {}, extra),
);

server.tool(
  'pipeline_inspect',
  'Inspect a pipeline: current phase, status, and the pending question (when the phase is conversational and awaiting an answer). Use before pipeline_reply / pipeline_approve.',
  {
    id: z.string().describe('Pipeline project id.'),
  },
  async ({ id }, extra) => proxy('pipeline_inspect', { id }, {}, extra),
);

server.tool(
  'pipeline_create',
  'Create a new pipeline and start it. ALWAYS confirm path/type/brief with the human in chat first. pipelineType: development | development-v2 | security | feature | architecture-review | bug (bug = Bug Pipe, 9 phases, for a reported DEFECT: discovery, 3 parallel analyses, consolidation gate with two outcomes, spec, planner, coder/evaluator). Pass drive:"semi"|"full" to take over driving the pipeline right away (create and drive in one step).',
  {
    projectPath: z.string().describe('Absolute path of the target project directory.'),
    pipelineType: z.enum(PIPELINE_TYPES).describe('Pipeline type.'),
    name: z.string().describe('Pipeline project name.'),
    brief: z.string().describe('Initial briefing of what to build (confirmed with the human).'),
    drive: z
      .enum(['semi', 'full'])
      .optional()
      .describe(
        'Optional: take over driving right after creation (semi = escalates control gates to the human; full = reads, evaluates and decides control gates itself).',
      ),
  },
  async ({ projectPath, pipelineType, name, brief, drive }, extra) =>
    proxy(
      'pipeline_create',
      { projectPath, pipelineType, name, brief, drive },
      { idempotent: false, timeoutMs: 5 * 60_000 },
      extra,
    ),
);

server.tool(
  'pipeline_drive',
  'Take over driving an EXISTING pipeline (created via pipeline_create or by the human). Engata o drive na lane desta conversa; se ela ja dirige outro pipeline, pare-o pelo Pipeline ou use a outra lane. mode: "semi" (escalates control gates to the human) or "full" (autonomous: at control gates it reads the artifact, evaluates vs the intent and decides itself - approve if aligned, escalate only if diverging; human gates like Design Lock stay with the human). Use this OR pipeline_create with drive for the orchestrator to drive.',
  {
    id: z.string().describe('Pipeline project id to drive.'),
    mode: z.enum(['semi', 'full']).describe('Autonomy: semi (gated) or full (auto on low-risk gates).'),
  },
  async ({ id, mode }, extra) => proxy('pipeline_drive', { id, mode }, {}, extra),
);

server.tool(
  'pipeline_reply',
  'Reply to the question of the current conversational phase agent. RESOLVES when the phase agent FINISHES its turn (via event), not at dispatch. Only works in a conversational phase.',
  {
    id: z.string().describe('Pipeline project id.'),
    message: z.string().describe('Message/answer for the phase agent.'),
  },
  async ({ id, message }, extra) => proxy('pipeline_reply', { id, message }, { idempotent: false }, extra),
);

server.tool(
  'pipeline_approve',
  'Approve the current phase gate and advance the pipeline. Gate policy comes from the seeded drive prompt: in semi mode escalate control gates (PRD/SPEC validation, sprint validation) to the human; in full mode read the artifact, evaluate vs the intent and decide yourself (approve with a short justification if aligned, pipeline_escalate only if diverging). Human gates (e.g. Design Lock) are never self-approved in any mode. metadata: arch-review phase2 { selectedCandidateId }, dev-v2 phase5 { action:"lock-and-continue" }, bug phase3 { action:"approve-plan" | "close-pipeline" }.',
  {
    id: z.string().describe('Pipeline project id.'),
    metadata: z
      .union([z.record(z.string(), z.unknown()), z.string()])
      .optional()
      .describe(
        'Gate metadata as a JSON object (e.g. { selectedCandidateId }, { action:"lock-and-continue" } or, in the bug pipeline phase 3, { action:"approve-plan" } | { action:"close-pipeline" }). A JSON string of the same object is also accepted.',
      ),
  },
  async ({ id, metadata }, extra) => {
    const normalized = normalizeApproveMetadata(metadata);
    if (!normalized.ok) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: normalized.error }) }],
        isError: true,
      };
    }
    return proxy('pipeline_approve', { id, metadata: normalized.metadata }, { idempotent: false }, extra);
  },
);

server.tool(
  'pipeline_escalate',
  'Escalate the pipeline to the human: posts your message in the chat and PAUSES the drive (awaiting-human) until the human replies. Use it on a control gate in semi mode, or when you disagree with a control gate in full mode. Writing in the chat alone does NOT pause the drive; only pipeline_escalate does.',
  {
    id: z.string().describe('Pipeline project id.'),
    message: z.string().describe('Message for the human (summary + what you need an OK on, or why you disagree).'),
  },
  async ({ id, message }, extra) => proxy('pipeline_escalate', { id, message }, { idempotent: false }, extra),
);

server.tool(
  'pipeline_abort',
  'Abort the pipeline (terminate the current phase execution). Consequential action: confirm with the human if in doubt.',
  {
    id: z.string().describe('Pipeline project id.'),
  },
  async ({ id }, extra) => proxy('pipeline_abort', { id }, {}, extra),
);

server.tool(
  'pipeline_pause',
  'Pause the pipeline (suspend the current phase; can be resumed later by the human).',
  {
    id: z.string().describe('Pipeline project id.'),
  },
  async ({ id }, extra) => proxy('pipeline_pause', { id }, {}, extra),
);

server.tool(
  'design_session_config',
  'Configure the LionDesign Studio session of a development-v2 pipeline: pick the agent/model (e.g. agentId "claude" + model "opus"), reasoning effort and design system. Merges over the current session config and reboots the design session.',
  {
    id: z.string().describe('Pipeline project id (development-v2).'),
    agentId: z.string().optional().describe('LionDesign agent id (e.g. claude | codex | gemini).'),
    model: z
      .string()
      .optional()
      .describe('Model slug or alias accepted by the agent (e.g. opus, sonnet, gemini-2.5-pro).'),
    reasoning: z.enum(['low', 'medium', 'high']).optional().describe('Reasoning effort.'),
    designSystemId: z.string().optional().describe('Design system id to apply to the session.'),
  },
  async ({ id, agentId, model, reasoning, designSystemId }, extra) =>
    proxy('design_session_config', { id, agentId, model, reasoning, designSystemId }, { idempotent: false }, extra),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[lionclaw-pipeline-control] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[lionclaw-pipeline-control] Fatal error:', err);
  process.exit(1);
});
