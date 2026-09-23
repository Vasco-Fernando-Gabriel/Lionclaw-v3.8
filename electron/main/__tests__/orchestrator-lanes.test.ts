import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queryMock: vi.fn<(args: { prompt: string; options: Record<string, unknown> }) => unknown>(),
  getApiKeyMock: vi.fn(async (): Promise<string | null> => 'test-key'),
  getSessionMessagesMock: vi.fn((_sessionId: string): unknown[] => []),
  getActiveSessionMock: vi.fn(),
  getActiveChatSessionMock: vi.fn(),
  insertMessageMock: vi.fn(() => 1),
  getHarnessProjectMock: vi.fn((_id: string): unknown => null),
  getDriveSessionIdMock: vi.fn((_id: string): string | null => null),
  isDriveEngagedMock: vi.fn((_id: string): boolean => false),
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
  InvalidOrchestratorSelectionError: class extends Error {
    code: string;
    constructor(message: string, code = 'orchestrator_unconfigured') {
      super(message);
      this.name = 'InvalidOrchestratorSelectionError';
      this.code = code;
    }
  },
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
  updateSessionTokens: vi.fn(),
  getActiveSession: h.getActiveSessionMock,
  getActiveChatSession: h.getActiveChatSessionMock,
  getSession: vi.fn(() => undefined),
  getEnabledTools: vi.fn(() => []),
  getSessionMessages: (sessionId: string) => h.getSessionMessagesMock(sessionId),
  insertTaskExecution: vi.fn(),
  getTurnIndexForUserMessage: vi.fn(() => 1),
  getLatestUserTurnIndex: vi.fn(() => 1),
  getHarnessProject: (id: string) => h.getHarnessProjectMock(id),
  getDriveSessionId: (id: string) => h.getDriveSessionIdMock(id),
  isDriveEngaged: (id: string) => h.isDriveEngagedMock(id),
}));

vi.mock('../activity-log', () => ({
  recordActivity: vi.fn(),
  isWriteTool: vi.fn(() => false),
  deriveToolDetail: vi.fn(() => ''),
}));

vi.mock('../knowledge-state', () => ({ setActiveAgentId: vi.fn() }));
vi.mock('../onboarding', () => ({ extractAndProcessOnboardingData: vi.fn(() => null) }));
vi.mock('../pricing', () => ({ calculateCost: () => 0 }));
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
vi.mock('../pipeline-shared/sdk-bootstrap', () => ({
  ensureNodeInPath: vi.fn(),
  getClaudeCodeExecutablePath: () => '/tmp/claude-cli.js',
  getClaudeSdkProcessOptions: () => ({ pathToClaudeCodeExecutable: '/tmp/claude-cli.js', executable: 'node' }),
}));
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
  executeTelegramLaneQuery,
  executeCronQuery,
  enqueueTelegramLaneTask,
  stopTelegramQuery,
  stopCronQuery,
  resetTelegramSessionState,
  resetCronSessionState,
  submitMessage,
  shouldDiscardStaleDriveTurn,
} from '../orchestrator';
import { reportDriveTurnComplete } from '../drive-usage-sink';
import { clearingSessions, markSessionClearing } from '../clearing-sessions';
import { getDesktopLane, resetDesktopLanesForTests } from '../desktop-lanes';
import { getInFlightDesktopSessions, resetInFlightDesktopSessionsForTests } from '../in-flight-desktop-session';

const fakeGetWindow = () => null;

function okQueryResult() {
  return {
    async *[Symbol.asyncIterator]() {},
    toggleMcpServer: async () => {},
  };
}

function hangingQueryResult(): { result: unknown; release: () => void } {
  let releaseFn: () => void = () => {};
  const result = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<unknown>>((resolve) => {
            releaseFn = () => resolve({ done: true, value: undefined });
          }),
      };
    },
    toggleMcpServer: async () => {},
  };
  return { result, release: () => releaseFn() };
}

function sdkOptionsOfCall(index: number): Record<string, unknown> {
  const call = h.queryMock.mock.calls[index];
  expect(call, `query() call #${index} deveria existir`).toBeDefined();
  return (call[0] as { options: Record<string, unknown> }).options;
}

beforeEach(() => {
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(() => okQueryResult());
  h.getApiKeyMock.mockReset();
  h.getApiKeyMock.mockResolvedValue('test-key');
  h.getSessionMessagesMock.mockReset();
  h.getSessionMessagesMock.mockReturnValue([]);
  h.getActiveSessionMock.mockClear();
  h.getActiveChatSessionMock.mockClear();
  h.insertMessageMock.mockClear();
  h.getHarnessProjectMock.mockReset();
  h.getHarnessProjectMock.mockReturnValue(null);
  h.getDriveSessionIdMock.mockReset();
  h.getDriveSessionIdMock.mockReturnValue(null);
  h.isDriveEngagedMock.mockReset();
  h.isDriveEngagedMock.mockReturnValue(false);
  resetTelegramSessionState();
  resetCronSessionState();
});

