import type { ChatMessage } from '../../../src/types';
import { attachToolsBlocks, type MessageWithToolsBlock } from '../session-timeline';

export const KIMI_HISTORY_MAX_TURNS = 8;
export const KIMI_HISTORY_MAX_CHARS = 12000;
export const KIMI_HISTORY_MESSAGE_MAX_CHARS = 3000;

const EMPTY_TOOLS_BY_ANCHOR: ReadonlyMap<number, string> = new Map();

function roleLabel(role: ChatMessage['role']): string {
  switch (role) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'system':
      return 'System';
  }
}

function formatHistoryMessage(entry: MessageWithToolsBlock): string {
  const { message, toolsBlock } = entry;
  const prefix = roleLabel(message.role);
  const content =
    message.content.length > KIMI_HISTORY_MESSAGE_MAX_CHARS
      ? `${message.content.slice(0, KIMI_HISTORY_MESSAGE_MAX_CHARS)}\n[...message truncated...]`
      : message.content;
  const tools = toolsBlock === undefined ? '' : `\n\n${toolsBlock}`;
  return `${prefix}: ${content}${tools}`;
}

export function buildKimiHistoryPreamble(
  messages: ChatMessage[],
  options: { dropLast?: boolean; toolsByAnchor?: Map<number, string> } = {},
): string {
  const base = (options.dropLast ?? true) ? messages.slice(0, -1) : messages;
  const priorTurns = attachToolsBlocks(
    base.filter((message) => message.role === 'user' || message.role === 'assistant'),
    options.toolsByAnchor ?? EMPTY_TOOLS_BY_ANCHOR,
  ).slice(-KIMI_HISTORY_MAX_TURNS);

  const selected: string[] = [];
  let usedChars = 0;

  for (let i = priorTurns.length - 1; i >= 0; i -= 1) {
    const formatted = formatHistoryMessage(priorTurns[i]);
    const separatorChars = selected.length > 0 ? 2 : 0;
    const nextChars = formatted.length + separatorChars;

    if (selected.length > 0 && usedChars + nextChars > KIMI_HISTORY_MAX_CHARS) {
      break;
    }

    if (selected.length === 0 && nextChars > KIMI_HISTORY_MAX_CHARS) {
      selected.unshift(formatted.slice(0, KIMI_HISTORY_MAX_CHARS));
      break;
    }

    selected.unshift(formatted);
    usedChars += nextChars;
  }

  return selected.join('\n\n');
}
