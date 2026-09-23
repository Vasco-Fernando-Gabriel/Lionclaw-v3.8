import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({
  getDynamicWorkflowRun: vi.fn(() => null),
  getDynamicWorkflowDefinition: vi.fn(() => null),
  listDynamicWorkflowRunsByStatus: vi.fn(() => []),
  setDynamicWorkflowRunStatus: vi.fn(),
  updateDynamicWorkflowRun: vi.fn(),
  upsertDynamicWorkflowNodeRun: vi.fn(),
  updateDynamicWorkflowNodeRun: vi.fn(),
  listDynamicWorkflowNodeRuns: vi.fn(() => []),
  insertDynamicWorkflowEvent: vi.fn(() => ({})),
  listDynamicWorkflowRecentEvents: vi.fn(() => []),
  insertDynamicWorkflowGateDecision: vi.fn(() => ({})),
  insertDynamicWorkflowArtifact: vi.fn(() => ({})),
  insertDynamicWorkflowMessage: vi.fn(() => ({})),
  listDynamicWorkflowMessages: vi.fn(() => []),
  getDynamicWorkflowRunCostAggregate: vi.fn(() => ({})),
  createDynamicWorkflowNode: vi.fn(() => ({})),
  getDynamicWorkflowNodeByKey: vi.fn(() => null),
  updateDynamicWorkflowNodeSprintMeta: vi.fn(),
  updateDynamicWorkflowDefinition: vi.fn(),
  upsertDynamicWorkflowSprint: vi.fn(() => ({})),
  updateDynamicWorkflowSprint: vi.fn(),
  listDynamicWorkflowSprints: vi.fn(() => []),
  materializeDynamicWorkflowSprintPlan: vi.fn(),
  getDynamicWorkflowPriorMaterialization: vi.fn(() => null),
  appendDynamicWorkflowJournalEntry: vi.fn(),
  listDynamicWorkflowJournalEntries: vi.fn(() => []),
  truncateDynamicWorkflowJournalFrom: vi.fn(),
  createDynamicWorkflowDefinition: vi.fn(() => ({})),
  repointDynamicWorkflowRunDefinition: vi.fn(),
  claimAdjustmentsForNode: vi.fn(() => []),
  getSetting: vi.fn(() => undefined),
  getConsumedAdjustmentsForNode: vi.fn(() => []),
}));
vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: vi.fn() }));

import {
  createDefaultRunnerDeps,
  makeRealClaudeCompatBackend,
  makeRealCloserAgentTurn,
  CLOSER_AUTO_APPROVED_TOOLS,
} from '../dynamic-workflows/workflow-runner-deps';
import {
  runClaudeCompatNode,
  type ClaudeCompatExecInput,
  type ClaudeCompatExecResult,
} from '../dynamic-workflows/workflow-claude-compat-executor';
import type {
  ClaudeCompatRunInput,
  ComposedToolInput,
  ToolDecision,
} from '../dynamic-workflows/workflow-agent-adapter';
import type { AgentQueryConfig } from '../agent-config-resolver';

function fakeConfig(over: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
  return {
    model: 'claude-test',
    systemPrompt: 'voce e um agente',
    allowedTools: ['Read', 'Grep'],
    mcpServers: [],
    maxTurns: undefined,
    effort: 'medium',
    thinking: 'adaptive',
    thinkingBudget: undefined,
    runtime: 'cloud',
    ...over,
  };
}

function fakeRunNode(capture?: (input: ClaudeCompatExecInput) => void): typeof runClaudeCompatNode {
  return (async (input: ClaudeCompatExecInput): Promise<ClaudeCompatExecResult> => {
    capture?.(input);
    return {
      output: 'ok',
      model: input.config.model,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.01,
      apiRequests: 1,
      toolUses: 0,
    };
  }) as typeof runClaudeCompatNode;
}

