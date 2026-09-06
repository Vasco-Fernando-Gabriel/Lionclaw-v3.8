
import type {
  CodexStreamCallbacks,
  CodexResponse,
  CodexTokenUsage,
  CodexPatchFailureSample,
  CodexToolUseMeta,
} from './types';
import {
  CODEX_GATEWAY_SERVER_ID,
  GATEWAY_INVOKE_TOOL_NAME,
  GATEWAY_SCHEMA_TOOL_NAME,
  deriveMcpGatewayDisplayName,
} from '../mcp-display';


export type LionSandbox = 'workspace-write' | 'read-only' | 'danger-full-access';
export type LionApproval = 'never' | 'on-request' | 'auto-edit';


const SANDBOX_TO_WIRE: Record<LionSandbox, string> = {
  'workspace-write': 'workspaceWrite',
  'read-only': 'readOnly',
  'danger-full-access': 'dangerFullAccess',
};

const SANDBOX_FROM_WIRE: Record<string, LionSandbox> = {
  workspaceWrite: 'workspace-write',
  readOnly: 'read-only',
  dangerFullAccess: 'danger-full-access',
};

const APPROVAL_TO_WIRE: Record<LionApproval, string> = {
  never: 'never',
  'on-request': 'onRequest',
  'auto-edit': 'autoEdit',
};

const APPROVAL_FROM_WIRE: Record<string, LionApproval> = {
  never: 'never',
  onRequest: 'on-request',
  autoEdit: 'auto-edit',
};

export function sandboxToWire(internal: LionSandbox): string {
  const wire = SANDBOX_TO_WIRE[internal];
  if (wire === undefined) {
    throw new Error(`unknown internal sandbox enum: ${String(internal)}`);
  }
  return wire;
}

export function sandboxFromWire(wire: string): LionSandbox {
  const internal = SANDBOX_FROM_WIRE[wire];
  if (internal === undefined) {
    throw new Error(`unknown wire sandbox enum: ${String(wire)}`);
  }
  return internal;
}

export function approvalToWire(internal: LionApproval): string {
  const wire = APPROVAL_TO_WIRE[internal];
  if (wire === undefined) {
    throw new Error(`unknown internal approval enum: ${String(internal)}`);
  }
  return wire;
}

export function approvalFromWire(wire: string): LionApproval {
  const internal = APPROVAL_FROM_WIRE[wire];
  if (internal === undefined) {
    throw new Error(`unknown wire approval enum: ${String(wire)}`);
  }
  return internal;
}


export interface AppServerEvent {
  method: string;
  params?: Record<string, unknown>;
}

const MAX_PATCH_FAILURE_SAMPLES = 5;


export interface TranslatorAccumulator {
  threadId: string | null;
  content: string;
  filesChanged: string[];
  commandsRun: Array<{ cmd: string; exitCode: number; durationMs: number }>;
  usage: CodexTokenUsage;
  applyPatchFailures: number;
  applyPatchFailureSamples: CodexPatchFailureSample[];
  timedOut: boolean;
  authRequired: boolean;
  failed: boolean;
  openCommands: Map<string, { cmd: string; startedAt: number }>;
  errorCode?: string;
  lastUsage?: CodexTokenUsage;
  modelContextWindow?: number;
}

export function createAccumulator(threadId?: string | null): TranslatorAccumulator {
  return {
    threadId: threadId ?? null,
    content: '',
    filesChanged: [],
    commandsRun: [],
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
    applyPatchFailures: 0,
    applyPatchFailureSamples: [],
    timedOut: false,
    authRequired: false,
    failed: false,
    openCommands: new Map(),
  };
}


function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function normalizeUsage(payload: Record<string, unknown> | undefined): CodexTokenUsage {
  const p = payload ?? {};
  const inputTokens = toNum(p['inputTokens'] ?? p['input_tokens']);
  const cachedInputTokens = toNum(p['cachedInputTokens'] ?? p['cached_input_tokens']);
  const outputTokens = toNum(p['outputTokens'] ?? p['output_tokens']);
  const reasoningOutputTokens = toNum(
    p['reasoningOutputTokens'] ?? p['reasoning_output_tokens'],
  );
  const explicitTotal = p['totalTokens'] ?? p['total_tokens'];
  const totalTokens =
    typeof explicitTotal === 'number' && Number.isFinite(explicitTotal)
      ? explicitTotal
      : inputTokens + outputTokens;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}


