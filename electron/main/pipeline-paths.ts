import path from 'path';
import fs from 'fs';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import type { HarnessProject } from '../../src/types';

const logger = createLogger('pipeline-paths');

type HarnessProjectPathInfo = Pick<HarnessProject, 'id' | 'projectPath' | 'pipelineDocsId'> & {
  sprintsJsonPath?: string | null;
};

function findLatestSecurityReportLegacy(projectPath: string): string | null {
  const securityDir = path.join(projectPath, '.lionclaw', 'Security');
  if (!fs.existsSync(securityDir)) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(securityDir);
  } catch {
    return null;
  }
  const candidates = entries.filter((name) => /^Security[-_]?\d{8}[-_]\d{4,6}\.md$/.test(name)).sort();
  if (candidates.length === 0) return null;
  return path.join(securityDir, candidates[candidates.length - 1]!);
}

export function findConsolidatedSecurityReport(projectPath: string, pipelineDocsId: string | null): string | null {
  if (pipelineDocsId) {
    const ctx = getPipelineDocsContext(projectPath, pipelineDocsId);
    if (ctx) {
      const docsPath = ctx.resolveDocPath('Security.md');
      if (fs.existsSync(docsPath)) return docsPath;
    }
  }
  return findLatestSecurityReportLegacy(projectPath);
}

const LEGACY_DOCS = ['PRD.md', 'SPEC.md', 'stories-requisitos.md', 'discovery-notes.md', 'sprints.json', 'SPRINTS.md'];

const LEGACY_GLOBS = [/^feature-discovery-notes-.*\.md$/];

void LEGACY_DOCS;

export function generatePipelineDocsId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export interface PipelineDocsContext {
  docsDir: string;
  docsId: string;
  resolveDocPath(baseName: string): string;
}

export function getPipelineDocsContext(projectPath: string, pipelineDocsId: string | null): PipelineDocsContext | null {
  if (!pipelineDocsId) return null;

  const docsRoot = path.join(projectPath, 'docs');
  const docsDir = path.join(docsRoot, `Docs${pipelineDocsId}`);

  if (!fs.existsSync(docsRoot)) fs.mkdirSync(docsRoot, { recursive: true });
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  return {
    docsDir,
    docsId: pipelineDocsId,
    resolveDocPath: (baseName: string) => {
      const ext = path.extname(baseName);
      const stem = baseName.slice(0, baseName.length - ext.length);
      return path.join(docsDir, `${stem}${pipelineDocsId}${ext}`);
    },
  };
}

export interface DesignSnapshotPaths {
  snapshotDir: string;
  artifactHtmlPath: string;
  contractPath: string;
  briefPath: string;
  manifestPath: string;
  lockReportPath: string;
}

export function resolveDesignSnapshotPaths(
  projectPath: string,
  pipelineDocsId: string | null,
): DesignSnapshotPaths | null {
  if (!pipelineDocsId) return null;
  const ctx = getPipelineDocsContext(projectPath, pipelineDocsId);
  if (!ctx) return null;

  const snapshotDir = path.join(ctx.docsDir, 'design');
  if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });

  return {
    snapshotDir,
    artifactHtmlPath: path.join(snapshotDir, 'artifact.html'),
    contractPath: path.join(snapshotDir, 'design-contract.json'),
    briefPath: path.join(snapshotDir, 'design-brief.md'),
    manifestPath: path.join(snapshotDir, 'manifest.json'),
    lockReportPath: path.join(snapshotDir, 'design-lock-report.md'),
  };
}

export function resolveOpenDesignPromptPath(projectPath: string, pipelineDocsId: string | null): string {
  if (pipelineDocsId) {
    const ctx = getPipelineDocsContext(projectPath, pipelineDocsId);
    if (ctx) {
      const designDir = path.join(ctx.docsDir, 'design');
      if (!fs.existsSync(designDir)) fs.mkdirSync(designDir, { recursive: true });
      return path.join(designDir, 'open-design-prompt.md');
    }
  }

  const fallbackDir = path.join(projectPath, '.lionclaw', 'open-design');
  if (!fs.existsSync(fallbackDir)) fs.mkdirSync(fallbackDir, { recursive: true });
  return path.join(fallbackDir, 'open-design-prompt.md');
}

export function resolveSpecPath(project: Pick<HarnessProject, 'specPath' | 'projectPath'>): string {
  if (project.specPath) return project.specPath;
  return path.join(project.projectPath, 'SPEC.md');
}

