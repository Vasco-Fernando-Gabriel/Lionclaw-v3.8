import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { sep } from 'node:path';
import { createLogger } from '../logger';
import { resolveArtifactPath, sha256Hex } from './workflow-artifacts';
import type { DynamicWorkflowJournalCallKey, DynamicWorkflowJournalEntry } from './types';

const logger = createLogger('dynamic-workflow-checkpoints');

export const CHECKPOINTS_SUBDIR = 'checkpoints';

export interface DynamicWorkflowNodeCheckpointSummary {
  nodeId: string;
  attempt: number;
  inputHash: string | null;
  outputHash: string | null;
  worktreeCommitSha: string | null;
  schemaRef: string | null;
  agentId: string | null;
  revision?: string | null;
  savedAt: string;
}

export interface DynamicWorkflowRunCheckpointIndex {
  nodes: Record<string, DynamicWorkflowNodeCheckpointSummary>;
  [extra: string]: unknown;
}

export interface DynamicWorkflowNodeCheckpointFile {
  nodeId: string;
  attempt: number;
  inputHash: string | null;
  outputHash: string | null;
  worktreeCommitSha: string | null;
  schemaRef: string | null;
  agentId: string | null;
  revision?: string | null;
  state: unknown;
  savedAt: string;
}

export interface WorkflowCheckpointsDeps {
  getRunCheckpoint: (runId: string) => string | null;
  persistRunCheckpoint: (runId: string, checkpointJson: string) => void;
  now?: () => Date;
}

export interface SaveCheckpointInput {
  runId: string;
  runDir: string;
  nodeId: string;
  attempt: number;
  state: unknown;
  inputHash?: string | null;
  outputHash?: string | null;
  worktreeCommitSha?: string | null;
  schemaRef?: string | null;
  agentId?: string | null;
  revision?: string | null;
}

export interface SaveCheckpointResult {
  file: DynamicWorkflowNodeCheckpointFile;
  absolutePath: string;
  index: DynamicWorkflowRunCheckpointIndex;
}

function emptyIndex(): DynamicWorkflowRunCheckpointIndex {
  return { nodes: {} };
}

export function parseRunCheckpointIndex(raw: string | null | undefined): DynamicWorkflowRunCheckpointIndex {
  if (!raw) return emptyIndex();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyIndex();
  }
  if (!parsed || typeof parsed !== 'object') return emptyIndex();
  const obj = parsed as Record<string, unknown>;
  const nodes =
    obj['nodes'] && typeof obj['nodes'] === 'object'
      ? (obj['nodes'] as Record<string, DynamicWorkflowNodeCheckpointSummary>)
      : {};
  return { ...obj, nodes };
}

export function saveNodeCheckpoint(deps: WorkflowCheckpointsDeps, input: SaveCheckpointInput): SaveCheckpointResult {
  const now = (deps.now ?? (() => new Date()))();
  const savedAt = now.toISOString();

  const serializedState = safeSerialize(input.state);
  const outputHash = input.outputHash !== undefined ? input.outputHash : sha256Hex(serializedState);

  const file: DynamicWorkflowNodeCheckpointFile = {
    nodeId: input.nodeId,
    attempt: input.attempt,
    inputHash: input.inputHash ?? null,
    outputHash,
    worktreeCommitSha: input.worktreeCommitSha ?? null,
    schemaRef: input.schemaRef ?? null,
    agentId: input.agentId ?? null,
    revision: input.revision ?? null,
    state: input.state,
    savedAt,
  };

  const absolutePath = resolveArtifactPath(
    input.runDir,
    `${CHECKPOINTS_SUBDIR}/${sanitizeNodeIdForFile(input.nodeId)}.json`,
  );
  const parentDir = absolutePath.slice(0, absolutePath.lastIndexOf(sep)) || sep;
  mkdirSync(parentDir, { recursive: true });
  writeFileSync(absolutePath, JSON.stringify(file, null, 2), 'utf8');

  const index = parseRunCheckpointIndex(deps.getRunCheckpoint(input.runId));
  index.nodes[input.nodeId] = {
    nodeId: input.nodeId,
    attempt: input.attempt,
    inputHash: file.inputHash,
    outputHash: file.outputHash,
    worktreeCommitSha: file.worktreeCommitSha,
    schemaRef: file.schemaRef,
    agentId: file.agentId,
    revision: file.revision ?? null,
    savedAt,
  };
  deps.persistRunCheckpoint(input.runId, JSON.stringify(index));

  logger.info(
    {
      runId: input.runId,
      nodeId: input.nodeId,
      attempt: input.attempt,
      worktreeCommitSha: file.worktreeCommitSha,
    },
    'checkpoint de node persistido',
  );

  return { file, absolutePath, index };
}

export function readNodeCheckpoint(runDir: string, nodeId: string): DynamicWorkflowNodeCheckpointFile | null {
  let absolutePath: string;
  try {
    absolutePath = resolveArtifactPath(runDir, `${CHECKPOINTS_SUBDIR}/${sanitizeNodeIdForFile(nodeId)}.json`);
  } catch {
    return null;
  }
  if (!existsSync(absolutePath)) return null;
  try {
    const raw = readFileSync(absolutePath, 'utf8');
    const parsed = JSON.parse(raw) as DynamicWorkflowNodeCheckpointFile;
    if (!parsed || typeof parsed !== 'object' || parsed.nodeId !== nodeId) {
      return null;
    }
    return parsed;
  } catch (err) {
    logger.warn({ err, runId: runDir, nodeId }, 'checkpoint de node ilegivel (ignorado)');
    return null;
  }
}

export function readNodeCheckpointSummary(
  deps: Pick<WorkflowCheckpointsDeps, 'getRunCheckpoint'>,
  runId: string,
  nodeId: string,
): DynamicWorkflowNodeCheckpointSummary | null {
  const index = parseRunCheckpointIndex(deps.getRunCheckpoint(runId));
  return index.nodes[nodeId] ?? null;
}

function safeSerialize(state: unknown): string {
  try {
    return JSON.stringify(state ?? null);
  } catch {
    return 'null';
  }
}

function sanitizeNodeIdForFile(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

const JOURNAL_KEY_FIELDS: ReadonlyArray<keyof DynamicWorkflowJournalCallKey> = [
  'callPath',
  'primitive',
  'nodeId',
  'argHash',
  'schemaRef',
  'policyHash',
  'agentId',
  'model',
  'runtime',
  'planHash',
  'workflowRevision',
];

export function journalKeyMatches(
  journaled: DynamicWorkflowJournalCallKey,
  incoming: DynamicWorkflowJournalCallKey,
): boolean {
  for (const field of JOURNAL_KEY_FIELDS) {
    const inValue = incoming[field] ?? null;
    const jValue = journaled[field] ?? null;
    if ((field === 'model' || field === 'runtime') && inValue === null) continue;
    if (inValue !== jValue) return false;
  }
  return true;
}

export interface JournalReplayLookup {
  kind: 'reuse' | 'diverge' | 'fresh';
  entry?: DynamicWorkflowJournalEntry;
}

export function lookupJournalReplay(
  journal: ReadonlyArray<DynamicWorkflowJournalEntry>,
  callIndex: number,
  incoming: DynamicWorkflowJournalCallKey,
): JournalReplayLookup {
  const entry = journal.find((e) => e.callIndex === callIndex);
  if (!entry) return { kind: 'fresh' };
  if (journalKeyMatches(entry, incoming)) return { kind: 'reuse', entry };
  return { kind: 'diverge', entry };
}
