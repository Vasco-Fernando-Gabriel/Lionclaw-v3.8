import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const getSessionActiveRepositoryMock = vi.fn();
const getLocalRepositoryMock = vi.fn();
const insertRepoGraphTurnUsageMock = vi.fn();
vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  insertAuditEntry: vi.fn(),
  getAgent: vi.fn(() => undefined),
  getActiveChatSession: vi.fn(() => null),
  getSessionActiveRepository: (sessionId: string) => getSessionActiveRepositoryMock(sessionId),
  getLocalRepository: (id: string) => getLocalRepositoryMock(id),
  insertRepoGraphTurnUsage: (input: unknown) => insertRepoGraphTurnUsageMock(input),
  getLatestUserTurnIndex: vi.fn(() => 1),
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

const readerMocks = {
  detect: vi.fn(async (_input: unknown) => ({ exists: true, stats: { files: 1 } })),
  search: vi.fn(async (_input: unknown) => ({ symbols: [] })),
  minimalContext: vi.fn(async (_input: unknown) => ({
    repositoryId: 'repo-1',
    rootPath: '/tmp/fake-repo',
    files: [],
    symbols: [],
    renderedMarkdown: '',
  })),
  impact: vi.fn(async (_input: unknown) => ({
    symbol: 'x',
    depth: 2,
    nodeCount: 0,
    edgeCount: 0,
    affected: [],
  })),
  node: vi.fn(async (_input: unknown) => ({ node: null })),
  callers: vi.fn(async (_input: unknown) => ({ symbol: 'x', related: [] })),
  callees: vi.fn(async (_input: unknown) => ({ symbol: 'x', related: [] })),
};
vi.mock('../ipc/repo-graph', () => ({
  getRepoGraphEngine: () => ({ asReader: () => readerMocks }),
}));

import { dispatch, type JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import { setRepoGraphTurnSession, clearRepoGraphTurnSession } from '../repo-graph/turn-context';
import { RepoGraphEngine, type RepoGraphEngineDb, type RepoGraphProvider } from '../repo-graph/engine';
import type { LocalRepositoryRecord } from '../repo-graph/types';

function makeRepo(status: LocalRepositoryRecord['status']): LocalRepositoryRecord {
  return {
    id: 'repo-1',
    name: 'fake-repo',
    rootPath: '/tmp/fake-repo',
    canonicalRootPath: '/tmp/fake-repo',
    gitRoot: null,
    provider: 'codegraph',
    graphPath: null,
    status,
    indexedCommit: null,
    indexedWorktreeHash: null,
    lastIndexedAt: null,
    statsJson: null,
    graphPromptSuppressedGlobal: false,
    settingsJson: '{}',
    createdAt: '',
    updatedAt: '',
  };
}

const ctx: JsonRpcContext = {
  getWindow: () => ({ webContents: { send: vi.fn() } }) as never,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearRepoGraphTurnSession();
  setRepoGraphTurnSession('sess-1', 'claude-sdk');
  getSessionActiveRepositoryMock.mockReturnValue({
    sessionId: 'sess-1',
    repositoryId: 'repo-1',
    graphPromptSuppressed: false,
    attachedAt: '',
    updatedAt: '',
  });
  getLocalRepositoryMock.mockReturnValue(makeRepo('ready'));
});

describe('AC-8 — escrita NAO existe no dispatch agent-facing', () => {
  it.each(['repo_graph_build', 'repo_graph_update', 'repo_graph_sync', 'repo_graph_index'])(
    '%s -> Method not found (-32601)',
    async (method) => {
      const res = await dispatch(ctx, {
        method,
        id: 1,
        params: { ...{ sessionId: 'sess-1' }, repositoryId: 'repo-1' },
      });
      expect(res.result).toBeUndefined();
      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(-32601);
      expect(res.error?.message).toContain('Method not found');
    },
  );

  it('engine.asReader() (visao entregue ao dispatch) nao expoe build/update em runtime', () => {
    const engineDb: RepoGraphEngineDb = {
      upsertLocalRepository: vi.fn(() => makeRepo('ready')),
      getLocalRepository: vi.fn(() => makeRepo('ready')),
      listLocalRepositories: vi.fn(() => []),
      removeLocalRepository: vi.fn(),
      updateLocalRepositoryGraphState: vi.fn(),
      setRepoGraphPromptSuppressedGlobal: vi.fn(),
      insertRepoGraphRun: vi.fn(),
      updateRepoGraphRun: vi.fn(),
      getLatestRepoGraphRun: vi.fn(() => null),
      attachSessionRepository: vi.fn(),
      detachSessionRepository: vi.fn(),
      getSessionActiveRepository: vi.fn(() => null),
      setSessionGraphPromptSuppressed: vi.fn(),
    } as unknown as RepoGraphEngineDb;
    const provider = {
      providerName: 'codegraph',
      detect: vi.fn(),
      search: vi.fn(),
      minimalContext: vi.fn(),
      impact: vi.fn(),
      node: vi.fn(),
      callers: vi.fn(),
      callees: vi.fn(),
      build: vi.fn(),
      update: vi.fn(),
    } as unknown as RepoGraphProvider;

    const reader = new RepoGraphEngine(engineDb, provider).asReader();
    const readerAsRecord = reader as unknown as Record<string, unknown>;
    expect(readerAsRecord['build']).toBeUndefined();
    expect(readerAsRecord['update']).toBeUndefined();
    for (const fn of ['detect', 'search', 'minimalContext', 'impact', 'node', 'callers', 'callees']) {
      expect(typeof readerAsRecord[fn]).toBe('function');
    }
  });
});

