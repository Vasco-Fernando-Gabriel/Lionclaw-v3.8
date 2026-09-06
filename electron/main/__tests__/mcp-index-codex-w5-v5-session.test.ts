
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatFeatureToggles } from '../../../src/types';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const MOCK_SERVERS = [
  { id: 'google-drive', description: 'Drive do usuario', isActive: true },
  { id: 'shopify', description: 'Loja do dono', isActive: true },
  { id: 'lionclaw-agents', description: 'Subagentes LionClaw', isActive: true },
  { id: 'lionclaw-user-question', description: 'Perguntas ao usuario', isActive: true },
  { id: 'inativo', description: 'Fora por isActive', isActive: false },
];

const MOCK_REGISTRY = [
  {
    mcpId: 'google-drive',
    toolName: 'list_files',
    description: 'Lista arquivos do Drive',
    inputSchema: '{"type":"object","properties":{"path":{"type":"string"}}}',
    lastDiscoveredAt: '2026-01-01T00:00:00.000Z',
  },
  {
    mcpId: 'shopify',
    toolName: 'get_orders',
    description: 'Pedidos da loja',
    inputSchema: '{"type":"object"}',
    lastDiscoveredAt: '2026-01-01T00:00:00.000Z',
  },
  {
    mcpId: 'lionclaw-agents',
    toolName: 'call_agent',
    description: 'Dispara um subagente',
    inputSchema: '{"type":"object"}',
    lastDiscoveredAt: '2026-01-01T00:00:00.000Z',
  },
];

vi.mock('../db', () => ({
  getAllMCPServers: () => MOCK_SERVERS,
  getPermissionBypass: () => false,
  getSetting: vi.fn(() => undefined),
}));

vi.mock('../paths', () => ({ getAgentCwd: () => '/tmp/w5-session' }));

vi.mock('../mcp-manager', () => ({
  getMcpToolRegistryEntries: vi.fn(() => MOCK_REGISTRY),
}));

const buildSystemPromptMock = vi.fn(
  (_agentId?: string, _opts?: Record<string, unknown>) => 'LION-PROMPT',
);
vi.mock('../prompt-builder', () => ({
  buildSystemPrompt: (...a: unknown[]) =>
    buildSystemPromptMock(...(a as [string?, Record<string, unknown>?])),
  loadGeneratedAgentContext: () => 'PERSONA',
}));

vi.mock('../prompt-builder-repo-graph', () => ({
  appendRepoGraphSection: (p: string) => p,
}));

const captured = vi.hoisted(() => ({
  runs: [] as Array<{ sessionOptions: { systemPrompt: string } }>,
}));
vi.mock('../agent-runtime/codex-session-factory', () => ({
  resolveCodexSessionForRun: vi.fn(
    async (args: { sessionOptions: { systemPrompt: string } }) => {
      captured.runs.push(args);
      return { threadId: null, close: () => undefined };
    },
  ),
}));

vi.mock('../codex-chat-spawn-extras', () => ({
  resolveChatCodexMcpComposition: vi.fn(() => ({
    mode: 'full',
    extraArgs: [],
    fingerprint: null,
  })),
}));

import {
  CODEX_SDK_SYSTEM_PROMPT_V4,
  CODEX_SDK_SYSTEM_PROMPT_V5,
  CODEX_SDK_SYSTEM_PROMPT_V6,
  CODEX_DRIVING_PIPELINES_STUB,
  buildCodexSdkSystemPromptV4,
  buildCodexSdkSystemPromptV5,
  buildCodexMcpIndexCapabilityBullet,
  buildCodexMcpCatalogPrompt,
} from '../codex-sdk/prompt';
import { createChatCodexSession, type CodexChatContextMeta } from '../codex-sdk/session';
import {
  CODEX_GATEWAY_SERVER_ID,
  CODEX_GATEWAY_INVOKE_TOOL_NAME,
  CODEX_GATEWAY_SCHEMA_TOOL_NAME,
} from '../mcp-display';
import { serializeMcpSchemasForContext } from '../agent-runtime/tool-schemas';
import { estimateTokensRough } from '../agent-runtime/context-measure';

