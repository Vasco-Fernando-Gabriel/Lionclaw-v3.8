
import { getSessionMessages } from '../../db';
import type { LionAdapter, LionChatMessage } from '../adapters/types';
import { COMPACTION_PROMPT_V1 } from './prompt';
import { estimateTokens, getMaxContext } from './token-estimate';
import { getCachedSummary, saveCachedSummary } from './db';

const KEEP_RECENT_TURNS = 12;

const THRESHOLD_RATIO = 0.70;

function hasUsableHistoryContent(message: { role: string; content: string }): boolean {
  return message.role !== 'assistant' || message.content.trim().length > 0;
}

export interface CompactIfNeededOptions {
  sessionId: string;
  newUserMsg: string;
  systemPrompt: string;
  primaryAdapter: LionAdapter;
  primaryModel: string;
  primaryProvider: string;
  maxContextTokens?: number;
  thresholdRatio?: number;
  compactionAdapter?: LionAdapter;
  compactionModel?: string;
  compactedUpToMessageId?: number;
  emitChunk: (chunk: { type: 'compacting'; isCompacting: boolean }) => void;
}

export interface CompactResult {
  messages: LionChatMessage[];
  compacted: boolean;
}

async function compactViaProvider(
  older: LionChatMessage[],
  adapter: LionAdapter,
  model: string,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const serialized = older
    .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join('\n\n');

  const messages: LionChatMessage[] = [
    { role: 'user', content: `${COMPACTION_PROMPT_V1}\n\n${serialized}` },
  ];

  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const ev of adapter.streamCompletion({ model, messages })) {
    if (ev.type === 'text') {
      text += ev.delta;
    } else if (ev.type === 'usage') {
      inputTokens = ev.usage.inputTokens;
      outputTokens = ev.usage.outputTokens;
    } else if (ev.type === 'error') {
      throw new Error(`compactViaProvider: adapter error: ${ev.error}`);
    }
  }

  if (!text.trim()) {
    throw new Error('compactViaProvider: resposta vazia do adapter.');
  }

  return { text, inputTokens, outputTokens };
}

export async function compactIfNeeded(
  opts: CompactIfNeededOptions,
): Promise<CompactResult> {
  const allDbMessages = getSessionMessages(opts.sessionId);

  const dbMessages =
    opts.compactedUpToMessageId !== undefined
      ? allDbMessages.filter((m) => m.id > (opts.compactedUpToMessageId as number))
      : allDbMessages;

  const history = dbMessages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(0, -1)
    .filter(hasUsableHistoryContent);

  const systemTokens = estimateTokens(opts.systemPrompt);
  const historyTokens = history.reduce((s, m) => s + estimateTokens(m.content), 0);
  const newMsgTokens = estimateTokens(opts.newUserMsg);
  const totalTokens = systemTokens + historyTokens + newMsgTokens;

  const configuredMaxContext = Number.isFinite(opts.maxContextTokens)
    ? Math.floor(opts.maxContextTokens ?? 0)
    : 0;
  const maxContext =
    configuredMaxContext > 0
      ? configuredMaxContext
      : getMaxContext(opts.primaryProvider, opts.primaryModel);
  const configuredThresholdRatio = Number.isFinite(opts.thresholdRatio)
    ? opts.thresholdRatio ?? THRESHOLD_RATIO
    : THRESHOLD_RATIO;
  const thresholdRatio = Math.min(0.95, Math.max(0.50, configuredThresholdRatio));
  const threshold = thresholdRatio * maxContext;

  const newUserMessage: LionChatMessage = { role: 'user', content: opts.newUserMsg };

  if (history.length <= KEEP_RECENT_TURNS || totalTokens < threshold) {
    return {
      messages: [
        ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        newUserMessage,
      ],
      compacted: false,
    };
  }

  const recentDbMessages = history.slice(-KEEP_RECENT_TURNS);
  const olderDbMessages = history.slice(0, -KEEP_RECENT_TURNS);

  const recent: LionChatMessage[] = recentDbMessages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));
  const older: LionChatMessage[] = olderDbMessages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  const lastOlderId = olderDbMessages[olderDbMessages.length - 1].id;

  const cached = getCachedSummary(opts.sessionId, lastOlderId);

  let summaryText: string;
  if (cached) {
    summaryText = cached.summary_text;
  } else {
    opts.emitChunk({ type: 'compacting', isCompacting: true });

    const effectiveAdapter = opts.compactionAdapter ?? opts.primaryAdapter;
    const effectiveModel = opts.compactionModel ?? opts.primaryModel;
    const effectiveProvider = opts.compactionAdapter
      ? (opts.compactionAdapter.name as string)
      : opts.primaryProvider;

    let result: { text: string; inputTokens: number; outputTokens: number };
    try {
      result = await compactViaProvider(older, effectiveAdapter, effectiveModel);
    } catch (e) {
      opts.emitChunk({ type: 'compacting', isCompacting: false });
      throw e;
    }
    summaryText = result.text;

    saveCachedSummary(
      opts.sessionId,
      lastOlderId,
      summaryText,
      effectiveModel,
      effectiveProvider,
      { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    );

    opts.emitChunk({ type: 'compacting', isCompacting: false });
  }

  const summaryBlock: LionChatMessage = {
    role: 'system',
    content: '[Resumo das mensagens anteriores]: ' + summaryText,
  };

  return {
    messages: [summaryBlock, ...recent, newUserMessage],
    compacted: true,
  };
}
