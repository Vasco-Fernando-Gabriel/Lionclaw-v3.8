import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger';
import { setODViewBounds, showODView, hideODView } from '../open-design/webview';
import { pricingCalculate } from '../pricing';
import type {
  OrchestratorProvider,
  OrchestratorRuntime,
  OpenAiCompatiblePreset,
} from '../../../src/types';
import type { IpcContext } from './context';

const logger = createLogger('ipc');

export function registerOpenDesignHandlers(ctx: IpcContext): void {
  const { getMainWindow } = ctx;

  ipcMain.handle('open-design:preflight', async () => {
    const { preflight } = await import('../open-design/installer');
    return preflight();
  });

  ipcMain.handle(
    'open-design:setup',
    async (_event, projectId: string, payload: Record<string, unknown>) => {
      try {
        const { setOpenDesignConfig } = await import('../open-design/config');
        const secretFields = new Set(['apiKey', 'token', 'secret']);
        const ignoredFields = new Set(['openDesignRoot']);
        const sanitized: Record<string, unknown> = {};
        let hadSecrets = false;
        let hadIgnored = false;
        for (const [k, v] of Object.entries(payload)) {
          if (secretFields.has(k)) {
            hadSecrets = true;
          } else if (ignoredFields.has(k)) {
            hadIgnored = true;
          } else {
            sanitized[k] = v;
          }
        }
        if (hadSecrets) {
          logger.warn(
            {
              projectId,
              removedFields: [...secretFields].filter((f) => f in payload),
            },
            'open-design:setup: secret fields removed from config; use Vault for keys',
          );
        }
        if (hadIgnored) {
          logger.info(
            {
              projectId,
              ignored: [...ignoredFields].filter((f) => f in payload),
            },
            'open-design:setup: legacy fields ignored (vendor path is internal now)',
          );
        }
        setOpenDesignConfig(
          projectId,
          sanitized as Parameters<typeof setOpenDesignConfig>[1],
        );
        return { ok: true };
      } catch (err) {
        logger.error({ err, projectId }, 'open-design:setup failed');
        return { error: String(err) };
      }
    },
  );

  ipcMain.handle('open-design:boot-install-status', async () => {
    const { getBootInstallStatus } =
      await import('../open-design/boot-installer');
    return getBootInstallStatus();
  });

  ipcMain.handle('open-design:boot-install-retry', async () => {
    try {
      const { retryBootInstall } = await import('../open-design/boot-installer');
      return await retryBootInstall();
    } catch (err) {
      logger.error({ err }, 'open-design:boot-install-retry failed');
      return {
        kind: 'failed',
        error: String(err),
        failedAt: new Date().toISOString(),
      };
    }
  });

  ipcMain.handle(
    'open-design:get-session-config',
    async (_event, projectId: string) => {
      try {
        const { getSessionConfig } =
          await import('../open-design/session-config');
        return getSessionConfig(projectId);
      } catch (err) {
        logger.error(
          { err, projectId },
          'open-design:get-session-config failed',
        );
        return null;
      }
    },
  );

  ipcMain.handle(
    'open-design:set-session-config',
    async (_event, projectId: string, cfg: unknown) => {
      try {
        const { setSessionConfig } =
          await import('../open-design/session-config');
        setSessionConfig(
          projectId,
          cfg as Parameters<typeof setSessionConfig>[1],
        );
        return { ok: true } as const;
      } catch (err) {
        logger.warn(
          { err, projectId },
          'open-design:set-session-config rejected',
        );
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'open-design:ensure-session',
    async (_event, projectId: string) => {
      try {
        const { ensureSession } = await import('../open-design/bootstrap');
        return await ensureSession(projectId);
      } catch (err) {
        logger.error({ err, projectId }, 'open-design:ensure-session failed');
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'open-design:get-start-status',
    async (_event, projectId: string) => {
      try {
        const { isDriveEngaged } = await import('../db');
        const { isDriveStartPending } = await import('../open-design/drive-autostart');
        return {
          driveEngaged: isDriveEngaged(projectId),
          startPending: isDriveStartPending(projectId),
        };
      } catch (err) {
        logger.error({ err, projectId }, 'open-design:get-start-status failed');
        return { driveEngaged: false, startPending: false };
      }
    },
  );

  ipcMain.handle('open-design:start', async (_event, projectId: string) => {
    try {
      const { start } = await import('../open-design/manager');
      return start(projectId);
    } catch (err) {
      logger.error({ err, projectId }, 'open-design:start failed');
      return { error: String(err) };
    }
  });

  ipcMain.handle('open-design:stop', async (_event, projectId: string) => {
    try {
      const { stop } = await import('../open-design/manager');
      return stop(projectId);
    } catch (err) {
      logger.error({ err, projectId }, 'open-design:stop failed');
      return { error: String(err) };
    }
  });

  ipcMain.handle('open-design:restart', async (_event, projectId: string) => {
    try {
      const { restart } = await import('../open-design/manager');
      return restart(projectId);
    } catch (err) {
      logger.error({ err, projectId }, 'open-design:restart failed');
      return { error: String(err) };
    }
  });

  ipcMain.handle('open-design:status', async (_event, projectId: string) => {
    try {
      const { status } = await import('../open-design/manager');
      return status(projectId);
    } catch (err) {
      logger.error({ err, projectId }, 'open-design:status failed');
      return { error: String(err) };
    }
  });

  ipcMain.handle(
    'open-design:build-initial-prompt',
    async (_event, projectId: string) => {
      try {
        const { buildInitialPrompt } =
          await import('../open-design/prompt-builder');
        return await buildInitialPrompt(projectId);
      } catch (err) {
        logger.error(
          { err, projectId },
          'open-design:build-initial-prompt failed',
        );
        return { error: String(err) };
      }
    },
  );

  ipcMain.handle(
    'open-design:inject-initial-prompt',
    async (_event, projectId: string) => {
      try {
        const { buildInitialPrompt } =
          await import('../open-design/prompt-builder');
        const result = await buildInitialPrompt(projectId);
        if ('error' in result) return result;
        const { clipboard } = await import('electron');
        clipboard.writeText(result.prompt);
        return { ok: true, mode: 'clipboard', prompt: result.prompt } as const;
      } catch (err) {
        logger.error(
          { err, projectId },
          'open-design:inject-initial-prompt failed',
        );
        return { error: String(err) };
      }
    },
  );

  ipcMain.handle('open-design:snapshot', async (_event, projectId: string) => {
    try {
      const { captureSnapshot } = await import('../open-design/snapshot');
      return await captureSnapshot(projectId);
    } catch (err) {
      logger.error({ err, projectId }, 'open-design:snapshot failed');
      return { error: String(err) };
    }
  });

  ipcMain.handle('open-design:lock', () => {
    return {
      error:
        'Use pipeline:approve na fase 5; open-design:lock e interno do PipelineEngine',
    };
  });

  ipcMain.handle(
    'open-design:get-locked-snapshot',
    async (_event, projectId: string) => {
      try {
        const { getOpenDesignConfig } = await import('../open-design/config');
        const cfg = getOpenDesignConfig(projectId);
        if (!cfg?.runDir) return { error: 'not-locked' };
        if (!cfg.locked) return { error: 'not-locked' };

        const snapshotDir = path.join(
          cfg.runDir,
          'open-design',
          'snapshots',
          'latest',
        );
        const manifestPath =
          cfg.manifestPath ?? path.join(snapshotDir, 'manifest.json');
        const contractPath =
          cfg.contractPath ?? path.join(snapshotDir, 'design-contract.json');
        const artifactHtmlPath =
          cfg.artifactHtmlPath ??
          path.join(snapshotDir, 'artifact', 'index.html');

        if (!fs.existsSync(artifactHtmlPath)) return { error: 'not-locked' };

        return {
          ok: true,
          paths: { snapshotDir, manifestPath, contractPath, artifactHtmlPath },
          lockedAt: cfg.lockedAt ?? null,
        };
      } catch (err) {
        logger.error(
          { err, projectId },
          'open-design:get-locked-snapshot failed',
        );
        return { error: String(err) };
      }
    },
  );

  ipcMain.handle(
    'open-design:destructive-unlock',
    async (_event, projectId: string, confirmation: string) => {
      try {
        const { destructiveUnlock } =
          await import('../open-design/escape-hatch');
        return await destructiveUnlock(projectId, confirmation);
      } catch (err) {
        logger.error(
          { err, projectId },
          'open-design:destructive-unlock failed',
        );
        return { error: String(err) };
      }
    },
  );

  ipcMain.handle(
    'open-design:open-artifact',
    async (_event, projectId: string) => {
      try {
        const { getOpenDesignConfig } = await import('../open-design/config');
        const cfg = getOpenDesignConfig(projectId);
        if (!cfg?.runDir) return { error: 'not-locked' };
        const htmlPath =
          cfg.artifactHtmlPath ??
          path.join(
            cfg.runDir,
            'open-design',
            'snapshots',
            'latest',
            'artifact',
            'index.html',
          );
        if (!fs.existsSync(htmlPath)) return { error: 'not-locked' };
        return { ok: true, htmlPath } as const;
      } catch (err) {
        logger.error({ err, projectId }, 'open-design:open-artifact failed');
        return { error: String(err) };
      }
    },
  );

  ipcMain.handle(
    'open-design:read-locked-html',
    async (_event, projectId: string) => {
      try {
        const { getOpenDesignConfig } = await import('../open-design/config');
        const cfg = getOpenDesignConfig(projectId);
        if (!cfg?.runDir) return { error: 'not-locked' };
        const htmlPath =
          cfg.artifactHtmlPath ??
          path.join(
            cfg.runDir,
            'open-design',
            'snapshots',
            'latest',
            'artifact',
            'index.html',
          );
        const snapshotDir =
          cfg.snapshotDir ??
          path.join(cfg.runDir, 'open-design', 'snapshots', 'latest');
        const resolvedHtml = path.resolve(htmlPath);
        const resolvedDir = path.resolve(snapshotDir);
        if (
          !resolvedHtml.startsWith(resolvedDir + path.sep) &&
          resolvedHtml !== resolvedDir
        ) {
          return { error: 'path fora do snapshotDir do projeto' };
        }
        if (!fs.existsSync(resolvedHtml)) return { error: 'not-locked' };
        const content = fs.readFileSync(resolvedHtml, 'utf-8');
        return { ok: true, html: content, htmlPath: resolvedHtml } as const;
      } catch (err) {
        logger.error({ err, projectId }, 'open-design:read-locked-html failed');
        return { error: String(err) };
      }
    },
  );

  ipcMain.handle(
    'open-design:set-view-bounds',
    (
      _event,
      bounds: { x: number; y: number; width: number; height: number },
    ) => {
      try {
        setODViewBounds(bounds);
        return { ok: true };
      } catch (err) {
        logger.error({ err }, 'open-design:set-view-bounds failed');
        return { error: String(err) };
      }
    },
  );

  ipcMain.handle(
    'open-design:show-view',
    (
      _event,
      url: string,
      bounds: { x: number; y: number; width: number; height: number },
    ) => {
      try {
        const win = getMainWindow();
        if (!win || win.isDestroyed()) return { error: 'no-main-window' };
        showODView(win, url, bounds);
        return { ok: true };
      } catch (err) {
        logger.error({ err }, 'open-design:show-view failed');
        return { error: String(err) };
      }
    },
  );

  ipcMain.handle('open-design:hide-view', () => {
    try {
      hideODView();
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'open-design:hide-view failed');
      return { error: String(err) };
    }
  });

  ipcMain.handle(
    'pricing:calculate',
    (
      _event,
      input: {
        runtime: OrchestratorRuntime;
        provider: OrchestratorProvider;
        model: string;
        presetId?: OpenAiCompatiblePreset | string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      },
    ) => {
      return pricingCalculate(input);
    },
  );
}
