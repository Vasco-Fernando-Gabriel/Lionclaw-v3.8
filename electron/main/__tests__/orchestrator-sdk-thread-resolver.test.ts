import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queryMock: vi.fn<(args: { prompt: string; options: Record<string, unknown> }) => unknown>(),
  getApiKeyMock: vi.fn(async (): Promise<string | null> => 'test-key'),
  getSessionMessagesMock: vi.fn((_sessionId: string): unknown[] => []),
  getSessionMock: vi.fn((_sessionId: string): Record<string, unknown> | undefined => undefined),
  getActiveSessionMock: vi.fn(),
  getActiveChatSessionMock: vi.fn(),
  insertMessageMock: vi.fn(() => 1),
  clearSessionPendingSeedMock: vi.fn(),
  insertTaskExecutionMock: vi.fn(),
  startTaskExecutionMock: vi.fn(),
  finalizeTaskExecutionOnceMock: vi.fn(),
  finalizeRunningTaskExecutionTreeMock: vi.fn(),
  updateSessionTokensMock: vi.fn(),
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

vi.mock('../claude-compat-sdk', () => ({
  executeClaudeCompatSdkQuery: vi.fn(async () => undefined),
  isClaudeCompatQueryActive: vi.fn(() => false),
  resetClaudeCompatSdkSessionState: vi.fn(),
  stopClaudeCompatQuery: vi.fn(),
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

vi.mock('../db', () => ({
  threadIdOf: (s: { id: string; sdkSessionId?: string | null }) => s.sdkSessionId ?? s.id,
  getSessionOrchestrator: () => null,
  getAllAgents: () => [],
  getAgent: () => undefined,
  insertMessage: (...args: unknown[]) => h.insertMessageMock(...(args as [])),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(),
  getSetting: vi.fn(() => undefined),
  updateSessionTokens: h.updateSessionTokensMock,
  getActiveSession: h.getActiveSessionMock,
  getActiveChatSession: h.getActiveChatSessionMock,
  getSession: (sessionId: string) => h.getSessionMock(sessionId),
  getEnabledTools: vi.fn(() => []),
  getSessionMessages: (sessionId: string) => h.getSessionMessagesMock(sessionId),
  insertTaskExecution: h.insertTaskExecutionMock,
  startTaskExecution: h.startTaskExecutionMock,
  finalizeTaskExecutionOnce: h.finalizeTaskExecutionOnceMock,
  finalizeRunningTaskExecutionTree: h.finalizeRunningTaskExecutionTreeMock,
  getTurnIndexForUserMessage: vi.fn(() => 1),
  getLatestUserTurnIndex: vi.fn(() => 1),
  getHarnessProject: vi.fn(() => null),
  clearSessionPendingSeed: (...args: unknown[]) => h.clearSessionPendingSeedMock(...(args as [])),
}));

vi.mock('../activity-log', () => ({
  recordActivity: vi.fn(),
  isWriteTool: vi.fn(() => false),
  deriveToolDetail: vi.fn(() => ''),
}));

vi.mock('../knowledge-state', () => ({ setActiveAgentId: vi.fn() }));
vi.mock('../onboarding', () => ({ extractAndProcessOnboardingData: vi.fn(() => null) }));
vi.mock('../pricing', () => ({ calculateCost: () => 0, hasKnownPricing: () => true }));
vi.mock('../secrets-vault', () => ({
  getApiKey: (...args: unknown[]) => h.getApiKeyMock(...(args as [])),
  getSecret: async () => null,
}));
vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => vi.fn(),
  GUARD_GATED_TOOLS: [],
}));
vi.mock('../mcp-manager', () => ({ getMCPConfigForAgent: async () => ({}) }));
vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: async () => ({
    allowedTools: [],
    systemPrompt: '',
    mcpServers: [],
    maxTurns: 0,
  }),
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
vi.mock('../title-generator', () => ({
  ensureInitialSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(),
}));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../drive-usage-sink', () => ({
  reportDriveTurnUsage: vi.fn(),
  reportDriveTurnComplete: vi.fn(),
}));
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

import {
  executeClaudeSdkQuery,
  executeTelegramLaneQuery,
  resetSdkSessionState,
  resetTelegramSessionState,
  resetCronSessionState,
} from '../orchestrator';

const fakeGetWindow = () => null;

