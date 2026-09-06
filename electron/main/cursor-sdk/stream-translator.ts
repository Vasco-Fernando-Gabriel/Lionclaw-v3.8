
import { captureToolResult, captureToolUse } from '../artifact-detector';
import { insertAuditEntry } from '../db';
import { createLogger } from '../logger';
import { recordActivity, isWriteTool } from '../activity-log';
import { calculateCost, getPricingSnapshot, hasKnownPricing } from '../pricing';
import type { ArtifactData, AuditEntry, StreamChunk } from '../../../src/types';
import type { CursorSidecarUsage } from '../agent-runtime/cursor-sidecar/protocol';

const logger = createLogger('cursor-stream-translator');

export interface CursorStreamTranslatorOptions {
  sessionId: string;
  model: string;
  emit: (chunk: StreamChunk) => void;
  onArtifact?: (artifact: ArtifactData) => void;
  onAuditEntry?: (entry: Omit<AuditEntry, 'id' | 'createdAt'>) => void;
  subagent?: string;
  turnIndex?: number;
}

export interface CursorStreamTranslator {
  onEvent(event: unknown): void;
  assistantText(): string;
  toolUses(): number;
  finalize(usage: NonNullable<StreamChunk['usage']>): void;
  fail(error: unknown): void;
}

export function buildCursorUsageSnapshot(
  usage: CursorSidecarUsage | undefined,
  model: string,
  estimated: { inputTokens: number; outputTokens: number },
): NonNullable<StreamChunk['usage']> {
  if (!usage) {
    return {
      inputTokens: estimated.inputTokens,
      outputTokens: estimated.outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimated: true,
      runtime: 'cursor-sdk',
      provider: 'cursor',
      model,
      costUsd: null,
      costStatus: 'unknown',
      tokenStatus: 'not_reported',
      costUnknownReason: 'no-usage-reported',
      costEstimationKind: 'subscription-equivalent-payg',
    };
  }
  const aggregatedInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const pricingKnown = hasKnownPricing(model);
  const snapshot = getPricingSnapshot(model);
  const cacheWriteUnpriced =
    snapshot.entry?.cacheCreationBilling === 'not-separately-reported'
    && usage.cacheWriteTokens > 0;
  const costUsd = pricingKnown
    ? calculateCost(model, aggregatedInput, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens)
    : null;
  return {
    inputTokens: aggregatedInput,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheWriteTokens,
    runtime: 'cursor-sdk',
    provider: 'cursor',
    model,
    costUsd,
    costStatus: costUsd === null ? 'unknown' : cacheWriteUnpriced ? 'estimated-partial' : 'known',
    ...(cacheWriteUnpriced && costUsd !== null
      ? { costStatusReasons: ['cache-write-not-reported'] as const }
      : {}),
    tokenStatus: 'reported',
    ...(costUsd === null ? { costUnknownReason: 'unknown-pricing' } : {}),
    costEstimationKind: 'subscription-equivalent-payg',
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function createCursorStreamTranslator(
  opts: CursorStreamTranslatorOptions,
): CursorStreamTranslator {
  const turnIndex = opts.turnIndex ?? 0;
  let accumulatedText = '';
  let toolUseCount = 0;
  const seenArtifacts = new Set<string>();
  const openActivities = new Map<string, string>();

  const audit = (entry: Omit<AuditEntry, 'id' | 'createdAt'>): void => {
    try {
      insertAuditEntry(entry);
      opts.onAuditEntry?.(entry);
    } catch (err) {
      logger.debug({ err }, 'cursor audit insert failed');
    }
  };
  const artifact = (value: ArtifactData | null): void => {
    if (!value) return;
    const key = `${value.type}:${value.data.filePath ?? value.id}`;
    if (seenArtifacts.has(key)) return;
    seenArtifacts.add(key);
    opts.emit({ type: 'artifact', artifact: value });
    opts.onArtifact?.(value);
  };
  const closeActivity = (callId: string, name: string, status: 'done' | 'error'): void => {
    openActivities.delete(callId);
    recordActivity(
      opts.sessionId,
      turnIndex,
      {
        id: callId,
        kind: 'tool',
        phase: 'end',
        label: name,
        toolName: name,
        status,
        ...(status === 'done' && isWriteTool(name) ? { changed: true } : {}),
        endedAt: new Date().toISOString(),
      },
      opts.emit,
    );
  };
  const settlePending = (status: 'done' | 'error'): void => {
    for (const [callId, name] of [...openActivities]) {
      closeActivity(callId, name, status);
      opts.emit({ type: 'tool_result', tool: name, toolCallId: callId, result: 'interrompido' });
    }
  };

  const onToolCall = (evt: Record<string, unknown>): void => {
    const name = typeof evt['name'] === 'string' ? (evt['name'] as string) : 'unknown';
    const callId = typeof evt['call_id'] === 'string' && evt['call_id'].length > 0
      ? (evt['call_id'] as string)
      : `${name}-${toolUseCount}`;
    const status = evt['status'];
    if (status === 'running') {
      if (openActivities.has(callId)) return; // evento repetido do SDK
      openActivities.set(callId, name);
      try { artifact(captureToolUse(callId, name, asRecord(evt['args']) ?? {})); } catch { /* best effort */ }
      opts.emit({ type: 'tool_call', tool: name, toolCallId: callId, input: asRecord(evt['args']) ?? {} });
      audit({
        sessionId: opts.sessionId,
        subagent: opts.subagent,
        eventType: 'tool_call',
        toolName: name,
        ...(evt['args'] !== undefined ? { input: stringify(evt['args']) } : {}),
      });
      recordActivity(
        opts.sessionId,
        turnIndex,
        {
          id: callId,
          kind: 'tool',
          phase: 'start',
          label: name,
          status: 'running',
          toolName: name,
          startedAt: new Date().toISOString(),
        },
        opts.emit,
      );
      return;
    }
    if (status === 'completed' || status === 'error') {
      toolUseCount += 1;
      const output = stringify(evt['result']);
      try { artifact(captureToolResult(callId, output, status === 'error')); } catch { /* best effort */ }
      opts.emit({
        type: 'tool_result',
        tool: name,
        toolCallId: callId,
        result: output,
        ...(evt['args'] !== undefined ? { input: evt['args'] } : {}),
      });
      audit({
        sessionId: opts.sessionId,
        subagent: opts.subagent,
        eventType: 'tool_result',
        toolName: name,
        ...(evt['args'] !== undefined ? { input: stringify(evt['args']) } : {}),
        output,
      });
      if (openActivities.has(callId)) {
        closeActivity(callId, name, status === 'error' ? 'error' : 'done');
      }
    }
  };

  return {
    onEvent(event) {
      const evt = asRecord(event);
      if (!evt) return;
      switch (evt['type']) {
        case 'assistant': {
          const message = asRecord(evt['message']);
          const content = message?.['content'];
          if (Array.isArray(content)) {
            for (const block of content) {
              const rec = asRecord(block);
              if (rec?.['type'] === 'text' && typeof rec['text'] === 'string') {
                accumulatedText += rec['text'];
                if (rec['text'].length > 0) opts.emit({ type: 'text', content: rec['text'] });
              }
            }
          }
          break;
        }
        case 'thinking': {
          const text = typeof evt['text'] === 'string' ? (evt['text'] as string) : '';
          if (text) {
            audit({
              sessionId: opts.sessionId,
              subagent: opts.subagent,
              eventType: 'tool_call',
              toolName: 'cursor.reasoning',
              input: text,
            });
          }
          break;
        }
        case 'tool_call':
          onToolCall(evt);
          break;
        default:
          break;
      }
    },
    assistantText: () => accumulatedText,
    toolUses: () => toolUseCount,
    finalize(usage) {
      settlePending('done');
      opts.emit({ type: 'usage', usage });
      opts.emit({ type: 'done', content: opts.sessionId });
    },
    fail(error) {
      settlePending('error');
      opts.emit({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    },
  };
}
