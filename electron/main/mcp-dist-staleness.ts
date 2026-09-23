import fs from 'fs';
import path from 'path';

export const MCP_DIST_REBUILD_COMMAND = 'npm run build:mcps';

export const MCP_DIST_STALE_HINT = `helper MCP com dist desatualizado; rode ${MCP_DIST_REBUILD_COMMAND}`;

export interface McpDistFs {
  stat: (target: string) => { isDirectory: () => boolean; mtimeMs: number } | null;
  readdir: (dir: string) => string[];
}

export interface McpDistLocation {
  serversRoot: string;
  serverId: string;
  entryPath: string;
}

export interface McpDistStalenessResult {
  serverId: string;
  stale: boolean;
  distMtimeMs: number;
  sourceMtimeMs: number;
}

const defaultFs: McpDistFs = {
  stat: (target) => {
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    return stat ? { isDirectory: () => stat.isDirectory(), mtimeMs: stat.mtimeMs } : null;
  },
  readdir: (dir) => fs.readdirSync(dir),
};

const DIST_LOCATION_RE = /^(.*[\\/]mcp-servers)[\\/]([a-z0-9][a-z0-9-]*)[\\/]dist[\\/]/;

export function locateMcpDistEntry(entryPath: string): McpDistLocation | null {
  const match = DIST_LOCATION_RE.exec(entryPath);
  if (!match) return null;
  return { serversRoot: match[1], serverId: match[2], entryPath };
}

export function newestMtimeMs(root: string, fsImpl: McpDistFs = defaultFs): number {
  let newest = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const stat = fsImpl.stat(current);
    if (!stat) continue;
    if (stat.isDirectory()) {
      for (const entry of fsImpl.readdir(current)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        pending.push(path.join(current, entry));
      }
    } else if (stat.mtimeMs > newest) {
      newest = stat.mtimeMs;
    }
  }
  return newest;
}

export function checkMcpDistStaleness(
  location: McpDistLocation,
  fsImpl: McpDistFs = defaultFs,
): McpDistStalenessResult | null {
  const serverDir = path.join(location.serversRoot, location.serverId);
  const srcDir = path.join(serverDir, 'src');
  const srcStat = fsImpl.stat(srcDir);
  if (!srcStat || !srcStat.isDirectory()) return null;
  const distStat = fsImpl.stat(location.entryPath);
  if (!distStat || distStat.isDirectory()) return null;
  const sourceMtimeMs = Math.max(
    newestMtimeMs(srcDir, fsImpl),
    fsImpl.stat(path.join(serverDir, 'package.json'))?.mtimeMs ?? 0,
    newestMtimeMs(path.join(location.serversRoot, '_shared'), fsImpl),
  );
  return {
    serverId: location.serverId,
    stale: distStat.mtimeMs <= sourceMtimeMs,
    distMtimeMs: distStat.mtimeMs,
    sourceMtimeMs,
  };
}

export function checkMcpDistEntryStaleness(
  entryPath: string,
  fsImpl: McpDistFs = defaultFs,
): McpDistStalenessResult | null {
  const location = locateMcpDistEntry(entryPath);
  return location ? checkMcpDistStaleness(location, fsImpl) : null;
}
