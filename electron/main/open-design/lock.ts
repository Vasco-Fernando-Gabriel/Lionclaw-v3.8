import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger';
import { getHarnessProject } from '../db';
import { resolveDesignSnapshotPaths } from '../pipeline-paths';
import { getOpenDesignConfig, setOpenDesignConfig } from './config';
import { captureSnapshot } from './snapshot';
import { extractContractFromHtml } from './contract';
import { buildBrief } from './brief-builder';
import { validateLock } from './validator';
import { stop as stopSidecar } from './manager';
import { emitIPC } from '../pipeline-shared/ipc-emitter';
import { savePipelinePhaseMetrics, getDb } from '../db';
import type { LockValidationResult } from './validator';

const logger = createLogger('open-design-lock');

export interface LockResult {
  ok: true;
  snapshotDir: string;
  manifestPath: string;
  contractPath: string;
  briefPath: string;
  reportPath: string;
  lockReportPath: string;
  artifactHtmlPath: string;
  lockedAt: string;
}

export interface LockRejected {
  ok: false;
  reportPath: string;
  lockReportPath: string;
  report: LockValidationResult;
}

export async function lock(projectId: string): Promise<LockResult | LockRejected | { error: string }> {
  try {
    logger.info({ projectId }, 'Design Lock gate started');

    const cfg = getOpenDesignConfig(projectId);
    if (!cfg?.runDir) return { error: 'runDir not configured for project' };

    const project = getHarnessProject(projectId);
    const designPaths = project?.projectPath
      ? resolveDesignSnapshotPaths(project.projectPath, project.pipelineDocsId ?? null)
      : null;
    const snapshotDir = designPaths?.snapshotDir ?? path.join(cfg.runDir, 'open-design', 'snapshots', 'latest');
    const lockReportPath = designPaths?.lockReportPath ?? path.join(snapshotDir, 'design-lock-report.md');
    const reportPath = lockReportPath;

    if (cfg.locked === true && cfg.lockedAt) {
      const artifactHtmlPath =
        cfg.artifactHtmlPath ?? designPaths?.artifactHtmlPath ?? path.join(snapshotDir, 'artifact', 'index.html');
      const contractPath =
        cfg.contractPath ?? designPaths?.contractPath ?? path.join(snapshotDir, 'design-contract.json');
      const briefPath = cfg.briefPath ?? designPaths?.briefPath ?? path.join(snapshotDir, 'design-brief.md');
      const manifestPath = cfg.manifestPath ?? designPaths?.manifestPath ?? path.join(snapshotDir, 'manifest.json');
      const allPresent =
        fs.existsSync(artifactHtmlPath) &&
        fs.existsSync(contractPath) &&
        fs.existsSync(briefPath) &&
        fs.existsSync(manifestPath);
      if (allPresent) {
        logger.info(
          { projectId, lockedAt: cfg.lockedAt },
          'Design Lock: already locked — returning cached result (idempotent)',
        );
        return {
          ok: true,
          snapshotDir,
          manifestPath,
          contractPath,
          briefPath,
          reportPath,
          lockReportPath,
          artifactHtmlPath,
          lockedAt: cfg.lockedAt,
        };
      }
      logger.warn(
        { projectId },
        'Design Lock: cfg.locked=true mas arquivos do snapshot sumiram — re-executando validator',
      );
    }

    logger.info({ projectId }, 'Design Lock: capturing snapshot');
    const snapResult = await captureSnapshot(projectId);
    if ('error' in snapResult) {
      logger.error({ projectId, error: snapResult.error }, 'Design Lock: snapshot failed');
      return { error: `snapshot failed: ${snapResult.error}` };
    }

    const contractPath = designPaths?.contractPath ?? path.join(snapshotDir, 'design-contract.json');
    if (!fs.existsSync(contractPath)) {
      const htmlPath = designPaths?.artifactHtmlPath ?? path.join(snapshotDir, 'artifact', 'index.html');
      if (fs.existsSync(htmlPath)) {
        const contract = await extractContractFromHtml(htmlPath);
        if (contract) {
          fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2), 'utf-8');
        }
      }
    }

    const briefPath = designPaths?.briefPath ?? path.join(snapshotDir, 'design-brief.md');
    if (!fs.existsSync(briefPath) && fs.existsSync(contractPath)) {
      try {
        const rawContract = JSON.parse(fs.readFileSync(contractPath, 'utf-8')) as Parameters<typeof buildBrief>[0];
        const brief = buildBrief(rawContract);
        fs.writeFileSync(briefPath, brief, 'utf-8');
      } catch (err) {
        logger.warn({ err, projectId }, 'Design Lock: could not build brief');
      }
    }

    logger.info({ projectId }, 'Design Lock: running validator');
    const validation = await validateLock(projectId);

    if (!validation.ok) {
      logger.warn({ projectId, problemCount: validation.problems.length }, 'Design Lock REJECTED');

      savePipelinePhaseMetrics({
        projectId,
        phaseNumber: 6,
        phaseName: 'Design Lock',
        status: 'failed',
        completedAt: new Date().toISOString(),
      });

      const db = getDb();
      db.prepare(
        `
        UPDATE harness_projects
        SET status = 'running', pipeline_current_phase = 5, updated_at = datetime('now')
        WHERE id = ?
      `,
      ).run(projectId);

      emitIPC('pipeline:project-updated', {
        projectId,
        patch: { status: 'running', currentPhase: 5 },
      });

      const problemsCompact = validation.problems.slice(0, 5).map((p) => ({
        rule: p.rule,
        item: p.item,
        hint: p.hint,
      }));

      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: 5,
        phaseName: 'LionDesign Studio',
        status: 'running',
        awaitingUser: true,
        metadata: {
          openDesignLockRejected: true,
          rejectedLockPhase: 6,
          reportPath,
          lockReportPath,
          problems: problemsCompact,
          problemCount: validation.problems.length,
        },
      });

      try {
        setOpenDesignConfig(projectId, {
          locked: false,
          snapshotDir,
          lockReportPath,
        });
      } catch (err) {
        logger.warn({ err, projectId }, 'lock: failed to persist lockReportPath on rejection (non-fatal)');
      }

      return { ok: false, reportPath, lockReportPath, report: validation };
    }

    const lockedAt = new Date().toISOString();
    const manifestPath = designPaths?.manifestPath ?? path.join(snapshotDir, 'manifest.json');

    let existingManifest: Record<string, unknown> = {};
    if (fs.existsSync(manifestPath)) {
      try {
        existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
      } catch {}
    }

    const existingHashes = (existingManifest.hashes as Record<string, string> | undefined) ?? {};
    const newManifest: Record<string, unknown> = {
      ...existingManifest,
      version: 1,
      locked: true,
      lockedAt,
      hashes: existingHashes,
    };

    fs.writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2), 'utf-8');

    const briefPathFinal = designPaths?.briefPath ?? path.join(snapshotDir, 'design-brief.md');
    const contractPathFinal = designPaths?.contractPath ?? path.join(snapshotDir, 'design-contract.json');
    const artifactHtmlPathFinal = designPaths?.artifactHtmlPath ?? path.join(snapshotDir, 'artifact', 'index.html');

    setOpenDesignConfig(projectId, {
      locked: true,
      lockedAt,
      snapshotDir,
      manifestPath,
      contractPath: contractPathFinal,
      artifactHtmlPath: artifactHtmlPathFinal,
      briefPath: briefPathFinal,
      lockReportPath,
    });

    try {
      await stopSidecar(projectId);
    } catch (err) {
      logger.warn({ err, projectId }, 'Design Lock: could not stop sidecar (non-fatal)');
    }

    logger.info({ projectId, lockedAt }, 'Design Lock approved — manifest patched, sidecar stopped');

    return {
      ok: true,
      snapshotDir,
      manifestPath,
      contractPath: contractPathFinal,
      briefPath: briefPathFinal,
      reportPath,
      lockReportPath,
      artifactHtmlPath: artifactHtmlPathFinal,
      lockedAt,
    };
  } catch (err) {
    logger.error({ err, projectId }, 'lock() threw unexpected error');
    return { error: (err as Error).message };
  }
}
