import { ChildProcess, spawn, spawnSync } from 'child_process';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { createLogger } from '../logger';
import { getOpenDesignConfig, setOpenDesignConfig, resolveRunDir } from './config';
import { resolveOpenDesignGlobalDataDir, resolveOpenDesignRoot } from './paths';
import { ensurePnpm, ensurePnpmShimDir, getCachedPnpm, spawnPnpm } from './pnpm-runner';
import { destroyODView } from './webview';
import { minimalInternalRuntimeEnv, resolveOpenDesignSidecar } from '../distribution-runtime';

const logger = createLogger('open-design-manager');

interface ProcessHandle {
  projectId: string;
  runId: string;
  daemonPort: number;
  webPort: number;
  daemonUrl: string;
  webUrl: string;
  process: ChildProcess;
  logStream: fs.WriteStream | null;
}

let active: ProcessHandle | null = null;

export function persistRuntimeCoordinates(projectId: string, daemonUrl: string, webUrl: string): void {
  setOpenDesignConfig(projectId, {
    daemonUrl,
    webUrl,
    dataDir: resolveOpenDesignGlobalDataDir(),
  });
}

const FORBIDDEN_PREFIXES = ['OD_', 'OPEN_DESIGN_', 'NEXT_'] as const;

export function buildSidecarBaseEnv(): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (FORBIDDEN_PREFIXES.some((p) => key.startsWith(p))) continue;
    filtered[key] = value;
  }
  return filtered;
}

function withPnpmShimPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  try {
    const binDir = ensurePnpmShimDir();
    const sep = process.platform === 'win32' ? ';' : ':';
    const currentPath = env.PATH ?? env.Path ?? process.env.PATH ?? '';
    return { ...env, PATH: `${binDir}${sep}${currentPath}` };
  } catch (err) {
    logger.warn({ err }, 'pnpm-runner: failed to set up shim — falling back to host PATH');
    return env;
  }
}

export function buildSidecarRuntimeEnv(): NodeJS.ProcessEnv {
  return withPnpmShimPath({
    ...buildSidecarBaseEnv(),
    OD_DATA_DIR: resolveOpenDesignGlobalDataDir(),
    OD_EMBED_HOST: 'lionclaw',
  });
}

