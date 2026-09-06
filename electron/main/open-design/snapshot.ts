import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../logger';
import { getHarnessProject } from '../db';
import { resolveDesignSnapshotPaths } from '../pipeline-paths';
import { getOpenDesignConfig, setOpenDesignConfig } from './config';
import { extractContractFromHtml } from './contract';
import { buildBrief } from './brief-builder';
import { createAdapter } from './adapter-http';
import type { LockedSnapshotPaths } from '../../../src/types/open-design';
import { resolveOpenDesignGlobalDataDir } from './paths';
import { status as getOpenDesignRuntimeStatus } from './manager';

const logger = createLogger('open-design-snapshot');

function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function fetchArtifactFromDaemon(
  daemonUrl: string,
  openDesignProjectId: string,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const healthTimeout = setTimeout(() => controller.abort(), 800);
    const healthRes = await fetch(`${daemonUrl}/api/health`, { signal: controller.signal });
    clearTimeout(healthTimeout);
    if (!healthRes.ok) return null;
  } catch {
    return null;
  }

  try {
    const adapter = createAdapter({ baseUrl: daemonUrl });
    const { html } = await adapter.fetchFinalArtifact(openDesignProjectId);
    return html;
  } catch (err) {
    logger.warn({ err, openDesignProjectId }, 'fetchArtifactFromDaemon: adapter returned no candidate');
    return null;
  }
}

function findArtifactOnFilesystem(
  dataDir: string,
  openDesignProjectId: string | undefined,
): string | null {
  if (!openDesignProjectId) return null;
  if (!fs.existsSync(dataDir)) return null;

  const artifactDir = path.join(dataDir, 'projects', openDesignProjectId, 'artifact');
  if (!fs.existsSync(artifactDir)) return null;

  let bestMtime = 0;
  let bestPath: string | null = null;

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const fullPath = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(fullPath);
      } else if (e.isFile() && e.name.endsWith('.html')) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > bestMtime) {
            bestMtime = stat.mtimeMs;
            bestPath = fullPath;
          }
        } catch {
        }
      }
    }
  };

  walk(artifactDir);

  return bestPath;
}

export interface CaptureSnapshotResult {
  ok: true;
  paths: LockedSnapshotPaths;
  hashes: { htmlSha256: string; contractSha256: string | null };
}

export async function captureSnapshot(
  projectId: string,
): Promise<CaptureSnapshotResult | { error: string }> {
  try {
    const cfg = getOpenDesignConfig(projectId);
    if (!cfg?.runDir) return { error: 'runDir not configured for project' };

    const runDir = cfg.runDir;
    const runtimeStatus = getOpenDesignRuntimeStatus(projectId);
    const daemonUrl = cfg.daemonUrl ?? runtimeStatus.daemonUrl ?? undefined;
    const dataDir = cfg.dataDir ?? resolveOpenDesignGlobalDataDir();

    const project = getHarnessProject(projectId);
    const designPaths = project?.projectPath
      ? resolveDesignSnapshotPaths(project.projectPath, project.pipelineDocsId ?? null)
      : null;
    const snapshotDir = designPaths?.snapshotDir
      ?? path.join(runDir, 'open-design', 'snapshots', 'latest');
    const destHtmlPath = designPaths?.artifactHtmlPath
      ?? path.join(snapshotDir, 'artifact', 'index.html');
    fs.mkdirSync(path.dirname(destHtmlPath), { recursive: true });

    const openDesignProjectId =
      cfg.openDesignProjectId ??
      ((cfg as unknown as Record<string, unknown>).odProjectId as string | undefined);

    let htmlContent: string | null = null;
    if (daemonUrl && openDesignProjectId) {
      htmlContent = await fetchArtifactFromDaemon(daemonUrl, openDesignProjectId);
      if (htmlContent) {
        logger.info({ projectId, openDesignProjectId }, 'Artifact fetched from OD HTTP API');
      }
    }

    if (!htmlContent) {
      const found = findArtifactOnFilesystem(dataDir, openDesignProjectId);
      if (found) {
        htmlContent = fs.readFileSync(found, 'utf-8');
        logger.info({ projectId, openDesignProjectId, found }, 'Artifact read from OD filesystem');
      }
    }

    if (!htmlContent) {
      return { error: 'Could not obtain artifact: OD daemon unavailable and no filesystem artifact found' };
    }

    fs.writeFileSync(destHtmlPath, htmlContent, 'utf-8');
    const htmlSha256 = sha256File(destHtmlPath);

    const contract = await extractContractFromHtml(destHtmlPath);
    const contractPath = designPaths?.contractPath ?? path.join(snapshotDir, 'design-contract.json');
    let contractSha256: string | null = null;

    if (contract) {
      if (contract.source && typeof contract.source === 'object') {
        contract.source.artifactPath = path.basename(destHtmlPath);
      }
      fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2), 'utf-8');
      contractSha256 = sha256File(contractPath);

      const brief = buildBrief(contract);
      const briefPath = designPaths?.briefPath ?? path.join(snapshotDir, 'design-brief.md');
      fs.writeFileSync(briefPath, brief, 'utf-8');
    } else {
      logger.warn({ projectId }, 'No valid DesignContract found in artifact HTML');
    }

    const manifestPath = designPaths?.manifestPath ?? path.join(snapshotDir, 'manifest.json');
    let existingManifest: Record<string, unknown> = {};
    if (fs.existsSync(manifestPath)) {
      try {
        existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
      } catch {
      }
    }

    const hashes: Record<string, string> = {
      ...(existingManifest.hashes as Record<string, string> | undefined ?? {}),
    };
    if (!hashes.htmlSha256) hashes.htmlSha256 = htmlSha256;
    if (!hashes.contractSha256 && contractSha256) hashes.contractSha256 = contractSha256;

    const manifest = {
      version: 1,
      locked: (existingManifest.locked as boolean | undefined) ?? false,
      lockedAt: (existingManifest.lockedAt as string | undefined) ?? null,
      files: {
        html: path.basename(destHtmlPath),
        contract: path.basename(contractPath),
        brief: 'design-brief.md',
        report: 'design-lock-report.md',
      },
      hashes,
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    setOpenDesignConfig(projectId, {
      snapshotDir,
      manifestPath,
      contractPath: fs.existsSync(contractPath) ? contractPath : undefined,
      artifactHtmlPath: destHtmlPath,
    });

    const paths: LockedSnapshotPaths = {
      snapshotDir,
      manifestPath,
      contractPath,
      artifactHtmlPath: destHtmlPath,
    };

    logger.info({ projectId, snapshotDir, htmlSha256 }, 'Snapshot captured successfully');

    return { ok: true, paths, hashes: { htmlSha256, contractSha256 } };
  } catch (err) {
    logger.error({ err, projectId }, 'captureSnapshot failed');
    return { error: (err as Error).message };
  }
}
