import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OrchestratorSelection } from '../../orchestrator-selection';

const settings = new Map<string, string>();

vi.mock('../../db', () => ({
  createSession: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getAllAgents: vi.fn(() => []),
  getSession: vi.fn(() => ({ id: 'sid', title: 't', type: 'chat' })),
  getSessionMessages: vi.fn(() => []),
  insertMessage: vi.fn(() => 1),
  getTurnIndexForUserMessage: vi.fn(() => 7),
  getLatestUserTurnIndex: vi.fn(() => 0),
  updateSessionTokens: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
  clearSessionPendingSeed: vi.fn(),
  insertAuditEntry: vi.fn(),
  getPermissionBypass: vi.fn(() => false),
  getSetting: vi.fn((key: string) => settings.get(key) ?? ''),
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../pricing', () => ({ calculateCost: vi.fn(() => 0.5) }));

const BROAD_CONFIG: Record<string, { command: string; args: string[] }> = {
  'google-drive': { command: 'node', args: ['drive.js'] },
  shopify: { command: 'node', args: ['shopify.js'] },
};
const AGENT_CONFIG: Record<string, { command: string; args: string[] }> = {
  'google-drive': { command: 'node', args: ['drive.js'] },
};

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
];

const getMCPConfigForAgent = vi.fn(async (agentId?: string) => (agentId === 'agent-x' ? AGENT_CONFIG : BROAD_CONFIG));
const getMcpToolRegistryEntries = vi.fn((mcpId?: string) =>
  mcpId ? REGISTRY.filter((e) => e.mcpId === mcpId) : REGISTRY,
);
const getMCPToolsFromRegistry = vi.fn((ids: string[]) =>
  REGISTRY.filter((e) => ids.includes(e.mcpId)).map((e) => `mcp__${e.mcpId}__${e.toolName}`),
);
const discoverAndSaveMCPTools = vi.fn(async () => [] as string[]);
const getAllMCPServers = vi.fn(() => MOCK_SERVERS);

vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: (...a: unknown[]) => getMCPConfigForAgent(...(a as [string?])),
  getMcpToolRegistryEntries: (...a: unknown[]) => getMcpToolRegistryEntries(...(a as [string?])),
  getMCPToolsFromRegistry: (...a: unknown[]) => getMCPToolsFromRegistry(...(a as [string[]])),
  discoverAndSaveMCPTools: (...a: unknown[]) => discoverAndSaveMCPTools(...(a as [])),
  getAllMCPServers: () => getAllMCPServers(),
}));

const EAGER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'mcp__google-drive__delete_file',
      description: 'Delete a file permanently from Drive',
      parameters: {
        type: 'object',
        properties: { file_id: { type: 'string', description: 'Drive file id' } },
        required: ['file_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp__google-drive__list_files',
      description: 'List files from the user Drive folder',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp__shopify__get_orders',
      description: 'List recent orders from the store',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Max orders' } },
      },
    },
  },
];

const setupMCPsForSession = vi.fn(async (config: Record<string, unknown>) => ({
  client: { connections: Object.keys(config).map((serverId) => ({ serverId })) },
  tools: EAGER_TOOLS,
}));
const teardownMCPsForSession = vi.fn(async () => {});
const callMCPTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'drive ok' }] }));

vi.mock('../../mcp-tool-bridge', () => ({
  setupMCPsForSession: (...a: unknown[]) => setupMCPsForSession(...(a as [Record<string, unknown>])),
  teardownMCPsForSession: (...a: unknown[]) => teardownMCPsForSession(...(a as [])),
  callMCPTool: (...a: unknown[]) => callMCPTool(...(a as [])),
}));

const guardDecision = vi.fn(async (): Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }> => ({
  behavior: 'allow',
}));
vi.mock('../../permission-guard', () => ({
  createPermissionGuard: vi.fn(() => guardDecision),
}));