describe('os 7 methods reader chegam ao RepoGraphReader', () => {
  it('repo_graph_status compoe detect + record do repo', async () => {
    const res = await dispatch(ctx, { method: 'repo_graph_status', id: 1, params: { ...{ sessionId: 'sess-1' } } });
    expect(res.error).toBeUndefined();
    expect(readerMocks.detect).toHaveBeenCalledTimes(1);
    expect(res.result).toMatchObject({
      repository: { id: 'repo-1', status: 'ready' },
      graphExists: true,
    });
  });

  it.each([
    ['repo_graph_search', { term: 'x' }, 'search'],
    ['repo_graph_minimal_context', { task: 'mapear modulo' }, 'minimalContext'],
    ['repo_graph_impact', { symbol: 'executeQuery' }, 'impact'],
    ['repo_graph_node', { name: 'executeQuery' }, 'node'],
    ['repo_graph_callers', { symbol: 'executeQuery' }, 'callers'],
    ['repo_graph_callees', { symbol: 'executeQuery' }, 'callees'],
  ] as const)('%s despacha para reader.%s', async (method, params, readerFn) => {
    const res = await dispatch(ctx, { method, id: 2, params: { ...{ sessionId: 'sess-1' }, ...params } });
    expect(res.error).toBeUndefined();
    expect(readerMocks[readerFn]).toHaveBeenCalledTimes(1);
    const input = readerMocks[readerFn].mock.calls[0][0] as { rootPath: string };
    expect(input.rootPath).toBe('/tmp/fake-repo');
  });

  it('params invalidos -> { error } sem tocar o reader alem da validacao', async () => {
    const res = await dispatch(ctx, { method: 'repo_graph_search', id: 3, params: { ...{ sessionId: 'sess-1' } } });
    expect(res.result).toEqual({ error: 'term is required' });
    expect(readerMocks.search).not.toHaveBeenCalled();
  });
});

describe('gate de consultabilidade (ready/stale; stale NUNCA bloqueia)', () => {
  it("graph 'absent' -> { error } instrutivo sem tocar o provider", async () => {
    getLocalRepositoryMock.mockReturnValue(makeRepo('absent'));
    const res = await dispatch(ctx, {
      method: 'repo_graph_search',
      id: 4,
      params: { ...{ sessionId: 'sess-1' }, term: 'x' },
    });
    expect(res.result).toEqual({
      error: expect.stringContaining('ainda nao foi criado'),
    });
    expect(readerMocks.search).not.toHaveBeenCalled();
    expect(insertRepoGraphTurnUsageMock).not.toHaveBeenCalled();
  });

  it("graph 'building' -> { error } instrutivo", async () => {
    getLocalRepositoryMock.mockReturnValue(makeRepo('building'));
    const res = await dispatch(ctx, {
      method: 'repo_graph_callers',
      id: 5,
      params: { ...{ sessionId: 'sess-1' }, symbol: 'x' },
    });
    expect(res.result).toEqual({
      error: expect.stringContaining('sendo indexado'),
    });
    expect(readerMocks.callers).not.toHaveBeenCalled();
  });

  it("graph 'stale' continua consultavel", async () => {
    getLocalRepositoryMock.mockReturnValue(makeRepo('stale'));
    const res = await dispatch(ctx, {
      method: 'repo_graph_search',
      id: 6,
      params: { ...{ sessionId: 'sess-1' }, term: 'x' },
    });
    expect(res.error).toBeUndefined();
    expect(readerMocks.search).toHaveBeenCalledTimes(1);
  });

  it("repo_graph_status responde mesmo com graph 'absent' (estado e consultavel)", async () => {
    getLocalRepositoryMock.mockReturnValue(makeRepo('absent'));
    const res = await dispatch(ctx, { method: 'repo_graph_status', id: 7, params: { ...{ sessionId: 'sess-1' } } });
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ repository: { status: 'absent' } });
  });
});
