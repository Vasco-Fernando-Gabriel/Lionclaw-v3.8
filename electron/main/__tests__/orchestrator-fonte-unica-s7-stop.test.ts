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
  getSetting: vi.fn(() => undefined),
  updateSessionTokens: vi.fn(),
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
  clearSessionPendingSeed: vi.fn(),
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
vi.mock('../agent-runtime/codex-session-factory', () => ({
  resolveCodexSessionForRun: vi.fn(async () => ({
    send: (prompt: string, cb: unknown, signal: AbortSignal) => codexSendImpl(prompt, cb, signal),
    close: vi.fn(),
  })),
}));
vi.mock('../codex-sdk/stream-translator', () => ({
  createCodexStreamTranslator: () => ({ callbacks: {}, finalize: vi.fn(), fail: vi.fn(), timelineEvents: () => [] }),
}));

import { isClaudeCompatQueryActive } from '../claude-compat-sdk';
import { executeCodexSdkQuery, isCodexSdkQueryActive } from '../codex-sdk';
import { stopCurrentQuery } from '../orchestrator';
import { telegramLane, type SdkLane } from '../sdk-lane';
import { getDesktopLane } from '../desktop-lanes';

const desktopLane = getDesktopLane('d-codex');
import type { OrchestratorSelection } from '../orchestrator-selection';
import { CodexAuthError } from '../codex-runtime/errors';

const noopGetWindow = () => null;

function codexSelection(): OrchestratorSelection {
  return { runtime: 'codex-sdk', provider: 'codex', model: 'model-c', source: 'settings' };
}

beforeEach(() => {
  vi.clearAllMocks();
  desktopLane.currentAbortController = null;
  desktopLane.sdkActiveSessionId = null;
  telegramLane.currentAbortController = null;
  telegramLane.sdkActiveSessionId = null;
  codexSendImpl = async () => ({ status: 'completed', threadId: 'thread-1', content: 'ok', usage: { totalTokens: 1 } });
});

describe('AC-7/AC-15: stopCurrentQuery (desktop) nao mata turno em voo do telegram', () => {
  it('Codex owner converte auth propagada no motivo do abort em erro tipado de chat', async () => {
    codexSendImpl = (_prompt, _callbacks, signal) =>
      new Promise((resolve) => {
        const cancelled = () =>
          resolve({
            status: 'cancelled',
            threadId: 'thread-auth',
            content: '',
            usage: { totalTokens: 0 },
          });
        if (signal.aborted) return cancelled();
        signal.addEventListener('abort', cancelled, { once: true });
      });
    const chunks: Array<Record<string, unknown>> = [];
    const run = executeCodexSdkQuery(
      'turno com subagente',
      {
        sessionId: 't-codex-auth',
        silent: true,
        onStreamChunk: (chunk) => chunks.push(chunk as unknown as Record<string, unknown>),
      },
      noopGetWindow,
      telegramLane,
      codexSelection(),
    );

    await new Promise((resolve) => setImmediate(resolve));
    telegramLane.currentAbortController?.abort(new CodexAuthError('login Codex necessario'));
    await run;

    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'error',
        code: 'SUBAGENT_AUTH_REQUIRED',
        authProvider: 'codex',
        error: 'login Codex necessario',
      }),
    );
  });

  it('codex: turno em voo na telegram lane sobrevive ao stopCurrentQuery do desktop', async () => {
    codexSendImpl = (_p, _cb, signal) =>
      new Promise((_resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });

    const run = executeCodexSdkQuery(
      'turno longo telegram',
      { sessionId: 't-codex', silent: true },
      noopGetWindow,
      telegramLane,
      codexSelection(),
    ).catch(() => undefined);

    await new Promise((r) => setImmediate(r));
    expect(isCodexSdkQueryActive(telegramLane)).toBe(true);

    stopCurrentQuery();
    expect(isCodexSdkQueryActive(telegramLane)).toBe(true);

    telegramLane.currentAbortController?.abort();
    await run;
  });

  it('compat: turno em voo na telegram lane sobrevive ao stopCurrentQuery do desktop', () => {
    telegramLane.currentAbortController = new AbortController();
    const telegramSignal = telegramLane.currentAbortController.signal;
    telegramLane.sdkActiveSessionId = 'compat:zai:telegram:shared';

    expect(isClaudeCompatQueryActive(telegramLane)).toBe(true);

    stopCurrentQuery();
    expect(isClaudeCompatQueryActive(telegramLane)).toBe(true);
    expect(telegramSignal.aborted).toBe(false);
  });

  it('vice-versa: abortar a telegram lane nao mata o turno em voo do desktop (codex)', async () => {
    codexSendImpl = (_p, _cb, signal) =>
      new Promise((_resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const liveDesktopLane = getDesktopLane('d-codex');
    const desktopRun = executeCodexSdkQuery(
      'turno desktop',
      { sessionId: 'd-codex', silent: true },
      noopGetWindow,
      liveDesktopLane,
      codexSelection(),
    ).catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    expect(isCodexSdkQueryActive(liveDesktopLane)).toBe(true);

    const telegram: SdkLane = telegramLane;
    telegram.currentAbortController = new AbortController();
    telegram.currentAbortController.abort();
    expect(isCodexSdkQueryActive(liveDesktopLane)).toBe(true);

    stopCurrentQuery();
    await desktopRun;
    expect(isCodexSdkQueryActive(liveDesktopLane)).toBe(false);
  });
});