function legacySessionRow(id: string, type: 'chat' | 'telegram' = 'chat'): Record<string, unknown> {
  return {
    id,
    sdkSessionId: undefined,
    pendingSeed: undefined,
    title: 'x',
    type,
    status: 'active',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
}

function okQueryResult() {
  return {
    async *[Symbol.asyncIterator]() {},
    toggleMcpServer: async () => {},
  };
}

function sdkCallOf(index: number): { prompt: string; options: Record<string, unknown> } {
  const call = h.queryMock.mock.calls[index];
  expect(call, `query() call #${index} deveria existir`).toBeDefined();
  return call[0] as { prompt: string; options: Record<string, unknown> };
}

function threadDecisionOf(index: number): Record<string, unknown> {
  const opts = sdkCallOf(index).options;
  const decision: Record<string, unknown> = {};
  for (const key of ['continue', 'resume', 'sessionId'] as const) {
    if (key in opts) decision[key] = opts[key];
  }
  return decision;
}

beforeEach(() => {
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(() => okQueryResult());
  h.getApiKeyMock.mockReset();
  h.getApiKeyMock.mockResolvedValue('test-key');
  h.getSessionMessagesMock.mockReset();
  h.getSessionMessagesMock.mockReturnValue([]);
  h.getSessionMock.mockReset();
  h.getSessionMock.mockReturnValue(undefined);
  h.getActiveSessionMock.mockClear();
  h.getActiveChatSessionMock.mockClear();
  h.insertMessageMock.mockClear();
  h.clearSessionPendingSeedMock.mockClear();
  h.insertTaskExecutionMock.mockClear();
  h.startTaskExecutionMock.mockClear();
  h.finalizeTaskExecutionOnceMock.mockClear();
  h.finalizeRunningTaskExecutionTreeMock.mockClear();
  h.updateSessionTokensMock.mockClear();
  resetSdkSessionState();
  resetTelegramSessionState();
  resetCronSessionState();
});

describe('AC-12: sessao com sdk_session_id/pending_seed NULL e byte-identica (SPEC 4.2)', () => {
  it('espelha Task nativa no ledger V138 e preserva o insert legado', async () => {
    h.queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-native-1',
          tool_use_id: 'tool-native-1',
          description: 'delegar analise',
          task_type: 'researcher',
        };
        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'task-native-1',
          tool_use_id: 'tool-native-1',
          status: 'completed',
          summary: 'feito',
        };
      },
      toggleMcpServer: async () => {},
    }));

    await executeClaudeSdkQuery('oi', { sessionId: 'd-native', silent: true }, fakeGetWindow);

    expect(h.startTaskExecutionMock).toHaveBeenCalledTimes(2);
    const child = h.startTaskExecutionMock.mock.calls[1][0] as Record<string, unknown>;
    expect(child).toEqual(
      expect.objectContaining({
        executionKind: 'native-task',
        ownerKind: 'chat',
        ownerId: 'd-native',
        sessionId: 'd-native',
        toolUseId: 'tool-native-1',
        taskId: 'task-native-1',
        runtime: 'cloud',
        provider: 'anthropic',
      }),
    );
    expect(h.finalizeTaskExecutionOnceMock).toHaveBeenCalledWith(
      child.executionId,
      expect.objectContaining({
        status: 'completed',
        tokenStatus: 'not_reported',
        costStatus: 'unknown',
        costUnknownReason: 'no-usage-reported',
      }),
    );
    expect(h.insertTaskExecutionMock).not.toHaveBeenCalled();
  });

  it('marca usage unilateral da Task nativa como unknown mesmo com request e input', async () => {
    h.queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-native-partial',
          tool_use_id: 'tool-native-partial',
          description: 'delegar analise',
          task_type: 'researcher',
        };
        yield {
          type: 'stream_event',
          parent_tool_use_id: 'tool-native-partial',
          event: {
            type: 'message_start',
            message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 11 } },
          },
        };
        yield {
          type: 'stream_event',
          parent_tool_use_id: 'tool-native-partial',
          event: { type: 'message_delta', usage: { output_tokens: 0 } },
        };
        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'task-native-partial',
          tool_use_id: 'tool-native-partial',
          status: 'completed',
          summary: 'feito',
        };
      },
      toggleMcpServer: async () => {},
    }));

    await executeClaudeSdkQuery('oi', { sessionId: 'd-native-partial', silent: true }, fakeGetWindow);

    const child = h.startTaskExecutionMock.mock.calls[1][0] as Record<string, unknown>;
    expect(h.finalizeTaskExecutionOnceMock).toHaveBeenCalledWith(
      child.executionId,
      expect.objectContaining({
        inputTokens: 11,
        outputTokens: 0,
        apiRequests: 1,
        tokenStatus: 'not_reported',
        costStatus: 'unknown',
        costUnknownReason: 'no-usage-reported',
      }),
    );
  });

  it('persiste no pai somente usage principal e deixa a sidechain no native-task', async () => {
    h.queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'stream_event',
          event: { type: 'message_start', message: { model: 'claude-opus-4-8', usage: { input_tokens: 10 } } },
        };
        yield { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 5 } } };
        yield {
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-native-usage',
          tool_use_id: 'tool-native-usage',
          description: 'delegar',
          task_type: 'researcher',
        };
        yield {
          type: 'stream_event',
          parent_tool_use_id: 'tool-native-usage',
          event: { type: 'message_start', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 100 } } },
        };
        yield {
          type: 'stream_event',
          parent_tool_use_id: 'tool-native-usage',
          event: { type: 'message_delta', usage: { output_tokens: 20 } },
        };
        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'task-native-usage',
          tool_use_id: 'tool-native-usage',
          status: 'completed',
          summary: 'feito',
        };
      },
      toggleMcpServer: async () => {},
    }));

    await executeClaudeSdkQuery('oi', { sessionId: 'd-native-usage', silent: true }, fakeGetWindow);

    expect(h.updateSessionTokensMock).toHaveBeenCalledWith('d-native-usage', 10, 5, 0, {
      costStatus: 'known',
      runtime: 'cloud',
      tokenStatus: 'reported',
    });
    const child = h.startTaskExecutionMock.mock.calls[1][0] as Record<string, unknown>;
    expect(h.finalizeTaskExecutionOnceMock).toHaveBeenCalledWith(
      child.executionId,
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        inputTokens: 100,
        outputTokens: 20,
      }),
    );
  });

  it('estado 1 — sessao NOVA (sem mensagens): { sessionId } puro, sem continue/resume', async () => {
    h.getSessionMock.mockImplementation((id: string) => legacySessionRow(id));
    await executeClaudeSdkQuery('oi', { sessionId: 'd-new', silent: true }, fakeGetWindow);

    expect(threadDecisionOf(0)).toEqual({ sessionId: 'd-new' });
  });

  it('estado 2 — lane FRIA com mensagens: { resume: sessionId } puro', async () => {
    h.getSessionMock.mockImplementation((id: string) => legacySessionRow(id));
    h.getSessionMessagesMock.mockImplementation((id: string) => (id === 'd-hist' ? [{ id: 1 }] : []));
    await executeClaudeSdkQuery('oi', { sessionId: 'd-hist', silent: true }, fakeGetWindow);

    expect(threadDecisionOf(0)).toEqual({ resume: 'd-hist' });
  });

  it('estado 3 — lane VIVA no desktop: NUNCA continue:true, sempre { resume } (lanes 8.5 / V5, AC-20)', async () => {
    h.getSessionMock.mockImplementation((id: string) => legacySessionRow(id));
    h.getSessionMessagesMock.mockImplementation((id: string) => (id === 'd-hist' ? [{ id: 1 }] : []));
    await executeClaudeSdkQuery('a', { sessionId: 'd-hist', silent: true }, fakeGetWindow);
    await executeClaudeSdkQuery('b', { sessionId: 'd-hist', silent: true }, fakeGetWindow);

    expect(threadDecisionOf(0)).toEqual({ resume: 'd-hist' });
    expect(threadDecisionOf(1)).toEqual({ resume: 'd-hist' });
  });

  it('estado 3 — lane VIVA no telegram: { continue: true } puro (fast-path preservado fora do desktop)', async () => {
    h.getSessionMock.mockImplementation((id: string) => legacySessionRow(id));
    h.getSessionMessagesMock.mockImplementation((id: string) => (id === 't-hist' ? [{ id: 1 }] : []));
    resetTelegramSessionState();
    await executeTelegramLaneQuery('a', { sessionId: 't-hist', silent: true }, fakeGetWindow);
    await executeTelegramLaneQuery('b', { sessionId: 't-hist', silent: true }, fakeGetWindow);

    expect(threadDecisionOf(0)).toEqual({ resume: 't-hist' });
    expect(threadDecisionOf(1)).toEqual({ continue: true });
    resetTelegramSessionState();
  });

  it('sessao inexistente no DB (getSession undefined) tambem segue o caminho legado', async () => {
    await executeClaudeSdkQuery('oi', { sessionId: 'd-ghost', silent: true }, fakeGetWindow);
    expect(threadDecisionOf(0)).toEqual({ sessionId: 'd-ghost' });
  });
});

