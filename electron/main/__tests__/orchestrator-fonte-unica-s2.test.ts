
import { describe, it, expect, beforeEach, vi } from 'vitest';


const h = vi.hoisted(() => {
  type ExecutorMock = (...args: unknown[]) => Promise<undefined>;
  class InvalidOrchestratorSelectionError extends Error {
    code: 'orchestrator_unconfigured' | 'orchestrator_provider_unavailable';
    missingField?: 'runtime' | 'provider' | 'model';
    constructor(
      message: string,
      code: 'orchestrator_unconfigured' | 'orchestrator_provider_unavailable' = 'orchestrator_unconfigured',
      missingField?: 'runtime' | 'provider' | 'model',
    ) {
      super(message);
      this.name = 'InvalidOrchestratorSelectionError';
      this.code = code;
      this.missingField = missingField;
    }
  }
  return {
    queryMock: vi.fn<(args: { prompt: string; options: Record<string, unknown> }) => unknown>(),
    getApiKeyMock: vi.fn(async (): Promise<string | null> => 'test-key'),
    resolveMock: vi.fn(),
    codexExecMock: vi.fn<ExecutorMock>(async () => undefined),
    compatExecMock: vi.fn<ExecutorMock>(async () => undefined),
    kimiExecMock: vi.fn<ExecutorMock>(async () => undefined),
    lionExecMock: vi.fn<ExecutorMock>(async () => undefined),
    windowSend: vi.fn(),
    InvalidOrchestratorSelectionError,
  };
});

const InvalidOrchestratorSelectionError = h.InvalidOrchestratorSelectionError;


vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  rootLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => h.queryMock(args),
}));

vi.mock('../orchestrator-selection', () => ({
  resolveOrchestratorSelection: (...args: unknown[]) => h.resolveMock(...(args as [])),
  InvalidOrchestratorSelectionError: h.InvalidOrchestratorSelectionError,
}));

vi.mock('../claude-compat-sdk', () => ({
  executeClaudeCompatSdkQuery: (...args: unknown[]) => h.compatExecMock(...args),
  isClaudeCompatQueryActive: vi.fn(() => false),
  resetClaudeCompatSdkSessionState: vi.fn(),
  stopClaudeCompatQuery: vi.fn(),
}));

vi.mock('../codex-sdk', () => ({
  executeCodexSdkQuery: (...args: unknown[]) => h.codexExecMock(...args),
  isCodexSdkQueryActive: vi.fn(() => false),
  resetCodexSdkSessionState: vi.fn(),
  stopCodexSdkQuery: vi.fn(),
}));

vi.mock('../kimi-sdk', () => ({
  executeKimiSdkQuery: (...args: unknown[]) => h.kimiExecMock(...args),
  isKimiSdkQueryActive: vi.fn(() => false),
  resetKimiSdkSessionState: vi.fn(),
  stopKimiSdkQuery: vi.fn(),
}));

vi.mock('../lion-sdk', () => ({
  executeLionSdkQuery: (...args: unknown[]) => h.lionExecMock(...args),
  isLionSdkQueryActive: vi.fn(() => false),
  resetLionSdkSessionState: vi.fn(),
  stopLionSdkQuery: vi.fn(),
}));

vi.mock('../db', () => ({
  getAllAgents: () => [],
  getAgent: () => undefined,
  insertMessage: vi.fn(() => 1),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(),
  getSetting: vi.fn(() => undefined),
  updateSessionTokens: vi.fn(),
  getActiveSession: vi.fn(() => undefined),
  getActiveChatSession: vi.fn(() => undefined),
  getSession: vi.fn(() => undefined),
  getEnabledTools: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  insertTaskExecution: vi.fn(),
  getTurnIndexForUserMessage: vi.fn(() => 1),
  getLatestUserTurnIndex: vi.fn(() => 1),
  getHarnessProject: vi.fn(() => null),
  clearSessionPendingSeed: vi.fn(),
}));

vi.mock('../activity-log', () => ({
  recordActivity: vi.fn(),
  isWriteTool: vi.fn(() => false),
  deriveToolDetail: vi.fn(() => ''),
}));

vi.mock('../knowledge-state', () => ({ setActiveAgentId: vi.fn() }));
vi.mock('../onboarding', () => ({ extractAndProcessOnboardingData: vi.fn(() => null) }));
vi.mock('../pricing', () => ({ calculateCost: () => 0 }));
vi.mock('../secrets-vault', () => ({
  getApiKey: (...args: unknown[]) => h.getApiKeyMock(...(args as [])),
  getSecret: async () => null,
}));
vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => vi.fn(),
  GUARD_GATED_TOOLS: [],
}));
vi.mock('../mcp-manager', () => ({ getMCPConfigForAgent: async () => ({}) }));
vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: async () => ({
    allowedTools: [],
    systemPrompt: '',
    mcpServers: [],
    maxTurns: 0,
  }),
  mergeRepoGraphAllowlist: (tools: string[]) => tools,
  buildRepoGraphMcpSpec: () => ({}),
  REPO_GRAPH_MCP_SERVER_ID: 'repo-graph',
}));
vi.mock('../mcp-discovery', () => ({ getDisabledSDKMcps: () => [] }));
vi.mock('../artifact-detector', () => ({
  captureToolUse: vi.fn(),
  captureToolResult: vi.fn(),
  resetArtifactDetector: vi.fn(),
}));
vi.mock('../prompt-builder', () => ({ buildSystemPrompt: () => '' }));
vi.mock('../paths', () => ({
  getAgentCwd: () => '/agent/cwd',
  getBackgroundCwd: () => '/bg/cwd',
  getCronCwd: () => '/cron/cwd',
  getLionClawHome: () => '/tmp',
}));
vi.mock('../codex-agents-mcp', () => ({ getCodexAgentsServer: () => undefined }));
vi.mock('../title-generator', () => ({
  ensureInitialSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(),
}));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../drive-usage-sink', () => ({
  reportDriveTurnUsage: vi.fn(),
  reportDriveTurnComplete: vi.fn(),
}));
vi.mock('../repo-graph/turn-context', () => ({
  setRepoGraphTurnSession: vi.fn(),
  clearRepoGraphTurnSession: vi.fn(),
  setRepoGraphTurnContext: vi.fn(),
  getRepoGraphTurnContext: vi.fn(() => null),
}));
vi.mock('../prompt-builder-repo-graph', () => ({
  appendRepoGraphSection: (prompt: string) => prompt,
  summarizeRepoGraphStats: () => '',
  buildRepoGraphSubagentSection: () => '',
}));


