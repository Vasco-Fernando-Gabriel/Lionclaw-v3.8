
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { createLogger } from '../logger';
import { checkRepoStaleness, clearStalenessForRepo } from './staleness';
import { validateRepoRootPath } from './validate-root';
import type {
  LocalRepositoryRecord,
  RepoGraphRunRecord,
  SessionActiveRepositoryRecord,
  RepoGraphReader,
  RepoGraphWriter,
  RepoGraphProviderStatus,
  RepoGraphSearchInput,
  RepoGraphSearchResult,
  RepoGraphContextInput,
  RepoGraphContext,
  RepoGraphImpactInput,
  RepoGraphImpactResult,
  RepoGraphNodeInput,
  RepoGraphNodeResult,
  RepoGraphCallInput,
  RepoGraphCallResult,
  RepoGraphBuildInput,
  RepoGraphRunResult,
  RepoGraphRunKind,
  RepoStalenessResult,
  RepoGraphStatusEvent,
  SessionRepoGraphState,
} from './types';

const logger = createLogger('repo-graph-engine');

export const BUILD_PROGRESS_THROTTLE_MS = 2_000;

export interface RepoGraphEngineDb {
  upsertLocalRepository: (input: {
    id: string;
    name: string;
    rootPath: string;
    canonicalRootPath: string;
    gitRoot: string | null;
    provider?: string;
  }) => LocalRepositoryRecord;
  getLocalRepository: (id: string) => LocalRepositoryRecord | null;
  listLocalRepositories: () => LocalRepositoryRecord[];
  removeLocalRepository: (id: string) => void;
  updateLocalRepositoryGraphState: (
    id: string,
    patch: {
      status?: LocalRepositoryRecord['status'];
      indexedCommit?: string | null;
      indexedWorktreeHash?: string | null;
      lastIndexedAt?: string | null;
      statsJson?: string | null;
      graphPath?: string | null;
    },
  ) => void;
  setRepoGraphPromptSuppressedGlobal: (id: string, suppressed: boolean) => void;
  insertRepoGraphRun: (input: {
    id: string;
    repositoryId: string;
    sessionId: string | null;
    provider: string;
    kind: RepoGraphRunKind;
  }) => RepoGraphRunRecord;
  updateRepoGraphRun: (
    id: string,
    patch: {
      status?: RepoGraphRunRecord['status'];
      completedAt?: string | null;
      durationMs?: number;
      output?: string | null;
      error?: string | null;
      statsJson?: string | null;
    },
  ) => void;
  getLatestRepoGraphRun: (repositoryId: string) => RepoGraphRunRecord | null;
  attachSessionRepository: (sessionId: string, repositoryId: string) => void;
  detachSessionRepository: (sessionId: string) => void;
  getSessionActiveRepository: (sessionId: string) => SessionActiveRepositoryRecord | null;
  setSessionGraphPromptSuppressed: (sessionId: string, suppressed: boolean) => void;
  getKanbanBoardForRepository?: (repositoryId: string) => { prefix: string } | null;
}

export type RepoGraphProvider = RepoGraphReader &
  RepoGraphWriter & { readonly providerName: string };


interface ActiveRunHandle {
  runId: string;
  repositoryId: string;
  controller: AbortController;
}

export class RepoGraphEngine {
  private readonly db: RepoGraphEngineDb;
  private readonly provider: RepoGraphProvider;
  private statusEmitter: ((event: RepoGraphStatusEvent) => void) | null = null;
  private readonly activeRuns = new Map<string, ActiveRunHandle>();

  constructor(db: RepoGraphEngineDb, provider: RepoGraphProvider) {
    this.db = db;
    this.provider = provider;
  }

  setStatusEmitter(emitter: (event: RepoGraphStatusEvent) => void): void {
    this.statusEmitter = emitter;
  }

  private emitStatus(event: RepoGraphStatusEvent): void {
    try {
      this.statusEmitter?.(event);
    } catch (err) {
      logger.warn({ err }, 'emitStatus falhou (listener do renderer)');
    }
  }


  listRepositories(): LocalRepositoryRecord[] {
    return this.db.listLocalRepositories();
  }

