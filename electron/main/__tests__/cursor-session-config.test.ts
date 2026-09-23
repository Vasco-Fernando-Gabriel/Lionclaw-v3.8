import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

const getMCPConfigForAgentMock = vi.fn();
const getMcpToolRegistryEntriesMock = vi.fn();
vi.mock('../mcp-manager', () => ({
  getMCPConfigForAgent: (...args: unknown[]) => getMCPConfigForAgentMock(...args),
  getMcpToolRegistryEntries: (...args: unknown[]) => getMcpToolRegistryEntriesMock(...args),
}));

const invokeMcpToolMock = vi.fn();
const getMcpToolSchemaMock = vi.fn();
vi.mock('../mcp-invoke', () => ({
  invokeMcpTool: (...args: unknown[]) => invokeMcpToolMock(...args),
  getMcpToolSchema: (...args: unknown[]) => getMcpToolSchemaMock(...args),
}));

const dispatchLionSubagentMock = vi.fn();
vi.mock('../agent-runtime/subagent-dispatch', () => ({
  dispatchLionSubagent: (...args: unknown[]) => dispatchLionSubagentMock(...args),
}));

import { buildCursorSessionTools, stripUnmaterializedCursorTools } from '../agent-runtime/cursor-session-config';
import type { SubagentDispatchContext } from '../agent-runtime/types';
import type { CursorToolInvocation } from '../agent-runtime/cursor-sidecar/sidecar-manager';

function fakeHost(parentAbortSignal: AbortSignal): SubagentDispatchContext {
  return {
    ownerKind: 'chat',
    ownerId: 'sess-1',
    sessionId: 'sess-1',
    lane: 'desktop',
    surface: 'cursor-sdk',
    workspace: { cwd: 'C:/tmp/ws', readRoots: ['C:/tmp/ws'], writeRoots: [] },
    permission: { mode: 'default', dangerouslySkipPermissions: false },
    parentAbortSignal,
    rootExecutionId: 'root-1',
    parentExecutionId: 'root-1',
    depth: 0,
    remainingBudget: 16,
    budgetState: { remaining: 16 },
    controlState: {},
    capabilityCeiling: { allowedTools: [], allowedMcpServerIds: [] },
  };
}

function invocation(name: string, args: Record<string, unknown>): CursorToolInvocation {
  return { executionId: 'exec-1', toolName: name, args };
}

const CATALOG_SCHEMA = JSON.stringify({ type: 'object', properties: {} });

beforeEach(() => {
  vi.clearAllMocks();
  getMCPConfigForAgentMock.mockResolvedValue({
    'lionclaw-pipeline-control': { command: 'node', args: [] },
    gateway: { command: 'node', args: [] },
  });
  getMcpToolRegistryEntriesMock.mockReturnValue([
    {
      mcpId: 'lionclaw-pipeline-control',
      toolName: 'pipeline_start',
      description: 'start',
      inputSchema: CATALOG_SCHEMA,
    },
    { mcpId: 'gateway', toolName: 'mcp_invoke_inner', description: 'gw', inputSchema: CATALOG_SCHEMA },
    { mcpId: 'shopify', toolName: 'orders_list', description: 'fora', inputSchema: CATALOG_SCHEMA },
  ]);
});

