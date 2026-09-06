
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGit,
  commitNode,
  commitWip,
  WORKFLOW_RUN_LOCK_FILE,
  buildTouchedFilesReport,
  computeTouchedFiles,
  matchWriteSet,
  resetToCommit,
  squashMergePostGate,
  finalizeStagedMerge,
  branchTipSha,
  revParseHead,
  nodeCommitMessage,
  wipCommitMessage,
  squashCommitMessage,
  WORKFLOW_GIT_AUTHOR_EMAIL,
  WORKFLOW_GIT_AUTHOR_NAME,
} from '../dynamic-workflows/workflow-git';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function initRepo(dir: string): void {
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'user.email', 'test@example.com');
}

function writeAndCommit(dir: string, file: string, content: string, msg: string): string {
  const full = join(dir, file);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dwf-git-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('mensagens de commit padrao (8.6.1)', () => {
  it('node/WIP/squash seguem o formato da spec', () => {
    expect(nodeCommitMessage('run1', 'coder', 2)).toBe('wf(run1): coder attempt 2');
    expect(wipCommitMessage('run1', 'coder', 2)).toBe('wf-wip(run1): coder attempt 2 interrupted');
    expect(squashCommitMessage('Feature X', 'entrega pronta', 'run1')).toBe(
      'wf(Feature X): entrega pronta (run run1)',
    );
  });
});

describe('matchWriteSet (glob deterministico)', () => {
  it('casa ** em qualquer profundidade incluindo zero segmentos', () => {
    expect(matchWriteSet('src/a.ts', ['src/**'])).toBe(true);
    expect(matchWriteSet('src/deep/nested/a.ts', ['src/**'])).toBe(true);
    expect(matchWriteSet('src/a.ts', ['src/**/*.ts'])).toBe(true);
    expect(matchWriteSet('src/a.ts', ['**/*.ts'])).toBe(true);
  });

  it('* nao cruza separador', () => {
    expect(matchWriteSet('src/a.ts', ['src/*.ts'])).toBe(true);
    expect(matchWriteSet('src/deep/a.ts', ['src/*.ts'])).toBe(false);
  });

  it('path exato sem curinga casa exato', () => {
    expect(matchWriteSet('package.json', ['package.json'])).toBe(true);
    expect(matchWriteSet('package.json', ['other.json'])).toBe(false);
  });

  it('writeSet vazio nega tudo', () => {
    expect(matchWriteSet('any.ts', [])).toBe(false);
  });
});

describe('commit do host por node e WIP (8.6.1)', () => {
  it('commitNode cria commit com autor proprio e mensagem padrao', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    writeAndCommit(repo, 'base.txt', 'base', 'base');

    writeFileSync(join(repo, 'feature.ts'), 'export const x = 1;', 'utf8');
    const res = await commitNode({ runId: 'run1', nodeId: 'coder', attempt: 1, cwd: repo }, runGit);

    expect(res.empty).toBe(false);
    expect(res.sha).toBeTruthy();
    expect(git(repo, 'log', '-1', '--pretty=%s')).toBe('wf(run1): coder attempt 1');
    expect(git(repo, 'log', '-1', '--pretty=%an')).toBe(WORKFLOW_GIT_AUTHOR_NAME);
    expect(git(repo, 'log', '-1', '--pretty=%ae')).toBe(WORKFLOW_GIT_AUTHOR_EMAIL);
  });

  it('commitNode em working tree limpo nao cria commit vazio', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    writeAndCommit(repo, 'base.txt', 'base', 'base');
    const before = git(repo, 'rev-parse', 'HEAD');

    const res = await commitNode({ runId: 'run1', nodeId: 'validator', attempt: 1, cwd: repo }, runGit);

    expect(res.empty).toBe(true);
    expect(res.sha).toBeNull();
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('commitWip preserva o progresso do writer em interrupcao', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    writeAndCommit(repo, 'base.txt', 'base', 'base');

    writeFileSync(join(repo, 'partial.ts'), 'half done', 'utf8');
    const res = await commitWip({ runId: 'run1', nodeId: 'coder', attempt: 3, cwd: repo }, runGit);

    expect(res.empty).toBe(false);
    expect(git(repo, 'log', '-1', '--pretty=%s')).toBe('wf-wip(run1): coder attempt 3 interrupted');
  });

  it('git add -A transitorio: retry recupera (nao mata o node)', async () => {
    let addCalls = 0;
    const fakeGit = async (
      args: string[],
    ): Promise<{ code: number; stdout: string; stderr: string }> => {
      const cmd = args.join(' ');
      if (cmd === 'add -A') {
        addCalls += 1;
        return addCalls === 1
          ? { code: 1, stdout: '', stderr: "fatal: Unable to create '.../index.lock': File exists" }
          : { code: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('diff --cached --name-only')) return { code: 0, stdout: 'src/x.ts\n', stderr: '' };
      if (cmd.includes('commit')) return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'rev-parse HEAD') return { code: 0, stdout: 'sha-abc', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const res = await commitNode(
      { runId: 'run1', nodeId: 'coder', attempt: 1, cwd: '/x' },
      fakeGit as unknown as typeof runGit,
    );
    expect(addCalls).toBe(2); // falhou 1x, retry passou
    expect(res).toEqual({ sha: 'sha-abc', empty: false });
  });

  it('git add -A persistente: propaga COM o stderr (que antes se perdia)', async () => {
    const fakeGit = async (
      args: string[],
    ): Promise<{ code: number; stdout: string; stderr: string }> =>
      args.join(' ') === 'add -A'
        ? { code: 1, stdout: '', stderr: 'fatal: not enough disk space' }
        : { code: 0, stdout: '', stderr: '' };
    await expect(
      commitNode(
        { runId: 'run1', nodeId: 'coder', attempt: 1, cwd: '/x' },
        fakeGit as unknown as typeof runGit,
      ),
    ).rejects.toThrow('not enough disk space');
  });
});

describe('touched-files por diff de commit + writeSet (8.6.1 / 7.4)', () => {
  it('primeiro commit do run lista todos os arquivos do node', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const base = writeAndCommit(repo, 'base.txt', 'base', 'base');

    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'a', 'utf8');
    writeFileSync(join(repo, 'src', 'b.ts'), 'b', 'utf8');
    const node = await commitNode({ runId: 'r', nodeId: 'coder', attempt: 1, cwd: repo }, runGit);

    const files = await computeTouchedFiles(repo, base, node.sha!, runGit);
    expect(files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('flagra arquivo tocado fora do writeSet (node falha salvo gate de escopo)', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const base = writeAndCommit(repo, 'base.txt', 'base', 'base');

    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'ok.ts'), 'ok', 'utf8');
    writeFileSync(join(repo, 'secret.env'), 'leak', 'utf8');
    const node = await commitNode({ runId: 'r', nodeId: 'coder', attempt: 1, cwd: repo }, runGit);

    const report = await buildTouchedFilesReport(
      {
        runId: 'r',
        nodeId: 'coder',
        attempt: 1,
        cwd: repo,
        fromSha: base,
        toSha: node.sha!,
        writeSet: ['src/**'],
      },
      runGit,
    );

    expect(report.files).toEqual(['secret.env', 'src/ok.ts']);
    expect(report.outsideWriteSet).toEqual(['secret.env']);
  });

  it('SM-29: arquivo INTERNO do workflow (.lionclaw-workflow-run.lock) NAO reprova o writer', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const base = writeAndCommit(repo, 'base.txt', 'base', 'base');

    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'ok.ts'), 'ok', 'utf8');
    writeFileSync(join(repo, '.lionclaw-workflow-run.lock'), '{}', 'utf8');
    const node = await commitNode({ runId: 'r', nodeId: 'coder', attempt: 1, cwd: repo }, runGit);

    const report = await buildTouchedFilesReport(
      { runId: 'r', nodeId: 'coder', attempt: 1, cwd: repo, fromSha: base, toSha: node.sha!, writeSet: ['src/**'] },
      runGit,
    );

    expect(report.files).toEqual(['src/ok.ts']);
    expect(report.outsideWriteSet).toEqual([]);
  });

  it('SM-38: temp do agente (.verify.mjs) e arquivo GITIGNORED NAO reprovam o writer', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const base = writeAndCommit(repo, '.gitignore', 'build.tmp\nnode_modules/\n', 'base');

    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'ok.ts'), 'ok', 'utf8');
    writeFileSync(join(repo, '.verify.mjs'), 'console.log(1)', 'utf8');
    writeFileSync(join(repo, 'build.tmp'), 'x', 'utf8');
    git(repo, 'add', '-f', 'build.tmp');
    const node = await commitNode({ runId: 'r', nodeId: 'coder', attempt: 1, cwd: repo }, runGit);

    const report = await buildTouchedFilesReport(
      { runId: 'r', nodeId: 'coder', attempt: 1, cwd: repo, fromSha: base, toSha: node.sha!, writeSet: ['src/**'] },
      runGit,
    );

    expect(report.files).toEqual(['src/ok.ts']);
    expect(report.outsideWriteSet).toEqual([]);
  });

  it('SM-38b: artefatos de build (dist/, .tsbuildinfo) NAO reprovam o writer mesmo SEM .gitignore', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const base = writeAndCommit(repo, 'base.txt', 'base', 'base');

    mkdirSync(join(repo, 'packages', 'server', 'src', 'db'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'server', 'src', 'db', 'index.ts'), 'export const x = 1;', 'utf8');
    mkdirSync(join(repo, 'packages', 'server', 'dist', 'db'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'server', 'dist', 'db', 'index.js'), 'exports.x=1', 'utf8');
    writeFileSync(join(repo, 'packages', 'server', 'dist', '.tsbuildinfo'), '{}', 'utf8');
    const node = await commitNode({ runId: 'r', nodeId: 'coder', attempt: 1, cwd: repo }, runGit);

    const report = await buildTouchedFilesReport(
      {
        runId: 'r',
        nodeId: 'coder',
        attempt: 1,
        cwd: repo,
        fromSha: base,
        toSha: node.sha!,
        writeSet: ['packages/server/src/**'],
      },
      runGit,
    );

    expect(report.files).toEqual(['packages/server/src/db/index.ts']);
    expect(report.outsideWriteSet).toEqual([]);
  });

  it('tudo dentro do writeSet -> outsideWriteSet vazio', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const base = writeAndCommit(repo, 'base.txt', 'base', 'base');

    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'a', 'utf8');
    const node = await commitNode({ runId: 'r', nodeId: 'coder', attempt: 1, cwd: repo }, runGit);

    const report = await buildTouchedFilesReport(
      { runId: 'r', nodeId: 'coder', attempt: 1, cwd: repo, fromSha: base, toSha: node.sha!, writeSet: ['src/**'] },
      runGit,
    );
    expect(report.outsideWriteSet).toEqual([]);
  });
});