function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        return reject(new Error('Failed to get port'));
      }
      const port = addr.port;
      server.close((err) => {
        if (err) return reject(err);
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForHealth(url: string, attempts = 10, delayMs = 500): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 400);
      const res = await fetch(`${url}/api/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function waitForWebReady(webUrl: string, attempts = 20, delayMs = 500): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 400);
      const res = await fetch(`${webUrl}/`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.status >= 200 && res.status < 400) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  if (process.platform === 'win32') {
    try {
      const args = signal === 'SIGKILL' ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T'];
      const res = spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
      return res.status === 0;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

async function cleanupOrphanDaemonWindows(): Promise<void> {
  const vendorRoot = resolveOpenDesignRoot();
  const stampsDir = path.join(vendorRoot, '.tmp', 'tools-dev', 'default');
  if (!fs.existsSync(stampsDir)) return;

  const invocation = getCachedPnpm();
  if (!invocation) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const proc = spawnPnpm(['tools-dev', 'stop'], {
        cwd: vendorRoot,
        stdio: 'ignore',
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        logger.warn('cleanupOrphanDaemon (win32): tools-dev stop timed out, continuing');
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        done();
      }, 8000);
      proc.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      proc.once('error', (err) => {
        clearTimeout(timer);
        logger.warn({ err }, 'cleanupOrphanDaemon (win32): tools-dev stop failed, continuing');
        done();
      });
    } catch (err) {
      logger.warn({ err }, 'cleanupOrphanDaemon (win32): could not spawn tools-dev stop, continuing');
      done();
    }
  });
  logger.info({ vendorRoot }, 'cleanupOrphanDaemon (win32): tools-dev stop done (best-effort)');
}

async function cleanupOrphanDaemon(): Promise<void> {
  if (process.platform === 'win32') {
    await cleanupOrphanDaemonWindows();
    return;
  }

  const vendorRoot = resolveOpenDesignRoot();
  const stampsDir = path.join(vendorRoot, '.tmp', 'tools-dev', 'default');
  const ipcDir = '/tmp/open-design/ipc/default';

  const hasStamps = fs.existsSync(stampsDir);
  const hasIpc = fs.existsSync(ipcDir) && fs.readdirSync(ipcDir).length > 0;
  if (!hasStamps && !hasIpc) return;

  const { exec } = await import('child_process');
  const run = (cmd: string, timeoutMs: number): Promise<string> =>
    new Promise((resolve) => {
      exec(cmd, { timeout: timeoutMs }, (_err, stdout) => {
        resolve(typeof stdout === 'string' ? stdout : '');
      });
    });

  if (hasStamps) {
    try {
      const invocation = getCachedPnpm();
      if (invocation) {
        const argv = [invocation.bin, ...invocation.prefixArgs, 'tools-dev', 'stop']
          .map((s) => `'${s.replace(/'/g, `'\\''`)}'`)
          .join(' ');
        logger.info({ vendorRoot }, 'cleanupOrphanDaemon: running `tools-dev stop` (best-effort)');
        await run(`cd ${vendorRoot} && ${argv}`, 5000);
      }
    } catch (err) {
      logger.warn({ err }, 'cleanupOrphanDaemon: tools-dev stop failed (continuing with fallback)');
    }
  }

  const lsofOut = await run(`lsof -t /tmp/open-design 2>/dev/null || true`, 1500);
  const pids = Array.from(new Set(lsofOut.split(/\s+/).filter(Boolean)))
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);

  for (const pid of pids) {
    logger.warn({ pid }, 'cleanupOrphanDaemon: killing orphan process holding /tmp/open-design');
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }
  if (pids.length > 0) {
    await new Promise((r) => setTimeout(r, 500));
    for (const pid of pids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (hasIpc) {
    try {
      for (const entry of fs.readdirSync(ipcDir)) {
        try {
          fs.unlinkSync(path.join(ipcDir, entry));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (hasStamps) {
    try {
      for (const entry of fs.readdirSync(stampsDir)) {
        if (entry === 'logs') continue;
        const full = path.join(stampsDir, entry);
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  }

  logger.info({ killedPids: pids, stampsCleared: hasStamps, ipcCleared: hasIpc }, 'cleanupOrphanDaemon: done');
}

async function stopHandle(handle: ProcessHandle, reason: string): Promise<void> {
  logger.info({ projectId: handle.projectId, runId: handle.runId, reason }, 'Stopping LionDesign sidecar');
  handle.logStream?.end();

  return new Promise((resolve) => {
    const proc = handle.process;
    if (proc.exitCode !== null) {
      resolve();
      return;
    }

    const killTimer = setTimeout(() => {
      logger.warn({ projectId: handle.projectId, pid: proc.pid }, 'Sidecar did not exit on SIGTERM, sending SIGKILL');
      killProcessTree(proc.pid, 'SIGKILL');
      resolve();
    }, 3000);

    proc.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });

    killProcessTree(proc.pid, 'SIGTERM');
  });
}

type PackagedReady = { daemonUrl: string; webUrl: string };

function parsePackagedReady(line: string): PackagedReady | null {
  const prefix = 'LIONCLAW_OPEN_DESIGN_READY=';
  if (!line.startsWith(prefix)) return null;
  const parsed = JSON.parse(line.slice(prefix.length)) as Partial<PackagedReady>;
  for (const value of [parsed.daemonUrl, parsed.webUrl]) {
    if (typeof value !== 'string') throw new Error('LionDesign packaged readiness incompleta');
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
      throw new Error(`LionDesign packaged readiness insegura: ${value}`);
    }
  }
  return parsed as PackagedReady;
}

async function startPackagedRuntime(
  projectId: string,
  runId: string,
  runDir: string,
): Promise<{ ok: true; daemonUrl: string; webUrl: string } | { error: string }> {
  let runtime;
  try {
    runtime = resolveOpenDesignSidecar({ packaged: true, resourcesPath: process.resourcesPath });
  } catch (err) {
    return { error: `LionDesign standalone inválido: ${err instanceof Error ? err.message : String(err)}` };
  }
  const logsDir = path.join(runDir, 'open-design', 'runtime', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(logsDir, `sidecar-${Date.now()}.log`), { flags: 'a' });
  const env = minimalInternalRuntimeEnv(runtime.nodePath, {
    ...buildSidecarBaseEnv(),
    OD_DATA_DIR: resolveOpenDesignGlobalDataDir(),
    OD_EMBED_HOST: 'lionclaw',
    OD_PACKAGED_CONFIG_PATH: runtime.configPath,
    OD_NAMESPACE: 'lionclaw',
  });
  const proc = spawn(runtime.nodePath, [runtime.headlessPath], {
    cwd: runtime.root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  proc.stderr?.pipe(logStream);
  proc.stdout?.pipe(logStream);
  let buffered = '';
  const ready = await new Promise<PackagedReady>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error('timeout aguardando readiness packaged')), 60_000);
    const cleanup = (): void => clearTimeout(timeout);
    proc.once('error', (error) => {
      cleanup();
      rejectReady(error);
    });
    proc.once('exit', (code, signal) => {
      cleanup();
      rejectReady(new Error(`LionDesign packaged saiu antes da readiness: code=${code} signal=${signal ?? 'none'}`));
    });
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const parsed = parsePackagedReady(line);
          if (parsed) {
            cleanup();
            resolveReady(parsed);
          }
        } catch (error) {
          cleanup();
          rejectReady(error);
        }
      }
    });
  }).catch(async (error) => {
    killProcessTree(proc.pid, 'SIGKILL');
    logStream.end();
    throw error;
  });
  const daemonPort = Number(new URL(ready.daemonUrl).port);
  const webPort = Number(new URL(ready.webUrl).port);
  if (!(await waitForHealth(ready.daemonUrl, 10, 300)) || !(await waitForWebReady(ready.webUrl, 10, 300))) {
    killProcessTree(proc.pid, 'SIGKILL');
    logStream.end();
    return { error: 'LionDesign packaged anunciou readiness mas health/web falharam' };
  }
  const handle: ProcessHandle = {
    projectId,
    runId,
    daemonPort,
    webPort,
    daemonUrl: ready.daemonUrl,
    webUrl: ready.webUrl,
    process: proc,
    logStream,
  };
  active = handle;
  persistRuntimeCoordinates(projectId, ready.daemonUrl, ready.webUrl);
  proc.on('exit', () => {
    if (active?.process === proc) active = null;
    logStream.end();
  });
  return { ok: true, daemonUrl: ready.daemonUrl, webUrl: ready.webUrl };
}

