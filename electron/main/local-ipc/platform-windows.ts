
import net from 'net';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getLionClawHome } from '../paths';

export interface WindowsListenResult {
  server: net.Server;
  address: string;
  transport: 'pipe';
}

export function getRuntimeDir(): string {
  return path.join(getLionClawHome(), 'runtime');
}

export async function ensureRuntimeDir(): Promise<string> {
  const dir = getRuntimeDir();
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

export function buildPipePath(): string {
  return `\\\\.\\pipe\\lionclaw-main-${crypto.randomUUID()}`;
}

export async function listenWindows(
  connectionHandler: (socket: net.Socket) => void,
): Promise<WindowsListenResult> {
  await ensureRuntimeDir();
  const pipePath = buildPipePath();

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
    server.listen(pipePath);
  });

  return { server, address: pipePath, transport: 'pipe' };
}

export async function cleanupWindows(_pipePath: string): Promise<void> {
}
