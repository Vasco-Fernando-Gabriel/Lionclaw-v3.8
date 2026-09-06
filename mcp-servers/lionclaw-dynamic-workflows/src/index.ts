
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  LocalIpcClient,
  assertEndpointPresentOrExit,
  type CallOptions,
} from '../../_shared/local-ipc-client.js';
import { AUTHORING_GUIDE_TEXT } from '../../_shared/dynamic-workflow-authoring-guide.js';

assertEndpointPresentOrExit();

const client = new LocalIpcClient({ callTimeoutMs: 15 * 60 * 1000 });

const server = new McpServer({ name: 'lionclaw-dynamic-workflows', version: '1.0.0' });

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

server.tool(
  'dynamic_workflow_authoring_guide',
  'READ-ONLY. Returns the canonical authoring guide for dynamic workflows: the reference workflow.js (compilable, current grammar), the allowed agentType list, the agent() RETURN CONTRACT (node without schema = writer returns a STRING; node with schema returns the parsed object; never String(obj); null ONLY after your explicit skip on the failure:<nodeId> gate; textOf helper), the sprint-planner plan shape the .js reads (sprints[].features[].acceptanceCriteria, writeSetHint), the short-step doctrine (1 AC per writer unit with maxTurns 150, greenCheck per unit, npm run build on the LAST unit of each sprint, ONE validator round per sprint scoped by ARQUIVOS TOCADOS, refuter ONLY for P1 findings (P2/P3 go straight to advisory), P1-only convergence, ONE sprint fixer, re-refute, scout reporter with digest artifact via JSON.stringify) and the FORBIDDEN list (gate(), materializeSprintPlan, nodes without timeoutMs or > 45 min, writer with schema, agentType outside the list, sprintIndex in greenCheck, String(obj) in prompts). Call it BEFORE every dynamic_workflow_author. No input, no side effect.',
  {},
  async () => ({ content: [{ type: 'text' as const, text: AUTHORING_GUIDE_TEXT }] }),
);