vi.mock('../../skills', () => ({ listSkills: vi.fn(() => []) }));
vi.mock('../../title-generator', () => ({ ensureInitialSessionTitle: vi.fn() }));
vi.mock('../../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../../onboarding', () => ({
  completeOnboardingFromConversationMessages: vi.fn(),
  completeOnboardingFromUserProfileMessage: vi.fn(() => false),
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
}));
const PIPELINE_SENTINEL = '## Pipeline Control\n\nUse pipeline_drive e dynamic_workflow_generate via mcp_call.';
vi.mock('../../prompt-builder', () => ({
  buildSystemPrompt: vi.fn(() => 'SYS'),
  buildPipelineControlSection: vi.fn(() => PIPELINE_SENTINEL),
  getSubagentsPromptMode: vi.fn(() => 'index'),
}));
vi.mock('../../prompt-builder-repo-graph', () => ({
  getRepoGraphPromptSection: vi.fn(() => ''),
}));
vi.mock('../runtime-context', () => ({
  buildLionRuntimeContextPrompt: vi.fn(() => '## LionClaw Runtime Context\n\nRUNTIME-CONTEXT'),
}));

vi.mock('../adapters/ollama', () => ({
  createOllamaAdapter: vi.fn(() => ({ name: 'ollama', streamCompletion: vi.fn() })),
}));
vi.mock('../adapters/lmstudio', () => ({
  createLmStudioAdapter: vi.fn(() => ({ name: 'lmstudio', streamCompletion: vi.fn() })),
}));
vi.mock('../adapters/openai-compatible', () => ({
  createOpenAiCompatibleAdapter: vi.fn(() => ({
    name: 'openai-compatible',
    streamCompletion: vi.fn(),
  })),
}));
vi.mock('../adapters/google-genai', () => ({
  createGoogleGenAiAdapter: vi.fn(() => ({ name: 'google-genai', streamCompletion: vi.fn() })),
}));
vi.mock('../title', () => ({ maybeGenerateLionSessionTitle: vi.fn(async () => {}) }));

const compactIfNeeded = vi.fn(async (_opts: unknown) => ({
  messages: [{ role: 'user' as const, content: 'oi' }],
  compacted: false,
}));
vi.mock('../compaction', () => ({
  compactIfNeeded: (opts: unknown) => compactIfNeeded(opts as never),
}));

interface CapturedLoopOpts {
  initialMessages: Array<{ role: string; content: string }>;
  tools: Array<{ name: string }>;
  dispatcher: (call: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  }) => Promise<{ content: string; isError?: boolean; displayName?: string }>;
}
let capturedLoopOpts: CapturedLoopOpts | null = null;
const runLionLoop = vi.fn(async (opts: CapturedLoopOpts) => {
  capturedLoopOpts = opts;
  return { finalText: 'resposta lion', ok: true, usage: { inputTokens: 1, outputTokens: 1 } };
});
vi.mock('../runtime', () => ({
  MAX_TOOL_TURNS: 5,
  runLionLoop: (...a: unknown[]) => runLionLoop(...(a as [CapturedLoopOpts])),
}));

import { executeLionSdkQuery } from '../index';
import {
  LION_SDK_SYSTEM_PROMPT_V1,
  buildLionMcpCatalogPrompt,
  buildLionSkillCatalogPrompt,
  buildLionSubagentCatalogPrompt,
  buildLionToolCatalogPrompt,
  parsePrefixedMcpName,
  type LionMcpToolEntry,
} from '../prompt';
import { LION_TOOL_SCHEMAS } from '../tool-registry';
import { initMcpInvoke, _resetMcpInvokeForTesting } from '../../mcp-invoke';

const OLLAMA: OrchestratorSelection = {
  runtime: 'lion-sdk',
  provider: 'ollama',
  model: 'qwen3:32b',
  baseUrl: 'http://localhost:11434',
  source: 'settings',
};
const VERTEX: OrchestratorSelection = {
  runtime: 'lion-sdk',
  provider: 'vertex-ai',
  model: 'gemini-2.5-pro',
  apiKey: 'k',
  source: 'settings',
};

async function runTurn(
  selection: OrchestratorSelection = OLLAMA,
  options: Record<string, unknown> = {},
): Promise<{ systemPrompt: string; opts: CapturedLoopOpts }> {
  await executeLionSdkQuery('oi', { sessionId: 'sid', ...options }, () => null, undefined, selection);
  if (!capturedLoopOpts) throw new Error('runLionLoop nao foi chamado');
  return { systemPrompt: capturedLoopOpts.initialMessages[0].content, opts: capturedLoopOpts };
}

