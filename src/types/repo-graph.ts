

export type LocalRepositoryStatus = 'absent' | 'building' | 'ready' | 'stale' | 'error';

export interface LocalRepositoryRecord {
  id: string;
  name: string;
  rootPath: string;
  canonicalRootPath: string;
  gitRoot: string | null;
  provider: string;
  graphPath: string | null;
  status: LocalRepositoryStatus;
  indexedCommit: string | null;
  indexedWorktreeHash: string | null;
  lastIndexedAt: string | null;
  statsJson: string | null;
  graphPromptSuppressedGlobal: boolean;
  settingsJson: string;
  createdAt: string;
  updatedAt: string;
}

export type RepoGraphRunKind = 'build' | 'update';
export type RepoGraphRunStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface RepoGraphRunRecord {
  id: string;
  repositoryId: string;
  sessionId: string | null;
  provider: string;
  kind: RepoGraphRunKind;
  status: RepoGraphRunStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  output: string | null;
  error: string | null;
  statsJson: string | null;
}

export interface SessionActiveRepositoryRecord {
  sessionId: string;
  repositoryId: string;
  graphPromptSuppressed: boolean;
  attachedAt: string;
  updatedAt: string;
}

export type RepoGraphUsageSource =
  | 'orchestrator-mcp'
  | 'subagent-mcp'
  | 'prefetch'
  | 'runtime-limited'
  | 'build';

export interface RepoGraphTurnUsageRecord {
  id: string;
  sessionId: string;
  turnIndex: number;
  repositoryId: string;
  source: RepoGraphUsageSource;
  runtime: string | null;
  toolName: string | null;
  used: boolean;
  reason: string | null;
  resultCount: number;
  bytesReturned: number;
  durationMs: number;
  createdAt: string;
}


export interface RepoStalenessResult {
  stale: boolean;
  reason?: string;
}

export interface SessionRepoGraphState {
  sessionId: string;
  repository: LocalRepositoryRecord | null;
  attach: SessionActiveRepositoryRecord | null;
  staleness: RepoStalenessResult | null;
  activeRun: RepoGraphRunRecord | null;
}

export interface RepoGraphStatusEvent {
  repositoryId: string;
  sessionId: string | null;
  status: LocalRepositoryStatus;
  runId?: string;
  runStatus?: RepoGraphRunStatus;
  kind?: RepoGraphRunKind;
  buildProgress?: string;
  error?: string;
}


export interface RepoGraphTurnSample {
  toolCalls: number;
  tokens: number;
}

export interface RepoGraphSavingsGroup {
  turns: number;
  avgToolCalls: number | null;
  avgTokens: number | null;
}

export interface RepoGraphSavingsMetrics {
  withRepo: RepoGraphSavingsGroup;
  withoutRepo: RepoGraphSavingsGroup;
  toolCallsSavingsPct: number | null;
  tokensSavingsPct: number | null;
  minTurnsWindow: number;
  windowMet: boolean;
}


export type RepoGraphBadgeState =
  | 'no-repo' // apagada — nenhum repositorio ativo nesta conversa
  | 'graph-absent' // apagada com CTA — graph ausente, clique para criar
  | 'building' // discreta animada — indexando repositorio
  | 'ready' // discreta — CodeGraph pronto (nao usado no turno)
  | 'used-in-turn' // acesa — CodeGraph usado neste turno
  | 'stale' // amarela — graph desatualizado, clique para atualizar
  | 'error' // vermelha discreta — erro no CodeGraph
  | 'runtime-limited'; // discreta com aviso — runtime usando contexto precomputado


export interface RepoGraphStatusResult {
  repository: LocalRepositoryRecord;
  detect: {
    exists: boolean;
    stats?: { files?: number; nodes?: number; edges?: number };
    statusText?: string;
    error?: string;
  };
  staleness: RepoStalenessResult | null;
}

export interface RepoGraphAPI {
  list: () => Promise<LocalRepositoryRecord[] | { error: string }>;
  addRepository: (rawPath: string) => Promise<LocalRepositoryRecord | { error: string }>;
  removeRepository: (repositoryId: string) => Promise<{ ok: true } | { error: string }>;
  getSessionState: (sessionId: string) => Promise<SessionRepoGraphState | { error: string }>;
  attachSession: (
    sessionId: string,
    repositoryId: string,
  ) => Promise<{ ok: true } | { error: string }>;
  detachSession: (sessionId: string) => Promise<{ ok: true } | { error: string }>;
  setPromptSuppressed: (
    sessionId: string,
    suppressed: boolean,
  ) => Promise<{ ok: true } | { error: string }>;
  setGlobalPromptSuppressed: (
    repositoryId: string,
    suppressed: boolean,
  ) => Promise<{ ok: true } | { error: string }>;
  status: (repositoryId: string) => Promise<RepoGraphStatusResult | { error: string }>;
  metrics: () => Promise<RepoGraphSavingsMetrics | { error: string }>;
  build: (
    repositoryId: string,
    sessionId?: string | null,
  ) => Promise<{ runId: string } | { error: string }>;
  update: (
    repositoryId: string,
    sessionId?: string | null,
  ) => Promise<{ runId: string } | { error: string }>;
  onStatus: (cb: (event: RepoGraphStatusEvent) => void) => () => void;
}

declare module './index' {
  interface LionClawAPI {
    repoGraph: RepoGraphAPI;
  }
}
