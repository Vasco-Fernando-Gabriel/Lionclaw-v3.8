import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeProjectState,
  prepareWorkspace,
  recreateWorktree,
  cleanupWorktree,
  runBranchName,
  defaultWorktreeRoot,
  writeRunLock,
  readRunLock,
  clearRunLock,
  isCrashMarkerStale,
  ensureRunLockExcluded,
} from '../dynamic-workflows/workflow-worktree';
import { runGit, branchTipSha, WORKFLOW_RUN_LOCK_FILE } from '../dynamic-workflows/workflow-git';
import { readFileSync } from 'node:fs';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function initRepoWithCommit(dir: string): void {
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# project', 'utf8');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'initial');
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dwf-wt-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('probeProjectState (8.6 tabela: 3 estados)', () => {
  it('git com commits -> run-worktree', async () => {
    const repo = join(root, 'existing');
    mkdirSync(repo, { recursive: true });
    initRepoWithCommit(repo);

    const probe = await probeProjectState(repo, runGit);
    expect(probe.state).toBe('git-with-commits');
    expect(probe.mode).toBe('run-worktree');
    expect(probe.baseBranch).toBe('main');
    expect(probe.needsInit).toBe(false);
    expect(probe.needsBaselineCommit).toBe(false);
  });

  it('pasta vazia -> fresh-project, needsInit', async () => {
    const empty = join(root, 'empty');
    mkdirSync(empty, { recursive: true });

    const probe = await probeProjectState(empty, runGit);
    expect(probe.state).toBe('empty');
    expect(probe.mode).toBe('fresh-project');
    expect(probe.needsInit).toBe(true);
    expect(probe.needsBaselineCommit).toBe(false);
  });

  it('git inicializado mas HEAD unborn -> fresh-project', async () => {
    const unborn = join(root, 'unborn');
    mkdirSync(unborn, { recursive: true });
    git(unborn, 'init', '-b', 'main');

    const probe = await probeProjectState(unborn, runGit);
    expect(probe.state).toBe('git-unborn');
    expect(probe.mode).toBe('fresh-project');
    expect(probe.needsInit).toBe(false);
  });

  it('codigo sem git -> run-worktree, needsInit + baseline', async () => {
    const code = join(root, 'code');
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, 'index.js'), 'console.log(1)', 'utf8');

    const probe = await probeProjectState(code, runGit);
    expect(probe.state).toBe('code-no-git');
    expect(probe.mode).toBe('run-worktree');
    expect(probe.needsInit).toBe(true);
    expect(probe.needsBaselineCommit).toBe(true);
  });

  it('rejeita projectPath relativo', async () => {
    await expect(probeProjectState('relative/path', runGit)).rejects.toThrow(/absoluto/);
  });
});

describe('prepareWorkspace - run-worktree (AC-24)', () => {
  it('cria worktree dynworkflow/<runId>, captura base sha/hash, branch propria', async () => {
    const repo = join(root, 'existing');
    mkdirSync(repo, { recursive: true });
    initRepoWithCommit(repo);
    const baseSha = git(repo, 'rev-parse', 'HEAD');

    const handle = await prepareWorkspace({ runId: 'run1', projectPath: repo }, runGit);

    expect(handle.mode).toBe('run-worktree');
    expect(handle.baseBranch).toBe('main');
    expect(handle.baseCommitSha).toBe(baseSha);
    expect(handle.baseWorktreeHash).toBeTruthy();
    expect(handle.worktreeBranch).toBe('dynworkflow/run1');
    expect(handle.worktreePath).toBe(defaultWorktreeRoot(repo, 'run1'));
    expect(handle.workspaceDir).toBe(handle.worktreePath);
    expect(existsSync(join(handle.worktreePath!, '.git'))).toBe(true);
    expect(await branchTipSha(repo, 'dynworkflow/run1', runGit)).toBe(baseSha);
    expect(readRunLock(handle.worktreePath!)?.runId).toBe('run1');
  });

  it('codigo sem git: faz baseline e roda como run-worktree (AC-27 complemento)', async () => {
    const code = join(root, 'code');
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, 'index.js'), 'console.log(1)', 'utf8');

    const handle = await prepareWorkspace({ runId: 'run2', projectPath: code }, runGit);

    expect(handle.mode).toBe('run-worktree');
    expect(handle.baseCommitSha).toBeTruthy();
    const log = git(code, 'log', '--pretty=%s');
    expect(log).toContain('wf-baseline(run2)');
    expect(existsSync(join(handle.worktreePath!, 'index.js'))).toBe(true);
  });
});

