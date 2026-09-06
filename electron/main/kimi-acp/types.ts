
import type { CliRunOptions } from '../agent-runtime/cli-agentic/contract';
import type { AgentPermissionProfile } from '../agent-runtime/types';
import type { KimiEffectiveThinking } from '../../../src/constants/kimi-models';

export interface AcpNotification {
  method: string; // e.g. "session/update"
  params: Record<string, unknown>;
}

export interface AcpSessionUpdate {
  sessionUpdate: string; // agent_message_chunk | agent_thought_chunk | tool_call | tool_call_update | ...
  content?: { type?: string; text?: string };
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string; // pending | in_progress | completed
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface KimiAcpRunSessionKey {
  surface: 'pipeline' | 'chat' | 'agent' | 'oneshot';
  ownerKind: 'pipeline' | 'chat' | 'agent' | 'oneshot';
  runId: string; // REQUIRED on every key
  projectId?: string;
  agentId?: string;
  ownerId?: string;
}

export interface KimiAcpRegistrableHandle {
  key: KimiAcpRunSessionKey;
  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'interrupted' | 'closed' | 'failed';
  createdAt?: number;
  lastActivityAt?: number;
  hasStartedTurn?: boolean;
  close(): Promise<void>;
}

export type KimiAcpProfile = 'chat' | 'pipeline' | 'agent-scoped' | 'one-shot';

export interface KimiAcpMcpServerEntry {
  id: string;
  name: string;
  type: 'http' | 'sse';
  url: string;
  headers: Array<{ name: string; value: string }>; // observed-empty `[]` accepted by the wire
  env: Array<{ name: string; value: string }>; // observed-empty `[]` accepted by the wire
}

export interface KimiAcpRunOptions extends CliRunOptions {
  permission?: AgentPermissionProfile;
  effectiveThinking?: KimiEffectiveThinking;
  profile?: KimiAcpProfile;
  surface?: KimiAcpRunSessionKey['surface'];
  ownerKind?: KimiAcpRunSessionKey['ownerKind'];
  runId?: string;
  projectId?: string;
  agentId?: string;
  ownerId?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  cancelGraceMs?: number;
  handshakeTimeoutMs?: number;
  mcpServers?: KimiAcpMcpServerEntry[];
}
