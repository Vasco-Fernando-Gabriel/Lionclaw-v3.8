import type { ChatMessage } from '../../../src/types';
import { attachToolsBlocks, type MessageWithToolsBlock } from '../session-timeline';

export const CURSOR_HISTORY_MAX_TURNS = 8;
export const CURSOR_HISTORY_MAX_CHARS = 12_000;
export const CURSOR_HISTORY_MESSAGE_MAX_CHARS = 3_000;

const EMPTY_TOOLS_BY_ANCHOR: ReadonlyMap<number, string> = new Map();

function format(entry: MessageWithToolsBlock): string {
  const { message, toolsBlock } = entry;
  const role = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : 'System';
  const content =
    message.content.length > CURSOR_HISTORY_MESSAGE_MAX_CHARS
      ? `${message.content.slice(0, CURSOR_HISTORY_MESSAGE_MAX_CHARS)}\n[...message truncated...]`
      : message.content;
  const tools = toolsBlock === undefined ? '' : `\n\n${toolsBlock}`;
  return `${role}: ${content}${tools}`;
}

export function buildCursorHistoryPreamble(
  messages: ChatMessage[],
  options: { dropLast?: boolean; toolsByAnchor?: Map<number, string> } = {},
): string {
  const base = (options.dropLast ?? true) ? messages.slice(0, -1) : messages;
  const turns = attachToolsBlocks(
    base.filter((message) => message.role === 'user' || message.role === 'assistant'),
    options.toolsByAnchor ?? EMPTY_TOOLS_BY_ANCHOR,
  ).slice(-CURSOR_HISTORY_MAX_TURNS);
  const selected: string[] = [];
  let length = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const item = format(turns[index]);
    const next = item.length + (selected.length > 0 ? 2 : 0);
    if (selected.length > 0 && length + next > CURSOR_HISTORY_MAX_CHARS) break;
    selected.unshift(item.slice(0, CURSOR_HISTORY_MAX_CHARS));
    length += next;
  }
  return selected.join('\n\n');
}