function compatInput(over: Partial<ClaudeCompatRunInput> = {}): ClaudeCompatRunInput {
  return {
    agentId: 'scout',
    runtime: 'cloud',
    model: 'claude-test',
    systemPrompt: 'voce e o scout',
    prompt: 'mapeie o repo',
    cwd: '/repo',
    allowedTools: ['Read', 'Grep'],
    mcpServers: [],
    canUseTool: ((): ToolDecision => ({ behavior: 'allow' })) as unknown as (input: ComposedToolInput) => ToolDecision,
    abortSignal: new AbortController().signal,
    timeoutMs: 60_000,
    ...over,
  };
}

describe('SPEC-010 painel-final: backend claude-compat do node FIADO em producao', () => {
  it('createDefaultRunnerDeps() (producao, sem override) entrega adapterDeps.claudeCompat DEFINIDO', () => {
    const deps = createDefaultRunnerDeps();
    expect(deps.adapterDeps).toBeDefined();
    expect(typeof deps.adapterDeps?.claudeCompat).toBe('function');
  });

  it('o backend real do node CHEGA ao executor dedicado com a particao da policy', async () => {
    let captured: ClaudeCompatExecInput | null = null;
    const backend = makeRealClaudeCompatBackend({
      resolveConfig: async () => fakeConfig({ allowedTools: ['Read', 'Grep', 'Write', 'Bash'] }),
      runNode: fakeRunNode((i) => (captured = i)),
    });

    const raw = await backend(
      compatInput({
        allowedTools: ['Read', 'Grep'], // auto-aprovado particionado (sem Write/Bash)
        mcpServers: [{ 'kb-server': { type: 'stdio', command: 'x' } }] as ClaudeCompatRunInput['mcpServers'],
      }),
    );

    expect(raw.output).toBe('ok');
    expect(raw.costStatus).toBe('known');
    expect(captured).not.toBeNull();
    const inp = captured as unknown as ClaudeCompatExecInput;
    expect(inp.runtime).toBe('cloud');
    expect(inp.cwd).toBe('/repo');
    expect(inp.allowedTools).toEqual(['Read', 'Grep']);
    expect(inp.allowedTools).not.toContain('Write');
    expect(inp.allowedTools).not.toContain('Bash');
    expect(inp.mcpServers).toHaveLength(1);
    expect(typeof inp.canUseTool).toBe('function');
  });

  it('backend real propaga metrics (custo/tokens) para o adapter', async () => {
    const backend = makeRealClaudeCompatBackend({
      resolveConfig: async () => fakeConfig(),
      runNode: fakeRunNode(),
    });
    const raw = await backend(compatInput());
    expect(raw.inputTokens).toBe(10);
    expect(raw.outputTokens).toBe(5);
    expect(raw.costUsd).toBe(0.01);
    expect(raw.model).toBe('claude-test');
  });
});

