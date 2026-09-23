import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StreamChunk } from '../../../src/types';

const h = {
  queryMock: vi.fn(),
  sendMock: vi.fn(),
  model: 'claude-opus-4-8',
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
    model: h.model,
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
  threadIdOf: (s: { id: string; sdkSessionId?: string | null }) => s.sdkSessionId ?? s.id,
  getSessionOrchestrator: () => null,
  getAllAgents: () => [],
  getAgent: () => undefined,
  insertMessage: vi.fn(() => 1),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(),
  getSetting: vi.fn(() => undefined),
  updateSessionTokens: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
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
import type { BrowserWindow } from 'electron';

const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, chunk: StreamChunk) => h.sendMock(channel, chunk) },
} as unknown as BrowserWindow;
const getWindow = () => fakeWindow;

function sentContextUsageChunks(): StreamChunk[] {
  return h.sendMock.mock.calls
    .filter(([channel]) => channel === 'chat:stream')
    .map(([, chunk]) => chunk as StreamChunk)
    .filter((c) => c.type === 'context_usage');
}

function messageStart(usage: Record<string, number>) {
  return { type: 'stream_event', event: { type: 'message_start', message: { usage } } };
}
function messageDelta(outputTokens: number) {
  return { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: outputTokens } } };
}
function textDelta(text: string) {
  return { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } };
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
  h.sendMock.mockReset();
  h.model = 'claude-opus-4-8';
  resetTelegramSessionState();
});

describe('SA-2: contextUsage no path cloud (query() direto, D6)', () => {
  it('AC-A3: turno com usage principal emite context_usage = contexto vivo / janela do resolver', async () => {
    h.queryMock.mockImplementation(() =>
      streamQuery([
        messageStart({ input_tokens: 500, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 }),
        messageDelta(40),
        textDelta('resposta'),
      ]),
    );

    await executeTelegramLaneQuery('oi', { sessionId: 'sa2-a3', silent: false }, getWindow);

    const chunks = sentContextUsageChunks();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.contextUsage).toEqual({
      contextTokens: 850 + 40,
      contextWindowTokens: 1_000_000,
      compactionThresholdPercent: 80,
      source: 'provider',
    });
  });

  it('AC-A4: modelo DESCONHECIDO do resolver -> sem chunk context_usage (D5) e sem crash', async () => {
    h.model = 'modelo-misterioso-9000';
    h.queryMock.mockImplementation(() =>
      streamQuery([
        messageStart({ input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
        messageDelta(40),
        textDelta('resposta'),
      ]),
    );

    await expect(
      executeTelegramLaneQuery('oi', { sessionId: 'sa2-a4', silent: false }, getWindow),
    ).resolves.toBeUndefined();

    expect(sentContextUsageChunks()).toHaveLength(0);
    const errorChunks = h.sendMock.mock.calls
      .filter(([channel]) => channel === 'chat:stream')
      .map(([, chunk]) => chunk as StreamChunk)
      .filter((c) => c.type === 'error');
    expect(errorChunks).toHaveLength(0);
  });

  it('AC-A4/edge: turno SEM usage principal nao emite context_usage (contador tambem nao seta)', async () => {
    h.queryMock.mockImplementation(() => streamQuery([textDelta('so texto, sem usage')]));

    await executeTelegramLaneQuery('oi', { sessionId: 'sa2-edge', silent: false }, getWindow);

    expect(sentContextUsageChunks()).toHaveLength(0);
  });
});
