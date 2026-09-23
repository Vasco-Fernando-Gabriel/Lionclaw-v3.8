import fs from 'fs';
import path from 'path';

export interface PathGuardFs {
  realpathSync(p: string): string;
  existsSync(p: string): boolean;
}

const defaultFs: PathGuardFs = {
  realpathSync: (p: string) => fs.realpathSync.native(p),
  existsSync: (p: string) => fs.existsSync(p),
};

export type PathGuardDenyReason = 'outside-root' | 'symlink-escape' | 'protected-path' | 'not-in-write-set';

export interface PathGuardAllow {
  ok: true;
  canonicalPath: string;
  relativePath: string;
}

export interface PathGuardDeny {
  ok: false;
  reason: PathGuardDenyReason;
  message: string;
  canonicalPath?: string;
}

export type PathGuardResult = PathGuardAllow | PathGuardDeny;

export interface PathGuardConfig {
  workspaceRoot: string;
  protectedPaths?: string[];
  writeSet?: string[];
  fsImpl?: PathGuardFs;
}

function canonicalizeMaybeMissing(target: string, fsImpl: PathGuardFs): string {
  const resolved = path.resolve(target);
  const segments: string[] = [];
  let current = resolved;
  while (!fsImpl.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return resolved;
    }
    segments.unshift(path.basename(current));
    current = parent;
  }
  const realBase = fsImpl.realpathSync(current);
  return segments.length > 0 ? path.join(realBase, ...segments) : realBase;
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        re += '.*';
        i++;
        if (normalized[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp('^' + re + '$');
}

function toPosixRelative(root: string, canonical: string): string {
  const rel = path.relative(root, canonical);
  return rel.split(path.sep).join('/');
}

export class WorkflowPathGuard {
  private readonly root: string;
  private readonly protectedRegexes: RegExp[];
  private readonly writeSetRegexes: RegExp[] | null;
  private readonly fsImpl: PathGuardFs;
  private readonly detectedWrites = new Set<string>();

  constructor(config: PathGuardConfig) {
    this.fsImpl = config.fsImpl ?? defaultFs;
    this.root = canonicalizeMaybeMissing(config.workspaceRoot, this.fsImpl);
    this.protectedRegexes = (config.protectedPaths ?? []).map(globToRegExp);
    this.writeSetRegexes = config.writeSet && config.writeSet.length > 0 ? config.writeSet.map(globToRegExp) : null;
  }

  get canonicalRoot(): string {
    return this.root;
  }

  check(target: string): PathGuardResult {
    const canonical = canonicalizeMaybeMissing(target, this.fsImpl);
    const containment = this.assertContained(canonical);
    if (!containment.ok) return containment;
    return {
      ok: true,
      canonicalPath: canonical,
      relativePath: toPosixRelative(this.root, canonical),
    };
  }

  checkWrite(target: string): PathGuardResult {
    const canonical = canonicalizeMaybeMissing(target, this.fsImpl);
    const containment = this.assertContained(canonical);
    if (!containment.ok) return containment;

    const relative = toPosixRelative(this.root, canonical);

    if (this.protectedRegexes.some((re) => re.test(relative))) {
      return {
        ok: false,
        reason: 'protected-path',
        message: `escrita negada: ${relative} esta em path protegido`,
        canonicalPath: canonical,
      };
    }

    if (this.writeSetRegexes && !this.writeSetRegexes.some((re) => re.test(relative))) {
    }

    this.detectedWrites.add(relative);
    return { ok: true, canonicalPath: canonical, relativePath: relative };
  }

  getDetectedWrites(): string[] {
    return [...this.detectedWrites].sort();
  }

  validateTouchedFiles(touched: string[]): string[] {
    if (!this.writeSetRegexes) return [];
    return touched
      .map((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''))
      .filter((rel) => !this.writeSetRegexes!.some((re) => re.test(rel)));
  }

  private assertContained(canonical: string): PathGuardResult {
    const relative = path.relative(this.root, canonical);
    const escapes = relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
    if (escapes) {
      return {
        ok: false,
        reason: canonical === this.root ? 'outside-root' : 'symlink-escape',
        message: `path fora da raiz do workspace: ${canonical}`,
        canonicalPath: canonical,
      };
    }
    return {
      ok: true,
      canonicalPath: canonical,
      relativePath: toPosixRelative(this.root, canonical),
    };
  }
}
