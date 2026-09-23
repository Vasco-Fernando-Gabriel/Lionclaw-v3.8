import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const iter = (async function* () {})();
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
  rootLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('../db', () => ({
  threadIdOf: (s: { id: string; sdkSessionId?: string | null }) => s.sdkSessionId ?? s.id,
  getSessionOrchestrator: () => null,
  getAllAgents: vi.fn(() => [] as unknown[]),
  getAgent: vi.fn(() => undefined),
  insertMessage: vi.fn(() => 1),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(),
  clearSessionPendingSeed: vi.fn(),
  getSetting: vi.fn((key: string) => (key === 'onboarding_completed' ? 'true' : undefined)),
  updateSessionTokens: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
  setSessionAgenticContextTokens: vi.fn(),
  resetSessionAgenticContext: vi.fn(),
  getSessionMessagesAfterFence: vi.fn(() => []),
  getActiveChatSession: vi.fn(() => ({ id: 'desktop-active' })),
  getSession: vi.fn(() => null),
  getEnabledTools: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  insertTaskExecution: vi.fn(),
  getTurnIndexForUserMessage: vi.fn(() => 0),
  getLatestUserTurnIndex: vi.fn(() => 0),
  getAllMCPServers: vi.fn(() => []),
  getPermissionBypass: () => false,
  insertRepoGraphTurnUsage: vi.fn(),
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
  getApiKey: vi.fn(async () => 'fake-api-key'),
}));
vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => vi.fn(),
  GUARD_GATED_TOOLS: [],
}));
vi.mock('../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async () => ({})),
  getMcpToolRegistryEntries: vi.fn(() => []),
}));
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
vi.mock('../prompt-builder', () => ({
  buildSystemPrompt: () => '',
  loadGeneratedAgentContext: () => '',
}));
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
  getClaudeSdkProcessOptions: vi.fn(() => ({
    pathToClaudeCodeExecutable: '/tmp/claude-cli.js',
    executable: 'node',
  })),
}));
vi.mock('../title-generator', () => ({
  ensureInitialSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(),
}));
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
  signal: AbortSignal,
) => Promise<{ status: string; threadId: string; content: string; usage: { totalTokens: number } }>;
const codexClose = vi.fn();
vi.mock('../agent-runtime/codex-session-factory', () => ({
  resolveCodexSessionForRun: vi.fn(async () => ({
    send: (prompt: string, _cb: unknown, signal: AbortSignal) => codexSendImpl(prompt, signal),
    close: codexClose,
  })),
}));
vi.mock('../codex-sdk/stream-translator', () => ({
  createCodexStreamTranslator: () => ({ callbacks: {}, finalize: vi.fn(), fail: vi.fn(), timelineEvents: () => [] }),
}));

import { executeClaudeCompatSdkQuery, stopClaudeCompatQuery, isClaudeCompatQueryActive } from '../claude-compat-sdk';
import { executeCodexSdkQuery, stopCodexSdkQuery, isCodexSdkQueryActive } from '../codex-sdk';
import { stopCurrentQuery, stopTelegramQuery } from '../orchestrator';
import { type SdkLane } from '../sdk-lane';
import { getDesktopLane } from '../desktop-lanes';

const desktopLane = getDesktopLane('sess-1');
import type { OrchestratorSelection } from '../orchestrator-selection';
import type { QueryOptions } from '../orchestrator';

const noopGetWindow = () => null;

function makeLane(name: string): SdkLane {
  return {
    name,
    kind: name === 'telegram' ? 'telegram' : name === 'cron' ? 'cron' : 'desktop',
    sdkActiveSessionId: null,
    currentAbortController: null,
  };
}

function compatSelection(overrides: Partial<OrchestratorSelection> = {}): OrchestratorSelection {
  return {
    runtime: 'claude-compat-sdk',
    provider: 'zai',
    model: 'glm-4.7',
    source: 'settings',
    apiKey: 'fake-api-key',
    ...overrides,
  };
}

function compatOptions(overrides: Partial<QueryOptions> = {}): QueryOptions {
  return { sessionId: 'sess-1', silent: true, _forceNewSession: false, ...overrides };
}

