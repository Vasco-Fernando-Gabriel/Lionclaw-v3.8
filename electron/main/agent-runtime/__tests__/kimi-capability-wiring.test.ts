import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatFeatureToggles } from '../../../../src/types';

const settings = new Map<string, string>();

vi.mock('../../db', () => ({
  getSetting: (key: string) => settings.get(key),
  getEnabledTools: () => [],
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@moonshot-ai/kimi-agent-sdk', () => ({
  createExternalTool: (def: { name: string; description: string; parameters: unknown; handler: unknown }) => ({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    handler: def.handler,
  }),
}));

const KIMI_SURFACE_CONFIG: Record<string, { command: string; args: string[] }> = {
  'google-drive': { command: 'node', args: ['drive.js'] },
  'lionclaw-pipeline-control': { command: 'node', args: ['pipe.js'] },
  'lionclaw-dynamic-workflows': { command: 'node', args: ['dyn.js'] },
};

const REGISTRY = [
  {
    mcpId: 'google-drive',
    toolName: 'list_files',
    description: 'List files',
    inputSchema: null,
    lastDiscoveredAt: '2026-07-01T00:00:00.000Z',
  },
  {
    mcpId: 'lionclaw-pipeline-control',
    toolName: 'pipeline_drive',
    description: 'Drive de pipeline',
    inputSchema: null,
    lastDiscoveredAt: '2026-07-01T00:00:00.000Z',
  },
  {
    mcpId: 'lionclaw-dynamic-workflows',
    toolName: 'dynamic_workflow_generate',
    description: 'Gera workflow',
    inputSchema: null,
    lastDiscoveredAt: '2026-07-01T00:00:00.000Z',
  },
];

const MOCK_SERVERS = [
  { id: 'google-drive', name: 'Google Drive', description: 'Drive', isActive: true, indexMode: 'tools' as const },
  {
    id: 'lionclaw-pipeline-control',
    name: 'Pipeline Control',
    description: 'Pipe',
    isActive: true,
    indexMode: 'tools' as const,
  },
  {
    id: 'lionclaw-dynamic-workflows',
    name: 'Dynamic Workflows',
    description: 'Dyn',
    isActive: true,
    indexMode: 'tools' as const,
  },
];

function applyS5aFilter(
  config: Record<string, { command: string; args: string[] }>,
  capabilities?: ChatFeatureToggles,
): Record<string, { command: string; args: string[] }> {
  if (!capabilities) return { ...config };
  const gatedByServer: Record<string, keyof ChatFeatureToggles> = {
    'lionclaw-pipeline-control': 'pipelineControl',
    'lionclaw-dynamic-workflows': 'dynamicWorkflows',
  };
  const out: Record<string, { command: string; args: string[] }> = {};
  for (const [id, spec] of Object.entries(config)) {
    const gated = gatedByServer[id];
    if (gated !== undefined && capabilities[gated] === false) continue;
    out[id] = spec;
  }
  return out;
}

const getMCPConfigForAgent = vi.fn(
  async (_agentId?: string, opts?: { surface?: string; capabilities?: ChatFeatureToggles }) =>
    applyS5aFilter(KIMI_SURFACE_CONFIG, opts?.capabilities),
);
const getMCPToolsFromRegistry = vi.fn((ids: string[]) =>
  REGISTRY.filter((e) => ids.includes(e.mcpId)).map((e) => `mcp__${e.mcpId}__${e.toolName}`),
);
const getMcpToolRegistryEntries = vi.fn((mcpId?: string) =>
  mcpId ? REGISTRY.filter((e) => e.mcpId === mcpId) : REGISTRY,
);
const getAllMCPServers = vi.fn(() => MOCK_SERVERS);

vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: (...a: unknown[]) =>
    getMCPConfigForAgent(...(a as [string?, { surface?: string; capabilities?: ChatFeatureToggles }?])),
  getMCPToolsFromRegistry: (...a: unknown[]) => getMCPToolsFromRegistry(...(a as [string[]])),
  getMcpToolRegistryEntries: (...a: unknown[]) => getMcpToolRegistryEntries(...(a as [string?])),
  getAllMCPServers: () => getAllMCPServers(),
  discoverAndSaveMCPTools: vi.fn(async () => [] as string[]),
}));

const setupMCPsForSession = vi.fn(async (config: Record<string, unknown>) => ({
  client: { connections: Object.keys(config).map((serverId) => ({ serverId })) },
  tools: [] as unknown[],
}));
vi.mock('../../mcp-tool-bridge', () => ({
  setupMCPsForSession: (...a: unknown[]) => setupMCPsForSession(...(a as [Record<string, unknown>])),
  teardownMCPsForSession: vi.fn(async () => {}),
  callMCPTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
}));

