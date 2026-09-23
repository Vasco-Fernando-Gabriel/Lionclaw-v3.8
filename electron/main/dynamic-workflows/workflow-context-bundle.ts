import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createLogger } from '../logger';
import type {
  DynamicWorkflowAgentSummary,
  DynamicWorkflowBaselineCommand,
  DynamicWorkflowBaselineResult,
  DynamicWorkflowContextBundle,
  DynamicWorkflowGateTemplate,
} from './types';

const logger = createLogger('dynamic-workflow-context-bundle');

export const CONTEXT_BUNDLE_FILE = 'context-bundle.json';

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface ContextBundleGitInfo {
  gitRoot: string | null;
  commitSha: string | null;
  worktreeHash: string | null;
}

export interface ContextBundleRepoGraphInfo {
  repoGraphRunId: string | null;
  repoGraphPath: string | null;
  repoScanId: string | null;
}

export interface ContextBundleDeps {
  readTextFile?: (path: string) => string;
  pathExists?: (path: string) => boolean;
  probeGit?: (projectPath: string) => ContextBundleGitInfo;
  loadAgentCatalog: () => DynamicWorkflowAgentSummary[];
  loadRepoGraph?: (projectPath: string) => ContextBundleRepoGraphInfo;
  generateId?: (specSha256: string) => string;
  now?: () => string;
}

export interface BuildContextBundleInput {
  projectPath: string;
  runDir: string;
  specPath?: string | null;
  specText?: string | null;
  createdBy: 'orchestrator' | 'manual';
  relevantFiles?: DynamicWorkflowContextBundle['relevantFiles'];
  protectedPaths?: string[];
  baselineCommands?: DynamicWorkflowBaselineCommand[];
  baselineResults?: DynamicWorkflowBaselineResult[];
  knownGates?: DynamicWorkflowGateTemplate[];
}

export interface BuildContextBundleResult {
  bundle: DynamicWorkflowContextBundle;
  bundlePath: string;
  sha256: string;
}

export class ContextBundleSpecError extends Error {
  readonly code = 'context-bundle-spec-missing';
  constructor(detail: string) {
    super(`SPEC ausente ou ilegivel para o context bundle: ${detail}`);
    this.name = 'ContextBundleSpecError';
  }
}

function defaultReadTextFile(path: string): string {
  return readFileSync(path, 'utf8');
}

interface PackageScriptsInfo {
  packageScripts: Record<string, string>;
  hasBuildScript: boolean;
}

function readPackageScripts(
  projectPath: string,
  readTextFile: (path: string) => string,
  pathExists: (path: string) => boolean,
): PackageScriptsInfo {
  const empty: PackageScriptsInfo = { packageScripts: {}, hasBuildScript: false };
  const pkgPath = join(projectPath, 'package.json');
  if (!pathExists(pkgPath)) {
    return empty;
  }
  let raw: string;
  try {
    raw = readTextFile(pkgPath);
  } catch (err) {
    logger.warn({ projectPath, err: (err as Error).message }, 'package.json ilegivel; build-detection desligada');
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ projectPath, err: (err as Error).message }, 'package.json malformado; build-detection desligada');
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return empty;
  }
  const scriptsValue = (parsed as { scripts?: unknown }).scripts;
  if (typeof scriptsValue !== 'object' || scriptsValue === null) {
    return empty;
  }
  const packageScripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(scriptsValue as Record<string, unknown>)) {
    if (typeof value === 'string') {
      packageScripts[name] = value;
    }
  }
  return {
    packageScripts,
    hasBuildScript: typeof packageScripts.build === 'string',
  };
}

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultGenerateId(specSha256: string): string {
  return `dwfb_${sha256Hex(`${specSha256}:${Date.now()}`).slice(0, 24)}`;
}

function resolveSpecText(input: BuildContextBundleInput, readTextFile: (path: string) => string): string {
  if (typeof input.specText === 'string' && input.specText.length > 0) {
    return input.specText;
  }
  if (typeof input.specPath === 'string' && input.specPath.length > 0) {
    try {
      return readTextFile(input.specPath);
    } catch (err) {
      throw new ContextBundleSpecError(`falha ao ler specPath ${input.specPath}: ${(err as Error).message}`);
    }
  }
  throw new ContextBundleSpecError('nem specText nem specPath fornecidos');
}

function resolveWithinRunDir(runDir: string, fileName: string): string {
  const canonicalRoot = existsSync(runDir) ? realpathSync(runDir) : resolve(runDir);
  const absoluteTarget = resolve(canonicalRoot, fileName);
  const canonicalTarget = existsSync(absoluteTarget) ? realpathSync(absoluteTarget) : absoluteTarget;
  const rel = relative(canonicalRoot, canonicalTarget);
  const within = canonicalTarget === canonicalRoot || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel));
  if (!within) {
    throw new Error(`context bundle fora do run dir (runDir=${canonicalRoot}, alvo=${fileName})`);
  }
  return canonicalTarget;
}

