import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const insertRepoGraphTurnUsageMock = vi.fn();
const getLatestUserTurnIndexMock = vi.fn((_sessionId: string) => 3);
vi.mock('../db', () => ({
  insertRepoGraphTurnUsage: (input: unknown) => insertRepoGraphTurnUsageMock(input),
  getLatestUserTurnIndex: (sessionId: string) => getLatestUserTurnIndexMock(sessionId),
  getActiveChatSession: vi.fn(() => null),
}));

import {
  composeMinimalContext,
  renderContextMarkdown,
  prefetchRepoGraphTurnContext,
  MINIMAL_CONTEXT_MAX_FILES,
  MINIMAL_CONTEXT_MAX_SYMBOLS,
  MINIMAL_CONTEXT_MAX_MARKDOWN_BYTES,
  type MinimalContextSources,
} from '../repo-graph/minimal-context';
import {
  setRepoGraphTurnSession,
  clearRepoGraphTurnSession,
  setRepoGraphTurnContext,
} from '../repo-graph/turn-context';
import type { RepoGraphContext, RepoGraphReader, RepoGraphSymbol } from '../repo-graph/types';
import type { StreamChunk } from '../../../src/types';

const ROOT = '/abs/fake-repo';

function makeSymbols(count: number): RepoGraphSymbol[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `sym${i}`,
    kind: 'function',
    filePath: `src/file${i}.ts`,
    startLine: i + 1,
  }));
}

function makeSources(overrides: Partial<MinimalContextSources> = {}): MinimalContextSources {
  return {
    search: vi.fn(async () => ({ symbols: makeSymbols(30) })),
    callers: vi.fn(async () => ({
      symbol: 'sym0',
      related: [{ name: 'callerA', kind: 'function', filePath: 'src/caller.ts' }],
    })),
    files: vi.fn(async () => ({
      files: Array.from({ length: 25 }, (_, i) => ({
        path: `src/extra${i}.ts`,
        nodeCount: 100 - i,
      })),
    })),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRepoGraphTurnSession();
});

describe('composeMinimalContext — caps e paths absolutos (11.2 / AC-7)', () => {
  it('aplica caps de 20 symbols e 10 files', async () => {
    const ctx = await composeMinimalContext(makeSources(), {
      rootPath: ROOT,
      repositoryId: 'repo-1',
      task: 'onde executeQuery e definido?',
    });
    expect(ctx.symbols.length).toBeLessThanOrEqual(MINIMAL_CONTEXT_MAX_SYMBOLS);
    expect(ctx.symbols.length).toBe(20);
    expect(ctx.files.length).toBeLessThanOrEqual(MINIMAL_CONTEXT_MAX_FILES);
    expect(ctx.files.length).toBe(10);
  });

  it('paths de files e symbols sao ABSOLUTOS (join com rootPath quando relativos)', async () => {
    const ctx = await composeMinimalContext(makeSources(), {
      rootPath: ROOT,
      repositoryId: 'repo-1',
      task: 'tarefa',
    });
    for (const f of ctx.files) {
      expect(f.path.startsWith('/')).toBe(true);
      expect(f.path.startsWith(ROOT)).toBe(true);
    }
    for (const s of ctx.symbols) {
      expect(s.file.startsWith(ROOT)).toBe(true);
    }
  });

  it('renderedMarkdown <= 10KB e contem repo/tarefa/simbolos', async () => {
    const ctx = await composeMinimalContext(makeSources(), {
      rootPath: ROOT,
      repositoryId: 'repo-1',
      task: 'minha tarefa',
    });
    expect(Buffer.byteLength(ctx.renderedMarkdown, 'utf8')).toBeLessThanOrEqual(MINIMAL_CONTEXT_MAX_MARKDOWN_BYTES);
    expect(ctx.renderedMarkdown).toContain('## Contexto do repositorio (CodeGraph)');
    expect(ctx.renderedMarkdown).toContain(ROOT);
    expect(ctx.renderedMarkdown).toContain('minha tarefa');
    expect(ctx.renderedMarkdown).toContain('sym0');
  });

  it('falha de callers/files e best-effort (contexto sai sem callEdges)', async () => {
    const sources = makeSources({
      callers: vi.fn(async () => {
        throw new Error('callers indisponivel');
      }),
      files: vi.fn(async () => {
        throw new Error('files indisponivel');
      }),
    });
    const ctx = await composeMinimalContext(sources, {
      rootPath: ROOT,
      repositoryId: 'repo-1',
      task: 'tarefa',
    });
    expect(ctx.callEdges).toBeUndefined();
    expect(ctx.files.length).toBe(10);
  });
});

describe('renderContextMarkdown — limite duro de 10KB com truncamento avisado', () => {
  it('trunca conteudo gigante e avisa', () => {
    const bigFiles = Array.from({ length: 500 }, (_, i) => ({
      path: `${ROOT}/src/um-arquivo-com-nome-bem-grande-${i}.ts`,
      reason: 'x'.repeat(120),
    }));
    const markdown = renderContextMarkdown({
      rootPath: ROOT,
      task: 'tarefa',
      files: bigFiles,
      symbols: [],
      callEdges: [],
    });
    expect(Buffer.byteLength(markdown, 'utf8')).toBeLessThanOrEqual(MINIMAL_CONTEXT_MAX_MARKDOWN_BYTES);
    expect(markdown).toContain('[contexto truncado em 10KB]');
  });

  it('conteudo pequeno passa intacto (sem aviso)', () => {
    const markdown = renderContextMarkdown({
      rootPath: ROOT,
      task: 'tarefa',
      files: [{ path: `${ROOT}/a.ts`, reason: 'define a' }],
      symbols: [{ name: 'a', kind: 'function', file: `${ROOT}/a.ts`, line: 1 }],
      callEdges: [{ from: 'b', to: 'a' }],
    });
    expect(markdown).not.toContain('[contexto truncado em 10KB]');
  });
});

