import crypto from 'crypto';
import { captureToolResult, captureToolUse } from '../artifact-detector';
import { insertAuditEntry } from '../db';
import { createLogger } from '../logger';
import { recordActivity, isWriteTool } from '../activity-log';
import { calculateCost, hasKnownPricing } from '../pricing';
import type { ArtifactData, AuditEntry, StreamChunk } from '../../../src/types';
import type { CliAgenticResponse, CliStreamCallbacks } from '../agent-runtime/cli-agentic/contract';
import {
  createObservedTimelineRecorder,
  type TimelineMetricsEvent,
  type TimelineTurnHandle,
} from '../session-timeline';

const logger = createLogger('kimi-stream-translator');

export interface KimiStreamTranslatorOptions {
  sessionId: string;
  emit: (chunk: StreamChunk) => void;
  onArtifact?: (artifact: ArtifactData) => void;
  onAuditEntry?: (entry: Omit<AuditEntry, 'id' | 'createdAt'>) => void;
  subagent?: string;
  turnIndex?: number;
  timeline?: TimelineTurnHandle;
}

export interface KimiStreamTranslator {
  callbacks: CliStreamCallbacks;
  finalize(response: CliAgenticResponse, usage: NonNullable<StreamChunk['usage']>): void;
  fail(err: unknown): void;
  timelineEvents(): TimelineMetricsEvent[];
}

export function buildKimiUsageSnapshot(
  response: CliAgenticResponse,
  model: string,
  pricingModel: string,
  estimated: { inputTokens: number; outputTokens: number },
): NonNullable<StreamChunk['usage']> {
  const usage = response.usage;
  const tokenReported = usage.inputTokens > 0 && usage.outputTokens > 0;
  const costUsd =
    tokenReported && hasKnownPricing(pricingModel)
      ? calculateCost(
          pricingModel,
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheReadTokens,
          usage.cacheCreationTokens,
        )
      : null;
  return {
    inputTokens: tokenReported ? usage.inputTokens : estimated.inputTokens,
    outputTokens: tokenReported ? usage.outputTokens : estimated.outputTokens,
    cacheReadTokens: tokenReported ? usage.cacheReadTokens : 0,
    cacheCreationTokens: tokenReported ? usage.cacheCreationTokens : 0,
    ...(!tokenReported ? { estimated: true } : {}),
    runtime: 'kimi-sdk',
    provider: 'kimi',
    model,
    costUsd,
    costStatus: costUsd === null ? 'unknown' : 'known',
    tokenStatus: tokenReported ? 'reported' : 'not_reported',
    ...(costUsd === null
      ? {
          costUnknownReason: tokenReported ? 'unknown-pricing' : 'no-usage-reported',
        }
      : {}),
    costEstimationKind: 'subscription-equivalent-payg',
  };
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined || result === null) return '';
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringifyResultForDisplay(result: unknown, fallback: string): string {
  const record = asRecord(result);
  if (record?.type === 'image_generation_result') {
    const prompt = typeof record.prompt === 'string' && record.prompt.trim() ? record.prompt.trim() : 'imagem gerada';
    return `Imagem gerada: ${prompt}`;
  }
  return fallback;
}

function artifactDedupKey(artifact: ArtifactData): string {
  const filePath = artifact.data.filePath;
  const imageBase64 = artifact.data.imageBase64;
  if (typeof filePath === 'string') return `${artifact.type}:file:${filePath}`;
  if (typeof imageBase64 === 'string') return `${artifact.type}:inline:${imageBase64.slice(0, 80)}`;
  return `${artifact.type}:${artifact.id}`;
}