  async addRepository(rawPath: string): Promise<LocalRepositoryRecord | { error: string }> {
    const validated = validateRepoRootPath(rawPath);
    if ('error' in validated) return validated;

    const repo = this.db.upsertLocalRepository({
      id: crypto.randomUUID(),
      name: validated.name,
      rootPath: rawPath.trim(),
      canonicalRootPath: validated.canonicalRootPath,
      gitRoot: validated.gitRoot,
      provider: this.provider.providerName,
    });

    try {
      const detect = await this.provider.detect(repo.canonicalRootPath);
      if (detect.error && !detect.exists) {
        logger.warn(
          { repoId: repo.id, error: detect.error },
          'detect inicial: binario do codegraph ausente; mantendo absent (recuperavel no build)',
        );
        if (repo.status !== 'absent' && repo.status !== 'building') {
          this.db.updateLocalRepositoryGraphState(repo.id, { status: 'absent' });
        }
      } else if (detect.exists && repo.status === 'absent') {
        this.db.updateLocalRepositoryGraphState(repo.id, {
          status: 'ready',
          graphPath: `${repo.canonicalRootPath}/.codegraph/codegraph.db`,
          statsJson: detect.stats ? JSON.stringify(detect.stats) : null,
        });
      } else if (!detect.exists && repo.status !== 'absent' && repo.status !== 'building') {
        this.db.updateLocalRepositoryGraphState(repo.id, { status: 'absent' });
      }
    } catch (err) {
      logger.warn({ err, repoId: repo.id }, 'detect inicial falhou (best-effort)');
    }
    return this.db.getLocalRepository(repo.id) as LocalRepositoryRecord;
  }

  removeRepository(repositoryId: string): { ok: true } | { error: string } {
    const repo = this.db.getLocalRepository(repositoryId);
    if (!repo) return { error: `repositorio nao encontrado: ${repositoryId}` };
    const board = this.db.getKanbanBoardForRepository?.(repositoryId);
    if (board) {
      return {
        error: `repositorio possui quadro Kanban (${board.prefix}); delete o quadro antes`,
      };
    }
    this.cancelActiveRun(repositoryId);
    this.db.removeLocalRepository(repositoryId);
    return { ok: true };
  }

  attachSession(
    sessionId: string,
    repositoryId: string,
  ): { ok: true } | { error: string } {
    const repo = this.db.getLocalRepository(repositoryId);
    if (!repo) return { error: `repositorio nao encontrado: ${repositoryId}` };
    this.db.attachSessionRepository(sessionId, repositoryId);
    return { ok: true };
  }

  detachSession(sessionId: string): { ok: true } {
    this.db.detachSessionRepository(sessionId);
    return { ok: true };
  }

  getSessionState(sessionId: string): SessionRepoGraphState {
    const attach = this.db.getSessionActiveRepository(sessionId);
    if (!attach) {
      return { sessionId, repository: null, attach: null, staleness: null, activeRun: null };
    }
    const repository = this.db.getLocalRepository(attach.repositoryId);
    if (!repository) {
      return { sessionId, repository: null, attach, staleness: null, activeRun: null };
    }
    let staleness: RepoStalenessResult | null = null;
    if (repository.status === 'ready' || repository.status === 'stale') {
      staleness = checkRepoStaleness({
        repositoryId: repository.id,
        canonicalRootPath: repository.canonicalRootPath,
        indexedCommit: repository.indexedCommit,
        lastIndexedAt: repository.lastIndexedAt,
      });
      if (staleness.stale && repository.status === 'ready') {
        this.db.updateLocalRepositoryGraphState(repository.id, { status: 'stale' });
      }
    }
    const latestRun = this.db.getLatestRepoGraphRun(repository.id);
    const activeRun =
      latestRun && latestRun.status === 'running' && this.activeRuns.has(repository.id)
        ? latestRun
        : null;
    return {
      sessionId,
      repository: this.db.getLocalRepository(repository.id),
      attach,
      staleness,
      activeRun,
    };
  }

  setPromptSuppressed(sessionId: string, suppressed: boolean): { ok: true } {
    this.db.setSessionGraphPromptSuppressed(sessionId, suppressed);
    return { ok: true };
  }

  setGlobalPromptSuppressed(
    repositoryId: string,
    suppressed: boolean,
  ): { ok: true } | { error: string } {
    const repo = this.db.getLocalRepository(repositoryId);
    if (!repo) return { error: `repositorio nao encontrado: ${repositoryId}` };
    this.db.setRepoGraphPromptSuppressedGlobal(repositoryId, suppressed);
    return { ok: true };
  }

  async status(repositoryId: string): Promise<
    | {
        repository: LocalRepositoryRecord;
        detect: RepoGraphProviderStatus;
        staleness: RepoStalenessResult | null;
      }
    | { error: string }
  > {
    const repo = this.db.getLocalRepository(repositoryId);
    if (!repo) return { error: `repositorio nao encontrado: ${repositoryId}` };
    const detect = await this.provider.detect(repo.canonicalRootPath);
    let staleness: RepoStalenessResult | null = null;
    if (detect.exists && (repo.status === 'ready' || repo.status === 'stale')) {
      staleness = checkRepoStaleness({
        repositoryId: repo.id,
        canonicalRootPath: repo.canonicalRootPath,
        indexedCommit: repo.indexedCommit,
        lastIndexedAt: repo.lastIndexedAt,
      });
      if (staleness.stale && repo.status === 'ready') {
        this.db.updateLocalRepositoryGraphState(repo.id, { status: 'stale' });
      }
    }
    return {
      repository: this.db.getLocalRepository(repositoryId) as LocalRepositoryRecord,
      detect,
      staleness,
    };
  }