export function buildContextBundle(input: BuildContextBundleInput, deps: ContextBundleDeps): BuildContextBundleResult {
  if (!isAbsolute(input.projectPath)) {
    throw new Error(`projectPath deve ser absoluto: ${input.projectPath}`);
  }

  const readTextFile = deps.readTextFile ?? defaultReadTextFile;
  const pathExists = deps.pathExists ?? ((p: string) => existsSync(p));
  const now = deps.now ?? defaultNow;
  const generateId = deps.generateId ?? defaultGenerateId;

  const specSource = resolveSpecText(input, readTextFile);
  const specSha256 = sha256Hex(specSource);

  const { packageScripts, hasBuildScript } = readPackageScripts(input.projectPath, readTextFile, pathExists);

  const git: ContextBundleGitInfo = deps.probeGit
    ? deps.probeGit(input.projectPath)
    : { gitRoot: null, commitSha: null, worktreeHash: null };

  const repoGraph: ContextBundleRepoGraphInfo = deps.loadRepoGraph
    ? deps.loadRepoGraph(input.projectPath)
    : { repoGraphRunId: null, repoGraphPath: null, repoScanId: null };

  const agentCatalogSnapshot = deps.loadAgentCatalog();

  const bundle: DynamicWorkflowContextBundle = {
    id: generateId(specSha256),
    projectPath: input.projectPath,
    gitRoot: git.gitRoot,
    commitSha: git.commitSha,
    worktreeHash: git.worktreeHash,
    specPath: input.specPath ?? null,
    specSha256,
    repoGraphRunId: repoGraph.repoGraphRunId,
    repoGraphPath: repoGraph.repoGraphPath,
    repoScanId: repoGraph.repoScanId,
    relevantFiles: input.relevantFiles ?? [],
    protectedPaths: input.protectedPaths ?? [],
    baselineCommands: input.baselineCommands ?? [],
    baselineResults: input.baselineResults ?? [],
    knownGates: input.knownGates ?? [],
    agentCatalogSnapshot,
    createdBy: input.createdBy,
    packageScripts,
    hasBuildScript,
    createdAt: now(),
  };

  const bundlePath = resolveWithinRunDir(input.runDir, CONTEXT_BUNDLE_FILE);
  const parentDir = bundlePath.slice(0, bundlePath.lastIndexOf(sep)) || sep;
  mkdirSync(parentDir, { recursive: true });
  const serialized = JSON.stringify(bundle, null, 2);
  writeFileSync(bundlePath, serialized, 'utf8');

  logger.info(
    {
      projectPath: input.projectPath,
      bundlePath,
      specSha256,
      agents: agentCatalogSnapshot.length,
    },
    'context bundle montado e persistido',
  );

  return { bundle, bundlePath, sha256: sha256Hex(serialized) };
}

export interface BundleFreshnessReport {
  fresh: boolean;
  reasons: BundleFreshnessReason[];
}

export type BundleFreshnessReason =
  'project-missing' | 'spec-changed' | 'commit-changed' | 'relevant-file-missing' | 'agent-missing';

export interface BundleFreshnessInput {
  bundle: DynamicWorkflowContextBundle;
  currentSpecText?: string | null;
  currentSpecPath?: string | null;
}

export function checkBundleFreshness(input: BundleFreshnessInput, deps: ContextBundleDeps): BundleFreshnessReport {
  const readTextFile = deps.readTextFile ?? defaultReadTextFile;
  const pathExists = deps.pathExists ?? ((p: string) => existsSync(p));
  const reasons: BundleFreshnessReason[] = [];
  const { bundle } = input;

  if (!pathExists(bundle.projectPath)) {
    reasons.push('project-missing');
  }

  let currentSpec: string | null = null;
  if (typeof input.currentSpecText === 'string') {
    currentSpec = input.currentSpecText;
  } else if (
    typeof input.currentSpecPath === 'string' &&
    input.currentSpecPath.length > 0 &&
    pathExists(input.currentSpecPath)
  ) {
    try {
      currentSpec = readTextFile(input.currentSpecPath);
    } catch {
      currentSpec = null;
    }
  }
  if (currentSpec !== null && sha256Hex(currentSpec) !== bundle.specSha256) {
    reasons.push('spec-changed');
  }

  if (bundle.commitSha && deps.probeGit) {
    const git = deps.probeGit(bundle.projectPath);
    if (git.commitSha && git.commitSha !== bundle.commitSha) {
      reasons.push('commit-changed');
    }
  }

  for (const f of bundle.relevantFiles) {
    const abs = isAbsolute(f.path) ? f.path : join(bundle.projectPath, f.path);
    if (!pathExists(abs)) {
      reasons.push('relevant-file-missing');
      break;
    }
  }

  if (bundle.agentCatalogSnapshot.length > 0) {
    const current = new Set(deps.loadAgentCatalog().map((a) => a.id));
    const missing = bundle.agentCatalogSnapshot.some((a) => !current.has(a.id));
    if (missing) {
      reasons.push('agent-missing');
    }
  }

  return { fresh: reasons.length === 0, reasons };
}
