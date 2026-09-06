
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createLogger } from '../logger';
import type { RepoStalenessInput, RepoStalenessResult } from './types';

const logger = createLogger('repo-graph-staleness');

export const STALE_CHECK_MAX_DIRTY = 200;

export const STALE_CHECK_THROTTLE_MS = 5 * 60_000;

export interface StalenessDeps {
  execGit: (args: string[], cwd: string) => string;
  statMtimeMs: (absolutePath: string) => number;
  now: () => number;
}

const defaultDeps: StalenessDeps = {
  execGit: (args, cwd) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true }),
  statMtimeMs: (absolutePath) => fs.statSync(absolutePath).mtimeMs,
  now: () => Date.now(),
};

interface ThrottleEntry {
  at: number;
  result: RepoStalenessResult;
}

const throttleCache = new Map<string, ThrottleEntry>();

export function __clearStalenessThrottleForTests(): void {
  throttleCache.clear();
}

export function clearStalenessForRepo(repositoryId: string): void {
  throttleCache.delete(repositoryId);
}

export function parsePorcelainLine(line: string): string | null {
  if (line.length < 4) return null;
  let p = line.slice(3);
  const arrow = p.indexOf(' -> ');
  if (arrow !== -1) p = p.slice(arrow + 4);
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return p || null;
}

export function checkRepoStaleness(
  input: RepoStalenessInput,
  deps: StalenessDeps = defaultDeps,
): RepoStalenessResult {
  const cached = throttleCache.get(input.repositoryId);
  if (cached && deps.now() - cached.at < STALE_CHECK_THROTTLE_MS) {
    return cached.result;
  }
  const result = computeStaleness(input, deps);
  throttleCache.set(input.repositoryId, { at: deps.now(), result });
  return result;
}

function computeStaleness(
  input: RepoStalenessInput,
  deps: StalenessDeps,
): RepoStalenessResult {
  if (!input.lastIndexedAt) {
    return { stale: false, reason: 'sem-last-indexed-at' };
  }

  let head: string;
  try {
    head = deps.execGit(['rev-parse', 'HEAD'], input.canonicalRootPath).trim();
  } catch (err) {
    logger.warn(
      { err, root: input.canonicalRootPath },
      'staleness: git rev-parse falhou (repo sem git?); staleness nao-determinavel',
    );
    return { stale: false, reason: 'git-indisponivel' };
  }
  if (input.indexedCommit && head !== input.indexedCommit) {
    return { stale: true, reason: `HEAD ${head.slice(0, 8)} != indexed ${input.indexedCommit.slice(0, 8)}` };
  }

  let porcelain: string;
  try {
    porcelain = deps.execGit(['status', '--porcelain'], input.canonicalRootPath);
  } catch (err) {
    logger.warn({ err, root: input.canonicalRootPath }, 'staleness: git status falhou');
    return { stale: false, reason: 'git-indisponivel' };
  }

  const dirtyFiles = porcelain
    .split('\n')
    .map((line) => parsePorcelainLine(line))
    .filter((p): p is string => p !== null)
    .filter((p) => !p.startsWith('.codegraph') && !p.startsWith('.lionclaw'));

  if (dirtyFiles.length === 0) {
    return { stale: false };
  }
  if (dirtyFiles.length > STALE_CHECK_MAX_DIRTY) {
    return { stale: true, reason: `${dirtyFiles.length} arquivos dirty (> ${STALE_CHECK_MAX_DIRTY})` };
  }

  const indexedAtMs = Date.parse(input.lastIndexedAt);
  if (!Number.isFinite(indexedAtMs)) {
    return { stale: true, reason: 'last_indexed_at invalido' };
  }

  for (const rel of dirtyFiles) {
    const abs = path.join(input.canonicalRootPath, rel);
    let mtimeMs: number;
    try {
      mtimeMs = deps.statMtimeMs(abs);
    } catch {
      return { stale: true, reason: `arquivo dirty inacessivel: ${rel}` };
    }
    if (indexedAtMs < mtimeMs) {
      return { stale: true, reason: `editado apos o index: ${rel}` };
    }
  }

  return { stale: false };
}
