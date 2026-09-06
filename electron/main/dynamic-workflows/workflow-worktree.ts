
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '../logger';
import type { DynamicWorkflowWorkspaceMode } from '../../../src/types/dynamic-workflow';
import {
  runGit,
  revParseHead,
  branchTipSha,
  type GitRunner,
  type GitBackoffOptions,
  WorkflowGitError,
  WORKFLOW_RUN_LOCK_FILE,
  shortRunId,
  sprintBranchName,
  setLongpaths,
  runGitWithBackoff,
} from './workflow-git';

const logger = createLogger('dynamic-workflow-worktree');

const BASELINE_AUTHOR_NAME = 'LionClaw Workflow';
const BASELINE_AUTHOR_EMAIL = 'workflow@lionclaw.local';

export type ProjectGitState =
  | 'git-with-commits' // repo existente com pelo menos 1 commit
  | 'git-unborn' // repo git inicializado mas HEAD unborn (zero commits)
  | 'empty' // pasta vazia (ou inexistente)
  | 'code-no-git'; // pasta com arquivos mas sem repositorio git

export interface ProjectStateProbe {
  state: ProjectGitState;
  mode: DynamicWorkflowWorkspaceMode;
  baseBranch: string | null;
  needsInit: boolean;
  needsBaselineCommit: boolean;
}

export async function probeProjectState(
  projectPath: string,
  git: GitRunner = runGit,
): Promise<ProjectStateProbe> {
  if (!isAbsolute(projectPath)) {
    throw new WorkflowGitError(`projectPath deve ser absoluto: ${projectPath}`);
  }

  const exists = existsSync(projectPath);
  const isEmpty = !exists || isDirEmpty(projectPath);

  const insideRepo = exists ? await isGitRepo(projectPath, git) : false;

  if (insideRepo) {
    const hasCommit = await hasAnyCommit(projectPath, git);
    if (hasCommit) {
      const baseBranch = await currentBranch(projectPath, git);
      return {
        state: 'git-with-commits',
        mode: 'run-worktree',
        baseBranch,
        needsInit: false,
        needsBaselineCommit: false,
      };
    }
    return {
      state: 'git-unborn',
      mode: 'fresh-project',
      baseBranch: null,
      needsInit: false,
      needsBaselineCommit: false,
    };
  }

  if (isEmpty) {
    return {
      state: 'empty',
      mode: 'fresh-project',
      baseBranch: null,
      needsInit: true,
      needsBaselineCommit: false,
    };
  }

  return {
    state: 'code-no-git',
    mode: 'run-worktree',
    baseBranch: null,
    needsInit: true,
    needsBaselineCommit: true,
  };
}

export interface PrepareWorkspaceInput {
  runId: string;
  projectPath: string;
  probe?: ProjectStateProbe;
  worktreeRoot?: string;
}

export interface WorkspaceHandle {
  runId: string;
  mode: DynamicWorkflowWorkspaceMode;
  repoRoot: string;
  baseBranch: string;
  baseCommitSha: string;
  baseWorktreeHash: string;
  workspaceDir: string;
  worktreePath: string | null;
  worktreeBranch: string | null;
}

export function runBranchName(runId: string): string {
  return `dynworkflow/${runId}`;
}

export function defaultWorktreeRoot(projectPath: string, runId: string): string {
  return join(projectPath, '.lionclaw', 'workflows', runId, 'worktree');
}

