
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';


const settings = new Map<string, string>();
const getSettingSpy = vi.fn((key: string) => settings.get(key));

vi.mock('../../db', () => ({
  getSetting: (key: string) => getSettingSpy(key),
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@moonshot-ai/kimi-agent-sdk', () => ({
  createExternalTool: (def: {
    name: string;
    description: string;
    parameters: unknown;
    handler: unknown;
  }) => ({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    handler: def.handler,
  }),
}));


const KIMI_SURFACE_CONFIG: Record<string, { command: string; args: string[] }> = {
  'google-drive': { command: 'node', args: ['drive.js'] },
  shopify: { command: 'node', args: ['shopify.js'] },
  'lionclaw-pipeline-control': { command: 'node', args: ['pipe.js'] },
  'lionclaw-dynamic-workflows': { command: 'node', args: ['dyn.js'] },
};

const REGISTRY = [
  {
    mcpId: 'google-drive',
    toolName: 'delete_file',
    description: 'Delete a file permanently from Drive',
    inputSchema: JSON.stringify({
      type: 'object',
      required: ['file_id'],
      properties: { file_id: { type: 'string' } },
    }),
    lastDiscoveredAt: '2026-07-01T00:00:00.000Z',
  },
  {
    mcpId: 'google-drive',
    toolName: 'list_files',
    description: 'List files from the user Drive folder',
    inputSchema: JSON.stringify({
      type: 'object',
      properties: { query: { type: 'string' } },
    }),
    lastDiscoveredAt: '2026-07-01T00:00:00.000Z',
  },
  {
    mcpId: 'shopify',
    toolName: 'get_orders',
    description: 'List recent orders from the store',
    inputSchema: JSON.stringify({
      type: 'object',
      properties: { limit: { type: 'number' } },
    }),
    lastDiscoveredAt: '2026-07-01T00:00:00.000Z',
  },
  {
    mcpId: 'lionclaw-pipeline-control',
    toolName: 'pipeline_drive',
    description: 'Drive de pipeline por chat',
    inputSchema: null,
    lastDiscoveredAt: '2026-07-01T00:00:00.000Z',
  },
  {
    mcpId: 'lionclaw-dynamic-workflows',
    toolName: 'dynamic_workflow_generate',
    description: 'Gera um dynamic workflow',
    inputSchema: null,
    lastDiscoveredAt: '2026-07-01T00:00:00.000Z',
  },
];

const MOCK_SERVERS = [
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Acesso ao Google Drive do usuario',
    isActive: true,
    indexMode: 'tools' as const,
  },
  {
    id: 'shopify',
    name: 'Shopify',
    description: 'Operacoes na loja Shopify',
    isActive: true,
    indexMode: 'tools' as const,
  },
  {
    id: 'lionclaw-pipeline-control',
    name: 'Pipeline Control',
    description: 'Controle de pipelines por chat',
    isActive: true,
    indexMode: 'tools' as const,
  },
];

const getMCPConfigForAgent = vi.fn(async () => KIMI_SURFACE_CONFIG);
const getMCPToolsFromRegistry = vi.fn((ids: string[]) =>
  REGISTRY.filter((e) => ids.includes(e.mcpId)).map((e) => `mcp__${e.mcpId}__${e.toolName}`),
);
const getMcpToolRegistryEntries = vi.fn((mcpId?: string) =>
  mcpId ? REGISTRY.filter((e) => e.mcpId === mcpId) : REGISTRY,
);
const getAllMCPServers = vi.fn(() => MOCK_SERVERS);
const discoverAndSaveMCPTools = vi.fn(async () => [] as string[]);

vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: (...a: unknown[]) => getMCPConfigForAgent(...(a as [])),
  getMCPToolsFromRegistry: (...a: unknown[]) => getMCPToolsFromRegistry(...(a as [string[]])),
  getMcpToolRegistryEntries: (...a: unknown[]) => getMcpToolRegistryEntries(...(a as [string?])),
  getAllMCPServers: () => getAllMCPServers(),
  discoverAndSaveMCPTools: (...a: unknown[]) => discoverAndSaveMCPTools(...(a as [])),
}));

