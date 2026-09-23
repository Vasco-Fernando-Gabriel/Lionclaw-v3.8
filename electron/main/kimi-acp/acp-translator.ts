import type { CliStreamCallbacks, CliAgenticResponse } from '../agent-runtime/cli-agentic/contract';
import type { AcpSessionUpdate } from './types';

export interface KimiAcpAccumulator {
  sessionId: string | null;
  content: string;
  toolUses: number;
  failed: boolean;
  cancelled: boolean;
  toolNameById: Map<string, string>;
  rawInputById: Map<string, unknown>;
}

export function createAccumulator(sessionId?: string | null): KimiAcpAccumulator {
  return {
    sessionId: sessionId ?? null,
    content: '',
    toolUses: 0,
    failed: false,
    cancelled: false,
    toolNameById: new Map<string, string>(),
    rawInputById: new Map<string, unknown>(),
  };
}

export type KimiTurnOutcome = 'completed' | 'cancelled' | 'failed';

export interface TranslateHooks {
  callbacks?: CliStreamCallbacks;
  onUnknownUpdate?: (u: AcpSessionUpdate) => void;
}

export function translateSessionUpdate(
  update: AcpSessionUpdate,
  acc: KimiAcpAccumulator,
  hooks?: TranslateHooks,
): void {
  const cb = hooks?.callbacks;

  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = update.content?.text;
      if (text) {
        acc.content += text;
        cb?.onText?.(text);
      }
      return;
    }

    case 'agent_thought_chunk': {
      const text = update.content?.text;
      if (text) {
        cb?.onThinking?.(text);
      }
      return;
    }

    case 'tool_call': {
      const title = update.title ?? 'tool';
      if (update.toolCallId) {
        acc.toolNameById.set(update.toolCallId, title);
        if (update.rawInput !== undefined) {
          acc.rawInputById.set(update.toolCallId, update.rawInput);
        }
      }
      acc.toolUses += 1;
      cb?.onToolUse?.(title, update.toolCallId);
      return;
    }

    case 'tool_call_update': {
      if (update.status === 'in_progress') {
        if (update.toolCallId && update.rawInput !== undefined) {
          acc.rawInputById.set(update.toolCallId, update.rawInput);
        }
        return;
      }
      if (update.status === 'completed') {
        const name =
          (update.toolCallId ? acc.toolNameById.get(update.toolCallId) : undefined) ?? update.title ?? 'tool';
        const stashedInput =
          (update.toolCallId ? acc.rawInputById.get(update.toolCallId) : undefined) ?? update.rawInput;
        const input = stashedInput ?? update.rawOutput;
        cb?.onToolUseComplete?.(name, input, update.toolCallId);
        cb?.onToolUseIO?.(name, stashedInput, update.rawOutput ?? update.content?.text, update.toolCallId);
        return;
      }
      return;
    }

    case 'available_commands_update':
    case 'plan':
    case 'current_mode_update':
      return;

    default: {
      hooks?.onUnknownUpdate?.(update);
      return;
    }
  }
}

export function finalizeResponse(
  acc: KimiAcpAccumulator,
  outcome: KimiTurnOutcome,
  usage?: CliAgenticResponse['usage'] | null,
): CliAgenticResponse {
  const status: CliAgenticResponse['status'] =
    acc.cancelled || outcome === 'cancelled'
      ? 'cancelled'
      : acc.failed || outcome === 'failed'
        ? 'max_steps_reached'
        : 'finished';

  return {
    content: acc.content,
    usage: usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    toolUses: acc.toolUses,
    status,
  };
}

export function stopReasonToOutcome(stopReason: string | undefined): KimiTurnOutcome {
  switch (stopReason) {
    case 'end_turn':
    case 'stop':
    case 'completed':
      return 'completed';
    case 'cancelled':
    case 'interrupted':
      return 'cancelled';
    case 'max_tokens':
    case 'max_steps':
    case 'refusal':
      return 'failed';
    default:
      return 'completed';
  }
}
