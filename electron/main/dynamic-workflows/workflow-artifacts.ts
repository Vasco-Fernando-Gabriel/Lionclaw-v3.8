
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createLogger } from '../logger';
import type {
  DynamicWorkflowArtifact,
  DynamicWorkflowArtifactInsertInput,
} from './types';

const logger = createLogger('dynamic-workflow-artifacts');

export class WorkflowArtifactPathError extends Error {
  readonly code = 'artifact-path-escape';
  readonly runDir: string;
  readonly attemptedPath: string;
  constructor(runDir: string, attemptedPath: string, detail: string) {
    super(
      `artifact path fora do run dir do workflow: ${detail} (runDir=${runDir}, alvo=${attemptedPath})`,
    );
    this.name = 'WorkflowArtifactPathError';
    this.runDir = runDir;
    this.attemptedPath = attemptedPath;
  }
}

export interface WorkflowArtifactsDeps {
  registerArtifact: (
    input: DynamicWorkflowArtifactInsertInput,
  ) => DynamicWorkflowArtifact;
  generateId?: () => string;
}

export interface WriteArtifactInput {
  runId: string;
  runDir: string;
  relativePath: string;
  content: string;
  kind: string;
  nodeId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface WriteArtifactResult {
  artifact: DynamicWorkflowArtifact;
  absolutePath: string;
  sha256: string;
}

function defaultGenerateId(): string {
  return `dwfa_${createHash('sha256')
    .update(`${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 24)}`;
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function resolveArtifactPath(
  runDir: string,
  target: string,
): string {
  const canonicalRoot = existsSync(runDir) ? realpathSync(runDir) : resolve(runDir);

  const absoluteTarget = isAbsolute(target) ? resolve(target) : resolve(canonicalRoot, target);

  const canonicalTarget = canonicalizeExisting(absoluteTarget);

  if (!isWithin(canonicalRoot, canonicalTarget)) {
    throw new WorkflowArtifactPathError(
      canonicalRoot,
      target,
      'o caminho resolvido escapa a raiz do run dir',
    );
  }
  return canonicalTarget;
}

function isWithin(root: string, child: string): boolean {
  if (child === root) return true;
  const rel = relative(root, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function canonicalizeExisting(absoluteTarget: string): string {
  if (existsSync(absoluteTarget)) {
    return realpathSync(absoluteTarget);
  }
  const segments = absoluteTarget.split(sep);
  for (let i = segments.length - 1; i > 0; i--) {
    const prefix = segments.slice(0, i).join(sep) || sep;
    if (existsSync(prefix)) {
      const realPrefix = realpathSync(prefix);
      const remainder = segments.slice(i);
      return join(realPrefix, ...remainder);
    }
  }
  return absoluteTarget;
}

export function writeArtifact(
  deps: WorkflowArtifactsDeps,
  input: WriteArtifactInput,
): WriteArtifactResult {
  const absolutePath = resolveArtifactPath(input.runDir, input.relativePath);

  const parentDir = absolutePath.slice(0, absolutePath.lastIndexOf(sep)) || sep;
  mkdirSync(parentDir, { recursive: true });

  writeFileSync(absolutePath, input.content, 'utf8');
  const sha256 = sha256Hex(input.content);

  const id = (deps.generateId ?? defaultGenerateId)();
  const artifact = deps.registerArtifact({
    id,
    runId: input.runId,
    nodeId: input.nodeId ?? null,
    kind: input.kind,
    path: absolutePath,
    sha256,
    metadataJson: JSON.stringify(input.metadata ?? {}),
  });

  logger.info(
    { runId: input.runId, kind: input.kind, path: absolutePath, sha256 },
    'artifact gravado e registrado',
  );

  return { artifact, absolutePath, sha256 };
}

export function runLogPath(runDir: string, fileName: string): string {
  return resolveArtifactPath(runDir, join('logs', fileName));
}
