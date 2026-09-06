
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const iter = (async function* () {
    })();
    return Object.assign(iter, { toggleMcpServer: vi.fn(async () => undefined) });
  },
}));

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
  getSetting: vi.fn(() => undefined),
  updateSessionTokens: vi.fn(),
  getActiveSession: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getSession: vi.fn(() => null),
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
  getApiKey: vi.fn(async () => null),
  getSecret: vi.fn(async () => 'fake-api-key'),
}));
vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => vi.fn(),
  GUARD_GATED_TOOLS: [],
}));

vi.mock('../mcp-manager', () => ({
  getMCPConfigForAgent: async () => ({}),
  getMCPToolsFromRegistry: vi.fn(() => []),
  getAllMCPServers: vi.fn(() => []),
  buildMCPSpecForAgent: vi.fn(() => undefined),
}));

const ALLOWLIST_BY_AGENT: Record<string, string[]> = {
  'com-todo': ['Read', 'TodoWrite', 'Grep'],
  'sem-todo': ['Read', 'Grep'],
  livre: [],
};

function baseAgentConfig(agentId: string) {
  return {
    model: 'claude-sonnet-4-6',
    systemPrompt: '',
    allowedTools: ALLOWLIST_BY_AGENT[agentId] ?? [],
    mcpServers: [],
    maxTurns: 0,
    effort: 'high',
    thinking: 'adaptive',
    thinkingBudget: undefined,
    runtime: 'cloud',
  };
}
vi.mock('../agent-config-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-config-resolver')>();
  return {
    ...actual,
    resolveAgentQueryConfig: async (agentId: string) => baseAgentConfig(agentId),
  };
});

vi.mock('../mcp-discovery', () => ({
  getDisabledSDKMcps: () => [],
  getCachedSDKMcpServers: () => [],
}));
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
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../pipeline-shared/sdk-bootstrap', () => ({
  ensureNodeInPath: vi.fn(),
  getClaudeCodeExecutablePath: () => '/tmp/claude.exe',
  getClaudeSdkProcessOptions: () => ({
    pathToClaudeCodeExecutable: '/tmp/claude.exe',
    executable: 'node',
  }),
}));
vi.mock('../title-generator', () => ({
  ensureInitialSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(),
}));
vi.mock('../sdk-session-id', () => ({
  makeScopedSdkSessionId: (scope: string, sessionId: string) => `${scope}:${sessionId}`,
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

import { buildAgentDefinitions as buildOrchestratorDefs } from '../orchestrator';
import { buildAgentDefinitions as buildCompatDefs } from '../claude-compat-sdk';
import { TASK_TOOL_NAMES } from '../agent-runtime/sdk-tool-names';

const MAPPED_COM_TODO = ['Read', ...TASK_TOOL_NAMES, 'Grep'];

beforeEach(() => {
  vi.clearAllMocks();
  getAllAgentsMock.mockReturnValue([
    { id: 'com-todo', description: 'Agente com TodoWrite', model: 'default', isActive: true, runtime: 'cloud' },
    { id: 'sem-todo', description: 'Agente sem TodoWrite', model: 'default', isActive: true, runtime: 'cloud' },
    { id: 'livre', description: 'Agente sem allowlist (herda tudo)', model: 'default', isActive: true, runtime: 'cloud' },
  ]);
});

describe('D8 — buildAgentDefinitions (orchestrator) traduz nomes na fronteira', () => {
  it('TodoWrite -> Task tools NO LUGAR', async () => {
    const defs = await buildOrchestratorDefs();
    expect(defs['com-todo']!.tools).toEqual(MAPPED_COM_TODO);
  });

  it('allowlist sem TodoWrite fica identica', async () => {
    const defs = await buildOrchestratorDefs();
    expect(defs['sem-todo']!.tools).toEqual(['Read', 'Grep']);
  });

  it('allowlist vazia preserva undefined (= herda todas as tools)', async () => {
    const defs = await buildOrchestratorDefs();
    expect(defs['livre']!.tools).toBeUndefined();
    expect('tools' in defs['livre']!).toBe(true);
  });
});

describe('D8 — buildAgentDefinitions (claude-compat-sdk) espelha o orchestrator', () => {
  it.each(['zai', 'minimax'] as const)('provider %s: TodoWrite -> Task tools NO LUGAR', async (provider) => {
    const defs = await buildCompatDefs(provider);
    expect(defs['com-todo']!.tools).toEqual(MAPPED_COM_TODO);
  });

  it.each(['zai', 'minimax'] as const)('provider %s: allowlist sem TodoWrite fica identica', async (provider) => {
    const defs = await buildCompatDefs(provider);
    expect(defs['sem-todo']!.tools).toEqual(['Read', 'Grep']);
  });

  it.each(['zai', 'minimax'] as const)('provider %s: allowlist vazia preserva undefined', async (provider) => {
    const defs = await buildCompatDefs(provider);
    expect(defs['livre']!.tools).toBeUndefined();
  });

  it('orchestrator e compat produzem o MESMO `tools` para os tres agentes', async () => {
    const orch = await buildOrchestratorDefs();
    const compat = await buildCompatDefs('zai');
    for (const id of Object.keys(ALLOWLIST_BY_AGENT)) {
      expect(compat[id]!.tools).toEqual(orch[id]!.tools);
    }
  });
});
