
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const getActiveChatSessionMock = vi.fn<() => { id: string } | null>(() => null);
const getSessionActiveRepositoryMock = vi.fn((_sessionId: string) => null as unknown);
const insertRepoGraphTurnUsageMock = vi.fn();
vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  insertAuditEntry: vi.fn(),
  getAgent: vi.fn(() => undefined),
  getActiveChatSession: () => getActiveChatSessionMock(),
  getSessionActiveRepository: (sessionId: string) => getSessionActiveRepositoryMock(sessionId),
  getLocalRepository: vi.fn(() => null),
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

const asReaderMock = vi.fn();
vi.mock('../ipc/repo-graph', () => ({
  getRepoGraphEngine: () => ({ asReader: asReaderMock }),
}));

import { dispatch, type JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import {
  setRepoGraphTurnSession,
  clearRepoGraphTurnSession,
  setRepoGraphTurnContext,
} from '../repo-graph/turn-context';
import {
  buildRepoGraphSection,
  getRepoGraphPromptSection,
  appendRepoGraphSection,
  summarizeRepoGraphStats,
} from '../prompt-builder-repo-graph';

const SEVEN_TOOLS = [
  'repo_graph_status',
  'repo_graph_search',
  'repo_graph_minimal_context',
  'repo_graph_impact',
  'repo_graph_node',
  'repo_graph_callers',
  'repo_graph_callees',
];

const sendSpy = vi.fn();
const ctx: JsonRpcContext = {
  getWindow: () => ({ webContents: { send: sendSpy } }) as never,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearRepoGraphTurnSession();
  getSessionActiveRepositoryMock.mockReturnValue(null);
});

describe('AC-1 — prompt sem secao repo-graph (inspecao)', () => {
  it('sem RepoChatContext do turno a secao e vazia e o prompt fica byte-identico', () => {
    const base = '# System prompt do orquestrador\n\nRegras...';
    expect(getRepoGraphPromptSection()).toBe('');
    expect(appendRepoGraphSection(base)).toBe(base);
    for (const tool of SEVEN_TOOLS) {
      expect(appendRepoGraphSection(base)).not.toContain(tool);
    }
  });

  it('COM repo ativo (ctx setado pelo hook F6) a secao entra com as 7 tools pelo nome exato', () => {
    setRepoGraphTurnSession('sess-1', 'claude-sdk');
    setRepoGraphTurnContext({
      repositoryId: 'repo-1',
      canonicalRootPath: '/tmp/fake-repo',
      status: 'ready',
      statsResumo: '12 arquivos, 80 simbolos',
    });
    const prompt = appendRepoGraphSection('# Base');
    expect(prompt.startsWith('# Base')).toBe(true);
    expect(prompt).toContain('/tmp/fake-repo');
    for (const tool of SEVEN_TOOLS) {
      expect(prompt).toContain(tool);
    }
    expect(prompt).toMatch(/Glob\/Grep\/Read em massa/);
    expect(prompt).toMatch(/subagent sem MCP/);
  });

  it('graph stale tambem recebe a secao (stale NUNCA bloqueia, 3.5)', () => {
    setRepoGraphTurnSession('sess-1');
    setRepoGraphTurnContext({
      repositoryId: 'repo-1',
      canonicalRootPath: '/tmp/fake-repo',
      status: 'stale',
      statsResumo: null,
    });
    const section = getRepoGraphPromptSection();
    expect(section).not.toBe('');
    expect(section).toContain('STALE');
  });

  it('buildRepoGraphSection inclui o resumo de stats quando presente', () => {
    const section = buildRepoGraphSection({
      repositoryId: 'repo-1',
      canonicalRootPath: '/tmp/fake-repo',
      status: 'ready',
      statsResumo: '42 arquivos, 99 simbolos',
    });
    expect(section).toContain('42 arquivos, 99 simbolos');
  });

  it('summarizeRepoGraphStats e best-effort (null em JSON invalido/vazio)', () => {
    expect(summarizeRepoGraphStats(null)).toBeNull();
    expect(summarizeRepoGraphStats('nao-json')).toBeNull();
    expect(summarizeRepoGraphStats('{}')).toBeNull();
    expect(summarizeRepoGraphStats('{"files":3,"nodes":10,"edges":20}')).toBe(
      '3 arquivos, 10 simbolos, 20 relacoes',
    );
  });
});

describe('AC-1 — zero chunk e turn_usage vazia (3 turnos simulados)', () => {
  it('3 turnos sem repo ativo: { error } instrutivo, nenhum chunk, nenhuma linha', async () => {
    for (let turno = 1; turno <= 3; turno += 1) {
      setRepoGraphTurnSession('sess-sem-repo', 'claude-sdk');
      try {
        const res = await dispatch(ctx, {
          method: 'repo_graph_search',
          id: turno,
          params: { term: 'executeQuery' },
        });
        expect(res.error).toBeUndefined();
        expect(res.result).toEqual({
          error: expect.stringContaining('nenhum repositorio ativo nesta conversa'),
        });
      } finally {
        clearRepoGraphTurnSession();
      }
    }
    expect(insertRepoGraphTurnUsageMock).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(asReaderMock).not.toHaveBeenCalled();
  });

  it('sem sessao resolvivel (sem turno + sem sessao ativa): { error }, sem efeitos', async () => {
    getActiveChatSessionMock.mockReturnValue(null);
    const res = await dispatch(ctx, {
      method: 'repo_graph_status',
      id: 9,
      params: {},
    });
    expect(res.result).toEqual({
      error: expect.stringContaining('nenhum repositorio ativo nesta conversa'),
    });
    expect(insertRepoGraphTurnUsageMock).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
