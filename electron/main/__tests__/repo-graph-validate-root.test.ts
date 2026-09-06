
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  validateRepoRootPath,
  validateRepoRootAgainstCanonical,
  hasParentTraversal,
  type ValidateRootDeps,
} from '../repo-graph/validate-root';

let baseDir = '';
let gitRepoDir = '';
let gitSubDir = '';
let plainDir = '';
let linkToPlain = '';
let escapeTargetDir = '';
let linkEscaping = '';

const noGitDeps: ValidateRootDeps = {
  gitToplevel: () => {
    throw new Error('fatal: not a git repository');
  },
};

beforeAll(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-rg-root-'));

  gitRepoDir = path.join(baseDir, 'git-repo');
  gitSubDir = path.join(gitRepoDir, 'packages', 'core');
  fs.mkdirSync(gitSubDir, { recursive: true });
  execFileSync('git', ['init', '-q', gitRepoDir], { encoding: 'utf8' });

  plainDir = path.join(baseDir, 'plain');
  fs.mkdirSync(plainDir);
  linkToPlain = path.join(baseDir, 'link-to-plain');
  fs.symlinkSync(plainDir, linkToPlain, 'dir');

  escapeTargetDir = path.join(baseDir, 'outside');
  fs.mkdirSync(escapeTargetDir);
  linkEscaping = path.join(plainDir, 'link-escaping');
  fs.symlinkSync(escapeTargetDir, linkEscaping, 'dir');
});

afterAll(() => {
  if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
});


describe('hasParentTraversal', () => {
  it('detecta ../ em qualquer posicao', () => {
    expect(hasParentTraversal('/a/../b')).toBe(true);
    expect(hasParentTraversal('../b')).toBe(true);
    expect(hasParentTraversal('/a/b/..')).toBe(true);
  });

  it('nao confunde nomes que contem pontos', () => {
    expect(hasParentTraversal('/a/..b/c')).toBe(false);
    expect(hasParentTraversal('/a/b../c')).toBe(false);
    expect(hasParentTraversal('/a/.hidden/c')).toBe(false);
  });
});


describe('validateRepoRootPath (13.2)', () => {
  it('rejeita path vazio e relativo', () => {
    expect(validateRepoRootPath('')).toHaveProperty('error');
    expect(validateRepoRootPath('   ')).toHaveProperty('error');
    expect(validateRepoRootPath('relative/path')).toHaveProperty('error');
  });

  it('rejeita ../ no input cru (sem normalizacao silenciosa)', () => {
    const result = validateRepoRootPath(`${plainDir}/../plain`);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/\.\.\//);
  });

  it('rejeita pasta inexistente', () => {
    const result = validateRepoRootPath(path.join(baseDir, 'nao-existe'));
    expect(result).toHaveProperty('error');
  });

  it('rejeita arquivo (nao-diretorio)', () => {
    const file = path.join(baseDir, 'arquivo.txt');
    fs.writeFileSync(file, 'x');
    const result = validateRepoRootPath(file);
    expect(result).toHaveProperty('error');
  });

  it('pasta sem git: canonical = realpath do candidato, gitRoot null', () => {
    const result = validateRepoRootPath(plainDir, noGitDeps);
    expect(result).toMatchObject({
      canonicalRootPath: fs.realpathSync(plainDir),
      gitRoot: null,
      name: 'plain',
    });
  });

  it('symlink para pasta: canonicaliza para o realpath do ALVO (F9)', () => {
    const result = validateRepoRootPath(linkToPlain, noGitDeps);
    expect(result).toMatchObject({
      canonicalRootPath: fs.realpathSync(plainDir),
    });
    expect((result as { canonicalRootPath: string }).canonicalRootPath).not.toBe(linkToPlain);
  });

  it('SUBDIR de git repo: canonical root vira o git toplevel (git real)', () => {
    const result = validateRepoRootPath(gitSubDir);
    expect(result).toMatchObject({
      canonicalRootPath: fs.realpathSync(gitRepoDir),
    });
    expect((result as { gitRoot: string | null }).gitRoot).toBe(fs.realpathSync(gitRepoDir));
  });

  it('raiz do git repo: canonical = o proprio toplevel', () => {
    const result = validateRepoRootPath(gitRepoDir);
    expect(result).toMatchObject({
      canonicalRootPath: fs.realpathSync(gitRepoDir),
      name: path.basename(fs.realpathSync(gitRepoDir)),
    });
  });
});


describe('validateRepoRootAgainstCanonical (13.2 — igualdade, nao prefixo)', () => {
  it('aceita o proprio canonical', () => {
    const canonical = fs.realpathSync(plainDir);
    const result = validateRepoRootAgainstCanonical(plainDir, canonical);
    expect(result).toEqual({ canonicalRootPath: canonical });
  });

  it('aceita symlink que RESOLVE para o canonical (realpath nos dois lados)', () => {
    const canonical = fs.realpathSync(plainDir);
    const result = validateRepoRootAgainstCanonical(linkToPlain, canonical);
    expect(result).toEqual({ canonicalRootPath: canonical });
  });

  it('rejeita ../ no input cru', () => {
    const canonical = fs.realpathSync(plainDir);
    const result = validateRepoRootAgainstCanonical(`${plainDir}/../plain`, canonical);
    expect(result).toHaveProperty('error');
  });

  it('rejeita SUBDIR do canonical (igualdade estrita, nunca prefixo solto)', () => {
    const canonical = fs.realpathSync(gitRepoDir);
    const result = validateRepoRootAgainstCanonical(gitSubDir, canonical);
    expect(result).toHaveProperty('error');
  });

  it('rejeita symlink que ESCAPA para fora do canonical', () => {
    const canonical = fs.realpathSync(plainDir);
    const result = validateRepoRootAgainstCanonical(linkEscaping, canonical);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/nao corresponde/);
  });

  it('rejeita pasta inexistente e canonical inexistente', () => {
    const canonical = fs.realpathSync(plainDir);
    expect(
      validateRepoRootAgainstCanonical(path.join(baseDir, 'nada'), canonical),
    ).toHaveProperty('error');
    expect(
      validateRepoRootAgainstCanonical(plainDir, path.join(baseDir, 'nada')),
    ).toHaveProperty('error');
  });
});