export async function prepareWorkspace(
  input: PrepareWorkspaceInput,
  git: GitRunner = runGit,
): Promise<WorkspaceHandle> {
  const probe = input.probe ?? (await probeProjectState(input.projectPath, git));
  const repoRoot = input.projectPath;

  if (probe.needsInit) {
    if (!existsSync(repoRoot)) {
      mkdirSync(repoRoot, { recursive: true });
    }
    const init = await git(['init'], repoRoot);
    if (init.code !== 0) {
      throw new WorkflowGitError('falha em git init', init.stderr);
    }
  }

  if (probe.needsBaselineCommit) {
    await commitBaseline(repoRoot, input.runId, git);
  }

  if (probe.mode === 'fresh-project') {
    let baseCommitSha: string;
    if (!(await hasAnyCommit(repoRoot, git))) {
      await commitEmptyRoot(repoRoot, input.runId, git);
    }
    baseCommitSha = await revParseHead(repoRoot, git);
    const baseBranch = (await currentBranch(repoRoot, git)) ?? 'main';
    const baseWorktreeHash = await treeHash(repoRoot, baseCommitSha, git);
    return {
      runId: input.runId,
      mode: 'fresh-project',
      repoRoot,
      baseBranch,
      baseCommitSha,
      baseWorktreeHash,
      workspaceDir: repoRoot, // desenvolve direto na branch principal
      worktreePath: null,
      worktreeBranch: null,
    };
  }

  const baseBranch = probe.baseBranch ?? (await currentBranch(repoRoot, git)) ?? 'main';
  const baseCommitSha = await revParseHead(repoRoot, git);
  const baseWorktreeHash = await treeHash(repoRoot, baseCommitSha, git);
  const worktreePath = input.worktreeRoot ?? defaultWorktreeRoot(input.projectPath, input.runId);
  const branch = runBranchName(input.runId);

  await ensureWorktree(repoRoot, worktreePath, branch, baseCommitSha, git);
  writeRunLock(worktreePath, input.runId);
  await ensureRunLockExcluded(worktreePath, git);
  linkNodeModulesBestEffort(repoRoot, worktreePath);

  return {
    runId: input.runId,
    mode: 'run-worktree',
    repoRoot,
    baseBranch,
    baseCommitSha,
    baseWorktreeHash,
    workspaceDir: worktreePath,
    worktreePath,
    worktreeBranch: branch,
  };
}

export function linkNodeModulesBestEffort(repoRoot: string, worktreePath: string): void {
  try {
    const source = join(repoRoot, 'node_modules');
    const target = join(worktreePath, 'node_modules');
    if (!existsSync(source) || existsSync(target)) return;
    symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    logger.warn({ err, repoRoot, worktreePath }, 'link de node_modules na worktree falhou (segue sem)');
  }
}

export async function recreateWorktree(
  params: { repoRoot: string; worktreePath: string; runId: string; baseCommitSha: string },
  git: GitRunner = runGit,
): Promise<void> {
  const branch = runBranchName(params.runId);
  await git(['worktree', 'prune'], params.repoRoot);
  await ensureWorktree(params.repoRoot, params.worktreePath, branch, params.baseCommitSha, git);
  writeRunLock(params.worktreePath, params.runId);
  await ensureRunLockExcluded(params.worktreePath, git);
}

export interface CleanupInput {
  repoRoot: string;
  worktreePath: string;
  runId: string;
  keepBranch?: boolean;
}

export async function cleanupWorktree(input: CleanupInput, git: GitRunner = runGit): Promise<void> {
  clearRunLock(input.worktreePath);
  await git(['worktree', 'remove', '--force', input.worktreePath], input.repoRoot);
  await git(['worktree', 'prune'], input.repoRoot);
  if (existsSync(input.worktreePath)) {
    rmSync(input.worktreePath, { recursive: true, force: true });
  }
  if (!input.keepBranch) {
    const branch = runBranchName(input.runId);
    const del = await git(['branch', '-D', branch], input.repoRoot);
    if (del.code !== 0) {
      logger.debug({ runId: input.runId, branch, stderr: del.stderr }, 'branch do run ja ausente no cleanup');
    }
  }
}


export const SPRINT_WORKTREE_ROOT_MAX_LEN = 150;

export function defaultSprintWorktreePath(
  projectPath: string,
  runId: string,
  sprintIndex: number,
): string {
  return join(projectPath, '.lionclaw', 'wf', shortRunId(runId), `s${Math.max(0, Math.floor(sprintIndex))}`);
}

export function tempSprintWorktreePath(runId: string, sprintIndex: number): string {
  return join(tmpdir(), 'lcwf', shortRunId(runId), `s${Math.max(0, Math.floor(sprintIndex))}`);
}