describe('guard de sessao explicita (SPEC 1.4 / AC-5)', () => {
  it('telegramLane sem sessionId rejeita e NUNCA cai em getActiveSession()', async () => {
    await expect(executeTelegramLaneQuery('oi', {}, fakeGetWindow)).rejects.toThrow(/sessionId explicito/);
    expect(h.getActiveSessionMock).not.toHaveBeenCalled();
    expect(h.getActiveChatSessionMock).not.toHaveBeenCalled();
    expect(h.queryMock).not.toHaveBeenCalled();
  });

  it('cronLane sem sessionId rejeita e NUNCA cai em getActiveSession()', async () => {
    await expect(executeCronQuery('tarefa', {}, fakeGetWindow)).rejects.toThrow(/sessionId explicito/);
    expect(h.getActiveSessionMock).not.toHaveBeenCalled();
    expect(h.getActiveChatSessionMock).not.toHaveBeenCalled();
    expect(h.queryMock).not.toHaveBeenCalled();
  });

  it('guard nao mata a fila: job seguinte com sessionId executa normal', async () => {
    await expect(executeTelegramLaneQuery('oi', {}, fakeGetWindow)).rejects.toThrow();
    await executeTelegramLaneQuery('agora vai', { sessionId: 't-ok', silent: true }, fakeGetWindow);
    expect(h.queryMock).toHaveBeenCalledTimes(1);
  });
});

describe('contrato de erro das filas (SPEC 1.3 / AC-71)', () => {
  it('telegram: job 1 falha -> Promise do JOB rejeita com o erro real; job 2 executa', async () => {
    h.queryMock
      .mockImplementationOnce(() => {
        throw new Error('boom do SDK');
      })
      .mockImplementation(() => okQueryResult());

    const job1 = executeTelegramLaneQuery('turno 1', { sessionId: 't-1', silent: true }, fakeGetWindow);
    const job2 = executeTelegramLaneQuery('turno 2', { sessionId: 't-1', silent: true }, fakeGetWindow);

    await expect(job1).rejects.toThrow('boom do SDK');
    await expect(job2).resolves.toBeUndefined();
    expect(h.queryMock).toHaveBeenCalledTimes(2);
  });

  it('cron: job 1 falha -> rejeita com o erro real; job 2 executa (fila viva)', async () => {
    h.queryMock
      .mockImplementationOnce(() => {
        throw new Error('cron quebrou');
      })
      .mockImplementation(() => okQueryResult());

    const job1 = executeCronQuery('tarefa 1', { sessionId: 'c-1', silent: true }, fakeGetWindow);
    const job2 = executeCronQuery('tarefa 2', { sessionId: 'c-2', silent: true }, fakeGetWindow);

    await expect(job1).rejects.toThrow('cron quebrou');
    await expect(job2).resolves.toBeUndefined();
    expect(h.queryMock).toHaveBeenCalledTimes(2);
  });
});

describe('contrato de efemeridade do cron (SPEC 7.1)', () => {
  it('sessao com mensagens rejeita SEM tocar o SDK', async () => {
    h.getSessionMessagesMock.mockImplementation((id: string) => (id === 'c-usada' ? [{ id: 1 }] : []));
    await expect(executeCronQuery('tarefa', { sessionId: 'c-usada', silent: true }, fakeGetWindow)).rejects.toThrow(
      /SEM mensagens/,
    );
    expect(h.queryMock).not.toHaveBeenCalled();
  });

  it('sessao vazia abre thread NOVA ({ sessionId }, sem continue/resume/_forceNewSession) e persiste a user message', async () => {
    await executeCronQuery('faz a tarefa', { sessionId: 'c-fresh', silent: true }, fakeGetWindow);

    const opts = sdkOptionsOfCall(0);
    expect(opts.sessionId).toBe('c-fresh');
    expect(opts.continue).toBeUndefined();
    expect(opts.resume).toBeUndefined();
    expect(h.insertMessageMock).toHaveBeenCalledWith('c-fresh', 'user', 'faz a tarefa');
  });
});

