import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentQueryConfig } from '../../agent-config-resolver';
import { createSubagentDispatchContext } from '../subagent-dispatch';
import * as subagentDispatch from '../subagent-dispatch';
import { buildGrokNativeToolPolicy, buildGrokSessionTools, stripUnmaterializedGrokTools } from '../grok-session-config';

const { invokeMcpTool } = vi.hoisted(() => ({
  invokeMcpTool: vi.fn(async (_request: unknown) => ({
    content: 'ok',
    displayName: 'mcp__skills__load_skill',
  })),
}));

vi.mock('../../mcp-invoke', () => ({ invokeMcpTool }));
vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async () => ({ skills: { command: 'node', args: [] } })),
  getMcpToolRegistryEntries: vi.fn(() => [
    {
      mcpId: 'skills',
      toolName: 'load_skill',
      description: 'Carrega uma skill pelo nome.',
      inputSchema: JSON.stringify({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      }),
      lastDiscoveredAt: '2026-07-18T00:00:00.000Z',
    },
  ]),
}));

function config(allowedTools: string[] = []): AgentQueryConfig {
  return {
    model: 'grok-4.5',
    systemPrompt: 'Use mcp__skills__load_skill quando existir.\nPreserve esta regra.',
    allowedTools,
    mcpServers: [],
    maxTurns: undefined,
    effort: 'high',
    thinking: 'enabled',
    thinkingBudget: undefined,
    runtime: 'grok',
  };
}

beforeEach(() => invokeMcpTool.mockClear());

