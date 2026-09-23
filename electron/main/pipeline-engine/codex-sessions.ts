import { createLogger } from '../logger';
import { hasActiveOfficialRun, resetOfficialProjectRunsNow } from '../agent-runtime/codex-session-factory';
import type { CodexSession } from '../codex-runtime/types';
import { getAgent, getPipelinePhaseMessages } from '../db';
import { getLoopPhases, getPhaseAgentId } from './registry';

const logger = createLogger('pipeline-engine');

export interface CodexSessionsPhaseState {
  projectId: string;
  currentPhase: number;
  codexSessions: Map<string, CodexSession>;
}

export function closeCodexSessions(state: CodexSessionsPhaseState): void {
  if (state.codexSessions.size === 0) {
    resetOfficialProjectRunsNow(state.projectId, 'phase-transition-empty');
    return;
  }
  logger.debug(
    { projectId: state.projectId, count: state.codexSessions.size },
    'Closing Codex sessions for phase transition',
  );
  for (const session of state.codexSessions.values()) {
    try {
      session.close();
    } catch (err) {
      logger.warn({ err, projectId: state.projectId }, 'Error closing CodexSession (non-fatal)');
    }
  }
  state.codexSessions.clear();
  resetOfficialProjectRunsNow(state.projectId, 'phase-transition');
}

export function hasCodexSessionForPhase(state: CodexSessionsPhaseState, phase: number): boolean {
  for (const key of state.codexSessions.keys()) {
    const lastColon = key.lastIndexOf(':');
    if (lastColon === -1) continue;
    const suffix = key.slice(lastColon + 1);
    if (Number(suffix) === phase) return true;
  }
  return false;
}

export interface CodexGateContext {
  hasCodexSessionForPhase(state: CodexSessionsPhaseState, phase: number): boolean;
}

export function maybeKillIdleCodexOnGate(
  ctx: CodexGateContext,
  projectId: string,
  state: CodexSessionsPhaseState,
  project: { pipelineType?: string },
): void {
  const phase = state.currentPhase;

  if (getLoopPhases(project).has(phase)) return;

  const phaseAgentId = getPhaseAgentId(phase, project);
  const usouCodex =
    (phaseAgentId !== undefined && getAgent(phaseAgentId)?.runtime === 'codex') ||
    ctx.hasCodexSessionForPhase(state, phase);
  if (!usouCodex) return;

  const hasOfficial = hasActiveOfficialRun({ surface: 'pipeline', projectId });
  if (!hasOfficial) return;

  resetOfficialProjectRunsNow(projectId, 'pipeline-gate');
  logger.info(
    { projectId, phase, phaseAgentId },
    'maybeKillIdleCodexOnGate: pool Codex resetado no gate (fase deixada usou Codex)',
  );
}

const TRANSIENT_CODEX_SESSION_ERROR_PATTERNS: readonly string[] = [
  'codex app-server exited',
  'app-server transport closed',
  'CodexSession is already closed',
  'Cannot reply: no active threadId',
  'turn/start failed: app-server transport closed',
];

export function isTransientCodexSessionError(message: string): boolean {
  return TRANSIENT_CODEX_SESSION_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

const RESUME_HISTORY_CHAR_BUDGET = 60_000;

export function buildCodexResumePrompt(opts: {
  projectId: string;
  phaseNumber: number;
  preamble: string;
  userMessage: string;
}): string {
  let history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  try {
    history = getPipelinePhaseMessages(opts.projectId, opts.phaseNumber);
  } catch (err) {
    logger.warn(
      { projectId: opts.projectId, phaseNumber: opts.phaseNumber, err },
      'buildCodexResumePrompt: failed to read phase history (continuing without it)',
    );
  }

  const lines: string[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    const content = (entry.content ?? '').trim();
    if (!content) continue;
    const line = `[${entry.role === 'user' ? 'usuario' : 'assistente'}]: ${content}`;
    if (lines.length > 0 && used + line.length > RESUME_HISTORY_CHAR_BUDGET) break;
    lines.unshift(line);
    used += line.length;
  }
  const historyBlock = lines.length > 0 ? lines.join('\n\n') : '(sem historico persistido nesta fase)';

  return (
    `[RETOMADA DE SESSAO] A sessao anterior do Codex desta fase foi encerrada ` +
    `(processo ocioso finalizado). Voce esta numa sessao NOVA: use o contexto ` +
    `abaixo para retomar exatamente de onde parou. NAO recomece a fase do zero.\n\n` +
    `${opts.preamble.trim()}\n\n` +
    `## Historico da conversa desta fase (ordem cronologica)\n${historyBlock}\n\n` +
    `## Mensagem do usuario\n${opts.userMessage}`
  );
}
