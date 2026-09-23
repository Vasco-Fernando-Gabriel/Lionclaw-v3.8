import crypto from 'crypto';
import type { CodexResponse, CodexStreamCallbacks, CodexToolUseMeta } from '../codex-runtime/types';
import { captureToolResult, captureToolUse } from '../artifact-detector';
import { insertAuditEntry } from '../db';
import { createLogger } from '../logger';
import { recordActivity, isWriteTool } from '../activity-log';
import type { ArtifactData, AuditEntry, StreamChunk } from '../../../src/types';
import {
  createObservedTimelineRecorder,
  type TimelineMetricsEvent,
  type TimelineTurnHandle,
} from '../session-timeline';

const logger = createLogger('codex-stream-translator');

export interface CodexStreamTranslatorOptions {
  sessionId: string;
  emit: (chunk: StreamChunk) => void;
  onArtifact?: (artifact: ArtifactData) => void;
  onAuditEntry?: (entry: Omit<AuditEntry, 'id' | 'createdAt'>) => void;
  subagent?: string;
  turnIndex?: number;
  timeline?: TimelineTurnHandle;
}

export interface CodexStreamTranslator {
  callbacks: CodexStreamCallbacks;
  finalize(response: CodexResponse): void;
  fail(err: unknown): void;
  timelineEvents(): TimelineMetricsEvent[];
}

function isCallAgentMcpTool(name: string): boolean {
  return name === 'mcp:lionclaw-agents.call_agent';
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

export function createCodexStreamTranslator(opts: CodexStreamTranslatorOptions): CodexStreamTranslator {
  const { sessionId, emit, onArtifact, onAuditEntry, subagent, turnIndex = 0 } = opts;
  let pendingToolUseId: string | null = null;
  const toolUseIdByCallId = new Map<string, string>();
  const emittedArtifactKeys = new Set<string>();
  const activityIdByCallId = new Map<string, string>();
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

  const callbacks: CodexStreamCallbacks = {
    onText: (delta: string) => {
      if (!delta) return;
      emit({ type: 'text', content: delta });
    },
    onReasoning: (delta: string) => {
      try {
        recordAuditEntry({
          sessionId,
          subagent,
          eventType: 'tool_call',
          toolName: 'codex.reasoning',
          input: delta,
        });
      } catch (err) {
        logger.debug({ err }, 'audit insert for reasoning failed');
      }
    },
    onToolUse: (name: string, meta?: CodexToolUseMeta) => {
      const toolUseId = crypto.randomUUID();
      if (meta?.callId) toolUseIdByCallId.set(meta.callId, toolUseId);
      else pendingToolUseId = toolUseId;
      timeline.toolCall({ toolUseId: meta?.callId ?? toolUseId, toolName: name, content: '' });
      try {
        const artifact = captureToolUse(toolUseId, name, {});
        emitArtifactIfAny(artifact);
      } catch (err) {
        logger.debug({ err, tool: name }, 'captureToolUse threw');
      }
      emit({ type: 'tool_call', tool: name, toolCallId: toolUseId, input: {} });
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
      if (!isCallAgentMcpTool(name)) {
        const callId = meta?.callId;
        const activityId = callId
          ? (activityIdByCallId.get(callId) ??
            (() => {
              const id = toolUseId;
              activityIdByCallId.set(callId, id);
              return id;
            })())
          : toolUseId;
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
    onToolUseComplete: (name: string, result: unknown, meta?: { callId?: string }) => {
      const artifactContent = stringifyResult(result);
      const resultString = stringifyResultForDisplay(result, artifactContent);
      const callId = meta?.callId;
      const toolUseId = callId
        ? (toolUseIdByCallId.get(callId) ?? crypto.randomUUID())
        : (pendingToolUseId ?? crypto.randomUUID());
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
      timeline.toolResult({
        toolUseId: callId ?? toolUseId,
        toolName: name,
        content: resultString,
        isError,
      });
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
      if (!isCallAgentMcpTool(name)) {
        const activityId = callId ? (activityIdByCallId.get(callId) ?? crypto.randomUUID()) : toolUseId;
        if (callId) activityIdByCallId.delete(callId);
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
      if (callId) toolUseIdByCallId.delete(callId);
      else pendingToolUseId = null;
    },
  };

  function finalize(response: CodexResponse): void {
    try {
      const artifact = captureToolResult('codex-final-response', response.content, false);
      emitArtifactIfAny(artifact);
    } catch (err) {
      logger.debug({ err }, 'captureToolResult threw for final response');
    }
    emit({
      type: 'usage',
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheReadTokens: response.usage.cachedInputTokens,
      },
    });
    emit({ type: 'done', content: sessionId });
  }

  function fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: 'error', error: message });
  }

  return { callbacks, finalize, fail, timelineEvents: timeline.events };
}
