import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const iter = (async function* () {})();
    return Object.assign(iter, { toggleMcpServer: vi.fn(async () => undefined) });
  },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

const insertMessageMock = vi.fn(() => 1);
vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => [] as unknown[]),
  getAgent: vi.fn(() => undefined),
  insertMessage: (...args: unknown[]) => insertMessageMock(...(args as [])),
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
  getAllMCPServers: vi.fn(() => []),
  getPermissionBypass: () => false,
  insertRepoGraphTurnUsage: vi.fn(),
  clearSessionPendingSeed: vi.fn(),
  getHarnessProject: vi.fn(() => null),
}));

vi.mock('../knowledge-state', () => ({ setActiveAgentId: vi.fn() }));
vi.mock('../onboarding', () => ({
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
  completeOnboardingFromPersistedProfile: vi.fn(() => false),
}));
vi.mock('../pricing', () => ({ calculateCost: () => 0 }));
vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async () => 'fake-api-key'),
  getApiKey: vi.fn(async () => null),
}));
vi.mock('../permission-guard', () => ({ createPermissionGuard: () => vi.fn(), GUARD_GATED_TOOLS: [] }));
vi.mock('../mcp-manager', () => ({ getMCPConfigForAgent: vi.fn(async () => ({})) }));
vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: vi.fn(async () => ({ allowedTools: [], systemPrompt: '', mcpServers: [], maxTurns: 0 })),
}));
vi.mock('../mcp-discovery', () => ({ getDisabledSDKMcps: () => [], getCachedSDKMcpServers: () => [] }));
vi.mock('../artifact-detector', () => ({
  captureToolUse: vi.fn(),
  captureToolResult: vi.fn(),
  resetArtifactDetector: vi.fn(),
}));
vi.mock('../prompt-builder', () => ({ buildSystemPrompt: () => '', loadGeneratedAgentContext: () => '' }));
vi.mock('../paths', () => ({
  getAgentCwd: () => '/tmp',
  getBackgroundCwd: () => '/tmp',
  getCronCwd: () => '/tmp',
  getLionClawHome: () => '/tmp',
}));
vi.mock('../codex-agents-mcp', () => ({ getCodexAgentsServer: () => undefined }));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../pipeline-shared/sdk-bootstrap', () => ({
  ensureNodeInPath: vi.fn(),
  getClaudeCodeExecutablePath: () => '/tmp/claude-cli.js',
  getClaudeSdkProcessOptions: () => ({ pathToClaudeCodeExecutable: '/tmp/claude-cli.js', executable: 'node' }),
}));
vi.mock('../title-generator', () => ({ ensureInitialSessionTitle: vi.fn(), generateSessionTitle: vi.fn() }));
vi.mock('../repo-graph/turn-context', () => ({
  getRepoGraphTurnContext: vi.fn(() => null),
  setRepoGraphTurnSession: vi.fn(),
  clearRepoGraphTurnSession: vi.fn(),
  setRepoGraphTurnContext: vi.fn(),
}));
vi.mock('../prompt-builder-repo-graph', () => ({
  appendRepoGraphSection: (p: string) => p,
  buildRepoGraphSection: () => '',
}));
vi.mock('../drive-usage-sink', () => ({ reportDriveTurnUsage: vi.fn(), reportDriveTurnComplete: vi.fn() }));

import type { OrchestratorSelection } from '../orchestrator-selection';
vi.mock('../orchestrator-selection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestrator-selection')>();
  return {
    ...actual,
    resolveOrchestratorSelection: vi.fn(async (): Promise<OrchestratorSelection> => ({
      runtime: 'claude-compat-sdk',
      provider: 'zai',
      model: 'glm-5',
      source: 'settings',
    })),
  };
});

interface ExecOptions {
  sessionId?: string;
  displayMessage?: string;
  onStreamChunk?: (chunk: { type: string; content?: string }) => void;
}
const compatExec = vi.fn<(message: string, opts: ExecOptions) => Promise<void>>();
vi.mock('../claude-compat-sdk', () => ({
  executeClaudeCompatSdkQuery: (message: string, opts: ExecOptions) => compatExec(message, opts),
  isClaudeCompatQueryActive: vi.fn(() => false),
  resetClaudeCompatSdkSessionState: vi.fn(),
  stopClaudeCompatQuery: vi.fn(),
  buildCompatEnv: vi.fn(() => ({})),
}));
vi.mock('../codex-sdk', () => ({
  executeCodexSdkQuery: vi.fn(async () => undefined),
  isCodexSdkQueryActive: vi.fn(() => false),
  resetCodexSdkSessionState: vi.fn(),
  stopCodexSdkQuery: vi.fn(),
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

import { submitMessage, getDesktopSessionExecutionState } from '../orchestrator';
import { setLaneSessionUpdatedListener } from '../lane-session-events';
import { persistUserChatMessage } from '../user-attachments-meta';

interface Observed {
  sessionId: string;
  state: 'streaming' | 'queued' | 'idle';
  userInserts: number;
}

const observed: Observed[] = [];

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout aguardando o processor'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

beforeEach(() => {
  observed.length = 0;
  insertMessageMock.mockClear();
  compatExec.mockReset();
  compatExec.mockImplementation(async (_message, opts) => {
    persistUserChatMessage(opts.sessionId!, opts.displayMessage ?? 'oi');
    opts.onStreamChunk?.({ type: 'session', content: opts.sessionId });
    opts.onStreamChunk?.({ type: 'done', content: opts.sessionId });
  });
  setLaneSessionUpdatedListener((sessionId) => {
    observed.push({
      sessionId,
      state: getDesktopSessionExecutionState(sessionId),
      userInserts: insertMessageMock.mock.calls.filter((c) => (c as unknown[])[1] === 'user').length,
    });
  });
});

describe('P2-1 (7.4): o processor do desktop notifica inicio, persistencia da mensagem humana e fim do turno', () => {
  it('um turno: streaming/0 -> streaming/1 (persistida) -> idle/1', async () => {
    submitMessage('oi', { sessionId: 'lane-a', silent: true }, () => null);
    await waitFor(() => observed.some((o) => o.state === 'idle'));
    expect(observed).toEqual([
      { sessionId: 'lane-a', state: 'streaming', userInserts: 0 },
      { sessionId: 'lane-a', state: 'streaming', userInserts: 1 },
      { sessionId: 'lane-a', state: 'idle', userInserts: 1 },
    ]);
  });

  it('dois turnos da mesma lane: o fim do primeiro reporta queued (o segundo espera na fila), o fim do segundo idle', async () => {
    submitMessage('um', { sessionId: 'lane-b', silent: true }, () => null);
    submitMessage('dois', { sessionId: 'lane-b', silent: true }, () => null);
    await waitFor(() => observed.filter((o) => o.state === 'idle').length === 1 && observed.length === 6);
    expect(observed.map((o) => [o.state, o.userInserts])).toEqual([
      ['streaming', 0],
      ['streaming', 1],
      ['queued', 1],
      ['streaming', 1],
      ['streaming', 2],
      ['idle', 2],
    ]);
  });
});
