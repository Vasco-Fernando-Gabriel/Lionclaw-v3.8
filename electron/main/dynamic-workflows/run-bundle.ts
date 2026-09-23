import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { RunBundleEntry } from '../../../src/types/dynamic-workflow-cockpit';

export const RUN_BUNDLE_MAX_ENTRIES = 500;

const BUNDLE_FILES = ['workflow.js', 'workflow.manifest.json', join('logs', 'events.jsonl')];
const BUNDLE_DIRS = ['schemas', 'checkpoints', 'artifacts'];

export function listRunBundle(runDir: string, maxEntries: number = RUN_BUNDLE_MAX_ENTRIES): RunBundleEntry[] {
  const root = resolve(runDir);
  const entries: RunBundleEntry[] = [];
  const isInside = (absolutePath: string): boolean => absolutePath.startsWith(root + sep);

  const pushFile = (absolutePath: string): boolean => {
    if (entries.length >= maxEntries) return false;
    if (!isInside(absolutePath)) return true;
    const stat = lstatSync(absolutePath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) return true;
    entries.push({
      name: absolutePath.slice(absolutePath.lastIndexOf(sep) + 1),
      relativePath: relative(root, absolutePath).split(sep).join('/'),
      sizeBytes: stat.size,
      mtime: stat.mtime.toISOString(),
    });
    return true;
  };

  const walk = (dir: string): boolean => {
    if (!isInside(dir)) return true;
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory()) return true;
    const dirents = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue;
      const child = resolve(dir, dirent.name);
      if (!isInside(child)) continue;
      if (dirent.isDirectory()) {
        if (!walk(child)) return false;
      } else if (dirent.isFile()) {
        if (!pushFile(child)) return false;
      }
    }
    return true;
  };

  for (const file of BUNDLE_FILES) {
    if (!pushFile(resolve(root, file))) return entries;
  }
  for (const dir of BUNDLE_DIRS) {
    if (!walk(resolve(root, dir))) return entries;
  }
  return entries;
}
