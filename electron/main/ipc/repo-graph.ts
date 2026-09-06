import { ipcMain } from 'electron';
import { createLogger } from '../logger';
import {
  upsertLocalRepository,
  getLocalRepository,
  listLocalRepositories,
  removeLocalRepository,
  updateLocalRepositoryGraphState,
  setRepoGraphPromptSuppressedGlobal,
  insertRepoGraphRun,
  updateRepoGraphRun,
  getLatestRepoGraphRun,
  attachSessionRepository,
  detachSessionRepository,
  getSessionActiveRepository,
  setSessionGraphPromptSuppressed,
  getRepoGraphSavingsMetrics,
  getKanbanBoardByRepositoryId,
} from '../db';
import { RepoGraphEngine } from '../repo-graph/engine';
import { CodegraphCliProvider } from '../repo-graph/provider-codegraph';
import type { IpcContext } from './context';
import type {
  LocalRepositoryRecord,
  SessionRepoGraphState,
  RepoGraphSavingsMetrics,
} from '../repo-graph/types';

const logger = createLogger('ipc');

/**
 * registerRepoGraphHandlers — repo mode com CodeGraph no chat (SPEC
 * spec-chat-repo-codegraph.md, secao 6). 13 canais `repo-graph:*` em
 * kebab-case: 12 ipcMain.handle (os 11 da secao 6 + `repo-graph:metrics` da
 * A4/D-5) + 1 broadcast (`repo-graph:on-status`, emitido via webContents.send;
 * o renderer assina com cleanup pelo preload).
 *
 * CONSENTIMENTO ESTRUTURAL (5.2/13.1): `repo-graph:build` e `repo-graph:update`
 * sao os UNICOS caminhos ate o RepoGraphWriter — o dispatch agent-facing (A2)
 * recebe apenas `engine.asReader()`, onde build/update NAO existem. Nenhum
 * agente em nenhum runtime alcanca escrita.
 *
 * Erros em fluxo normal: `{ error: string }` (convencao IPC secao 9), sem throw.
 * O engine recebe o CRUD de db.ts por INJECAO (SQL so em db.ts; engine testavel
 * sem better-sqlite3).
 */

let engineSingleton: RepoGraphEngine | null = null;

/** Engine unico do processo (o jsonrpc da A2 reusa via getRepoGraphEngine). */
export function getRepoGraphEngine(): RepoGraphEngine {
  if (!engineSingleton) {
    engineSingleton = new RepoGraphEngine(
      {
        upsertLocalRepository,
        getLocalRepository,
        listLocalRepositories,
        removeLocalRepository,
        updateLocalRepositoryGraphState,
        setRepoGraphPromptSuppressedGlobal,
        insertRepoGraphRun,
        updateRepoGraphRun,
        getLatestRepoGraphRun,
        attachSessionRepository,
        detachSessionRepository,
        getSessionActiveRepository,
        setSessionGraphPromptSuppressed,
        getKanbanBoardForRepository: getKanbanBoardByRepositoryId,
      },
      new CodegraphCliProvider(),
    );
    // Reconciliacao pos-restart (fire-and-forget, best-effort): run 'running'
    // sem handle in-memory = app reiniciou no meio do build/update. O run
    // orfao vira 'error' e o status do repo e recomputado (ready/absent) -
    // sem isso a badge 'building' fica perpetua e os CTAs ficam desabilitados.
    void engineSingleton.reconcileOrphanRuns();
    // Repos presos em 'error' por binario ausente no add (npm install veio
    // depois): com o binario presente e sem graph no disco, volta a 'absent'
    // para o modal de consentimento/CTA reaparecerem. Estado disjunto do orfao.
    void engineSingleton.reconcileErroredRepos();
  }
  return engineSingleton;
}

