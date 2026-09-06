
import { describe, it, expect, beforeEach, vi } from 'vitest';


const h = {
  queryMock: vi.fn(),
  setActiveMock: vi.fn(),
};

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => h.queryMock(args),
}));

vi.mock('../orchestrator-selection', () => ({
  resolveOrchestratorSelection: vi.fn(async () => ({
    runtime: 'claude-sdk',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    source: 'settings',
  })),
  InvalidOrchestratorSelectionError: class extends Error {},
}));

vi.mock('../kimi-sdk', () => ({
  executeKimiSdkQuery: vi.fn(async () => undefined),
  isKimiSdkQueryActive: vi.fn(() => false),
  resetKimiSdkSessionState: vi.fn(),
  stopKimiSdkQuery: vi.fn(),
}));
vi.mock('../lion-sdk', () => ({
  executeLionSdkQuery: vi.fn(async () => undefined),
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
  setSessionActiveContextTokens: (...a: unknown[]) => h.setActiveMock(...(a as [])),
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
vi.mock('../secrets-vault', () => ({ getApiKey: async () => 'k', getSecret: async () => null }));
vi.mock('../permission-guard', () => ({ createPermissionGuard: () => vi.fn(), GUARD_GATED_TOOLS: [] }));
vi.mock('../mcp-manager', () => ({ getMCPConfigForAgent: async () => ({}) }));
vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: async () => ({ allowedTools: [], systemPrompt: '', mcpServers: [], maxTurns: 0 }),
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
vi.mock('../title-generator', () => ({ ensureInitialSessionTitle: vi.fn(), generateSessionTitle: vi.fn() }));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../drive-usage-sink', () => ({ reportDriveTurnUsage: vi.fn(), reportDriveTurnComplete: vi.fn() }));
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

import { executeTelegramLaneQuery, resetTelegramSessionState } from '../orchestrator';

const getWindow = () => null;


function messageStart(usage: Record<string, number>, parentToolUseId?: string) {
  return {
    type: 'stream_event',
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    event: { type: 'message_start', message: { usage } },
  };
}

function messageDelta(outputTokens: number, parentToolUseId?: string) {
  return {
    type: 'stream_event',
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    event: { type: 'message_delta', usage: { output_tokens: outputTokens } },
  };
}

function textDelta(text: string) {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  };
}

function streamQuery(messages: Array<Record<string, unknown>>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
    },
    toggleMcpServer: async () => {},
  };
}

beforeEach(() => {
  h.queryMock.mockReset();
  h.setActiveMock.mockReset();
  resetTelegramSessionState();
});

describe('claude-sdk: contador ativo por SET absoluto (contexto vivo, nao acumulado)', () => {
  it('SETA = ultima request principal (input + cacheRead + cacheCreation) + output do turno', async () => {
    h.queryMock.mockImplementation(() =>
      streamQuery([
        messageStart({ input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
        messageDelta(20),
        textDelta('parcial'),
        messageStart({ input_tokens: 500, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 }),
        messageDelta(40),
        textDelta(' final'),
      ]),
    );

    await executeTelegramLaneQuery('oi', { sessionId: 't-set', silent: true }, getWindow);

    expect(h.setActiveMock).toHaveBeenCalledTimes(1);
    expect(h.setActiveMock).toHaveBeenCalledWith('t-set', 850 + 40);
  });

  it('IGNORA requests de subagente: a ultima request PRINCIPAL forma o contexto vivo', async () => {
    h.queryMock.mockImplementation(() =>
      streamQuery([
        messageStart({ input_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
        messageDelta(30),
        textDelta('resposta'),
        messageStart(
          { input_tokens: 999999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          'tool-sub-1',
        ),
        messageDelta(88888, 'tool-sub-1'),
      ]),
    );

    await executeTelegramLaneQuery('oi', { sessionId: 't-sub', silent: true }, getWindow);

    expect(h.setActiveMock).toHaveBeenCalledWith('t-sub', 400 + 30);
  });

  it('turno SEM usage principal (edge) NAO seta (valor anterior preservado)', async () => {
    h.queryMock.mockImplementation(() => streamQuery([textDelta('so texto, sem usage')]));

    await executeTelegramLaneQuery('oi', { sessionId: 't-noedge', silent: true }, getWindow);

    expect(h.setActiveMock).not.toHaveBeenCalled();
  });

  it('turno que FALHA (throw no stream) NAO seta', async () => {
    h.queryMock.mockImplementation(() => {
      throw new Error('SDK caiu');
    });

    await expect(
      executeTelegramLaneQuery('oi', { sessionId: 't-fail', silent: true }, getWindow),
    ).rejects.toThrow('SDK caiu');

    expect(h.setActiveMock).not.toHaveBeenCalled();
  });
});