export function resolveSpecProgressPath(project: Pick<HarnessProject, 'projectPath'>): string {
  return path.join(project.projectPath, 'SPEC_PROGRESS.md');
}

export function resolvePrdPath(project: Pick<HarnessProject, 'prdPath'>): string | null {
  return project.prdPath ?? null;
}

export function resolveDiscoveryNotesPath(project: Pick<HarnessProject, 'discoveryNotesPath'>): string | null {
  return project.discoveryNotesPath ?? null;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[\\/]/g, '_').trim();
  return sanitized.length > 0 ? sanitized : 'unknown';
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveHarnessProjectDir(project: HarnessProjectPathInfo): string {
  const projectPath = path.resolve(project.projectPath);
  const docsCtx = getPipelineDocsContext(projectPath, project.pipelineDocsId ?? null);
  const projectDir = docsCtx?.docsDir ?? path.join(projectPath, 'docs');
  fs.mkdirSync(projectDir, { recursive: true });
  return path.resolve(projectDir);
}

export function getCanonicalHarnessSprintsPath(project: HarnessProjectPathInfo): string {
  const projectPath = path.resolve(project.projectPath);
  return project.pipelineDocsId
    ? path.join(projectPath, 'docs', `Docs${project.pipelineDocsId}`, `sprints${project.pipelineDocsId}.json`)
    : path.join(projectPath, 'docs', 'sprints.json');
}

export function resolveHarnessSprintsPath(project: HarnessProjectPathInfo): string {
  const sprintsPath = getCanonicalHarnessSprintsPath(project);
  fs.mkdirSync(path.dirname(sprintsPath), { recursive: true });
  return path.resolve(sprintsPath);
}

export function findHarnessSprintsReadPath(project: HarnessProjectPathInfo): string | null {
  const canonicalPath = getCanonicalHarnessSprintsPath(project);
  if (project.pipelineDocsId && fs.existsSync(canonicalPath)) {
    return canonicalPath;
  }

  const persistedPath = project.sprintsJsonPath ? path.resolve(project.sprintsJsonPath) : null;
  if (persistedPath && isPathInside(project.projectPath, persistedPath) && fs.existsSync(persistedPath)) {
    return persistedPath;
  }

  if (fs.existsSync(canonicalPath)) {
    return canonicalPath;
  }

  const projectRootLegacyPath = path.join(project.projectPath, 'sprints.json');
  if (fs.existsSync(projectRootLegacyPath)) {
    return projectRootLegacyPath;
  }

  const legacyPath = findLegacyHarnessSprintsPath(project);
  if (legacyPath && fs.existsSync(legacyPath)) {
    return legacyPath;
  }

  return null;
}

export function resolveHarnessSprintsReadPath(project: HarnessProjectPathInfo): string {
  return findHarnessSprintsReadPath(project) ?? resolveHarnessSprintsPath(project);
}

export function findPipelineDocReadPath(
  projectPath: string,
  pipelineDocsId: string | null | undefined,
  canonicalBaseName: string,
  legacyBaseName = canonicalBaseName,
  persistedPath?: string | null,
): string | null {
  const docsCtx = getPipelineDocsContext(projectPath, pipelineDocsId ?? null);
  if (docsCtx) {
    const docsPath = docsCtx.resolveDocPath(canonicalBaseName);
    if (fs.existsSync(docsPath)) {
      return docsPath;
    }
  }

  if (persistedPath && fs.existsSync(persistedPath)) {
    return path.resolve(persistedPath);
  }

  const legacyPath = path.join(projectPath, legacyBaseName);
  if (fs.existsSync(legacyPath)) {
    return legacyPath;
  }

  return null;
}