export function registerRepoGraphHandlers(ctx: IpcContext): void {
  const engine = getRepoGraphEngine();

  // Broadcast de status/progresso de build pro renderer (canal 12:
  // repo-graph:on-status). Sem janela = no-op silencioso.
  engine.setStatusEmitter((event) => {
    try {
      ctx.getMainWindow()?.webContents.send('repo-graph:on-status', event);
    } catch (err) {
      logger.warn({ err }, 'repo-graph:on-status broadcast failed');
    }
  });

  // repo-graph:list — repositorios registrados (pagina/seletor).
  ipcMain.handle('repo-graph:list', (): LocalRepositoryRecord[] | { error: string } => {
    try {
      return engine.listRepositories();
    } catch (err) {
      logger.error({ err }, 'repo-graph:list failed');
      return { error: (err as Error).message };
    }
  });

  // repo-graph:add-repository(rawPath) — valida/canonicaliza (13.2: realpath +
  // git toplevel) e registra. `../`/symlink que escape -> { error }.
  ipcMain.handle(
    'repo-graph:add-repository',
    async (_event, rawPath: string): Promise<LocalRepositoryRecord | { error: string }> => {
      try {
        return await engine.addRepository(rawPath);
      } catch (err) {
        logger.error({ err, rawPath }, 'repo-graph:add-repository failed');
        return { error: (err as Error).message };
      }
    },
  );

  // repo-graph:remove-repository(repositoryId) — remove o registro (attaches e
  // usages caem por FK; run em andamento e cancelado).
  ipcMain.handle(
    'repo-graph:remove-repository',
    (_event, repositoryId: string): { ok: true } | { error: string } => {
      try {
        return engine.removeRepository(repositoryId);
      } catch (err) {
        logger.error({ err, repositoryId }, 'repo-graph:remove-repository failed');
        return { error: (err as Error).message };
      }
    },
  );

  // repo-graph:get-session-state(sessionId) — attach + repo + staleness (check
  // barato 3.5 com throttle) + run ativo. Fonte da badge na troca de sessao.
  ipcMain.handle(
    'repo-graph:get-session-state',
    (_event, sessionId: string): SessionRepoGraphState | { error: string } => {
      try {
        return engine.getSessionState(sessionId);
      } catch (err) {
        logger.error({ err, sessionId }, 'repo-graph:get-session-state failed');
        return { error: (err as Error).message };
      }
    },
  );

  // repo-graph:attach-session(sessionId, repositoryId) — vincula o repo a
  // conversa (1:1 por sessao; re-attach troca o repo).
  ipcMain.handle(
    'repo-graph:attach-session',
    (_event, sessionId: string, repositoryId: string): { ok: true } | { error: string } => {
      try {
        return engine.attachSession(sessionId, repositoryId);
      } catch (err) {
        logger.error({ err, sessionId, repositoryId }, 'repo-graph:attach-session failed');
        return { error: (err as Error).message };
      }
    },
  );

  // repo-graph:detach-session(sessionId) — remove o vinculo da conversa.
  ipcMain.handle(
    'repo-graph:detach-session',
    (_event, sessionId: string): { ok: true } | { error: string } => {
      try {
        return engine.detachSession(sessionId);
      } catch (err) {
        logger.error({ err, sessionId }, 'repo-graph:detach-session failed');
        return { error: (err as Error).message };
      }
    },
  );

  // repo-graph:set-prompt-suppressed(sessionId, suppressed) — "agora nao" da
  // sessao (12.3).
  ipcMain.handle(
    'repo-graph:set-prompt-suppressed',
    (_event, sessionId: string, suppressed: boolean): { ok: true } | { error: string } => {
      try {
        return engine.setPromptSuppressed(sessionId, Boolean(suppressed));
      } catch (err) {
        logger.error({ err, sessionId }, 'repo-graph:set-prompt-suppressed failed');
        return { error: (err as Error).message };
      }
    },
  );

  // repo-graph:set-global-prompt-suppressed(repositoryId, suppressed) — "nao
  // perguntar de novo neste repo" (12.3, flag global do repo).
  ipcMain.handle(
    'repo-graph:set-global-prompt-suppressed',
    (_event, repositoryId: string, suppressed: boolean): { ok: true } | { error: string } => {
      try {
        return engine.setGlobalPromptSuppressed(repositoryId, Boolean(suppressed));
      } catch (err) {
        logger.error({ err, repositoryId }, 'repo-graph:set-global-prompt-suppressed failed');
        return { error: (err as Error).message };
      }
    },
  );

  // repo-graph:metrics — metricas D-5 (formula fixada, secao 19): agregacao
  // read-only em db.ts (getRepoGraphSavingsMetrics), exibida na pagina
  // Repositorios (A4). Canal NOVO no golden snapshot com justificativa.
  ipcMain.handle('repo-graph:metrics', (): RepoGraphSavingsMetrics | { error: string } => {
    try {
      return getRepoGraphSavingsMetrics();
    } catch (err) {
      logger.error({ err }, 'repo-graph:metrics failed');
      return { error: (err as Error).message };
    }
  });

  // repo-graph:status(repositoryId) — detect (fs + status texto best-effort) +
  // staleness lazy.
  ipcMain.handle('repo-graph:status', async (_event, repositoryId: string) => {
    try {
      return await engine.status(repositoryId);
    } catch (err) {
      logger.error({ err, repositoryId }, 'repo-graph:status failed');
      return { error: (err as Error).message };
    }
  });

  // repo-graph:build(repositoryId, sessionId?) — WRITER (so aqui). Cria o run,
  // retorna o runId na hora; progresso/conclusao chegam por repo-graph:on-status.
  // sessionId NULLABLE (Z3: build da UI pode rodar fora de turno).
  ipcMain.handle(
    'repo-graph:build',
    async (
      _event,
      repositoryId: string,
      sessionId?: string | null,
    ): Promise<{ runId: string } | { error: string }> => {
      try {
        return await engine.startRun(repositoryId, 'build', sessionId ?? null);
      } catch (err) {
        logger.error({ err, repositoryId }, 'repo-graph:build failed');
        return { error: (err as Error).message };
      }
    },
  );

  // repo-graph:update(repositoryId, sessionId?) — WRITER (so aqui): codegraph sync.
  ipcMain.handle(
    'repo-graph:update',
    async (
      _event,
      repositoryId: string,
      sessionId?: string | null,
    ): Promise<{ runId: string } | { error: string }> => {
      try {
        return await engine.startRun(repositoryId, 'update', sessionId ?? null);
      } catch (err) {
        logger.error({ err, repositoryId }, 'repo-graph:update failed');
        return { error: (err as Error).message };
      }
    },
  );
}