describe('prepareWorkspace - fresh-project (AC-27)', () => {
  it('pasta vazia: git init, branch principal, sem worktree', async () => {
    const empty = join(root, 'empty');
    mkdirSync(empty, { recursive: true });

    const handle = await prepareWorkspace({ runId: 'run3', projectPath: empty }, runGit);

    expect(handle.mode).toBe('fresh-project');
    expect(handle.worktreePath).toBeNull();
    expect(handle.worktreeBranch).toBeNull();
    expect(handle.workspaceDir).toBe(empty);
    expect(handle.baseCommitSha).toBeTruthy();
    expect(existsSync(join(empty, '.git'))).toBe(true);
  });

  it('HEAD unborn (git init sem commit): vira fresh-project com base', async () => {
    const unborn = join(root, 'unborn');
    mkdirSync(unborn, { recursive: true });
    git(unborn, 'init', '-b', 'main');
    git(unborn, 'config', 'user.name', 'Test User');
    git(unborn, 'config', 'user.email', 'test@example.com');

    const handle = await prepareWorkspace({ runId: 'run4', projectPath: unborn }, runGit);
    expect(handle.mode).toBe('fresh-project');
    expect(handle.workspaceDir).toBe(unborn);
    expect(handle.baseCommitSha).toBeTruthy();
  });
});

