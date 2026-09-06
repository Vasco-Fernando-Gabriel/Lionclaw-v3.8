import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  chunks: [] as Array<Record<string, unknown>>,
  finalize: vi.fn(),
  fail: vi.fn(),
  close: vi.fn(async () => undefined),
  send: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../db', () => ({
  clearSessionPendingSeed: vi.fn(),
  createSession: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getSession: vi.fn(() => ({ id: 'session-1', pendingSeed: null, compactedUpToMessageId: null, type: 'chat' })),
  getSessionMessages: vi.fn(() => []),
  getSessionActiveRepository: vi.fn(() => null),
  getLocalRepository: vi.fn(() => null),
  getSetting: vi.fn((key: string) => key === 'onboarding_completed' ? 'true' : undefined),
  insertAuditEntry: vi.fn(),
  insertMessage: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
  updateSessionTokens: vi.fn(),
}));

vi.mock('../user-attachments-meta', () => ({ persistUserChatMessage: vi.fn() }));
vi.mock('../token-estimator', () => ({ estimateTokens: vi.fn(() => 1) }));
vi.mock('../agent-runtime/context-measure', () => ({
  estimateAgenticContentTokens: vi.fn(() => 0),
  estimateStrongFloor: vi.fn(() => 0),
  reconcileActiveContext: vi.fn(() => 0),
}));
vi.mock('../chat-context-usage', () => ({ buildChatContextUsage: vi.fn(() => null) }));
vi.mock('../chat-compaction-trigger', () => ({ maybeCompactChatSession: vi.fn() }));
vi.mock('../title-generator', () => ({ ensureInitialSessionTitle: vi.fn(), generateSessionTitle: vi.fn() }));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../onboarding', () => ({
  completeOnboardingFromPersistedProfile: vi.fn(),
  extractAndProcessOnboardingData: vi.fn((content: string) => content),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
}));
vi.mock('../chat-capability-context', () => ({
  computeEffectiveCapabilitiesForTurn: vi.fn(),
  getActiveChatTurnByLane: vi.fn(() => null),
  getChatCapabilityTurn: vi.fn(),
}));
vi.mock('../grok-sdk/workspace', () => ({
  assertGrokWorkspaceUnchanged: vi.fn(),
  resolveGrokWorkspaceGrant: vi.fn(() => ({
    processCwd: '/tmp/grok',
    sessionCwd: '/tmp/grok',
    readRoots: ['/tmp/grok'],
    writeRoots: [],
    source: 'neutral',
    projectSources: [],
  })),
}));
vi.mock('../grok-sdk/session', () => ({
  createChatGrokSession: state.createSession,
}));
vi.mock('../grok-sdk/stream-translator', () => ({
  buildGrokUsageSnapshot: vi.fn(() => ({
    runtime: 'grok-sdk',
    provider: 'grok',
    model: 'grok-4.5',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    tokenStatus: 'not_reported',
    costStatus: 'unknown',
  })),
  createGrokStreamTranslator: vi.fn(() => ({
    callbacks: {},
    finalize: state.finalize,
    fail: state.fail,
  })),
}));

import { executeGrokSdkQuery } from '../grok-sdk';
import { cronLane, telegramLane } from '../sdk-lane';

const response = {
  content: '',
  status: 'completed',
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsdTicks: null },
};