export async function start(
  projectId: string,
): Promise<{ ok: true; daemonUrl: string; webUrl: string } | { error: string }> {
  const cfg = getOpenDesignConfig(projectId);
  if (!cfg) return { error: 'LionDesign config not found for project' };

  if (!app.isPackaged) {
    try {
      await ensurePnpm();
    } catch (err) {
      logger.error({ err, projectId }, 'open-design start: pnpm-runner cascade failed');
      return { error: `pnpm-runner indisponivel: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  const vendorRoot = app.isPackaged ? null : resolveOpenDesignRoot();

  const runDir = resolveRunDir(projectId);
  if (!runDir) return { error: 'runDir not set in project config' };

  const runId = cfg.runId;
  if (!runId) return { error: 'runId not set in project config' };

  if (active && active.projectId !== projectId) {
    logger.info(
      { stoppedProject: active.projectId, startingProject: projectId },
      'Dor conhecida: alternando entre projetos parou e reiniciou sidecar do projeto anterior',
    );
    await stopHandle(active, 'replaced by new project');
    active = null;
    try {
      destroyODView();
    } catch (err) {
      logger.warn({ err }, 'destroyODView failed while replacing sidecar project (non-fatal)');
    }
  } else if (active && active.projectId === projectId) {
    const alive = await waitForHealth(active.daemonUrl, 2, 200);
    if (alive) {
      logger.info({ projectId }, 'Sidecar already running and healthy, reusing');
      persistRuntimeCoordinates(projectId, active.daemonUrl, active.webUrl);
      return { ok: true, daemonUrl: active.daemonUrl, webUrl: active.webUrl };
    }
    await stopHandle(active, 'unhealthy, restarting');
    active = null;
    try {
      destroyODView();
    } catch (err) {
      logger.warn({ err }, 'destroyODView failed while restarting unhealthy sidecar (non-fatal)');
    }
  }

  if (app.isPackaged) {
    try {
      return await startPackagedRuntime(projectId, runId, runDir);
    } catch (err) {
      logger.error({ err, projectId }, 'LionDesign packaged start failed');
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  await cleanupOrphanDaemon();

  const daemonPort = await allocateFreePort();
  const webPort = await allocateFreePort();
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const logsDir = path.join(runDir, 'open-design', 'runtime', 'logs');

  fs.mkdirSync(logsDir, { recursive: true });

  const logPath = path.join(logsDir, `sidecar-${Date.now()}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const proc = spawnPnpm(
    ['tools-dev', 'run', 'web', '--daemon-port', String(daemonPort), '--web-port', String(webPort)],
    {
      cwd: vendorRoot!,
      env: buildSidecarRuntimeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  );

  proc.stdout?.pipe(logStream);
  proc.stderr?.pipe(logStream);

  proc.on('error', (err) => {
    logger.error({ projectId, err }, 'LionDesign sidecar process error');
  });

  proc.on('exit', (code, signal) => {
    logger.info({ projectId, code, signal }, 'LionDesign sidecar exited');
    if (active?.process === proc) active = null;
  });

  const handle: ProcessHandle = {
    projectId,
    runId,
    daemonPort,
    webPort,
    daemonUrl,
    webUrl,
    process: proc,
    logStream,
  };

  const daemonHealthy = await waitForHealth(daemonUrl, 60, 500);
  if (!daemonHealthy) {
    await stopHandle(handle, 'failed daemon health check after start');
    return { error: 'LionDesign daemon did not become healthy in time' };
  }

  const webHealthy = await waitForWebReady(webUrl, 60, 500);
  if (!webHealthy) {
    await stopHandle(handle, 'failed web readiness check after start');
    return { error: 'web UI timeout' };
  }

  active = handle;

  persistRuntimeCoordinates(projectId, daemonUrl, webUrl);

  logger.info({ projectId, daemonUrl, webUrl }, 'LionDesign sidecar started');
  return { ok: true, daemonUrl, webUrl };
}

export async function stop(projectId: string): Promise<{ ok: true } | { error: string }> {
  if (!active || active.projectId !== projectId) {
    return { error: 'No active sidecar for this project' };
  }
  await stopHandle(active, 'explicit stop');
  active = null;
  try {
    destroyODView();
  } catch (err) {
    logger.warn({ err }, 'destroyODView failed during stop (non-fatal)');
  }
  return { ok: true };
}

export async function restart(
  projectId: string,
): Promise<{ ok: true; daemonUrl: string; webUrl: string } | { error: string }> {
  if (active && active.projectId === projectId) {
    await stopHandle(active, 'restart');
    active = null;
    try {
      destroyODView();
    } catch (err) {
      logger.warn({ err }, 'destroyODView failed during restart (non-fatal)');
    }
  }
  return start(projectId);
}

export function status(projectId: string): {
  running: boolean;
  daemonUrl: string | null;
  webUrl: string | null;
  daemonPort: number | null;
  webPort: number | null;
} {
  if (!active || active.projectId !== projectId) {
    return { running: false, daemonUrl: null, webUrl: null, daemonPort: null, webPort: null };
  }
  return {
    running: true,
    daemonUrl: active.daemonUrl,
    webUrl: active.webUrl,
    daemonPort: active.daemonPort,
    webPort: active.webPort,
  };
}

export async function health(projectId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!active || active.projectId !== projectId) {
    return { ok: false, reason: 'No sidecar running for this project' };
  }
  const alive = await waitForHealth(active.daemonUrl, 2, 200);
  return alive ? { ok: true } : { ok: false, reason: 'Daemon not responding' };
}

export async function stopAll(): Promise<void> {
  if (!active) return;
  const handle = active;
  active = null;
  await stopHandle(handle, 'app quit');
}
