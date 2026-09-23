import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../db', () => ({
  createSession: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getSession: vi.fn(() => undefined),
  clearSessionPendingSeed: vi.fn(),
  updateSessionTokens: vi.fn(),
  getSessionMessages: vi.fn(() => []),
  getSetting: vi.fn((key: string) => (key === 'onboarding_completed' ? 'true' : null)),
  getTurnIndexForUserMessage: vi.fn(() => 1),
  getLatestUserTurnIndex: vi.fn(() => 1),
  insertAuditEntry: vi.fn(),
  insertMessage: vi.fn(() => 1),
  getAllMCPServers: vi.fn(() => []),
  getPermissionBypass: () => false,
  insertRepoGraphTurnUsage: vi.fn(),
}));

const h = vi.hoisted(() => ({
  calls: [] as string[],
  factoryCalls: 0,
}));

vi.mock('../agent-runtime/codex-session-factory', () => ({
  resolveCodexSessionForRun: vi.fn(async () => {
    h.factoryCalls += 1;
    const response = () => ({
      status: 'completed',
      threadId: 'thread-1',
      content: 'resposta',
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, totalTokens: 15 },
    });
    return {
      threadId: 'thread-1',
      send: vi.fn(async () => {
        h.calls.push('send');
        return response();
      }),
      reply: vi.fn(async () => {
        h.calls.push('reply');
        return response();
      }),
      setModel: vi.fn((model: string) => {
        h.calls.push(`setModel:${model}`);
      }),
      setReasoningEffort: vi.fn((effort: string) => {
        h.calls.push(`setReasoningEffort:${effort}`);
      }),
      isClosed: () => false,
      close: vi.fn(),
    };
  }),
}));

vi.mock('../prompt-builder', () => ({
  buildSystemPrompt: () => 'LION-PROMPT',
  loadGeneratedAgentContext: () => '',
}));
vi.mock('../paths', () => ({
  getAgentCwd: () => '/lionclaw/agents-home',
  getBackgroundCwd: () => '/lionclaw/agents-home',
  getLionClawHome: () => '/lionclaw',
}));
vi.mock('../codex-sdk/stream-translator', () => ({
  createCodexStreamTranslator: () => ({ callbacks: {}, finalize: vi.fn(), fail: vi.fn(), timelineEvents: () => [] }),
}));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../onboarding', () => ({
  completeOnboardingFromPersistedProfile: vi.fn(),
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
}));
vi.mock('../repo-graph/turn-context', () => ({
  getRepoGraphTurnContext: vi.fn(() => null),
}));
vi.mock('../title-generator', () => ({
  ensureInitialSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(),
}));
vi.mock('../chat-compaction-trigger', () => ({
  maybeCompactChatSession: vi.fn(async () => undefined),
  isChatTimelineReinjectEnabled: () => false,
}));

import { executeCodexSdkQuery, resetCodexSdkSessionState } from '../codex-sdk';
import type { OrchestratorSelection } from '../orchestrator-selection';

function selection(model: string, effort: string): OrchestratorSelection {
  return {
    runtime: 'codex-sdk',
    provider: 'codex',
    model,
    effort,
    source: 'session',
  } as unknown as OrchestratorSelection;
}

const getWindow = () => null;

beforeEach(() => {
  resetCodexSdkSessionState();
  h.calls.length = 0;
  h.factoryCalls = 0;
});

describe('7.5 (AC-10 lado main): modelo e effort da lane aplicados por turno na thread Codex viva', () => {
  it('reuse da thread: setReasoningEffort e setModel(selection.model) ANTES de cada reply, sem recriar a thread', async () => {
    await executeCodexSdkQuery(
      'turno 1',
      { sessionId: 'lane-codex' },
      getWindow,
      undefined,
      selection('gpt-5.4', 'medium'),
    );
    expect(h.factoryCalls).toBe(1);
    expect(h.calls).toEqual(['send']);

    h.calls.length = 0;
    await executeCodexSdkQuery(
      'turno 2',
      { sessionId: 'lane-codex' },
      getWindow,
      undefined,
      selection('gpt-5.5', 'high'),
    );
    expect(h.factoryCalls).toBe(1);
    expect(h.calls).toEqual(['setReasoningEffort:high', 'setModel:gpt-5.5', 'reply']);

    h.calls.length = 0;
    await executeCodexSdkQuery(
      'turno 3',
      { sessionId: 'lane-codex' },
      getWindow,
      undefined,
      selection('gpt-5.4-mini', 'low'),
    );
    expect(h.factoryCalls).toBe(1);
    expect(h.calls).toEqual(['setReasoningEffort:low', 'setModel:gpt-5.4-mini', 'reply']);
  });
});
