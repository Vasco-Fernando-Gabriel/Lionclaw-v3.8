import path from 'path';
import { createLogger } from '../logger';
import type {
  RepoGraphContext,
  RepoGraphContextInput,
  RepoGraphSearchInput,
  RepoGraphSearchResult,
  RepoGraphCallInput,
  RepoGraphCallResult,
  RepoGraphFilesInput,
  RepoGraphFilesResult,
  RepoGraphReader,
} from './types';
import type { RepoGraphChunkPayload, StreamChunk } from '../../../src/types';

const logger = createLogger('repo-graph-minimal-context');

export const MINIMAL_CONTEXT_MAX_FILES = 10;
export const MINIMAL_CONTEXT_MAX_SYMBOLS = 20;
export const MINIMAL_CONTEXT_MAX_MARKDOWN_BYTES = 10 * 1024;

export interface MinimalContextSources {
  search(input: RepoGraphSearchInput): Promise<RepoGraphSearchResult>;
  callers(input: RepoGraphCallInput): Promise<RepoGraphCallResult>;
  files(input: RepoGraphFilesInput): Promise<RepoGraphFilesResult>;
}

export function renderContextMarkdown(input: {
  rootPath: string;
  task: string;
  files: Array<{ path: string; reason: string }>;
  symbols: Array<{ name: string; kind: string; file: string; line?: number }>;
  callEdges: Array<{ from: string; to: string }>;
}): string {
  const lines: string[] = [];
  lines.push(`## Contexto do repositorio (CodeGraph)`);
  lines.push(`Repo: ${input.rootPath}`);
  lines.push(`Tarefa: ${input.task}`);
  if (input.symbols.length > 0) {
    lines.push('', '### Simbolos relevantes');
    for (const s of input.symbols) {
      lines.push(`- ${s.name} (${s.kind}) — ${s.file}${s.line ? `:${s.line}` : ''}`);
    }
  }
  if (input.files.length > 0) {
    lines.push('', '### Arquivos');
    for (const f of input.files) {
      lines.push(`- ${f.path} — ${f.reason}`);
    }
  }
  if (input.callEdges.length > 0) {
    lines.push('', '### Chamadas');
    for (const e of input.callEdges) {
      lines.push(`- ${e.from} -> ${e.to}`);
    }
  }
  let markdown = lines.join('\n');
  if (Buffer.byteLength(markdown, 'utf8') > MINIMAL_CONTEXT_MAX_MARKDOWN_BYTES) {
    const truncNote = '\n\n[contexto truncado em 10KB]';
    const budget = MINIMAL_CONTEXT_MAX_MARKDOWN_BYTES - Buffer.byteLength(truncNote, 'utf8');
    markdown = Buffer.from(markdown, 'utf8').subarray(0, budget).toString('utf8') + truncNote;
  }
  return markdown;
}

export async function composeMinimalContext(
  sources: MinimalContextSources,
  input: RepoGraphContextInput,
): Promise<RepoGraphContext> {
  const search = await sources.search({
    rootPath: input.rootPath,
    term: input.task,
    limit: MINIMAL_CONTEXT_MAX_SYMBOLS,
  });
  const symbols = search.symbols.slice(0, MINIMAL_CONTEXT_MAX_SYMBOLS);

  const callEdges: Array<{ from: string; to: string }> = [];
  const top = symbols[0];
  if (top) {
    try {
      const callers = await sources.callers({
        rootPath: input.rootPath,
        symbol: top.name,
        limit: 10,
      });
      for (const c of callers.related) callEdges.push({ from: c.name, to: top.name });
    } catch (err) {
      logger.warn({ err, symbol: top.name }, 'minimalContext: callers falhou (best-effort)');
    }
  }

  const fileReasons = new Map<string, string>();
  for (const sym of symbols) {
    if (sym.filePath && !fileReasons.has(sym.filePath)) {
      fileReasons.set(sym.filePath, `define ${sym.name}`);
    }
    if (fileReasons.size >= MINIMAL_CONTEXT_MAX_FILES) break;
  }
  if (fileReasons.size < MINIMAL_CONTEXT_MAX_FILES) {
    try {
      const all = await sources.files({ rootPath: input.rootPath });
      const byConnection = [...all.files].sort((a, b) => (b.nodeCount ?? 0) - (a.nodeCount ?? 0));
      for (const f of byConnection) {
        if (fileReasons.size >= MINIMAL_CONTEXT_MAX_FILES) break;
        if (!fileReasons.has(f.path)) {
          fileReasons.set(f.path, `arquivo central (${f.nodeCount ?? 0} simbolos)`);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'minimalContext: files falhou (best-effort)');
    }
  }

  const files = [...fileReasons.entries()].slice(0, MINIMAL_CONTEXT_MAX_FILES).map(([p, reason]) => ({
    path: path.isAbsolute(p) ? p : path.join(input.rootPath, p),
    reason,
  }));

  const contextSymbols = symbols.map((s) => ({
    name: s.name,
    kind: s.kind,
    file: path.isAbsolute(s.filePath) ? s.filePath : path.join(input.rootPath, s.filePath),
    line: s.startLine,
  }));

  const renderedMarkdown = renderContextMarkdown({
    rootPath: input.rootPath,
    task: input.task,
    files,
    symbols: contextSymbols,
    callEdges,
  });

  return {
    repositoryId: input.repositoryId,
    rootPath: input.rootPath,
    files,
    symbols: contextSymbols,
    callEdges: callEdges.length > 0 ? callEdges : undefined,
    renderedMarkdown,
  };
}

export interface RepoGraphPrefetchDeps {
  sessionId: string;
  getReader?: () => Promise<RepoGraphReader>;
  emitChunk?: (chunk: StreamChunk) => void;
}

async function emitChunkToActiveWindow(chunk: StreamChunk): Promise<void> {
  try {
    const electron = await import('electron');
    const win = electron.BrowserWindow?.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('chat:stream', chunk);
    }
  } catch (err) {
    logger.debug({ err }, 'emissao de chunk repo_graph (prefetch) sem janela');
  }
}

