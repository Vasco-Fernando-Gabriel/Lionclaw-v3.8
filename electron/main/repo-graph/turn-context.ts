import { createLogger } from '../logger';
import type { LocalRepositoryStatus } from './types';

const logger = createLogger('repo-graph-turn-context');

export interface RepoChatContext {
  repositoryId: string;
  canonicalRootPath: string;
  status: Extract<LocalRepositoryStatus, 'ready' | 'stale'>;
  statsResumo: string | null;
}

interface RepoGraphTurnState {
  runtime: string | null;
  context: RepoChatContext | null;
  runtimeLimitedEmitted: boolean;
}

const turnStates = new Map<string, RepoGraphTurnState>();

export function setRepoGraphTurnSession(sessionId: string, runtime?: string): void {
  turnStates.set(sessionId, {
    runtime: runtime ?? null,
    context: null,
    runtimeLimitedEmitted: false,
  });
}

export function clearRepoGraphTurnSession(sessionId?: string): void {
  if (sessionId === undefined) {
    turnStates.clear();
    return;
  }
  turnStates.delete(sessionId);
}

export function hasRepoGraphTurnSession(sessionId: string): boolean {
  return turnStates.has(sessionId);
}

export function getRepoGraphTurnRuntime(sessionId: string): string | null {
  return turnStates.get(sessionId)?.runtime ?? null;
}

export function setRepoGraphTurnContext(sessionId: string, context: RepoChatContext): void {
  const state = turnStates.get(sessionId);
  if (!state) {
    logger.warn({ sessionId }, 'setRepoGraphTurnContext sem turno registrado para a sessao; ignorado');
    return;
  }
  state.context = context;
}

export function getRepoGraphTurnContext(sessionId: string): RepoChatContext | null {
  return turnStates.get(sessionId)?.context ?? null;
}

export class RepoGraphTurnBindingError extends Error {
  readonly code = 'turn_binding_required' as const;

  constructor(detail: string) {
    super(`turn_binding_required: ${detail}`);
    this.name = 'RepoGraphTurnBindingError';
  }
}

export function resolveRepoGraphSessionId(binding: { sessionId?: string }): string {
  if (!binding.sessionId) {
    logger.warn('resolveRepoGraphSessionId sem sessionId no binding (turn_binding_required)');
    throw new RepoGraphTurnBindingError('a chamada nao trouxe sessionId para resolver a sessao do repo-graph.');
  }
  if (!turnStates.has(binding.sessionId)) {
    logger.warn(
      { sessionId: binding.sessionId },
      'resolveRepoGraphSessionId: sessao sem turno de chat registrado (turn_binding_required)',
    );
    throw new RepoGraphTurnBindingError(`nenhum turno de chat registrado para a sessao ${binding.sessionId}.`);
  }
  return binding.sessionId;
}

export function shouldEmitRuntimeLimited(sessionId: string): boolean {
  const state = turnStates.get(sessionId);
  if (!state) return false;
  if (state.runtimeLimitedEmitted) return false;
  state.runtimeLimitedEmitted = true;
  return true;
}

export function resetRepoGraphTurnContextForTests(): void {
  turnStates.clear();
}
