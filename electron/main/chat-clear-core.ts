import { createLogger } from './logger';
import {
  getClearingPhase,
  isSessionClearing,
  markSessionClearing,
  setClearingPhase,
  unmarkSessionClearing,
} from './clearing-sessions';
import { DreamingMutexCancelledError, type DreamingMutexRelease } from './dreaming-mutex';
import type { RunCompactionOptions, RunCompactionResult } from './memory-pipeline';
import { DEFAULT_CLEAR_FORCE_SETTLE_MS, type TurnSettleOutcome } from './turn-settle';
import type {
  ChatClearCancelResult,
  ChatClearErrorCode,
  ChatClearResult,
  ChatSession,
  CompactionActivePayload,
  SessionOrchestrator,
} from '../../src/types';

const logger = createLogger('chat-clear');

export const CLEAR_FORCE_SETTLE_MS_SETTING_KEY = 'clear_force_settle_ms';

export const CHAT_CLEAR_ERROR_MESSAGES: Record<ChatClearErrorCode, string> = {
  session_required: 'sessionId obrigatorio para o Clear.',
  session_not_found: 'Sessao nao encontrada.',
  session_not_active: 'A conversa nao esta aberta; so conversa aberta recebe Clear.',
  session_busy: 'A lane esta ocupada (turno em voo, item na fila ou Compactacao em andamento).',
  session_clearing: 'Esta lane ja esta em Clear.',
  drive_active: 'Ha um drive de pipeline ativo nesta lane; pare o drive antes do Clear.',
  empty_session: 'Conversa vazia nao tem Clear.',
  turn_did_not_settle: 'O turno em voo nao assentou no prazo; nada foi arquivado. Tente de novo.',
  clear_cancelled: 'Clear cancelado antes de comecar.',
  clear_not_queued: 'Nao ha Clear na fila para esta lane.',
  'COMPACT-SUMMARY-FAILED': 'O sumarizador falhou; a conversa segue aberta para nova tentativa.',
  'COMPACT-MEMORY-FAILED':
    'O gate de memoria / MEMORY.md / USER.md falhou; a conversa segue aberta para nova tentativa.',
  clear_failed: 'O Clear falhou; a conversa segue aberta.',
};

export interface ClearLaneDeps {
  getSession: (id: string) => ChatSession | undefined;
  countSessionMessages: (id: string) => number;
  isOpenDesktopConversation: (session: ChatSession) => boolean;
  setDreamingStartedAt: (id: string, startedAt: string | null) => void;
  replaceLaneSession: (input: {
    sessionId: string;
    finalStatus: 'archived' | 'compacted';
    orchestrator: SessionOrchestrator | null;
    purgeActivityLog?: boolean;
  }) => { newSessionId: string | null };
  getSessionsWithDreamingStarted: () => ChatSession[];
  getExecutionState: (id: string) => 'streaming' | 'queued' | 'idle';
  isCompacting: (id: string) => boolean;
  listActiveDriveProjectIds: (id: string) => string[];
  stopDrive: (projectId: string, reason: string) => void;
  onLaneClearFinished: (sessionId: string) => void;
  stopSessionQuery: (id: string) => void;
  awaitTurnSettled: (id: string, timeoutMs: number) => Promise<TurnSettleOutcome>;
  readSettleTimeoutMs: () => number;
  acquireDreamingMutex: (opts: { signal: AbortSignal }) => Promise<DreamingMutexRelease>;
  runCompaction: (
    periodStart: Date,
    periodEnd: Date,
    sessionId: string,
    opts: RunCompactionOptions,
  ) => Promise<RunCompactionResult | undefined>;
  resolveModelLabel: () => Promise<string>;
  readDefaultOrchestrator: () => SessionOrchestrator | null;
  closeCodexSession: (id: string) => void;
  emitCompactionActive: (payload: CompactionActivePayload) => void;
  emitSessionsUpdated: (sessionIds: string[]) => void;
  now: () => Date;
}

export interface LaneClearer {
  clearLaneSession: (sessionId: string, opts?: { force?: boolean }) => Promise<ChatClearResult>;
  cancelQueuedClear: (sessionId: string) => ChatClearCancelResult;
  rebuildClearingSessionsOnBoot: () => string[];
}

function compactionStepCodeOf(err: unknown): 'COMPACT-SUMMARY-FAILED' | 'COMPACT-MEMORY-FAILED' | null {
  if (!(err instanceof Error)) return null;
  const code = (err as { code?: unknown }).code;
  return code === 'COMPACT-SUMMARY-FAILED' || code === 'COMPACT-MEMORY-FAILED' ? code : null;
}

