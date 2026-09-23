import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { CliAgenticResponse, CliStreamCallbacks } from '../../agent-runtime/cli-agentic/contract';
import type { OrchestratorSelection } from '../../orchestrator-selection';
import type { QueryOptions } from '../../orchestrator';

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const insertMessage = vi.fn(
  (
    _sessionId: string,
    _role: 'user' | 'assistant' | 'system',
    _content: string,
    _subagent?: string,
    _metadata?: string,
  ): number => 1,
);
const insertAuditEntry = vi.fn((_entry: Record<string, unknown>): void => {});
const getActiveChatSession = vi.fn((): { id: string } | null => null);
const createSession = vi.fn((_id: string, _title: string): void => {});
const getSessionMessages = vi.fn((): unknown[] => []);
const getSetting = vi.fn((key: string): string | undefined => (key === 'onboarding_completed' ? 'true' : undefined));
const getTurnIndexForUserMessage = vi.fn((): number => 1);
const getLatestUserTurnIndex = vi.fn((): number => 0);
const getSession = vi.fn((_id: string): { id: string; title: string | null; type: string } | null => null);
const ensureInitialSessionTitle = vi.fn((_sessionId: string, _message: string): void => {});
const generateSessionTitle = vi.fn(async (_sessionId: string): Promise<void> => {});

vi.mock('../../db', () => ({
  getPermissionBypass: vi.fn(() => false),
  insertMessage: (
    sessionId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    subagent?: string,
    metadata?: string,
  ) => insertMessage(sessionId, role, content, subagent, metadata),
  insertAuditEntry: (entry: Record<string, unknown>) => insertAuditEntry(entry),
  getActiveChatSession: () => getActiveChatSession(),
  createSession: (id: string, title: string) => createSession(id, title),
  getSessionMessages: () => getSessionMessages(),
  getSetting: (key: string) => getSetting(key),
  getTurnIndexForUserMessage: () => getTurnIndexForUserMessage(),
  getLatestUserTurnIndex: () => getLatestUserTurnIndex(),
  getSession: (id: string) => getSession(id),
  upsertActivityLog: vi.fn(),
}));

vi.mock('../../title-generator', () => ({
  ensureInitialSessionTitle: (sessionId: string, message: string) => ensureInitialSessionTitle(sessionId, message),
  generateSessionTitle: (sessionId: string) => generateSessionTitle(sessionId),
}));

vi.mock('../../artifact-detector', () => ({
  captureToolUse: vi.fn(() => null),
  captureToolResult: vi.fn(() => null),
}));

const recordCompletedMainChatTurn = vi.fn();
vi.mock('../../dreaming-turn-engine', () => ({
  recordCompletedMainChatTurn: () => recordCompletedMainChatTurn(),
}));

vi.mock('../../onboarding', () => ({
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
  completeOnboardingFromPersistedProfile: vi.fn(() => false),
}));

let sessionSendImpl: (prompt: string, cb: CliStreamCallbacks, signal: AbortSignal) => Promise<CliAgenticResponse>;
const sessionClose = vi.fn(async () => {});
const createChatKimiSession = vi.fn(async () => ({
  send: (prompt: string, cb: CliStreamCallbacks, signal: AbortSignal) => sessionSendImpl(prompt, cb, signal),
  close: sessionClose,
}));

vi.mock('../session', () => ({
  createChatKimiSession: () => createChatKimiSession(),
}));

function makeSelection(): OrchestratorSelection {
  return {
    runtime: 'kimi-sdk',
    provider: 'kimi',
    model: 'kimi-code/kimi-for-coding',
    source: 'settings',
  };
}

function makeOptions(overrides?: Partial<QueryOptions>): QueryOptions {
  return { sessionId: 'sess-rt', ...overrides };
}

function collectStream(): {
  getWindow: () => BrowserWindow | null;
  chunks: Array<{ type: string; content?: string; sessionId?: string }>;
} {
  const chunks: Array<{ type: string; content?: string; sessionId?: string }> = [];
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        if (channel === 'chat:stream') {
          chunks.push(payload as { type: string; content?: string });
        }
      },
    },
  } as unknown as BrowserWindow;
  return { getWindow: () => fakeWindow, chunks };
}

beforeEach(() => {
  vi.clearAllMocks();
  getActiveChatSession.mockReturnValue(null);
  getSessionMessages.mockReturnValue([]);
  getSetting.mockImplementation((key: string) => (key === 'onboarding_completed' ? 'true' : undefined));
  getTurnIndexForUserMessage.mockReturnValue(1);
  getSession.mockReturnValue(null);
});