  async reconcileOrphanRuns(): Promise<void> {
    for (const repo of this.db.listLocalRepositories()) {
      try {
        const latestRun = this.db.getLatestRepoGraphRun(repo.id);
        if (!latestRun || latestRun.status !== 'running' || this.activeRuns.has(repo.id)) {
          continue;
        }
        this.db.updateRepoGraphRun(latestRun.id, {
          status: 'error',
          completedAt: new Date().toISOString(),
          error: 'interrompido por restart do app',
        });
        const detect = await this.safeDetect(repo.canonicalRootPath);
        const fallback: LocalRepositoryRecord['status'] = detect?.exists ? 'ready' : 'absent';
        this.db.updateLocalRepositoryGraphState(repo.id, { status: fallback });
        clearStalenessForRepo(repo.id);
        logger.warn(
          { repositoryId: repo.id, runId: latestRun.id, status: fallback },
          'run orfao reconciliado (app reiniciou durante build/update)',
        );
        this.emitStatus({
          repositoryId: repo.id,
          sessionId: latestRun.sessionId,
          status: fallback,
          runId: latestRun.id,
          runStatus: 'error',
          kind: latestRun.kind,
          error: 'interrompido por restart do app',
        });
      } catch (err) {
        logger.warn(
          { err, repositoryId: repo.id },
          'reconciliacao de run orfao falhou (best-effort)',
        );
      }
    }
  }

  async reconcileErroredRepos(): Promise<void> {
    for (const repo of this.db.listLocalRepositories()) {
      if (repo.status !== 'error') continue;
      try {
        const detect = await this.safeDetect(repo.canonicalRootPath);
        if (detect && !detect.exists && !detect.error) {
          this.db.updateLocalRepositoryGraphState(repo.id, { status: 'absent' });
          logger.warn(
            { repositoryId: repo.id },
            "repo preso em 'error' sem graph reconciliado para 'absent' (binario disponivel)",
          );
        }
      } catch (err) {
        logger.warn(
          { err, repositoryId: repo.id },
          'reconciliacao de repo error falhou (best-effort)',
        );
      }
    }
  }


  async startRun(
    repositoryId: string,
    kind: RepoGraphRunKind,
    sessionId: string | null,
  ): Promise<{ runId: string } | { error: string }> {
    const repo = this.db.getLocalRepository(repositoryId);
    if (!repo) return { error: `repositorio nao encontrado: ${repositoryId}` };
    if (this.activeRuns.has(repositoryId)) {
      return { error: 'ja existe um build/update em andamento para este repositorio' };
    }

    const runId = crypto.randomUUID();
    this.db.insertRepoGraphRun({
      id: runId,
      repositoryId,
      sessionId,
      provider: this.provider.providerName,
      kind,
    });
    this.db.updateLocalRepositoryGraphState(repositoryId, { status: 'building' });

    const controller = new AbortController();
    this.activeRuns.set(repositoryId, { runId, repositoryId, controller });
    this.emitStatus({ repositoryId, sessionId, status: 'building', runId, runStatus: 'running', kind });

    void this.executeRun(repo, runId, kind, sessionId, controller);
    return { runId };
  }

  cancelActiveRun(repositoryId: string): boolean {
    const handle = this.activeRuns.get(repositoryId);
    if (!handle) return false;
    handle.controller.abort();
    return true;
  }