describe('resolver sdkThreadId (SPEC 4.1)', () => {
  it('lane fria com mensagens: resume usa o sdkThreadId, nao o sessionId do DB', async () => {
    h.getSessionMock.mockImplementation((id: string) =>
      id === 't-comp' ? { ...legacySessionRow(id, 'telegram'), sdkSessionId: 'thread-uuid-1' } : undefined,
    );
    h.getSessionMessagesMock.mockImplementation((id: string) => (id === 't-comp' ? [{ id: 1 }] : []));

    await executeTelegramLaneQuery('oi', { sessionId: 't-comp', silent: true }, fakeGetWindow);

    expect(threadDecisionOf(0)).toEqual({ resume: 'thread-uuid-1' });
    expect(h.insertMessageMock).toHaveBeenCalledWith('t-comp', 'user', 'oi');
  });

  it('escrita da lane no sucesso usa sdkThreadId: fast-path continue:true casa no turno seguinte', async () => {
    h.getSessionMock.mockImplementation((id: string) =>
      id === 't-comp' ? { ...legacySessionRow(id, 'telegram'), sdkSessionId: 'thread-uuid-2' } : undefined,
    );
    h.getSessionMessagesMock.mockImplementation((id: string) => (id === 't-comp' ? [{ id: 1 }] : []));

    await executeTelegramLaneQuery('a', { sessionId: 't-comp', silent: true }, fakeGetWindow);
    await executeTelegramLaneQuery('b', { sessionId: 't-comp', silent: true }, fakeGetWindow);

    expect(threadDecisionOf(0)).toEqual({ resume: 'thread-uuid-2' });
    expect(threadDecisionOf(1)).toEqual({ continue: true });
  });

  it('retry pos-falha-de-resume abre thread fresca com o MESMO sdkThreadId', async () => {
    h.getSessionMock.mockImplementation((id: string) =>
      id === 't-comp' ? { ...legacySessionRow(id, 'telegram'), sdkSessionId: 'thread-uuid-3' } : undefined,
    );
    h.getSessionMessagesMock.mockImplementation((id: string) => (id === 't-comp' ? [{ id: 1 }] : []));
    h.queryMock
      .mockImplementationOnce(() => {
        throw new Error('EPIPE simulada');
      })
      .mockImplementation(() => okQueryResult());

    await executeTelegramLaneQuery('oi', { sessionId: 't-comp', silent: true }, fakeGetWindow);

    expect(threadDecisionOf(0)).toEqual({ resume: 'thread-uuid-3' });
    expect(threadDecisionOf(1)).toEqual({ sessionId: 'thread-uuid-3' });
  });
});

