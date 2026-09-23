import fs from 'fs';
import path from 'path';
import * as sqliteVec from 'sqlite-vec';

interface SqliteExtensionDatabase {
  loadExtension(candidate: string): void;
}

interface SqliteVecRuntimeOptions {
  resourcesPath?: string | null;
  platform?: NodeJS.Platform;
  arch?: string;
  fallbackLoad?: (database: SqliteExtensionDatabase) => void;
}

export function loadSqliteVecForRuntime(
  database: SqliteExtensionDatabase,
  options: SqliteVecRuntimeOptions = {},
): string | null {
  const resourcesPath =
    options.resourcesPath === undefined
      ? ((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? null)
      : options.resourcesPath;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (resourcesPath) {
    const packageOs = platform === 'win32' ? 'windows' : platform;
    const suffix = platform === 'win32' ? 'dll' : platform === 'darwin' ? 'dylib' : 'so';
    const unpackedRoot = path.resolve(resourcesPath, 'app.asar.unpacked', 'node_modules');
    const candidate = path.join(unpackedRoot, `sqlite-vec-${packageOs}-${arch}`, `vec0.${suffix}`);
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (stat?.isFile() && !stat.isSymbolicLink()) {
      const physicalRoot = fs.realpathSync(unpackedRoot);
      const physicalCandidate = fs.realpathSync(candidate);
      const fromRoot = path.relative(physicalRoot, physicalCandidate);
      if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
        throw new Error('sqlite-vec físico escapou da closure unpacked');
      }
      database.loadExtension(physicalCandidate);
      return physicalCandidate;
    }
  }
  (options.fallbackLoad ?? sqliteVec.load)(database);
  return null;
}