const buildSystemPromptMock = vi.fn((_agentId?: string, _opts?: Record<string, unknown>) => 'KIMI-SYS');
vi.mock('../../prompt-builder', () => ({
  buildSystemPrompt: (...a: unknown[]) => buildSystemPromptMock(...(a as [string?, Record<string, unknown>?])),
  loadGeneratedAgentContext: () => '',
}));

vi.mock('../../prompt-builder-repo-graph', () => ({
  appendRepoGraphSection: (p: string) => p,
}));

vi.mock('../kimi-availability', () => ({
  isKimiAvailable: vi.fn(async () => ({ authMode: 'subscription' })),
  resolveKimiBinary: vi.fn(async () => '/usr/local/bin/kimi'),
  KimiUnavailableError: class KimiUnavailableError extends Error {},
}));

const createRun = vi.fn(async () => ({ send: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('../../kimi-acp/acp-driver', () => ({
  getKimiAcpDriver: () => ({ createRun: (...a: unknown[]) => createRun(...(a as [])) }),
}));

const startKimiMcpBridge = vi.fn(async (_args: { tools: Array<{ name: string }> }) => ({
  mcpServerEntry: { name: 'LionClaw Bridge' },
  stop: vi.fn(async () => {}),
}));
vi.mock('../../kimi-acp/mcp-http-bridge', () => ({
  startKimiMcpBridge: (args: { tools: Array<{ name: string }> }) => startKimiMcpBridge(args),
}));

vi.mock('../../paths', () => ({
  getAgentCwd: () => '/tmp/kimi-wiring',
  getLionClawHome: () => '/tmp/lion-home',
}));

import { buildKimiSessionTools } from '../kimi-session-config';
import {
  buildAllowlistTool,
  KIMI_MCP_INVOKE_TOOL_NAME,
  KIMI_MCP_SCHEMA_TOOL_NAME,
  type KimiExternalTool,
} from '../kimi-external-tools';
import { createChatKimiSession } from '../../kimi-sdk/session';
import type { AgentQueryConfig } from '../../agent-config-resolver';

const PIPE_TOOL = 'mcp__lionclaw-pipeline-control__pipeline_drive';
const DYN_TOOL = 'mcp__lionclaw-dynamic-workflows__dynamic_workflow_generate';
const DRIVE_TOOL = 'mcp__google-drive__list_files';

const OFF: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: false };
const ON: ChatFeatureToggles = { pipelineControl: true, dynamicWorkflows: true };

function makeConfig(overrides: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
  return {
    model: 'kimi-code/kimi-for-coding',
    systemPrompt: 'Voce e o orquestrador.',
    allowedTools: [],
    mcpServers: [],
    maxTurns: undefined,
    effort: 'medium',
    thinking: 'disabled',
    thinkingBudget: undefined,
    runtime: 'kimi',
    ...overrides,
  };
}

async function buildChat(capabilities?: ChatFeatureToggles) {
  return buildKimiSessionTools({
    profile: 'chat',
    config: makeConfig(),
    cwd: '/tmp/work',
    abortController: new AbortController(),
    capabilities,
  });
}

function names(tools: KimiExternalTool[]): string[] {
  return tools.map((t) => t.name);
}

function capturedMcpConfigCapabilities(): unknown[] {
  return getMCPConfigForAgent.mock.calls.map((c) => (c[1] as { capabilities?: unknown } | undefined)?.capabilities);
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.clear();
  settings.set('mcp_prompt_mode', 'full');
});

describe('S5c kimi: composicao (buildKimiSessionTools threada capabilities ate o getMCPConfigForAgent)', () => {
  it('modo full, caps OFF -> helpers gated FORA da materializacao; negocio presente; capabilities chegam ao filtro', async () => {
    const { externalTools } = await buildChat({ ...OFF });

    const toolNames = names(externalTools);
    expect(toolNames).not.toContain(PIPE_TOOL);
    expect(toolNames).not.toContain(DYN_TOOL);
    expect(toolNames).toContain(DRIVE_TOOL);
    expect(capturedMcpConfigCapabilities()).toContainEqual(OFF);
    expect(getMCPConfigForAgent).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ surface: 'kimi-sdk', capabilities: OFF }),
    );
  });

  it('modo full, caps ON -> helpers gated PRESENTES (mesma materializacao do legado)', async () => {
    const { externalTools } = await buildChat({ ...ON });

    const toolNames = names(externalTools);
    expect(toolNames).toContain(PIPE_TOOL);
    expect(toolNames).toContain(DYN_TOOL);
    expect(toolNames).toContain(DRIVE_TOOL);
    expect(capturedMcpConfigCapabilities()).toContainEqual(ON);
  });

  it('sem capabilities (undefined) -> byte-identico: zero filtro e MESMA lista de tools do caso ON', async () => {
    const legacy = await buildChat(undefined);
    const legacyCaps = capturedMcpConfigCapabilities();
    vi.clearAllMocks();
    const on = await buildChat({ ...ON });

    expect(legacyCaps.every((c) => c === undefined)).toBe(true);
    expect(names(legacy.externalTools)).toEqual(names(on.externalTools));
    expect(legacy.systemPrompt).toEqual(on.systemPrompt);
  });

  it('modo index, caps OFF -> meta-tools presentes; helpers DIRECT gated FORA; allowedServerIds filtrado por construcao', async () => {
    settings.set('mcp_prompt_mode', 'index');
    const { externalTools } = await buildChat({ ...OFF });

    const toolNames = names(externalTools);
    expect(toolNames).toContain(KIMI_MCP_INVOKE_TOOL_NAME);
    expect(toolNames).toContain(KIMI_MCP_SCHEMA_TOOL_NAME);
    expect(toolNames).not.toContain(PIPE_TOOL);
    expect(toolNames).not.toContain(DYN_TOOL);
    expect(capturedMcpConfigCapabilities()).toContainEqual(OFF);
  });

  it('modo index, caps ON -> helpers DIRECT gated MATERIALIZADOS como hoje', async () => {
    settings.set('mcp_prompt_mode', 'index');
    const { externalTools } = await buildChat({ ...ON });

    const toolNames = names(externalTools);
    expect(toolNames).toContain(PIPE_TOOL);
    expect(toolNames).toContain(DYN_TOOL);
  });
});

