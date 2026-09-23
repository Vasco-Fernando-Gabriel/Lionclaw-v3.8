import fs from 'fs';
import path from 'path';
import { minimalInternalRuntimeEnv, resolveInternalNodeBinary, resolvePackagedMcpEntry } from './distribution-runtime';

export interface McpEntryResolutionOptions {
  resourcesPath?: string | null;
  appPath?: string | null;
  devOutputRoot?: string;
  sourceRoot?: string;
  cwd?: string | null;
  exists?: (candidate: string) => boolean;
  packaged?: boolean;
}

export interface McpRuntimeResolution extends McpEntryResolution {
  command: string | null;
  env: Record<string, string>;
}

export interface McpEntryResolution {
  entryPath: string | null;
  candidates: string[];
}

function validateMcpPath(id: string, relativeEntry: string): string[] {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`id MCP invalido: ${id}`);
  }
  const segments = relativeEntry.split(/[\\/]+/);
  if (
    relativeEntry.length === 0 ||
    path.isAbsolute(relativeEntry) ||
    /^[a-zA-Z]:/.test(relativeEntry) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`entrypoint MCP relativo invalido: ${relativeEntry}`);
  }
  return segments;
}

function defaultResourcesPath(): string | null {
  const value = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function defaultPackaged(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('electron')?.app?.isPackaged === true;
  } catch {
    return false;
  }
}

export function resolveMcpServerEntry(
  id: string,
  relativeEntry: string,
  options: McpEntryResolutionOptions = {},
): McpEntryResolution {
  const entrySegments = validateMcpPath(id, relativeEntry);
  const repoRoot = path.resolve(__dirname, '../..');
  const resourcesPath = options.resourcesPath === undefined ? defaultResourcesPath() : options.resourcesPath;
  const packaged = options.packaged ?? defaultPackaged();
  if (packaged) {
    try {
      const entryPath = resolvePackagedMcpEntry(id, {
        resourcesPath,
        packaged: true,
      });
      return { entryPath, candidates: [entryPath] };
    } catch (error) {
      throw new Error(`MCP packaged ${id} inválido: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const hasExplicitDevelopmentRoots =
    options.devOutputRoot !== undefined ||
    options.sourceRoot !== undefined ||
    options.appPath !== undefined ||
    options.cwd !== undefined ||
    options.resourcesPath !== undefined;
  if (!hasExplicitDevelopmentRoots) {
    try {
      const entryPath = resolvePackagedMcpEntry(id, { packaged: false });
      return { entryPath, candidates: [entryPath] };
    } catch {}
  }
  const roots = [
    resourcesPath ? path.join(resourcesPath, 'mcp-servers') : null,
    options.devOutputRoot ?? path.join(repoRoot, 'out', 'mcp-servers'),
    options.appPath ? path.join(options.appPath, 'mcp-servers') : null,
    options.sourceRoot ?? path.join(repoRoot, 'mcp-servers'),
    options.cwd ? path.join(options.cwd, 'out', 'mcp-servers') : null,
    options.cwd ? path.join(options.cwd, 'mcp-servers') : null,
  ].filter((root): root is string => typeof root === 'string' && root.length > 0);
  const uniqueRoots = roots.filter((root, index) => roots.indexOf(root) === index);
  const candidates = uniqueRoots.map((root) => path.join(root, id, ...entrySegments));
  const exists = options.exists ?? fs.existsSync;
  const entryPath =
    candidates.find((candidate) => {
      try {
        return exists(candidate);
      } catch {
        return false;
      }
    }) ?? null;
  return { entryPath, candidates };
}

export function resolveMcpServerRuntime(
  id: string,
  relativeEntry: string,
  options: McpEntryResolutionOptions = {},
): McpRuntimeResolution {
  const resolution = resolveMcpServerEntry(id, relativeEntry, options);
  if (!resolution.entryPath) return { ...resolution, command: null, env: {} };
  const packaged = options.packaged ?? defaultPackaged();
  try {
    const command = resolveInternalNodeBinary({
      resourcesPath: options.resourcesPath,
      packaged,
    });
    return {
      ...resolution,
      command,
      env: minimalInternalRuntimeEnv(command),
    };
  } catch (error) {
    if (packaged) throw error;
    return {
      ...resolution,
      command: process.execPath,
      env: minimalInternalRuntimeEnv(process.execPath),
    };
  }
}

export function resolveMcpServerEntryOrDefault(
  id: string,
  relativeEntry: string,
  options: McpEntryResolutionOptions = {},
): string {
  const resolution = resolveMcpServerEntry(id, relativeEntry, options);
  return resolution.entryPath ?? resolution.candidates[0];
}
