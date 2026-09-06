import { upsertActivityLog, getActiveChatSession } from './db';
import { createLogger } from './logger';
import {
  deriveMcpGatewayDisplayName,
  GATEWAY_INVOKE_TOOL_NAME,
  GATEWAY_SCHEMA_TOOL_NAME,
  MCP_REAL_TOOL_DISPLAY_RE,
} from './mcp-display';
import type {
  LiveActivityEvent,
  LiveActivityKind,
  LiveActivityPhase,
  LiveActivityStatus,
  StreamChunk,
} from '../../src/types';

const logger = createLogger('activity-log');

function fallbackStatusForPhase(phase: LiveActivityPhase): LiveActivityStatus {
  return phase === 'end' ? 'done' : 'running';
}

function normalizeActivityEvent(ev: LiveActivityEvent): LiveActivityEvent {
  const phase = ev.phase ?? 'update';
  const kind = ev.kind ?? ('tool' satisfies LiveActivityKind);
  let label =
    ev.label ??
    ev.toolName ??
    (typeof ev.agentId === 'string' && ev.agentId ? ev.agentId : ev.id);

  if (
    (ev.toolName === GATEWAY_INVOKE_TOOL_NAME || ev.toolName === GATEWAY_SCHEMA_TOOL_NAME) &&
    typeof ev.description === 'string' &&
    MCP_REAL_TOOL_DISPLAY_RE.test(ev.description)
  ) {
    label = ev.description;
  }

  return {
    ...ev,
    kind,
    phase,
    label,
    status: ev.status ?? fallbackStatusForPhase(phase),
  };
}

export function recordActivity(
  sessionId: string,
  turnIndex: number,
  ev: LiveActivityEvent,
  send: (chunk: StreamChunk) => void,
): void {
  const activity = normalizeActivityEvent(ev);

  send({ type: 'activity', activity: { ...activity, turnIndex } });

  try {
    upsertActivityLog(sessionId, turnIndex, activity);
  } catch (error) {
    logger.error(
      { error, sessionId, turnIndex, activityId: activity.id },
      'upsertActivityLog falhou (stream nao afetado)',
    );
  }
}

export function recordSystemActivity(input: {
  id: string;
  label: string;
  description: string;
  model?: string;
  status?: LiveActivityStatus;
}): void {
  try {
    const active = getActiveChatSession();
    if (!active) {
      logger.info(
        { activityId: input.id, label: input.label, description: input.description },
        'recordSystemActivity: sem sessao de chat ativa; skip registrado so no log',
      );
      return;
    }
    const ev: LiveActivityEvent = {
      id: input.id,
      kind: 'tool',
      phase: 'end',
      label: input.label,
      description: input.description,
      status: input.status ?? 'done',
      turnIndex: 0,
      ...(input.model ? { model: input.model } : {}),
    };
    upsertActivityLog(active.id, 0, normalizeActivityEvent(ev));
    logger.info(
      { sessionId: active.id, activityId: input.id, label: input.label },
      'recordSystemActivity: skip registrado no Activity Log',
    );
  } catch (error) {
    logger.warn(
      { error, activityId: input.id },
      'recordSystemActivity falhou (skip so no log; nada bloqueado)',
    );
  }
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function isWriteTool(name: string | undefined): boolean {
  return !!name && WRITE_TOOLS.has(name);
}

const GENERIC_DETAIL_MAX = 140;

const GENERIC_DETAIL_KEYS = [
  'query',
  'prompt',
  'url',
  'path',
  'pattern',
  'q',
  'text',
  'description',
  'command',
  'file_path',
] as const;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function genericDescription(input: Record<string, unknown>): string | undefined {
  for (const key of GENERIC_DETAIL_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return truncate(value.trim(), GENERIC_DETAIL_MAX);
    }
  }
  return undefined;
}

export function deriveToolDetail(
  name: string | undefined,
  input: Record<string, unknown> | undefined,
): { file?: string; command?: string; description?: string } {
  const detail: { file?: string; command?: string; description?: string } = {};
  if (!input) return detail;

  const gatewayTarget = deriveMcpGatewayDisplayName(name, input);
  if (gatewayTarget) {
    detail.description = gatewayTarget;
    return detail;
  }

  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit': {
      const file = input.file_path;
      if (typeof file === 'string') detail.file = file;
      return detail;
    }
    case 'NotebookEdit': {
      const file = input.notebook_path ?? input.file_path;
      if (typeof file === 'string') detail.file = file;
      return detail;
    }
    case 'Bash': {
      const command = input.command;
      if (typeof command === 'string') detail.command = command;
      return detail;
    }
    case 'Grep':
    case 'Glob': {
      const pattern = input.pattern ?? input.glob;
      if (typeof pattern === 'string') detail.description = pattern;
      return detail;
    }
    case 'ToolSearch': {
      const query = input.query ?? input.q;
      if (typeof query === 'string') detail.description = query;
      return detail;
    }
    case 'WebSearch': {
      const query = input.query ?? input.prompt;
      if (typeof query === 'string') detail.description = query;
      return detail;
    }
    case 'WebFetch': {
      const url = input.url;
      if (typeof url === 'string') detail.description = url;
      return detail;
    }
    case 'Task': {
      const description = input.description;
      if (typeof description === 'string') detail.description = description;
      return detail;
    }
    default: {
      const generic = genericDescription(input);
      if (generic) detail.description = generic;
      return detail;
    }
  }
}
