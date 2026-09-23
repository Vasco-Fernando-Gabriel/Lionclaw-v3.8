import crypto from 'crypto';
import { captureToolResult, captureToolUse } from '../artifact-detector';
import { insertAuditEntry } from '../db';
import { createLogger } from '../logger';
import { recordActivity, isWriteTool } from '../activity-log';
import { calculateCost, hasKnownPricing } from '../pricing';
import type { ArtifactData, AuditEntry, StreamChunk } from '../../../src/types';
import type { CliStreamCallbacks } from '../agent-runtime/cli-agentic/contract';
import type { GrokAcpResponse } from '../grok-acp/acp-translator';
import {
  createObservedTimelineRecorder,
  type TimelineMetricsEvent,
  type TimelineTurnHandle,
} from '../session-timeline';

const logger = createLogger('grok-stream-translator');

export interface GrokStreamTranslatorOptions {
  sessionId: string;
  model: string;
  emit: (chunk: StreamChunk) => void;
  onArtifact?: (artifact: ArtifactData) => void;
  onAuditEntry?: (entry: Omit<AuditEntry, 'id' | 'createdAt'>) => void;
  subagent?: string;
  turnIndex?: number;
  timeline?: TimelineTurnHandle;
}

export interface GrokStreamTranslator {
  callbacks: CliStreamCallbacks;
  finalize(response: GrokAcpResponse, usage: NonNullable<StreamChunk['usage']>): void;
  fail(error: unknown): void;
  timelineEvents(): TimelineMetricsEvent[];
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function fallbackCost(response: GrokAcpResponse, model: string): number | null {
  if (response.usage.cacheCreationTokens > 0) return null;
  const totalModelCalls = response.metadata?.modelCalls ?? 1;
  const modelUsage = response.metadata?.modelUsage;
  if (modelUsage && Object.keys(modelUsage).length > 0) {
    const rows = Object.entries(modelUsage);
    const detailedCalls = rows.reduce((sum, [, usage]) => sum + (usage.modelCalls ?? 0), 0);
    const detailedInput = rows.reduce((sum, [, usage]) => sum + usage.inputTokens, 0);
    const detailedOutput = rows.reduce((sum, [, usage]) => sum + usage.outputTokens, 0);
    const detailedCacheRead = rows.reduce((sum, [, usage]) => sum + usage.cachedReadTokens, 0);
    const detailedReasoning = rows.reduce((sum, [, usage]) => sum + usage.reasoningTokens, 0);
    if (
      detailedCalls !== totalModelCalls ||
      detailedInput !== response.usage.inputTokens ||
      detailedOutput !== response.usage.outputTokens ||
      detailedCacheRead !== response.usage.cacheReadTokens ||
      (response.usage.reasoningTokens !== undefined && detailedReasoning !== response.usage.reasoningTokens)
    )
      return null;
    let total = 0;
    for (const [usedModel, usage] of rows) {
      if (usage.modelCalls !== 1 || !hasKnownPricing(usedModel)) return null;
      total += calculateCost(usedModel, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens, 0, 0, {
        perRequestInput: true,
      });
    }
    return total;
  }
  if (totalModelCalls !== 1 || !hasKnownPricing(model)) return null;
  return calculateCost(
    model,
    response.usage.inputTokens,
    response.usage.outputTokens,
    response.usage.cacheReadTokens,
    response.usage.cacheCreationTokens,
    0,
    { perRequestInput: true },
  );
}

export function buildGrokUsageSnapshot(
  response: GrokAcpResponse,
  model: string,
  estimated: { inputTokens: number; outputTokens: number },
): NonNullable<StreamChunk['usage']> {
  const usage = response.usage;
  const tokenReported = usage.reported ?? (usage.inputTokens > 0 && usage.outputTokens > 0);
  const ticks = response.metadata?.costUsdTicks;
  const providerCost =
    typeof ticks === 'number' && Number.isSafeInteger(ticks) && ticks >= 0 ? ticks / 10_000_000_000 : null;
  const costUsd = tokenReported ? (providerCost ?? fallbackCost(response, model)) : null;
  return {
    inputTokens: tokenReported ? usage.inputTokens : estimated.inputTokens,
    outputTokens: tokenReported ? usage.outputTokens : estimated.outputTokens,
    cacheReadTokens: tokenReported ? usage.cacheReadTokens : 0,
    cacheCreationTokens: tokenReported ? usage.cacheCreationTokens : 0,
    ...(!tokenReported ? { estimated: true } : {}),
    runtime: 'grok-sdk',
    provider: 'grok',
    model,
    costUsd,
    costStatus: costUsd === null ? 'unknown' : 'known',
    tokenStatus: tokenReported ? 'reported' : 'not_reported',
    ...(costUsd === null
      ? {
          costUnknownReason: tokenReported ? 'insufficient-per-call-pricing-breakdown' : 'no-usage-reported',
        }
      : {}),
    costEstimationKind: 'subscription-equivalent-payg',
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function activityTracked(name: string): boolean {
  return !name.endsWith('__call_agent') && name !== 'call_agent';
}

export function createGrokStreamTranslator(opts: GrokStreamTranslatorOptions): GrokStreamTranslator {
  let toolCallId: string | null = null;
  const activityIdByToolCallId = new Map<string, string>();
  const seenArtifacts = new Set<string>();
  const turnIndex = opts.turnIndex ?? 0;
  const openActivities = new Map<string, string>();
  const timeline = createObservedTimelineRecorder(opts.timeline);
  const closeActivity = (
    activityId: string,
    name: string,
    detail: {
      status: 'done' | 'error';
      command?: string;
      exitCode?: number;
      durationMs?: number;
      filesChanged?: string[];
    },
  ): void => {
    openActivities.delete(activityId);
    recordActivity(
      opts.sessionId,
      turnIndex,
      {
        id: activityId,
        kind: 'tool',
        phase: 'end',
        label: name,
        toolName: name,
        status: detail.status,
        ...(detail.command !== undefined ? { command: detail.command } : {}),
        ...(detail.exitCode !== undefined ? { exitCode: detail.exitCode } : {}),
        ...(detail.durationMs !== undefined ? { durationMs: detail.durationMs } : {}),
        ...(detail.filesChanged !== undefined ? { filesChanged: detail.filesChanged } : {}),
        ...(detail.status === 'done' && isWriteTool(name) ? { changed: true } : {}),
        endedAt: new Date().toISOString(),
      },
      opts.emit,
    );
  };
  const settlePending = (status: 'done' | 'error'): void => {
    for (const [activityId, name] of [...openActivities]) {
      closeActivity(activityId, name, { status });
      opts.emit({ type: 'tool_result', tool: name, toolCallId: activityId, result: 'interrompido' });
    }
    activityIdByToolCallId.clear();
    toolCallId = null;
  };
  const audit = (entry: Omit<AuditEntry, 'id' | 'createdAt'>): void => {
    try {
      insertAuditEntry(entry);
      opts.onAuditEntry?.(entry);
    } catch (err) {
      logger.debug({ err }, 'grok audit insert failed');
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

  const callbacks: CliStreamCallbacks = {
    onText(delta) {
      if (delta) opts.emit({ type: 'text', content: delta });
    },
    onThinking(delta) {
      if (!delta) return;
      audit({
        sessionId: opts.sessionId,
        subagent: opts.subagent,
        eventType: 'tool_call',
        toolName: 'grok.reasoning',
        input: delta,
      });
    },
    onToolUse(name, driverToolCallId) {
      const id = crypto.randomUUID();
      toolCallId = id;
      if (driverToolCallId) activityIdByToolCallId.set(driverToolCallId, id);
      timeline.toolCall({ toolUseId: driverToolCallId ?? id, toolName: name, content: '' });
      try {
        artifact(captureToolUse(id, name, {}));
      } catch {
        /* best effort */
      }
      opts.emit({ type: 'tool_call', tool: name, toolCallId: id, input: {} });
      audit({ sessionId: opts.sessionId, subagent: opts.subagent, eventType: 'tool_call', toolName: name });
      if (activityTracked(name)) {
        openActivities.set(id, name);
        recordActivity(
          opts.sessionId,
          turnIndex,
          {
            id,
            kind: 'tool',
            phase: 'start',
            label: name,
            status: 'running',
            toolName: name,
            startedAt: new Date().toISOString(),
          },
          opts.emit,
        );
      }
    },
    onToolUseIO(name, input, result, driverToolCallId) {
      const correlated = driverToolCallId ? activityIdByToolCallId.get(driverToolCallId) : undefined;
      if (driverToolCallId) activityIdByToolCallId.delete(driverToolCallId);
      const timelineId = driverToolCallId ?? toolCallId;
      const id = correlated ?? toolCallId ?? crypto.randomUUID();
      const output = stringify(result);
      if (input !== undefined && timelineId !== null) {
        timeline.toolCallArgs({ toolUseId: timelineId, toolName: name, content: stringify(input) });
      }
      timeline.toolResult({ toolUseId: timelineId, toolName: name, content: output, isError: false });
      try {
        artifact(captureToolResult(id, output, false));
      } catch {
        /* best effort */
      }
      opts.emit({
        type: 'tool_result',
        tool: name,
        toolCallId: id,
        result: output,
        ...(input !== undefined ? { input } : {}),
      });
      audit({
        sessionId: opts.sessionId,
        subagent: opts.subagent,
        eventType: 'tool_result',
        toolName: name,
        ...(input !== undefined ? { input: stringify(input) } : {}),
        output,
      });
      if (openActivities.has(id)) {
        const record = asRecord(result);
        const exitCode = typeof record?.['exitCode'] === 'number' ? (record['exitCode'] as number) : undefined;
        const success = typeof record?.['success'] === 'boolean' ? (record['success'] as boolean) : true;
        closeActivity(id, name, {
          status: !success || (typeof exitCode === 'number' && exitCode !== 0) ? 'error' : 'done',
          ...(typeof record?.['command'] === 'string' ? { command: record['command'] as string } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(typeof record?.['durationMs'] === 'number' ? { durationMs: record['durationMs'] as number } : {}),
        });
      }
      if (correlated === undefined) toolCallId = null;
    },
  };

  const finalize = (_response: GrokAcpResponse, usage: NonNullable<StreamChunk['usage']>): void => {
    settlePending('done');
    opts.emit({ type: 'usage', usage });
    opts.emit({ type: 'done', content: opts.sessionId });
  };

  const fail = (error: unknown): void => {
    settlePending('error');
    opts.emit({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  };

  return { callbacks, finalize, fail, timelineEvents: timeline.events };
}
