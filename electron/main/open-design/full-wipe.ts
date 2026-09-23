import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger';
import { getOpenDesignConfig, setOpenDesignConfig } from './config';
import { clearSessionConfig } from './session-config';
import { resolveOpenDesignGlobalDataDir } from './paths';
import { resolveDesignSnapshotPaths } from '../pipeline-paths';
import { getHarnessProject } from '../db';
import { stop as stopOpenDesignDaemon } from './manager';

const logger = createLogger('open-design-full-wipe');

export async function wipeOpenDesign(projectId: string): Promise<{ ok: true } | { error: string }> {
  try {
    const cfg = getOpenDesignConfig(projectId);
    const project = getHarnessProject(projectId);

    try {
      await stopOpenDesignDaemon(projectId);
    } catch (err) {
      logger.warn({ err, projectId }, 'wipeOpenDesign: stop do daemon falhou (continuando)');
    }

    const odProjectId = cfg?.openDesignProjectId;
    if (odProjectId) {
      const dataDir = cfg?.dataDir || resolveOpenDesignGlobalDataDir();
      const projectsDir = path.join(dataDir, 'projects');
      const projectDir = path.join(projectsDir, odProjectId);
      const rel = path.relative(projectsDir, projectDir);
      const safe = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
      if (safe && fs.existsSync(projectDir)) {
        fs.rmSync(projectDir, { recursive: true, force: true });
        logger.info({ projectId, projectDir }, 'wipeOpenDesign: projeto do sidecar apagado');
      } else if (!safe) {
        logger.error({ projectId, projectDir }, 'wipeOpenDesign: path do sidecar inseguro — NAO apagado');
      }
    }

    if (project?.projectPath) {
      const snap = resolveDesignSnapshotPaths(project.projectPath, project.pipelineDocsId ?? null);
      if (snap) {
        for (const f of [
          snap.artifactHtmlPath,
          snap.contractPath,
          snap.briefPath,
          snap.manifestPath,
          snap.lockReportPath,
        ]) {
          try {
            if (fs.existsSync(f)) fs.rmSync(f, { force: true });
          } catch (err) {
            logger.warn({ err, file: f }, 'wipeOpenDesign: falha ao apagar arquivo de snapshot (nao-fatal)');
          }
        }
        logger.info(
          { projectId, snapshotDir: snap.snapshotDir },
          'wipeOpenDesign: snapshot do lock apagado (prompt preservado)',
        );
      }
    }

    clearSessionConfig(projectId);
    setOpenDesignConfig(projectId, {
      locked: false,
      lockedAt: undefined,
      snapshotDir: undefined,
      manifestPath: undefined,
      contractPath: undefined,
      artifactHtmlPath: undefined,
      briefPath: undefined,
      lockReportPath: undefined,
      openDesignProjectId: undefined,
    });

    logger.info({ projectId }, 'wipeOpenDesign: completo (design zerado, re-prompt re-armado)');
    return { ok: true };
  } catch (err) {
    logger.error({ err, projectId }, 'wipeOpenDesign falhou');
    return { error: (err as Error).message };
  }
}
