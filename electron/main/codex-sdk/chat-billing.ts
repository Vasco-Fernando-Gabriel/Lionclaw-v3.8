
import type { CodexTokenUsage } from '../codex-runtime/types';

export const ZERO_CODEX_USAGE: CodexTokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

export function codexUsageDelta(
  current: CodexTokenUsage,
  previous: CodexTokenUsage,
): CodexTokenUsage {
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningOutputTokens: Math.max(
      0,
      current.reasoningOutputTokens - previous.reasoningOutputTokens,
    ),
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
  };
}

export interface SettledChatCodexBilling {
  delta: CodexTokenUsage;
  nextBaseline: CodexTokenUsage;
}

export function settleChatCodexBilling(
  current: CodexTokenUsage,
  billedBaseline: CodexTokenUsage,
): SettledChatCodexBilling {
  return {
    delta: codexUsageDelta(current, billedBaseline),
    nextBaseline:
      current.totalTokens >= billedBaseline.totalTokens ? current : billedBaseline,
  };
}
