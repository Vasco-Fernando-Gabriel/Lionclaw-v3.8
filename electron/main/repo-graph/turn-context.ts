/**
 * repo-graph/turn-context.ts
 *
 * Contexto de execucao do TURNO do chat (Z2 — SPEC spec-chat-repo-codegraph.md,
 * secao 5.1). O hook ADITIVO F6 do orchestrator (executeQuery) SETA o sessionId
 * REAL do turno em execucao no inicio e LIMPA no finally, DEPOIS do dispatch do
 * runtime retornar. Subagents disparados dentro do turno herdam o mesmo
 * contexto (mesmo processo main).
 *
 * O caminho jsonrpc agent-facing (methods repo_graph_* em
 * local-ipc/jsonrpc-methods.ts) LE este contexto como fonte PRIMARIA da
 * resolucao de sessao -> repo; o fallback documentado e getActiveChatSession()
 * (ver resolveRepoGraphSessionId abaixo).
 *
 * Tambem carrega o estado por-turno da politica anti-ruido de emissao (secao
 * 8): runtime-limited emite NO MAXIMO 1 chunk por turno; o RepoChatContext do
 * turno alimenta a secao condicional de prompt (prompt-builder-repo-graph.ts).
 *
 * Estado em RAM, single-turn (a fila do chat processa 1 mensagem por vez na
 * lane desktop). Nao persiste nada; nao importa electron.
 */

// Namespace import (e nao named): o fallback so toca db.getActiveChatSession
// quando chamado, e mocks parciais de '../db' em testes de OUTROS modulos que
// importam este arquivo nao quebram no import (ABI trap / vi.mock factory).
import * as db from '../db';
import { createLogger } from '../logger';
import type { LocalRepositoryStatus } from './types';

const logger = createLogger('repo-graph-turn-context');

/**
 * RepoChatContext (secao 9): contexto compacto do repo ativo do turno, montado
 * pelo hook F6 SOMENTE quando o graph esta ready/stale. Alimenta a secao
 * condicional de prompt nos 4 runtimes e os campos runtime/source das metricas.
 */
export interface RepoChatContext {
  repositoryId: string;
  canonicalRootPath: string;
  status: Extract<LocalRepositoryStatus, 'ready' | 'stale'>;
  /** Resumo curto das stats do graph (ex: "142 arquivos, 3801 simbolos"). */
  statsResumo: string | null;
}

interface RepoGraphTurnState {
  sessionId: string | null;
  /** Runtime do turno em execucao (claude-sdk | claude-compat-sdk | codex-sdk | lion-sdk). */
  runtime: string | null;
  context: RepoChatContext | null;
  /** Politica anti-ruido (8): runtime-limited ja emitido neste turno? */
  runtimeLimitedEmitted: boolean;
}

const state: RepoGraphTurnState = {
  sessionId: null,
  runtime: null,
  context: null,
  runtimeLimitedEmitted: false,
};

/** Seta o sessionId REAL do turno (inicio do executeQuery, hook F6). */
export function setRepoGraphTurnSession(sessionId: string, runtime?: string): void {
  state.sessionId = sessionId;
  state.runtime = runtime ?? null;
  state.context = null;
  state.runtimeLimitedEmitted = false;
}

/**
 * Limpa o contexto do turno. Chamado no `finally` do executeQuery, DEPOIS do
 * dispatch do runtime retornar (Z2).
 */
export function clearRepoGraphTurnSession(): void {
  state.sessionId = null;
  state.runtime = null;
  state.context = null;
  state.runtimeLimitedEmitted = false;
}

/** Fonte PRIMARIA: sessionId setado pelo hook do turno (null fora de turno). */
export function getRepoGraphTurnSession(): string | null {
  return state.sessionId;
}

/** Runtime do turno em execucao (null fora de turno). */
export function getRepoGraphTurnRuntime(): string | null {
  return state.runtime;
}

/** Guarda o RepoChatContext montado pelo hook F6 (graph ready/stale). */
export function setRepoGraphTurnContext(context: RepoChatContext): void {
  state.context = context;
}

/** RepoChatContext do turno (null = sem repo ativo / graph nao consultavel). */
export function getRepoGraphTurnContext(): RepoChatContext | null {
  return state.context;
}

/**
 * Resolucao SERVER-SIDE da sessao em 2 camadas (Z2):
 *  1. contexto de execucao do turno (fonte primaria, setado pelo hook F6);
 *  2. fallback documentado abaixo.
 *
 * Limitacao do fallback: getActiveChatSession resolve por status='active' +
 * updated_at DESC (db.ts:~2919) e pode apontar a SESSAO ERRADA em chamada
 * longa, troca de conversa ou pos-compaction; e fallback, nunca fonte primaria.
 */
export function resolveRepoGraphSessionId(): string | null {
  if (state.sessionId) return state.sessionId;
  try {
    return db.getActiveChatSession()?.id ?? null;
  } catch (err) {
    logger.warn({ err }, 'fallback getActiveChatSession falhou (sem sessao resolvida)');
    return null;
  }
}

/**
 * Politica anti-ruido (secao 8): chunk `source:'runtime-limited'` e emitido NO
 * MAXIMO 1x por turno. Retorna true SOMENTE na primeira chamada do turno (e
 * marca como emitido); fora de turno retorna false (nada a emitir).
 */
export function shouldEmitRuntimeLimited(): boolean {
  if (!state.sessionId) return false;
  if (state.runtimeLimitedEmitted) return false;
  state.runtimeLimitedEmitted = true;
  return true;
}