describe('pending_seed (SPEC 4.3)', () => {
  const SEED = '[Resumo da conversa ate aqui]\nfatos importantes\n\n[Turnos recentes]\n...';

  function seedSession(pendingSeed: string | undefined) {
    h.getSessionMock.mockImplementation((id: string) =>
      id === 't-seed' ? { ...legacySessionRow(id, 'telegram'), sdkSessionId: 'thread-new', pendingSeed } : undefined,
    );
    h.getSessionMessagesMock.mockImplementation((id: string) => (id === 't-seed' ? [{ id: 1 }, { id: 2 }] : []));
  }

  it('forca thread NOVA ({ sessionId: sdkThreadId }) mesmo com historico, injeta o seed como preambulo e persiste a user message SEM o seed', async () => {
    seedSession(SEED);

    await executeTelegramLaneQuery(
      'qual era o plano?',
      { sessionId: 't-seed', silent: true, displayMessage: 'qual era o plano?' },
      fakeGetWindow,
    );

    expect(threadDecisionOf(0)).toEqual({ sessionId: 'thread-new' });
    const seededPrompt = sdkCallOf(0).prompt;
    expect(seededPrompt).toContain(`${SEED}\n\n[Contexto:`);
    expect(seededPrompt).toMatch(/\]\n\nqual era o plano\?$/);
    expect(h.insertMessageMock).toHaveBeenCalledWith('t-seed', 'user', 'qual era o plano?');
  });

  it('sucesso do turno consome o seed exatamente uma vez (clearSessionPendingSeed no ponto da escrita da lane)', async () => {
    seedSession(SEED);

    await executeTelegramLaneQuery('a', { sessionId: 't-seed', silent: true }, fakeGetWindow);

    expect(h.clearSessionPendingSeedMock).toHaveBeenCalledTimes(1);
    expect(h.clearSessionPendingSeedMock).toHaveBeenCalledWith('t-seed');

    seedSession(undefined);
    await executeTelegramLaneQuery('b', { sessionId: 't-seed', silent: true }, fakeGetWindow);

    expect(threadDecisionOf(1)).toEqual({ continue: true });
    expect(sdkCallOf(1).prompt).toMatch(/^\[Contexto: .+\]\n\nb$/);
    expect(h.clearSessionPendingSeedMock).toHaveBeenCalledTimes(1);
  });

  it('falha do turno PRESERVA o seed (clearSessionPendingSeed nao roda) e o job rejeita', async () => {
    seedSession(SEED);
    h.queryMock.mockImplementation(() => {
      throw new Error('turno quebrou');
    });

    await expect(executeTelegramLaneQuery('a', { sessionId: 't-seed', silent: true }, fakeGetWindow)).rejects.toThrow(
      'turno quebrou',
    );

    expect(h.clearSessionPendingSeedMock).not.toHaveBeenCalled();
  });
});
