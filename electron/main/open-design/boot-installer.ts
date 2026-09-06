import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { app, BrowserWindow } from 'electron';
import { createLogger } from '../logger';
import { ensurePnpm, spawnPnpm } from './pnpm-runner';
import { resolveOpenDesignRoot, resolveInstallSentinelPath } from './paths';
import { buildSidecarBaseEnv } from './manager';
import type {
  BootInstallStatus,
  BootInstallStreamEvent,
} from '../../../src/types/open-design';
import { resolveOpenDesignSidecar } from '../distribution-runtime';


const logger = createLogger('open-design-boot-installer');

const STREAM_CHANNEL = 'open-design:boot-install-stream';

let status: BootInstallStatus = { kind: 'idle' };
let inFlight: Promise<BootInstallStatus> | null = null;

function emit(event: BootInstallStreamEvent): void {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(STREAM_CHANNEL, event);
    } catch (err) {
      logger.warn({ err }, 'boot-installer: failed to emit stream event to a window');
    }
  }
}

export function getBootInstallStatus(): BootInstallStatus {
  return status;
}

type ReadinessCheck = { ready: true } | { ready: false; reason: string };

function readLockfileHash(): string | null {
  try {
    const lockfilePath = path.join(resolveOpenDesignRoot(), 'pnpm-lock.yaml');
    if (!fs.existsSync(lockfilePath)) return null;
    const buf = fs.readFileSync(lockfilePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch (err) {
    logger.warn({ err }, 'boot-installer: failed to hash pnpm-lock.yaml');
    return null;
  }
}

function checkReadiness(): ReadinessCheck {
  const sentinel = resolveInstallSentinelPath();
  if (!fs.existsSync(sentinel)) return { ready: false, reason: 'sentinel-missing' };

  const nodeModules = path.join(resolveOpenDesignRoot(), 'node_modules');
  if (!fs.existsSync(nodeModules)) return { ready: false, reason: 'node_modules-missing' };

  let payload: { nodeModuleVersion?: string; lockfileHash?: string };
  try {
    payload = JSON.parse(fs.readFileSync(sentinel, 'utf-8'));
  } catch {
    return { ready: false, reason: 'sentinel-unreadable' };
  }

  const currentAbi = process.versions.modules;
  if (payload.nodeModuleVersion !== currentAbi) {
    return {
      ready: false,
      reason: `abi-mismatch (sentinel=${payload.nodeModuleVersion ?? 'unknown'}, current=${currentAbi})`,
    };
  }

  const currentLockHash = readLockfileHash();
  if (currentLockHash !== null && payload.lockfileHash !== currentLockHash) {
    return {
      ready: false,
      reason: `lockfile-mismatch (sentinel=${(payload.lockfileHash ?? 'unknown').slice(0, 8)}, current=${currentLockHash.slice(0, 8)})`,
    };
  }

  return { ready: true };
}

function writeSentinelAtomic(): void {
  const sentinelPath = resolveInstallSentinelPath();
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });

  const payload = JSON.stringify(
    {
      ts: new Date().toISOString(),
      lockfileHash: readLockfileHash() ?? '',
      nodeModuleVersion: process.versions.modules,
    },
    null,
    2,
  );

  const tmpPath = `${sentinelPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, payload, 'utf-8');
  fs.renameSync(tmpPath, sentinelPath);
}

async function runInstall(): Promise<BootInstallStatus> {
  let runner: 'pnpm' | 'corepack' | 'npx';
  try {
    runner = (await ensurePnpm()).kind;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'boot-installer: pnpm-runner cascade failed');
    emit({ kind: 'error', message });
    status = { kind: 'failed', error: message, failedAt: new Date().toISOString() };
    return status;
  }

  status = { kind: 'installing', runner, startedAt: new Date().toISOString() };
  emit({ kind: 'start', runner });

  return new Promise<BootInstallStatus>((resolve) => {
    let finished = false;

    const proc = spawnPnpm(
      ['install', '--frozen-lockfile'],
      {
        cwd: resolveOpenDesignRoot(),
        env: buildSidecarBaseEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    proc.stdout?.setEncoding('utf-8');
    proc.stderr?.setEncoding('utf-8');

    proc.stdout?.on('data', (chunk: string) => {
      emit({ kind: 'stdout', chunk });
    });

    proc.stderr?.on('data', (chunk: string) => {
      emit({ kind: 'stderr', chunk });
    });

    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'boot-installer: spawn error');
      emit({ kind: 'error', message });
      status = { kind: 'failed', error: message, failedAt: new Date().toISOString() };
      resolve(status);
    });

    proc.on('exit', (code, signal) => {
      if (finished) return;
      finished = true;
      emit({ kind: 'exit', code, signal });
      if (code === 0) {
        try {
          writeSentinelAtomic();
          status = { kind: 'ready', finishedAt: new Date().toISOString() };
          logger.info('boot-installer: install completed successfully');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err }, 'boot-installer: failed to write sentinel after successful install');
          status = { kind: 'failed', error: message, failedAt: new Date().toISOString() };
        }
      } else {
        const error = `pnpm install exited with code ${code} signal ${signal ?? 'null'}`;
        logger.error({ code, signal }, 'boot-installer: install failed');
        status = { kind: 'failed', error, failedAt: new Date().toISOString() };
      }
      resolve(status);
    });
  });
}

export async function ensureVendorReady(): Promise<BootInstallStatus> {
  if (app.isPackaged) {
    try {
      resolveOpenDesignSidecar({ packaged: true, resourcesPath: process.resourcesPath });
      status = { kind: 'ready', finishedAt: new Date().toISOString() };
    } catch (err) {
      const message = `LionDesign standalone empacotado inválido: ${err instanceof Error ? err.message : String(err)}`;
      status = { kind: 'failed', error: message, failedAt: new Date().toISOString() };
      emit({ kind: 'error', message });
    }
    return status;
  }
  if (inFlight) return inFlight;

  const readiness = checkReadiness();
  if (readiness.ready) {
    status = { kind: 'ready', finishedAt: new Date().toISOString() };
    return status;
  }

  logger.info({ reason: readiness.reason }, 'boot-installer: vendor not ready, reinstalling');

  const nodeModules = path.join(resolveOpenDesignRoot(), 'node_modules');
  if (fs.existsSync(nodeModules)) {
    logger.info({ nodeModules }, 'boot-installer: clearing stale node_modules before reinstall');
    try {
      fs.rmSync(nodeModules, { recursive: true, force: true });
    } catch (err) {
      logger.error({ err, nodeModules }, 'boot-installer: failed to clear node_modules (proceeding anyway)');
    }
  }

  try {
    const sentinel = resolveInstallSentinelPath();
    if (fs.existsSync(sentinel)) fs.unlinkSync(sentinel);
  } catch (err) {
    logger.warn({ err }, 'boot-installer: failed to remove stale sentinel (continuing)');
  }

  inFlight = runInstall().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export async function retryBootInstall(): Promise<BootInstallStatus> {
  if (status.kind === 'installing') return status;
  status = { kind: 'idle' };
  return ensureVendorReady();
}

export function __resetBootInstallerForTests(): void {
  status = { kind: 'idle' };
  inFlight = null;
}
