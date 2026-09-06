
export interface CodexSessionOptions {
  model: string;
  cwd: string;
  systemPrompt?: string;
  approvalPolicy?: 'never' | 'on-request' | 'auto-edit';
  sandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  timeoutMs?: number;
  idleTimeoutMs?: number;
  projectId?: string;
  ownerKind?: 'chat' | 'pipeline';
  ownerId?: string;
}

export interface CodexToolUseMeta {
  callId?: string;
  kind?: 'bash' | 'file' | 'mcp' | 'web' | 'image';
}

export interface CodexStreamCallbacks {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolUse?: (tool: string, meta?: CodexToolUseMeta) => void;
  onToolUseComplete?: (tool: string, result: unknown, meta?: { callId?: string }) => void;
  onActivity?: () => void;
}

export interface CodexTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexPatchFailureSample {
  source: 'tool-output' | 'stderr';
  text: string;
  ts: number;
}

export interface CodexResponse {
  threadId: string;
  content: string;
  filesChanged: string[];
  commandsRun: Array<{ cmd: string; exitCode: number; durationMs: number }>;
  usage: CodexTokenUsage;
  status: 'completed' | 'failed' | 'timeout' | 'auth_required';
  applyPatchFailures: number;
  applyPatchFailureSamples: CodexPatchFailureSample[];
  errorCode?: string;
  lastUsage?: CodexTokenUsage;
  modelContextWindow?: number;
}

export interface CodexSession {
  threadId: string | null;
  send(
    prompt: string,
    cb?: CodexStreamCallbacks,
    abortSignal?: AbortSignal,
  ): Promise<CodexResponse>;
  reply(
    message: string,
    cb?: CodexStreamCallbacks,
    abortSignal?: AbortSignal,
  ): Promise<CodexResponse>;
  close(): void;
  setReasoningEffort?(effort: NonNullable<CodexSessionOptions['reasoningEffort']>): void;
}


export type CodexImplementation = 'official-app-server';

export type CodexSurface =
  | 'chat'
  | 'pipeline'
  | 'one-shot'
  | 'codex-agents-mcp';

export type CodexSelectableSurface = CodexSurface | 'agent-scoped';

export type CodexOwnerKind = 'chat' | 'pipeline';

export type CodexMcpProfile =
  | 'chat'
  | 'pipeline'
  | 'one-shot'
  | 'agent-scoped';

export interface CodexRunSessionKey {
  surface: CodexSurface;
  projectId?: string;
  phaseNumber?: number;
  agentId?: string;
  runId: string;
  attemptId?: string;
  sprintIndex?: number;
  loopIteration?: number;
  ownerKind: CodexOwnerKind;
  ownerId?: string;
  mcpProfile: CodexMcpProfile;
  allowedMcpServerIds?: string[];
  allowedMcpToolNames?: string[];
}

export interface CodexRunOptions {
  key: CodexRunSessionKey;
  model: string;
  cwd: string;
  systemPrompt?: string;
  approvalPolicy: 'never' | 'on-request' | 'auto-edit';
  sandbox: 'workspace-write' | 'read-only' | 'danger-full-access';
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  timeoutMs?: number;
  idleTimeoutMs?: number;
  disableGlobalMcp?: boolean;
  extraArgs?: string[];
}

export interface CodexRunHandle {
  key: CodexRunSessionKey;
  implementation: CodexImplementation;
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  status: 'idle' | 'running' | 'completed' | 'interrupted' | 'closed' | 'failed';

  createdAt?: number;
  lastActivityAt?: number;

  hasStartedTurn?: boolean;

  send(
    prompt: string,
    cb?: CodexStreamCallbacks,
    abortSignal?: AbortSignal,
  ): Promise<CodexResponse>;
  reply(
    message: string,
    cb?: CodexStreamCallbacks,
    abortSignal?: AbortSignal,
  ): Promise<CodexResponse>;

  interrupt(reason?: string): Promise<void>;
  close(): Promise<void>;
  waitClosed(timeoutMs: number): Promise<boolean>;
  forceKillFallback(reason: string): Promise<void>;
}

export interface CodexAvailability {
  installed: boolean;
  authenticated: boolean;
  appServerSupported: boolean;
  implementation: CodexImplementation;
  version?: string;
  error?: string;
}

export interface CodexDriver {
  implementation: CodexImplementation;
  createRun(opts: CodexRunOptions): Promise<CodexRunHandle>;
  hasActiveRun(scope: Partial<CodexRunSessionKey>): boolean;
  closeScope(scope: Partial<CodexRunSessionKey>, reason: string): Promise<void>;
  resetProjectFallback(projectId: string, reason: string): Promise<void>;
  isAvailable(): Promise<CodexAvailability>;
  shutdown(): Promise<void>;
}


export interface SyncCodexSession {
  threadId: string | null;
  send(
    prompt: string,
    cb?: CodexStreamCallbacks,
    abortSignal?: AbortSignal,
  ): Promise<CodexResponse>;
  reply(
    message: string,
    cb?: CodexStreamCallbacks,
    abortSignal?: AbortSignal,
  ): Promise<CodexResponse>;
  close(): void;
  setReasoningEffort?(effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'): void;
}