describe('reset de node/rodada (13.8)', () => {
  it('git reset --hard ao commit do node anterior desfaz o estrago', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    writeAndCommit(repo, 'base.txt', 'base', 'base');

    writeFileSync(join(repo, 'good.ts'), 'good', 'utf8');
    const node1 = await commitNode({ runId: 'r', nodeId: 'n1', attempt: 1, cwd: repo }, runGit);
    writeFileSync(join(repo, 'bad.ts'), 'broken', 'utf8');
    await commitNode({ runId: 'r', nodeId: 'n2', attempt: 1, cwd: repo }, runGit);

    await resetToCommit(repo, node1.sha!, runGit);

    expect(await revParseHead(repo, runGit)).toBe(node1.sha);
    expect(git(repo, 'log', '-1', '--pretty=%s')).toBe('wf(r): n1 attempt 1');
  });
});

describe('squash merge pos-gate (8.6.2)', () => {
  async function setupRunBranch(): Promise<{ repo: string; baseSha: string }> {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const baseSha = writeAndCommit(repo, 'base.txt', 'base', 'base');
    git(repo, 'branch', 'dynworkflow/run1', baseSha);
    git(repo, 'checkout', 'dynworkflow/run1');
    writeAndCommit(repo, 'feature.ts', 'feature', 'wf(run1): coder attempt 1');
    git(repo, 'checkout', 'main');
    return { repo, baseSha };
  }

  it('entrega VAZIA (run sem commits) -> squashed empty, sem commit, sem erro', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const baseSha = writeAndCommit(repo, 'base.txt', 'base', 'base');
    git(repo, 'branch', 'dynworkflow/run1', baseSha);

    const outcome = await squashMergePostGate(
      {
        cwd: repo,
        baseBranch: 'main',
        runBranch: 'dynworkflow/run1',
        baseCommitSha: baseSha,
        name: 'Feature',
        deliverySummary: 'entrega',
        runId: 'run1',
      },
      runGit,
    );

    expect(outcome.kind).toBe('squashed');
    if (outcome.kind === 'squashed') {
      expect(outcome.empty).toBe(true);
      expect(outcome.mergeSha).toBe(baseSha);
    }
    expect(git(repo, 'log', '-1', '--pretty=%s')).toBe('base');
  });

  it('base parada -> squash direto, um unico commit limpo', async () => {
    const { repo, baseSha } = await setupRunBranch();

    const outcome = await squashMergePostGate(
      {
        cwd: repo,
        baseBranch: 'main',
        runBranch: 'dynworkflow/run1',
        baseCommitSha: baseSha,
        name: 'Feature',
        deliverySummary: 'entrega',
        runId: 'run1',
      },
      runGit,
    );

    expect(outcome.kind).toBe('squashed');
    if (outcome.kind === 'squashed') {
      expect(outcome.baseAdvanced).toBe(false);
      expect(git(repo, 'log', '-1', '--pretty=%s')).toBe('wf(Feature): entrega (run run1)');
      expect(git(repo, 'cat-file', '-e', `${outcome.mergeSha}:feature.ts`) === '').toBe(true);
    }
  });

  it('base ANDOU + merge LIMPO -> staging sem tocar a base, re-check sinalizado', async () => {
    const { repo, baseSha } = await setupRunBranch();
    const advanced = writeAndCommit(repo, 'parallel.ts', 'parallel work', 'user parallel commit');
    expect(advanced).not.toBe(baseSha);

    const outcome = await squashMergePostGate(
      {
        cwd: repo,
        baseBranch: 'main',
        runBranch: 'dynworkflow/run1',
        baseCommitSha: baseSha,
        name: 'Feature',
        deliverySummary: 'entrega',
        runId: 'run1',
      },
      runGit,
    );

    expect(outcome.kind).toBe('staged');
    if (outcome.kind === 'staged') {
      expect(outcome.baseAdvanced).toBe(true);
      expect(outcome.recheckRequired).toBe(true);
      expect(await branchTipSha(repo, 'main', runGit)).toBe(advanced);
      const stagingTip = await branchTipSha(repo, 'dynworkflow-staging/run1', runGit);
      expect(stagingTip).toBe(outcome.stagingSha);

      const fin = await finalizeStagedMerge(
        { cwd: repo, baseBranch: 'main', stagingSha: outcome.stagingSha },
        runGit,
      );
      expect(await branchTipSha(repo, 'main', runGit)).toBe(fin.mergeSha);
    }
  });

  it('base ANDOU + CONFLITO -> nunca auto-resolve; branch do run preservada', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const baseSha = writeAndCommit(repo, 'shared.ts', 'original', 'base');
    git(repo, 'branch', 'dynworkflow/run1', baseSha);
    git(repo, 'checkout', 'dynworkflow/run1');
    writeAndCommit(repo, 'shared.ts', 'run version', 'wf(run1): coder attempt 1');
    git(repo, 'checkout', 'main');
    writeAndCommit(repo, 'shared.ts', 'user version', 'user parallel');

    const outcome = await squashMergePostGate(
      {
        cwd: repo,
        baseBranch: 'main',
        runBranch: 'dynworkflow/run1',
        baseCommitSha: baseSha,
        name: 'Feature',
        deliverySummary: 'entrega',
        runId: 'run1',
      },
      runGit,
    );

    expect(outcome.kind).toBe('conflict');
    if (outcome.kind === 'conflict') {
      expect(outcome.conflicted).toBe(true);
      expect(outcome.conflictPaths).toContain('shared.ts');
    }
    expect(await branchTipSha(repo, 'dynworkflow/run1', runGit)).not.toBeNull();
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});