const NAMING = {
  invokeToolName: CODEX_GATEWAY_INVOKE_TOOL_NAME,
  schemaToolName: CODEX_GATEWAY_SCHEMA_TOOL_NAME,
};
const OFF: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: false };
const FULL_FLEET_MARKER = 'All LionClaw MCP servers synced into your transport';

const INDEX_COMPOSITION = {
  mode: 'index' as const,
  extraArgs: ['-c', 'mcp_servers.google-drive.enabled=false', '-c', 'mcp_servers.lionclaw-gateway.enabled=true'],
  fingerprint: JSON.stringify({ servers: ['google-drive', 'shopify'], gatewayEntry: true }),
};
const FULL_COMPOSITION = { mode: 'full' as const, extraArgs: [], fingerprint: null };

beforeEach(() => {
  vi.clearAllMocks();
  captured.runs.length = 0;
});


describe('W5: CODEX_SDK_SYSTEM_PROMPT_V5 + buildCodexSdkSystemPromptV5', () => {
  it('V5 e BYTE-IDENTICA a V4 (parity do modo full, AC-C5)', () => {
    expect(CODEX_SDK_SYSTEM_PROMPT_V5).toEqual(CODEX_SDK_SYSTEM_PROMPT_V4);
  });

  it('modo full sem capabilities -> a PROPRIA constante V5 (mesma referencia); igual a V4 builder', () => {
    expect(buildCodexSdkSystemPromptV5(undefined, undefined)).toBe(CODEX_SDK_SYSTEM_PROMPT_V5);
    expect(buildCodexSdkSystemPromptV5(undefined, undefined)).toEqual(
      buildCodexSdkSystemPromptV4(undefined),
    );
  });

  it('pipelineControl OFF em modo full -> mesmo resultado do builder V4 (stub identico)', () => {
    expect(buildCodexSdkSystemPromptV5({ ...OFF }, undefined)).toEqual(
      buildCodexSdkSystemPromptV4({ ...OFF }),
    );
  });

  it('modo index: bullet de frota nativa substituido pelo bullet do indice + meta-tools; vizinhos intactos', () => {
    const prompt = buildCodexSdkSystemPromptV5(undefined, NAMING);
    expect(prompt).not.toContain(FULL_FLEET_MARKER);
    expect(prompt).toContain('NOT synced natively into this session');
    expect(prompt).toContain(`\`${CODEX_GATEWAY_INVOKE_TOOL_NAME}(server, tool, args)\``);
    expect(prompt).toContain(`\`${CODEX_GATEWAY_SCHEMA_TOOL_NAME}(server, tool)\``);
    expect(prompt).toContain('- File read and write.');
    expect(prompt).toContain('- LionClaw subagents via the `lionclaw-agents` MCP:');
    expect(prompt).toContain('## Working Style');
    expect(prompt.includes('—')).toBe(false);
  });

  it('modo index + pipelineControl OFF: os DOIS splices aplicados (independentes)', () => {
    const prompt = buildCodexSdkSystemPromptV5({ ...OFF }, NAMING);
    expect(prompt).toContain(CODEX_DRIVING_PIPELINES_STUB);
    expect(prompt).not.toContain('To DRIVE a pipeline autonomously');
    expect(prompt).not.toContain(FULL_FLEET_MARKER);
    expect(prompt).toContain('NOT synced natively into this session');
  });

  it('bullet do indice parametrizado por naming (nenhum nome hardcoded fora das constantes)', () => {
    const custom = buildCodexMcpIndexCapabilityBullet({
      invokeToolName: 'x_invoke',
      schemaToolName: 'x_schema',
    });
    expect(custom).toContain('`x_invoke(server, tool, args)`');
    expect(custom).toContain('`x_schema(server, tool)`');
    expect(custom).not.toContain('mcp_invoke');
  });
});


async function createSession(
  mcpComposition: typeof INDEX_COMPOSITION | typeof FULL_COMPOSITION,
  onContextMeta?: (meta: CodexChatContextMeta) => void,
): Promise<string> {
  await createChatCodexSession({
    sessionId: 'sess-w5',
    model: 'gpt-5.5',
    mcpComposition,
    ...(onContextMeta ? { onContextMeta } : {}),
  });
  expect(captured.runs.length).toBeGreaterThan(0);
  return captured.runs[captured.runs.length - 1].sessionOptions.systemPrompt;
}

