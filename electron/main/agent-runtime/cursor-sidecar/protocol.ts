export const CURSOR_SIDECAR_RPC_PREFIX = '@@LIONRPC@@';

export interface CursorCustomToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CursorSidecarExecuteConfig {
  executionId: string;
  model: string;
  apiKey: string;
  cwd: string;
  storeDir: string;
  prompt: string;
  settingSources: string[];
  allowedTools?: string[];
  guarded: boolean;
  sandbox?: boolean;
  customTools: CursorCustomToolDeclaration[];
  resumeAgentId?: string;
}

export interface CursorHostExecuteMessage {
  type: 'execute';
  config: CursorSidecarExecuteConfig;
}

export interface CursorHostToolResultMessage {
  type: 'tool-result';
  executionId: string;
  id: string;
  ok?: string;
  error?: string;
}

export interface CursorHostAbortMessage {
  type: 'abort';
  executionId: string;
  reason?: string;
}

export interface CursorHostPingMessage {
  type: 'ping';
  id: string;
}

export interface CursorHostShutdownMessage {
  type: 'shutdown';
}

export interface CursorHostListModelsMessage {
  type: 'list-models';
  id: string;
  apiKey: string;
}

export type CursorSidecarHostMessage =
  | CursorHostExecuteMessage
  | CursorHostToolResultMessage
  | CursorHostAbortMessage
  | CursorHostPingMessage
  | CursorHostShutdownMessage
  | CursorHostListModelsMessage;

export interface CursorSidecarUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface CursorSidecarReadyMessage {
  type: 'ready';
  pid: number;
  nodeVersion: string;
}

export interface CursorSidecarStartedMessage {
  type: 'execute-started';
  executionId: string;
  runId: string;
  agentId: string;
}

export interface CursorSidecarStreamEventMessage {
  type: 'stream-event';
  executionId: string;
  event: unknown;
}

export interface CursorSidecarToolInvokeMessage {
  type: 'tool-invoke';
  executionId: string;
  id: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface CursorSidecarResultMessage {
  type: 'execute-result';
  executionId: string;
  status: string;
  finalText: string;
  resultText?: string;
  usage?: CursorSidecarUsage;
  errorMessage?: string;
  errorCode?: string;
  agentId?: string;
  runId?: string;
  model?: string;
  durationMs?: number;
}

export interface CursorSidecarErrorMessage {
  type: 'execute-error';
  executionId: string;
  message: string;
  stack?: string;
}

export interface CursorSidecarPongMessage {
  type: 'pong';
  id: string;
}

export interface CursorSidecarFatalMessage {
  type: 'fatal';
  error: string;
}

export interface CursorSidecarModelEntry {
  id: string;
  displayName: string;
}

export interface CursorSidecarModelsResultMessage {
  type: 'models-result';
  id: string;
  models?: CursorSidecarModelEntry[];
  error?: string;
}

export type CursorSidecarMessage =
  | CursorSidecarReadyMessage
  | CursorSidecarStartedMessage
  | CursorSidecarStreamEventMessage
  | CursorSidecarToolInvokeMessage
  | CursorSidecarResultMessage
  | CursorSidecarErrorMessage
  | CursorSidecarPongMessage
  | CursorSidecarFatalMessage
  | CursorSidecarModelsResultMessage;

export function encodeSidecarLine(msg: CursorSidecarHostMessage | CursorSidecarMessage): string {
  return CURSOR_SIDECAR_RPC_PREFIX + JSON.stringify(msg) + '\n';
}

export function createSidecarLineDecoder(
  onMessage: (msg: Record<string, unknown>) => void,
  onGarbage?: (line: string) => void,
): (chunk: Buffer | string) => void {
  let buffer = '';
  return (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
      if (!line.startsWith(CURSOR_SIDECAR_RPC_PREFIX)) {
        if (line.trim().length > 0) onGarbage?.(line);
        continue;
      }
      try {
        const parsed = JSON.parse(line.slice(CURSOR_SIDECAR_RPC_PREFIX.length)) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          onMessage(parsed as Record<string, unknown>);
        } else {
          onGarbage?.(line);
        }
      } catch {
        onGarbage?.(`parse-error: ${line}`);
      }
    }
  };
}