export function resolveHarnessSprintArtifactDir(
  project: HarnessProjectPathInfo,
  sprintJsonIdOrSprintId: string,
): string {
  const dir = path.join(resolveHarnessProjectDir(project), 'sprints', sanitizePathSegment(sprintJsonIdOrSprintId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getLegacyHarnessProjectDir(projectId: string, lionclawHome = getLionClawHome()): string {
  return path.join(lionclawHome, 'harness', 'projects', projectId);
}

export function getLegacyHarnessSprintArtifactDir(
  projectId: string,
  sprintJsonIdOrSprintId: string,
  lionclawHome = getLionClawHome(),
): string {
  return path.join(
    getLegacyHarnessProjectDir(projectId, lionclawHome),
    'sprints',
    sanitizePathSegment(sprintJsonIdOrSprintId),
  );
}

export function isLegacyHarnessPath(
  project: Pick<HarnessProjectPathInfo, 'id'>,
  filePath: string,
  lionclawHome = getLionClawHome(),
): boolean {
  const legacyDir = getLegacyHarnessProjectDir(project.id, lionclawHome);
  return isPathInside(legacyDir, filePath);
}

function findLatestLegacySprintsVersion(projectId: string, lionclawHome: string): string | null {
  const legacyDir = getLegacyHarnessProjectDir(projectId, lionclawHome);
  if (!fs.existsSync(legacyDir)) return null;

  let entries: string[];
  try {
    entries = fs.readdirSync(legacyDir);
  } catch {
    return null;
  }

  const versions = entries
    .map((file) => {
      const match = file.match(/^sprints\.v(\d+)\.json$/);
      return match ? { file, version: Number.parseInt(match[1]!, 10) } : null;
    })
    .filter((entry): entry is { file: string; version: number } => entry !== null)
    .sort((a, b) => b.version - a.version);

  if (versions[0]) return path.join(legacyDir, versions[0].file);

  const unversioned = path.join(legacyDir, 'sprints.json');
  return fs.existsSync(unversioned) ? unversioned : null;
}

export function findLegacyHarnessSprintsPath(
  project: HarnessProjectPathInfo,
  lionclawHome = getLionClawHome(),
): string | null {
  if (project.sprintsJsonPath && isLegacyHarnessPath(project, project.sprintsJsonPath, lionclawHome)) {
    return path.resolve(project.sprintsJsonPath);
  }
  return findLatestLegacySprintsVersion(project.id, lionclawHome);
}

export type HarnessSprintsMigrationStatus =
  'not-legacy' | 'project-missing' | 'source-missing' | 'moved' | 'duplicate-removed' | 'conflict-kept-canonical';

export interface HarnessSprintsMigrationResult {
  status: HarnessSprintsMigrationStatus;
  canonicalPath: string;
  legacyPath: string | null;
  shouldUpdateDb: boolean;
}

export type HarnessDocsSprintsMigrationStatus =
  'source-missing' | 'canonical-existing' | 'moved' | 'duplicate-removed' | 'conflict-kept-source';

export interface HarnessDocsSprintsMigrationResult {
  status: HarnessDocsSprintsMigrationStatus;
  sourcePath: string | null;
  canonicalPath: string;
  pathToPersist: string;
}

export function migrateHarnessSprintsToPipelineDocs(
  project: HarnessProjectPathInfo,
  pipelineDocsId: string,
): HarnessDocsSprintsMigrationResult {
  const sourcePath = findHarnessSprintsReadPath({ ...project, pipelineDocsId: null });
  const canonicalPath = getCanonicalHarnessSprintsPath({ ...project, pipelineDocsId });

  if (!sourcePath) {
    return {
      status: fs.existsSync(canonicalPath) ? 'canonical-existing' : 'source-missing',
      sourcePath: null,
      canonicalPath,
      pathToPersist: canonicalPath,
    };
  }

  if (path.resolve(sourcePath) === canonicalPath) {
    return { status: 'duplicate-removed', sourcePath, canonicalPath, pathToPersist: canonicalPath };
  }

  fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });

  if (fs.existsSync(canonicalPath)) {
    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
    const canonicalContent = fs.readFileSync(canonicalPath, 'utf-8');
    if (sourceContent === canonicalContent) {
      fs.unlinkSync(sourcePath);
      logger.info(
        { projectId: project.id, sourcePath, canonicalPath },
        'Removed duplicate sprints JSON after pipeline docs migration',
      );
      return { status: 'duplicate-removed', sourcePath, canonicalPath, pathToPersist: canonicalPath };
    }

    logger.warn(
      { projectId: project.id, sourcePath, canonicalPath },
      'Pipeline docs sprints JSON already exists with different content; preserving current source path',
    );
    return { status: 'conflict-kept-source', sourcePath, canonicalPath, pathToPersist: sourcePath };
  }

  try {
    fs.renameSync(sourcePath, canonicalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.copyFileSync(sourcePath, canonicalPath);
    fs.unlinkSync(sourcePath);
  }

  logger.info(
    { projectId: project.id, sourcePath, canonicalPath },
    'Moved sprints JSON to pipeline docs canonical path',
  );
  return { status: 'moved', sourcePath, canonicalPath, pathToPersist: canonicalPath };
}

export function migrateLegacyHarnessSprintsJsonFile(
  project: HarnessProjectPathInfo,
  lionclawHome = getLionClawHome(),
): HarnessSprintsMigrationResult {
  const legacyPath = project.sprintsJsonPath
    ? isLegacyHarnessPath(project, project.sprintsJsonPath, lionclawHome)
      ? path.resolve(project.sprintsJsonPath)
      : null
    : findLatestLegacySprintsVersion(project.id, lionclawHome);
  const canonicalPath = getCanonicalHarnessSprintsPath(project);

  if (!legacyPath) {
    return { status: 'not-legacy', canonicalPath, legacyPath: null, shouldUpdateDb: false };
  }

  if (!fs.existsSync(project.projectPath)) {
    logger.warn(
      { projectId: project.id, projectPath: project.projectPath, legacyPath },
      'Skipping legacy sprints migration because project path does not exist',
    );
    return { status: 'project-missing', canonicalPath, legacyPath, shouldUpdateDb: false };
  }

  if (!fs.existsSync(legacyPath)) {
    logger.warn(
      { projectId: project.id, legacyPath },
      'Skipping legacy sprints migration because source file does not exist',
    );
    return { status: 'source-missing', canonicalPath, legacyPath, shouldUpdateDb: false };
  }

  fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });

  if (fs.existsSync(canonicalPath)) {
    const legacyContent = fs.readFileSync(legacyPath, 'utf-8');
    const canonicalContent = fs.readFileSync(canonicalPath, 'utf-8');
    if (legacyContent === canonicalContent) {
      fs.unlinkSync(legacyPath);
      logger.info(
        { projectId: project.id, legacyPath, canonicalPath },
        'Removed duplicate legacy sprints JSON after matching canonical file',
      );
      return { status: 'duplicate-removed', canonicalPath, legacyPath, shouldUpdateDb: true };
    }

    logger.warn(
      { projectId: project.id, legacyPath, canonicalPath },
      'Canonical sprints JSON already exists with different content; keeping canonical and preserving legacy source',
    );
    return { status: 'conflict-kept-canonical', canonicalPath, legacyPath, shouldUpdateDb: true };
  }

  try {
    fs.renameSync(legacyPath, canonicalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.copyFileSync(legacyPath, canonicalPath);
    fs.unlinkSync(legacyPath);
  }

  logger.info(
    { projectId: project.id, legacyPath, canonicalPath },
    'Moved legacy sprints JSON to canonical project path',
  );
  return { status: 'moved', canonicalPath, legacyPath, shouldUpdateDb: true };
}

export function migrateLegacyDocsToFolder(
  projectPath: string,
  pipelineDocsId: string,
): { migrated: string[]; errors: string[] } {
  const migrated: string[] = [];
  const errors: string[] = [];

  const ctx = getPipelineDocsContext(projectPath, pipelineDocsId);
  if (!ctx) {
    errors.push('Failed to create docsContext');
    return { migrated, errors };
  }

  const explicitMap: Record<string, string> = {
    'PRD.md': 'PRD.md',
    'SPEC.md': 'SPEC.md',
    'stories-requisitos.md': 'stories-requisitos.md',
    'discovery-notes.md': 'discovery.md',
    'sprints.json': 'sprints.json',
    'SPRINTS.md': 'SPRINTS.md',
  };

  for (const [legacyName, canonicalBase] of Object.entries(explicitMap)) {
    const legacyPath = path.join(projectPath, legacyName);
    if (!fs.existsSync(legacyPath)) continue;
    const targetPath = ctx.resolveDocPath(canonicalBase);
    try {
      if (fs.existsSync(targetPath)) continue;
      fs.renameSync(legacyPath, targetPath);
      migrated.push(`${legacyName} -> ${path.basename(targetPath)}`);
    } catch (err) {
      errors.push(`${legacyName}: ${(err as Error).message}`);
    }
  }

  try {
    const entries = fs.readdirSync(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const matches = LEGACY_GLOBS.some((re) => re.test(entry.name));
      if (!matches) continue;
      const legacyPath = path.join(projectPath, entry.name);
      const targetPath = ctx.resolveDocPath('discovery.md');
      try {
        if (fs.existsSync(targetPath)) continue;
        fs.renameSync(legacyPath, targetPath);
        migrated.push(`${entry.name} -> ${path.basename(targetPath)}`);
      } catch (err) {
        errors.push(`${entry.name}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    errors.push(`readdirSync(${projectPath}): ${(err as Error).message}`);
  }

  return { migrated, errors };
}
