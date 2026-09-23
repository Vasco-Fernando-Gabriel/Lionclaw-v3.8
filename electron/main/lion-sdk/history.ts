import type { ChatMessage, TimelineTurnWithEvents } from '../../../src/types';
import { groupMessageIntervals, selectExactCompleteRun, type MessageInterval } from '../session-timeline';
import type { LionChatMessage } from './adapters/types';

export interface LionTimelineHistoryOptions {
  messages: ChatMessage[];
  runsByAnchor: Map<number, TimelineTurnWithEvents[]>;
  excludeUserMessageId: number | null;
  seededUserMsg: string;
}

export function selectLionIntervalRun(
  interval: MessageInterval,
  runs: TimelineTurnWithEvents[],
): TimelineTurnWithEvents | null {
  const run = selectExactCompleteRun(runs);
  if (!run || !run.events.some((event) => event.kind === 'user')) return null;
  const assistants = interval.messages.filter((message) => message.role === 'assistant');
  return assistants.length && !assistants.some((message) => message.id === run.assistantMessageId) ? null : run;
}

export function expandLionTimelineInterval(
  interval: MessageInterval,
  runs: TimelineTurnWithEvents[],
): LionChatMessage[] {
  if (!interval.user) return [];
  const assistants = interval.messages.filter((message) => message.role === 'assistant');
  const run = selectLionIntervalRun(interval, runs);
  if (!run)
    return [
      { role: 'user', content: interval.user.content },
      ...assistants.map((message) => ({ role: 'assistant' as const, content: message.content })),
    ];
  const events = run.events.slice().sort((a, b) => a.seq - b.seq);
  const expanded: LionChatMessage[] = [];
  for (const event of events) {
    const reasoning = event.reasoningContent === null ? {} : { reasoning_content: event.reasoningContent };
    if (event.kind === 'assistant_step')
      expanded.push({
        role: 'assistant',
        content: event.content,
        ...reasoning,
        tool_calls: JSON.parse(event.toolCallsJson ?? '[]'),
      });
    else if (event.kind === 'tool_result')
      expanded.push({
        role: 'tool',
        content: event.content,
        tool_call_id: event.toolUseId!,
        name: event.toolName!,
      });
    else if (event.kind === 'assistant_final')
      expanded.push({ role: 'assistant', content: event.content, ...reasoning });
  }
  return [
    { role: 'user', content: events.find((event) => event.kind === 'user')!.content },
    ...(assistants.length === 0
      ? expanded
      : assistants.flatMap((message) =>
          message.id === run.assistantMessageId ? expanded : [{ role: 'assistant' as const, content: message.content }],
        )),
  ];
}

export function buildLionTimelineHistory(opts: LionTimelineHistoryOptions): LionChatMessage[] {
  return [
    ...groupMessageIntervals(opts.messages)
      .filter((interval) => interval.user !== null && interval.user.id !== opts.excludeUserMessageId)
      .flatMap((interval) => expandLionTimelineInterval(interval, opts.runsByAnchor.get(interval.user!.id) ?? [])),
    { role: 'user', content: opts.seededUserMsg },
  ];
}
