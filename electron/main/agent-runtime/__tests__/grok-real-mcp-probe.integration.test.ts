import { describe, expect, it, vi } from 'vitest';
import type { AgentQueryConfig } from '../../agent-config-resolver';

const { getMcpToolSchema, invokeMcpTool } = vi.hoisted(() => ({
  getMcpToolSchema: vi.fn(() => ({ content: 'load_skill exige o campo name.' })),
  invokeMcpTool: vi.fn(async () => ({
    content: 'LIONCLAW_GROK_MCP_OK',
    displayName: 'skills/load_skill',
    isError: false,
  })),
}));

vi.mock('../../mcp-manager', () => ({
  getMcpToolRegistryEntries: () => [
    {
      mcpId: 'skills',
      toolName: 'load_skill',
      description: 'Carrega uma skill do LionClaw pelo nome.',
      inputSchema: JSON.stringify({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      }),
      lastDiscoveredAt: '2026-07-18T00:00:00.000Z',
    },
  ],
}));

vi.mock('../../mcp-invoke', () => ({ getMcpToolSchema, invokeMcpTool }));
vi.mock('../../db', () => ({
  getSetting: () => undefined,
}));

import { grokExecutor } from '../grok-executor';

const config: AgentQueryConfig = {
  model: 'grok-4.5',
  systemPrompt: 'Use as tools materializadas pelo LionClaw quando a tarefa exigir.',
  allowedTools: ['mcp__skills__load_skill'],
  mcpServers: [],
  maxTurns: 2,
  effort: 'low',
  thinking: 'disabled',
  thinkingBudget: undefined,
  runtime: 'grok',
};

describe.skipIf(process.env['LIONCLAW_REAL_GROK_PROBE'] !== '1')('Grok real MCP dev probe', () => {
  it('atravessa a bridge controlada e invoca uma tool de skills do LionClaw', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const result = await grokExecutor.run(
        {
          agentId: 'grok-real-mcp-dev-probe',
          prompt: [
            'Use obrigatoriamente mcp_invoke com server="skills", tool="load_skill" e args={"name":"bridge-probe"}.',
            'Depois responda exatamente o output retornado pela ferramenta.',
          ].join(' '),
          cwd: process.cwd(),
          abortController: controller,
          permission: {
            mode: 'default',
            dangerouslySkipPermissions: false,
            canUseTool: async () => ({ behavior: 'allow' as const }),
          },
        },
        config,
      );

      expect(invokeMcpTool).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: 'skills',
          toolName: 'load_skill',
          args: { name: 'bridge-probe' },
          surface: 'grok-sdk',
        }),
      );
      expect(result.output).toContain('LIONCLAW_GROK_MCP_OK');
    } finally {
      clearTimeout(timer);
    }
  }, 40_000);
});
