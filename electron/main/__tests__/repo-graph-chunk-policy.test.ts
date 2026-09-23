import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const getActiveChatSessionMock = vi.fn<() => { id: string } | null>(() => null);
const getSessionActiveRepositoryMock = vi.fn();
const getLocalRepositoryMock = vi.fn();
const insertRepoGraphTurnUsageMock = vi.fn();
const getLatestUserTurnIndexMock = vi.fn(() => 7);
vi.mock('../in-flight-desktop-session', () => ({
  getInFlightDesktopSession: () => getActiveChatSessionMock()?.id ?? null,
  setInFlightDesktopSession: () => {},
}));
vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  insertAuditEntry: vi.fn(),
  getAgent: vi.fn(() => undefined),
  getActiveChatSession: () => getActiveChatSessionMock(),
  getSessionActiveRepository: (sessionId: string) => getSessionActiveRepositoryMock(sessionId),
  getLocalRepository: (id: string) => getLocalRepositoryMock(id),
  insertRepoGraphTurnUsage: (input: unknown) => insertRepoGraphTurnUsageMock(input),
  getLatestUserTurnIndex: () => getLatestUserTurnIndexMock(),
}));

vi.mock('../mcp-manager', () => ({ getAllMCPServers: vi.fn(() => []) }));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(async () => null) }));
vi.mock('../skills', () => ({ listSkills: vi.fn(() => []), getSkill: vi.fn() }));
vi.mock('../ask-question', () => ({ sendAskQuestion: vi.fn() }));
vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => vi.fn(async () => ({ behavior: 'allow' })),
}));
vi.mock('../pipeline-control-core', () => ({
  isPipelineWriteAction: () => false,
  pipelineListCore: vi.fn(),
  pipelineInspectCore: vi.fn(),
  pipelineCreateCore: vi.fn(),
  pipelineDriveCore: vi.fn(),
  pipelineReplyCore: vi.fn(),
  pipelineApproveCore: vi.fn(),
  pipelineAbortCore: vi.fn(),
  pipelinePauseCore: vi.fn(),
}));
vi.mock('../preview-open', () => ({ previewOpenCore: vi.fn() }));
vi.mock('../lion-sdk/tools/agent', () => ({ lionAgentDispatch: vi.fn() }));

const searchMock = vi.fn();
const nodeMock = vi.fn();
vi.mock('../ipc/repo-graph', () => ({
  getRepoGraphEngine: () => ({
    asReader: () => ({
      detect: vi.fn(async () => ({ exists: true })),
      search: (input: unknown) => searchMock(input),
      minimalContext: vi.fn(),
      impact: vi.fn(),
      node: (input: unknown) => nodeMock(input),
      callers: vi.fn(),
      callees: vi.fn(),
    }),
  }),
}));

