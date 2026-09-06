import type { CliRunOptions } from '../agent-runtime/cli-agentic/contract';
import type { AgentPermissionProfile } from '../agent-runtime/types';

export interface GrokAcpNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface GrokAcpSessionUpdate {
  sessionUpdate: string;
  content?: { type?: string; text?: string } | Array<{ type?: string; text?: string }>;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: unknown;
}

export interface GrokAcpMcpServerEntry {
  id: string;
  name: string;
  type: 'http' | 'sse';
  url: string;
  headers: Array<{ name: string; value: string }>;
  env: Array<{ name: string; value: string }>;
}

export type GrokAcpProfile = 'chat' | 'remote-chat' | 'pipeline' | 'agent-scoped' | 'one-shot' | 'workflow';
export type GrokEffort = 'low' | 'medium' | 'high';

export interface GrokAcpRunSessionKey {
  surface: 'chat' | 'pipeline' | 'agent' | 'workflow' | 'oneshot';
  ownerKind: string;
  runId: string;
  projectId?: string;
  agentId?: string;
  ownerId?: string;
}

export interface GrokAcpRegistrableHandle {
  key: GrokAcpRunSessionKey;
  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed' | 'closed';
  createdAt: number;
  lastActivityAt: number;
  hasStartedTurn: boolean;
  close(): Promise<void>;
}

export interface GrokAcpRunOptions extends CliRunOptions {
  processCwd?: string;
  attestSession?: (sessionId: string) => void | Promise<void>;
  assertWorkspaceUnchanged?: () => void | Promise<void>;
  effort?: GrokEffort;
  profile?: GrokAcpProfile;
  permission?: AgentPermissionProfile;
  sandbox?: string;
  nativeToolArgs?: string[];
  surface?: GrokAcpRunSessionKey['surface'];
  ownerKind?: string;
  runId?: string;
  projectId?: string;
  agentId?: string;
  ownerId?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  cancelGraceMs?: number;
  handshakeTimeoutMs?: number;
  mcpServers?: GrokAcpMcpServerEntry[];
}

export interface GrokModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  reasoningTokens: number;
  modelCalls?: number;
  costUsdTicks?: number;
}

export interface GrokAcpUsage {
  reported?: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  providerInputTokens?: number;
  reasoningTokens?: number;
  modelCalls?: number;
  apiDurationMs?: number;
  costUsdTicks?: number;
  numTurns?: number;
  modelUsage?: Record<string, GrokModelUsage>;
}
