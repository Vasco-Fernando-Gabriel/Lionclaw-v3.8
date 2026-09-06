
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OrchestratorSelection } from '../orchestrator-selection';


interface ServerRow {
  id: string;
  name: string;
  description: string | null;
  command: string;
  args: string;
  env_keys: string;
  is_active: number;
  visible_to: 'all' | 'codex-lion-only';
  index_mode: 'tools' | 'server';
}

interface RegistryRow {
  mcp_id: string;
  tool_name: string;
  description: string | null;
  input_schema: string | null;
  last_discovered_at: string | null;
}

const state = vi.hoisted(() => ({
  servers: [] as ServerRow[],
  registry: [] as RegistryRow[],
  agents: new Map<string, string>(),
  settings: new Map<string, string>(),
}));

vi.mock('../db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: (...args: unknown[]) => {
        if (sql.includes('FROM mcp_tool_registry')) {
          if (sql.includes('WHERE mcp_id IN')) {
            const ids = args as string[];
            return state.registry.filter((r) => ids.includes(r.mcp_id));
          }
          if (sql.includes('WHERE mcp_id = ?')) {
            return state.registry.filter((r) => r.mcp_id === args[0]);
          }
          return state.registry;
        }
        if (sql.includes('FROM mcp_servers')) return state.servers;
        return [];
      },
      get: (...args: unknown[]) => {
        if (sql.includes('FROM agents')) {
          const mcp = state.agents.get(args[0] as string);
          return mcp !== undefined ? { mcp_servers: mcp } : undefined;
        }
        if (sql.includes('FROM mcp_servers WHERE id')) {
          return state.servers.find((s) => s.id === args[0]);
        }
        return undefined;
      },
      run: () => undefined,
    }),
    transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
  }),
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
  getSetting: vi.fn((key: string) => state.settings.get(key) ?? ''),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../app-version', () => ({ getAppVersion: () => '0.0.0-test' }));
vi.mock('../pricing', () => ({ calculateCost: vi.fn(() => 0.5) }));


const setupMCPsForSession = vi.fn(async (config: Record<string, unknown>) => ({
  client: { connections: Object.keys(config).map((serverId) => ({ serverId })) },
  tools: [],
}));
const teardownMCPsForSession = vi.fn(async () => {});
const callMCPTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'drive ok' }] }));

vi.mock('../mcp-tool-bridge', () => ({
  setupMCPsForSession: (...a: unknown[]) =>
    setupMCPsForSession(...(a as [Record<string, unknown>])),
  teardownMCPsForSession: (...a: unknown[]) => teardownMCPsForSession(...(a as [])),
  callMCPTool: (...a: unknown[]) => callMCPTool(...(a as [])),
}));


const guardDecision = vi.fn(
  async (): Promise<{ behavior: 'allow' }> => ({ behavior: 'allow' }),
);
vi.mock('../permission-guard', () => ({
  createPermissionGuard: vi.fn(() => guardDecision),
}));


