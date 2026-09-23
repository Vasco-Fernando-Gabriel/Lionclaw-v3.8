import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { DETACH_FOR_TREE_KILL, killProcessTree } from './kill-process-tree';
import { getLionClawHome } from './paths';
import { deleteSecret, getSecret, getSecretNonInteractiveOrThrow, setSecret } from './secrets-vault';
import {
  ensureRemoteMcpWrapperSync,
  resolveRemoteMcpBridgeRuntime,
  resolveRemoteMcpWrapperPath,
  type RemoteMcpDescriptor,
} from './remote-mcp-wrapper';

const logger = createLogger('higgsfield-auth');

export const HIGGSFIELD_MCP_URL = 'https://mcp.higgsfield.ai/mcp';
export const HIGGSFIELD_SESSION_SECRET_KEY = 'HIGGSFIELD_MCP_SESSION';
const LEGACY_HIGGSFIELD_CREDENTIALS_KEY = 'HIGGSFIELD_CREDENTIALS';

const SNAPSHOT_VERSION = 1;
const MAX_SESSION_FILE_BYTES = 1024 * 1024;
const MAX_SESSION_TOTAL_BYTES = 4 * 1024 * 1024;
const AUTH_CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

interface SessionFileSnapshot {
  path: string;
  contentBase64: string;
}

interface HiggsfieldSessionSnapshot {
  version: typeof SNAPSHOT_VERSION;
  capturedAt: string;
  files: SessionFileSnapshot[];
}

export interface HiggsfieldAuthStatus {
  configured: boolean;
  localSession: boolean;
  authDir: string;
  wrapperPath: string;
  lastCapturedAt?: string;
}

export type HiggsfieldConnectResult =
  | {
      ok: true;
      status: HiggsfieldAuthStatus;
    }
  | {
      ok: false;
      error: string;
      status: HiggsfieldAuthStatus;
    };

function getHiggsfieldRuntimeRoot(): string {
  return path.join(getLionClawHome(), 'runtime', 'higgsfield');
}

export function getHiggsfieldAuthDir(): string {
  return path.join(getHiggsfieldRuntimeRoot(), 'mcp-auth');
}

export function getHiggsfieldRemoteMcpDescriptor(): RemoteMcpDescriptor {
  return {
    providerId: 'higgsfield',
    mcpUrl: HIGGSFIELD_MCP_URL,
    runtimeSubdir: 'higgsfield',
    wrapperFileName: 'higgsfield-mcp-wrapper.js',
    auth: { mode: 'session-dir', configDir: getHiggsfieldAuthDir() },
  };
}

export function getHiggsfieldMcpWrapperPath(): string {
  return resolveRemoteMcpWrapperPath(getHiggsfieldRemoteMcpDescriptor());
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  if (process.platform !== 'win32') {
    try {
      await fs.promises.chmod(dir, 0o700);
    } catch {}
  }
}

async function hasTokenFile(dir: string): Promise<boolean> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && (await hasTokenFile(full))) return true;
      if (entry.isFile() && entry.name.endsWith('_tokens.json')) return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function listSessionFiles(root: string, current = root): Promise<string[]> {
  const entries = await fs.promises.readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSessionFiles(root, full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function toSnapshotPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function resolveSnapshotPath(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('Snapshot de sessao Higgsfield invalido.');
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => part === '..' || part === '' || part.includes('\\'))) {
    throw new Error('Snapshot de sessao Higgsfield contem caminho invalido.');
  }
  const target = path.join(root, ...parts);
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error('Snapshot de sessao Higgsfield escapa do diretorio de auth.');
  }
  return normalizedTarget;
}

async function readSnapshotFromAuthDir(authDir: string): Promise<HiggsfieldSessionSnapshot | null> {
  if (!(await hasTokenFile(authDir))) return null;

  const files = await listSessionFiles(authDir);
  let totalBytes = 0;
  const snapshotFiles: SessionFileSnapshot[] = [];

  for (const file of files) {
    const stat = await fs.promises.stat(file);
    if (stat.size > MAX_SESSION_FILE_BYTES) {
      logger.warn({ file, size: stat.size }, 'Skipping oversized Higgsfield auth file');
      continue;
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_SESSION_TOTAL_BYTES) {
      throw new Error('Sessao Higgsfield excede o tamanho maximo permitido para o Vault.');
    }
    const content = await fs.promises.readFile(file);
    snapshotFiles.push({
      path: toSnapshotPath(authDir, file),
      contentBase64: content.toString('base64'),
    });
  }

  if (snapshotFiles.length === 0) return null;
  return {
    version: SNAPSHOT_VERSION,
    capturedAt: new Date().toISOString(),
    files: snapshotFiles,
  };
}