function clearError(code: ChatClearErrorCode, detail?: string): ChatClearResult {
  return { ok: false, code, error: detail ?? CHAT_CLEAR_ERROR_MESSAGES[code] };
}

function formatTranscriptDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function buildTranscriptName(sessionId: string, now: Date): string {
  return `${formatTranscriptDate(now)}-${sessionId}`;
}

export function readClearForceSettleMs(readSetting: (key: string) => string | undefined): number {
  const raw = Number.parseInt(readSetting(CLEAR_FORCE_SETTLE_MS_SETTING_KEY) || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLEAR_FORCE_SETTLE_MS;
}

export function createLaneClearer(deps: ClearLaneDeps): LaneClearer {
  const queuedAborts = new Map<string, AbortController>();

  function finish(sessionId: string): void {
    queuedAborts.delete(sessionId);
    unmarkSessionClearing(sessionId);
    deps.emitCompactionActive({ isActive: false, sessionId, source: 'lionclaw' });
  }

  async function clearLaneSession(sessionId: string, opts: { force?: boolean } = {}): Promise<ChatClearResult> {
    if (typeof sessionId !== 'string' || !sessionId) return clearError('session_required');
    const session = deps.getSession(sessionId);
    if (!session) return clearError('session_not_found');
    if (!deps.isOpenDesktopConversation(session)) return clearError('session_not_active');

    const priorPhase = getClearingPhase(sessionId);
    const resumingInterrupted = priorPhase === 'interrupted';
    if (priorPhase && !resumingInterrupted) return clearError('session_clearing');

    const laneBadge = session.laneBadge ?? null;
    const title = session.title ?? '';
    const pausedDriveProjectIds: string[] = [];

    if (!resumingInterrupted) {
      const execution = deps.getExecutionState(sessionId);
      const compacting = deps.isCompacting(sessionId);
      const driveProjectIds = deps.listActiveDriveProjectIds(sessionId);
      const busy = execution !== 'idle' || compacting;

      if (!opts.force) {
        if (busy) return clearError('session_busy');
        if (driveProjectIds.length > 0) return clearError('drive_active');
      }

      if (deps.countSessionMessages(sessionId) === 0 && execution === 'idle') {
        return clearError('empty_session');
      }

      if (opts.force && (busy || driveProjectIds.length > 0)) {
        if (compacting) return clearError('session_busy');
        markSessionClearing(sessionId, 'settling', laneBadge);
        for (const projectId of driveProjectIds) {
          try {
            deps.stopDrive(projectId, 'lane-clear-force');
            pausedDriveProjectIds.push(projectId);
          } catch (err) {
            logger.warn(
              { err: err instanceof Error ? err.message : String(err), projectId, sessionId },
              'clear force: pausa do drive falhou (segue)',
            );
          }
        }
        deps.stopSessionQuery(sessionId);
        const settle = await deps.awaitTurnSettled(sessionId, deps.readSettleTimeoutMs());
        if (!settle.settled) {
          unmarkSessionClearing(sessionId);
          logger.warn({ sessionId, reason: settle.reason }, 'clear force: turno nao assentou; nada arquivado');
          return clearError('turn_did_not_settle');
        }
      }
    }

    const abort = new AbortController();
    queuedAborts.set(sessionId, abort);
    markSessionClearing(sessionId, 'queued', laneBadge);

    let modelLabel = '';
    try {
      modelLabel = await deps.resolveModelLabel();
    } catch (err) {
      logger.warn(
        { sessionId, err: err instanceof Error ? err.message : String(err) },
        'clear: label do modelo de compactacao indisponivel (segue sem label)',
      );
    }
    deps.emitCompactionActive({
      isActive: true,
      sessionId,
      phase: 'queued',
      modelLabel,
      title,
      source: 'lionclaw',
    });

    let release: DreamingMutexRelease;
    try {
      release = await deps.acquireDreamingMutex({ signal: abort.signal });
    } catch (err) {
      finish(sessionId);
      if (err instanceof DreamingMutexCancelledError) return clearError('clear_cancelled');
      const detail = err instanceof Error ? err.message : String(err);
      return clearError('clear_failed', detail);
    }
    queuedAborts.delete(sessionId);

    try {
      if (getClearingPhase(sessionId) !== 'queued') {
        return clearError('clear_cancelled');
      }
      setClearingPhase(sessionId, 'running');
      const startedAt = deps.now();
      deps.setDreamingStartedAt(sessionId, startedAt.toISOString());
      deps.emitCompactionActive({
        isActive: true,
        sessionId,
        phase: 'running',
        modelLabel,
        title,
        source: 'lionclaw',
      });

      const current = deps.getSession(sessionId) ?? session;
      let result: RunCompactionResult | undefined;
      try {
        result = await deps.runCompaction(new Date(current.createdAt), startedAt, sessionId, {
          priorSummary: current.rollingSummary,
          skipDailySummary: true,
          transcriptName: buildTranscriptName(sessionId, startedAt),
          dreamingMutex: 'held',
          onModelLabel: (label) => {
            modelLabel = label;
            deps.emitCompactionActive({
              isActive: true,
              sessionId,
              phase: 'running',
              modelLabel: label,
              title,
              source: 'lionclaw',
            });
          },
        });
      } catch (err) {
        deps.setDreamingStartedAt(sessionId, null);
        const detail = err instanceof Error ? err.message : String(err);
        const stepCode = compactionStepCodeOf(err);
        if (stepCode) {
          logger.error({ sessionId, code: stepCode, err: detail }, 'clear: dreaming recusado (conversa intacta)');
          return clearError(stepCode, detail);
        }
        logger.error({ sessionId, err: detail }, 'clear: dreaming falhou (conversa intacta)');
        return clearError('clear_failed', detail);
      }

      if (!result) {
        deps.setDreamingStartedAt(sessionId, null);
        return clearError('empty_session');
      }

      const replaced = deps.replaceLaneSession({
        sessionId,
        finalStatus: 'compacted',
        orchestrator: deps.readDefaultOrchestrator(),
        purgeActivityLog: true,
      });

      try {
        deps.closeCodexSession(sessionId);
      } catch (err) {
        logger.warn(
          { sessionId, err: err instanceof Error ? err.message : String(err) },
          'clear: fechamento da thread Codex falhou (segue)',
        );
      }

      logger.info(
        {
          sessionId,
          newSessionId: replaced.newSessionId,
          warnings: result.warnings.length,
          pausedDriveProjectIds,
        },
        'clear concluido: conversa compacted, badge herdado pela conversa nova',
      );

      const touched = replaced.newSessionId ? [sessionId, replaced.newSessionId] : [sessionId];
      unmarkSessionClearing(sessionId);
      try {
        deps.onLaneClearFinished(replaced.newSessionId ?? sessionId);
      } catch (err) {
        logger.warn(
          { sessionId, err: err instanceof Error ? err.message : String(err) },
          'clear: notificacao de fim de Clear ao drive falhou (Clear segue concluido)',
        );
      }
      deps.emitSessionsUpdated(touched);

      return {
        ok: true,
        sessionId,
        newSessionId: replaced.newSessionId,
        warnings: result.warnings,
        pausedDriveProjectIds,
      };
    } finally {
      release();
      finish(sessionId);
    }
  }

  function cancelQueuedClear(sessionId: string): ChatClearCancelResult {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, code: 'session_required', error: CHAT_CLEAR_ERROR_MESSAGES.session_required };
    }
    if (getClearingPhase(sessionId) !== 'queued') {
      return { ok: false, code: 'clear_not_queued', error: CHAT_CLEAR_ERROR_MESSAGES.clear_not_queued };
    }
    const abort = queuedAborts.get(sessionId);
    if (!abort) {
      return { ok: false, code: 'clear_not_queued', error: CHAT_CLEAR_ERROR_MESSAGES.clear_not_queued };
    }
    abort.abort();
    return { ok: true, sessionId };
  }

  function rebuildClearingSessionsOnBoot(): string[] {
    const interrupted: string[] = [];
    for (const session of deps.getSessionsWithDreamingStarted()) {
      if (!deps.isOpenDesktopConversation(session)) continue;
      if (isSessionClearing(session.id)) continue;
      markSessionClearing(session.id, 'interrupted', session.laneBadge ?? null);
      interrupted.push(session.id);
    }
    if (interrupted.length > 0) {
      logger.warn({ sessions: interrupted }, 'Clear interrompido reconstruido no boot (state interrupted)');
    }
    return interrupted;
  }

  return { clearLaneSession, cancelQueuedClear, rebuildClearingSessionsOnBoot };
}
