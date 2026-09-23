import net from 'net';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getLionClawHome } from '../paths';

export interface UnixListenResult {
  server: net.Server;
  address: string;
  transport: 'unix';
}

export function getRuntimeDir(): string {
  return path.join(getLionClawHome(), 'runtime');
}

export async function ensureRuntimeDir(): Promise<string> {
  const dir = getRuntimeDir();
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    await fs.promises.chmod(dir, 0o700);
  } catch {}
  return dir;
}

export function resolveSocketRuntimeDir(runtimeDir: string, platform: NodeJS.Platform = process.platform): string {
  const maxBytes = platform === 'darwin' ? 103 : 107;
  const targetPath = platform === 'win32' ? path.win32 : path.posix;
  const sample = targetPath.join(runtimeDir, 'main-0000000000000000.sock');
  if (Buffer.byteLength(sample) <= maxBytes) return runtimeDir;
  const identity = crypto.createHash('sha256').update(targetPath.resolve(runtimeDir)).digest('hex').slice(0, 16);
  return targetPath.join('/tmp', `lc-ipc-${identity}`);
}

export async function listenUnix(connectionHandler: (socket: net.Socket) => void): Promise<UnixListenResult> {
  const homeRuntimeDir = await ensureRuntimeDir();
  const runtimeDir = resolveSocketRuntimeDir(homeRuntimeDir);
  if (runtimeDir !== homeRuntimeDir) {
    await fs.promises.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(runtimeDir, 0o700);
  }
  const suffix = crypto.randomBytes(8).toString('hex');
  const socketPath = path.join(runtimeDir, `main-${suffix}.sock`);

  try {
    await fs.promises.unlink(socketPath);
  } catch {}

  const server = net.createServer(connectionHandler);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });

  await fs.promises.chmod(socketPath, 0o600);

  return { server, address: socketPath, transport: 'unix' };
}

export async function cleanupUnix(socketPath: string): Promise<void> {
  try {
    await fs.promises.unlink(socketPath);
  } catch {}
  if (path.basename(path.dirname(socketPath)).startsWith('lc-ipc-')) {
    try {
      await fs.promises.rmdir(path.dirname(socketPath));
    } catch {}
  }
}