describe('kimi-sdk chat round-trip (mocked)', () => {
  it('sets an initial title and generates the AI title on the first turn', async () => {
    sessionSendImpl = async (_prompt, cb) => {
      cb.onText?.('resposta');
      return {
        content: 'resposta',
        usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
        toolUses: 0,
        status: 'finished',
      };
    };
    getSession.mockReturnValue({ id: 'sess-rt', title: null, type: 'chat' });
    getSessionMessages.mockReturnValue([
      { role: 'user', content: 'explica o repo' },
      { role: 'assistant', content: 'resposta' },
    ]);

    const { executeKimiSdkQuery } = await import('../index');
    const { getWindow } = collectStream();
    await executeKimiSdkQuery('explica o repo', makeOptions(), getWindow, undefined, makeSelection());

    expect(ensureInitialSessionTitle).toHaveBeenCalledWith('sess-rt', 'explica o repo');
    expect(generateSessionTitle).toHaveBeenCalledWith('sess-rt');
  });

  it('emits session first, forwards text, persists user + assistant, emits done', async () => {
    sessionSendImpl = async (_prompt, cb) => {
      cb.onText?.('Ola ');
      cb.onText?.('mundo');
      cb.onThinking?.('internal reasoning');
      return {
        content: 'Ola mundo',
        usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 },
        toolUses: 0,
        status: 'finished',
      };
    };

    const { executeKimiSdkQuery, isKimiSdkQueryActive } = await import('../index');
    const { getWindow, chunks } = collectStream();

    await executeKimiSdkQuery('oi', makeOptions(), getWindow, undefined, makeSelection());

    expect(chunks[0].type).toBe('session');
    expect(chunks[0].content).toBe('sess-rt');

    const textChunks = chunks.filter((c) => c.type === 'text');
    expect(textChunks.map((c) => c.content)).toEqual(['Ola ', 'mundo']);
    expect(chunks.some((c) => c.type === 'thinking')).toBe(false);
    expect(chunks.some((c) => c.type === 'reasoning')).toBe(false);

    expect(chunks.at(-1)?.type).toBe('done');

    const roles = insertMessage.mock.calls.map((args) => args[1]);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    const assistantCall = insertMessage.mock.calls.find((args) => args[1] === 'assistant');
    expect(assistantCall?.[2]).toBe('Ola mundo');

    expect(isKimiSdkQueryActive()).toBe(false);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it('reasoning stays audit-only end to end (no chunk, kimi.reasoning audit row)', async () => {
    sessionSendImpl = async (_prompt, cb) => {
      cb.onThinking?.('secret thoughts');
      cb.onText?.('resposta');
      return {
        content: 'resposta',
        usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
        toolUses: 0,
        status: 'finished',
      };
    };

    const { executeKimiSdkQuery } = await import('../index');
    const { getWindow, chunks } = collectStream();

    await executeKimiSdkQuery('pensa', makeOptions(), getWindow, undefined, makeSelection());

    expect(chunks.some((c) => c.type === 'thinking')).toBe(false);
    expect(chunks.some((c) => c.type === 'reasoning')).toBe(false);

    const reasoningAudits = insertAuditEntry.mock.calls.filter(
      (args) => (args[0] as { toolName?: string })?.toolName === 'kimi.reasoning',
    );
    expect(reasoningAudits.length).toBeGreaterThanOrEqual(1);
    expect(reasoningAudits[0][0]).toMatchObject({
      eventType: 'tool_call',
      toolName: 'kimi.reasoning',
      input: 'secret thoughts',
    });
  });

  it('stop/abort mid-run leaves no pending turn', async () => {
    const { executeKimiSdkQuery, stopKimiSdkQuery, isKimiSdkQueryActive } = await import('../index');

    sessionSendImpl = (_prompt, _cb, signal) =>
      new Promise<CliAgenticResponse>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });

    const { getWindow, chunks } = collectStream();
    const runPromise = executeKimiSdkQuery('longa', makeOptions(), getWindow, undefined, makeSelection());

    await new Promise((r) => setImmediate(r));
    expect(isKimiSdkQueryActive()).toBe(true);

    stopKimiSdkQuery();
    await runPromise;

    const assistantCalls = insertMessage.mock.calls.filter((args) => args[1] === 'assistant');
    expect(assistantCalls).toHaveLength(0);

    expect(sessionClose).toHaveBeenCalledTimes(1);
    expect(chunks.some((c) => c.type === 'error')).toBe(false);
    expect(chunks.some((c) => c.type === 'done')).toBe(false);

    expect(isKimiSdkQueryActive()).toBe(false);
  });

  it("stop/abort where send RESOLVES with status:'cancelled' leaves no pending turn", async () => {
    const { executeKimiSdkQuery, stopKimiSdkQuery, isKimiSdkQueryActive } = await import('../index');

    sessionSendImpl = (_prompt, cb, signal) =>
      new Promise<CliAgenticResponse>((resolve) => {
        cb.onText?.('parcial...');
        signal.addEventListener(
          'abort',
          () =>
            resolve({
              content: 'parcial...',
              usage: {
                inputTokens: 7,
                outputTokens: 3,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              },
              toolUses: 0,
              status: 'cancelled',
            }),
          { once: true },
        );
      });

    const { getWindow, chunks } = collectStream();
    const runPromise = executeKimiSdkQuery('longa', makeOptions(), getWindow, undefined, makeSelection());

    await new Promise((r) => setImmediate(r));
    expect(isKimiSdkQueryActive()).toBe(true);

    stopKimiSdkQuery();
    await runPromise;

    const assistantCalls = insertMessage.mock.calls.filter((args) => args[1] === 'assistant');
    expect(assistantCalls).toHaveLength(0);

    expect(chunks.some((c) => c.type === 'usage')).toBe(false);
    expect(chunks.some((c) => c.type === 'done')).toBe(false);
    expect(chunks.some((c) => c.type === 'error')).toBe(false);
    expect(recordCompletedMainChatTurn).not.toHaveBeenCalled();

    expect(sessionClose).toHaveBeenCalledTimes(1);
    expect(isKimiSdkQueryActive()).toBe(false);
  });
});
