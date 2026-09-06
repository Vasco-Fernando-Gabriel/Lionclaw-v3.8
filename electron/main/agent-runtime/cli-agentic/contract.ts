
export interface CliStreamCallbacks {
  onText?: (chunk: string) => void;
  onThinking?: (chunk: string) => void;
  onToolUse?: (tool: string, toolCallId?: string) => void;
  onToolUseComplete?: (tool: string, input: unknown, toolCallId?: string) => void;
  onToolUseIO?: (tool: string, input: unknown, output: unknown, toolCallId?: string) => void;
  onActivity?: () => void;
}

export interface CliRunOptions {
  workDir: string;
  model: string;
  effort?: string;
  thinking: boolean;
  systemPrompt: string;
  executable?: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
}

export interface CliAgenticResponse {
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  toolUses: number;
  status: 'finished' | 'cancelled' | 'max_steps_reached';
}

export interface CliRunHandle {
  send(prompt: string, cb?: CliStreamCallbacks, abortSignal?: AbortSignal): Promise<CliAgenticResponse>;
  reply(message: string, cb?: CliStreamCallbacks, abortSignal?: AbortSignal): Promise<CliAgenticResponse>;
  interrupt(reason?: string): Promise<void>;
  close(): Promise<void>;
  forceKillFallback(reason: string): Promise<void>;
}

export interface CliAgenticRuntime {
  isAvailable(): Promise<{
    installed: boolean;
    authenticated: boolean;
    authMode: 'subscription' | 'none';
    version?: string;
    error?: string;
  }>;
  createRun(opts: CliRunOptions): Promise<CliRunHandle>;
}
