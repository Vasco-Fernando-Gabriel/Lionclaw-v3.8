import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NON_INTERACTIVE_GIT_ENV,
  NON_INTERACTIVE_GIT_SSH_COMMAND,
  nonInteractiveGitEnv,
  applyNonInteractiveGitEnvToProcess,
} from '../dynamic-workflows/workflow-git-env';
import { runGit } from '../dynamic-workflows/workflow-git';

describe('workflow-git-env: vars nao-interativas (SM-28)', () => {
  it('NON_INTERACTIVE_GIT_ENV tem as chaves criticas com valores nao-interativos', () => {
    expect(NON_INTERACTIVE_GIT_ENV.GIT_TERMINAL_PROMPT).toBe('0');
    expect(NON_INTERACTIVE_GIT_ENV.GIT_SSH_COMMAND).toBe(NON_INTERACTIVE_GIT_SSH_COMMAND);
    expect(NON_INTERACTIVE_GIT_ENV.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    expect(NON_INTERACTIVE_GIT_ENV.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=accept-new');
    expect(NON_INTERACTIVE_GIT_ENV.GIT_SSH_COMMAND).toContain('ConnectTimeout=');
    expect(NON_INTERACTIVE_GIT_ENV.GIT_ASKPASS).toBe('/bin/false');
    expect(NON_INTERACTIVE_GIT_ENV.SSH_ASKPASS).toBe('/bin/false');
  });

  it('o objeto exportado e congelado (imutavel)', () => {
    expect(Object.isFrozen(NON_INTERACTIVE_GIT_ENV)).toBe(true);
  });
});

describe('workflow-git-env: nonInteractiveGitEnv (merge)', () => {
  it('mescla as vars SOBRE o base sem mutar o base', () => {
    const base: NodeJS.ProcessEnv = { FOO: 'bar', GIT_TERMINAL_PROMPT: '1' };
    const merged = nonInteractiveGitEnv(base);
    expect(merged.FOO).toBe('bar');
    expect(merged.GIT_TERMINAL_PROMPT).toBe('0');
    expect(merged.GIT_SSH_COMMAND).toBe(NON_INTERACTIVE_GIT_SSH_COMMAND);
    expect(base.GIT_TERMINAL_PROMPT).toBe('1');
    expect(base.GIT_SSH_COMMAND).toBeUndefined();
  });

  it('default usa process.env como base', () => {
    const merged = nonInteractiveGitEnv();
    expect(merged.GIT_TERMINAL_PROMPT).toBe('0');
    expect(merged.GIT_SSH_COMMAND).toBe(NON_INTERACTIVE_GIT_SSH_COMMAND);
  });
});

describe('workflow-git-env: applyNonInteractiveGitEnvToProcess (heranca)', () => {
  it('semeia as vars no env passado (idempotente, so as chaves de SM-28)', () => {
    const env: NodeJS.ProcessEnv = { KEEP: 'me' };
    applyNonInteractiveGitEnvToProcess(env);
    expect(env.KEEP).toBe('me');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_SSH_COMMAND).toBe(NON_INTERACTIVE_GIT_SSH_COMMAND);
    expect(env.GIT_ASKPASS).toBe('/bin/false');
    applyNonInteractiveGitEnvToProcess(env);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('sobrescreve um valor interativo previamente setado no env', () => {
    const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '1', SSH_ASKPASS: '/usr/bin/x11-ssh-askpass' };
    applyNonInteractiveGitEnvToProcess(env);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.SSH_ASKPASS).toBe('/bin/false');
  });
});

describe('workflow-git-env: runGit nao pendura num remote SSH (SM-28 end-to-end)', () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('git fetch de um host SSH inexistente FALHA RAPIDO em vez de pendurar', async () => {
    root = mkdtempSync(join(tmpdir(), 'wf-git-env-'));
    await runGit(['init', '-b', 'main'], root);
    await runGit(['remote', 'add', 'origin', 'git@nonexistent.invalid.lionclaw:owner/repo.git'], root);
    const started = Date.now();
    const res = await runGit(['fetch', 'origin'], root);
    const elapsed = Date.now() - started;
    expect(res.code).not.toBe(0);
    expect(elapsed).toBeLessThan(20_000);
    const combined = `${res.stdout}\n${res.stderr}`.toLowerCase();
    expect(combined).not.toContain('are you sure you want to continue connecting');
  }, 25_000);
});
