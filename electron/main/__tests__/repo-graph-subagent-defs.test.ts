
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

vi.mock('../orchestrator-selection', () => ({
  resolveOrchestratorSelection: vi.fn(),
  InvalidOrchestratorSelectionError: class extends Error {},
}));

vi.mock('../claude-compat-sdk', () => ({
  executeClaudeCompatSdkQuery: vi.fn(async () => undefined),
  isClaudeCompatQueryActive: vi.fn(() => false),
  resetClaudeCompatSdkSessionState: vi.fn(),
  stopClaudeCompatQuery: vi.fn(),
}));

vi.mock('../codex-sdk', () => ({
  executeCodexSdkQuery: vi.fn(async () => undefined),
  isCodexSdkQueryActive: vi.fn(() => false),
  resetCodexSdkSessionState: vi.fn(),
  stopCodexSdkQuery: vi.fn(),
}));

vi.mock('../lion-sdk', () => ({
  executeLionSdkQuery: vi.fn(async () => undefined),
  isLionSdkQueryActive: vi.fn(() => false),
  resetLionSdkSessionState: vi.fn(),
  stopLionSdkQuery: vi.fn(),
}));

const getAllAgentsMock = vi.fn((): unknown[] => []);
vi.mock('../db', () => ({
  getAllAgents: () => getAllAgentsMock(),
  getAgent: () => undefined,
  insertMessage: vi.fn(),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(() => 'session-1'),
  getSetting: vi.fn(),
  updateSessionTokens: vi.fn(),
  getActiveSession: vi.fn(),
  getActiveChatSession: vi.fn(),
  getSession: vi.fn(),
  getEnabledTools: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  insertTaskExecution: vi.fn(),
  getTurnIndexForUserMessage: vi.fn(() => 1),
  getLatestUserTurnIndex: vi.fn(() => 1),
  getCompletedDocsCount: vi.fn(() => 0),
}));

vi.mock('../knowledge-state', () => ({ setActiveAgentId: vi.fn() }));
vi.mock('../onboarding', () => ({ extractAndProcessOnboardingData: vi.fn() }));
vi.mock('../pricing', () => ({ calculateCost: () => 0 }));
vi.mock('../secrets-vault', () => ({
  getApiKey: async () => null,
  getSecret: async () => null,
}));
vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => vi.fn(),
  GUARD_GATED_TOOLS: [],
}));

vi.mock('../mcp-manager', () => ({
  getMCPConfigForAgent: async () => ({}),
  getMCPToolsFromRegistry: vi.fn(() => []),
  getAllMCPServers: vi.fn(() => []),
  buildMCPSpecForAgent: vi.fn((ids: string[]) =>
    ids.includes('repo-graph')
      ? [{ 'repo-graph': { command: 'node', args: ['/dist/repo-graph/src/index.js'] } }]
      : undefined,
  ),
}));

function baseAgentConfig(agentId: string, allowedToolsOverride?: string[]) {
  return {
    model: 'claude-sonnet-4-6',
    systemPrompt: agentId === 'analista' ? 'Prompt do analista' : '',
    allowedTools:
      allowedToolsOverride ?? (agentId === 'analista' ? ['Read', 'Grep'] : []),
    mcpServers: [],
    maxTurns: agentId === 'analista' ? 10 : 0,
    effort: 'high',
    thinking: 'adaptive',
    thinkingBudget: undefined,
    runtime: 'cloud',
  };
}
const agentConfigByIdMock = vi.fn(baseAgentConfig);
vi.mock('../agent-config-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-config-resolver')>();
  return {
    ...actual,
    resolveAgentQueryConfig: async (agentId: string) => agentConfigByIdMock(agentId),
  };
});

vi.mock('../mcp-discovery', () => ({ getDisabledSDKMcps: () => [] }));
vi.mock('../artifact-detector', () => ({
  captureToolUse: vi.fn(),
  captureToolResult: vi.fn(),
  resetArtifactDetector: vi.fn(),
}));
vi.mock('../prompt-builder', () => ({ buildSystemPrompt: async () => '' }));
vi.mock('../paths', () => ({
  getAgentCwd: () => '/tmp',
  getBackgroundCwd: () => '/tmp',
  getLionClawHome: () => '/tmp',
}));
vi.mock('../codex-agents-mcp', () => ({ getCodexAgentsServer: () => undefined }));
vi.mock('../title-generator', () => ({
  ensureInitialSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(),
}));
vi.mock('../message-queue', () => ({
  messageQueue: {
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    clear: vi.fn(),
    isProcessing: false,
    length: 0,
    processingDurationMs: 0,
  },
}));

import { buildAgentDefinitions } from '../orchestrator';
import { REPO_GRAPH_READER_TOOLS } from '../agent-config-resolver';
import type { RepoChatContext } from '../repo-graph/turn-context';