function codexSelection(): OrchestratorSelection {
  return { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-5.5', source: 'settings' };
}

beforeEach(() => {
  vi.clearAllMocks();
  codexSendImpl = async () => ({
    status: 'completed',
    threadId: 'thread-1',
    content: 'ok',
    usage: { totalTokens: 1 },
  });
});

describe('abort por lane (SPEC 3.1): stop escopado nao vaza entre lanes', () => {
  it('stopClaudeCompatQuery(desktop) NAO aborta o turno do telegram (compat)', () => {
    const desktop = makeLane('desktop');
    const telegram = makeLane('telegram');
    desktop.currentAbortController = new AbortController();
    telegram.currentAbortController = new AbortController();
    const telegramSignal = telegram.currentAbortController.signal;

    stopClaudeCompatQuery(desktop);

    expect(isClaudeCompatQueryActive(desktop)).toBe(false);
    expect(isClaudeCompatQueryActive(telegram)).toBe(true);
    expect(telegramSignal.aborted).toBe(false);
  });

  it('stopClaudeCompatQuery(telegram) NAO aborta o turno do desktop (compat)', () => {
    const desktop = makeLane('desktop');
    const telegram = makeLane('telegram');
    desktop.currentAbortController = new AbortController();
    telegram.currentAbortController = new AbortController();
    const desktopSignal = desktop.currentAbortController.signal;

    stopClaudeCompatQuery(telegram);

    expect(isClaudeCompatQueryActive(telegram)).toBe(false);
    expect(isClaudeCompatQueryActive(desktop)).toBe(true);
    expect(desktopSignal.aborted).toBe(false);
  });

  it('stopCodexSdkQuery(desktop) NAO aborta o turno do telegram (codex)', () => {
    const desktop = makeLane('desktop');
    const telegram = makeLane('telegram');
    desktop.currentAbortController = new AbortController();
    telegram.currentAbortController = new AbortController();
    const telegramSignal = telegram.currentAbortController.signal;

    stopCodexSdkQuery(desktop);

    expect(isCodexSdkQueryActive(desktop)).toBe(false);
    expect(isCodexSdkQueryActive(telegram)).toBe(true);
    expect(telegramSignal.aborted).toBe(false);
  });

  it('turno codex EM VOO na telegram lane sobrevive a um stop do desktop e para so no stop da telegram', async () => {
    codexSendImpl = (_prompt, signal) =>
      new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });

    const telegram = makeLane('telegram');
    const run = executeCodexSdkQuery(
      'turno longo do telegram',
      { sessionId: 't-abort', silent: true },
      noopGetWindow,
      telegram,
      codexSelection(),
    ).catch(() => {});

    await new Promise((r) => setImmediate(r));
    expect(isCodexSdkQueryActive(telegram)).toBe(true);

    stopCodexSdkQuery(makeLane('desktop'));
    expect(isCodexSdkQueryActive(telegram)).toBe(true);

    stopCodexSdkQuery(telegram);
    await run;
    expect(isCodexSdkQueryActive(telegram)).toBe(false);
  });
});

describe('guard de sessionId (SPEC 3.3): fora do desktop, options.sessionId e obrigatorio', () => {
  it('compat na telegram lane SEM sessionId lanca erro claro (nunca cai em getActiveChatSession)', async () => {
    const telegram = makeLane('telegram');
    await expect(
      executeClaudeCompatSdkQuery(
        'oi',
        compatOptions({ sessionId: undefined }),
        noopGetWindow,
        telegram,
        compatSelection(),
      ),
    ).rejects.toThrow(/telegram.*sessionId explicito|guard de sessao/i);
  });

  it('compat na desktop lane SEM sessionId lanca session_required (lanes RM2: fallback removido)', async () => {
    desktopLane.sdkActiveSessionId = null;
    await expect(
      executeClaudeCompatSdkQuery(
        'oi',
        compatOptions({ sessionId: undefined }),
        noopGetWindow,
        desktopLane,
        compatSelection(),
      ),
    ).rejects.toThrow(/desktop.*sessionId explicito|guard de sessao/i);
    expect(desktopLane.sdkActiveSessionId).toBeNull();
    desktopLane.sdkActiveSessionId = null;
  });

  it('codex na cron lane SEM sessionId lanca erro claro (nunca cai em getActiveChatSession)', async () => {
    const cron = makeLane('cron');
    await expect(
      executeCodexSdkQuery('oi', { sessionId: undefined, silent: true }, noopGetWindow, cron, codexSelection()),
    ).rejects.toThrow(/cron.*sessionId explicito|guard de sessao/i);
  });
});

describe('thread do compat por lane (SPEC 3.2): mesmo provider, lanes distintas nao clobbam', () => {
  it('desktop e telegram no MESMO provider produzem sdkActiveSessionId distintos', async () => {
    const desktop = makeLane('desktop');
    const telegram = makeLane('telegram');

    await executeClaudeCompatSdkQuery(
      'oi desktop',
      compatOptions({ sessionId: 'shared-sess' }),
      noopGetWindow,
      desktop,
      compatSelection(),
    );
    await executeClaudeCompatSdkQuery(
      'oi telegram',
      compatOptions({ sessionId: 'shared-sess' }),
      noopGetWindow,
      telegram,
      compatSelection(),
    );

    expect(desktop.sdkActiveSessionId).not.toBeNull();
    expect(telegram.sdkActiveSessionId).not.toBeNull();
    expect(desktop.sdkActiveSessionId).toContain(':desktop:');
    expect(telegram.sdkActiveSessionId).toContain(':telegram:');
    expect(desktop.sdkActiveSessionId).not.toBe(telegram.sdkActiveSessionId);
  });
});

describe('stopCurrentQuery/stopTelegramQuery abortam SO a propria lane', () => {
  it('as APIs de stop existem e sao chamaveis sem lancar (smoke de escopo)', () => {
    expect(() => stopCurrentQuery()).not.toThrow();
    expect(() => stopTelegramQuery()).not.toThrow();
  });
});