async function writeSnapshotToAuthDir(snapshot: HiggsfieldSessionSnapshot, authDir: string): Promise<void> {
  if (snapshot.version !== SNAPSHOT_VERSION || !Array.isArray(snapshot.files)) {
    throw new Error('Snapshot de sessao Higgsfield nao suportado.');
  }

  await fs.promises.rm(authDir, { recursive: true, force: true });
  await ensurePrivateDir(authDir);

  for (const file of snapshot.files) {
    const target = resolveSnapshotPath(authDir, file.path);
    await ensurePrivateDir(path.dirname(target));
    const content = Buffer.from(file.contentBase64, 'base64');
    await fs.promises.writeFile(target, content, { mode: 0o600 });
    if (process.platform !== 'win32') {
      try {
        await fs.promises.chmod(target, 0o600);
      } catch {}
    }
  }
}

async function readSnapshotFromVault(nonInteractive = false): Promise<HiggsfieldSessionSnapshot | null> {
  const raw = nonInteractive
    ? await getSecretNonInteractiveOrThrow(HIGGSFIELD_SESSION_SECRET_KEY)
    : await getSecret(HIGGSFIELD_SESSION_SECRET_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HiggsfieldSessionSnapshot;
  } catch (error) {
    logger.warn({ error }, 'Invalid Higgsfield session snapshot in Vault');
    return null;
  }
}

let localSessionSeen = false;

export function _resetHiggsfieldSessionStateForTests(): void {
  localSessionSeen = false;
}

export async function restoreHiggsfieldSessionFromVault(
  options: { nonInteractive?: boolean; force?: boolean } = {},
): Promise<boolean> {
  const authDir = getHiggsfieldAuthDir();
  if (options.force !== true && (await hasTokenFile(authDir))) {
    localSessionSeen = true;
    logger.info('Higgsfield MCP session ja presente no disco; restore do Vault ignorado');
    void captureHiggsfieldSessionToVault().catch(() => undefined);
    return false;
  }
  const snapshot = await readSnapshotFromVault(options.nonInteractive === true);
  if (!snapshot) return false;
  await writeSnapshotToAuthDir(snapshot, authDir);
  localSessionSeen = true;
  logger.info('Higgsfield MCP session restored from Vault');
  return true;
}

export async function reconcileHiggsfieldSession(): Promise<'saved' | 'invalidated' | 'noop'> {
  const authDir = getHiggsfieldAuthDir();
  if (await hasTokenFile(authDir)) {
    return (await captureHiggsfieldSessionToVault()) ? 'saved' : 'noop';
  }
  if (!localSessionSeen) return 'noop';
  localSessionSeen = false;
  await deleteSecret(HIGGSFIELD_SESSION_SECRET_KEY);
  logger.warn(
    'Higgsfield MCP session invalidada pelo servidor; snapshot do Vault removido. Conecte de novo em Vault > Higgsfield',
  );
  return 'invalidated';
}

let sessionWatcher: fs.FSWatcher | null = null;
let sessionWatchTimer: NodeJS.Timeout | null = null;

export function watchHiggsfieldSession(): void {
  if (sessionWatcher) return;
  const authDir = getHiggsfieldAuthDir();
  try {
    fs.mkdirSync(authDir, { recursive: true });
    const watcher = fs.watch(authDir, { recursive: true }, (_event, filename) => {
      if (filename && !String(filename).includes('_tokens.json')) return;
      if (sessionWatchTimer) clearTimeout(sessionWatchTimer);
      sessionWatchTimer = setTimeout(() => {
        void reconcileHiggsfieldSession().catch((error) => {
          logger.warn({ error }, 'Falha ao salvar a sessao Higgsfield no Vault');
        });
      }, 2000);
    });
    watcher.on('error', () => {
      stopWatchingHiggsfieldSession();
    });
    sessionWatcher = watcher;
  } catch (error) {
    logger.warn({ error }, 'Nao foi possivel observar a sessao Higgsfield');
  }
}

export function stopWatchingHiggsfieldSession(): void {
  if (sessionWatchTimer) {
    clearTimeout(sessionWatchTimer);
    sessionWatchTimer = null;
  }
  if (sessionWatcher) {
    sessionWatcher.close();
    sessionWatcher = null;
  }
}