export function chooseSprintWorktreePath(
  projectPath: string,
  runId: string,
  sprintIndex: number,
  maxLen = SPRINT_WORKTREE_ROOT_MAX_LEN,
): { path: string; fellBackToTemp: boolean } {
  const preferred = defaultSprintWorktreePath(projectPath, runId, sprintIndex);
  if (preferred.length <= maxLen) {
    return { path: preferred, fellBackToTemp: false };
  }
  return { path: tempSprintWorktreePath(runId, sprintIndex), fellBackToTemp: true };
}

export interface PrepareSprintWorktreeInput {
  runId: string;
  repoRoot: string;
  projectPath: string;
  sprintIndex: number;
  baseCommitSha: string;
  worktreeRootOverride?: string;
  backoff?: GitBackoffOptions;
}

export interface SprintWorktreeHandle {
  runId: string;
  sprintIndex: number;
  worktreePath: string;
  branch: string;
  baseSha: string;
  fellBackToTemp: boolean;
}

export async function prepareSprintWorktree(
  input: PrepareSprintWorktreeInput,
  git: GitRunner = runGit,
): Promise<SprintWorktreeHandle> {
  if (!isAbsolute(input.repoRoot)) {
    throw new WorkflowGitError(`repoRoot deve ser absoluto: ${input.repoRoot}`);
  }
  const chosen = input.worktreeRootOverride
    ? { path: input.worktreeRootOverride, fellBackToTemp: false }
    : chooseSprintWorktreePath(input.projectPath, input.runId, input.sprintIndex);
  const branch = sprintBranchName(input.runId, input.sprintIndex);

  await setLongpaths(input.repoRoot, git);

  await ensureSprintWorktree(
    input.repoRoot,
    chosen.path,
    branch,
    input.baseCommitSha,
    git,
    input.backoff,
  );
  writeRunLock(chosen.path, input.runId);
  await ensureRunLockExcluded(chosen.path, git);
  linkNodeModulesBestEffort(input.repoRoot, chosen.path);

  return {
    runId: input.runId,
    sprintIndex: input.sprintIndex,
    worktreePath: chosen.path,
    branch,
    baseSha: input.baseCommitSha,
    fellBackToTemp: chosen.fellBackToTemp,
  };
}

export async function cleanupSprintWorktree(
  input: { repoRoot: string; worktreePath: string; runId: string; sprintIndex: number; keepBranch?: boolean },
  git: GitRunner = runGit,
): Promise<void> {
  clearRunLock(input.worktreePath);
  await git(['worktree', 'remove', '--force', input.worktreePath], input.repoRoot);
  await git(['worktree', 'prune'], input.repoRoot);
  if (existsSync(input.worktreePath)) {
    rmSync(input.worktreePath, { recursive: true, force: true });
  }
  if (!input.keepBranch) {
    const branch = sprintBranchName(input.runId, input.sprintIndex);
    const del = await git(['branch', '-D', branch], input.repoRoot);
    if (del.code !== 0) {
      logger.debug(
        { runId: input.runId, branch, stderr: del.stderr },
        'branch da sprint ja ausente no cleanup',
      );
    }
  }
}

async function ensureSprintWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  baseCommitSha: string,
  git: GitRunner,
  backoff?: GitBackoffOptions,
): Promise<void> {
  if (existsSync(join(worktreePath, '.git'))) {
    return;
  }
  const parent = join(worktreePath, '..');
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const branchExists = (await branchTipSha(repoRoot, branch, git)) !== null;
  const args = branchExists
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, baseCommitSha];
  const res = await runGitWithBackoff(args, repoRoot, git, backoff);
  if (res.code !== 0) {
    throw new WorkflowGitError(`falha em git worktree add da sprint (${branch})`, res.stderr);
  }
}


const RUN_LOCK_FILE = WORKFLOW_RUN_LOCK_FILE;

export async function ensureRunLockExcluded(worktreePath: string, git: GitRunner = runGit): Promise<void> {
  try {
    const res = await git(['rev-parse', '--git-path', 'info/exclude'], worktreePath);
    const reported = res.stdout.trim();
    if (res.code !== 0 || reported.length === 0) {
      logger.warn(
        { worktreePath, stderr: res.stderr },
        'rev-parse --git-path info/exclude falhou (lock pode aparecer como untracked)',
      );
      return;
    }
    const excludeFile = isAbsolute(reported) ? reported : join(worktreePath, reported);
    const line = `/${RUN_LOCK_FILE}`;
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
    if (current.split(/\r?\n/).includes(line)) return;
    mkdirSync(dirname(excludeFile), { recursive: true });
    writeFileSync(
      excludeFile,
      `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${line}\n`,
      'utf8',
    );
  } catch (err) {
    logger.warn({ err, worktreePath }, 'exclude do run-lock falhou (lock pode aparecer como untracked)');
  }
}

