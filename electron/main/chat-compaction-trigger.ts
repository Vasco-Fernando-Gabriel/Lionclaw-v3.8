import { getSession, getSessionOrchestrator, getSetting } from './db';
import { getContextWindow } from './agent-runtime/model-context-windows';
import { compactChatSessionInPlace } from './chat-compaction-inplace';
import { isSessionClearing } from './clearing-sessions';
import {
  DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT,
  CHAT_COMPACTION_TRIGGER_PERCENT_SETTING_KEY,
  CHAT_AUTO_COMPACTION_ENABLED_SETTING_KEY,
  CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY,
  DEFAULT_DYNAMIC_WORKFLOW_DRIVE_COMPACTION_TOKENS,
  DYNAMIC_WORKFLOW_DRIVE_COMPACTION_TOKENS_SETTING_KEY,
  DYNAMIC_WORKFLOW_DRIVE_SESSION_PREFIX,
} from './chat-compaction-defaults';
import { buildExecutionError } from './agent-runtime/llm-error';
import { createLogger } from './logger';
import type { StreamChunk } from '../../src/types';

const logger = createLogger('chat-compaction');

export const CHAT_COMPACTION_MIN_SAVINGS_PERCENT = 10;

export const CHAT_COMPACTION_THRASHING_LIMIT = 2;

export const CHAT_COMPACTION_FAILURE_COOLDOWN_MS = 45_000;

interface ChatCompactionGuardState {
  consecutiveIneffective: number;
  stoppedByThrashing: boolean;
  cooldownUntilMs?: number;
}

const guardStates = new Map<string, ChatCompactionGuardState>();

function getGuardState(sessionId: string): ChatCompactionGuardState {
  let state = guardStates.get(sessionId);
  if (!state) {
    state = { consecutiveIneffective: 0, stoppedByThrashing: false };
    guardStates.set(sessionId, state);
  }
  return state;
}

export function __resetChatCompactionGuardsForTests(): void {
  guardStates.clear();
}

export function isChatAutoCompactionEnabled(): boolean {
  return getSetting(CHAT_AUTO_COMPACTION_ENABLED_SETTING_KEY) !== 'false';
}

export function isChatTimelineReinjectEnabled(): boolean {
  return getSetting(CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY) === 'true';
}

export function resolveChatCompactionTriggerPercent(): number {
  const raw = parseInt(
    getSetting(CHAT_COMPACTION_TRIGGER_PERCENT_SETTING_KEY) || String(DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT),
    10,
  );
  if (!Number.isFinite(raw)) return DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT;
  return Math.min(95, Math.max(50, raw));
}

export interface ChatCompactionTurnModel {
  model: string;
  provider?: string;
}

export function getChatCompactionThreshold(
  turnModel?: ChatCompactionTurnModel,
  sessionId?: string,
): number | undefined {
  let model: string;
  let provider: string | undefined;
  if (turnModel) {
    model = turnModel.model.trim();
    provider = turnModel.provider;
  } else if (sessionId) {
    const laneModel = getSessionOrchestrator(sessionId);
    model = (laneModel?.model ?? '').trim();
    provider = laneModel?.provider;
    if (!model) {
      logger.warn({ sessionId }, 'chat: lane sem colunas de orquestrador; gatilho de compactacao desligado (RM7)');
      return undefined;
    }
  } else {
    model = (getSetting('orchestrator_model') ?? '').trim();
    provider = getSetting('orchestrator_provider') || undefined;
  }
  if (!model) return undefined;
  const contextWindow = getContextWindow(model, provider);
  if (contextWindow === undefined || contextWindow <= 0) return undefined;
  const byPercent = Math.floor((contextWindow * resolveChatCompactionTriggerPercent()) / 100);
  if (typeof sessionId === 'string' && sessionId.startsWith(DYNAMIC_WORKFLOW_DRIVE_SESSION_PREFIX)) {
    return Math.min(byPercent, resolveDynamicWorkflowDriveCompactionTokens());
  }
  return byPercent;
}