import { dispatch, type JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import { setRepoGraphTurnSession, clearRepoGraphTurnSession } from '../repo-graph/turn-context';
import { RepoGraphEngine, type RepoGraphEngineDb, type RepoGraphProvider } from '../repo-graph/engine';
import type { LocalRepositoryRecord, RepoGraphStatusEvent } from '../repo-graph/types';

const REPO: LocalRepositoryRecord = {
  id: 'repo-1',
  name: 'fake-repo',
  rootPath: '/tmp/fake-repo',
  canonicalRootPath: '/tmp/fake-repo',
  gitRoot: null,
  provider: 'codegraph',
  graphPath: '/tmp/fake-repo/.codegraph/codegraph.db',
  status: 'ready',
  indexedCommit: 'abc',
  indexedWorktreeHash: null,
  lastIndexedAt: '2026-06-10T00:00:00.000Z',
  statsJson: '{"files":3}',
  graphPromptSuppressedGlobal: false,
  settingsJson: '{}',
  createdAt: '2026-06-10 00:00:00',
  updatedAt: '2026-06-10 00:00:00',
};

const sendSpy = vi.fn();
const ctx: JsonRpcContext = {
  getWindow: () => ({ webContents: { send: sendSpy } }) as never,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearRepoGraphTurnSession();
  getLatestUserTurnIndexMock.mockReturnValue(7);
  getSessionActiveRepositoryMock.mockReturnValue({
    sessionId: 'sess-1',
    repositoryId: 'repo-1',
    graphPromptSuppressed: false,
    attachedAt: '',
    updatedAt: '',
  });
  getLocalRepositoryMock.mockReturnValue(REPO);
  searchMock.mockResolvedValue({ symbols: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
  nodeMock.mockResolvedValue({ node: { name: 'executeQuery' } });
});

describe('politica de emissao — 1 chunk por tool USADA, com metrica', () => {
  it('cada chamada usada emite exatamente 1 chunk e 1 linha used=1', async () => {
    setRepoGraphTurnSession('sess-1', 'claude-sdk');
    await dispatch(ctx, { method: 'repo_graph_search', id: 1, params: { ...{ sessionId: 'sess-1' }, term: 'x' } });
    await dispatch(ctx, {
      method: 'repo_graph_node',
      id: 2,
      params: { ...{ sessionId: 'sess-1' }, name: 'executeQuery' },
    });
    clearRepoGraphTurnSession();

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(insertRepoGraphTurnUsageMock).toHaveBeenCalledTimes(2);

    const [channel, chunk] = sendSpy.mock.calls[0];
    expect(channel).toBe('chat:stream');
    expect(chunk.type).toBe('repo_graph');
    expect(chunk.sessionId).toBe('sess-1');
    expect(chunk.repoGraph).toMatchObject({
      sessionId: 'sess-1',
      turnIndex: 7,
      repositoryId: 'repo-1',
      status: 'ready',
      used: true,
      source: 'orchestrator-mcp',
      runtime: 'claude-sdk',
      toolName: 'repo_graph_search',
      resultCount: 3,
    });
    expect(chunk.repoGraph.bytesReturned).toBeGreaterThan(0);
    expect(typeof chunk.repoGraph.durationMs).toBe('number');

    const row = insertRepoGraphTurnUsageMock.mock.calls[0][0];
    expect(row).toMatchObject({
      sessionId: 'sess-1',
      turnIndex: 7,
      repositoryId: 'repo-1',
      source: 'orchestrator-mcp',
      runtime: 'claude-sdk',
      toolName: 'repo_graph_search',
      used: true,
      resultCount: 3,
    });
  });

  it('falha de tool com repo ativo: linha used=0 com reason e SEM chunk', async () => {
    searchMock.mockRejectedValue(new Error('cli explodiu'));
    setRepoGraphTurnSession('sess-1', 'claude-sdk');
    const res = await dispatch(ctx, {
      method: 'repo_graph_search',
      id: 3,
      params: { ...{ sessionId: 'sess-1' }, term: 'x' },
    });
    clearRepoGraphTurnSession();

    expect(res.result).toEqual({ error: 'cli explodiu' });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(insertRepoGraphTurnUsageMock).toHaveBeenCalledTimes(1);
    expect(insertRepoGraphTurnUsageMock.mock.calls[0][0]).toMatchObject({
      used: false,
      reason: 'cli explodiu',
      toolName: 'repo_graph_search',
    });
  });

  it('sem uso no turno = sem chunk e sem linha (NUNCA chunk por turno sem uso)', () => {
    setRepoGraphTurnSession('sess-1', 'claude-sdk');
    clearRepoGraphTurnSession();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(insertRepoGraphTurnUsageMock).not.toHaveBeenCalled();
  });

  it('uso FORA de turno (lanes RM2): erro tipado turn_binding_required, sem chunk e sem linha', async () => {
    getActiveChatSessionMock.mockReturnValue({ id: 'sess-1' });
    const res = await dispatch(ctx, {
      method: 'repo_graph_node',
      id: 4,
      params: { ...{ sessionId: 'sess-1' }, name: 'executeQuery' },
    });

    expect(res.result).toEqual({ error: expect.stringContaining('turn_binding_required') });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(insertRepoGraphTurnUsageMock).not.toHaveBeenCalled();
  });
});

describe('Z3 — build nao gera linha em turn_usage; progresso so em repo_graph_runs', () => {
  function makeEngineDb(): RepoGraphEngineDb & {
    updateRepoGraphRunMock: ReturnType<typeof vi.fn>;
  } {
    const updateRepoGraphRunMock = vi.fn();
    return {
      upsertLocalRepository: vi.fn(() => REPO),
      getLocalRepository: vi.fn(() => REPO),
      listLocalRepositories: vi.fn(() => [REPO]),
      removeLocalRepository: vi.fn(),
      updateLocalRepositoryGraphState: vi.fn(),
      setRepoGraphPromptSuppressedGlobal: vi.fn(),
      insertRepoGraphRun: vi.fn(
        (
          input: Parameters<RepoGraphEngineDb['insertRepoGraphRun']>[0],
        ): ReturnType<RepoGraphEngineDb['insertRepoGraphRun']> => ({
          id: input.id,
          repositoryId: input.repositoryId,
          sessionId: input.sessionId,
          provider: input.provider,
          kind: input.kind,
          status: 'running',
          startedAt: '',
          completedAt: null,
          durationMs: 0,
          output: null,
          error: null,
          statsJson: null,
        }),
      ),
      updateRepoGraphRun: (id: string, patch: unknown) => updateRepoGraphRunMock(id, patch),
      getLatestRepoGraphRun: vi.fn(() => null),
      attachSessionRepository: vi.fn(),
      detachSessionRepository: vi.fn(),
      getSessionActiveRepository: vi.fn(() => null),
      setSessionGraphPromptSuppressed: vi.fn(),
      updateRepoGraphRunMock,
    };
  }

  it('a superficie de CRUD do engine NAO tem insertRepoGraphTurnUsage (estrutural)', () => {
    const dbMock = makeEngineDb();
    expect('insertRepoGraphTurnUsage' in dbMock).toBe(false);
  });

  it('build persiste progresso em repo_graph_runs.output e emite buildProgress throttled (1x/2s)', async () => {
    const dbMock = makeEngineDb();
    const provider: RepoGraphProvider = {
      providerName: 'codegraph',
      detect: vi.fn(async () => ({ exists: true, stats: { files: 3 } })),
      search: vi.fn(),
      minimalContext: vi.fn(),
      impact: vi.fn(),
      node: vi.fn(),
      callers: vi.fn(),
      callees: vi.fn(),
      build: vi.fn(async (input) => {
        input.onProgress?.('linha-1\n');
        input.onProgress?.('linha-2\n');
        return { status: 'done' as const, output: 'linha-1\nlinha-2\n', durationMs: 50 };
      }),
      update: vi.fn(),
    };

    const engine = new RepoGraphEngine(dbMock, provider);
    const events: RepoGraphStatusEvent[] = [];
    const doneEvent = new Promise<void>((resolve) => {
      engine.setStatusEmitter((event) => {
        events.push(event);
        if (event.runStatus && event.runStatus !== 'running') resolve();
      });
    });

    const started = await engine.startRun('repo-1', 'build', null);
    expect(started).toHaveProperty('runId');
    await doneEvent;

    const progressEvents = events.filter((e) => e.buildProgress !== undefined);
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0].buildProgress).toBe('linha-1\n');

    const outputs = dbMock.updateRepoGraphRunMock.mock.calls
      .map(([, patch]) => (patch as { output?: string }).output)
      .filter((o): o is string => typeof o === 'string');
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs[outputs.length - 1]).toBe('linha-1\nlinha-2\n');

    expect(insertRepoGraphTurnUsageMock).not.toHaveBeenCalled();
  });
});
