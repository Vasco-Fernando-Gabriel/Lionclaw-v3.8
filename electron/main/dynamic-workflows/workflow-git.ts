import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../logger';
import { nonInteractiveGitEnv } from './workflow-git-env';

const logger = createLogger('dynamic-workflow-git');
const execFileAsync = promisify(execFile);

export const WORKFLOW_GIT_AUTHOR_NAME = 'LionClaw Workflow';
export const WORKFLOW_GIT_AUTHOR_EMAIL = 'workflow@lionclaw.local';

export const WORKFLOW_RUN_LOCK_FILE = '.lionclaw-workflow-run.lock';

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitRunResult>;

export const runGit: GitRunner = async (args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: nonInteractiveGitEnv(),
    });
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    };
  }
};

export class WorkflowGitError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'WorkflowGitError';
  }
}

function authorEnvArgs(): string[] {
  return ['-c', `user.name=${WORKFLOW_GIT_AUTHOR_NAME}`, '-c', `user.email=${WORKFLOW_GIT_AUTHOR_EMAIL}`];
}

export function nodeCommitMessage(runId: string, nodeId: string, attempt: number): string {
  return `wf(${runId}): ${nodeId} attempt ${attempt}`;
}

export function wipCommitMessage(runId: string, nodeId: string, attempt: number): string {
  return `wf-wip(${runId}): ${nodeId} attempt ${attempt} interrupted`;
}

export function failedWipCommitMessage(nodeId: string, attempt: number): string {
  return `wip(failed): ${nodeId} attempt ${attempt}`;
}

export function squashCommitMessage(name: string, deliverySummary: string, runId: string): string {
  return `wf(${name}): ${deliverySummary} (run ${runId})`;
}

export interface NodeCommitInput {
  runId: string;
  nodeId: string;
  attempt: number;
  cwd: string;
  transientPaths?: string[];
}

export interface CommitResult {
  sha: string | null;
  empty: boolean;
}

export async function commitNode(input: NodeCommitInput, git: GitRunner = runGit): Promise<CommitResult> {
  return commitAll(input.cwd, nodeCommitMessage(input.runId, input.nodeId, input.attempt), git, input.transientPaths);
}

export async function commitWip(input: NodeCommitInput, git: GitRunner = runGit): Promise<CommitResult> {
  return commitAll(input.cwd, wipCommitMessage(input.runId, input.nodeId, input.attempt), git, input.transientPaths);
}

export async function commitFailedWip(input: NodeCommitInput, git: GitRunner = runGit): Promise<CommitResult> {
  return commitAll(input.cwd, failedWipCommitMessage(input.nodeId, input.attempt), git, input.transientPaths);
}

function normalizeTransientPaths(transientPaths: string[] | undefined): string[] {
  if (!transientPaths || transientPaths.length === 0) return [];
  const out = new Set<string>();
  for (const raw of transientPaths) {
    if (/^([a-zA-Z]:|[\\/])/.test(raw)) {
      logger.warn({ path: raw }, 'transitorio ABSOLUTO rejeitado (so paths relativos ao repo)');
      continue;
    }
    const p = normalizeRel(raw);
    if (p.length === 0) continue;
    if (p.split('/').includes('..')) {
      logger.warn({ path: raw }, 'transitorio com segmento ".." rejeitado (escaparia do repo)');
      continue;
    }
    out.add(p);
  }
  return [...out];
}

async function unstageTransients(cwd: string, transientPaths: string[] | undefined, git: GitRunner): Promise<void> {
  const paths = normalizeTransientPaths(transientPaths);
  if (paths.length === 0) return;
  const res = await git(['reset', '-q', 'HEAD', '--', ...paths], cwd);
  if (res.code !== 0) {
    logger.warn(
      { cwd, transientPaths: paths, stderr: res.stderr },
      'falha ao tirar transitorios do staging (podem vazar no commit do node; o squash ainda filtra a entrega)',
    );
  }
}

async function commitAll(
  cwd: string,
  message: string,
  git: GitRunner,
  transientPaths?: string[],
): Promise<CommitResult> {
  let add = await git(['add', '-A'], cwd);
  if (add.code !== 0) {
    add = await git(['add', '-A'], cwd);
  }
  if (add.code !== 0) {
    throw new WorkflowGitError(`falha em git add -A: ${add.stderr}`, add.stderr);
  }
  await unstageTransients(cwd, transientPaths, git);
  const staged = await git(['diff', '--cached', '--name-only'], cwd);
  if (staged.code !== 0) {
    throw new WorkflowGitError('falha em git diff --cached', staged.stderr);
  }
  if (staged.stdout.trim().length === 0) {
    return { sha: null, empty: true };
  }
  const commit = await git([...authorEnvArgs(), 'commit', '-m', message], cwd);
  if (commit.code !== 0) {
    throw new WorkflowGitError('falha em git commit', commit.stderr);
  }
  const head = await revParseHead(cwd, git);
  return { sha: head, empty: false };
}