describe('RM9/V4 (codex): duas lanes desktop em voo com threads e cache por sessao', () => {
  it('stop de A aborta so A; B segue; closeCachedChatCodexSession fecha so a thread daquela sessao', async () => {
    const { resolveCodexSessionForRun } = await import('../agent-runtime/codex-session-factory');
    const { closeCachedChatCodexSession } = await import('../codex-sdk');
    const factory = vi.mocked(resolveCodexSessionForRun);
    factory.mockClear();
    const laneA = getDesktopLane('d-codex-a');
    const laneB = getDesktopLane('d-codex-b');
    const releases: Array<() => void> = [];
    codexSendImpl = (_prompt, _cb, signal) =>
      new Promise((resolve, reject) => {
        releases.push(() =>
          resolve({ status: 'completed', threadId: 'thread-x', content: 'ok', usage: { totalTokens: 1 } }),
        );
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });

    const runA = executeCodexSdkQuery(
      'turno A',
      { sessionId: 'd-codex-a', silent: true },
      noopGetWindow,
      laneA,
      codexSelection(),
    ).catch(() => undefined);
    const runB = executeCodexSdkQuery(
      'turno B',
      { sessionId: 'd-codex-b', silent: true },
      noopGetWindow,
      laneB,
      codexSelection(),
    ).catch(() => undefined);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(isCodexSdkQueryActive(laneA)).toBe(true);
    expect(isCodexSdkQueryActive(laneB)).toBe(true);
    expect(factory).toHaveBeenCalledTimes(2);

    stopCurrentQuery('d-codex-a');
    await runA;
    expect(isCodexSdkQueryActive(laneA)).toBe(false);
    expect(isCodexSdkQueryActive(laneB)).toBe(true);

    releases[1]!();
    await runB;
    expect(isCodexSdkQueryActive(laneB)).toBe(false);

    const sessions = await Promise.all(
      factory.mock.results.map((r) => r.value as Promise<{ close: ReturnType<typeof vi.fn> }>),
    );
    expect(sessions).toHaveLength(2);
    closeCachedChatCodexSession('d-codex-a', 'teste');
    expect(sessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(sessions[1]!.close).not.toHaveBeenCalled();
    closeCachedChatCodexSession('d-codex-b', 'teste');
    expect(sessions[1]!.close).toHaveBeenCalledTimes(1);
  });
});