describe('S4: transitorios por-run fora dos commits e da entrega', () => {
  const LOCK = WORKFLOW_RUN_LOCK_FILE;

  it('(d) commitNode nao commita SPEC copiada nem lock; transitorio sozinho nao vira commit', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    writeAndCommit(repo, 'base.txt', 'base', 'base');

    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'minha-spec.md'), '# spec', 'utf8');
    writeFileSync(join(repo, LOCK), '{}', 'utf8');
    writeFileSync(join(repo, 'src.ts'), 'code', 'utf8');
    const res = await commitNode(
      {
        runId: 'r',
        nodeId: 'coder',
        attempt: 1,
        cwd: repo,
        transientPaths: [LOCK, 'docs/minha-spec.md'],
      },
      runGit,
    );

    expect(res.empty).toBe(false);
    expect(git(repo, 'show', '--name-only', '--pretty=format:', 'HEAD')).toBe('src.ts');
    expect(existsSync(join(repo, 'docs', 'minha-spec.md'))).toBe(true);
    expect(existsSync(join(repo, LOCK))).toBe(true);

    const again = await commitNode(
      {
        runId: 'r',
        nodeId: 'coder',
        attempt: 2,
        cwd: repo,
        transientPaths: [LOCK, 'docs/minha-spec.md'],
      },
      runGit,
    );
    expect(again.empty).toBe(true);
    expect(again.sha).toBeNull();
  });

  it('(a)(c) entrega nao contem o lock mesmo COMMITADO na branch do run; base termina limpa', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const baseSha = writeAndCommit(repo, 'base.txt', 'base', 'base');
    git(repo, 'branch', 'dynworkflow/run1', baseSha);
    git(repo, 'checkout', 'dynworkflow/run1');
    writeFileSync(join(repo, 'feature.ts'), 'feature', 'utf8');
    writeFileSync(join(repo, LOCK), '{}', 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'wf(run1): coder attempt 1');
    git(repo, 'checkout', 'main');

    const outcome = await squashMergePostGate(
      {
        cwd: repo,
        baseBranch: 'main',
        runBranch: 'dynworkflow/run1',
        baseCommitSha: baseSha,
        name: 'Feature',
        deliverySummary: 'entrega',
        runId: 'run1',
        transientPaths: [LOCK],
      },
      runGit,
    );

    expect(outcome.kind).toBe('squashed');
    if (outcome.kind === 'squashed') {
      expect(outcome.empty).toBeUndefined();
      git(repo, 'cat-file', '-e', `${outcome.mergeSha}:feature.ts`);
      expect(() => git(repo, 'cat-file', '-e', `${outcome.mergeSha}:${LOCK}`)).toThrow();
    }
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('(b) arquivo .lionclaw/ RASTREADO sobrevive ao squash e mudanca legitima do run e entregue', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    writeAndCommit(repo, '.lionclaw/qualquer.md', 'v1', 'base com .lionclaw rastreado');
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'branch', 'dynworkflow/run1', baseSha);
    git(repo, 'checkout', 'dynworkflow/run1');
    writeFileSync(join(repo, '.lionclaw', 'qualquer.md'), 'v2 do run', 'utf8');
    writeFileSync(join(repo, LOCK), '{}', 'utf8');
    const node = await commitNode(
      { runId: 'run1', nodeId: 'coder', attempt: 1, cwd: repo, transientPaths: [LOCK] },
      runGit,
    );
    expect(node.empty).toBe(false);
    expect(git(repo, 'show', '--name-only', '--pretty=format:', 'HEAD')).toBe('.lionclaw/qualquer.md');
    git(repo, 'checkout', 'main');

    const outcome = await squashMergePostGate(
      {
        cwd: repo,
        baseBranch: 'main',
        runBranch: 'dynworkflow/run1',
        baseCommitSha: baseSha,
        name: 'Feature',
        deliverySummary: 'entrega',
        runId: 'run1',
        transientPaths: [LOCK],
      },
      runGit,
    );

    expect(outcome.kind).toBe('squashed');
    expect(git(repo, 'show', 'main:.lionclaw/qualquer.md')).toBe('v2 do run');
    expect(() => git(repo, 'cat-file', '-e', 'main:' + LOCK)).toThrow();
    expect(git(repo, 'status', '--porcelain')).toBe(`?? ${LOCK}`);
  });

  it('entrega SO-com-lock vira entrega vazia (sem commit vazio, sem WorkflowGitError)', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const baseSha = writeAndCommit(repo, 'base.txt', 'base', 'base');
    git(repo, 'branch', 'dynworkflow/run1', baseSha);
    git(repo, 'checkout', 'dynworkflow/run1');
    writeFileSync(join(repo, LOCK), '{}', 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'wf(run1): so o lock vazou');
    git(repo, 'checkout', 'main');

    const outcome = await squashMergePostGate(
      {
        cwd: repo,
        baseBranch: 'main',
        runBranch: 'dynworkflow/run1',
        baseCommitSha: baseSha,
        name: 'Feature',
        deliverySummary: 'entrega',
        runId: 'run1',
        transientPaths: [LOCK],
      },
      runGit,
    );

    expect(outcome.kind).toBe('squashed');
    if (outcome.kind === 'squashed') {
      expect(outcome.empty).toBe(true);
    }
    expect(git(repo, 'log', '-1', '--pretty=%s')).toBe('base');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('P0: SPEC untracked PRE-EXISTENTE no checkout do usuario sobrevive a entrega intacta', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const baseSha = writeAndCommit(repo, 'base.txt', 'base', 'base');
    git(repo, 'branch', 'dynworkflow/run1', baseSha);
    git(repo, 'checkout', 'dynworkflow/run1');
    writeFileSync(join(repo, 'feature.ts'), 'feature', 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'wf(run1): coder attempt 1');
    git(repo, 'checkout', 'main');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'minha-spec.md'), '# spec original do usuario', 'utf8');

    const outcome = await squashMergePostGate(
      {
        cwd: repo,
        baseBranch: 'main',
        runBranch: 'dynworkflow/run1',
        baseCommitSha: baseSha,
        name: 'Feature',
        deliverySummary: 'entrega',
        runId: 'run1',
        transientPaths: [LOCK, 'docs/minha-spec.md'],
      },
      runGit,
    );

    expect(outcome.kind).toBe('squashed');
    expect(existsSync(join(repo, 'docs', 'minha-spec.md'))).toBe(true);
    expect(readFileSync(join(repo, 'docs', 'minha-spec.md'), 'utf8')).toBe(
      '# spec original do usuario',
    );
    expect(() => git(repo, 'cat-file', '-e', 'main:docs/minha-spec.md')).toThrow();
    git(repo, 'cat-file', '-e', 'main:feature.ts');
  });

  it('transitorio ABSOLUTO ou com ".." e filtrado fora: nunca toca arquivo fora do repo', async () => {
    const outside = join(root, 'fora.md');
    writeFileSync(outside, 'conteudo externo', 'utf8');
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const baseSha = writeAndCommit(repo, 'base.txt', 'base', 'base');
    git(repo, 'branch', 'dynworkflow/run1', baseSha);
    git(repo, 'checkout', 'dynworkflow/run1');
    writeFileSync(join(repo, 'feature.ts'), 'feature', 'utf8');
    writeFileSync(join(repo, LOCK), '{}', 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'wf(run1): coder attempt 1');
    git(repo, 'checkout', 'main');

    const outcome = await squashMergePostGate(
      {
        cwd: repo,
        baseBranch: 'main',
        runBranch: 'dynworkflow/run1',
        baseCommitSha: baseSha,
        name: 'Feature',
        deliverySummary: 'entrega',
        runId: 'run1',
        transientPaths: ['../fora.md', outside, LOCK],
      },
      runGit,
    );

    expect(outcome.kind).toBe('squashed');
    expect(readFileSync(outside, 'utf8')).toBe('conteudo externo');
    if (outcome.kind === 'squashed') {
      expect(() => git(repo, 'cat-file', '-e', `${outcome.mergeSha}:${LOCK}`)).toThrow();
    }
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('caminho STAGING (base andou): lock fora do commit de staging, base limpa', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const baseSha = writeAndCommit(repo, 'base.txt', 'base', 'base');
    git(repo, 'branch', 'dynworkflow/run1', baseSha);
    git(repo, 'checkout', 'dynworkflow/run1');
    writeFileSync(join(repo, 'feature.ts'), 'feature', 'utf8');
    writeFileSync(join(repo, LOCK), '{}', 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'wf(run1): coder attempt 1');
    git(repo, 'checkout', 'main');
    writeAndCommit(repo, 'parallel.ts', 'parallel', 'user parallel commit');

    const outcome = await squashMergePostGate(
      {
        cwd: repo,
        baseBranch: 'main',
        runBranch: 'dynworkflow/run1',
        baseCommitSha: baseSha,
        name: 'Feature',
        deliverySummary: 'entrega',
        runId: 'run1',
        transientPaths: [LOCK],
      },
      runGit,
    );

    expect(outcome.kind).toBe('staged');
    if (outcome.kind === 'staged') {
      git(repo, 'cat-file', '-e', `${outcome.stagingSha}:feature.ts`);
      expect(() => git(repo, 'cat-file', '-e', `${outcome.stagingSha}:${LOCK}`)).toThrow();
    }
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});