describe('S5c kimi: buildAllowlistTool threada capabilities ao getMCPConfigForAgent do handler', () => {
  it('caps OFF -> handler do tool gated nao resolve o server (indisponivel), sem spawn', async () => {
    const tool = await buildAllowlistTool(PIPE_TOOL, { ...OFF });
    const result = await tool.handler({});

    expect(result.output).toContain('indisponivel');
    expect(getMCPConfigForAgent).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ surface: 'kimi-sdk', capabilities: OFF }),
    );
  });

  it('sem capabilities -> resolucao byte-identica (undefined chega ao filtro; server resolve)', async () => {
    const tool = await buildAllowlistTool(PIPE_TOOL, undefined);
    const result = await tool.handler({});
    expect(result.output).not.toContain('indisponivel');
    expect(capturedMcpConfigCapabilities()).toContainEqual(undefined);
  });
});

describe('S5c kimi: createChatKimiSession threada capabilities para prompt e sessao', () => {
  const permission = { mode: 'default' as const, dangerouslySkipPermissions: false };
  it('caps OFF -> buildSystemPrompt recebe OFF e a bridge NAO expoe os tools gated', async () => {
    const session = await createChatKimiSession({
      sessionId: 'sess-kimi',
      model: 'kimi-code/kimi-for-coding',
      permission,
      capabilities: { ...OFF },
    });

    const promptOpts = buildSystemPromptMock.mock.calls[0][1] as Record<string, unknown>;
    expect(promptOpts.capabilities).toEqual(OFF);
    expect(promptOpts.chatSurface).toBe('kimi-sdk');

    expect(startKimiMcpBridge).toHaveBeenCalledTimes(1);
    const bridgeTools = startKimiMcpBridge.mock.calls[0][0].tools.map((t) => t.name);
    expect(bridgeTools).not.toContain(PIPE_TOOL);
    expect(bridgeTools).not.toContain(DYN_TOOL);
    expect(bridgeTools).toContain(DRIVE_TOOL);
    await session.close();
  });

  it('caps ON -> buildSystemPrompt recebe ON e os tools gated ESTAO na bridge', async () => {
    const session = await createChatKimiSession({
      sessionId: 'sess-kimi',
      model: 'kimi-code/kimi-for-coding',
      permission,
      capabilities: { ...ON },
    });

    const promptOpts = buildSystemPromptMock.mock.calls[0][1] as Record<string, unknown>;
    expect(promptOpts.capabilities).toEqual(ON);

    const bridgeTools = startKimiMcpBridge.mock.calls[0][0].tools.map((t) => t.name);
    expect(bridgeTools).toContain(PIPE_TOOL);
    expect(bridgeTools).toContain(DYN_TOOL);
    await session.close();
  });

  it('sem capabilities -> undefined nos 2 pontos = comportamento legado byte-identico', async () => {
    const session = await createChatKimiSession({
      sessionId: 'sess-kimi',
      model: 'kimi-code/kimi-for-coding',
      permission,
    });

    const promptOpts = buildSystemPromptMock.mock.calls[0][1] as Record<string, unknown>;
    expect(promptOpts.capabilities).toBeUndefined();
    expect(capturedMcpConfigCapabilities().every((c) => c === undefined)).toBe(true);

    const bridgeTools = startKimiMcpBridge.mock.calls[0][0].tools.map((t) => t.name);
    expect(bridgeTools).toContain(PIPE_TOOL);
    expect(bridgeTools).toContain(DYN_TOOL);
    expect(bridgeTools).toContain(DRIVE_TOOL);
    await session.close();
  });
});
