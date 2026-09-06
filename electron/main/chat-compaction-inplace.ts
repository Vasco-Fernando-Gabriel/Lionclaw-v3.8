
import crypto from 'crypto';
import {
  getDb,
  getSession,
  getSessionMessages,
  getSetting,
  setSessionCompactionState,
  setSessionActiveContextTokens,
} from './db';
import { createLogger } from './logger';
import { estimateTokens } from './token-estimator';
import { summarizeLightweight } from './memory-pipeline';
import {
  buildExecutionError,
  EmptyProviderResponseError,
  type AgentExecutionError,
} from './agent-runtime/llm-error';
import type { ChatMessage } from '../../src/types';

const logger = createLogger('chat-compaction');

import {
  DEFAULT_CHAT_COMPACTION_TARGET_TOKENS,
  CHAT_COMPACTION_TARGET_TOKENS_SETTING_KEY,
} from './chat-compaction-defaults';

export { DEFAULT_CHAT_COMPACTION_TARGET_TOKENS, CHAT_COMPACTION_TARGET_TOKENS_SETTING_KEY };

const compactingChatSessions = new Set<string>();

function readPositiveNumberSetting(key: string, fallback: number): number {
  const raw = getSetting(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildChatCompactionSeed(
  rollingSummary: string,
  messages: ChatMessage[],
  targetTokens: number,
): string {
  const header = `[Resumo da conversa ate aqui]: ${rollingSummary}`;
  const SEPARATOR = '\n\n';
  let remaining = targetTokens - estimateTokens(header);

  const convo = messages.filter(m => m.role === 'user' || m.role === 'assistant');
  const turns: string[] = [];
  let current: string[] = [];
  for (const m of convo) {
    if (m.role === 'user' && current.length > 0) {
      turns.push(current.join('\n'));
      current = [];
    }
    current.push(`[${m.role}] ${m.content}`);
  }
  if (current.length > 0) turns.push(current.join('\n'));

  const included: string[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turnText = turns[i];
    const cost = estimateTokens(SEPARATOR + turnText);
    if (cost <= remaining) {
      included.unshift(turnText);
      remaining -= cost;
      continue;
    }
    if (included.length === 0 && turns.length > 0) {
      const marker = '[turno truncado] ';
      const budgetChars = Math.max(0, (remaining - estimateTokens(SEPARATOR + marker)) * 4);
      const tail = turnText.slice(Math.max(0, turnText.length - budgetChars));
      included.unshift(marker + tail);
    }
    break;
  }

  return included.length > 0 ? header + SEPARATOR + included.join(SEPARATOR) : header;
}

export interface ChatCompactionOutcome {
  ok: boolean;
  noop?: boolean;
  error?: string;
  seedTokens?: number;
  typedError?: AgentExecutionError;
}

export async function compactChatSessionInPlace(sessionId: string): Promise<ChatCompactionOutcome> {
  if (compactingChatSessions.has(sessionId)) {
    return { ok: false, noop: true, error: 'compactacao ja em andamento' };
  }
  const session = getSession(sessionId);
  if (!session || session.status !== 'active' || (session.type !== 'chat' && session.type !== 'manual')) {
    return { ok: false, error: 'sessao de chat ativa nao encontrada' };
  }

  compactingChatSessions.add(sessionId);
  try {
    const boundary = session.compactedUpToMessageId;
    const allMessages = getSessionMessages(sessionId);
    const deltaMessages = boundary !== undefined
      ? allMessages.filter(m => m.id > boundary)
      : allMessages;
    if (deltaMessages.length === 0) {
      logger.info({ sessionId, boundary }, 'chat: nada novo para compactar (delta vazio, no-op)');
      return { ok: true, noop: true };
    }

    let result: Awaited<ReturnType<typeof summarizeLightweight>>;
    try {
      result = await summarizeLightweight(sessionId, {
        sinceMessageId: boundary,
        priorSummary: session.rollingSummary,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, sessionId }, 'chat: compactacao leve abortada (summarizer falhou); contexto intacto');
      const typedError: AgentExecutionError = err instanceof EmptyProviderResponseError
        ? {
            code: err.code,
            category: err.category,
            userMessage: err.userMessage,
            suggestedAction: err.suggestedAction,
            raw: err.message,
          }
        : buildExecutionError('COMPACT-EMPTY', msg);
      return { ok: false, error: msg, typedError };
    }
    if (!result) {
      logger.info({ sessionId }, 'chat: summarizeLightweight sem mensagens no delta (no-op)');
      return { ok: true, noop: true };
    }

    const newRollingSummary = result.executiveSummary;

    const targetTokens = readPositiveNumberSetting(
      CHAT_COMPACTION_TARGET_TOKENS_SETTING_KEY,
      DEFAULT_CHAT_COMPACTION_TARGET_TOKENS,
    );
    const seed = buildChatCompactionSeed(newRollingSummary, allMessages, targetTokens);

    const newBoundary = deltaMessages[deltaMessages.length - 1].id;

    const newSdkThreadId = crypto.randomUUID();
    getDb().transaction(() => {
      setSessionCompactionState(sessionId, {
        compactedUpToMessageId: newBoundary,
        rollingSummary: newRollingSummary,
        pendingSeed: seed,
        sdkSessionId: newSdkThreadId,
      });
      setSessionActiveContextTokens(sessionId, estimateTokens(seed));
    })();

    logger.info(
      { sessionId, newBoundary, seedTokens: estimateTokens(seed), sdkThreadId: newSdkThreadId },
      'chat: compactacao in-place leve concluida (mesma sessao, thread SDK nova)',
    );
    return { ok: true, seedTokens: estimateTokens(seed) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sessionId }, 'chat: falha inesperada na compactacao in-place leve (nao-fatal)');
    return { ok: false, error: msg };
  } finally {
    compactingChatSessions.delete(sessionId);
  }
}