const REPO_CTX: RepoChatContext = {
  repositoryId: 'repo-1',
  canonicalRootPath: '/abs/fake-repo',
  status: 'ready',
  statsResumo: '12 arquivos, 80 simbolos',
};

function seedAgents(): void {
  getAllAgentsMock.mockReturnValue([
    {
      id: 'analista',
      description: 'Analista de codigo',
      model: 'claude-sonnet-4-6',
      isActive: true,
      runtime: 'cloud',
    },
    {
      id: 'livre',
      description: 'Agente sem allowlist (herda todas as tools)',
      model: 'default',
      isActive: true,
      runtime: 'cloud',
    },
    {
      id: 'local-1',
      description: 'Agente local (NAO vira subagent SDK)',
      model: 'llama3',
      isActive: true,
      runtime: 'local',
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  agentConfigByIdMock.mockImplementation(baseAgentConfig);
  seedAgents();
});

describe('buildAgentDefinitions SEM ctx — regressao (secao 15 item 3)', () => {
  it('retorna definitions identicas ao formato atual', async () => {
    const defs = await buildAgentDefinitions();
    expect(Object.keys(defs).sort()).toEqual(['analista', 'livre']);
    expect(defs['analista']).toEqual({
      description: 'Analista de codigo',
      tools: ['Read', 'Grep'],
      prompt: 'Prompt do analista',
      model: 'claude-sonnet-4-6',
      maxTurns: 10,
      mcpServers: [],
    });
    expect(defs['livre']).toEqual({
      description: 'Agente sem allowlist (herda todas as tools)',
      tools: undefined,
      prompt: undefined,
      model: undefined,
      maxTurns: undefined,
      mcpServers: [],
    });
  });

  it('sem ctx, NENHUMA tool mcp__repo-graph__ aparece', async () => {
    const defs = await buildAgentDefinitions();
    const tools = (defs['analista']!['tools'] as string[]) ?? [];
    expect(tools.some((t) => t.startsWith('mcp__repo-graph__'))).toBe(false);
  });
});

describe('buildAgentDefinitions COM ctx — merge repo-aware (11.1/F12/AC-7)', () => {
  it('allowlist MERGEADA: tools existentes preservadas + 7 tools repo-graph', async () => {
    const defs = await buildAgentDefinitions(REPO_CTX);
    const tools = defs['analista']!['tools'] as string[];
    expect(tools).toContain('Read');
    expect(tools).toContain('Grep');
    for (const tool of REPO_GRAPH_READER_TOOLS) {
      expect(tools).toContain(tool);
    }
    expect(tools.length).toBe(2 + REPO_GRAPH_READER_TOOLS.length);
  });

  it('NENHUMA tool de build/update entra (inexistente no reader, 5.2)', async () => {
    const defs = await buildAgentDefinitions(REPO_CTX);
    const tools = defs['analista']!['tools'] as string[];
    expect(REPO_GRAPH_READER_TOOLS.length).toBe(7);
    for (const tool of tools.filter((t) => t.startsWith('mcp__repo-graph__'))) {
      expect(tool).not.toMatch(/build|update|sync|index/);
    }
  });

  it('merge e idempotente (tool repo-graph ja na allowlist nao duplica)', async () => {
    agentConfigByIdMock.mockImplementation((agentId: string) =>
      baseAgentConfig(
        agentId,
        agentId === 'analista' ? ['Read', 'mcp__repo-graph__repo_graph_search'] : [],
      ),
    );
    const defs = await buildAgentDefinitions(REPO_CTX);
    const tools = defs['analista']!['tools'] as string[];
    expect(tools.filter((t) => t === 'mcp__repo-graph__repo_graph_search').length).toBe(1);
    expect(tools.length).toBe(1 + REPO_GRAPH_READER_TOOLS.length);
  });

  it('allowlist VAZIA (= herda todas as tools) permanece undefined (sem restringir)', async () => {
    const defs = await buildAgentDefinitions(REPO_CTX);
    expect(defs['livre']!['tools']).toBeUndefined();
  });

  it('prompt curto repo-aware anexado SEM perder o prompt original', async () => {
    const defs = await buildAgentDefinitions(REPO_CTX);
    const prompt = defs['analista']!['prompt'] as string;
    expect(prompt.startsWith('Prompt do analista')).toBe(true);
    expect(prompt).toContain('## Repositorio ativo (CodeGraph)');
    expect(prompt).toContain('/abs/fake-repo');
    const promptLivre = defs['livre']!['prompt'] as string;
    expect(promptLivre.startsWith('## Repositorio ativo (CodeGraph)')).toBe(true);
  });

  it('MCP repo-graph entra na definition (subprocess spec)', async () => {
    const defs = await buildAgentDefinitions(REPO_CTX);
    const mcpServers = defs['analista']!['mcpServers'] as Array<Record<string, unknown>>;
    expect(mcpServers.some((spec) => 'repo-graph' in spec)).toBe(true);
  });
});