import {
  submitMessage,
  executeTelegramLaneQuery,
  resetTelegramSessionState,
  resetCronSessionState,
} from '../orchestrator';

function makeCapturingGetWindow() {
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, chunk: unknown) => h.windowSend(channel, chunk) },
  };
  return () => win as unknown as import('electron').BrowserWindow;
}

function okQueryResult() {
  return {
    async *[Symbol.asyncIterator]() {
    },
    toggleMcpServer: async () => {},
  };
}

const claudeSelection = {
  runtime: 'claude-sdk',
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  source: 'settings',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.queryMock.mockImplementation(() => okQueryResult());
  h.getApiKeyMock.mockResolvedValue('test-key');
  h.windowSend.mockReset();
  resetTelegramSessionState();
  resetCronSessionState();
});


describe('processQueue: erro tipado do resolver emite chunk e a fila segue (SPEC 2.2)', () => {
  it('desktop: mensagem 1 falha com orchestrator_unconfigured (chunk emitido), mensagem 2 despacha', async () => {
    h.resolveMock
      .mockRejectedValueOnce(
        new InvalidOrchestratorSelectionError(
          'Orquestrador nao configurado: runtime ausente.',
          'orchestrator_unconfigured',
          'runtime',
        ),
      )
      .mockResolvedValue(claudeSelection);

    const getWindow = makeCapturingGetWindow();
    submitMessage('primeira (vai falhar)', {}, getWindow);
    submitMessage('segunda (deve rodar)', {}, getWindow);

    await vi.waitFor(() => expect(h.queryMock).toHaveBeenCalledTimes(1));

    const errorChunk = h.windowSend.mock.calls.find(
      ([channel, chunk]) =>
        channel === 'chat:stream' &&
        (chunk as { type?: string }).type === 'error' &&
        (chunk as { code?: string }).code === 'orchestrator_unconfigured',
    );
    expect(errorChunk).toBeDefined();
    expect((errorChunk![1] as { error?: string }).error).toMatch(/nao configurado/i);

    expect(h.queryMock).toHaveBeenCalledTimes(1);
    expect(h.resolveMock).toHaveBeenCalledTimes(2);
  });
});


describe('despacho por lane (S3): lane nao-desktop despacha qualquer runtime', () => {
  it('telegram + runtime codex-sdk DESPACHA ao executor do codex com a telegram lane', async () => {
    h.resolveMock.mockResolvedValue({
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-5.5',
      source: 'settings',
    });

    const getWindow = makeCapturingGetWindow();
    await executeTelegramLaneQuery(
      'oi do telegram',
      { sessionId: 't-gate', silent: true },
      getWindow,
    );

    expect(h.codexExecMock).toHaveBeenCalledTimes(1);
    const call = h.codexExecMock.mock.calls[0]!;
    expect(call[3]).toMatchObject({ name: 'telegram' });
    expect(call[4]).toMatchObject({ runtime: 'codex-sdk', provider: 'codex' });

    expect(h.compatExecMock).not.toHaveBeenCalled();
    expect(h.kimiExecMock).not.toHaveBeenCalled();
    expect(h.lionExecMock).not.toHaveBeenCalled();
    expect(h.queryMock).not.toHaveBeenCalled();
  });

  it('telegram + runtime claude-compat-sdk DESPACHA ao executor do compat com a telegram lane', async () => {
    h.resolveMock.mockResolvedValue({
      runtime: 'claude-compat-sdk',
      provider: 'zai',
      model: 'glm-4.7',
      source: 'settings',
    });

    const getWindow = makeCapturingGetWindow();
    await executeTelegramLaneQuery(
      'oi do telegram',
      { sessionId: 't-compat', silent: true },
      getWindow,
    );

    expect(h.compatExecMock).toHaveBeenCalledTimes(1);
    const call = h.compatExecMock.mock.calls[0]!;
    expect(call[3]).toMatchObject({ name: 'telegram' });
    expect(call[4]).toMatchObject({ runtime: 'claude-compat-sdk', provider: 'zai' });
    expect(h.codexExecMock).not.toHaveBeenCalled();
    expect(h.queryMock).not.toHaveBeenCalled();
  });

  it('telegram + runtime claude-sdk despacha normal (roda no proprio modulo)', async () => {
    h.resolveMock.mockResolvedValue(claudeSelection);

    const getWindow = makeCapturingGetWindow();
    await executeTelegramLaneQuery(
      'oi do telegram',
      { sessionId: 't-ok', silent: true },
      getWindow,
    );

    expect(h.queryMock).toHaveBeenCalledTimes(1);
    expect(h.codexExecMock).not.toHaveBeenCalled();
  });
});