const setupMCPsForSession = vi.fn(async (config: Record<string, unknown>) => ({
  client: { connections: Object.keys(config).map((serverId) => ({ serverId })) },
  tools: [] as unknown[],
}));
const teardownMCPsForSession = vi.fn(async () => {});
const callMCPTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'drive ok' }] }));

vi.mock('../../mcp-tool-bridge', () => ({
  setupMCPsForSession: (...a: unknown[]) =>
    setupMCPsForSession(...(a as [Record<string, unknown>])),
  teardownMCPsForSession: (...a: unknown[]) => teardownMCPsForSession(...(a as [])),
  callMCPTool: (...a: unknown[]) => callMCPTool(...(a as [])),
}));

const guardDecision = vi.fn(
  async (): Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }> => ({
    behavior: 'allow',
  }),
);
vi.mock('../../permission-guard', () => ({
  createPermissionGuard: vi.fn(() => guardDecision),
}));


import {
  buildKimiSessionTools,
  stripUnmaterializedToolInstructions,
} from '../kimi-session-config';
import {
  KIMI_SUBAGENT_TOOL_NAME,
  KIMI_USER_QUESTION_TOOL_NAME,
  KIMI_MCP_INVOKE_TOOL_NAME,
  KIMI_MCP_SCHEMA_TOOL_NAME,
  type KimiExternalTool,
} from '../kimi-external-tools';
import { buildMcpToolIndex } from '../../mcp-tool-index';
import { initMcpInvoke, _resetMcpInvokeForTesting } from '../../mcp-invoke';
import type { AgentQueryConfig } from '../../agent-config-resolver';


const SWARM_BASE =
  'Runtime: a ferramenta nativa de paralelismo do Kimi (AgentSwarm) NAO esta disponivel aqui e sera recusada; nao tente usa-la.';
const SWARM_SUBAGENT =
  'Para delegar trabalho a sub-agentes, use a ferramenta lion_run_subagent (os sub-agentes do LionClaw).';

const INDEX_HEADER = '## Servidores MCP (indice)';

const HELPER_BLOCKS = [
  '## Pipeline Drive',
  'Para dirigir pipelines use mcp__lionclaw-pipeline-control__pipeline_drive.',
  '',
  '## Dynamic Workflows',
  'Para gerar workflows use mcp__lionclaw-dynamic-workflows__dynamic_workflow_generate.',
].join('\n');

const BUSINESS_BLOCK = '## Drive Direto\nUse mcp__google-drive__delete_file para apagar arquivos.';

function makeConfig(overrides: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
  return {
    model: 'kimi-code/kimi-for-coding',
    systemPrompt: 'Voce e o orquestrador.',
    allowedTools: [],
    mcpServers: [],
    maxTurns: undefined,
    effort: 'medium',
    thinking: 'adaptive',
    thinkingBudget: undefined,
    runtime: 'kimi',
    ...overrides,
  };
}

async function buildChat(config: AgentQueryConfig = makeConfig()) {
  return buildKimiSessionTools({
    profile: 'chat',
    config,
    cwd: '/tmp/work',
    abortController: new AbortController(),
  });
}

