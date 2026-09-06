
import { describe, it, expect } from 'vitest';
import {
  createCloserPermissionGuard,
  tokenizeCommand,
  isGitCommand,
  defaultPathContainment,
  type CloserGitAuditEvent,
  type CloserGitConfirmRequest,
} from '../dynamic-workflows/closer-permission-guard';
import type {
  ComposedToolInput,
  ToolDecision,
} from '../dynamic-workflows/workflow-agent-adapter';

const WORKSPACE = '/work/run-1/worktree';

function makeGuard(over?: {
  confirm?: (req: CloserGitConfirmRequest) => boolean | Promise<boolean>;
  audit?: (e: CloserGitAuditEvent) => void;
  delegate?: (i: ComposedToolInput) => ToolDecision | Promise<ToolDecision>;
}) {
  return createCloserPermissionGuard({
    runId: 'run-1',
    workspaceCwd: WORKSPACE,
    confirmGitWrite: over?.confirm,
    auditGit: over?.audit,
    delegate: over?.delegate,
  });
}

function bash(command: string): ComposedToolInput {
  return { toolName: 'Bash', input: { command } };
}

describe('closer-permission-guard: tokenizer e deteccao de git', () => {
  it('tokeniza respeitando aspas e detecta o executavel git', () => {
    expect(isGitCommand('git status')).toBe(true);
    expect(isGitCommand('  git   commit -m "msg com espaco"')).toBe(true);
    expect(isGitCommand('npm test')).toBe(false);
    const t = tokenizeCommand('git commit -m "a b c"');
    expect(t.tokens).toEqual(['git', 'commit', '-m', 'a b c']);
    expect(t.compound).toBe(false);
  });

  it('marca comando composto (operadores de shell)', () => {
    expect(tokenizeCommand('git status && git push').compound).toBe(true);
    expect(tokenizeCommand('git log | head').compound).toBe(true);
    expect(tokenizeCommand('git diff; rm -rf /').compound).toBe(true);
  });
});

describe('closer-permission-guard: leitura git livre (8.8)', () => {
  it('status/diff/log/show/blame -> ALLOW sem confirmacao nem audit', async () => {
    let confirmCalls = 0;
    const audits: CloserGitAuditEvent[] = [];
    const guard = makeGuard({
      confirm: () => {
        confirmCalls += 1;
        return true;
      },
      audit: (e) => audits.push(e),
    });
    for (const cmd of [
      'git status',
      'git diff HEAD~1',
      'git log --oneline -5',
      'git show abc123',
      'git blame file.ts',
      'git branch', // listagem = read
      'git branch --list',
    ]) {
      const d = await guard(bash(cmd));
      expect(d.behavior, cmd).toBe('allow');
    }
    expect(confirmCalls).toBe(0);
    expect(audits.length).toBe(0);
  });
});

describe('closer-permission-guard: escrita local sob confirmacao (8.8)', () => {
  it('commit aprovado com confirmacao inline + audit approved', async () => {
    const audits: CloserGitAuditEvent[] = [];
    const reqs: CloserGitConfirmRequest[] = [];
    const guard = makeGuard({
      confirm: (req) => {
        reqs.push(req);
        return true;
      },
      audit: (e) => audits.push(e),
    });
    const d = await guard(bash('git commit -m "fix bug residual"'));
    expect(d.behavior).toBe('allow');
    expect(reqs).toHaveLength(1);
    expect(reqs[0].subcommand).toBe('commit');
    expect(reqs[0].cwd).toBe(WORKSPACE);
    expect(audits).toHaveLength(1);
    expect(audits[0].decision).toBe('approved');
    expect(audits[0].subcommand).toBe('commit');
  });

  it('commit NEGADO quando a confirmacao recusa (audit denied)', async () => {
    const audits: CloserGitAuditEvent[] = [];
    const guard = makeGuard({ confirm: () => false, audit: (e) => audits.push(e) });
    const d = await guard(bash('git commit -m x'));
    expect(d.behavior).toBe('deny');
    expect(audits[0].decision).toBe('denied');
  });

  it('escrita local NEGADA por padrao quando NAO ha confirmador (fail-closed)', async () => {
    const guard = makeGuard({}); // sem confirm.
    for (const cmd of [
      'git add -A',
      'git commit -m x',
      'git merge feature',
      'git rebase main',
      'git reset --hard HEAD~1',
      'git checkout -b nova',
      'git branch -d velha',
      'git stash',
    ]) {
      const d = await guard(bash(cmd));
      expect(d.behavior, cmd).toBe('deny');
    }
  });

  it('todos os verbos de escrita da lista unica passam por confirmacao', async () => {
    const seen: string[] = [];
    const guard = makeGuard({
      confirm: (req) => {
        seen.push(req.subcommand);
        return true;
      },
    });
    const cmds = [
      'git add file.ts',
      'git commit -m m',
      'git merge x',
      'git rebase y',
      'git reset z',
      'git stash push',
      'git branch -m renomeada',
      'git checkout outra-branch',
    ];
    for (const c of cmds) {
      const d = await guard(bash(c));
      expect(d.behavior, c).toBe('allow');
    }
    expect(seen).toEqual([
      'add',
      'commit',
      'merge',
      'rebase',
      'reset',
      'stash',
      'branch',
      'checkout',
    ]);
  });
});