function toolsToEntries(tools: typeof EAGER_TOOLS): LionMcpToolEntry[] {
  const entries: LionMcpToolEntry[] = [];
  for (const t of tools) {
    const parsed = parsePrefixedMcpName(t.function.name);
    if (!parsed) continue;
    const required = (t.function.parameters?.required ?? []) as string[];
    const props = (t.function.parameters?.properties ?? {}) as unknown as Record<
      string,
      { type?: string; description?: string }
    >;
    entries.push({
      serverId: parsed.serverId,
      toolName: parsed.toolName,
      description: t.function.description,
      args: Object.entries(props).map(([name, prop]) => ({
        name,
        type: prop?.type,
        description: prop?.description,
        required: required.includes(name),
      })),
      requiredArgs: required.map((name) => ({
        name,
        type: props[name]?.type,
        description: props[name]?.description,
      })),
    });
  }
  return entries;
}

function expectedFullModePrompt(): string {
  const parts = [
    LION_SDK_SYSTEM_PROMPT_V1,
    '## LionClaw Runtime Context\n\nRUNTIME-CONTEXT',
    buildLionToolCatalogPrompt(LION_TOOL_SCHEMAS.map((t) => ({ name: t.name, description: t.description }))),
    PIPELINE_SENTINEL,
    '', // getRepoGraphPromptSection() — filtrada
    buildLionMcpCatalogPrompt(toolsToEntries(EAGER_TOOLS)),
    buildLionSkillCatalogPrompt([]),
    buildLionSubagentCatalogPrompt([], 'index'),
  ];
  return parts.filter((p) => p.trim() !== '').join('\n\n---\n\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedLoopOpts = null;
  settings.clear();
  settings.set('onboarding_completed', 'true');
  _resetMcpInvokeForTesting();
  initMcpInvoke({ getWindow: () => null });
});

afterEach(() => {
  _resetMcpInvokeForTesting();
});

describe('S4 — prompt por modo', () => {
  it("modo 'full': system prompt BYTE-IDENTICO a composicao pre-S4 (+ snapshot)", async () => {
    settings.set('mcp_prompt_mode', 'full');
    const { systemPrompt } = await runTurn();
    expect(systemPrompt).toBe(expectedFullModePrompt());
    expect(systemPrompt).toMatchSnapshot();
    expect(systemPrompt).not.toContain('Servidores MCP disponiveis');
    expect(systemPrompt).not.toContain('mcp_schema');
  });

  it("modo 'index': prompt contem o indice + instrucao mcp_call/mcp_schema, SEM schemas completos", async () => {
    settings.set('mcp_prompt_mode', 'index');
    const { systemPrompt } = await runTurn();
    expect(systemPrompt).toContain('Servidores MCP disponiveis (catalogo resumido; schemas completos sob demanda):');
    expect(systemPrompt).toContain('google-drive: Acesso ao Google Drive do usuario');
    expect(systemPrompt).toContain('- delete_file: Delete a file permanently from Drive');
    expect(systemPrompt).toContain('shopify: Operacoes na loja Shopify');
    expect(systemPrompt).toContain('Para executar uma tool: mcp_call(server, tool, args).');
    expect(systemPrompt).toContain('mcp_schema(server, tool)');
    expect(systemPrompt).not.toContain('### server:');
    expect(systemPrompt).not.toContain('`file_id`: string (required)');
  });

  it('default (setting ausente) = index', async () => {
    const { systemPrompt } = await runTurn();
    expect(systemPrompt).toContain('Servidores MCP disponiveis');
  });

  it('helpers DIRECT: anuncio nativo presente nos 2 modos e helper FORA do indice', async () => {
    settings.set('mcp_prompt_mode', 'index');
    const indexRun = await runTurn();
    expect(indexRun.systemPrompt).toContain(PIPELINE_SENTINEL);
    expect(indexRun.systemPrompt).not.toContain('lionclaw-pipeline-control:');
    expect(indexRun.systemPrompt).not.toContain('pipeline_drive: Drive de pipeline por chat');

    settings.set('mcp_prompt_mode', 'full');
    const fullRun = await runTurn();
    expect(fullRun.systemPrompt).toContain(PIPELINE_SENTINEL);
  });

  it("P5: agente com config explicita mantem o catalogo DIRETO (sem indice amplo) em modo 'index'", async () => {
    settings.set('mcp_prompt_mode', 'index');
    const { systemPrompt } = await runTurn(OLLAMA, { agentId: 'agent-x' });
    expect(systemPrompt).toContain('### server: `google-drive`');
    expect(systemPrompt).not.toContain('Servidores MCP disponiveis');
    expect(setupMCPsForSession).not.toHaveBeenCalled();
  });
});

