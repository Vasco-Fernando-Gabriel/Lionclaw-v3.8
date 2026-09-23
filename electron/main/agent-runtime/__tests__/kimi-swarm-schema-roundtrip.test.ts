import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentQueryConfig } from '../../agent-config-resolver';
import { callTool, toListItem } from '../../kimi-acp/mcp-bridge-tools';
import { buildAllowlistTool, buildCoreMcpCatalogTools } from '../kimi-external-tools';
import { startKimiMcpBridge } from '../../kimi-acp/mcp-http-bridge';

const mocks = vi.hoisted(() => ({ invokeMcpTool: vi.fn() }));
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../mcp-invoke', () => ({ invokeMcpTool: mocks.invokeMcpTool }));
vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async () => ({
    'lionclaw-swarm': { command: 'node', args: ['swarm.js'] },
  })),
  getMCPToolsFromRegistry: vi.fn(() => ['mcp__lionclaw-swarm__swarm_start']),
  getMcpToolRegistryEntries: vi.fn(() => [
    {
      mcpId: 'lionclaw-swarm',
      toolName: 'swarm_start',
      description: 'Inicia análise paralela assíncrona.',
      inputSchema: JSON.stringify(swarmStartSchema),
    },
  ]),
}));

const memberSchema = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: { kind: { type: 'string', const: 'registered' }, agentId: { type: 'string' } },
      required: ['kind', 'agentId'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'ephemeral' },
        runtime: { type: 'string', enum: ['cloud', 'codex', 'zai', 'minimax-tp', 'kimi', 'local', 'external'] },
        model: { type: 'string' },
        rolePrompt: { type: 'string' },
        allowedTools: { type: 'array', items: { type: 'string' } },
        providerProfileId: { type: 'string' },
      },
      required: ['kind', 'runtime', 'model', 'rolePrompt', 'allowedTools'],
    },
  ],
};
const swarmStartSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    requestId: { type: 'string' },
    cwd: { type: 'string' },
    objective: { type: 'string' },
    knownContext: { type: 'string' },
    mode: { type: 'string', enum: ['fanout', 'comite'] },
    promptTemplate: { type: 'string' },
    member: memberSchema,
    items: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { target: { type: 'string' } },
        required: ['target'],
      },
    },
    target: { type: 'string' },
    members: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { slug: { type: 'string' }, objective: { type: 'string' }, member: memberSchema },
        required: ['slug', 'objective', 'member'],
      },
    },
  },
  required: ['requestId', 'cwd', 'objective', 'mode'],
};