server.tool(
  'dynamic_workflow_author',
  'Author a claude-code dynamic workflow BY CONVERSATION and create + start it in one step, WITHOUT a builder or SPEC: YOU (the orchestrator) write the workflow.js source yourself and pass it in workflowJsSource. ALWAYS call dynamic_workflow_authoring_guide BEFORE authoring and follow its reference .js (every node with timeoutMs <= 45 min, no gate(), writer without schema, greenCheck per unit, npm run build on the last unit of each sprint, one validator round per sprint, refuter ONLY for P1 findings, P1-only convergence). RETURN CONTRACT: agent() WITHOUT schema (every writer) returns a STRING (raw text); WITH schema it returns the parsed object; never String(obj) or concatenate an object into a prompt (that is how "[object Object]" reached validators and digests); pass writer output through the guide\'s textOf helper. agent() returns null ONLY after YOUR explicit skip on the failure:<nodeId> gate (a non-retryable node failure PAUSES the coordinator inside agent() until you decide via dynamic_workflow_approve payload.action retry/switch-agent/skip/abort): the .js must record a skip and move on without fabricating output. Never read ~/.lionclaw/workflow-templates (dead copy). The .js IS the workflow (claude-code parity): it compiles to a coordinator that spawns agents from the catalog via agent(prompt, { agentType, label?, phase?, schema?, model?, effort?, timeoutMs, maxTurns? }). maxTurns (1..400) caps the turns of that node (writers: 150; a unit above ~20 min or ~100 turns must be split into 2 ACs instead). Each agent() call may set its OWN model and effort (reasoning) - pick per-node model/effort from what you and the user discussed. model must stay INSIDE the runtime family of the agentType (claude-* on cloud, glm-* on zai, minimax-* on minimax-tp, gpt-*/codex-* on codex, grok-* on grok; cross-family is fatal model-cross-family). Model override is accepted on cloud/zai/minimax-tp/codex/grok and is fatal on kimi/local/external. effort is one of low|medium|high|xhigh|max|ultra: Claude-compatible nodes map xhigh/max/ultra to max; max requires a runtime/model that advertises it (including tiered Kimi), while ultra only runs on CODEX models that announce it (gpt-5.6 family) and delegates to internal Codex subagents at 2-3x token cost; NEVER pick "ultra" on your own: only when the human explicitly asked for that level. Effort override is accepted on cloud/zai/minimax-tp/codex/grok and is model-aware on Kimi: tiered Kimi models accept only their advertised tiers (currently low/high/max), while boolean-only Kimi models reject explicit effort; local/external are fatal. Grok accepts low/medium/high and executes authored nodes with the node guard, filtered MCP bridge, native-tool allowlist and dedicated Grok CLI profile. Example: agent(implementPrompt, { agentType: "dynamic-workflow-coder-codex", model: "gpt-5.6-sol", effort: "max" }) for the heavy coder next to agent(checkPrompt, { agentType: "dynamic-workflow-validator-spec", effort: "low" }) for a cheap validator. Use it for read-only code analysis/validation, for CREATING documents/specs, and for code development: writer agents from the dynamic-workflow squad ARE allowed (e.g. dynamic-workflow-coder, dynamic-workflow-fixer, dynamic-workflow-doc-writer) - anything they write MUST pass the synthetic cc-delivery gate before landing (merge only via your approveGate decision, local and reversible; pushing to remote is always hard-blocked in code). HARD RULES still enforced in code (not prompt): (1) every agentType MUST be a STRING LITERAL (agentType: "dynamic-workflow-scout"), never a variable/expression; (2) only agents from the dynamic-workflow squad allowlist may be referenced - any other squad is REJECTED before the run is created, with the real reason returned. On compile failure the real reason is returned. There is a rate limit on authoring per chat session.',
  {
    projectPath: z.string().describe('Absolute path of the target project directory.'),
    name: z.string().optional().describe('Workflow name.'),
    workflowJsSource: z
      .string()
      .describe('The claude-code workflow.js source YOU wrote (ESM subset). The .js IS the workflow - no SPEC, no manifest.'),
    start: z
      .boolean()
      .optional()
      .describe('Start the run immediately after creating it (default true). Set false to create-only and start later.'),
  },
  async ({ projectPath, name, workflowJsSource, start }) =>
    proxy(
      'dynamic_workflow_author',
      { projectPath, name, workflowJsSource, start },
      { idempotent: false, timeoutMs: 5 * 60_000 },
    ),
);

server.tool(
  'dynamic_workflow_start',
  'Start a workflow run that was already created (by dynamic_workflow_author with start=false). No-op with a notice if the run is already running. Idempotent and retryable.',
  {
    runId: z.string().describe('Workflow run id.'),
  },
  async ({ runId }) => proxy('dynamic_workflow_start', { runId }),
);

server.tool(
  'dynamic_workflow_inspect',
  'Inspect a workflow run: status, current phase/node, recent events, pending decision (gate/question/error/provider) and cost. Use BEFORE replying/approving/intervening and before reporting to the human.',
  {
    runId: z.string().describe('Workflow run id.'),
  },
  async ({ runId }) => proxy('dynamic_workflow_inspect', { runId }),
);

server.tool(
  'dynamic_workflow_reply',
  'Reply to a conversational node question (or send content to the next node) of a workflow run, on behalf of the human. Only targets a pending/next node; a stale target (the node already changed) is refused with the current snapshot.',
  {
    runId: z.string().describe('Workflow run id.'),
    message: z.string().describe('Message/answer for the node.'),
    targetNodeId: z.string().optional().describe('Optional node id this reply is meant for.'),
  },
  async ({ runId, message, targetNodeId }) =>
    proxy('dynamic_workflow_reply', { runId, message, targetNodeId }, { idempotent: false }),
);