describe('S4 — lazy universal', () => {
  it("modo 'index' + provider nao-vertex: ZERO setupMCPsForSession eager", async () => {
    settings.set('mcp_prompt_mode', 'index');
    await runTurn(OLLAMA);
    expect(setupMCPsForSession).not.toHaveBeenCalled();
  });

  it("modo 'full' + provider nao-vertex: eager preservado (1 setup com o config da sessao)", async () => {
    settings.set('mcp_prompt_mode', 'full');
    await runTurn(OLLAMA);
    expect(setupMCPsForSession).toHaveBeenCalledTimes(1);
    expect(setupMCPsForSession).toHaveBeenCalledWith(BROAD_CONFIG);
  });

  it("modo 'full' + vertex-ai: lazy legado preservado (sem eager)", async () => {
    settings.set('mcp_prompt_mode', 'full');
    await runTurn(VERTEX);
    expect(setupMCPsForSession).not.toHaveBeenCalled();
  });
});

describe('S4 — tools nativas por modo (mcp_schema)', () => {
  it("modo 'index': mcp_schema anunciada (tools do loop + catalogo LionSDK)", async () => {
    settings.set('mcp_prompt_mode', 'index');
    const { systemPrompt, opts } = await runTurn();
    expect(opts.tools.map((t) => t.name)).toContain('mcp_schema');
    expect(systemPrompt).toContain('`mcp_schema`');
  });

  it("modo 'full': mcp_schema AUSENTE (byte-parity do payload de tools)", async () => {
    settings.set('mcp_prompt_mode', 'full');
    const { opts } = await runTurn();
    expect(opts.tools.map((t) => t.name)).toEqual(LION_TOOL_SCHEMAS.map((t) => t.name));
  });

  it("modo 'index': dispatcher mcp_schema devolve o schema formatado do registry", async () => {
    settings.set('mcp_prompt_mode', 'index');
    const { opts } = await runTurn();
    const r = await opts.dispatcher({
      id: 'c1',
      name: 'mcp_schema',
      input: { server: 'google-drive', tool: 'list_files' },
    });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Tool: list_files');
    expect(r.content).toContain('Input schema (JSON):');
    expect(r.content).toContain('"query"');
  });

  it("modo 'full': dispatcher trata mcp_schema como tool desconhecida (fluxo atual)", async () => {
    settings.set('mcp_prompt_mode', 'full');
    const { opts } = await runTurn();
    const r = await opts.dispatcher({
      id: 'c1',
      name: 'mcp_schema',
      input: { server: 'google-drive', tool: 'list_files' },
    });
    expect(r.isError).toBe(true);
    expect(r.content).toBe('Unknown tool: mcp_schema');
  });
});