export interface RunLockInfo {
  runId: string;
  pid: number;
  startedAt: string;
}

export function writeRunLock(worktreePath: string, runId: string): void {
  if (!existsSync(worktreePath)) {
    return;
  }
  const info: RunLockInfo = { runId, pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(join(worktreePath, RUN_LOCK_FILE), JSON.stringify(info), 'utf8');
}

export function readRunLock(worktreePath: string): RunLockInfo | null {
  const file = join(worktreePath, RUN_LOCK_FILE);
  if (!existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RunLockInfo;
  } catch {
    return null;
  }
}

export function clearRunLock(worktreePath: string): void {
  const file = join(worktreePath, RUN_LOCK_FILE);
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {
    }
  }
}

export function isCrashMarkerStale(worktreePath: string): boolean {
  const lock = readRunLock(worktreePath);
  if (!lock) {
    return false;
  }
  return lock.pid !== process.pid;
}


function isDirEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).filter((n) => n !== '.git').length === 0;
  } catch {
    return true;
  }
}

async function isGitRepo(dir: string, git: GitRunner): Promise<boolean> {
  const res = await git(['rev-parse', '--is-inside-work-tree'], dir);
  return res.code === 0 && res.stdout.trim() === 'true';
}

async function hasAnyCommit(dir: string, git: GitRunner): Promise<boolean> {
  const res = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], dir);
  return res.code === 0 && res.stdout.trim().length > 0;
}

async function currentBranch(dir: string, git: GitRunner): Promise<string | null> {
  const res = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  if (res.code !== 0) {
    return null;
  }
  const name = res.stdout.trim();
  return name.length > 0 && name !== 'HEAD' ? name : null;
}

async function treeHash(dir: string, commitSha: string, git: GitRunner): Promise<string> {
  const res = await git(['rev-parse', `${commitSha}^{tree}`], dir);
  if (res.code !== 0) {
    throw new WorkflowGitError('falha ao obter tree hash do commit base', res.stderr);
  }
  return res.stdout.trim();
}

function baselineEnvArgs(): string[] {
  return ['-c', `user.name=${BASELINE_AUTHOR_NAME}`, '-c', `user.email=${BASELINE_AUTHOR_EMAIL}`];
}

async function commitBaseline(dir: string, runId: string, git: GitRunner): Promise<void> {
  const add = await git(['add', '-A'], dir);
  if (add.code !== 0) {
    throw new WorkflowGitError('falha em git add -A do baseline', add.stderr);
  }
  const commit = await git(
    [...baselineEnvArgs(), 'commit', '-m', `wf-baseline(${runId}): snapshot inicial do projeto`],
    dir,
  );
  if (commit.code !== 0) {
    await commitEmptyRoot(dir, runId, git);
  }
}

async function commitEmptyRoot(dir: string, runId: string, git: GitRunner): Promise<void> {
  const commit = await git(
    [...baselineEnvArgs(), 'commit', '--allow-empty', '-m', `wf-baseline(${runId}): repositorio inicial`],
    dir,
  );
  if (commit.code !== 0) {
    throw new WorkflowGitError('falha no commit raiz do fresh-project', commit.stderr);
  }
}

async function ensureWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  baseCommitSha: string,
  git: GitRunner,
): Promise<void> {
  if (existsSync(join(worktreePath, '.git'))) {
    return;
  }
  const parent = join(worktreePath, '..');
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const branchExists = (await branchTipSha(repoRoot, branch, git)) !== null;
  const args = branchExists
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, baseCommitSha];
  const res = await git(args, repoRoot);
  if (res.code !== 0) {
    throw new WorkflowGitError(`falha em git worktree add (${branch})`, res.stderr);
  }
}