describe('seletor de CWD 3-vias (SPEC 1.5)', () => {
  it('cronLane roda em getCronCwd(); telegramLane roda em getAgentCwd() (persona principal)', async () => {
    await executeCronQuery('tarefa', { sessionId: 'c-cwd', silent: true }, fakeGetWindow);
    await executeTelegramLaneQuery('oi', { sessionId: 't-cwd', silent: true }, fakeGetWindow);

    expect(sdkOptionsOfCall(0).cwd).toBe('/cron/cwd');
    expect(sdkOptionsOfCall(1).cwd).toBe('/agent/cwd');
  });
});

describe('fast-path do Telegram e reset por lane (AC-11)', () => {
  it('resume -> continue; cron no meio NAO derruba o continue; reset volta para resume', async () => {
    h.getSessionMessagesMock.mockImplementation((id: string) => (id === 't-live' ? [{ id: 1 }] : []));

    await executeTelegramLaneQuery('a', { sessionId: 't-live', silent: true }, fakeGetWindow);
    expect(sdkOptionsOfCall(0).resume).toBe('t-live');

    await executeTelegramLaneQuery('b', { sessionId: 't-live', silent: true }, fakeGetWindow);
    expect(sdkOptionsOfCall(1).continue).toBe(true);

    await executeCronQuery('tarefa', { sessionId: 'c-meio', silent: true }, fakeGetWindow);

    await executeTelegramLaneQuery('c', { sessionId: 't-live', silent: true }, fakeGetWindow);
    expect(sdkOptionsOfCall(3).continue).toBe(true);

    resetTelegramSessionState();
    await executeTelegramLaneQuery('d', { sessionId: 't-live', silent: true }, fakeGetWindow);
    expect(sdkOptionsOfCall(4).resume).toBe('t-live');
  });
});

