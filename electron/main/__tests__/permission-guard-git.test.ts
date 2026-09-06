
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { createPermissionGuard } from '../permission-guard';

const DENY_MESSAGE = 'Comandos git que modificam state (commit, push, reset, rebase, merge, etc) sao proibidos. O usuario faz controle de versao manualmente. Use Write/Edit para arquivos, e git status/diff/log para inspecao.';

function makeGuard() {
  return createPermissionGuard(() => null);
}

describe('permission-guard: FORBIDDEN_GIT_PATTERNS', () => {
  let guard: ReturnType<typeof makeGuard>;

  beforeEach(() => {
    guard = makeGuard();
  });

  const forbiddenCommands = [
    { label: 'git commit', cmd: 'git commit -m "feat: add feature"' },
    { label: 'git commit --amend', cmd: 'git commit --amend --no-edit' },
    { label: 'git push', cmd: 'git push origin main' },
    { label: 'git push --force', cmd: 'git push --force origin main' },
    { label: 'git reset', cmd: 'git reset HEAD~1' },
    { label: 'git reset --hard', cmd: 'git reset --hard HEAD' },
    { label: 'git reset --soft', cmd: 'git reset --soft HEAD~1' },
    { label: 'git reset --mixed', cmd: 'git reset --mixed HEAD' },
    { label: 'git rebase', cmd: 'git rebase main' },
    { label: 'git rebase -i', cmd: 'git rebase -i HEAD~3' },
    { label: 'git merge', cmd: 'git merge feature-branch' },
    { label: 'git merge --no-ff', cmd: 'git merge --no-ff feature-branch' },
    { label: 'git rm', cmd: 'git rm src/old-file.ts' },
    { label: 'git rm -r', cmd: 'git rm -r old-directory/' },
    { label: 'git stash drop', cmd: 'git stash drop stash@{0}' },
    { label: 'git tag', cmd: 'git tag v1.0.0' },
    { label: 'git tag annotated', cmd: 'git tag -a v1.0.0 -m "Release"' },
    { label: 'git remote add', cmd: 'git remote add upstream https://github.com/foo/bar.git' },
    { label: 'git remote set-url', cmd: 'git remote set-url origin https://github.com/foo/bar.git' },
    { label: 'git remote remove', cmd: 'git remote remove upstream' },
    { label: 'git remote rename', cmd: 'git remote rename origin upstream' },
    { label: 'git push -f', cmd: 'git push -f origin main' },
    { label: 'git fetch --force', cmd: 'git fetch --force origin' },
  ];

  for (const { label, cmd } of forbiddenCommands) {
    it(`denies "${label}" directly without modal`, async () => {
      const result = await guard('Bash', { command: cmd });
      expect(result.behavior).toBe('deny');
      expect((result as { behavior: 'deny'; message: string }).message).toBe(DENY_MESSAGE);
    });
  }

  const allowedGitCommands = [
    { label: 'git status', cmd: 'git status' },
    { label: 'git diff', cmd: 'git diff HEAD' },
    { label: 'git diff --cached', cmd: 'git diff --cached' },
    { label: 'git log', cmd: 'git log --oneline -10' },
    { label: 'git show', cmd: 'git show HEAD:src/file.ts' },
    { label: 'git branch --list', cmd: 'git branch --list' },
    { label: 'git ls-files', cmd: 'git ls-files src/' },
    { label: 'git ls-files --others', cmd: 'git ls-files --others --exclude-standard' },
    { label: 'git checkout main (branch switch)', cmd: 'git checkout main' },
    { label: 'git checkout -b new-branch', cmd: 'git checkout -b new-branch' },
    { label: 'git stash (save)', cmd: 'git stash' },
    { label: 'git add .', cmd: 'git add .' },
    { label: 'git add src/', cmd: 'git add src/' },
  ];

  for (const { label, cmd } of allowedGitCommands) {
    it(`allows read-only "${label}"`, async () => {
      const result = await guard('Bash', { command: cmd });
      expect(result.behavior).toBe('allow');
    });
  }


  const newForbiddenCommands = [
    {
      label: 'git checkout -- file.txt (discard local changes)',
      cmd: 'git checkout -- file.txt',
    },
    {
      label: 'git checkout -- src/ (discard directory changes)',
      cmd: 'git checkout -- src/',
    },
    {
      label: 'git clean -fd (delete untracked files)',
      cmd: 'git clean -fd',
    },
    {
      label: 'git clean -f (delete untracked files, short form)',
      cmd: 'git clean -f',
    },
    {
      label: 'git clean -fxd (also removes ignored files)',
      cmd: 'git clean -fxd',
    },
  ];

  for (const { label, cmd } of newForbiddenCommands) {
    it(`denies "${label}" directly without modal`, async () => {
      const result = await guard('Bash', { command: cmd });
      expect(result.behavior).toBe('deny');
      expect((result as { behavior: 'deny'; message: string }).message).toBe(DENY_MESSAGE);
    });
  }

  const nonGitCommands = [
    { label: 'npm install', cmd: 'npm install' },
    { label: 'npx tsc', cmd: 'npx tsc --noEmit' },
    { label: 'npm run build', cmd: 'npm run build' },
    { label: 'ls', cmd: 'ls -la' },
    { label: 'cat file', cmd: 'cat src/index.ts' },
  ];

  for (const { label, cmd } of nonGitCommands) {
    it(`does not block non-git command "${label}"`, async () => {
      const result = await guard('Bash', { command: cmd });
      if (result.behavior === 'deny') {
        expect((result as { behavior: 'deny'; message: string }).message).not.toBe(DENY_MESSAGE);
      } else {
        expect(result.behavior).toBe('allow');
      }
    });
  }
});