describe('buildCursorSessionTools — perfil chat', () => {
  it('resolves the scope with surface cursor-sdk + capabilities and declares the bridge tools', async () => {
    const abort = new AbortController();
    const tools = await buildCursorSessionTools({
      profile: 'chat',
      systemPrompt: 'PROMPT-BASE',
      scope: { sessionId: 'sess-1', turnId: 'turn-1' },
      capabilities: { pipelineControl: true, dynamicWorkflows: false },
      dispatchContext: fakeHost(abort.signal),
      allowUserQuestion: true,
      getWindow: () => null,
      abortSignal: abort.signal,
    });
    expect(getMCPConfigForAgentMock).toHaveBeenCalledWith(undefined, {
      surface: 'cursor-sdk',
      capabilities: { pipelineControl: true, dynamicWorkflows: false },
    });
    const names = tools.declarations.map((decl) => decl.name);
    expect(names).toContain('mcp_invoke');
    expect(names).toContain('mcp_schema');
    expect(names).toContain('lion_run_subagent');
    expect(names).toContain('lion_ask_user_question');
    expect(tools.allowedServerIds.sort()).toEqual(['gateway', 'lionclaw-pipeline-control']);
    expect(tools.systemPrompt).toContain('Servidores MCP (indice)');
    expect(tools.systemPrompt).toContain('lionclaw-pipeline-control: pipeline_start');
    expect(tools.systemPrompt).not.toContain('shopify');
    expect(tools.systemPrompt).toContain('lion_run_subagent');
  });

  it('enforces the PER-TOOL restriction before dispatching to the central wrapper', async () => {
    const abort = new AbortController();
    const tools = await buildCursorSessionTools({
      profile: 'chat',
      systemPrompt: '',
      scope: { sessionId: 'sess-1', turnId: 'turn-9' },
      dispatchContext: fakeHost(abort.signal),
      abortSignal: abort.signal,
    });
    const invoke = tools.handlers['mcp_invoke']!;
    await expect(
      invoke(invocation('mcp_invoke', { server: 'gateway', tool: 'nao_existe' }), { signal: abort.signal }),
    ).rejects.toThrow(/nao pertence ao escopo MCP/);
    await expect(
      invoke(invocation('mcp_invoke', { server: 'shopify', tool: 'orders_list' }), { signal: abort.signal }),
    ).rejects.toThrow(/nao pertence ao escopo MCP/);
    expect(invokeMcpToolMock).not.toHaveBeenCalled();

    invokeMcpToolMock.mockResolvedValue({ isError: false, content: 'ok', displayName: 'pipeline_start' });
    const output = await invoke(
      invocation('mcp_invoke', { server: 'lionclaw-pipeline-control', tool: 'pipeline_start', args: { x: 1 } }),
      { signal: abort.signal },
    );
    expect(output).toBe('ok');
    expect(invokeMcpToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'lionclaw-pipeline-control',
        toolName: 'pipeline_start',
        surface: 'cursor-sdk',
        sessionId: 'sess-1',
        turnId: 'turn-9',
        allowedServerIds: expect.arrayContaining(['lionclaw-pipeline-control', 'gateway']),
        context: { surface: 'chat' },
        signal: abort.signal,
      }),
    );
  });

  it('runs LionClaw subagents through dispatchLionSubagent with abort propagation', async () => {
    const parentAbort = new AbortController();
    const tools = await buildCursorSessionTools({
      profile: 'chat',
      systemPrompt: '',
      scope: { sessionId: 'sess-1', turnId: 'turn-2' },
      dispatchContext: fakeHost(parentAbort.signal),
      abortSignal: parentAbort.signal,
    });
    dispatchLionSubagentMock.mockResolvedValue({ ok: true, executionId: 'x', output: 'feito' });
    const handler = tools.handlers['lion_run_subagent']!;
    const callAbort = new AbortController();
    const output = await handler(invocation('lion_run_subagent', { agentId: 'harness-coder', prompt: 'faz' }), {
      signal: callAbort.signal,
    });
    expect(output).toBe('feito');
    const [input, host] = dispatchLionSubagentMock.mock.calls[0] as [
      { agentId: string; prompt: string },
      SubagentDispatchContext,
    ];
    expect(input).toMatchObject({ agentId: 'harness-coder', prompt: 'faz' });
    expect(host.rootExecutionId).toBe('root-1');
    expect(host.ownerKind).toBe('chat');
    expect(host.parentAbortSignal.aborted).toBe(false);
    callAbort.abort();
    expect(host.parentAbortSignal.aborted).toBe(true);

    dispatchLionSubagentMock.mockResolvedValue({ ok: false, executionId: 'y', error: 'agente sumiu' });
    await expect(
      handler(invocation('lion_run_subagent', { agentId: 'x', prompt: 'y' }), { signal: parentAbort.signal }),
    ).rejects.toThrow('agente sumiu');
  });
});

describe('buildCursorSessionTools — perfil remote-chat', () => {
  it('exposes ONLY the subagent dispatcher (telegram/cron nunca herdam a superficie MCP)', async () => {
    const abort = new AbortController();
    const tools = await buildCursorSessionTools({
      profile: 'remote-chat',
      systemPrompt: 'PROMPT',
      scope: { sessionId: 'sess-2', turnId: 'turn-3' },
      dispatchContext: fakeHost(abort.signal),
      abortSignal: abort.signal,
    });
    expect(tools.declarations.map((decl) => decl.name)).toEqual(['lion_run_subagent']);
    expect(getMCPConfigForAgentMock).not.toHaveBeenCalled();
    expect(tools.allowedServerIds).toEqual([]);
  });
});

describe('stripUnmaterializedCursorTools', () => {
  it('removes lines citing mcp__ tools that are not materialized in this session', () => {
    const prompt = [
      'Linha normal.',
      'Use mcp__lionclaw-pipeline-control__pipeline_start para iniciar.',
      'Outra linha normal.',
    ].join('\n');
    const stripped = stripUnmaterializedCursorTools(prompt, new Set(['mcp_invoke']));
    expect(stripped).toContain('Linha normal.');
    expect(stripped).not.toContain('mcp__lionclaw-pipeline-control__pipeline_start');
  });
});
