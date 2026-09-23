export type SwarmRuntime = 'cloud' | 'codex' | 'zai' | 'minimax-tp' | 'kimi' | 'local' | 'external';
export type SwarmMember =
  | { kind: 'registered'; agentId: string }
  | {
      kind: 'ephemeral';
      runtime: SwarmRuntime;
      model: string;
      rolePrompt: string;
      allowedTools: string[];
      providerProfileId?: string;
    };
export type SwarmStartInput = {
  requestId: string;
  cwd: string;
  objective: string;
  knownContext?: string;
} & (
  | { mode: 'fanout'; promptTemplate: string; member: SwarmMember; items: Array<{ target: string }> }
  | { mode: 'comite'; target: string; members: Array<{ slug: string; objective: string; member: SwarmMember }> }
);
export interface SwarmSettings {
  concurrencyCap: number;
  maxAttempts: number;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
}
export const DEFAULT_SWARM_SETTINGS: Readonly<SwarmSettings> = {
  concurrencyCap: 5,
  maxAttempts: 2,
  idleTimeoutMs: 20 * 60_000,
  hardTimeoutMs: 2 * 60 * 60_000,
};
export type SwarmRunStatus = 'queued' | 'running' | 'aborting' | 'done' | 'partial' | 'failed' | 'aborted';
export type SwarmItemStatus = 'pending' | 'running' | 'stopping' | 'retrying' | 'ok' | 'failed' | 'cancelled';
export type SwarmOutcome =
  | 'ok'
  | 'timeout-idle'
  | 'timeout-hard'
  | 'provider-error'
  | 'crash'
  | 'bad-trailer'
  | 'invalid-findings'
  | 'task-failed'
  | 'cancelled'
  | 'interrupted'
  | 'auth-required'
  | 'unsupported-capability';
export interface SwarmError {
  code: string;
  message: string;
  retryable: boolean;
}
export interface SwarmMetrics {
  costUsd: number | null;
  costStatus: 'known' | 'unknown' | 'estimated-partial';
  tokenStatus?: 'reported' | 'not_reported';
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  costStatusReasons?: readonly string[];
}
export interface SwarmAttempt {
  id: string;
  n: number;
  startedAt: string;
  endedAt: string | null;
  outcome: SwarmOutcome | null;
  error: SwarmError | null;
  terminationConfirmedAt: string | null;
  outputFile: string;
  findingsFile: string;
  validatedContentHash: string | null;
  metrics: SwarmMetrics;
}
export interface SwarmItem {
  slug: string;
  target: string;
  prompt: string;
  member: SwarmMember;
  runtime: SwarmRuntime;
  model: string;
  resolvedConfigFile: string;
  status: SwarmItemStatus;
  currentAttemptId: string | null;
  nextAttemptAt: string | null;
  attempts: SwarmAttempt[];
  findingsFile: string | null;
  summary: string | null;
  lastSignalAt: string | null;
  error: SwarmError | null;
}
export interface SwarmRun {
  delivery?: { status: 'pending' | 'claimed' | 'delivered' | 'undeliverable'; error?: string | null };
  schemaVersion: 1;
  revision: number;
  terminalRevision: number | null;
  runId: string;
  chatSessionId: string;
  requestId: string;
  requestHash: string;
  mode: 'fanout' | 'comite';
  cwd: string;
  objective: string;
  status: SwarmRunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  settings: SwarmSettings;
  items: SwarmItem[];
}
export interface SwarmRunSummary {
  runId: string;
  chatSessionId: string;
  revision: number;
  mode: 'fanout' | 'comite';
  status: SwarmRunStatus;
  itemCount: number;
  createdAt: string;
  finishedAt: string | null;
  costUsd: number | null;
}
export interface SwarmCatalog {
  members: Array<{
    agentId: string;
    name: string;
    description: string;
    runtime: SwarmRuntime;
    model: string;
    available: boolean;
    reason?: string;
  }>;
  profiles: Array<{ id: string; runtime: SwarmRuntime; model: string; available: boolean; reason?: string }>;
}
export type SwarmFindingsOperation =
  | { operation: 'begin'; uploadId: string }
  | { operation: 'chunk'; uploadId: string; seq: number; content: string }
  | { operation: 'finalize'; uploadId: string; chunkCount: number; sha256: string };
export interface SwarmFindingsAck {
  uploadId: string;
  nextSeq: number;
  sha256: string;
  findingsFile?: string;
}
export type SwarmResult<T> = T | { error: string; code: string };
export interface SwarmAPI {
  openFindings: (sessionId: string, runId: string, slug: string) => Promise<SwarmResult<{ opened: true }>>;
  start: (sessionId: string, input: SwarmStartInput) => Promise<SwarmResult<{ runId: string; status: SwarmRunStatus }>>;
  abort: (sessionId: string, runId: string) => Promise<SwarmResult<SwarmRun>>;
  getRunState: (sessionId: string, runId: string) => Promise<SwarmResult<SwarmRun>>;
  listRuns: (
    sessionId: string,
    cursor?: string,
    limit?: number,
  ) => Promise<SwarmResult<{ runs: SwarmRunSummary[]; nextCursor: string | null }>>;
  getCatalog: (sessionId: string) => Promise<SwarmResult<SwarmCatalog>>;
  getSettings: () => Promise<SwarmResult<SwarmSettings>>;
  setSettings: (settings: SwarmSettings) => Promise<SwarmResult<SwarmSettings>>;
  onStream: (callback: (event: { runId: string; chatSessionId: string; revision: number }) => void) => () => void;
}