function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function toolKindFor(method: string): CodexToolUseMeta['kind'] {
  if (method.includes('commandExecution')) return 'bash';
  if (method.includes('fileChange') || method.includes('patch')) return 'file';
  if (method.includes('mcpToolCall')) return 'mcp';
  return undefined;
}

function flattenMcpResult(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  const rec = asRecord(result);
  const content = rec['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = asRecord(block);
      if (typeof b['text'] === 'string') parts.push(b['text'] as string);
      else if (b['type'] === 'image' || b['data'] !== undefined || b['url'] !== undefined || b['image_url'] !== undefined) {
        try { parts.push(JSON.stringify(b)); } catch { /* skip unserializable block */ }
      }
    }
    if (parts.length) return parts.join('\n');
  }
  const structured = rec['structuredContent'] ?? rec['structured_content'];
  if (structured !== undefined) {
    try { return JSON.stringify(structured); } catch { return ''; }
  }
  try { return JSON.stringify(result); } catch { return ''; }
}

export interface TranslateEventHooks {
  callbacks?: CodexStreamCallbacks;
  onUnknownEvent?: (event: AppServerEvent) => void;
}

export function translateEvent(
  event: AppServerEvent,
  acc: TranslatorAccumulator,
  hooks: TranslateEventHooks = {},
): void {
  const cb = hooks.callbacks;
  cb?.onActivity?.();

  const method = event.method;
  const params = event.params ?? {};

  switch (method) {
    case 'thread/started':
    case 'thread/start': {
      const threadId = asString(params['threadId'] ?? params['thread_id']);
      if (threadId) acc.threadId = threadId;
      return;
    }

    case 'item/agentMessage/delta':
    case 'agentMessage/delta': {
      const delta = asString(params['delta'] ?? params['text']);
      if (delta) {
        acc.content += delta;
        cb?.onText?.(delta);
      }
      return;
    }

    case 'item/reasoning/delta':
    case 'reasoning/delta': {
      const delta = asString(params['delta'] ?? params['text']);
      if (delta) {
        cb?.onReasoning?.(delta);
      }
      return;
    }

    case 'commandExecution/started':
    case 'item/commandExecution/started': {
      const callId = asString(params['callId'] ?? params['call_id']);
      const cmd = asString(params['command'] ?? params['cmd']);
      if (callId) {
        acc.openCommands.set(callId, { cmd, startedAt: toNum(params['startedAt']) || Date.now() });
      }
      cb?.onToolUse?.('Bash', { callId: callId || undefined, kind: 'bash' });
      return;
    }

    case 'commandExecution/completed':
    case 'item/commandExecution/completed': {
      const callId = asString(params['callId'] ?? params['call_id']);
      const cmd = asString(params['command'] ?? params['cmd']);
      const exitCode = toNum(params['exitCode'] ?? params['exit_code']);
      const open = callId ? acc.openCommands.get(callId) : undefined;
      const durationMs =
        toNum(params['durationMs'] ?? params['duration_ms']) ||
        (open ? Math.max(0, Date.now() - open.startedAt) : 0);
      const resolvedCmd = cmd || open?.cmd || 'command';
      acc.commandsRun.push({ cmd: resolvedCmd, exitCode, durationMs });
      if (callId) acc.openCommands.delete(callId);
      cb?.onToolUseComplete?.('Bash', { command: resolvedCmd, exitCode, durationMs }, {
        callId: callId || undefined,
      });
      return;
    }

    case 'fileChange':
    case 'item/fileChange':
    case 'item/patch': {
      const path = asString(params['path'] ?? params['file']);
      if (path && !acc.filesChanged.includes(path)) {
        acc.filesChanged.push(path);
      }
      const failed = params['applyPatchFailed'] === true || params['apply_patch_failed'] === true;
      if (failed) {
        acc.applyPatchFailures += 1;
        if (acc.applyPatchFailureSamples.length < MAX_PATCH_FAILURE_SAMPLES) {
          acc.applyPatchFailureSamples.push({
            source: 'tool-output',
            text: asString(params['failureText'] ?? params['failure_text']).slice(0, 2000),
            ts: Date.now(),
          });
        }
      }
      return;
    }

    case 'dynamicToolCall/started':
    case 'item/dynamicToolCall/started': {
      const callId = asString(params['callId'] ?? params['call_id']);
      const name = asString(params['name'] ?? params['tool']);
      cb?.onToolUse?.(name || 'dynamic-tool', { callId: callId || undefined });
      return;
    }
    case 'dynamicToolCall/completed':
    case 'item/dynamicToolCall/completed': {
      const callId = asString(params['callId'] ?? params['call_id']);
      const name = asString(params['name'] ?? params['tool']);
      cb?.onToolUseComplete?.(name || 'dynamic-tool', asRecord(params['result']), {
        callId: callId || undefined,
      });
      return;
    }

    case 'mcpToolCall/started':
    case 'item/mcpToolCall/started': {
      const callId = asString(params['callId'] ?? params['call_id']);
      const name = asString(params['name'] ?? params['tool']);
      cb?.onToolUse?.(name || 'mcp-tool', { callId: callId || undefined, kind: 'mcp' });
      return;
    }
    case 'mcpToolCall/completed':
    case 'item/mcpToolCall/completed': {
      const callId = asString(params['callId'] ?? params['call_id']);
      const name = asString(params['name'] ?? params['tool']);
      cb?.onToolUseComplete?.(name || 'mcp-tool', asRecord(params['result']), {
        callId: callId || undefined,
      });
      return;
    }

    case 'thread/tokenUsage/updated':
    case 'tokenUsage/updated': {
      const tuRoot = asRecord(params['tokenUsage'] ?? params['usage'] ?? params);
      const total =
        tuRoot['total'] && typeof tuRoot['total'] === 'object'
          ? asRecord(tuRoot['total'])
          : tuRoot;
      acc.usage = normalizeUsage(total);
      if (tuRoot['last'] && typeof tuRoot['last'] === 'object') {
        acc.lastUsage = normalizeUsage(asRecord(tuRoot['last']));
      }
      const mcw = tuRoot['modelContextWindow'];
      if (typeof mcw === 'number' && Number.isFinite(mcw) && mcw > 0) {
        acc.modelContextWindow = Math.floor(mcw);
      }
      return;
    }

    case 'item/started':
    case 'item/updated':
    case 'item/completed': {
      const item = asRecord(params['item']);
      const itemType = asString(item['type']);
      if (itemType === 'agentMessage') {
        if (method === 'item/completed' && acc.content === '') {
          const text = asString(item['text']);
          if (text) {
            acc.content = text;
            cb?.onText?.(text);
          }
        }
      } else if (itemType === 'reasoning') {
        if (method === 'item/completed') {
          const rtext = asString(item['text']);
          if (rtext) cb?.onReasoning?.(rtext);
        }
      } else if (itemType === 'commandExecution') {
        const cmd = asString(item['command'] ?? item['cmd']);
        const callId = asString(item['id']) || undefined;
        if (method === 'item/started') {
          cb?.onToolUse?.('Bash', { callId, kind: 'bash' });
        } else if (method === 'item/completed') {
          const exitCode = toNum(item['exitCode'] ?? item['exit_code']);
          const durationMs = toNum(item['durationMs'] ?? item['duration_ms']);
          acc.commandsRun.push({
            cmd: cmd || 'command',
            exitCode,
            durationMs,
          });
          cb?.onToolUseComplete?.('Bash', { command: cmd || 'command', exitCode, durationMs }, { callId });
        }
      } else if (itemType === 'fileChange' && method === 'item/completed') {
        const path = asString(item['path'] ?? item['file']);
        if (path && !acc.filesChanged.includes(path)) acc.filesChanged.push(path);
      } else if (itemType === 'mcpToolCall') {
        const server = asString(item['server']);
        const tool = asString(item['tool']);
        let label = server && tool ? `mcp:${server}.${tool}` : tool || server || 'mcp-tool';
        if (
          server === CODEX_GATEWAY_SERVER_ID &&
          (tool === 'mcp_invoke' || tool === 'mcp_schema')
        ) {
          const rawArgs = item['arguments'] ?? item['args'];
          let parsedArgs: unknown = rawArgs;
          if (typeof rawArgs === 'string') {
            try {
              parsedArgs = JSON.parse(rawArgs);
            } catch {
              parsedArgs = null;
            }
          }
          const metaName =
            tool === 'mcp_invoke' ? GATEWAY_INVOKE_TOOL_NAME : GATEWAY_SCHEMA_TOOL_NAME;
          const real = deriveMcpGatewayDisplayName(metaName, parsedArgs);
          if (real) {
            const [, realServer, realTool] = real.split('__');
            label = `mcp:${realServer}.${realTool}`;
          }
        }
        const callId = asString(item['id']) || undefined;
        if (method === 'item/started') {
          cb?.onToolUse?.(label, { callId, kind: 'mcp' });
        } else if (method === 'item/completed') {
          cb?.onToolUseComplete?.(label, flattenMcpResult(item['result']), { callId });
        }
      }
      return;
    }

    case 'auth/required':
    case 'thread/authRequired': {
      acc.authRequired = true;
      return;
    }

    case 'turn/started':
    case 'turn/start':
    case 'turn/completed':
    case 'turn/complete':
    case 'thread/closed':
      return;
    case 'turn/failed':
    case 'turn/error': {
      acc.failed = true;
      return;
    }
    case 'error': {
      if (params['willRetry'] !== true) acc.failed = true;
      return;
    }

    case 'mcpServer/startupStatus/updated':
    case 'account/rateLimits/updated':
    case 'thread/status/changed':
    case 'remoteControl/status/changed':
      return;

    default: {
      hooks.onUnknownEvent?.(event);
      void toolKindFor(method); // keep helper referenced; classifier is available for callers.
      return;
    }
  }
}