const config: AgentQueryConfig = {
  model: 'configured-model',
  systemPrompt: '',
  allowedTools: [],
  mcpServers: [],
  maxTurns: undefined,
  effort: 'medium',
  thinking: 'adaptive',
  thinkingBudget: undefined,
  runtime: 'kimi',
};
const binding = { sessionId: 'chat-schema-regression', turnId: 'turn-2', lane: 'desktop' as const };
const args = {
  requestId: 'audit-2',
  cwd: '/tmp/project',
  objective: 'Auditar segurança',
  mode: 'comite',
  members: [
    { slug: 'auth', objective: 'Examinar autenticação', member: { kind: 'registered', agentId: 'auth-auditor' } },
    {
      slug: 'logic',
      objective: 'Examinar lógica',
      member: {
        kind: 'ephemeral',
        runtime: 'kimi',
        model: 'configured-worker-model',
        rolePrompt: 'Auditor',
        allowedTools: ['Read', 'Grep'],
      },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invokeMcpTool.mockResolvedValue({
    content: '{"runId":"run-2"}',
    displayName: 'mcp__lionclaw-swarm__swarm_start',
  });
});

describe('Kimi SDK real: Swarm schema and nested arguments through MCP bridge', () => {
  async function catalog() {
    return buildCoreMcpCatalogTools(
      config,
      'index',
      { pipelineControl: false, dynamicWorkflows: false, swarm: true },
      binding,
    );
  }

  it('announces the complete registry schema, including members and both member variants', async () => {
    const tools = await catalog();
    const direct = tools.find((tool) => tool.name === 'mcp__lionclaw-swarm__swarm_start')!;
    expect(toListItem(direct).inputSchema).toEqual(swarmStartSchema);
  });

  it('also exposes the registry schema in full catalog and agent allowlist modes', async () => {
    const full = await buildCoreMcpCatalogTools(config, 'full');
    expect(toListItem(full[0]!).inputSchema).toEqual(swarmStartSchema);
    const allowed = await buildAllowlistTool('mcp__lionclaw-swarm__swarm_start');
    expect(toListItem(allowed).inputSchema).toEqual(swarmStartSchema);
  });

  it('serves the schema and nested calls over the authenticated HTTP bridge', async () => {
    const bridge = await startKimiMcpBridge({ tools: await catalog() });
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${bridge.token}`,
        'Content-Type': 'application/json',
      };
      const rpc = (method: string, id: number, params?: Record<string, unknown>) =>
        fetch(bridge.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        });
      const initialized = await rpc('initialize', 1, {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'schema-regression', version: '1' },
      });
      expect(initialized.status).toBe(200);
      await initialized.json();
      headers['Mcp-Session-Id'] = initialized.headers.get('mcp-session-id')!;
      expect(headers['Mcp-Session-Id']).toBeTruthy();
      const listed = await rpc('tools/list', 2);
      expect(listed.status).toBe(200);
      const listBody = (await listed.json()) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
      expect(
        listBody.result.tools.find((tool) => tool.name === 'mcp__lionclaw-swarm__swarm_start')?.inputSchema,
      ).toEqual(swarmStartSchema);
      for (const [index, name] of ['mcp__lionclaw-swarm__swarm_start', 'mcp_invoke'].entries()) {
        const called = await rpc('tools/call', index + 3, {
          name,
          arguments: name === 'mcp_invoke' ? { server: 'lionclaw-swarm', tool: 'swarm_start', args } : args,
        });
        expect(called.status).toBe(200);
        expect(await called.json()).toMatchObject({
          result: { content: [{ type: 'text', text: '{"runId":"run-2"}' }] },
        });
        expect(mocks.invokeMcpTool).toHaveBeenNthCalledWith(index + 1, {
          serverId: 'lionclaw-swarm',
          toolName: 'swarm_start',
          args,
          surface: 'kimi-sdk',
          sessionId: binding.sessionId,
          turnId: binding.turnId,
          allowedServerIds: ['lionclaw-swarm'],
          context: { surface: 'chat', ...binding },
          signal: expect.any(AbortSignal),
        });
      }
    } finally {
      await bridge.stop();
    }
  });

  it.each(['direct', 'mcp_invoke'] as const)(
    '%s preserves nested arrays, objects and authenticated turn binding',
    async (route) => {
      const tools = await catalog();
      const name = route === 'direct' ? 'mcp__lionclaw-swarm__swarm_start' : 'mcp_invoke';
      const tool = tools.find((entry) => entry.name === name)!;
      const signal = new AbortController().signal;
      const wireArgs = JSON.parse(
        JSON.stringify(route === 'direct' ? args : { server: 'lionclaw-swarm', tool: 'swarm_start', args }),
      ) as Record<string, unknown>;
      const result = await callTool(tool, wireArgs, { signal });
      expect(result).toEqual({ content: [{ type: 'text', text: '{"runId":"run-2"}' }] });
      expect(mocks.invokeMcpTool).toHaveBeenCalledExactlyOnceWith({
        serverId: 'lionclaw-swarm',
        toolName: 'swarm_start',
        args,
        surface: 'kimi-sdk',
        sessionId: binding.sessionId,
        turnId: binding.turnId,
        allowedServerIds: ['lionclaw-swarm'],
        context: { surface: 'chat', ...binding },
        signal,
      });
    },
  );
});
