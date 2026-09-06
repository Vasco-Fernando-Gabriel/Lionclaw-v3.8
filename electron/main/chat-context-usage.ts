
import { getSetting } from './db';
import { getContextWindow } from './agent-runtime/model-context-windows';
import {
  DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT,
  CHAT_COMPACTION_TRIGGER_PERCENT_SETTING_KEY,
} from './chat-compaction-defaults';
import type { StreamChunk } from '../../src/types';

export type ChatContextUsage = NonNullable<StreamChunk['contextUsage']>;

export function resolveCompactionThresholdPercent(): number {
  const raw = parseInt(
    getSetting(CHAT_COMPACTION_TRIGGER_PERCENT_SETTING_KEY) ||
      String(DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT),
    10,
  );
  if (!Number.isFinite(raw)) return DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT;
  return Math.min(95, Math.max(50, raw));
}

export function buildChatContextUsage(args: {
  model: string | undefined;
  provider?: string;
  contextTokens: number;
  source: 'estimate' | 'provider';
}): ChatContextUsage | undefined {
  const { model, provider, contextTokens, source } = args;
  if (!model) return undefined;
  if (!Number.isFinite(contextTokens) || contextTokens < 0) return undefined;

  const contextWindowTokens = getContextWindow(model, provider);
  if (contextWindowTokens === undefined || contextWindowTokens <= 0) return undefined;

  return {
    contextTokens: Math.floor(contextTokens),
    contextWindowTokens,
    compactionThresholdPercent: resolveCompactionThresholdPercent(),
    source,
  };
}

export function resolveLionContextWindowTokens(
  model: string,
  provider: string | undefined,
  manualMaxContextTokens: number | undefined,
): number | undefined {
  const resolved = getContextWindow(model, provider);
  if (resolved !== undefined && resolved > 0) return resolved;
  return provider === 'ollama' || provider === 'lmstudio' ? manualMaxContextTokens : undefined;
}
