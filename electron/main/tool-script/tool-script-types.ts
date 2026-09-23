import type { AgentPermissionProfile } from '../agent-runtime/types';
import type { ChatFeatureToggles } from '../../../src/types';

export const TOOL_SCRIPT_DEFAULT_TOOLS: readonly string[] = [
  'read_file',
  'write_file',
  'edit',
  'grep',
  'search_files',
  'run_command',
  'mcp_invoke',
];

export const TOOL_SCRIPT_DEFAULT_TIMEOUT_MS = 300_000;

export const TOOL_SCRIPT_DEFAULT_RPC_TIMEOUT_MS = 120_000;

export const TOOL_SCRIPT_DEFAULT_MAX_STDOUT_BYTES = 50_000;

export const TOOL_SCRIPT_DEFAULT_MAX_STDERR_BYTES = 10_000;

export const TOOL_SCRIPT_DEFAULT_MAX_TOOL_CALLS = 50;

export const TOOL_SCRIPT_HARD_BUFFER_CAP_BYTES = 5 * 1024 * 1024;

export interface ToolScriptRpcRequestFrame {
  id: number;
  tool: string;
  args: Record<string, unknown>;
  token: string;
}

export interface ToolScriptRpcResponseFrame {
  id: number;
  ok: boolean;
  result?: string;
  error?: string;
}

export interface ToolScriptHeartbeatFrame {
  id: number;
  heartbeat: true;
}

export interface ToolScriptRpcCall {
  id: number;
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolScriptDispatchContext {
  sessionId: string;
  turnId: string;
  cwd: string;
  permissionProfile: AgentPermissionProfile;
  allowedServerIds: readonly string[];
  capabilities: ChatFeatureToggles;
  pauseTimeout(): void;
  resumeTimeout(): void;
}

export type ToolScriptRpcDispatcher = (call: ToolScriptRpcCall, ctx: ToolScriptDispatchContext) => Promise<string>;

export interface ToolScriptEngineDeps {
  dispatchRpc: ToolScriptRpcDispatcher;
  buildEnv?: () => NodeJS.ProcessEnv;
  enabledTools?: readonly string[];
  timeoutMs?: number;
  rpcTimeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxToolCalls?: number;
  pythonPath?: string;
}

export interface ToolScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  toolCallCount: number;
  timedOut: boolean;
  aborted: boolean;
  persistedPath?: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  toolCallLimitExceeded: boolean;
}

export type ToolScriptErrorCode =
  'turn-context-missing' | 'turn-context-incomplete' | 'python-unavailable' | 'invalid-tool-name';

export class ToolScriptError extends Error {
  readonly code: ToolScriptErrorCode;

  constructor(code: ToolScriptErrorCode, message: string) {
    super(message);
    this.name = 'ToolScriptError';
    this.code = code;
  }
}
