import { captureToolResult, captureToolUse } from '../artifact-detector';
import type { ArtifactData, StreamChunk } from '../../../src/types';
import { insertAuditEntry } from '../db';
import { createLogger } from '../logger';
import { recordActivity, isWriteTool, deriveToolDetail } from '../activity-log';

const logger = createLogger('lion-sdk-stream');

export interface LionStreamTranslatorOptions {
  sessionId: string;
  emit: (chunk: StreamChunk) => void;
  subagent?: string;
  turnIndex?: number;
}

export interface LionStreamTranslator {
  emitText(delta: string): void;
  emitToolCall(toolUseId: string, name: string, input: Record<string, unknown>): void;
  emitToolResult(toolUseId: string, name: string, result: string, isError?: boolean): void;
  emitError(err: unknown): void;
  emitUsage(usage: NonNullable<StreamChunk['usage']>): void;
  emitContextUsage(contextUsage: NonNullable<StreamChunk['contextUsage']>): void;
  emitDone(): void;
}

function stringifyMaybe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emitArtifactIfAny(emit: (c: StreamChunk) => void, artifact: ArtifactData | null): void {
  if (!artifact) return;
  emit({ type: 'artifact', artifact });
}

export function mcpToolLabel(serverId: string, tool: string): string {
  return `mcp:${serverId}.${tool}`;
}

export function createLionStreamTranslator(opts: LionStreamTranslatorOptions): LionStreamTranslator {
  const { sessionId, emit, subagent, turnIndex = 0 } = opts;

  return {
    emitText(delta: string): void {
      if (!delta) return;
      emit({ type: 'text', content: delta });
    },

    emitToolCall(toolUseId, name, input): void {
      try {
        const artifact = captureToolUse(toolUseId, name, input);
        emitArtifactIfAny(emit, artifact);
      } catch (e) {
        logger.debug({ err: e, tool: name }, 'captureToolUse threw');
      }
      emit({ type: 'tool_call', tool: name, input });
      try {
        insertAuditEntry({
          sessionId,
          subagent,
          eventType: 'tool_call',
          toolName: name,
          input: stringifyMaybe(input),
        });
      } catch (e) {
        logger.debug({ err: e }, 'audit insert for tool_call failed');
      }
      if (!name.startsWith('mcp:')) {
        const detail = deriveToolDetail(name, input);
        recordActivity(
          sessionId,
          turnIndex,
          {
            id: toolUseId,
            kind: 'tool',
            phase: 'start',
            label: name,
            status: 'running',
            toolName: name,
            file: detail.file,
            command: detail.command,
            description: detail.description,
            startedAt: new Date().toISOString(),
          },
          emit,
        );
      }
    },

    emitToolResult(toolUseId, name, result, isError): void {
      try {
        const artifact = captureToolResult(toolUseId, result, !!isError);
        emitArtifactIfAny(emit, artifact);
      } catch (e) {
        logger.debug({ err: e, tool: name }, 'captureToolResult threw');
      }
      emit({ type: 'tool_result', tool: name, result });
      try {
        insertAuditEntry({
          sessionId,
          subagent,
          eventType: 'tool_result',
          toolName: name,
          output: result,
        });
      } catch (e) {
        logger.debug({ err: e }, 'audit insert for tool_result failed');
      }
      if (!name.startsWith('mcp:')) {
        recordActivity(
          sessionId,
          turnIndex,
          {
            id: toolUseId,
            kind: 'tool',
            phase: 'end',
            label: name,
            toolName: name,
            status: isError ? 'error' : 'done',
            changed: isError ? undefined : isWriteTool(name),
            endedAt: new Date().toISOString(),
          },
          emit,
        );
      }
    },

    emitError(err): void {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'error', error: message });
    },

    emitUsage(usage): void {
      emit({ type: 'usage', usage });
    },

    emitContextUsage(contextUsage): void {
      emit({ type: 'context_usage', contextUsage });
    },

    emitDone(): void {
      emit({ type: 'done', content: sessionId });
    },
  };
}
