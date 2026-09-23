import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../db', () => ({
  insertAuditEntry: vi.fn(),
  getPermissionBypass: vi.fn(() => true),
}));

vi.mock('../ask-question', () => ({
  sendAskQuestion: vi.fn(),
}));

vi.mock('../repo-profiler', () => ({
  EXCLUDED_FROM_AUDIT_PATTERNS: [],
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

import {
  createCloserPermissionGuard,
  tokenizeCommand,
  type CloserGitConfirmRequest,
} from '../dynamic-workflows/closer-permission-guard';
import type {
  ComposedToolInput,
  ToolDecision as CloserToolDecision,
} from '../dynamic-workflows/workflow-agent-adapter';
import {
  squashMergePostGate,
  finalizeStagedMerge,
  resetToCommit,
  commitNode,
  type GitRunner,
  type GitRunResult,
} from '../dynamic-workflows/workflow-git';
import { createPermissionGuard } from '../permission-guard';

const WORKSPACE = '/work/run-1/worktree';

function makeCloserGuard(): (i: ComposedToolInput) => Promise<CloserToolDecision> {
  return createCloserPermissionGuard({
    runId: 'run-1',
    workspaceCwd: WORKSPACE,
    confirmGitWrite: (_req: CloserGitConfirmRequest) => true,
  });
}

function bash(command: string): ComposedToolInput {
  return { toolName: 'Bash', input: { command } };
}

describe('E1/T1 Superficie 1 (closer guard): push e remotos negados, merge local permitido', () => {
  const remoteDenied: Array<{ sub: string; cmd: string }> = [
    { sub: 'push', cmd: 'git push origin main' },
    { sub: 'push --force', cmd: 'git push --force origin main' },
    { sub: 'push -f', cmd: 'git push -f origin HEAD' },
    { sub: 'fetch', cmd: 'git fetch origin' },
    { sub: 'pull', cmd: 'git pull origin main' },
    { sub: 'clone', cmd: 'git clone https://example.com/repo.git' },
    { sub: 'remote add', cmd: 'git remote add upstream https://example.com/x.git' },
    { sub: 'remote set-url', cmd: 'git remote set-url origin https://example.com/y.git' },
    { sub: 'remote remove', cmd: 'git remote remove upstream' },
    { sub: 'submodule', cmd: 'git submodule update --init' },
    { sub: 'send-email', cmd: 'git send-email patch.eml' },
    { sub: 'request-pull', cmd: 'git request-pull v1 origin' },
    { sub: 'format-patch', cmd: 'git format-patch -1 HEAD' },
  ];

  for (const { sub, cmd } of remoteDenied) {
    it(`nega "${sub}" MESMO com confirmador inline true`, async () => {
      const guard = makeCloserGuard();
      const d = await guard(bash(cmd));
      expect(d.behavior).toBe('deny');
      if (d.behavior === 'deny') {
        expect(d.message.toLowerCase()).toContain('remoto');
        expect(d.message).not.toContain('encadeado');
      }
    });
  }

  const localWrite: Array<{ sub: string; cmd: string }> = [
    { sub: 'merge --squash', cmd: 'git merge --squash dynworkflow/run-1' },
    { sub: 'commit', cmd: 'git commit -m "wf: node-x attempt 1"' },
    { sub: 'add -A', cmd: 'git add -A' },
    { sub: 'reset --hard', cmd: 'git reset --hard HEAD~1' },
    { sub: 'checkout main', cmd: 'git checkout main' },
  ];

  for (const { sub, cmd } of localWrite) {
    it(`permite git LOCAL "${sub}" com confirmacao inline`, async () => {
      const guard = makeCloserGuard();
      const d = await guard(bash(cmd));
      expect(d.behavior).toBe('allow');
    });
  }

  it('git LOCAL e NEGADO sem confirmador (fail-closed) — mas continua sendo LOCAL, nao remoto', async () => {
    const guard = createCloserPermissionGuard({ runId: 'run-1', workspaceCwd: WORKSPACE });
    const d = await guard(bash('git merge --squash dynworkflow/run-1'));
    expect(d.behavior).toBe('deny');
    if (d.behavior === 'deny') {
      expect(d.message).toContain('confirmacao inline');
      expect(d.message.toLowerCase()).not.toContain('remoto');
    }
  });

  it('push COMPOSTO (`git status && git push`) e negado pelo SINAL compound, nao so pelo Set', async () => {
    expect(tokenizeCommand('git status && git push').compound).toBe(true);

    const guard = makeCloserGuard();
    const d = await guard(bash('git status && git push origin main'));
    expect(d.behavior).toBe('deny');
    if (d.behavior === 'deny') {
      expect(d.message).toContain('encadeado');
    }

    for (const cmd of ['git diff; git push', 'git log | git push', 'git status && git push --force origin main']) {
      const dd = await guard(bash(cmd));
      expect(dd.behavior).toBe('deny');
    }
  });
});

const FORBIDDEN_RUNNER_SUBCOMMANDS = new Set(['push', 'fetch', 'pull', 'clone', 'remote', 'submodule']);

interface RecordedCall {
  args: string[];
  cwd: string;
}

function makeRecordingRunner(opts?: { baseTip?: string | null; ahead?: string; cachedQuietCode?: number }): {
  runner: GitRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: GitRunner = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    const reply = (over: Partial<GitRunResult> = {}): GitRunResult => ({
      code: 0,
      stdout: '',
      stderr: '',
      ...over,
    });
    let i = 0;
    while (i < args.length && (args[i] === '-c' || args[i].startsWith('-c'))) {
      i += args[i] === '-c' ? 2 : 1;
    }
    const sub = args[i];
    const rest = args.slice(i + 1);

    if (sub === 'rev-parse' && rest.includes('--verify')) {
      return opts?.baseTip === null ? reply({ code: 1 }) : reply({ stdout: `${opts?.baseTip ?? 'basecommit0'}\n` });
    }
    if (sub === 'rev-parse') {
      return reply({ stdout: 'newheadsha\n' });
    }
    if (sub === 'rev-list') {
      return reply({ stdout: `${opts?.ahead ?? '3'}\n` });
    }
    if (sub === 'diff' && rest.includes('--quiet')) {
      return reply({ code: opts?.cachedQuietCode ?? 1 });
    }
    if (sub === 'diff' && rest.includes('--name-only') && rest.includes('--cached')) {
      return reply({ stdout: 'src/file.ts\n' });
    }
    if (sub === 'diff') {
      return reply({ stdout: '' });
    }
    return reply();
  };
  return { runner, calls };
}

function assertNoRemote(calls: RecordedCall[]): void {
  for (const { args } of calls) {
    expect(args.length).toBeGreaterThan(0);
    for (const a of args) {
      expect(FORBIDDEN_RUNNER_SUBCOMMANDS.has(a)).toBe(false);
    }
    expect(args).not.toContain('origin');
    if (args[0] === 'merge' || args.includes('merge')) {
      const hasLocalMode = args.includes('--squash') || args.includes('--ff-only') || args.includes('--abort');
      expect(hasLocalMode).toBe(true);
    }
  }
}

describe('E1/T1 Superficie 2 (runner): merge da entrega e git LOCAL, nunca push/fetch/pull/remote/origin', () => {
  it('squashMergePostGate (base parada) so emite git LOCAL', async () => {
    const { runner, calls } = makeRecordingRunner({ baseTip: 'basecommit0', ahead: '3' });
    const outcome = await squashMergePostGate(
      {
        cwd: '/repo',
        baseBranch: 'main',
        runBranch: 'dynworkflow/run-1',
        baseCommitSha: 'basecommit0',
        name: 'feat',
        deliverySummary: 'entrega',
        runId: '20260628_120000-abc123',
      },
      runner,
    );
    expect(outcome.kind).toBe('squashed');
    assertNoRemote(calls);
    expect(calls.some((c) => c.args.includes('merge') && c.args.includes('--squash'))).toBe(true);
    expect(calls.some((c) => c.args[0] === 'checkout')).toBe(true);
  });

  it('squashMergePostGate (base andou) faz staging LOCAL, nunca push', async () => {
    const { runner, calls } = makeRecordingRunner({
      baseTip: 'baseADVANCED',
      ahead: '3',
      cachedQuietCode: 1,
    });
    const outcome = await squashMergePostGate(
      {
        cwd: '/repo',
        baseBranch: 'main',
        runBranch: 'dynworkflow/run-1',
        baseCommitSha: 'basecommit0',
        name: 'feat',
        deliverySummary: 'entrega',
        runId: '20260628_120000-abc123',
      },
      runner,
    );
    expect(outcome.kind).toBe('staged');
    assertNoRemote(calls);
    expect(calls.some((c) => c.args[0] === 'branch')).toBe(true);
  });

  it('finalizeStagedMerge faz ff-only LOCAL, nunca push', async () => {
    const { runner, calls } = makeRecordingRunner({});
    const res = await finalizeStagedMerge({ cwd: '/repo', baseBranch: 'main', stagingSha: 'stagingsha' }, runner);
    expect(res.mergeSha).toBeTruthy();
    assertNoRemote(calls);
    expect(calls.some((c) => c.args.includes('merge') && c.args.includes('--ff-only'))).toBe(true);
  });

  it('resetToCommit e commitNode so emitem git LOCAL', async () => {
    const { runner, calls } = makeRecordingRunner({ cachedQuietCode: 1 });
    await resetToCommit('/repo', 'priorsha', runner);
    await commitNode({ runId: 'run-1', nodeId: 'node-x', attempt: 1, cwd: '/repo' }, runner);
    assertNoRemote(calls);
    expect(calls.some((c) => c.args[0] === 'reset' && c.args.includes('--hard'))).toBe(true);
    expect(calls.some((c) => c.args.includes('commit'))).toBe(true);
  });
});

const FORBIDDEN_GIT_DENY_MESSAGE =
  'Comandos git que modificam state (commit, push, reset, rebase, merge, etc) sao proibidos. O usuario faz controle de versao manualmente. Use Write/Edit para arquivos, e git status/diff/log para inspecao.';

describe('E1/T1 Superficie 3 (Bash autonomo): push/remote negados pelo guard generico', () => {
  const guard = createPermissionGuard(() => null);

  const pushAndRemote: Array<{ label: string; cmd: string }> = [
    { label: 'git push', cmd: 'git push origin main' },
    { label: 'git push --force', cmd: 'git push --force origin main' },
    { label: 'git push -f', cmd: 'git push -f origin HEAD' },
    { label: 'git remote add', cmd: 'git remote add upstream https://example.com/x.git' },
    { label: 'git remote set-url', cmd: 'git remote set-url origin https://example.com/y.git' },
    { label: 'git remote remove', cmd: 'git remote remove upstream' },
    { label: 'git remote rename', cmd: 'git remote rename origin upstream' },
    { label: 'git fetch --force', cmd: 'git fetch --force origin' },
  ];

  for (const { label, cmd } of pushAndRemote) {
    it(`nega "${label}" por behavior:'deny' (sem modal), mesmo com bypass LIGADO`, async () => {
      const d = await guard('Bash', { command: cmd });
      expect(d.behavior).toBe('deny');
      expect((d as { behavior: 'deny'; message: string }).message).toBe(FORBIDDEN_GIT_DENY_MESSAGE);
    });
  }

  it('a negacao do push NAO depende do toggle de bypass (ramo git e ANTES de confirmUnlessBypass)', async () => {
    const d = await guard('Bash', { command: 'git push origin main' });
    expect(d.behavior).toBe('deny');
  });

  it('git LOCAL de inspecao (status/diff/log) e checkout de branch NAO sao bloqueados pelo guard generico', async () => {
    for (const cmd of ['git status', 'git diff HEAD', 'git log --oneline -5', 'git checkout main']) {
      const d = await guard('Bash', { command: cmd });
      expect(d.behavior).toBe('allow');
    }
  });
});

describe('E1/T1 sintese: nenhum caminho autonomo da push', () => {
  it('as tres superficies negam push para o MESMO comando', async () => {
    const pushCmd = 'git push origin main';

    const closer = makeCloserGuard();
    const s1 = await closer(bash(pushCmd));
    expect(s1.behavior).toBe('deny');

    expect(FORBIDDEN_RUNNER_SUBCOMMANDS.has('push')).toBe(true);

    const bashGuard = createPermissionGuard(() => null);
    const s3 = await bashGuard('Bash', { command: pushCmd });
    expect(s3.behavior).toBe('deny');
  });
});