server.tool(
  'dynamic_workflow_approve',
  'Approve (or reject) a gate of a workflow run that YOU drive (mode orchestrator). Authored runs have only HOST gates: boundary:<phase> / boundary:coordinator-finished (opened when the window semaphore is ATENCAO or SEM VEREDITO; approve = continue with the risk stated, reject = pause and keep the verdict until a new judgement), failure:<nodeId> (a node failed non-retryably or exhausted retries: the coordinator is PAUSED inside that agent() until you decide; decision "approve" + payload.action = retry (default; optional payload.instruction is appended to the SAME node as [AJUSTE DO ORQUESTRADOR], new attempt now, worktree kept from the wip(failed) commit), switch-agent (+payload.agentType from the dynamic-workflow squad), skip (agent() returns null to the .js, which records the skip and moves on; the failed worktree is reset) or abort (kills the run); decision "reject" = keep the run paused), and cc-delivery (LOCAL squash-merge of the run worktree, reversible, never pushes). Always dynamic_workflow_inspect first and approve only the pendingDecision gate. gate() is fatal in authored .js, so there is no plan-review gate: replan does nothing on these runs (legacy manifest runs only).',
  {
    runId: z.string().describe('Workflow run id.'),
    gateId: z.string().describe('Gate id to decide (boundary:<phase>, boundary:coordinator-finished, failure:<nodeId>, cc-delivery).'),
    decision: z.enum(['approve', 'reject']).describe('Gate decision.'),
    reason: z.string().optional().describe('Optional reason recorded in the audit trail.'),
    payload: z
      .object({
        action: z
          .enum(['retry', 'switch-agent', 'skip', 'abort', 'replan'])
          .optional()
          .describe(
            'failure:<nodeId> gate: retry (default), switch-agent, skip (null to the .js) or abort. replan = legacy plan-review only.',
          ),
        instruction: z
          .string()
          .optional()
          .describe('retry only: steering instruction appended to the failed node prompt as [AJUSTE DO ORQUESTRADOR].'),
        agentType: z
          .string()
          .optional()
          .describe('switch-agent only: the new agentType (dynamic-workflow squad, e.g. dynamic-workflow-coder-codex).'),
      })
      .optional()
      .describe(
        'Gate payload. failure:<nodeId>: { action: retry | switch-agent | skip | abort, instruction?, agentType? }. Ignored on boundary:* and cc-delivery.',
      ),
    replan: z
      .boolean()
      .optional()
      .describe(
        'Legacy manifest runs only (plan-review gate): send the plan back to the planner for one more round. Authored runs have no plan-review gate (gate() is fatal), so this is ignored on boundary:*, failure:* and cc-delivery.',
      ),
  },
  async ({ runId, gateId, decision, reason, payload, replan }) =>
    proxy(
      'dynamic_workflow_approve',
      {
        runId,
        gateId,
        decision,
        reason,
        ...(payload ? { payload } : replan ? { payload: { action: 'replan' } } : {}),
      },
      { idempotent: false },
    ),
);