describe('prefetchRepoGraphTurnContext — baseline do turno (A3)', () => {
  const fakeContext: RepoGraphContext = {
    repositoryId: 'repo-1',
    rootPath: ROOT,
    files: [{ path: `${ROOT}/a.ts`, reason: 'define a' }],
    symbols: [{ name: 'a', kind: 'function', file: `${ROOT}/a.ts`, line: 1 }],
    renderedMarkdown: '## Contexto do repositorio (CodeGraph)\nRepo: /abs/fake-repo',
  };

  function makeReader(minimalContext = vi.fn(async () => fakeContext)): RepoGraphReader {
    return { minimalContext } as unknown as RepoGraphReader;
  }

  function setTurnComRepo(): void {
    setRepoGraphTurnSession('sess-1', 'codex-sdk');
    setRepoGraphTurnContext('sess-1', {
      repositoryId: 'repo-1',
      canonicalRootPath: ROOT,
      status: 'ready',
      statsResumo: null,
    });
  }

  it('sem turno (regressao): retorna null SEM tocar reader/db/chunk', async () => {
    const reader = makeReader();
    const emitChunk = vi.fn();
    const result = await prefetchRepoGraphTurnContext('tarefa', {
      sessionId: 'sess-1',
      getReader: async () => reader,
      emitChunk,
    });
    expect(result).toBeNull();
    expect(insertRepoGraphTurnUsageMock).not.toHaveBeenCalled();
    expect(emitChunk).not.toHaveBeenCalled();
  });

  it('turno SEM repo ativo (ctx nao setado pelo hook F6): null sem efeitos', async () => {
    setRepoGraphTurnSession('sess-1', 'codex-sdk');
    const emitChunk = vi.fn();
    const result = await prefetchRepoGraphTurnContext('tarefa', {
      sessionId: 'sess-1',
      getReader: async () => makeReader(),
      emitChunk,
    });
    expect(result).toBeNull();
    expect(insertRepoGraphTurnUsageMock).not.toHaveBeenCalled();
    expect(emitChunk).not.toHaveBeenCalled();
  });

  it('sucesso: turn_usage source prefetch (used=1, metricas) + 1 chunk repo_graph', async () => {
    setTurnComRepo();
    const chunks: StreamChunk[] = [];
    const result = await prefetchRepoGraphTurnContext('onde X e definido?', {
      sessionId: 'sess-1',
      getReader: async () => makeReader(),
      emitChunk: (chunk) => chunks.push(chunk),
    });
    expect(result).not.toBeNull();
    expect(result?.renderedMarkdown).toContain('## Contexto do repositorio (CodeGraph)');

    expect(insertRepoGraphTurnUsageMock).toHaveBeenCalledTimes(1);
    const row = insertRepoGraphTurnUsageMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(row['source']).toBe('prefetch');
    expect(row['used']).toBe(true);
    expect(row['sessionId']).toBe('sess-1');
    expect(row['repositoryId']).toBe('repo-1');
    expect(row['runtime']).toBe('codex-sdk');
    expect(row['toolName']).toBe('repo_graph_minimal_context');
    expect(row['turnIndex']).toBe(3);
    expect(row['resultCount']).toBe(2);
    expect(row['bytesReturned']).toBe(Buffer.byteLength(fakeContext.renderedMarkdown, 'utf8'));

    expect(chunks.length).toBe(1);
    expect(chunks[0]!.type).toBe('repo_graph');
    expect(chunks[0]!.repoGraph?.source).toBe('prefetch');
    expect(chunks[0]!.repoGraph?.used).toBe(true);
  });

  it('falha do reader: runtime-limited (used=0 com reason) NO MAXIMO 1x/turno', async () => {
    setTurnComRepo();
    const reader = makeReader(
      vi.fn(async () => {
        throw new Error('graph corrompido');
      }),
    );
    const chunks: StreamChunk[] = [];
    const deps = { sessionId: 'sess-1', getReader: async () => reader, emitChunk: (c: StreamChunk) => chunks.push(c) };

    const first = await prefetchRepoGraphTurnContext('tarefa', deps);
    expect(first).toBeNull();
    expect(insertRepoGraphTurnUsageMock).toHaveBeenCalledTimes(1);
    const row = insertRepoGraphTurnUsageMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(row['source']).toBe('runtime-limited');
    expect(row['used']).toBe(false);
    expect(row['reason']).toContain('graph corrompido');
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.repoGraph?.source).toBe('runtime-limited');

    const second = await prefetchRepoGraphTurnContext('tarefa', deps);
    expect(second).toBeNull();
    expect(insertRepoGraphTurnUsageMock).toHaveBeenCalledTimes(1);
    expect(chunks.length).toBe(1);
  });
});