describe('filas independentes e stop por lane (SPEC 1.2)', () => {
  it('cron pendurado nao atrasa o Telegram; stopCronQuery aborta APENAS a cronLane', async () => {
    const hang = hangingQueryResult();
    h.queryMock.mockImplementationOnce(() => hang.result).mockImplementation(() => okQueryResult());

    const cronJob = executeCronQuery('tarefa longa', { sessionId: 'c-hang', silent: true }, fakeGetWindow);
    await new Promise((r) => setTimeout(r, 10));
    const telegramJob = executeTelegramLaneQuery('oi', { sessionId: 't-rapida', silent: true }, fakeGetWindow);

    await expect(telegramJob).resolves.toBeUndefined();
    let cronSettled = false;
    void cronJob.then(
      () => {
        cronSettled = true;
      },
      () => {
        cronSettled = true;
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(cronSettled).toBe(false);

    const cronAbort = sdkOptionsOfCall(0).abortController as AbortController;
    expect(cronAbort).toBeInstanceOf(AbortController);
    stopTelegramQuery();
    expect(cronAbort.signal.aborted).toBe(false);

    stopCronQuery();
    expect(cronAbort.signal.aborted).toBe(true);

    hang.release();
    await cronJob;
  });
});

describe('enqueueTelegramLaneTask: compactacao serializada na fila (SPEC 5.3 / AC-16)', () => {
  it('a tarefa espera o turno pendente e o turno seguinte espera a tarefa (nenhum intercala com o re-seed)', async () => {
    const order: string[] = [];
    const hang = hangingQueryResult();
    h.queryMock.mockImplementationOnce(() => hang.result).mockImplementation(() => okQueryResult());

    const turn1 = executeTelegramLaneQuery('turno 1', { sessionId: 't-1', silent: true }, fakeGetWindow).then(() => {
      order.push('turn1');
    });

    let releaseTask: () => void = () => {};
    const taskGate = new Promise<void>((res) => {
      releaseTask = res;
    });
    const task = enqueueTelegramLaneTask(async () => {
      order.push('task-start');
      await taskGate;
      order.push('task-end');
    });

    const turn2 = executeTelegramLaneQuery('turno 2', { sessionId: 't-1', silent: true }, fakeGetWindow).then(() => {
      order.push('turn2');
    });

    await new Promise((r) => setTimeout(r, 15));
    expect(order).toEqual([]);
    expect(h.queryMock).toHaveBeenCalledTimes(1);

    hang.release();
    await turn1;
    await vi.waitFor(() => expect(order).toContain('task-start'));
    await new Promise((r) => setTimeout(r, 15));
    expect(order).not.toContain('turn2');
    expect(h.queryMock).toHaveBeenCalledTimes(1);

    releaseTask();
    await task;
    await turn2;
    expect(order).toEqual(['turn1', 'task-start', 'task-end', 'turn2']);
    expect(h.queryMock).toHaveBeenCalledTimes(2);
  });

  it('falha da tarefa rejeita o Promise do caller e a fila continua viva (contrato SPEC 1.3)', async () => {
    await expect(
      enqueueTelegramLaneTask(async () => {
        throw new Error('compactacao quebrou');
      }),
    ).rejects.toThrow('compactacao quebrou');

    await expect(
      executeTelegramLaneQuery('depois da falha', { sessionId: 't-2', silent: true }, fakeGetWindow),
    ).resolves.toBeUndefined();
    expect(h.queryMock).toHaveBeenCalledTimes(1);
  });

  it('retorna o valor da tarefa ao caller (desfecho tipado da compactacao)', async () => {
    await expect(enqueueTelegramLaneTask(async () => ({ ok: true as const }))).resolves.toEqual({ ok: true });
  });
});

describe('AC-12 (drive): turno system-event numa lane interrupted e descartado com sinal ao coordenador', () => {
  it('submitMessage recusa a lane em Clear e emite reportDriveTurnComplete(discarded) sem enfileirar', () => {
    vi.mocked(reportDriveTurnComplete).mockClear();
    markSessionClearing('s-interrupted', 'interrupted', 1);
    try {
      submitMessage(
        'wake do drive',
        {
          sessionId: 's-interrupted',
          origin: 'system-event',
          driveProjectId: 'proj-1',
          driveTurnId: 'dt-1',
        },
        fakeGetWindow,
      );
      expect(reportDriveTurnComplete).toHaveBeenCalledWith('proj-1', 'dt-1', 'discarded');
      expect(h.queryMock).not.toHaveBeenCalled();
    } finally {
      clearingSessions.clear();
    }
  });

  it('turno humano numa lane em Clear e recusado sem sinal de drive', () => {
    vi.mocked(reportDriveTurnComplete).mockClear();
    markSessionClearing('s-interrupted', 'interrupted', 1);
    try {
      submitMessage('oi', { sessionId: 's-interrupted' }, fakeGetWindow);
      expect(reportDriveTurnComplete).not.toHaveBeenCalled();
      expect(h.queryMock).not.toHaveBeenCalled();
    } finally {
      clearingSessions.clear();
    }
  });
});

describe('AC-20: dois turnos desktop no mesmo cwd usam a PROPRIA thread (resume), nunca continue', () => {
  beforeEach(() => {
    resetDesktopLanesForTests();
    resetInFlightDesktopSessionsForTests();
  });

  it('A e B em paralelo: cada query() recebe resume da propria sessao; wake dw-drive-* roda em paralelo com o humano', async () => {
    await import('@anthropic-ai/claude-agent-sdk');
    h.getSessionMessagesMock.mockImplementation(() => [{ id: 1 }]);
    const hangs = [hangingQueryResult(), hangingQueryResult(), hangingQueryResult()];
    h.queryMock
      .mockImplementationOnce(() => hangs[0]!.result)
      .mockImplementationOnce(() => hangs[1]!.result)
      .mockImplementationOnce(() => hangs[2]!.result);

    submitMessage('a', { sessionId: 'lane-a', silent: true }, fakeGetWindow);
    await vi.waitFor(() => expect(h.queryMock).toHaveBeenCalledTimes(1));
    submitMessage('b', { sessionId: 'lane-b', silent: true }, fakeGetWindow);
    await vi.waitFor(() => expect(h.queryMock).toHaveBeenCalledTimes(2));

    const human = [sdkOptionsOfCall(0), sdkOptionsOfCall(1)];
    expect(human.map((o) => o.resume).sort()).toEqual(['lane-a', 'lane-b']);
    expect(human.every((o) => o.continue === undefined)).toBe(true);
    expect(human[0]!.cwd).toBe(human[1]!.cwd);
    expect(human[0]!.abortController).not.toBe(human[1]!.abortController);
    expect(getInFlightDesktopSessions().sort()).toEqual(['lane-a', 'lane-b']);

    submitMessage(
      'wake',
      {
        sessionId: 'dw-drive-run-x',
        silent: true,
        origin: 'system-event',
        driveProjectId: 'run-x',
        driveTurnId: 'dt-1',
      },
      fakeGetWindow,
    );
    await vi.waitFor(() => expect(h.queryMock).toHaveBeenCalledTimes(3));
    expect(sdkOptionsOfCall(2).resume).toBe('dw-drive-run-x');
    expect(sdkOptionsOfCall(2).continue).toBeUndefined();
    expect(getInFlightDesktopSessions()).toHaveLength(3);

    for (const hang of hangs) hang.release();
    await vi.waitFor(() => expect(getInFlightDesktopSessions()).toEqual([]));
    expect(getDesktopLane('lane-a').sdkActiveSessionId).toBe('lane-a');
    expect(getDesktopLane('lane-b').sdkActiveSessionId).toBe('lane-b');
  });

  it('segundo turno da MESMA lane tambem usa resume (desktop nunca continue, mesmo com a thread viva no processo)', async () => {
    h.getSessionMessagesMock.mockImplementation(() => [{ id: 1 }]);
    submitMessage('um', { sessionId: 'lane-c', silent: true }, fakeGetWindow);
    submitMessage('dois', { sessionId: 'lane-c', silent: true }, fakeGetWindow);
    await vi.waitFor(() => expect(h.queryMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(getInFlightDesktopSessions()).toEqual([]));
    expect(sdkOptionsOfCall(0).resume).toBe('lane-c');
    expect(sdkOptionsOfCall(1).resume).toBe('lane-c');
    expect(sdkOptionsOfCall(1).continue).toBeUndefined();
  });
});

describe('5.3: checagem DEFENSIVA de lane no dequeue do turno de drive', () => {
  const driveProject = {
    id: 'proj_a',
    name: 'Demo',
    pipelineType: 'development-v2',
    status: 'running',
    pipelineCurrentPhase: 3,
  };

  function engageOnLaneA(): void {
    h.getHarnessProjectMock.mockReturnValue(driveProject);
    h.isDriveEngagedMock.mockReturnValue(true);
    h.getDriveSessionIdMock.mockReturnValue('lane-A');
  }

  it('turno de P1 enfileirado em B com a coluna apontando para A e descartado', () => {
    engageOnLaneA();
    expect(
      shouldDiscardStaleDriveTurn(
        { sessionId: 'lane-B', origin: 'system-event', driveProjectId: 'proj_a', drivePhase: 3 },
        'lane-B',
      ),
    ).toBe(true);
  });

  it('descarta mesmo com pipelineCurrentPhase null (nao depende do retorno por fase real)', () => {
    h.getHarnessProjectMock.mockReturnValue({ ...driveProject, pipelineCurrentPhase: null });
    h.isDriveEngagedMock.mockReturnValue(true);
    h.getDriveSessionIdMock.mockReturnValue('lane-A');

    expect(
      shouldDiscardStaleDriveTurn(
        { sessionId: 'lane-B', origin: 'system-event', driveProjectId: 'proj_a', drivePhase: 3 },
        'lane-B',
      ),
    ).toBe(true);
  });

  it('turno na PROPRIA lane do drive passa', () => {
    engageOnLaneA();
    expect(
      shouldDiscardStaleDriveTurn(
        { sessionId: 'lane-A', origin: 'system-event', driveProjectId: 'proj_a', drivePhase: 3 },
        'lane-A',
      ),
    ).toBe(false);
  });

  it('projeto NAO engajado nao entra na checagem de lane (fica com os guards antigos)', () => {
    h.getHarnessProjectMock.mockReturnValue(driveProject);
    h.isDriveEngagedMock.mockReturnValue(false);
    h.getDriveSessionIdMock.mockReturnValue('lane-A');

    expect(
      shouldDiscardStaleDriveTurn(
        { sessionId: 'lane-B', origin: 'system-event', driveProjectId: 'proj_a', drivePhase: 3 },
        'lane-B',
      ),
    ).toBe(false);
  });

  it('lane dw-drive-* (workflow) escapa da checagem de lane', () => {
    engageOnLaneA();
    expect(
      shouldDiscardStaleDriveTurn(
        {
          sessionId: 'dw-drive-run-x',
          origin: 'system-event',
          driveProjectId: 'proj_a',
          drivePhase: 3,
        },
        'dw-drive-run-x',
      ),
    ).toBe(false);
  });

  it('turno SEM drivePhase (workflow) escapa por construcao', () => {
    engageOnLaneA();
    expect(
      shouldDiscardStaleDriveTurn({ sessionId: 'lane-B', origin: 'system-event', driveProjectId: 'proj_a' }, 'lane-B'),
    ).toBe(false);
  });

  it('no dequeue, o descarte por lane sinaliza reportDriveTurnComplete(discarded) e nao chama o SDK', async () => {
    vi.mocked(reportDriveTurnComplete).mockClear();
    engageOnLaneA();

    submitMessage(
      'wake do drive',
      {
        sessionId: 'lane-B',
        origin: 'system-event',
        driveProjectId: 'proj_a',
        driveTurnId: 'dt-lane',
        drivePhase: 3,
        silent: true,
      },
      fakeGetWindow,
    );

    await vi.waitFor(() => expect(reportDriveTurnComplete).toHaveBeenCalledWith('proj_a', 'dt-lane', 'discarded'));
    expect(h.queryMock).not.toHaveBeenCalled();
  });
});