export function resolveDynamicWorkflowDriveCompactionTokens(): number {
  const raw = Number.parseInt(getSetting(DYNAMIC_WORKFLOW_DRIVE_COMPACTION_TOKENS_SETTING_KEY) || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DYNAMIC_WORKFLOW_DRIVE_COMPACTION_TOKENS;
}

export async function maybeCompactChatSession(
  sessionId: string,
  emitChunk?: (chunk: StreamChunk) => void,
  turnModel?: ChatCompactionTurnModel,
): Promise<void> {
  try {
    if (!isChatAutoCompactionEnabled()) return;

    if (isSessionClearing(sessionId)) {
      logger.info({ sessionId }, 'chat: gatilho de compactacao pulado (sessao em Clear)');
      return;
    }
    const session = getSession(sessionId);
    if (!session || session.status !== 'active') return;
    if (session.type !== 'chat' && session.type !== 'manual') return;

    const threshold = getChatCompactionThreshold(turnModel, sessionId);
    if (threshold === undefined) return;

    const tokensAtivos = session.activeContextTokensEst;
    if (tokensAtivos === undefined || tokensAtivos < threshold) return;

    const guard = getGuardState(sessionId);
    if (guard.stoppedByThrashing) {
      return;
    }
    if (guard.cooldownUntilMs !== undefined) {
      if (Date.now() < guard.cooldownUntilMs) {
        logger.info(
          { sessionId, cooldownUntilMs: guard.cooldownUntilMs },
          'chat: gatilho em cooldown pos-falha do sumarizador (AC-A11, skip)',
        );
        return;
      }
      guard.cooldownUntilMs = undefined;
    }

    logger.info({ sessionId, tokensAtivos, threshold }, 'chat: gatilho de compactacao in-place leve atingido (SA-3)');
    if (emitChunk) emitChunk({ type: 'compacting', isCompacting: true });
    let outcome!: Awaited<ReturnType<typeof compactChatSessionInPlace>>;
    try {
      outcome = await compactChatSessionInPlace(sessionId);
    } finally {
      if (emitChunk) emitChunk({ type: 'compacting', isCompacting: false });
    }
    if (!outcome.ok && !outcome.noop && outcome.typedError && emitChunk) {
      emitChunk({
        type: 'error',
        code: outcome.typedError.code,
        error: outcome.typedError.userMessage,
      });
    }

    if (!outcome.ok && !outcome.noop) {
      guard.cooldownUntilMs = Date.now() + CHAT_COMPACTION_FAILURE_COOLDOWN_MS;
      return;
    }
    if (outcome.ok && !outcome.noop) {
      const seedTokens = outcome.seedTokens;
      if (emitChunk && seedTokens !== undefined) {
        const laneModel = turnModel ?? getSessionOrchestrator(sessionId);
        const model = (laneModel?.model ?? '').trim();
        const contextWindow = model ? getContextWindow(model, laneModel?.provider) : undefined;
        if (contextWindow !== undefined && contextWindow > 0) {
          emitChunk({
            type: 'context_usage',
            contextUsage: {
              contextTokens: seedTokens,
              contextWindowTokens: contextWindow,
              compactionThresholdPercent: resolveChatCompactionTriggerPercent(),
              source: 'estimate',
            },
          });
        }
      }
      const savingsPercent =
        seedTokens !== undefined && tokensAtivos > 0 ? ((tokensAtivos - seedTokens) / tokensAtivos) * 100 : undefined;
      const ineffective = savingsPercent !== undefined && savingsPercent < CHAT_COMPACTION_MIN_SAVINGS_PERCENT;
      if (!ineffective) {
        guard.consecutiveIneffective = 0;
        return;
      }
      guard.consecutiveIneffective += 1;
      logger.warn(
        { sessionId, tokensAtivos, seedTokens, savingsPercent, consecutive: guard.consecutiveIneffective },
        'chat: compactacao ineficaz (economia < 10%)',
      );
      if (guard.consecutiveIneffective >= CHAT_COMPACTION_THRASHING_LIMIT) {
        guard.stoppedByThrashing = true;
        const typed = buildExecutionError(
          'COMPACT-SKIPPED',
          `anti-thrashing: ${guard.consecutiveIneffective} compactacoes consecutivas salvando <${CHAT_COMPACTION_MIN_SAVINGS_PERCENT}%`,
        );
        logger.warn(
          { sessionId, consecutive: guard.consecutiveIneffective },
          'chat: anti-thrashing parou o auto-compact desta sessao (AC-A10)',
        );
        if (emitChunk) {
          emitChunk({
            type: 'error',
            code: typed.code,
            error:
              'Compactacao automatica pausada nesta sessao: as ultimas compactacoes quase nao ' +
              'reduziram o contexto. Use o botao compactar ou inicie um novo chat.',
          });
        }
      }
    }
  } catch (err) {
    logger.error({ err, sessionId }, 'chat: falha no gatilho de compactacao (best-effort, nao-fatal)');
  }
}