describe('Grok chat empty response contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.chunks.length = 0;
    state.send.mockResolvedValue(response);
    state.createSession.mockResolvedValue({
      contextMeta: { systemPromptTokens: 0, toolSchemasTokens: 0 },
      send: state.send,
      close: state.close,
    });
    telegramLane.currentAbortController = null;
    cronLane.currentAbortController = null;
  });

  it('emite LLM-EMPTY antes de done e nao finaliza turno realmente vazio', async () => {
    const db = await import('../db');
    vi.mocked(db.getSession).mockReturnValue({
      id: 'session-1', pendingSeed: 'SEED', compactedUpToMessageId: null, type: 'chat',
    } as never);
    await executeGrokSdkQuery(
      'ola',
      {
        sessionId: 'session-1',
        onStreamChunk: (chunk) => state.chunks.push(chunk as unknown as Record<string, unknown>),
      },
      () => null,
      undefined,
      { runtime: 'grok-sdk', provider: 'grok', model: 'grok-4.5', source: 'settings', effort: 'high' },
    );

    expect(state.chunks).toContainEqual(expect.objectContaining({ type: 'error', code: 'LLM-EMPTY' }));
    expect(state.chunks.some((chunk) => chunk.type === 'done')).toBe(false);
    expect(state.finalize).not.toHaveBeenCalled();
    expect(state.fail).not.toHaveBeenCalled();
    expect(state.close).toHaveBeenCalledOnce();
    expect(db.clearSessionPendingSeed).not.toHaveBeenCalled();
  });

  it('mantem tool-only como empty-ok e consome pending_seed', async () => {
    const db = await import('../db');
    vi.mocked(db.getSession).mockReturnValue({
      id: 'session-1', pendingSeed: 'SEED', compactedUpToMessageId: null, type: 'chat',
    } as never);
    state.send.mockImplementation(async (_prompt, callbacks) => {
      callbacks.onToolUse?.('Read', { file_path: '/tmp/a' });
      return response;
    });

    await executeGrokSdkQuery(
      'leia',
      { sessionId: 'session-1', onStreamChunk: (chunk) => state.chunks.push(chunk as unknown as Record<string, unknown>) },
      () => null,
      undefined,
      { runtime: 'grok-sdk', provider: 'grok', model: 'grok-4.5', source: 'settings', effort: 'high' },
    );

    expect(state.chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(state.finalize).toHaveBeenCalledOnce();
    expect(db.insertMessage).not.toHaveBeenCalled();
    expect(db.clearSessionPendingSeed).toHaveBeenCalledWith('session-1');
    expect(db.updateSessionTokens).toHaveBeenCalledWith('session-1', 0, 0, 0, {
      costStatus: 'unknown',
      tokenStatus: 'not_reported',
      costUnknownReason: null,
      runtime: 'grok',
      costEstimationKind: 'subscription-equivalent-payg',
    });
  });

  it('nao persiste dimensoes canonicas de envelope unilateral', async () => {
    const db = await import('../db');
    state.send.mockResolvedValue({
      ...response,
      content: 'resposta parcial',
      usage: {
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 10,
        cacheCreationTokens: 0,
        reported: false,
      },
    });

    await executeGrokSdkQuery(
      'ola',
      { sessionId: 'session-1', onStreamChunk: (chunk) => state.chunks.push(chunk as unknown as Record<string, unknown>) },
      () => null,
      undefined,
      { runtime: 'grok-sdk', provider: 'grok', model: 'grok-4.5', source: 'settings', effort: 'high' },
    );

    expect(db.updateSessionTokens).toHaveBeenCalledWith('session-1', 0, 0, 0, {
      costStatus: 'unknown',
      tokenStatus: 'not_reported',
      costUnknownReason: null,
      runtime: 'grok',
      costEstimationKind: 'subscription-equivalent-payg',
    });
  });

  it('cancelamento do CLI sem abort local vira erro visivel, sem done nem persistencia', async () => {
    const db = await import('../db');
    vi.mocked(db.getSession).mockReturnValue({
      id: 'session-1', pendingSeed: 'SEED', compactedUpToMessageId: null, type: 'chat',
    } as never);
    state.send.mockResolvedValue({ ...response, content: 'parcial', status: 'cancelled' });

    await executeGrokSdkQuery(
      'pare',
      { sessionId: 'session-1', onStreamChunk: (chunk) => state.chunks.push(chunk as unknown as Record<string, unknown>) },
      () => null,
      undefined,
      { runtime: 'grok-sdk', provider: 'grok', model: 'grok-4.5', source: 'settings', effort: 'high' },
    );

    expect(state.chunks.some((chunk) => chunk.type === 'done')).toBe(false);
    expect(state.finalize).not.toHaveBeenCalled();
    expect(state.fail).toHaveBeenCalledOnce();
    expect(String((state.fail.mock.calls[0] as unknown[])[0])).toContain('cancelado pelo CLI');
    expect(state.close).toHaveBeenCalledOnce();
    expect(db.clearSessionPendingSeed).not.toHaveBeenCalled();
  });

  it('propaga falha de autenticacao pelo translator sem abrir turno ACP', async () => {
    const authError = new Error('cached_token authentication failed');
    state.createSession.mockRejectedValue(authError);

    await executeGrokSdkQuery(
      'ola',
      { sessionId: 'session-1', onStreamChunk: (chunk) => state.chunks.push(chunk as unknown as Record<string, unknown>) },
      () => null,
      undefined,
      { runtime: 'grok-sdk', provider: 'grok', model: 'grok-4.5', source: 'settings', effort: 'high' },
    );

    expect(state.fail).toHaveBeenCalledWith(authError);
    expect(state.send).not.toHaveBeenCalled();
    expect(state.finalize).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
  });

  it('rejeita falha de criacao da sessao na lane Telegram depois de emitir o erro', async () => {
    const authError = new Error('cached_token authentication failed');
    state.createSession.mockRejectedValue(authError);

    await expect(executeGrokSdkQuery(
      'ola',
      { sessionId: 'telegram-session', onStreamChunk: (chunk) => state.chunks.push(chunk as unknown as Record<string, unknown>) },
      () => null,
      telegramLane,
      { runtime: 'grok-sdk', provider: 'grok', model: 'grok-4.5', source: 'settings', effort: 'high' },
    )).rejects.toBe(authError);

    expect(state.fail).toHaveBeenCalledWith(authError);
    expect(state.send).not.toHaveBeenCalled();
    expect(telegramLane.currentAbortController).toBeNull();
  });

  it('rejeita falha do send na lane cron depois de emitir o erro e fechar a sessao', async () => {
    const db = await import('../db');
    vi.mocked(db.getSession).mockReturnValue({
      id: 'cron-session', pendingSeed: 'SEED', compactedUpToMessageId: null, type: 'chat',
    } as never);
    const sendError = new Error('grok process exited');
    state.send.mockRejectedValue(sendError);

    await expect(executeGrokSdkQuery(
      'execute',
      { sessionId: 'cron-session', onStreamChunk: (chunk) => state.chunks.push(chunk as unknown as Record<string, unknown>) },
      () => null,
      cronLane,
      { runtime: 'grok-sdk', provider: 'grok', model: 'grok-4.5', source: 'settings', effort: 'high' },
    )).rejects.toBe(sendError);

    expect(state.fail).toHaveBeenCalledWith(sendError);
    expect(state.close).toHaveBeenCalledOnce();
    expect(cronLane.currentAbortController).toBeNull();
    expect(db.clearSessionPendingSeed).not.toHaveBeenCalled();
  });
});