server.tool(
  'dynamic_workflow_intervene',
  'Intervene in a workflow run to change course (never edit state out of band). Supported: pause/resume, rerun-node (needs nodeId + instruction: re-executes an ALREADY COMPLETED node with your instruction appended as [AJUSTE DO ORQUESTRADOR]; the host first quiesces the run (pauses and waits for the in-flight child; error after 60 s, nothing truncated), truncates the journal from that node and resumes; later commits in the worktree are NOT undone. On a FAILED node (gate failure:<nodeId> pending) rerun-node = retry with instruction: same as dynamic_workflow_approve payload { action: "retry", instruction }), adjust-next-node (needs instruction; nodeId = exact node id of ANY node that has not started yet (a future node in a later phase is accepted and the adjustment is kept until that node claims it; only an already started/completed node is refused), or "*" = the next node that starts in the current phase; in a parallel fan-out only the FIRST node to start gets "*", so target the nodeId for fan-out; steer the next node, e.g. tell the coordinator to launch MORE adversarial validators on the current sprint), switch-agent (swap the agent of a pending/interrupted node for a different one in the catalog: needs nodeId + newAgentId + reason; if the new agent expands the effective permission the run asks for a human gate and the swap is NOT applied yet), approve-gate (boundary:<phase> / boundary:coordinator-finished / cc-delivery; gate() is fatal in authored .js so there is no plan-review gate), reply. To add MORE validators on an authored run: rerun-node on the validator/reporter node with an instruction, adjust-next-node to steer the coordinator, or dynamic_workflow_edit_coordinator (requires the run quiesced: pause first) to rewrite the topology with extra validator rounds. When the human tells you to do one of these in the chat, DO IT (call this tool): the human gave the word, you execute. Never reply that they should click a button.',
  {
    runId: z.string().describe('Workflow run id.'),
    intervention: z
      .object({
        type: z
          .enum([
            'pause',
            'resume',
            'rerun-node',
            'adjust-next-node',
            'switch-agent',
            'approve-gate',
            'reply',
          ])
          .describe('Intervention type (14.1.1; rerun-node per SPEC orquestrador-driver D9).'),
        reason: z.string().optional().describe('Reason (required for some types: switch-agent requires it).'),
        acceptBoundary: z
          .boolean()
          .optional()
          .describe('resume only: explicitly ACCEPT a rejected boundary gate (boundary:*) and reset its frozen window; without it the resume re-reaches the boundary and the gate reopens.'),
        nodeId: z
          .string()
          .optional()
          .describe('Target node id. rerun-node: the COMPLETED node to re-execute, or the FAILED node with a failure:<nodeId> gate pending (= retry with instruction) (required). adjust-next-node: exact id of any node not started yet (future nodes accepted) or "*" (next node that starts). switch-agent: the pending/interrupted node whose agent is swapped.'),
        instruction: z.string().optional().describe('Steering instruction (rerun-node: required, appended to the node prompt; adjust-next-node: required, kept until the target node claims it).'),
        newAgentId: z
          .string()
          .optional()
          .describe('New agent id from the catalog (switch-agent only). Must be an active agent.'),
        gateId: z.string().optional().describe('Gate id (approve-gate).'),
        decision: z.enum(['approve', 'reject']).optional().describe('Decision (approve-gate).'),
        message: z.string().optional().describe('Message (reply).'),
        targetNodeId: z.string().optional().describe('Target node (reply).'),
      })
      .describe('Intervention payload (discriminated by type).'),
  },
  async ({ runId, intervention }) =>
    proxy('dynamic_workflow_intervene', { runId, intervention }, { idempotent: false }),
);

server.tool(
  'dynamic_workflow_abort',
  'Abort a workflow run (terminate the current execution). The branch dynworkflow/<runId> stays alive by default for autopsy. Consequential action: confirm with the human if in doubt. No-op if the run already ended.',
  {
    runId: z.string().describe('Workflow run id.'),
  },
  async ({ runId }) => proxy('dynamic_workflow_abort', { runId }),
);

server.tool(
  'dynamic_workflow_edit_coordinator',
  'Rewrite the coordinator workflow.js / topology of a paused run TRANSACTIONALLY (this is the ONLY way to edit a live workflow - never use a generic Write). Requires quiescence: the run must be paused with no writer in flight and no merge in progress (pause it first via dynamic_workflow_intervene { type: "pause" } and let the running attempt finish). The tool writes a temp file in the run dir, recompiles, revalidates (a coder/writer node may NEVER declare a schemaRef), and only on success creates a new auditable revision, re-points the run to it, and lets resume re-run from the divergence point via the journal. The internal manifest is ALWAYS re-derived by the engine from the compiled meta - the edit accepts ONLY workflowJsSource, never a manifest. On compile/validate failure the run is NOT mutated and the real reason is returned.',
  {
    runId: z.string().describe('Workflow run id (must be paused/quiescent).'),
    workflowJsSource: z.string().describe('The rewritten coordinator workflow.js source (ESM subset).'),
    reason: z.string().describe('Why the edit is being made (recorded in the audit trail).'),
    resume: z
      .boolean()
      .optional()
      .describe('Resume the run automatically after the edit (default false; otherwise resume via intervene).'),
  },
  async ({ runId, workflowJsSource, reason, resume }) =>
    proxy(
      'dynamic_workflow_edit_coordinator',
      { runId, workflowJsSource, reason, resume },
      { idempotent: false, timeoutMs: 5 * 60_000 },
    ),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[lionclaw-dynamic-workflows] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[lionclaw-dynamic-workflows] Fatal error:', err);
  process.exit(1);
});
