
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { ValidateRepoRootResult } from './types';

export interface ValidateRootDeps {
  gitToplevel: (cwd: string) => string;
}

const defaultDeps: ValidateRootDeps = {
  gitToplevel: (cwd) =>
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    }).trim(),
};

export function hasParentTraversal(raw: string): boolean {
  return raw.split(/[\\/]+/).some((segment) => segment === '..');
}

export function validateRepoRootPath(
  raw: string,
  deps: ValidateRootDeps = defaultDeps,
): ValidateRepoRootResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'caminho do repositorio vazio' };
  }
  const trimmed = raw.trim();
  if (!path.isAbsolute(trimmed)) {
    return { error: `caminho do repositorio deve ser absoluto (recebido "${trimmed}")` };
  }
  if (hasParentTraversal(trimmed)) {
    return { error: `caminho com "../" nao e permitido (recebido "${trimmed}")` };
  }

  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync(trimmed);
  } catch {
    return { error: `pasta nao encontrada: ${trimmed}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realCandidate);
  } catch {
    return { error: `pasta inacessivel: ${realCandidate}` };
  }
  if (!stat.isDirectory()) {
    return { error: `o caminho nao e uma pasta: ${realCandidate}` };
  }

  let gitRoot: string | null = null;
  try {
    const toplevel = deps.gitToplevel(realCandidate);
    if (toplevel) {
      gitRoot = fs.realpathSync(toplevel);
    }
  } catch {
    gitRoot = null;
  }

  const canonicalRootPath = gitRoot ?? realCandidate;
  return {
    canonicalRootPath,
    gitRoot,
    name: path.basename(canonicalRootPath),
  };
}

export function validateRepoRootAgainstCanonical(
  raw: string,
  canonicalRootPath: string,
): { canonicalRootPath: string } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'repoRoot vazio' };
  }
  const trimmed = raw.trim();
  if (!path.isAbsolute(trimmed)) {
    return { error: `repoRoot deve ser absoluto (recebido "${trimmed}")` };
  }
  if (hasParentTraversal(trimmed)) {
    return { error: `repoRoot com "../" nao e permitido (recebido "${trimmed}")` };
  }

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(trimmed);
  } catch {
    return { error: `repoRoot nao encontrado: ${trimmed}` };
  }

  let realCanonical: string;
  try {
    realCanonical = fs.realpathSync(canonicalRootPath);
  } catch {
    return { error: `repositorio ativo nao encontrado no disco: ${canonicalRootPath}` };
  }

  if (realTarget !== realCanonical) {
    return {
      error: `repoRoot "${trimmed}" nao corresponde ao repositorio ativo da sessao`,
    };
  }
  return { canonicalRootPath: realCanonical };
}


export interface SubagentRepoRootDeps {
  getSessionActiveRepository: (sessionId: string) => { repositoryId: string } | null;
  getLocalRepository: (repositoryId: string) => { canonicalRootPath: string } | null;
}

export async function resolveSubagentRepoRoot(
  input: { repoRoot: string; sessionId?: string },
  deps?: SubagentRepoRootDeps,
): Promise<{ cwd: string } | { error: string }> {
  if (typeof input.repoRoot !== 'string' || !input.repoRoot.trim()) {
    return { error: 'repoRoot vazio' };
  }
  if (typeof input.sessionId !== 'string' || !input.sessionId.trim()) {
    return { error: 'sessionId e obrigatorio quando repoRoot e informado' };
  }

  let resolvedDeps = deps;
  if (!resolvedDeps) {
    const db = await import('../db');
    resolvedDeps = {
      getSessionActiveRepository: (sessionId) => db.getSessionActiveRepository(sessionId),
      getLocalRepository: (repositoryId) => db.getLocalRepository(repositoryId),
    };
  }

  const attach = resolvedDeps.getSessionActiveRepository(input.sessionId);
  if (!attach) {
    return { error: `nenhum repositorio ativo na sessao ${input.sessionId}` };
  }
  const repo = resolvedDeps.getLocalRepository(attach.repositoryId);
  if (!repo) {
    return { error: 'repositorio ativo da sessao nao encontrado no registro' };
  }

  const validated = validateRepoRootAgainstCanonical(input.repoRoot, repo.canonicalRootPath);
  if ('error' in validated) return validated;
  return { cwd: validated.canonicalRootPath };
}