describe('S4 camada 1: run-lock no info/exclude do COMMON DIR', () => {
  it('prepareWorkspace registra o lock no exclude comum; lock invisivel no git status da worktree', async () => {
    const repo = join(root, 'existing');
    mkdirSync(repo, { recursive: true });
    initRepoWithCommit(repo);

    const handle = await prepareWorkspace({ runId: 'run-ex1', projectPath: repo }, runGit);
    const wt = handle.worktreePath!;

    expect(existsSync(join(wt, WORKFLOW_RUN_LOCK_FILE))).toBe(true);
    expect(git(wt, 'status', '--porcelain')).toBe('');
    const common = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(common.split(/\r?\n/)).toContain(`/${WORKFLOW_RUN_LOCK_FILE}`);
  });

  it('idempotente: preparar de novo nao duplica a linha do exclude', async () => {
    const repo = join(root, 'existing');
    mkdirSync(repo, { recursive: true });
    initRepoWithCommit(repo);

    await prepareWorkspace({ runId: 'run-ex2', projectPath: repo }, runGit);
    await prepareWorkspace({ runId: 'run-ex2', projectPath: repo }, runGit);

    const common = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    const hits = common.split(/\r?\n/).filter((l) => l === `/${WORKFLOW_RUN_LOCK_FILE}`);
    expect(hits).toHaveLength(1);
  });

  it('checkout NORMAL (retorno relativo do rev-parse): resolve contra o cwd e escreve no .git/info/exclude', async () => {
    const repo = join(root, 'plain');
    mkdirSync(repo, { recursive: true });
    initRepoWithCommit(repo);

    await ensureRunLockExcluded(repo, runGit);

    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split(/\r?\n/)).toContain(`/${WORKFLOW_RUN_LOCK_FILE}`);
    writeFileSync(join(repo, WORKFLOW_RUN_LOCK_FILE), '{}', 'utf8');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});

describe('recreateWorktree no resume (8.6 / 10.3.5)', () => {
  it('recria a worktree a partir de baseCommitSha quando ela sumiu', async () => {
    const repo = join(root, 'existing');
    mkdirSync(repo, { recursive: true });
    initRepoWithCommit(repo);
    const baseSha = git(repo, 'rev-parse', 'HEAD');

    const handle = await prepareWorkspace({ runId: 'run5', projectPath: repo }, runGit);
    const wtPath = handle.worktreePath!;
    expect(existsSync(wtPath)).toBe(true);

    rmSync(wtPath, { recursive: true, force: true });
    expect(existsSync(wtPath)).toBe(false);

    await recreateWorktree({ repoRoot: repo, worktreePath: wtPath, runId: 'run5', baseCommitSha: baseSha }, runGit);

    expect(existsSync(join(wtPath, '.git'))).toBe(true);
    expect(await branchTipSha(repo, runBranchName('run5'), runGit)).toBeTruthy();
  });
});

describe('lock de execucao + marcador de crash (8.6)', () => {
  it('writeRunLock/readRunLock round-trip e clear', () => {
    const wt = join(root, 'wt');
    mkdirSync(wt, { recursive: true });
    writeRunLock(wt, 'runX');
    const lock = readRunLock(wt);
    expect(lock?.runId).toBe('runX');
    expect(lock?.pid).toBe(process.pid);
    clearRunLock(wt);
    expect(readRunLock(wt)).toBeNull();
  });

  it('isCrashMarkerStale: false para o processo atual, true para pid alheio', () => {
    const wt = join(root, 'wt');
    mkdirSync(wt, { recursive: true });
    writeRunLock(wt, 'runX');
    expect(isCrashMarkerStale(wt)).toBe(false);
    writeFileSync(
      join(wt, '.lionclaw-workflow-run.lock'),
      JSON.stringify({ runId: 'runX', pid: 999999, startedAt: new Date().toISOString() }),
      'utf8',
    );
    expect(isCrashMarkerStale(wt)).toBe(true);
  });

  it('sem lock -> nao e crash', () => {
    const wt = join(root, 'wt');
    mkdirSync(wt, { recursive: true });
    expect(isCrashMarkerStale(wt)).toBe(false);
  });
});

describe('cleanupWorktree pos-merge (8.6.2 passo 5) e abort (13.8)', () => {
  it('remove worktree e branch por default', async () => {
    const repo = join(root, 'existing');
    mkdirSync(repo, { recursive: true });
    initRepoWithCommit(repo);

    const handle = await prepareWorkspace({ runId: 'run6', projectPath: repo }, runGit);
    expect(await branchTipSha(repo, 'dynworkflow/run6', runGit)).toBeTruthy();

    await cleanupWorktree({ repoRoot: repo, worktreePath: handle.worktreePath!, runId: 'run6' }, runGit);

    expect(existsSync(handle.worktreePath!)).toBe(false);
    expect(await branchTipSha(repo, 'dynworkflow/run6', runGit)).toBeNull();
  });

  it('abort preserva a branch (keepBranch) para autopsia', async () => {
    const repo = join(root, 'existing');
    mkdirSync(repo, { recursive: true });
    initRepoWithCommit(repo);

    const handle = await prepareWorkspace({ runId: 'run7', projectPath: repo }, runGit);
    git(handle.worktreePath!, 'config', 'user.name', 'Test User');
    git(handle.worktreePath!, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(handle.worktreePath!, 'work.ts'), 'work', 'utf8');
    git(handle.worktreePath!, 'add', '-A');
    git(handle.worktreePath!, 'commit', '-m', 'wf(run7): coder attempt 1');

    await cleanupWorktree(
      { repoRoot: repo, worktreePath: handle.worktreePath!, runId: 'run7', keepBranch: true },
      runGit,
    );

    expect(existsSync(handle.worktreePath!)).toBe(false);
    expect(await branchTipSha(repo, 'dynworkflow/run7', runGit)).toBeTruthy();
  });
});