  private async executeRun(
    repo: LocalRepositoryRecord,
    runId: string,
    kind: RepoGraphRunKind,
    sessionId: string | null,
    controller: AbortController,
  ): Promise<void> {
    let accumulated = '';
    let lastEmitAt = 0;
    let lastPersistAt = 0;
    const onProgress = (chunkText: string): void => {
      accumulated += chunkText;
      const now = Date.now();
      if (now - lastEmitAt >= BUILD_PROGRESS_THROTTLE_MS) {
        lastEmitAt = now;
        this.emitStatus({
          repositoryId: repo.id,
          sessionId,
          status: 'building',
          runId,
          runStatus: 'running',
          kind,
          buildProgress: chunkText,
        });
      }
      if (now - lastPersistAt >= BUILD_PROGRESS_THROTTLE_MS) {
        lastPersistAt = now;
        try {
          this.db.updateRepoGraphRun(runId, { output: accumulated });
        } catch (err) {
          logger.warn({ err, runId }, 'persistencia de progresso falhou');
        }
      }
    };

    const input: RepoGraphBuildInput = {
      rootPath: repo.canonicalRootPath,
      kind,
      onProgress,
      signal: controller.signal,
    };

    let result: RepoGraphRunResult;
    try {
      result = kind === 'build' ? await this.provider.build(input) : await this.provider.update(input);
    } catch (err) {
      result = {
        status: 'error',
        output: accumulated,
        error: (err as Error).message,
        durationMs: 0,
      };
    } finally {
      this.activeRuns.delete(repo.id);
    }

    const completedAt = new Date().toISOString();
    if (result.status === 'done') {
      let statsJson: string | null = null;
      try {
        const detect = await this.provider.detect(repo.canonicalRootPath);
        statsJson = detect.stats ? JSON.stringify(detect.stats) : null;
      } catch {
        statsJson = null;
      }
      const indexedCommit = resolveGitHead(repo.canonicalRootPath);
      const worktreeHash = resolveWorktreeHash(repo.canonicalRootPath);
      this.db.updateRepoGraphRun(runId, {
        status: 'done',
        completedAt,
        durationMs: result.durationMs,
        output: result.output,
        statsJson,
      });
      this.db.updateLocalRepositoryGraphState(repo.id, {
        status: 'ready',
        indexedCommit,
        indexedWorktreeHash: worktreeHash,
        lastIndexedAt: completedAt,
        statsJson,
        graphPath: `${repo.canonicalRootPath}/.codegraph/codegraph.db`,
      });
      clearStalenessForRepo(repo.id);
      this.emitStatus({ repositoryId: repo.id, sessionId, status: 'ready', runId, runStatus: 'done', kind });
      return;
    }

    if (result.status === 'cancelled') {
      this.db.updateRepoGraphRun(runId, {
        status: 'cancelled',
        completedAt,
        durationMs: result.durationMs,
        output: result.output,
      });
      const detectAfterCancel = await this.safeDetect(repo.canonicalRootPath);
      const fallback: LocalRepositoryRecord['status'] = detectAfterCancel?.exists
        ? 'ready'
        : 'absent';
      this.db.updateLocalRepositoryGraphState(repo.id, { status: fallback });
      clearStalenessForRepo(repo.id);
      this.emitStatus({
        repositoryId: repo.id,
        sessionId,
        status: fallback,
        runId,
        runStatus: 'cancelled',
        kind,
      });
      return;
    }

    this.db.updateRepoGraphRun(runId, {
      status: 'error',
      completedAt,
      durationMs: result.durationMs,
      output: result.output,
      error: result.error ?? 'erro desconhecido no build do graph',
    });
    const detectAfterError = await this.safeDetect(repo.canonicalRootPath);
    const fallback: LocalRepositoryRecord['status'] = detectAfterError?.exists
      ? 'stale'
      : 'error';
    this.db.updateLocalRepositoryGraphState(repo.id, { status: fallback });
    clearStalenessForRepo(repo.id);
    this.emitStatus({
      repositoryId: repo.id,
      sessionId,
      status: fallback,
      runId,
      runStatus: 'error',
      kind,
      error: result.error,
    });
  }

  private async safeDetect(rootPath: string): Promise<RepoGraphProviderStatus | null> {
    try {
      return await this.provider.detect(rootPath);
    } catch {
      return null;
    }
  }


  asReader(): RepoGraphReader {
    return {
      detect: (rootPath) => this.provider.detect(rootPath),
      search: (input: RepoGraphSearchInput): Promise<RepoGraphSearchResult> =>
        this.provider.search(input),
      minimalContext: (input: RepoGraphContextInput): Promise<RepoGraphContext> =>
        this.provider.minimalContext(input),
      impact: (input: RepoGraphImpactInput): Promise<RepoGraphImpactResult> =>
        this.provider.impact(input),
      node: (input: RepoGraphNodeInput): Promise<RepoGraphNodeResult> =>
        this.provider.node(input),
      callers: (input: RepoGraphCallInput): Promise<RepoGraphCallResult> =>
        this.provider.callers(input),
      callees: (input: RepoGraphCallInput): Promise<RepoGraphCallResult> =>
        this.provider.callees(input),
    };
  }
}

function resolveGitHead(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function resolveWorktreeHash(cwd: string): string | null {
  try {
    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    return crypto.createHash('sha1').update(porcelain).digest('hex');
  } catch {
    return null;
  }
}
