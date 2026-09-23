import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMcpToolSchema, invokeMcpTool } = vi.hoisted(() => ({
  getMcpToolSchema: vi.fn(),
  invokeMcpTool: vi.fn(),
}));

vi.mock('../../db', () => ({ getSetting: () => 'index' }));
vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: async () => ({ allowed: { command: 'node', args: ['allowed.js'] } }),
  getMcpToolRegistryEntries: () => [
    {
      mcpId: 'allowed',
      toolName: 'visible',
      description: 'Tool permitida',
      inputSchema: JSON.stringify({ type: 'object', properties: {}, additionalProperties: false }),
    },
  ],
}));
vi.mock('../../mcp-invoke', () => ({
  getMcpToolSchema,
  invokeMcpTool,
}));

import type { AgentQueryConfig } from '../../agent-config-resolver';
import { buildGrokSessionTools } from '../grok-session-config';

const config: AgentQueryConfig = {
  model: 'grok-4.5',
  systemPrompt: '',
  allowedTools: [],
  mcpServers: [],
  maxTurns: undefined,
  effort: 'high',
  thinking: 'enabled',
  thinkingBudget: undefined,
  runtime: 'grok',
};

beforeEach(() => {
  getMcpToolSchema.mockReset();
  getMcpToolSchema.mockReturnValue({ content: 'schema permitido' });
  invokeMcpTool.mockReset();
  invokeMcpTool.mockResolvedValue({ content: 'ok', displayName: 'allowed/visible' });
});

describe('Grok MCP index scope', () => {
  it('mcp_schema nao consulta registry para server fora de allowedServerIds', async () => {
    const built = await buildGrokSessionTools({
      profile: 'chat',
      config,
      cwd: '/tmp',
      abortController: new AbortController(),
    });
    const schema = built.externalTools.find((tool) => tool.name === 'mcp_schema');
    expect(schema).toBeDefined();

    await expect(schema!.handler({ server: 'hidden', tool: 'secret' })).rejects.toThrow('nao pertence ao escopo');
    expect(getMcpToolSchema).not.toHaveBeenCalled();

    const allowed = await schema!.handler({ server: 'allowed', tool: 'visible' });
    expect(allowed.output).toBe('schema permitido');
    expect(getMcpToolSchema).toHaveBeenCalledWith('allowed', 'visible');
  });

  it('nega tool fora da allowlist exata mesmo dentro de server permitido', async () => {
    const built = await buildGrokSessionTools({
      profile: 'chat',
      config,
      cwd: '/tmp',
      abortController: new AbortController(),
    });
    const invoke = built.externalTools.find((tool) => tool.name === 'mcp_invoke')!;
    const schema = built.externalTools.find((tool) => tool.name === 'mcp_schema')!;

    await expect(invoke.handler({ server: 'allowed', tool: 'secret', args: {} })).rejects.toThrow(
      'nao pertence ao escopo',
    );
    await expect(schema.handler({ server: 'allowed', tool: 'secret' })).rejects.toThrow('nao pertence ao escopo');
    expect(invokeMcpTool).not.toHaveBeenCalled();
    expect(getMcpToolSchema).not.toHaveBeenCalled();
  });
});