describe('SPEC-010 painel-final: closer NAO auto-aprova Bash/Write/Edit (guard git-first vivo)', () => {
  it('makeRealCloserAgentTurn passa allowedTools SEM Bash/Write/Edit e canUseTool presente', async () => {
    let captured: ClaudeCompatExecInput | null = null;
    const turn = makeRealCloserAgentTurn({
      resolveConfig: async () =>
        fakeConfig({ allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'], runtime: 'cloud' }),
      runNode: fakeRunNode((i) => (captured = i)),
    });

    const res = await turn({
      runId: 'run-1',
      agentId: 'dynamic-workflow-closer',
      prompt: 'feche o run',
      cwd: '/repo',
      canUseTool: async () => ({ behavior: 'allow' as const }),
    });

    expect(res.ok).toBe(true);
    expect(captured).not.toBeNull();
    const inp = captured as unknown as ClaudeCompatExecInput;
    expect(inp.allowedTools).toEqual(CLOSER_AUTO_APPROVED_TOOLS);
    expect(inp.allowedTools).not.toContain('Bash');
    expect(inp.allowedTools).not.toContain('Write');
    expect(inp.allowedTools).not.toContain('Edit');
    expect(typeof inp.canUseTool).toBe('function');
  });

  it('CLOSER_AUTO_APPROVED_TOOLS e SO o subset read-only seguro', () => {
    expect(CLOSER_AUTO_APPROVED_TOOLS).toEqual(['Read', 'Glob', 'Grep']);
    for (const dangerous of ['Bash', 'Write', 'Edit']) {
      expect(CLOSER_AUTO_APPROVED_TOOLS).not.toContain(dangerous);
    }
  });
});

describe('SPEC-010 painel-final: executor dedicado particiona o allowedTools no SDK (AC-4/8.3)', () => {
  it('runClaudeCompatNode passa SO o auto-aprovado ao builder de options (Bash/Write fora)', async () => {
    let sdkOptions: Record<string, unknown> | null = null;
    const fakeBuilder = (
      _req: unknown,
      config: AgentQueryConfig,
      _cli: string,
      _abort: AbortController,
    ): Record<string, unknown> => {
      const opts = {
        allowedTools: config.allowedTools,
        canUseTool: (_req as { permission: { canUseTool: unknown } }).permission.canUseTool,
        mcpServers:
          config.mcpServers.length > 0
            ? Object.fromEntries(config.mcpServers.flatMap((s) => Object.entries(s)))
            : undefined,
      };
      sdkOptions = opts;
      return opts;
    };

    async function* fakeStream(): AsyncIterable<Record<string, unknown>> {}

    const res = await runClaudeCompatNode(
      {
        runtime: 'cloud',
        config: fakeConfig({ allowedTools: ['Read', 'Grep', 'Write', 'Bash'] }),
        prompt: 'p',
        cwd: '/repo',
        allowedTools: ['Read', 'Grep'],
        mcpServers: [],
        canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        abortSignal: new AbortController().signal,
      },
      {
        buildCloudOptions: fakeBuilder as never,
        query: (() => fakeStream()) as never,
        processStream: (async () => ({
          output: 'done',
          metrics: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        })) as never,
        calculateCost: () => 0,
        resolveCliPath: () => '/cli',
      },
    );

    expect(res.output).toBe('done');
    expect(sdkOptions).not.toBeNull();
    const opts = sdkOptions as unknown as { allowedTools: string[]; canUseTool: unknown };
    expect(opts.allowedTools).toEqual(['Read', 'Grep']);
    expect(opts.allowedTools).not.toContain('Write');
    expect(opts.allowedTools).not.toContain('Bash');
    expect(typeof opts.canUseTool).toBe('function');
  });

  it('runClaudeCompatNode emite stream ao vivo do node (texto em lote + tool_call)', async () => {
    const chunks: Array<{ type: string; content?: string; toolName?: string }> = [];
    async function* fakeStream(): AsyncIterable<Record<string, unknown>> {}
    const res = await runClaudeCompatNode(
      {
        runtime: 'cloud',
        config: fakeConfig({ allowedTools: ['Read'] }),
        prompt: 'p',
        cwd: '/repo',
        allowedTools: ['Read'],
        mcpServers: [],
        canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        abortSignal: new AbortController().signal,
        onStreamChunk: (c) => chunks.push(c),
      },
      {
        buildCloudOptions: ((_r: unknown, c: AgentQueryConfig) => ({
          allowedTools: c.allowedTools,
        })) as never,
        query: (() => fakeStream()) as never,
        processStream: (async (
          _q: unknown,
          opts: {
            onText?: (t: string) => void;
            onToolUseComplete?: (t: string, i: unknown) => void;
          },
        ) => {
          opts.onText?.('ola ');
          opts.onText?.('mundo');
          opts.onToolUseComplete?.('Read', { file_path: '/repo/src/x.ts' });
          return {
            output: 'done',
            metrics: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          };
        }) as never,
        calculateCost: () => 0,
        resolveCliPath: () => '/cli',
      },
    );

    expect(res.output).toBe('done');
    const tool = chunks.find((c) => c.type === 'tool_call');
    expect(tool).toMatchObject({ type: 'tool_call', toolName: 'Read', content: '/repo/src/x.ts' });
    const text = chunks
      .filter((c) => c.type === 'text')
      .map((c) => c.content)
      .join('');
    expect(text).toContain('ola');
    expect(text).toContain('mundo');
  });
});