function toolByName(tools: KimiExternalTool[], name: string): KimiExternalTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool nao materializada: ${name}`);
  return tool;
}

function expectedFullCatalogDecls(): Array<{ name: string; description: string }> {
  const out: Array<{ name: string; description: string }> = [];
  for (const serverId of Object.keys(KIMI_SURFACE_CONFIG)) {
    for (const entry of REGISTRY.filter((e) => e.mcpId === serverId)) {
      const fullName = `mcp__${entry.mcpId}__${entry.toolName}`;
      out.push({ name: fullName, description: `Tool MCP ${fullName} (servidor ${serverId}).` });
    }
  }
  return out;
}

function expectedIndex(): string {
  return buildMcpToolIndex({
    invokeToolName: KIMI_MCP_INVOKE_TOOL_NAME,
    schemaToolName: KIMI_MCP_SCHEMA_TOOL_NAME,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.clear();
  _resetMcpInvokeForTesting();
  initMcpInvoke({ getWindow: () => null });
});

afterEach(() => {
  _resetMcpInvokeForTesting();
});


describe('S5 — composicao das externalTools por modo', () => {
  it("modo 'index': meta-tools + SOMENTE helpers DIRECT (nenhuma tool de server de negocio)", async () => {
    settings.set('mcp_prompt_mode', 'index');
    const { externalTools } = await buildChat();
    const names = externalTools.map((t) => t.name);

    expect(names).toEqual([
      KIMI_SUBAGENT_TOOL_NAME,
      KIMI_USER_QUESTION_TOOL_NAME,
      KIMI_MCP_INVOKE_TOOL_NAME,
      KIMI_MCP_SCHEMA_TOOL_NAME,
      'mcp__lionclaw-pipeline-control__pipeline_drive',
      'mcp__lionclaw-dynamic-workflows__dynamic_workflow_generate',
    ]);
    expect(names.some((n) => n.startsWith('mcp__google-drive__'))).toBe(false);
    expect(names.some((n) => n.startsWith('mcp__shopify__'))).toBe(false);
  });

  it("modo 'index': mcp_invoke tem schema zod explicito { server, tool, args }", async () => {
    settings.set('mcp_prompt_mode', 'index');
    const { externalTools } = await buildChat();
    const invoke = toolByName(externalTools, KIMI_MCP_INVOKE_TOOL_NAME);
    const schema = toolByName(externalTools, KIMI_MCP_SCHEMA_TOOL_NAME);
    const invokeShape = (invoke.parameters as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(invokeShape).sort()).toEqual(['args', 'server', 'tool']);
    const schemaShape = (schema.parameters as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(schemaShape).sort()).toEqual(['server', 'tool']);
    expect(invoke.description).toContain('indice');
  });

  it('default (setting ausente) = index', async () => {
    const { externalTools } = await buildChat();
    const names = externalTools.map((t) => t.name);
    expect(names).toContain(KIMI_MCP_INVOKE_TOOL_NAME);
    expect(names).toContain(KIMI_MCP_SCHEMA_TOOL_NAME);
    expect(names.some((n) => n.startsWith('mcp__google-drive__'))).toBe(false);
  });

  it("modo 'full': declaracoes cegas BYTE-IDENTICAS a formula antiga; sem meta-tools", async () => {
    settings.set('mcp_prompt_mode', 'full');
    const { externalTools } = await buildChat();
    const catalog = externalTools.slice(2).map((t) => ({ name: t.name, description: t.description }));
    expect(catalog).toEqual(expectedFullCatalogDecls());
    const names = externalTools.map((t) => t.name);
    expect(names).not.toContain(KIMI_MCP_INVOKE_TOOL_NAME);
    expect(names).not.toContain(KIMI_MCP_SCHEMA_TOOL_NAME);
  });

  it("modo 'full': handler do catalogo preserva spawn-per-call + teardown (comportamento legado)", async () => {
    settings.set('mcp_prompt_mode', 'full');
    const { externalTools } = await buildChat();
    const tool = toolByName(externalTools, 'mcp__google-drive__list_files');
    const r = await tool.handler({ query: 'spec' });
    expect(setupMCPsForSession).toHaveBeenCalledTimes(1);
    expect(setupMCPsForSession).toHaveBeenCalledWith({
      'google-drive': KIMI_SURFACE_CONFIG['google-drive'],
    });
    expect(teardownMCPsForSession).toHaveBeenCalledTimes(1);
    expect(r.output).toBe(JSON.stringify({ content: [{ type: 'text', text: 'drive ok' }] }));
    expect(r.message).toBe('mcp__google-drive__list_files ok');
    expect(guardDecision).not.toHaveBeenCalled();
  });

  it("modo 'index': helper DIRECT usa o wrapper com o mesmo scope/allowlist do run", async () => {
    settings.set('mcp_prompt_mode', 'index');
    const { externalTools } = await buildChat();
    const invokeModule = await import('../../mcp-invoke');
    const invokeSpy = vi.spyOn(invokeModule, 'invokeMcpTool');
    const meta = toolByName(externalTools, KIMI_MCP_INVOKE_TOOL_NAME);
    const direct = toolByName(externalTools, 'mcp__lionclaw-pipeline-control__pipeline_drive');

    await meta.handler({ server: 'google-drive', tool: 'list_files', args: {} });
    const r = await direct.handler({ action: 'status' });

    expect(invokeSpy).toHaveBeenCalledTimes(2);
    const metaRequest = invokeSpy.mock.calls[0]![0];
    const directRequest = invokeSpy.mock.calls[1]![0];
    expect(directRequest).toMatchObject({
      serverId: 'lionclaw-pipeline-control',
      toolName: 'pipeline_drive',
      surface: 'kimi-sdk',
      sessionId: metaRequest.sessionId,
      turnId: metaRequest.turnId,
      allowedServerIds: metaRequest.allowedServerIds,
      context: { surface: 'chat' },
    });
    expect(r.message).toBe('mcp__lionclaw-pipeline-control__pipeline_drive ok');
    expect(teardownMCPsForSession).not.toHaveBeenCalled();
  });
});

describe('S5 — indice no systemPrompt', () => {
  it("modo 'index': bloco do indice anexado ao prompt (INTEIRO, byte-identico ao builder)", async () => {
    settings.set('mcp_prompt_mode', 'index');
    const { systemPrompt } = await buildChat();
    const index = expectedIndex();
    expect(index).toContain('google-drive: Acesso ao Google Drive do usuario');
    expect(index).toContain('- list_files: List files from the user Drive folder');
    expect(index).toContain('shopify: Operacoes na loja Shopify');
    expect(index).not.toContain('lionclaw-pipeline-control:');
    expect(index).toContain(`${KIMI_MCP_INVOKE_TOOL_NAME}(server, tool, args)`);
    expect(systemPrompt).toContain(INDEX_HEADER);
    expect(systemPrompt).toContain(index);
  });

  it("modo 'full': prompt BYTE-IDENTICO a composicao legada (sem indice)", async () => {
    settings.set('mcp_prompt_mode', 'full');
    const base = 'Voce e o orquestrador.';
    const { systemPrompt } = await buildChat(makeConfig({ systemPrompt: base }));
    expect(systemPrompt).toBe(`${base}\n\n${SWARM_BASE} ${SWARM_SUBAGENT}`);
    expect(systemPrompt).not.toContain(INDEX_HEADER);
    expect(systemPrompt).not.toContain('Servidores MCP disponiveis');
  });
});

describe('S5 — AC-14: indice e helpers sobrevivem ao strip REAL', () => {
  it('unit: stripUnmaterializedToolInstructions preserva indice INTEIRO + blocos dos helpers', () => {
    const index = expectedIndex();
    const prompt = [
      'Voce e o orquestrador.',
      '',
      HELPER_BLOCKS,
      '',
      `${INDEX_HEADER}`,
      '',
      index,
    ].join('\n');
    const materialized = new Set([
      KIMI_MCP_INVOKE_TOOL_NAME,
      KIMI_MCP_SCHEMA_TOOL_NAME,
      'mcp__lionclaw-pipeline-control__pipeline_drive',
      'mcp__lionclaw-dynamic-workflows__dynamic_workflow_generate',
    ]);
    const out = stripUnmaterializedToolInstructions(prompt, materialized);
    expect(out).toContain(index);
    expect(out).toContain('mcp__lionclaw-pipeline-control__pipeline_drive');
    expect(out).toContain('mcp__lionclaw-dynamic-workflows__dynamic_workflow_generate');
    expect(out).toContain('## Pipeline Drive');
    expect(out).toContain('## Dynamic Workflows');
    expect(out).toBe(prompt);
  });

  it('end-to-end: prompt do chat em modo index sobrevive ao strip; bloco de negocio (controle) e stripado', async () => {
    settings.set('mcp_prompt_mode', 'index');
    const base = ['Voce e o orquestrador.', '', HELPER_BLOCKS, '', BUSINESS_BLOCK].join('\n');
    const { systemPrompt } = await buildChat(makeConfig({ systemPrompt: base }));
    const index = expectedIndex();
    expect(systemPrompt).toContain(INDEX_HEADER);
    expect(systemPrompt).toContain(index);
    expect(systemPrompt).toContain('mcp__lionclaw-pipeline-control__pipeline_drive');
    expect(systemPrompt).toContain('mcp__lionclaw-dynamic-workflows__dynamic_workflow_generate');
    expect(systemPrompt).not.toContain('mcp__google-drive__delete_file');
    expect(systemPrompt).not.toContain('## Drive Direto');
    expect(index).toContain('- delete_file: Delete a file permanently from Drive');
  });
});

describe('S5 — handler mcp_invoke via wrapper central (mcp-invoke REAL)', () => {
  async function getInvokeTool(): Promise<KimiExternalTool> {
    settings.set('mcp_prompt_mode', 'index');
    const { externalTools } = await buildChat();
    return toolByName(externalTools, KIMI_MCP_INVOKE_TOOL_NAME);
  }

  it('roteia pro wrapper: pool spawn on-demand, flatten e displayName REAL no message (AC-9)', async () => {
    const invoke = await getInvokeTool();
    const r = await invoke.handler({ server: 'google-drive', tool: 'list_files', args: { query: 'spec' } });
    expect(r.output).toBe('drive ok');
    expect(r.message).toBe('mcp__google-drive__list_files ok');
    expect(setupMCPsForSession).toHaveBeenCalledTimes(1);
    expect(setupMCPsForSession).toHaveBeenCalledWith({
      'google-drive': KIMI_SURFACE_CONFIG['google-drive'],
    });
    expect(teardownMCPsForSession).not.toHaveBeenCalled();
    const call = callMCPTool.mock.calls[0] as unknown[];
    expect(call[1]).toBe('mcp__google-drive__list_files');
    expect(call[2]).toEqual({ query: 'spec' });
    expect(call[3]).toEqual({ timeoutMs: 60_000 });
  });

  it('escopo: server fora do surface kimi => isError flui como texto, sem spawn', async () => {
    const invoke = await getInvokeTool();
    const r = await invoke.handler({ server: 'nao-permitido', tool: 'x', args: {} });
    expect(r.output).toContain('fora do escopo desta sessao');
    expect(r.output).toContain(
      'google-drive, shopify, lionclaw-pipeline-control, lionclaw-dynamic-workflows',
    );
    expect(r.message).toBe('mcp__nao-permitido__x failed');
    expect(setupMCPsForSession).not.toHaveBeenCalled();
    expect(callMCPTool).not.toHaveBeenCalled();
  });

  it('guard AC-13: tool destrutiva consulta o guard com o nome REAL; deny bloqueia sem invocar', async () => {
    const invoke = await getInvokeTool();
    guardDecision.mockResolvedValueOnce({ behavior: 'deny', message: 'usuario negou' });
    const r = await invoke.handler({
      server: 'google-drive',
      tool: 'delete_file',
      args: { file_id: 'f1' },
    });
    expect(guardDecision).toHaveBeenCalledWith('mcp__google-drive__delete_file', { file_id: 'f1' });
    expect(r.output).toContain('negada pelo guard de permissoes');
    expect(r.message).toBe('mcp__google-drive__delete_file failed');
    expect(callMCPTool).not.toHaveBeenCalled();
  });

  it('guard AC-13: tool safe NAO consulta o guard; allow em destrutiva prossegue', async () => {
    const invoke = await getInvokeTool();
    await invoke.handler({ server: 'google-drive', tool: 'list_files', args: {} });
    expect(guardDecision).not.toHaveBeenCalled();

    const r = await invoke.handler({
      server: 'google-drive',
      tool: 'delete_file',
      args: { file_id: 'f1' },
    });
    expect(guardDecision).toHaveBeenCalledTimes(1);
    expect(r.output).toBe('drive ok');
    expect(r.message).toBe('mcp__google-drive__delete_file ok');
  });

  it('schema-on-error do wrapper flui como texto de erro para o modelo', async () => {
    const invoke = await getInvokeTool();
    callMCPTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: 'invalid args' }],
    } as never);
    const r = await invoke.handler({ server: 'google-drive', tool: 'list_files', args: { bogus: 1 } });
    expect(r.message).toBe('mcp__google-drive__list_files failed');
    expect(r.output).toContain('retornou erro');
    expect(r.output).toContain('Schema resumido de list_files');
    expect(r.output).toContain('query: string');
  });
});

describe('S5 — handler mcp_schema (registry via getMcpToolSchema REAL)', () => {
  it('devolve o schema formatado do registry', async () => {
    settings.set('mcp_prompt_mode', 'index');
    const { externalTools } = await buildChat();
    const schema = toolByName(externalTools, KIMI_MCP_SCHEMA_TOOL_NAME);
    const r = await schema.handler({ server: 'google-drive', tool: 'list_files' });
    expect(r.message).toBe('mcp_schema ok');
    expect(r.output).toContain('Tool: list_files');
    expect(r.output).toContain('Input schema (JSON):');
    expect(r.output).toContain('"query"');
  });

  it('tool inexistente => did-you-mean como texto de erro', async () => {
    settings.set('mcp_prompt_mode', 'index');
    const { externalTools } = await buildChat();
    const schema = toolByName(externalTools, KIMI_MCP_SCHEMA_TOOL_NAME);
    const r = await schema.handler({ server: 'google-drive', tool: 'list_filez' });
    expect(r.message).toBe('mcp_schema failed');
    expect(r.output).toContain('nao existe no servidor google-drive');
    expect(r.output).toContain('list_files');
  });
});

describe('S5 — perfil agent-scoped INTOCADO (P5)', () => {
  it('allowlist direta, sem meta-tools, sem indice, sem leitura do modo', async () => {
    settings.set('mcp_prompt_mode', 'index');
    const config = makeConfig({ allowedTools: ['Read', 'mcp__google-drive__list_files'] });
    const { externalTools, systemPrompt } = await buildKimiSessionTools({
      profile: 'agent-scoped',
      config,
      cwd: '/tmp/work',
      abortController: new AbortController(),
    });
    expect(externalTools.map((t) => t.name)).toEqual(['mcp__google-drive__list_files']);
    expect(systemPrompt).not.toContain(INDEX_HEADER);
    expect(systemPrompt).not.toContain('Servidores MCP disponiveis');
    expect(getSettingSpy).not.toHaveBeenCalledWith('mcp_prompt_mode');
  });

  it('pipeline/one-shot seguem vazios e sem indice mesmo em modo index', async () => {
    settings.set('mcp_prompt_mode', 'index');
    for (const profile of ['pipeline', 'one-shot'] as const) {
      const { externalTools, systemPrompt } = await buildKimiSessionTools({
        profile,
        config: makeConfig(),
        cwd: '/tmp/work',
        abortController: new AbortController(),
      });
      expect(externalTools).toHaveLength(0);
      expect(systemPrompt).not.toContain(INDEX_HEADER);
    }
  });
});
