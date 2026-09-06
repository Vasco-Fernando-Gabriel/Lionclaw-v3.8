import type { DynamicWorkflowNodeRun } from './dynamic-workflow';

export interface CockpitNodeRun extends DynamicWorkflowNodeRun {
  label?: string | null;
  worktreeCommitSha?: string | null;
}

export interface RunBundleEntry {
  name: string;
  relativePath: string;
  sizeBytes: number;
  mtime: string;
}

export interface DynamicWorkflowCockpitOptionalAPI {
  getRunBundle?: (runId: string) => Promise<RunBundleEntry[] | { error: string }>;
  openRunDir?: (runId: string) => Promise<{ ok: true } | { error: string }>;
}

export interface WriterCommitInfo {
  nodeId: string;
  phaseId: string | null;
  attempt: number;
  label: string | null;
  agentId: string | null;
  worktreeCommitSha: string | null;
  touchedFiles: string[];
}

export interface TouchedFilesFromEvents {
  files: string[];
  hidden: number;
  truncated: boolean;
  writers: WriterCommitInfo[];
}
