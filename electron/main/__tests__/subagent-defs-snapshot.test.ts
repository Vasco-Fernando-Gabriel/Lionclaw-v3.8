
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

function baseAgentConfig(agentId: string) {
  return {
    model: 'claude-sonnet-4-6',
    systemPrompt: agentId === 'researcher' ? 'Prompt integral do researcher' : '',
    allowedTools: agentId === 'researcher' ? ['Read', 'WebSearch'] : [],
    mcpServers: [],
    maxTurns: agentId === 'researcher' ? 12 : 0,
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
import type { RepoChatContext } from '../repo-graph/turn-context';

const RESEARCHER_DESCRIPTION =
  'Especialista em pesquisa profunda. Cobre coleta de fontes, verificacao adversarial e sintese final com citacoes completas para relatorios extensos.';
const CODER_DESCRIPTION =
  'Implementa codigo de producao. Segue SPEC, roda testes e nunca entrega sem validar os gates da sprint.';

const REPO_CTX: RepoChatContext = {
  repositoryId: 'repo-1',
  canonicalRootPath: '/abs/fake-repo',
  status: 'ready',
  statsResumo: '12 arquivos, 80 simbolos',
};

beforeEach(() => {
  vi.clearAllMocks();
  getAllAgentsMock.mockReturnValue([
    {
      id: 'researcher',
      description: RESEARCHER_DESCRIPTION,
      model: 'claude-opus-4-7',
      isActive: true,
      runtime: 'cloud',
    },
    {
      id: 'coder',
      description: CODER_DESCRIPTION,
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
});

describe('AC-59 — snapshot byte-identico do buildAgentDefinitions (orchestrator)', () => {
  it('repoChatContext UNDEFINED: snapshot estavel', async () => {
    const defs = await buildAgentDefinitions();
    expect(JSON.stringify(defs, null, 2)).toMatchSnapshot();
  });

  it('repoChatContext DEFINIDO: snapshot estavel', async () => {
    const defs = await buildAgentDefinitions(REPO_CTX);
    expect(JSON.stringify(defs, null, 2)).toMatchSnapshot();
  });

  it('a description entregue a Task tool e INTEGRAL (nunca o resumo de 80 chars)', async () => {
    for (const defs of [await buildAgentDefinitions(), await buildAgentDefinitions(REPO_CTX)]) {
      expect(defs['researcher']!['description']).toBe(RESEARCHER_DESCRIPTION);
      expect(defs['coder']!['description']).toBe(CODER_DESCRIPTION);
    }
  });
});