describe('Grok session config', () => {
  it('one-shot nao materializa MCP nem anuncia tool ausente', async () => {
    const result = await buildGrokSessionTools({
      profile: 'one-shot',
      config: config(),
      cwd: '/tmp',
      abortController: new AbortController(),
    });
    expect(result.externalTools).toEqual([]);
    expect(result.systemPrompt).not.toContain('mcp__skills__load_skill');
    expect(result.systemPrompt).toContain('Subagentes nativos');
  });

  it('agent-scoped materializa somente o indice MCP allowlisted, sem sombrear builtins', async () => {
    const result = await buildGrokSessionTools({
      profile: 'agent-scoped',
      config: config(['Read', 'Bash', 'mcp__skills__load_skill']),
      cwd: '/tmp',
      abortController: new AbortController(),
    });
    expect(result.externalTools.map((tool) => tool.name)).toEqual(['mcp_invoke', 'mcp_schema']);
    expect(result.systemPrompt).toContain('skills: load_skill');
    expect(result.systemPrompt).not.toContain('mcp__skills__load_skill');
    expect(result.externalTools[0]).toMatchObject({
      description: expect.stringContaining('Executa uma tool MCP'),
      parameters: {
        type: 'object',
        required: ['server', 'tool'],
      },
    });
    await expect(result.externalTools[0]!.handler({ server: 'skills', tool: 'inexistente' })).rejects.toThrow(
      /nao pertence ao escopo MCP/,
    );
  });

  it.each(['workflow', 'pipeline'] as const)(
    '%s usa indice MCP portatil mesmo com configuracao global full',
    async (profile) => {
      const result = await buildGrokSessionTools({
        profile,
        config: config(['Read', 'mcp__skills__load_skill']),
        cwd: '/tmp',
        abortController: new AbortController(),
      });

      expect(result.externalTools.map((tool) => tool.name)).toEqual(['mcp_invoke', 'mcp_schema']);
      expect(result.systemPrompt).not.toContain('mcp__skills__load_skill');
      expect(result.systemPrompt).toContain('Servidores MCP (indice)');
    },
  );

  it.each(['agent-scoped', 'workflow', 'pipeline'] as const)(
    '%s respeita modo index global com meta-tools filtradas pela allowlist',
    async (profile) => {
      const result = await buildGrokSessionTools({
        profile,
        config: config(['Read', 'mcp__skills__load_skill']),
        cwd: '/tmp',
        abortController: new AbortController(),
      });

      expect(result.externalTools.map((tool) => tool.name)).toEqual(['mcp_invoke', 'mcp_schema']);
      expect(result.systemPrompt).toContain('skills: load_skill');
      expect(result.systemPrompt).not.toContain('mcp__skills__load_skill');
    },
  );

  it('perfil sem MCP allowlisted permanece text-only no modo index', async () => {
    const result = await buildGrokSessionTools({
      profile: 'agent-scoped',
      config: config(['Read']),
      cwd: '/tmp',
      abortController: new AbortController(),
    });

    expect(result.externalTools).toEqual([]);
    expect(result.systemPrompt).not.toContain('Servidores MCP');
    expect(result.systemPrompt).toContain('Preserve esta regra.');
  });

  it('reutiliza o mesmo escopo de sessao e turno em chamadas MCP pelo indice', async () => {
    const result = await buildGrokSessionTools({
      profile: 'agent-scoped',
      config: config(['mcp__skills__load_skill']),
      cwd: '/tmp',
      abortController: new AbortController(),
    });
    const tool = result.externalTools.find((entry) => entry.name === 'mcp_invoke')!;

    await tool.handler({ server: 'skills', tool: 'load_skill', args: { name: 'primeira' } }, { toolUseId: 'tool-1' });
    await tool.handler({ server: 'skills', tool: 'load_skill', args: { name: 'segunda' } }, { toolUseId: 'tool-2' });

    expect(invokeMcpTool).toHaveBeenCalledTimes(2);
    const first = invokeMcpTool.mock.calls[0]![0] as { sessionId: string; turnId: string };
    const second = invokeMcpTool.mock.calls[1]![0] as { sessionId: string; turnId: string };
    expect(first.sessionId).toBe(second.sessionId);
    expect(first.turnId).toBe(second.turnId);
    expect(first.turnId).not.toBe('tool-1');
    expect(first.turnId).not.toBe('tool-2');
  });

  it('materializa subagente Lion somente com contexto host e Agent allowlisted', async () => {
    const baseArgs = {
      profile: 'agent-scoped' as const,
      cwd: '/tmp',
      abortController: new AbortController(),
      dispatchContext: createSubagentDispatchContext({
        ownerKind: 'pipeline' as const,
        ownerId: 'p1',
        lane: 'pipeline' as const,
        surface: 'pipeline',
        cwd: '/tmp',
        readRoots: ['/tmp'],
        writeRoots: ['/tmp'],
        permission: { mode: 'default' as const, dangerouslySkipPermissions: false },
        parentAbortSignal: new AbortController().signal,
      }),
    };
    const denied = await buildGrokSessionTools({ ...baseArgs, config: config(['Read']) });
    expect(denied.externalTools.map((tool) => tool.name)).not.toContain('lion_run_subagent');
    const allowed = await buildGrokSessionTools({ ...baseArgs, config: config(['Read', 'Agent']) });
    expect(allowed.externalTools.map((tool) => tool.name)).toContain('lion_run_subagent');
    expect(allowed.systemPrompt).toContain('use lion_run_subagent');
    const dispatch = vi.spyOn(subagentDispatch, 'dispatchLionSubagent').mockResolvedValueOnce({
      ok: false,
      executionId: 'failed-child',
      error: 'filho falhou',
    });
    const tool = allowed.externalTools.find((entry) => entry.name === 'lion_run_subagent')!;
    await expect(
      tool.handler(
        { agentId: 'child', prompt: 'x' },
        { transportCorrelation: { kind: 'mcp-request-id', value: '91' } },
      ),
    ).rejects.toThrow(/filho falhou/);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        transportCorrelation: { kind: 'mcp-request-id', value: '91' },
      }),
      expect.anything(),
    );
    expect(dispatch.mock.calls[0]![0]).not.toHaveProperty('toolUseId');
    dispatch.mockRestore();
  });

  it('gera politica nativa separada e default-deny para one-shot', () => {
    expect(buildGrokNativeToolPolicy('agent-scoped', ['Read', 'Write', 'mcp__skills__load_skill'])).toEqual({
      argv: ['--tools', 'read_file,write_file', '--disable-web-search'],
      effectiveTools: ['read_file', 'write_file'],
    });
    expect(
      buildGrokNativeToolPolicy('agent-scoped', ['Read', 'Edit', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch']),
    ).toEqual({
      argv: ['--tools', 'read_file,search_replace,run_terminal_cmd,grep,list_dir,web_search,web_fetch'],
      effectiveTools: [
        'read_file',
        'search_replace',
        'run_terminal_cmd',
        'grep',
        'list_dir',
        'web_search',
        'web_fetch',
      ],
    });
    expect(buildGrokNativeToolPolicy('one-shot', ['Read'])).toEqual({
      argv: ['--tools', '', '--disable-web-search'],
      effectiveTools: [],
    });
    expect(stripUnmaterializedGrokTools('a\nmcp__x__y\nb', new Set())).toBe('a\nb');
  });
});
