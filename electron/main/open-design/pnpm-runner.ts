import { execFile, spawn, type SpawnOptions, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';
import { createLogger } from '../logger';

const logger = createLogger('open-design-pnpm-runner');

const PNPM_VERSION = '10.33.2';

export type PnpmInvocation =
  | { kind: 'pnpm'; bin: 'pnpm'; prefixArgs: readonly [] }
  | { kind: 'corepack'; bin: 'corepack'; prefixArgs: readonly [string] }
  | { kind: 'npx'; bin: 'npx'; prefixArgs: readonly [string, string] };

const CANDIDATES: readonly PnpmInvocation[] = [
  { kind: 'pnpm', bin: 'pnpm', prefixArgs: [] },
  { kind: 'corepack', bin: 'corepack', prefixArgs: [`pnpm@${PNPM_VERSION}`] },
  { kind: 'npx', bin: 'npx', prefixArgs: ['-y', `pnpm@${PNPM_VERSION}`] },
];

let cached: PnpmInvocation | null = null;
let inflight: Promise<PnpmInvocation> | null = null;

function resolveBinForPlatform(bin: string): { bin: string; useShell: boolean } {
  if (process.platform !== 'win32') return { bin, useShell: false };
  const pathStr = process.env.PATH ?? process.env.Path ?? '';
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';');
  for (const dir of pathStr.split(';')) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (fs.statSync(candidate).isFile()) {
          const lower = candidate.toLowerCase();
          const useShell = lower.endsWith('.cmd') || lower.endsWith('.bat');
          return { bin: candidate, useShell };
        }
      } catch {}
    }
  }
  return { bin, useShell: false };
}

function probe(candidate: PnpmInvocation): Promise<boolean> {
  return new Promise((resolve) => {
    const probeArgs = [...candidate.prefixArgs, '--version'];
    const { bin: resolvedBin, useShell } = resolveBinForPlatform(candidate.bin);
    execFile(resolvedBin, probeArgs, { timeout: 8000, shell: useShell }, (err, stdout) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(typeof stdout === 'string' && stdout.trim().length > 0);
    });
  });
}

export async function ensurePnpm(): Promise<PnpmInvocation> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    for (const candidate of CANDIDATES) {
      const ok = await probe(candidate);
      if (ok) {
        cached = candidate;
        logger.info({ runner: candidate.kind }, 'pnpm-runner: cascade resolved');
        return candidate;
      }
      logger.warn({ runner: candidate.kind }, 'pnpm-runner: candidate failed --version probe');
    }
    inflight = null;
    throw new Error(
      `pnpm-runner: cascade exhausted (pnpm, corepack pnpm@${PNPM_VERSION}, npx -y pnpm@${PNPM_VERSION} all failed)`,
    );
  })();

  try {
    const result = await inflight;
    inflight = null;
    return result;
  } catch (err) {
    inflight = null;
    throw err;
  }
}

export function spawnPnpm(args: readonly string[], opts: SpawnOptions): ChildProcess {
  if (!cached) {
    throw new Error('pnpm-runner: spawnPnpm called before ensurePnpm()');
  }
  const fullArgs = [...cached.prefixArgs, ...args];
  const { bin: resolvedBin, useShell } = resolveBinForPlatform(cached.bin);
  const mergedOpts: SpawnOptions = useShell ? { ...opts, shell: true } : opts;
  return spawn(resolvedBin, fullArgs, mergedOpts);
}

export function getCachedPnpm(): PnpmInvocation | null {
  return cached;
}

export function resetPnpmCache(): void {
  cached = null;
  inflight = null;
  cachedShimDir = null;
}

let cachedShimDir: string | null = null;

function safeUserDataPath(): string | null {
  try {
    return app.getPath('userData');
  } catch {
    return null;
  }
}

function findBinInPath(bin: string, excludeDir: string): string | null {
  const pathStr = process.env.PATH ?? process.env.Path ?? '';
  const isWindows = process.platform === 'win32';
  const sep = isWindows ? ';' : ':';
  const exts = isWindows ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()) : [''];
  const normalizedExclude = path.resolve(excludeDir);
  for (const dir of pathStr.split(sep)) {
    if (!dir) continue;
    let resolvedDir: string;
    try {
      resolvedDir = path.resolve(dir);
    } catch {
      continue;
    }
    if (resolvedDir === normalizedExclude) continue;
    for (const ext of exts) {
      const candidate = path.join(resolvedDir, bin + ext);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (!isWindows) {
          try {
            fs.accessSync(candidate, fs.constants.X_OK);
          } catch {
            continue;
          }
        }
        return candidate;
      } catch {}
    }
  }
  return null;
}

export function ensurePnpmShimDir(): string {
  if (cachedShimDir && fs.existsSync(cachedShimDir)) return cachedShimDir;
  if (!cached) {
    throw new Error('pnpm-runner: ensurePnpmShimDir called before ensurePnpm()');
  }

  const baseDir = safeUserDataPath() ?? path.join(os.tmpdir(), 'lionclaw-open-design-runtime');
  const binDir = path.join(baseDir, 'open-design', 'runtime', 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const isWindows = process.platform === 'win32';
  const shimName = isWindows ? 'pnpm.cmd' : 'pnpm';
  const shimPath = path.join(binDir, shimName);

  const quoted = (s: string): string => {
    if (isWindows) return `"${s}"`;
    return `'${s.replace(/'/g, `'\\''`)}'`;
  };

  let cmdParts: string;
  if (cached.kind === 'pnpm') {
    const realPnpm = findBinInPath('pnpm', binDir);
    if (!realPnpm) {
      throw new Error(
        'pnpm-runner: cached invocation is direct `pnpm` but no real pnpm found in PATH outside shim dir',
      );
    }
    cmdParts = quoted(realPnpm);
  } else {
    cmdParts = [cached.bin, ...cached.prefixArgs].map(quoted).join(' ');
  }

  const body = isWindows ? `@echo off\r\n${cmdParts} %*\r\n` : `#!/usr/bin/env sh\nexec ${cmdParts} "$@"\n`;

  fs.writeFileSync(shimPath, body, { mode: 0o755 });
  if (!isWindows) {
    try {
      fs.chmodSync(shimPath, 0o755);
    } catch {
      /* ignore */
    }
  }

  cachedShimDir = binDir;
  logger.info({ binDir, runner: cached.kind }, 'pnpm-runner: shim written');
  return binDir;
}