vi.mock('../skills', () => ({ listSkills: vi.fn(() => []) }));
vi.mock('../title-generator', () => ({ ensureInitialSessionTitle: vi.fn() }));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../onboarding', () => ({
  completeOnboardingFromConversationMessages: vi.fn(),
  completeOnboardingFromUserProfileMessage: vi.fn(() => false),
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
}));
vi.mock('../prompt-builder', () => ({
  buildSystemPrompt: vi.fn(() => 'SYS'),
  buildPipelineControlSection: vi.fn(() => '## Pipeline Control\n\nSENTINEL'),
  getSubagentsPromptMode: vi.fn(() => 'index'),
}));
vi.mock('../prompt-builder-repo-graph', () => ({
  getRepoGraphPromptSection: vi.fn(() => ''),
}));
vi.mock('../lion-sdk/runtime-context', () => ({
  buildLionRuntimeContextPrompt: vi.fn(() => '## LionClaw Runtime Context\n\nRUNTIME-CONTEXT'),
}));
vi.mock('../lion-sdk/adapters/ollama', () => ({
  createOllamaAdapter: vi.fn(() => ({ name: 'ollama', streamCompletion: vi.fn() })),
}));
vi.mock('../lion-sdk/adapters/lmstudio', () => ({
  createLmStudioAdapter: vi.fn(() => ({ name: 'lmstudio', streamCompletion: vi.fn() })),
}));
vi.mock('../lion-sdk/adapters/openai-compatible', () => ({
  createOpenAiCompatibleAdapter: vi.fn(() => ({
    name: 'openai-compatible',
    streamCompletion: vi.fn(),
  })),
}));
vi.mock('../lion-sdk/adapters/google-genai', () => ({
  createGoogleGenAiAdapter: vi.fn(() => ({ name: 'google-genai', streamCompletion: vi.fn() })),
}));
vi.mock('../lion-sdk/title', () => ({ maybeGenerateLionSessionTitle: vi.fn(async () => {}) }));
vi.mock('../lion-sdk/compaction', () => ({
  compactIfNeeded: vi.fn(async () => ({
    messages: [{ role: 'user' as const, content: 'oi' }],
    compacted: false,
  })),
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
vi.mock('../lion-sdk/runtime', () => ({
  MAX_TOOL_TURNS: 5,
  runLionLoop: (...a: unknown[]) => runLionLoop(...(a as [CapturedLoopOpts])),
}));


import { getMCPConfigForAgent } from '../mcp-manager';
import { MCP_GATEWAY_SERVER_ID } from '../mcp-display';
import { executeLionSdkQuery } from '../lion-sdk/index';
import { initMcpInvoke, _resetMcpInvokeForTesting } from '../mcp-invoke';

const OLLAMA: OrchestratorSelection = {
  runtime: 'lion-sdk',
  provider: 'ollama',
  model: 'qwen3:32b',
  baseUrl: 'http://localhost:11434',
  source: 'settings',
};

function serverRow(
  id: string,
  visibleTo: 'all' | 'codex-lion-only' = 'all',
): ServerRow {
  return {
    id,
    name: `Server ${id}`,
    description: `Servidor ${id}`,
    command: 'node',
    args: JSON.stringify([`/path/${id}.js`]),
    env_keys: '[]',
    is_active: 1,
    visible_to: visibleTo,
    index_mode: 'tools',
  };
}

function registryRow(mcpId: string, toolName: string, description: string): RegistryRow {
  return {
    mcp_id: mcpId,
    tool_name: toolName,
    description,
    input_schema: '{"type":"object","properties":{"query":{"type":"string"}}}',
    last_discovered_at: '2026-07-01T00:00:00.000Z',
  };
}

async function runLionTurn(options: Record<string, unknown> = {}): Promise<CapturedLoopOpts> {
  capturedLoopOpts = null;
  await executeLionSdkQuery('oi', { sessionId: 'sid', ...options }, () => null, undefined, OLLAMA);
  if (!capturedLoopOpts) throw new Error('runLionLoop nao foi chamado');
  return capturedLoopOpts;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedLoopOpts = null;
  _resetMcpInvokeForTesting();
  initMcpInvoke({ getWindow: () => null });
  state.settings = new Map([
    ['onboarding_completed', 'true'],
    ['mcp_prompt_mode', 'index'],
  ]);
  state.agents = new Map([['agent-p5', JSON.stringify(['google-drive'])]]);
  state.servers = [
    serverRow('google-drive'),
    serverRow('shopify'),
    serverRow('lionclaw-pipeline-control'),
  ];
  state.registry = [
    registryRow('google-drive', 'list_files', 'Lista arquivos do Drive'),
    registryRow('google-drive', 'delete_file', 'Apaga arquivo do Drive'),
    registryRow('shopify', 'get_orders', 'Lista pedidos da loja'),
    registryRow('lionclaw-pipeline-control', 'pipeline_drive', 'Drive de pipeline'),
  ];
});

afterEach(() => {
  _resetMcpInvokeForTesting();
});


describe('AC-15 (a) — claude/compat: agente com mcpServers explicito fica DIRETO', () => {
  for (const surface of ['claude-sdk', 'claude-compat-sdk'] as const) {
    it(`${surface} + modo index: servers explicitos DIRETOS, sem gateway`, async () => {
      const config = await getMCPConfigForAgent('agent-p5', { surface });
      expect(config).toBeDefined();
      expect(Object.keys(config!)).toEqual(['google-drive']);
      expect(config!['google-drive']).toEqual({ command: 'node', args: ['/path/google-drive.js'] });
      expect(config![MCP_GATEWAY_SERVER_ID]).toBeUndefined();
      expect(config!['shopify']).toBeUndefined();
    });

    it(`${surface}: composicao do agente P5 IDENTICA nos modos index e full (como hoje)`, async () => {
      const indexMode = await getMCPConfigForAgent('agent-p5', { surface });
      state.settings.set('mcp_prompt_mode', 'full');
      const fullMode = await getMCPConfigForAgent('agent-p5', { surface });
      expect(JSON.stringify(indexMode)).toBe(JSON.stringify(fullMode));
    });
  }

  it('contraste: sessao AMPLA (sem agentId) em modo index ganha gateway e perde os servers de negocio', async () => {
    const broad = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    expect(broad![MCP_GATEWAY_SERVER_ID]).toBeDefined();
    expect(broad!['google-drive']).toBeUndefined();
  });
});


describe('AC-15 (b) — lion: agente P5 mantem catalogo direto e allowlist exata', () => {
  it('prompt do agente P5 em modo index: catalogo DIRETO por server, sem o indice amplo', async () => {
    const opts = await runLionTurn({ agentId: 'agent-p5' });
    const systemPrompt = opts.initialMessages[0].content;
    expect(systemPrompt).toContain('### server: `google-drive`');
    expect(systemPrompt).not.toContain('### server: `shopify`');
    expect(systemPrompt).not.toContain('Servidores MCP disponiveis');
    expect(setupMCPsForSession).not.toHaveBeenCalled();
  });

  it('mcp_call num server DENTRO da config explicita: funciona via wrapper (spawn so do alvo)', async () => {
    const opts = await runLionTurn({ agentId: 'agent-p5' });
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
      'google-drive': { command: 'node', args: ['/path/google-drive.js'] },
    });
  });

  it('mcp_call num server FORA da config explicita: escopo bloqueia ANTES do spawn, allowlist exata', async () => {
    const opts = await runLionTurn({ agentId: 'agent-p5' });
    const r = await opts.dispatcher({
      id: 'c1',
      name: 'mcp_call',
      input: { server_id: 'shopify', tool: 'get_orders', args: {} },
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('fora do escopo desta sessao');
    expect(r.content).toContain('google-drive');
    expect(r.content).not.toContain('shopify,'); // nao lista o server bloqueado como permitido
    expect(setupMCPsForSession).not.toHaveBeenCalled();
    expect(callMCPTool).not.toHaveBeenCalled();
  });

  it('contraste: sessao AMPLA (sem agentId) tem shopify na allowlist do mcp_call', async () => {
    const opts = await runLionTurn();
    const r = await opts.dispatcher({
      id: 'c1',
      name: 'mcp_call',
      input: { server_id: 'shopify', tool: 'get_orders', args: {} },
    });
    expect(r.isError).toBeFalsy();
    expect(r.displayName).toBe('mcp__shopify__get_orders');
    expect(setupMCPsForSession).toHaveBeenCalledWith({
      shopify: { command: 'node', args: ['/path/shopify.js'] },
    });
  });
});
