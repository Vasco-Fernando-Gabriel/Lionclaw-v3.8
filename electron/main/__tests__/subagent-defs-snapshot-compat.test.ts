
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
}));

const getAllAgentsMock = vi.fn((): unknown[] => []);
vi.mock('../db', () => ({
  getAllAgents: () => getAllAgentsMock(),
  getAgent: vi.fn(() => undefined),
  insertMessage: vi.fn(),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(),
  getSetting: vi.fn(() => undefined),
  updateSessionTokens: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getSession: vi.fn(() => null),
  getEnabledTools: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  insertTaskExecution: vi.fn(),
  getTurnIndexForUserMessage: vi.fn(() => 0),
  getLatestUserTurnIndex: vi.fn(() => 0),
}));

vi.mock('../knowledge-state', () => ({ setActiveAgentId: vi.fn() }));
vi.mock('../onboarding', () => ({ extractAndProcessOnboardingData: vi.fn() }));
vi.mock('../pricing', () => ({ calculateCost: () => 0 }));
vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async () => 'fake-api-key'),
  getApiKey: vi.fn(async () => null),
}));
vi.mock('../permission-guard', () => ({ createPermissionGuard: () => vi.fn() }));
vi.mock('../mcp-manager', () => ({ getMCPConfigForAgent: vi.fn(async () => ({})) }));

vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: vi.fn(async () => ({
    allowedTools: [],
    systemPrompt: '',
    mcpServers: [],
    maxTurns: 0,
  })),
}));

vi.mock('../mcp-discovery', () => ({
  getDisabledSDKMcps: () => [],
  getCachedSDKMcpServers: () => [],
}));

vi.mock('../artifact-detector', () => ({
  captureToolUse: vi.fn(),
  captureToolResult: vi.fn(),
  resetArtifactDetector: vi.fn(),
}));

vi.mock('../prompt-builder', () => ({ buildSystemPrompt: () => '' }));

vi.mock('../paths', () => ({
  getAgentCwd: () => '/tmp',
  getBackgroundCwd: () => '/tmp',
  getLionClawHome: () => '/tmp',
}));

vi.mock('../codex-agents-mcp', () => ({ getCodexAgentsServer: () => undefined }));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../pipeline-shared/sdk-bootstrap', () => ({
  ensureNodeInPath: vi.fn(),
  getClaudeCodeExecutablePath: () => '/tmp/claude-cli.js',
  getClaudeSdkProcessOptions: () => ({
    pathToClaudeCodeExecutable: '/tmp/claude-cli.js',
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

import { buildAgentDefinitions } from '../claude-compat-sdk';

const RESEARCHER_DESCRIPTION =
  'Especialista em pesquisa profunda. Cobre coleta de fontes, verificacao adversarial e sintese final com citacoes completas para relatorios extensos.';

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
      description: 'Implementa codigo de producao. Segue SPEC e roda os gates.',
      model: 'default',
      isActive: true,
      runtime: 'cloud',
    },
  ]);
});

describe('AC-59 — snapshot byte-identico do buildAgentDefinitions (claude-compat)', () => {
  it('provider zai: snapshot estavel', async () => {
    const defs = await buildAgentDefinitions('zai');
    expect(JSON.stringify(defs, null, 2)).toMatchSnapshot();
  });

  it('provider minimax: snapshot estavel (override de model intacto)', async () => {
    const defs = await buildAgentDefinitions('minimax');
    expect(JSON.stringify(defs, null, 2)).toMatchSnapshot();
    expect(defs['researcher']!['model']).toBeUndefined();
  });

  it('description INTEGRAL nos dois providers', async () => {
    for (const provider of ['zai', 'minimax'] as const) {
      const defs = await buildAgentDefinitions(provider);
      expect(defs['researcher']!['description']).toBe(RESEARCHER_DESCRIPTION);
    }
  });
});
