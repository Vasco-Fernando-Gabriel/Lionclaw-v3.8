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

interface FakeSession {
  threadId: string;
  send: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  setReasoningEffort: ReturnType<typeof vi.fn>;
  isClosed: () => boolean;
  close: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  pending: new Map<string, () => void>(),
  nextSessionId: null as string | null,
}));

vi.mock('../agent-runtime/codex-session-factory', () => ({
  resolveCodexSessionForRun: vi.fn(async () => {
    const id = h.nextSessionId ?? 'unknown';
    const response = () => ({
      status: 'completed',
      threadId: `thread-${id}`,
      content: 'resposta',
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, totalTokens: 15 },
    });
    const wait = () =>
      new Promise<ReturnType<typeof response>>((resolve) => {
        h.pending.set(id, () => resolve(response()));
      });
    const session = {
      threadId: `thread-${id}`,
      send: vi.fn(async () => wait()),
      reply: vi.fn(async () => wait()),
      setModel: vi.fn(),
      setReasoningEffort: vi.fn(),
      isClosed: () => false,
      close: vi.fn(),
    };
    h.sessions.set(id, session);
    return session;
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

import {
  executeCodexSdkQuery,
  resetCodexSdkSessionState,
  closeIdleCachedChatCodexSessions,
  closeAllCachedChatCodexSessions,
} from '../codex-sdk';
import { resetDesktopLanesForTests } from '../desktop-lanes';
import type { OrchestratorSelection } from '../orchestrator-selection';

const selection: OrchestratorSelection = {
  runtime: 'codex-sdk',
  provider: 'codex',
  model: 'gpt-5.5',
  effort: 'medium',
  source: 'session',
} as unknown as OrchestratorSelection;

const getWindow = () => null;

function session(id: string): FakeSession {
  return h.sessions.get(id) as FakeSession;
}

function startTurn(id: string): Promise<void> {
  h.nextSessionId = id;
  return executeCodexSdkQuery('oi', { sessionId: id }, getWindow, undefined, selection);
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

beforeEach(() => {
  resetCodexSdkSessionState();
  resetDesktopLanesForTests();
  h.sessions.clear();
  h.pending.clear();
  h.nextSessionId = null;
});

describe('RM1 (P2-3): closeIdleCachedChatCodexSessions preserva a thread com turno em voo', () => {
  it('fecha so a thread OCIOSA; a lane em voo segue com a mesma thread e responde depois', async () => {
    const idleTurn = startTurn('lane-idle');
    await waitFor(() => h.pending.has('lane-idle'));
    h.pending.get('lane-idle')!();
    await idleTurn;

    const busyTurn = startTurn('lane-busy');
    await waitFor(() => h.pending.has('lane-busy'));

    const closed = closeIdleCachedChatCodexSessions('resume-after-auth');
    expect(closed).toEqual(['lane-idle']);
    expect(session('lane-idle').close).toHaveBeenCalledTimes(1);
    expect(session('lane-busy').close).not.toHaveBeenCalled();

    h.pending.get('lane-busy')!();
    await busyTurn;
    expect(session('lane-busy').close).not.toHaveBeenCalled();

    expect(closeIdleCachedChatCodexSessions('resume-after-auth')).toEqual(['lane-busy']);
    expect(session('lane-busy').close).toHaveBeenCalledTimes(1);
  });

  it('closeAllCachedChatCodexSessions (shutdown / factory reset) continua fechando tudo, inclusive em voo', async () => {
    const busyTurn = startTurn('lane-busy');
    await waitFor(() => h.pending.has('lane-busy'));

    closeAllCachedChatCodexSessions('app-shutdown');
    expect(session('lane-busy').close).toHaveBeenCalledTimes(1);

    h.pending.get('lane-busy')!();
    await busyTurn;
  });
});
