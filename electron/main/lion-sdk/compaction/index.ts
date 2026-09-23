import { createHash } from 'node:crypto';
import type { TimelineTurnWithEvents } from '../../../../src/types';
import { createLogger } from '../../logger';
import { isChatTimelineReinjectEnabled } from '../../chat-compaction-trigger';
import {
  groupMessageIntervals,
  groupRunsByAnchor,
  selectLatestRun,
  formatToolsBlock,
  type MessageInterval,
} from '../../session-timeline';
import { buildLionTimelineHistory, expandLionTimelineInterval, selectLionIntervalRun } from '../history';
import { getSessionMessages } from '../../db';
import type { LionAdapter, LionChatMessage } from '../adapters/types';
import { COMPACTION_PROMPT_V1 } from './prompt';
import { estimateTokens, getMaxContext } from './token-estimate';
import { getCachedSummary, saveCachedSummary } from './db';

const KEEP_RECENT_TURNS = 12;
export const KEEP_RECENT_INTERVALS = 6;
const logger = createLogger('lion-compaction');

const THRESHOLD_RATIO = 0.7;

function hasUsableHistoryContent(message: { role: string; content: string }): boolean {
  return message.role !== 'assistant' || message.content.trim().length > 0;
}

export interface CompactIfNeededOptions {
  timeline?: { runs: TimelineTurnWithEvents[]; excludeUserMessageId: number | null; fence: number | null };
  sessionId: string;
  newUserMsg: string;
  retryWithoutPersistedUser?: boolean;
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
  const serialized = older.map((m) => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n');

  const messages: LionChatMessage[] = [{ role: 'user', content: `${COMPACTION_PROMPT_V1}\n\n${serialized}` }];

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

async function compactTextMode(opts: CompactIfNeededOptions): Promise<CompactResult> {
  const allDbMessages = getSessionMessages(opts.sessionId);

  const dbMessages =
    opts.compactedUpToMessageId !== undefined
      ? allDbMessages.filter((m) => m.id > (opts.compactedUpToMessageId as number))
      : allDbMessages;

  const eligibleHistory = dbMessages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const history = opts.retryWithoutPersistedUser
    ? eligibleHistory
    : eligibleHistory.slice(0, -1).filter(hasUsableHistoryContent);

  const systemTokens = estimateTokens(opts.systemPrompt);
  const historyTokens = history.reduce((s, m) => s + estimateTokens(m.content), 0);
  const newMsgTokens = estimateTokens(opts.newUserMsg);
  const totalTokens = systemTokens + historyTokens + newMsgTokens;

  const configuredMaxContext = Number.isFinite(opts.maxContextTokens) ? Math.floor(opts.maxContextTokens ?? 0) : 0;
  const maxContext =
    configuredMaxContext > 0 ? configuredMaxContext : getMaxContext(opts.primaryProvider, opts.primaryModel);
  const configuredThresholdRatio = Number.isFinite(opts.thresholdRatio)
    ? (opts.thresholdRatio ?? THRESHOLD_RATIO)
    : THRESHOLD_RATIO;
  const thresholdRatio = Math.min(0.95, Math.max(0.5, configuredThresholdRatio));
  const threshold = thresholdRatio * maxContext;

  const newUserMessage: LionChatMessage = { role: 'user', content: opts.newUserMsg };

  if (history.length <= KEEP_RECENT_TURNS || totalTokens < threshold) {
    return {
      messages: [...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })), newUserMessage],
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

  const cached = getCachedSummary(opts.sessionId, lastOlderId, 'text', '');

  let summaryText: string;
  if (cached) {
    summaryText = cached.summary_text;
  } else {
    opts.emitChunk({ type: 'compacting', isCompacting: true });

    const effectiveAdapter = opts.compactionAdapter ?? opts.primaryAdapter;
    const effectiveModel = opts.compactionModel ?? opts.primaryModel;
    const effectiveProvider = opts.compactionAdapter ? (opts.compactionAdapter.name as string) : opts.primaryProvider;

    let result: { text: string; inputTokens: number; outputTokens: number };
    try {
      result = await compactViaProvider(older, effectiveAdapter, effectiveModel);
    } catch (e) {
      opts.emitChunk({ type: 'compacting', isCompacting: false });
      throw e;
    }
    summaryText = result.text;

    saveCachedSummary(opts.sessionId, lastOlderId, 'text', '', summaryText, effectiveModel, effectiveProvider, {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

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

interface ToolsInterval {
  interval: MessageInterval;
  runs: TimelineTurnWithEvents[];
}

export function computeSelectionHash(intervals: ToolsInterval[]): string {
  return createHash('sha1')
    .update(
      JSON.stringify(
        intervals.map(({ interval, runs }) => {
          const run = selectLatestRun(runs);
          return [
            interval.user!.id,
            run?.seqId ?? 'legacy',
            run?.events.length ?? 0,
            interval.messages.filter((message) => message.role === 'assistant').map((message) => message.id),
          ];
        }),
      ),
    )
    .digest('hex');
}

export function estimateTimelineIntervalTokens(interval: MessageInterval, runs: TimelineTurnWithEvents[]): number {
  const run = selectLionIntervalRun(interval, runs);
  const toolTokens =
    run?.events.reduce(
      (sum, event) => sum + (event.kind === 'assistant_step' ? estimateTokens(event.toolCallsJson ?? '') : 0),
      0,
    ) ?? 0;
  return (
    toolTokens +
    expandLionTimelineInterval(interval, runs).reduce(
      (total, message) => total + estimateTokens(message.content) + estimateTokens(message.reasoning_content ?? ''),
      0,
    )
  );
}

async function compactToolsMode(
  opts: CompactIfNeededOptions,
  timeline: NonNullable<CompactIfNeededOptions['timeline']>,
): Promise<CompactResult> {
  const messages = getSessionMessages(opts.sessionId).filter(
    (message) => timeline.fence === null || message.id > timeline.fence,
  );
  const runsByAnchor = groupRunsByAnchor(timeline.runs);
  const intervals: ToolsInterval[] = groupMessageIntervals(messages)
    .filter((interval) => interval.user !== null && interval.user.id !== timeline.excludeUserMessageId)
    .map((interval) => ({ interval, runs: runsByAnchor.get(interval.user!.id) ?? [] }));
  const configuredMax = Number.isFinite(opts.maxContextTokens) ? Math.floor(opts.maxContextTokens ?? 0) : 0;
  const maxContext = configuredMax > 0 ? configuredMax : getMaxContext(opts.primaryProvider, opts.primaryModel);
  const ratio = Number.isFinite(opts.thresholdRatio) ? (opts.thresholdRatio ?? THRESHOLD_RATIO) : THRESHOLD_RATIO;
  const threshold = maxContext * Math.min(0.95, Math.max(0.5, ratio));
  const fixedTokens = estimateTokens(opts.systemPrompt) + estimateTokens(opts.newUserMsg);
  const tokens = (items: ToolsInterval[]): number =>
    items.reduce((sum, item) => sum + estimateTimelineIntervalTokens(item.interval, item.runs), 0);
  if (fixedTokens + tokens(intervals) < threshold)
    return {
      messages: buildLionTimelineHistory({
        messages,
        runsByAnchor,
        excludeUserMessageId: timeline.excludeUserMessageId,
        seededUserMsg: opts.newUserMsg,
      }),
      compacted: false,
    };
  const older = intervals.slice(0, -KEEP_RECENT_INTERVALS);
  const retained = intervals.slice(-KEEP_RECENT_INTERVALS);
  const summary: LionChatMessage[] = [];
  if (older.length) {
    const lastOlderId = older[older.length - 1].interval.user!.id;
    const hash = computeSelectionHash(older);
    const cached = getCachedSummary(opts.sessionId, lastOlderId, 'tools', hash);
    let text: string;
    if (cached) text = cached.summary_text;
    else {
      const serialized = older.flatMap(({ interval, runs }): LionChatMessage[] => {
        const blocks: LionChatMessage[] = interval.messages
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));
        const run = selectLatestRun(runs);
        const tools = run ? formatToolsBlock(run) : '';
        if (tools) blocks[blocks.length - 1].content += '\n\n' + tools;
        return blocks;
      });
      opts.emitChunk({ type: 'compacting', isCompacting: true });
      try {
        const adapter = opts.compactionAdapter ?? opts.primaryAdapter;
        const model = opts.compactionModel ?? opts.primaryModel;
        const result = await compactViaProvider(serialized, adapter, model);
        text = result.text;
        saveCachedSummary(
          opts.sessionId,
          lastOlderId,
          'tools',
          hash,
          text,
          model,
          opts.compactionAdapter ? adapter.name : opts.primaryProvider,
          result,
        );
      } finally {
        opts.emitChunk({ type: 'compacting', isCompacting: false });
      }
    }
    summary.push({ role: 'system', content: '[Resumo das mensagens anteriores]: ' + text });
  }
  const summaryTokens = summary.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  while (retained.length > 1 && fixedTokens + summaryTokens + tokens(retained) > threshold) retained.shift();
  if (fixedTokens + summaryTokens + tokens(retained) > threshold) {
    logger.warn(
      { sessionId: opts.sessionId, threshold },
      'Lion-SDK: ultimo intervalo inteiro excede o orcamento de contexto',
    );
  }
  return {
    messages: [
      ...summary,
      ...retained.flatMap((item) => expandLionTimelineInterval(item.interval, item.runs)),
      { role: 'user', content: opts.newUserMsg },
    ],
    compacted: summary.length > 0 || retained.length < intervals.length,
  };
}

export async function compactIfNeeded(opts: CompactIfNeededOptions): Promise<CompactResult> {
  return opts.timeline && isChatTimelineReinjectEnabled()
    ? compactToolsMode(opts, opts.timeline)
    : compactTextMode(opts);
}