export async function revParseHead(cwd: string, git: GitRunner = runGit): Promise<string> {
  const res = await git(['rev-parse', 'HEAD'], cwd);
  if (res.code !== 0) {
    throw new WorkflowGitError('falha em git rev-parse HEAD', res.stderr);
  }
  return res.stdout.trim();
}

export interface TouchedFilesReport {
  runId: string;
  nodeId: string;
  attempt: number;
  fromSha: string | null;
  toSha: string;
  files: string[];
  outsideWriteSet: string[];
}

export async function computeTouchedFiles(
  cwd: string,
  fromSha: string | null,
  toSha: string,
  git: GitRunner = runGit,
): Promise<string[]> {
  const range = fromSha ? `${fromSha}..${toSha}` : toSha;
  const args = fromSha
    ? ['diff', '--name-only', range]
    : ['diff-tree', '-r', '--no-commit-id', '--name-only', '--root', toSha];
  const res = await git(args, cwd);
  if (res.code !== 0) {
    throw new WorkflowGitError('falha ao calcular touched-files', res.stderr);
  }
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

export async function buildTouchedFilesReport(
  params: {
    runId: string;
    nodeId: string;
    attempt: number;
    cwd: string;
    fromSha: string | null;
    toSha: string;
    writeSet: string[];
  },
  git: GitRunner = runGit,
): Promise<TouchedFilesReport> {
  const nonInternal = (await computeTouchedFiles(params.cwd, params.fromSha, params.toSha, git)).filter(
    (f) => !isInternalWorkflowFile(f) && !isBuildArtifact(f),
  );
  const files = await filterGitIgnoredFiles(params.cwd, nonInternal, git);
  const outsideWriteSet = files.filter((f) => !matchWriteSet(f, params.writeSet));
  if (outsideWriteSet.length > 0) {
    logger.warn(
      { runId: params.runId, nodeId: params.nodeId, outsideWriteSet },
      'node tocou arquivos fora do writeSet (8.6/7.4)',
    );
  }
  return {
    runId: params.runId,
    nodeId: params.nodeId,
    attempt: params.attempt,
    fromSha: params.fromSha,
    toSha: params.toSha,
    files,
    outsideWriteSet,
  };
}

const INTERNAL_WORKFLOW_PATH_PREFIXES = ['.lionclaw/', '.lionclaw\\'];
const INTERNAL_WORKFLOW_FILES = new Set([WORKFLOW_RUN_LOCK_FILE, '.verify.mjs', '.tmp-verify.mjs']);
function isInternalWorkflowFile(file: string): boolean {
  const f = file.replace(/^\.\//, '');
  return INTERNAL_WORKFLOW_FILES.has(f) || INTERNAL_WORKFLOW_PATH_PREFIXES.some((prefix) => f.startsWith(prefix));
}

const BUILD_ARTIFACT_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
  '.svelte-kit',
]);
function isBuildArtifact(file: string): boolean {
  const f = file.replace(/^\.\//, '');
  if (f.endsWith('.tsbuildinfo')) return true;
  const dirSegments = f.split('/').slice(0, -1);
  return dirSegments.some((seg) => BUILD_ARTIFACT_DIR_SEGMENTS.has(seg));
}

async function filterGitIgnoredFiles(cwd: string, files: string[], git: GitRunner): Promise<string[]> {
  if (files.length === 0) return files;
  try {
    const res = await git(['check-ignore', '--no-index', '--', ...files], cwd);
    if (res.code !== 0 && res.code !== 1) return files;
    if (res.code === 1) return files;
    const ignored = new Set(
      res.stdout
        .split('\n')
        .map((l) => l.trim().replace(/^\.\//, ''))
        .filter((l) => l.length > 0),
    );
    if (ignored.size === 0) return files;
    return files.filter((f) => !ignored.has(f.replace(/^\.\//, '')));
  } catch {
    return files;
  }
}

export function matchWriteSet(path: string, writeSet: string[]): boolean {
  const normalized = normalizeRel(path);
  for (const pattern of writeSet) {
    if (globMatch(normalizeRel(pattern), normalized)) {
      return true;
    }
  }
  return false;
}

function normalizeRel(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\//, '');
}

function globMatch(pattern: string, value: string): boolean {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re).test(value);
}

export async function resetToCommit(cwd: string, sha: string, git: GitRunner = runGit): Promise<void> {
  const res = await git(['reset', '--hard', sha], cwd);
  if (res.code !== 0) {
    throw new WorkflowGitError(`falha em git reset --hard ${sha}`, res.stderr);
  }
}

export type MergeOutcome =
  | {
      kind: 'squashed';
      mergeSha: string;
      baseAdvanced: false;
      empty?: true;
    }
  | { kind: 'staged'; stagingSha: string; baseAdvanced: true; recheckRequired: true }
  | { kind: 'conflict'; baseAdvanced: boolean; conflicted: true; conflictPaths: string[] };

export interface SquashMergeInput {
  cwd: string;
  baseBranch: string;
  runBranch: string;
  baseCommitSha: string;
  name: string;
  deliverySummary: string;
  runId: string;
  stagingBranch?: string;
  transientPaths?: string[];
}

export async function squashMergePostGate(input: SquashMergeInput, git: GitRunner = runGit): Promise<MergeOutcome> {
  const currentBase = await branchTipSha(input.cwd, input.baseBranch, git);
  const baseAdvanced = currentBase !== null && currentBase !== input.baseCommitSha;

  const ahead = await git(['rev-list', '--count', `${input.baseBranch}..${input.runBranch}`], input.cwd);
  if (ahead.code === 0 && ahead.stdout.trim() === '0') {
    return {
      kind: 'squashed',
      mergeSha: currentBase ?? input.baseCommitSha,
      baseAdvanced: false,
      empty: true,
    };
  }

  if (!baseAdvanced) {
    await checkout(input.cwd, input.baseBranch, git);
    const squash = await git(['merge', '--squash', input.runBranch], input.cwd);
    if (squash.code !== 0) {
      const conflictPaths = await unmergedPaths(input.cwd, git);
      await abortMergeAttempt(input.cwd, git);
      return { kind: 'conflict', baseAdvanced: false, conflicted: true, conflictPaths };
    }
    await dropTransientsFromDelivery(input.cwd, input.transientPaths, git);
    const stagedDiff = await git(['diff', '--cached', '--quiet'], input.cwd);
    if (stagedDiff.code === 0) {
      const headSha = await revParseHead(input.cwd, git);
      return { kind: 'squashed', mergeSha: headSha, baseAdvanced: false, empty: true };
    }
    const commit = await git(
      [...authorEnvArgs(), 'commit', '-m', squashCommitMessage(input.name, input.deliverySummary, input.runId)],
      input.cwd,
    );
    if (commit.code !== 0) {
      throw new WorkflowGitError('falha no commit do squash merge', commit.stderr);
    }
    const mergeSha = await revParseHead(input.cwd, git);
    return { kind: 'squashed', mergeSha, baseAdvanced: false };
  }

  const stagingBranch = input.stagingBranch ?? `dynworkflow-staging/${input.runId}`;
  await git(['branch', '-f', stagingBranch, input.baseBranch], input.cwd);
  await checkout(input.cwd, stagingBranch, git);
  const squashIntoStaging = await git(['merge', '--squash', input.runBranch], input.cwd);
  if (squashIntoStaging.code !== 0) {
    const conflictPaths = await unmergedPaths(input.cwd, git);
    await abortMergeAttempt(input.cwd, git);
    await checkout(input.cwd, input.baseBranch, git);
    return { kind: 'conflict', baseAdvanced: true, conflicted: true, conflictPaths };
  }
  await dropTransientsFromDelivery(input.cwd, input.transientPaths, git);
  const stagedIntoStagingDiff = await git(['diff', '--cached', '--quiet'], input.cwd);
  if (stagedIntoStagingDiff.code === 0) {
    await checkout(input.cwd, input.baseBranch, git);
    await git(['branch', '-D', stagingBranch], input.cwd);
    return {
      kind: 'squashed',
      mergeSha: currentBase ?? input.baseCommitSha,
      baseAdvanced: false,
      empty: true,
    };
  }
  const stagingCommit = await git(
    [
      ...authorEnvArgs(),
      'commit',
      '-m',
      `${squashCommitMessage(input.name, input.deliverySummary, input.runId)} [staging]`,
    ],
    input.cwd,
  );
  if (stagingCommit.code !== 0) {
    const tip = await branchTipSha(input.cwd, stagingBranch, git);
    await checkout(input.cwd, input.baseBranch, git);
    return { kind: 'staged', stagingSha: tip ?? currentBase, baseAdvanced: true, recheckRequired: true };
  }
  const stagingSha = await revParseHead(input.cwd, git);
  await checkout(input.cwd, input.baseBranch, git);
  return { kind: 'staged', stagingSha, baseAdvanced: true, recheckRequired: true };
}

async function dropTransientsFromDelivery(
  cwd: string,
  transientPaths: string[] | undefined,
  git: GitRunner,
): Promise<void> {
  const paths = normalizeTransientPaths(transientPaths);
  if (paths.length === 0) return;
  const stagedRes = await git(['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only', '--', ...paths], cwd);
  const stagedByMerge =
    stagedRes.code === 0
      ? new Set(
          stagedRes.stdout
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0),
        )
      : null;
  const reset = await git(['reset', '-q', 'HEAD', '--', ...paths], cwd);
  if (reset.code !== 0) {
    logger.warn(
      { cwd, transientPaths: paths, stderr: reset.stderr },
      'falha ao resetar transitorios no squash (podem vazar na entrega)',
    );
    return;
  }
  if (stagedByMerge === null) {
    logger.warn(
      { cwd, transientPaths: paths, stderr: stagedRes.stderr },
      'nao foi possivel determinar o que o merge introduziu nos transitorios; working tree intocado (podem vazar na entrega)',
    );
    return;
  }
  for (const p of paths) {
    if (!stagedByMerge.has(p)) continue;
    const inBase = await git(['cat-file', '-e', `HEAD:${p}`], cwd);
    if (inBase.code === 0) {
      await git(['checkout', '-q', 'HEAD', '--', p], cwd);
    } else {
      try {
        rmSync(join(cwd, p), { force: true });
      } catch (err) {
        logger.warn({ cwd, path: p, err }, 'falha ao remover transitorio residual do working tree');
      }
    }
  }
}

export async function finalizeStagedMerge(
  params: { cwd: string; baseBranch: string; stagingSha: string },
  git: GitRunner = runGit,
): Promise<{ mergeSha: string }> {
  await checkout(params.cwd, params.baseBranch, git);
  const ff = await git(['merge', '--ff-only', params.stagingSha], params.cwd);
  if (ff.code !== 0) {
    throw new WorkflowGitError('falha no fast-forward da staging para a base', ff.stderr);
  }
  const mergeSha = await revParseHead(params.cwd, git);
  return { mergeSha };
}

export async function branchTipSha(cwd: string, branch: string, git: GitRunner = runGit): Promise<string | null> {
  const res = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
  if (res.code !== 0) {
    return null;
  }
  const sha = res.stdout.trim();
  return sha.length > 0 ? sha : null;
}

export async function checkout(cwd: string, branch: string, git: GitRunner = runGit): Promise<void> {
  const res = await git(['checkout', branch], cwd);
  if (res.code !== 0) {
    throw new WorkflowGitError(`falha em git checkout ${branch}`, res.stderr);
  }
}

async function abortMergeAttempt(cwd: string, git: GitRunner): Promise<void> {
  await git(['merge', '--abort'], cwd);
  await git(['reset', '--hard', 'HEAD'], cwd);
}

export async function unmergedPaths(cwd: string, git: GitRunner = runGit): Promise<string[]> {
  const res = await git(['diff', '--name-only', '--diff-filter=U'], cwd);
  if (res.code !== 0) {
    return [];
  }
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .sort();
}

export function sanitizeBranchSegment(segment: string): string {
  return segment
    .replace(/[^A-Za-z0-9._/-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
}

export function sprintBranchName(runId: string, sprintIndex: number): string {
  const safeRun = sanitizeBranchSegment(runId);
  return `dynworkflow/${safeRun}-s${Math.max(0, Math.floor(sprintIndex))}`;
}

export function shortRunId(runId: string, len = 7): string {
  const n = Math.min(8, Math.max(6, Math.floor(len)));
  return createHash('sha1').update(runId).digest('hex').slice(0, n);
}

export async function setLongpaths(repoRoot: string, git: GitRunner = runGit): Promise<void> {
  const res = await git(['config', 'core.longpaths', 'true'], repoRoot);
  if (res.code !== 0) {
    logger.debug({ repoRoot, stderr: res.stderr }, 'falha ao setar core.longpaths (ignorado)');
  }
}

export function isGitLockError(res: GitRunResult): boolean {
  if (res.code === 0) return false;
  const text = `${res.stderr}\n${res.stdout}`.toLowerCase();
  return (
    text.includes('index.lock') ||
    (text.includes('unable to create') && text.includes('.lock')) ||
    text.includes('cannot lock ref') ||
    text.includes('could not lock') ||
    text.includes('another git process') ||
    text.includes('packed-refs.lock')
  );
}

export interface GitBackoffOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runGitWithBackoff(
  args: string[],
  cwd: string,
  git: GitRunner = runGit,
  options: GitBackoffOptions = {},
): Promise<GitRunResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 50);
  const sleep = options.sleep ?? realSleep;
  let last: GitRunResult = { code: 1, stdout: '', stderr: 'git nao executado' };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await git(args, cwd);
    if (last.code === 0 || !isGitLockError(last)) return last;
    if (attempt < maxAttempts) {
      logger.debug({ cwd, args, attempt, stderr: last.stderr }, 'git lock; backoff e retry');
      await sleep(baseDelayMs * attempt);
    }
  }
  return last;
}
