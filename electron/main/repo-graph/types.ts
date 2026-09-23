import type { RepoGraphRunKind } from '../../../src/types/repo-graph';

export type {
  LocalRepositoryStatus,
  LocalRepositoryRecord,
  RepoGraphRunKind,
  RepoGraphRunStatus,
  RepoGraphRunRecord,
  SessionActiveRepositoryRecord,
  RepoGraphUsageSource,
  RepoGraphTurnUsageRecord,
  RepoStalenessResult,
  SessionRepoGraphState,
  RepoGraphStatusEvent,
  RepoGraphTurnSample,
  RepoGraphSavingsGroup,
  RepoGraphSavingsMetrics,
} from '../../../src/types/repo-graph';

export interface RepoGraphProviderStats {
  files?: number;
  nodes?: number;
  edges?: number;
}

export interface RepoGraphProviderStatus {
  exists: boolean;
  stats?: RepoGraphProviderStats;
  statusText?: string;
  error?: string;
}

export interface RepoGraphSearchInput {
  rootPath: string;
  term: string;
  kind?: string;
  limit?: number;
}

export interface RepoGraphSymbol {
  name: string;
  kind: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  signature?: string;
  isExported?: boolean;
  score?: number;
}

export interface RepoGraphSearchResult {
  symbols: RepoGraphSymbol[];
}

export interface RepoGraphNodeInput {
  rootPath: string;
  name: string;
}

export interface RepoGraphNodeResult {
  node: RepoGraphSymbol | null;
}

export interface RepoGraphCallInput {
  rootPath: string;
  symbol: string;
  limit?: number;
}

export interface RepoGraphCallResult {
  symbol: string;
  related: RepoGraphSymbol[];
}

export interface RepoGraphImpactInput {
  rootPath: string;
  symbol: string;
  depth?: number;
}

export interface RepoGraphImpactResult {
  symbol: string;
  depth: number;
  nodeCount: number;
  edgeCount: number;
  affected: RepoGraphSymbol[];
}

export interface RepoGraphFilesInput {
  rootPath: string;
  filter?: string;
}

export interface RepoGraphFileEntry {
  path: string;
  language?: string;
  nodeCount?: number;
  size?: number;
}

export interface RepoGraphFilesResult {
  files: RepoGraphFileEntry[];
}

export interface RepoGraphContextInput {
  rootPath: string;
  repositoryId: string;
  task: string;
}

export interface RepoGraphContext {
  repositoryId: string;
  rootPath: string;
  files: Array<{ path: string; reason: string }>;
  symbols: Array<{ name: string; kind: string; file: string; line?: number }>;
  callEdges?: Array<{ from: string; to: string }>;
  renderedMarkdown: string;
}

export interface RepoGraphBuildInput {
  rootPath: string;
  kind: RepoGraphRunKind;
  onProgress?: (chunkText: string) => void;
  signal?: AbortSignal;
}

export interface RepoGraphRunResult {
  status: 'done' | 'error' | 'cancelled';
  output: string;
  error?: string;
  durationMs: number;
}

export interface RepoGraphReader {
  detect(rootPath: string): Promise<RepoGraphProviderStatus>;
  search(input: RepoGraphSearchInput): Promise<RepoGraphSearchResult>;
  minimalContext(input: RepoGraphContextInput): Promise<RepoGraphContext>;
  impact(input: RepoGraphImpactInput): Promise<RepoGraphImpactResult>;
  node(input: RepoGraphNodeInput): Promise<RepoGraphNodeResult>;
  callers(input: RepoGraphCallInput): Promise<RepoGraphCallResult>;
  callees(input: RepoGraphCallInput): Promise<RepoGraphCallResult>;
}

export interface RepoGraphWriter {
  build(input: RepoGraphBuildInput): Promise<RepoGraphRunResult>;
  update(input: RepoGraphBuildInput): Promise<RepoGraphRunResult>;
}

export interface RepoStalenessInput {
  repositoryId: string;
  canonicalRootPath: string;
  indexedCommit: string | null;
  lastIndexedAt: string | null;
}

export type ValidateRepoRootResult =
  | {
      canonicalRootPath: string;
      gitRoot: string | null;
      name: string;
    }
  | { error: string };