export async function prefetchRepoGraphTurnContext(
  task: string,
  deps: RepoGraphPrefetchDeps,
): Promise<RepoGraphContext | null> {
  let turnContext: typeof import('./turn-context');
  try {
    turnContext = await import('./turn-context');
  } catch (err) {
    logger.warn({ err }, 'prefetch: turn-context indisponivel');
    return null;
  }

  const sessionId = deps.sessionId;
  const ctx = turnContext.getRepoGraphTurnContext(sessionId);
  if (!ctx) return null;

  const runtime = turnContext.getRepoGraphTurnRuntime(sessionId);
  const emitChunk = deps.emitChunk ?? ((chunk: StreamChunk) => void emitChunkToActiveWindow(chunk));
  const startedMs = Date.now();

  const record = async (input: {
    source: RepoGraphChunkPayload['source'];
    used: boolean;
    reason?: string;
    resultCount: number;
    bytesReturned: number;
  }): Promise<void> => {
    let turnIndex = 0;
    try {
      const db = await import('../db');
      try {
        turnIndex = db.getLatestUserTurnIndex(sessionId);
      } catch (err) {
        logger.warn({ err, sessionId }, 'prefetch: getLatestUserTurnIndex falhou (turnIndex=0)');
      }
      const cryptoMod = await import('crypto');
      db.insertRepoGraphTurnUsage({
        id: cryptoMod.randomUUID(),
        sessionId,
        turnIndex,
        repositoryId: ctx.repositoryId,
        source: input.source,
        runtime,
        toolName: 'repo_graph_minimal_context',
        used: input.used,
        reason: input.reason ?? null,
        resultCount: input.resultCount,
        bytesReturned: input.bytesReturned,
        durationMs: Date.now() - startedMs,
      });
    } catch (err) {
      logger.warn({ err, sessionId }, 'prefetch: persistencia de repo_graph_turn_usage falhou');
    }
    try {
      const repoGraph: RepoGraphChunkPayload = {
        sessionId,
        turnIndex,
        repositoryId: ctx.repositoryId,
        status: ctx.status,
        used: input.used,
        source: input.source,
        runtime,
        toolName: 'repo_graph_minimal_context',
        ...(input.reason ? { reason: input.reason } : {}),
        resultCount: input.resultCount,
        bytesReturned: input.bytesReturned,
        durationMs: Date.now() - startedMs,
      };
      emitChunk({ type: 'repo_graph', sessionId, repoGraph });
    } catch (err) {
      logger.warn({ err, sessionId }, 'prefetch: emissao de chunk repo_graph falhou');
    }
  };

  try {
    const reader = deps.getReader
      ? await deps.getReader()
      : (await import('../ipc/repo-graph')).getRepoGraphEngine().asReader();
    const context = await reader.minimalContext({
      rootPath: ctx.canonicalRootPath,
      repositoryId: ctx.repositoryId,
      task,
    });
    await record({
      source: 'prefetch',
      used: true,
      resultCount: context.files.length + context.symbols.length,
      bytesReturned: Buffer.byteLength(context.renderedMarkdown, 'utf8'),
    });
    return context;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, sessionId }, 'prefetch do repo-graph falhou (turno segue sem baseline)');
    if (turnContext.shouldEmitRuntimeLimited(sessionId)) {
      await record({
        source: 'runtime-limited',
        used: false,
        reason: message,
        resultCount: 0,
        bytesReturned: 0,
      });
    }
    return null;
  }
}