export function createKimiStreamTranslator(opts: KimiStreamTranslatorOptions): KimiStreamTranslator {
  const { sessionId, emit, onArtifact, onAuditEntry, subagent, turnIndex = 0 } = opts;
  let pendingToolUseId: string | null = null;
  const localIdByToolCallId = new Map<string, string>();
  const emittedArtifactKeys = new Set<string>();
  const activityIdStack: string[] = [];
  const timeline = createObservedTimelineRecorder(opts.timeline);

  function emitArtifactIfAny(artifact: ArtifactData | null): void {
    if (!artifact) return;
    const key = artifactDedupKey(artifact);
    if (emittedArtifactKeys.has(key)) return;
    emittedArtifactKeys.add(key);
    emit({ type: 'artifact', artifact });
    onArtifact?.(artifact);
  }

  function recordAuditEntry(entry: Omit<AuditEntry, 'id' | 'createdAt'>): void {
    insertAuditEntry(entry);
    onAuditEntry?.(entry);
  }

  const callbacks: CliStreamCallbacks = {
    onText: (delta: string) => {
      if (!delta) return;
      emit({ type: 'text', content: delta });
    },
    onThinking: (delta: string) => {
      try {
        recordAuditEntry({
          sessionId,
          subagent,
          eventType: 'tool_call',
          toolName: 'kimi.reasoning',
          input: delta,
        });
      } catch (err) {
        logger.debug({ err }, 'audit insert for reasoning failed');
      }
    },
    onToolUse: (name: string, toolCallId?: string) => {
      const localId = crypto.randomUUID();
      pendingToolUseId = localId;
      if (toolCallId) localIdByToolCallId.set(toolCallId, localId);
      timeline.toolCall({ toolUseId: toolCallId ?? localId, toolName: name, content: '' });
      try {
        const artifact = captureToolUse(localId, name, {});
        emitArtifactIfAny(artifact);
      } catch (err) {
        logger.debug({ err, tool: name }, 'captureToolUse threw');
      }
      emit({ type: 'tool_call', tool: name, toolCallId: localId, input: {} });
      try {
        recordAuditEntry({
          sessionId,
          subagent,
          eventType: 'tool_call',
          toolName: name,
        });
      } catch (err) {
        logger.debug({ err }, 'audit insert for tool_call failed');
      }
      if (!name.startsWith('mcp:')) {
        const activityId = localId;
        activityIdStack.push(activityId);
        recordActivity(
          sessionId,
          turnIndex,
          {
            id: activityId,
            kind: 'tool',
            phase: 'start',
            label: name,
            status: 'running',
            toolName: name,
            startedAt: new Date().toISOString(),
          },
          emit,
        );
      }
    },
    onToolUseComplete: (name: string, result: unknown, toolCallId?: string) => {
      const artifactContent = stringifyResult(result);
      const resultString = stringifyResultForDisplay(result, artifactContent);
      const mappedId = toolCallId ? localIdByToolCallId.get(toolCallId) : undefined;
      const toolUseId = mappedId ?? pendingToolUseId ?? crypto.randomUUID();
      if (mappedId && pendingToolUseId === mappedId) pendingToolUseId = null;
      try {
        const artifact = captureToolResult(toolUseId, artifactContent, false);
        emitArtifactIfAny(artifact);
      } catch (err) {
        logger.debug({ err, tool: name }, 'captureToolResult threw');
      }
      emit({ type: 'tool_result', tool: name, toolCallId: toolUseId, result: resultString });
      try {
        recordAuditEntry({
          sessionId,
          subagent,
          eventType: 'tool_result',
          toolName: name,
          output: resultString,
        });
      } catch (err) {
        logger.debug({ err }, 'audit insert for tool_result failed');
      }
      if (!name.startsWith('mcp:')) {
        const mappedIndex = mappedId ? activityIdStack.lastIndexOf(mappedId) : -1;
        if (mappedIndex >= 0) activityIdStack.splice(mappedIndex, 1);
        const activityId = mappedId ?? activityIdStack.pop() ?? crypto.randomUUID();
        const record = asRecord(result);
        const command = typeof record?.command === 'string' ? record.command : undefined;
        const exitCode = typeof record?.exitCode === 'number' ? record.exitCode : undefined;
        const durationMs = typeof record?.durationMs === 'number' ? record.durationMs : undefined;
        const filesChanged = Array.isArray(record?.filesChanged)
          ? (record.filesChanged.filter((f) => typeof f === 'string') as string[])
          : undefined;
        const success = typeof record?.success === 'boolean' ? record.success : true;
        const bashFailed = typeof exitCode === 'number' && exitCode !== 0;
        const isError = !success || bashFailed;
        const write = isWriteTool(name);

        recordActivity(
          sessionId,
          turnIndex,
          {
            id: activityId,
            kind: 'tool',
            phase: 'end',
            label: name,
            toolName: name,
            status: isError ? 'error' : 'done',
            command,
            exitCode,
            durationMs,
            filesChanged: filesChanged && filesChanged.length > 0 ? filesChanged : undefined,
            changed: isError ? undefined : write,
            endedAt: new Date().toISOString(),
          },
          emit,
        );
      }
    },
    onToolUseIO: (name: string, input: unknown, output: unknown, toolCallId?: string) => {
      const timelineId = toolCallId ?? pendingToolUseId;
      if (toolCallId) localIdByToolCallId.delete(toolCallId);
      else pendingToolUseId = null;
      if (input !== undefined && timelineId !== null) {
        timeline.toolCallArgs({ toolUseId: timelineId, toolName: name, content: stringifyResult(input) });
      }
      timeline.toolResult({
        toolUseId: timelineId,
        toolName: name,
        content: stringifyResult(output),
        isError: false,
      });
    },
  };

  function finalize(response: CliAgenticResponse, usage: NonNullable<StreamChunk['usage']>): void {
    try {
      const artifact = captureToolResult('kimi-final-response', response.content, false);
      emitArtifactIfAny(artifact);
    } catch (err) {
      logger.debug({ err }, 'captureToolResult threw for final response');
    }
    emit({ type: 'usage', usage });
    emit({ type: 'done', content: sessionId });
  }

  function fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: 'error', error: message });
  }

  return { callbacks, finalize, fail, timelineEvents: timeline.events };
}
