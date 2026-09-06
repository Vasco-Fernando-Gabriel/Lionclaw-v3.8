import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { resolveOpenDesignSidecar } from '../distribution-runtime';


let cachedRoot: string | null = null;
let cachedDataDir: string | null = null;

export function resolveOpenDesignRoot(): string {
  if (cachedRoot) return cachedRoot;
  if (app.isPackaged) {
    cachedRoot = resolveOpenDesignSidecar({ packaged: true, resourcesPath: process.resourcesPath }).root;
    return cachedRoot;
  }
  cachedRoot = path.join(app.getAppPath(), 'vendor', 'open-design');
  return cachedRoot;
}

export function resolveOpenDesignGlobalDataDir(): string {
  if (cachedDataDir) return cachedDataDir;
  cachedDataDir = path.join(app.getPath('userData'), 'open-design', 'runtime', '.od');
  fs.mkdirSync(cachedDataDir, { recursive: true });
  return cachedDataDir;
}

export function resolveInstallSentinelPath(): string {
  return path.join(app.getPath('userData'), 'open-design', 'runtime', '.install', 'lionclaw-install-ok');
}

export function resetPathsCache(): void {
  cachedRoot = null;
  cachedDataDir = null;
}