describe('S4 — mcp_call via wrapper central (modo index)', () => {
  it('roteia pelo wrapper: pool spawn on-demand, flatten e displayName reais', async () => {
    settings.set('mcp_prompt_mode', 'index');
    const { opts } = await runTurn();
    const r = await opts.dispatcher({
      id: 'c1',
      name: 'mcp_call',
      input: { server_id: 'google-drive', tool: 'list_files', args: { query: 'spec' } },
    });
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe('drive ok');
    expect(r.displayName).toBe('mcp__google-drive__list_files');
    expect(setupMCPsForSession).toHaveBeenCalledTimes(1);
    expect(setupMCPsForSession).toHaveBeenCalledWith({
      'google-drive': BROAD_CONFIG['google-drive'],
    });
    const call = callMCPTool.mock.calls[0] as unknown[];
    expect(call[1]).toBe('mcp__google-drive__list_files');
    expect(call[2]).toEqual({ query: 'spec' });
    expect(call[3]).toEqual({ timeoutMs: 60_000 });
  });

  it('escopo: server fora do mcpConfig da sessao => erro claro, sem spawn', async () => {
    settings.set('mcp_prompt_mode', 'index');
    const { opts } = await runTurn();
    const r = await opts.dispatcher({
      id: 'c1',
      name: 'mcp_call',
      input: { server_id: 'nao-permitido', tool: 'anything', args: {} },
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('fora do escopo desta sessao');
    expect(r.content).toContain('google-drive, shopify');
    expect(setupMCPsForSession).not.toHaveBeenCalled();
    expect(callMCPTool).not.toHaveBeenCalled();
  });

  it('guard AC-13: tool destrutiva consulta o guard com o nome REAL; deny bloqueia sem invocar', async () => {
    settings.set('mcp_prompt_mode', 'index');
    const { opts } = await runTurn();
    guardDecision.mockResolvedValueOnce({ behavior: 'deny', message: 'usuario negou' });
    const r = await opts.dispatcher({
      id: 'c1',
      name: 'mcp_call',
      input: { server_id: 'google-drive', tool: 'delete_file', args: { file_id: 'f1' } },
    });
    expect(guardDecision).toHaveBeenCalledWith('mcp__google-drive__delete_file', {
      file_id: 'f1',
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('negada pelo guard de permissoes');
    expect(callMCPTool).not.toHaveBeenCalled();
  });

  it('guard AC-13: tool safe NAO consulta o guard; allow em destrutiva prossegue', async () => {
    settings.set('mcp_prompt_mode', 'index');
    const { opts } = await runTurn();
    await opts.dispatcher({
      id: 'c1',
      name: 'mcp_call',
      input: { server_id: 'google-drive', tool: 'list_files', args: {} },
    });
    expect(guardDecision).not.toHaveBeenCalled();

    const r = await opts.dispatcher({
      id: 'c2',
      name: 'mcp_call',
      input: { server_id: 'google-drive', tool: 'delete_file', args: { file_id: 'f1' } },
    });
    expect(guardDecision).toHaveBeenCalledTimes(1);
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe('drive ok');
  });

  it('teardown de fim de turno NAO derruba o pool do wrapper (modo index)', async () => {
    settings.set('mcp_prompt_mode', 'index');
    runLionLoop.mockImplementationOnce(async (opts: CapturedLoopOpts) => {
      capturedLoopOpts = opts;
      await opts.dispatcher({
        id: 'c1',
        name: 'mcp_call',
        input: { server_id: 'google-drive', tool: 'list_files', args: {} },
      });
      return { finalText: 'ok', ok: true, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    await runTurn();
    expect(setupMCPsForSession).toHaveBeenCalledTimes(1);
    expect(teardownMCPsForSession).not.toHaveBeenCalled();
  });
});

describe('S4 — mcp_call em modo full (caminho legado byte-identico)', () => {
  it('usa a conexao eager da sessao, sem guard e sem timeout do wrapper; label legado mcp:server.tool', async () => {
    settings.set('mcp_prompt_mode', 'full');
    const { opts } = await runTurn();
    const r = await opts.dispatcher({
      id: 'c1',
      name: 'mcp_call',
      input: { server_id: 'google-drive', tool: 'delete_file', args: { file_id: 'f1' } },
    });
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe('drive ok');
    expect(r.displayName).toBe('mcp:google-drive.delete_file');
    expect(guardDecision).not.toHaveBeenCalled();
    const call = callMCPTool.mock.calls[0] as unknown[];
    expect(call[1]).toBe('mcp__google-drive__delete_file');
    expect(call.length).toBeLessThanOrEqual(3);
  });

  it('server fora do mcpConfig => erro legado "nenhum MCP ativo"', async () => {
    settings.set('mcp_prompt_mode', 'full');
    const { opts } = await runTurn();
    const r = await opts.dispatcher({
      id: 'c1',
      name: 'mcp_call',
      input: { server_id: 'nao-permitido', tool: 'x', args: {} },
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('nenhum MCP ativo com server_id=nao-permitido');
  });
});
