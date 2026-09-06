import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../logger';
import { getOpenDesignConfig, setOpenDesignConfig } from './config';
import { emitIPC } from '../pipeline-shared/ipc-emitter';
import { getDb, savePipelinePhaseMetrics } from '../db';

const logger = createLogger('open-design-escape-hatch');


export interface DestructiveUnlockResult {
  ok: true;
  designRevisionId: string;
  archivePath: string;
}


export async function destructiveUnlock(
  projectId: string,
  confirmation: string,
): Promise<DestructiveUnlockResult | { error: string }> {
  if (confirmation !== 'DESBLOQUEAR DESIGN') {
    return { error: 'invalid-confirmation' };
  }

  try {
    const cfg = getOpenDesignConfig(projectId);
    if (!cfg?.runDir) return { error: 'runDir not configured for project' };

    const runDir = cfg.runDir;
    const snapshotDir = path.join(runDir, 'open-design', 'snapshots', 'latest');
    const revisionsDir = path.join(runDir, 'open-design', 'snapshots', 'revisions');

    const designRevisionId = `rev-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const revisionDir = path.join(revisionsDir, designRevisionId);
    fs.mkdirSync(revisionDir, { recursive: true });

    logger.info({ projectId, designRevisionId }, 'Escape hatch: archiving current lock state');

    if (fs.existsSync(snapshotDir)) {
      copyDirRecursive(snapshotDir, revisionDir);
    }

    const db = getDb();

    const messages = db.prepare(`
      SELECT id, phase_number, role, content, tool_calls, sprint_index, round_index, agent_id, created_at
      FROM pipeline_messages
      WHERE project_id = ? AND phase_number >= 5
      ORDER BY phase_number ASC, created_at ASC
    `).all(projectId) as Array<Record<string, unknown>>;

    const metrics = db.prepare(`
      SELECT *
      FROM pipeline_phase_metrics
      WHERE project_id = ? AND phase_number >= 5
      ORDER BY phase_number ASC
    `).all(projectId) as Array<Record<string, unknown>>;

    const archivedStatePath = path.join(revisionDir, 'archived-state.json');
    fs.writeFileSync(
      archivedStatePath,
      JSON.stringify(
        {
          designRevisionId,
          archivedAt: new Date().toISOString(),
          projectId,
          messages,
          metrics,
        },
        null,
        2,
      ),
      'utf-8',
    );

    db.prepare(`
      DELETE FROM pipeline_messages WHERE project_id = ? AND phase_number >= 5
    `).run(projectId);

    db.prepare(`
      DELETE FROM pipeline_phase_metrics WHERE project_id = ? AND phase_number >= 5
    `).run(projectId);

    try {
      if (fs.existsSync(snapshotDir)) {
        const artifactDir = path.join(snapshotDir, 'artifact');
        if (fs.existsSync(artifactDir)) {
          fs.rmSync(artifactDir, { recursive: true, force: true });
        }
        for (const file of [
          'design-contract.json',
          'design-brief.md',
          'design-lock-report.md',
          'manifest.json',
        ]) {
          const fp = path.join(snapshotDir, file);
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
        }
      }
    } catch (err) {
      logger.warn({ err, projectId }, 'Escape hatch: could not fully clear latest/ (non-fatal)');
    }

    setOpenDesignConfig(projectId, {
      locked: false,
      lockedAt: undefined,
      designRevisionId,
      snapshotDir: undefined,
      contractPath: undefined,
      artifactHtmlPath: undefined,
      manifestPath: undefined,
    });

    db.prepare(`
      UPDATE harness_projects
      SET status = 'running', pipeline_current_phase = 5, updated_at = datetime('now')
      WHERE id = ?
    `).run(projectId);

    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: 6,
      phaseName: 'Design Lock',
      status: 'interrupted',
      completedAt: new Date().toISOString(),
      metadata: { escapedHatch: true, designRevisionId },
    });

    emitIPC('pipeline:project-updated', {
      projectId,
      patch: { status: 'running', currentPhase: 5 },
    });

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 5,
      phaseName: 'LionDesign Studio',
      status: 'running',
      awaitingUser: true,
      metadata: {
        designRevisionRestarted: true,
        designRevisionId,
        archivePath: revisionDir,
      },
    });

    logger.info(
      { projectId, designRevisionId, revisionDir },
      'Escape hatch: destructive unlock complete',
    );

    return { ok: true, designRevisionId, archivePath: revisionDir };
  } catch (err) {
    logger.error({ err, projectId }, 'destructiveUnlock threw unexpected error');
    return { error: (err as Error).message };
  }
}


function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