export async function captureHiggsfieldSessionToVault(): Promise<boolean> {
  const authDir = getHiggsfieldAuthDir();
  const snapshot = await readSnapshotFromAuthDir(authDir);
  if (!snapshot) return false;
  await setSecret(HIGGSFIELD_SESSION_SECRET_KEY, JSON.stringify(snapshot));
  localSessionSeen = true;
  logger.info({ files: snapshot.files.length }, 'Higgsfield MCP session saved to Vault');
  return true;
}

export async function deleteHiggsfieldSession(): Promise<void> {
  await deleteSecret(HIGGSFIELD_SESSION_SECRET_KEY);
  await deleteSecret(LEGACY_HIGGSFIELD_CREDENTIALS_KEY);
  await fs.promises.rm(getHiggsfieldAuthDir(), { recursive: true, force: true });
  logger.info('Higgsfield MCP session removed');
}

export async function getHiggsfieldAuthStatus(): Promise<HiggsfieldAuthStatus> {
  const snapshot = await readSnapshotFromVault();
  return {
    configured: snapshot !== null,
    localSession: await hasTokenFile(getHiggsfieldAuthDir()),
    authDir: getHiggsfieldAuthDir(),
    wrapperPath: getHiggsfieldMcpWrapperPath(),
    lastCapturedAt: snapshot?.capturedAt,
  };
}

export function ensureHiggsfieldMcpWrapperSync(): string {
  return ensureRemoteMcpWrapperSync(getHiggsfieldRemoteMcpDescriptor());
}

function truncateOutput(text: string): string {
  return text.length > 1200 ? `${text.slice(-1200)}` : text;
}

const ADDR_IN_USE_RE = /EADDRINUSE[\s\S]{0,80}?(?:127\.0\.0\.1|localhost|0\.0\.0\.0):(\d{2,5})/i;

function describeAuthFailure(output: string | undefined): string {
  if (!output) return 'Nao foi possivel autenticar Higgsfield.';
  const addrInUse = output.match(ADDR_IN_USE_RE);
  if (addrInUse) {
    return `A porta de callback do OAuth (${addrInUse[1]}) ja esta em uso por uma sessao Higgsfield anterior travada. Feche outras tentativas de conexao (ou reinicie o LionClaw) e tente novamente.`;
  }
  return output;
}

export async function connectHiggsfield(options?: { force?: boolean }): Promise<HiggsfieldConnectResult> {
  const force = options?.force === true;
  const authDir = getHiggsfieldAuthDir();
  ensureHiggsfieldMcpWrapperSync();

  if (force) {
    await fs.promises.rm(authDir, { recursive: true, force: true });
  } else {
    await restoreHiggsfieldSessionFromVault({ force: true });
  }
  await ensurePrivateDir(authDir);

  const bridge = resolveRemoteMcpBridgeRuntime();
  const command = bridge.command;
  const args = [bridge.clientEntryPath, HIGGSFIELD_MCP_URL];
  const env = {
    ...bridge.env,
    MCP_REMOTE_CONFIG_DIR: authDir,
    NO_COLOR: '1',
  };

  const result = await new Promise<{ code: number | null; error?: string }>((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: DETACH_FOR_TREE_KILL,
    });
    let stderr = '';
    let stdout = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child);
      resolve({ code: null, error: 'Tempo limite ao autenticar Higgsfield. Tente conectar novamente.' });
    }, AUTH_CONNECT_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = truncateOutput(stdout + chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = truncateOutput(stderr + chunk.toString());
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, error: error.message });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
      resolve({ code, error: code === 0 ? undefined : output || `Processo saiu com codigo ${code}` });
    });
  });

  if (result.code !== 0) {
    logger.warn({ error: result.error }, 'Higgsfield auth command failed');
    return {
      ok: false,
      error: describeAuthFailure(result.error),
      status: await getHiggsfieldAuthStatus(),
    };
  }

  const saved = await captureHiggsfieldSessionToVault();
  stopWatchingHiggsfieldSession();
  watchHiggsfieldSession();
  if (!saved) {
    return {
      ok: false,
      error: 'Login finalizou, mas nenhum token Higgsfield foi encontrado para salvar no Vault.',
      status: await getHiggsfieldAuthStatus(),
    };
  }

  return {
    ok: true,
    status: await getHiggsfieldAuthStatus(),
  };
}