describe('closer-permission-guard: push e remotos sempre negados (8.8)', () => {
  it('push negado MESMO com confirmador que aprovaria tudo', async () => {
    const audits: CloserGitAuditEvent[] = [];
    const guard = makeGuard({ confirm: () => true, audit: (e) => audits.push(e) });
    const d = await guard(bash('git push origin main'));
    expect(d.behavior).toBe('deny');
    expect((d as { message: string }).message).toMatch(/push|remoto/i);
    expect(audits.some((a) => a.subcommand === 'push' && a.decision === 'denied')).toBe(true);
  });

  it('fetch/pull/clone/remote/submodule negados', async () => {
    const guard = makeGuard({ confirm: () => true });
    for (const cmd of [
      'git push',
      'git push --force',
      'git fetch origin',
      'git pull',
      'git clone https://x',
      'git remote add origin https://x',
      'git remote set-url origin https://y',
      'git submodule update',
    ]) {
      const d = await guard(bash(cmd));
      expect(d.behavior, cmd).toBe('deny');
    }
  });
});

describe('closer-permission-guard: containment do workspace (8.8)', () => {
  it('git -C apontando para fora do workspace e negado', async () => {
    const guard = makeGuard({ confirm: () => true });
    const d = await guard(bash('git -C /etc commit -m x'));
    expect(d.behavior).toBe('deny');
    expect((d as { message: string }).message).toMatch(/fora do workspace/i);
  });

  it('git -C para subdir do workspace e permitido (write com confirmacao)', async () => {
    const guard = makeGuard({ confirm: () => true });
    const d = await guard(bash(`git -C ${WORKSPACE}/src status`));
    expect(d.behavior).toBe('allow');
  });

  it('--git-dir/--work-tree para fora sao negados', async () => {
    const guard = makeGuard({ confirm: () => true });
    expect((await guard(bash('git --git-dir=/tmp/.git status'))).behavior).toBe('deny');
    expect((await guard(bash('git --work-tree=/ commit -m x'))).behavior).toBe('deny');
  });

  it('defaultPathContainment: relativo interno true; absoluto fora false; .. que escapa false', () => {
    expect(defaultPathContainment(WORKSPACE, 'src')).toBe(true);
    expect(defaultPathContainment(WORKSPACE, `${WORKSPACE}/a/b`)).toBe(true);
    expect(defaultPathContainment(WORKSPACE, '/etc')).toBe(false);
    expect(defaultPathContainment(WORKSPACE, '../../etc')).toBe(false);
  });
});

describe('closer-permission-guard: comando composto negado (8.8)', () => {
  it('encadear git esconde escrita atras de read: negado', async () => {
    const guard = makeGuard({ confirm: () => true });
    expect((await guard(bash('git status && git push'))).behavior).toBe('deny');
    expect((await guard(bash('git log | tee out.txt'))).behavior).toBe('deny');
  });
});

describe('closer-permission-guard: tools NAO-git seguem o delegate (8.8)', () => {
  it('Bash sem git e roteado ao delegate', async () => {
    const calls: ComposedToolInput[] = [];
    const guard = makeGuard({
      delegate: (i) => {
        calls.push(i);
        return { behavior: 'deny', message: 'delegate decidiu' };
      },
    });
    const d = await guard(bash('npm test'));
    expect(d.behavior).toBe('deny');
    expect((d as { message: string }).message).toBe('delegate decidiu');
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe('Bash');
  });

  it('Write/Edit caem no delegate (guard composto da policy)', async () => {
    const seen: string[] = [];
    const guard = makeGuard({
      delegate: (i) => {
        seen.push(i.toolName);
        return { behavior: 'allow' };
      },
    });
    expect((await guard({ toolName: 'Write', input: { file_path: 'a.ts' } })).behavior).toBe('allow');
    expect((await guard({ toolName: 'Edit', input: { file_path: 'b.ts' } })).behavior).toBe('allow');
    expect((await guard({ toolName: 'Read', input: { file_path: 'c.ts' } })).behavior).toBe('allow');
    expect(seen).toEqual(['Write', 'Edit', 'Read']);
  });

  it('sem delegate, tool nao-git e negada (fail-closed)', async () => {
    const guard = makeGuard({});
    const d = await guard({ toolName: 'Write', input: { file_path: 'a.ts' } });
    expect(d.behavior).toBe('deny');
  });
});
