import type { ChatMessage } from '../../../src/types';

export const GROK_HISTORY_MAX_TURNS = 8;
export const GROK_HISTORY_MAX_CHARS = 12_000;
export const GROK_HISTORY_MESSAGE_MAX_CHARS = 3_000;

function format(message: ChatMessage): string {
  const role = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : 'System';
  const content = message.content.length > GROK_HISTORY_MESSAGE_MAX_CHARS
    ? `${message.content.slice(0, GROK_HISTORY_MESSAGE_MAX_CHARS)}\n[...message truncated...]`
    : message.content;
  return `${role}: ${content}`;
}

export function buildGrokHistoryPreamble(
  messages: ChatMessage[],
  options: { dropLast?: boolean } = {},
): string {
  const base = (options.dropLast ?? true) ? messages.slice(0, -1) : messages;
  const turns = base
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-GROK_HISTORY_MAX_TURNS);
  const selected: string[] = [];
  let length = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const item = format(turns[index]);
    const next = item.length + (selected.length > 0 ? 2 : 0);
    if (selected.length > 0 && length + next > GROK_HISTORY_MAX_CHARS) break;
    selected.unshift(item.slice(0, GROK_HISTORY_MAX_CHARS));
    length += next;
  }
  return selected.join('\n\n');
}