export function extractCodexErrorCode(event: AppServerEvent): string | undefined {
  const params = event.params;
  if (!params) return undefined;
  const turnObj = params['turn'] as { error?: unknown } | undefined;
  const errInfo = params['error'] ?? turnObj?.error;
  if (typeof errInfo === 'string') return errInfo || undefined;
  if (errInfo && typeof errInfo === 'object') {
    const rec = errInfo as Record<string, unknown>;
    const explicit = rec['code'] ?? rec['kind'] ?? rec['type'];
    if (typeof explicit === 'string' && explicit) return explicit;
    const key = Object.keys(rec).find(
      (k) => k !== 'message' && k !== 'details' && k !== 'willRetry',
    );
    if (key) return key;
  }
  return undefined;
}


export type TurnOutcome = 'completed' | 'failed' | 'interrupted' | 'timeout' | 'auth_required';

export function finalizeResponse(
  acc: TranslatorAccumulator,
  outcome: TurnOutcome,
): CodexResponse {
  let status: CodexResponse['status'];
  if (acc.authRequired || outcome === 'auth_required') {
    status = 'auth_required';
  } else if (acc.timedOut || outcome === 'timeout') {
    status = 'timeout';
  } else if (acc.failed || outcome === 'failed' || outcome === 'interrupted') {
    status = 'failed';
  } else {
    status = 'completed';
  }

  return {
    threadId: acc.threadId ?? '',
    content: acc.content,
    filesChanged: acc.filesChanged,
    commandsRun: acc.commandsRun,
    usage: acc.usage,
    status,
    applyPatchFailures: acc.applyPatchFailures,
    applyPatchFailureSamples: acc.applyPatchFailureSamples,
    ...(acc.errorCode !== undefined && (status === 'failed' || status === 'timeout')
      ? { errorCode: acc.errorCode }
      : {}),
    ...(acc.lastUsage !== undefined ? { lastUsage: acc.lastUsage } : {}),
    ...(acc.modelContextWindow !== undefined
      ? { modelContextWindow: acc.modelContextWindow }
      : {}),
  };
}