describe('W5: createChatCodexSession em modo INDEX', () => {
  it('systemPrompt = V5-index + catalogo da composicao REAL (diretos + gateway sintetizado, negocio fora)', async () => {
    const systemPrompt = await createSession(INDEX_COMPOSITION);

    expect(systemPrompt).not.toContain(FULL_FLEET_MARKER);
    expect(systemPrompt).toContain('NOT synced natively into this session');

    expect(systemPrompt).toContain('- `lionclaw-agents`');
    expect(systemPrompt).toContain('- `lionclaw-user-question`');
    expect(systemPrompt).not.toContain('- `google-drive`');
    expect(systemPrompt).not.toContain('- `shopify`');
    expect(systemPrompt).toContain(`- \`${CODEX_GATEWAY_SERVER_ID}\``);
    expect(systemPrompt).toContain(
      `${CODEX_GATEWAY_INVOKE_TOOL_NAME}(server, tool, args) executes any tool from the MCP index above`,
    );

    const promptOpts = buildSystemPromptMock.mock.calls[0][1] as Record<string, unknown>;
    expect(promptOpts.chatSurface).toBe('codex-sdk');
    expect(promptOpts.codexMcpMode).toBe('index');
  });

  it('piso AC-C8 (sem dupla contagem): bucket exclui schemas de negocio e inclui meta-schemas do gateway', async () => {
    let meta: CodexChatContextMeta | null = null;
    await createSession(INDEX_COMPOSITION, (m) => {
      meta = m;
    });
    expect(meta).not.toBeNull();
    const expectedJson = serializeMcpSchemasForContext(
      MOCK_REGISTRY.filter((r) => r.mcpId === 'lionclaw-agents'),
      { includeGatewayMeta: true },
    );
    expect(expectedJson).toContain('mcp__gateway__mcp_invoke');
    expect(expectedJson).not.toContain('google-drive');
    expect(meta!.mcpSchemasTokens).toBe(estimateTokensRough(expectedJson));
  });
});

describe('W5: createChatCodexSession em modo FULL (AC-C5 parity)', () => {
  it('systemPrompt BYTE-IDENTICO a formula legada (V6 + persona + lion + catalogo integral)', async () => {
    const systemPrompt = await createSession(FULL_COMPOSITION);
    const legacyCatalog = buildCodexMcpCatalogPrompt(
      MOCK_SERVERS.filter((s) => s.isActive).map((s) => ({ id: s.id, description: s.description })),
    );
    expect(systemPrompt).toEqual(
      [CODEX_SDK_SYSTEM_PROMPT_V6, 'PERSONA', 'LION-PROMPT', legacyCatalog].join('\n\n'),
    );
    expect(systemPrompt).toContain('Bug Pipe (`pipelineType: "bug"`, 9 phases)');
    const withoutBugBlock = CODEX_SDK_SYSTEM_PROMPT_V6.split('\n')
      .filter(
        (line) =>
          !line.startsWith('- Bug Pipe (') && !line.startsWith('- Phase 3 of the bug pipeline'),
      )
      .join('\n');
    expect(withoutBugBlock).toEqual(CODEX_SDK_SYSTEM_PROMPT_V4);
    const promptOpts = buildSystemPromptMock.mock.calls[0][1] as Record<string, unknown>;
    expect(promptOpts.codexMcpMode).toBe('full');
  });

  it('piso em full: bucket byte-identico ao atual (todos os ativos, SEM meta do gateway)', async () => {
    let meta: CodexChatContextMeta | null = null;
    await createSession(FULL_COMPOSITION, (m) => {
      meta = m;
    });
    expect(meta).not.toBeNull();
    const activeIds = new Set(MOCK_SERVERS.filter((s) => s.isActive).map((s) => s.id));
    const expectedJson = serializeMcpSchemasForContext(
      MOCK_REGISTRY.filter((r) => activeIds.has(r.mcpId)),
    );
    expect(expectedJson).toContain('google-drive');
    expect(expectedJson).not.toContain('mcp__gateway__mcp_invoke');
    expect(meta!.mcpSchemasTokens).toBe(estimateTokensRough(expectedJson));
  });
});
