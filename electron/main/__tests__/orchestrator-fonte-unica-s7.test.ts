
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

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => [] as unknown[]),
  getAgent: vi.fn(() => undefined),
  insertMessage: vi.fn(() => 1),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(),
  getSetting: vi.fn((key: string) => (key === 'onboarding_completed' ? undefined : undefined)),
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
}));

vi.mock('../knowledge-state', () => ({ setActiveAgentId: vi.fn() }));
vi.mock('../onboarding', () => ({
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
  completeOnboardingFromPersistedProfile: vi.fn(() => false),
}));
vi.mock('../pricing', () => ({ calculateCost: () => 0 }));

const getApiKey = vi.fn(async () => null as string | null);
vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async () => 'fake-api-key'),
  getApiKey: () => getApiKey(),
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
  getClaudeSdkProcessOptions: () => ({
    pathToClaudeCodeExecutable: '/tmp/claude-cli.js',
    executable: 'node',
  }),
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
vi.mock('../sdk-session-id', () => ({
  makeScopedSdkSessionId: (scope: string, sessionId: string) => `${scope}:${sessionId}`,
}));

let codexSendImpl: (
  prompt: string,
  cb: unknown,
  signal: AbortSignal,
) => Promise<{ status: string; threadId: string; content: string; usage: { totalTokens: number } }>;
const codexClose = vi.fn();
vi.mock('../agent-runtime/codex-session-factory', () => ({
  resolveCodexSessionForRun: vi.fn(async () => ({
    send: (prompt: string, cb: unknown, signal: AbortSignal) => codexSendImpl(prompt, cb, signal),
    close: codexClose,
  })),
}));
vi.mock('../codex-sdk/stream-translator', () => ({
  createCodexStreamTranslator: () => ({ callbacks: {}, finalize: vi.fn(), fail: vi.fn() }),
}));

import type { OrchestratorSelection } from '../orchestrator-selection';
let nextSelection: OrchestratorSelection;
vi.mock('../orchestrator-selection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestrator-selection')>();
  return {
    ...actual,
    resolveOrchestratorSelection: vi.fn(async () => nextSelection),
  };
});

type ExecutorMock = (...args: unknown[]) => Promise<undefined>;
const compatExec = vi.fn<ExecutorMock>(async () => undefined);
vi.mock('../claude-compat-sdk', () => ({
  executeClaudeCompatSdkQuery: (...args: unknown[]) => compatExec(...args),
  isClaudeCompatQueryActive: vi.fn(() => false),
  resetClaudeCompatSdkSessionState: vi.fn(),
  stopClaudeCompatQuery: vi.fn(),
  buildCompatEnv: vi.fn(() => ({})),
}));
const codexExec = vi.fn<ExecutorMock>(async () => undefined);
vi.mock('../codex-sdk', () => ({
  executeCodexSdkQuery: (...args: unknown[]) => codexExec(...args),
  isCodexSdkQueryActive: vi.fn(() => false),
  resetCodexSdkSessionState: vi.fn(),
  stopCodexSdkQuery: vi.fn(),
}));
const kimiExec = vi.fn<ExecutorMock>(async () => undefined);
vi.mock('../kimi-sdk', () => ({
  executeKimiSdkQuery: (...args: unknown[]) => kimiExec(...args),
  isKimiSdkQueryActive: vi.fn(() => false),
  resetKimiSdkSessionState: vi.fn(),
  stopKimiSdkQuery: vi.fn(),
}));
const lionExec = vi.fn<ExecutorMock>(async () => undefined);
vi.mock('../lion-sdk', () => ({
  executeLionSdkQuery: (...args: unknown[]) => lionExec(...args),
  isLionSdkQueryActive: vi.fn(() => false),
  resetLionSdkSessionState: vi.fn(),
  stopLionSdkQuery: vi.fn(),
}));

import { executeQuery, type QueryOptions } from '../orchestrator';
import { telegramLane, cronLane, type SdkLane } from '../sdk-lane';

const noopGetWindow = () => null;

const SELECTIONS = {
  'claude-sdk': { runtime: 'claude-sdk', provider: 'anthropic', model: 'model-a', source: 'settings' },
  'claude-compat-sdk': { runtime: 'claude-compat-sdk', provider: 'zai', model: 'model-b', source: 'settings' },
  'codex-sdk': { runtime: 'codex-sdk', provider: 'codex', model: 'model-c', source: 'settings' },
  'kimi-sdk': { runtime: 'kimi-sdk', provider: 'kimi', model: 'model-d', source: 'settings' },
  'lion-sdk': { runtime: 'lion-sdk', provider: 'ollama', model: 'model-e', source: 'settings' },
} satisfies Record<
  'claude-sdk' | 'claude-compat-sdk' | 'codex-sdk' | 'kimi-sdk' | 'lion-sdk',
  OrchestratorSelection
>;

function options(overrides: Partial<QueryOptions> = {}): QueryOptions {
  return { sessionId: 'sess-int', silent: true, _forceNewSession: false, ...overrides };
}

const SUB_SDK_SPIES = {
  'claude-compat-sdk': compatExec,
  'codex-sdk': codexExec,
  'kimi-sdk': kimiExec,
  'lion-sdk': lionExec,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  getApiKey.mockResolvedValue(null);
  codexSendImpl = async () => ({ status: 'completed', threadId: 'thread-1', content: 'ok', usage: { totalTokens: 1 } });
});


describe('AC-1/AC-10: cada runtime configurado despacha para SEU executor na lane (telegram e cron)', () => {
  const runtimes = Object.keys(SELECTIONS) as Array<keyof typeof SELECTIONS>;

  for (const lane of [telegramLane, cronLane] as SdkLane[]) {
    for (const runtime of runtimes) {
      it(`runtime ${runtime} na lane ${lane.name} chama so o executor de ${runtime} com a lane e a selection`, async () => {
        nextSelection = SELECTIONS[runtime];

        await executeQuery('turno de integracao', options(), noopGetWindow, lane);

        if (runtime === 'claude-sdk') {
          expect(getApiKey).toHaveBeenCalledTimes(1);
        } else {
          const spy = SUB_SDK_SPIES[runtime];
          expect(spy).toHaveBeenCalledTimes(1);
          const [, , , passedLane, passedSelection] = spy.mock.calls[0] as unknown[];
          expect(passedLane).toBe(lane);
          expect(passedSelection).toEqual(SELECTIONS[runtime]);
          expect((passedSelection as OrchestratorSelection).source).toBe('settings');
          expect(getApiKey).not.toHaveBeenCalled();
        }

        for (const other of runtimes) {
          if (other === runtime || other === 'claude-sdk') continue;
          expect(SUB_SDK_SPIES[other]).not.toHaveBeenCalled();
        }
      });
    }
  }
});
