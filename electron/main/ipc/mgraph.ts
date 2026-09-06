import { ipcMain } from 'electron';
import { createLogger } from '../logger';
import { getSetting, setSetting } from '../db';
import {
  buildGraphData,
  readVaultNote,
  searchVault,
  createVaultStructure,
  getVaultStats,
  seedVault,
  listNotesByType,
  findBacklinks,
  deleteVaultNote,
} from '../mgraph-engine';
import {
  ingestFile,
  ingestUrl,
  ingestText,
  resumeIngestJob,
  cancelIngest,
  discardPartialJob,
  acceptPartialJob,
  getIngestHistory,
  estimateIngestFile,
} from '../graph-ingest';
import type { IpcContext } from './context';

const logger = createLogger('ipc');

export function registerMgraphHandlers(ctx: IpcContext): void {
  const { getMainWindow } = ctx;

  const mgraphDisabled = () => ({
    error: 'mgraph desabilitado nesta build' as const,
  });
  const isMgraphEnabled = () => getSetting('mgraph_mode') === 'true';

  ipcMain.handle('mgraph:graph', () => {
    if (!isMgraphEnabled()) return mgraphDisabled();
    try {
      return buildGraphData();
    } catch (err) {
      logger.error({ err }, 'mgraph:graph failed');
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('mgraph:read', (_event, notePath: string) => {
    if (!isMgraphEnabled()) return mgraphDisabled();
    try {
      return readVaultNote(notePath);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('mgraph:search', (_event, query: string) => {
    if (!isMgraphEnabled()) return mgraphDisabled();
    try {
      return searchVault(query);
    } catch (err) {
      logger.error({ err }, 'mgraph:search failed');
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('mgraph:seed', async (_event, forceReseed?: boolean) => {
    if (!isMgraphEnabled()) return mgraphDisabled();
    const win = getMainWindow();
    try {
      const result = await seedVault(win, forceReseed === true);
      logger.info(
        { notes: result.notes, connections: result.connections },
        'Vault seed completed',
      );
      return result;
    } catch (err) {
      logger.error({ err }, 'Vault seed failed');
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('mgraph:stats', () => {
    if (!isMgraphEnabled()) return mgraphDisabled();
    try {
      return getVaultStats();
    } catch (err) {
      logger.error({ err }, 'mgraph:stats failed');
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('mgraph:list-notes', (_event, type: string) => {
    if (!isMgraphEnabled()) return mgraphDisabled();
    try {
      return listNotesByType(type);
    } catch (err) {
      logger.error({ err }, 'mgraph:list-notes failed');
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    'mgraph:delete-note',
    (_event, notePath: string, options?: { force?: boolean }) => {
      if (!isMgraphEnabled()) return mgraphDisabled();
      try {
        return deleteVaultNote(notePath, options);
      } catch (err) {
        logger.error({ err }, 'mgraph:delete-note failed');
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle('mgraph:note-backlinks', (_event, notePath: string) => {
    if (!isMgraphEnabled()) return mgraphDisabled();
    try {
      return findBacklinks(notePath);
    } catch (err) {
      logger.error({ err }, 'mgraph:note-backlinks failed');
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });


  ipcMain.handle(
    'mgraph:ingest-file',
    async (_event, filePath: string, fileName: string) => {
      if (!isMgraphEnabled()) return mgraphDisabled();
      try {
        return await ingestFile(filePath, fileName);
      } catch (err) {
        logger.error({ err }, 'mgraph:ingest-file failed');
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('mgraph:ingest-url', async (_event, url: string) => {
    if (!isMgraphEnabled()) return mgraphDisabled();
    try {
      return await ingestUrl(url);
    } catch (err) {
      logger.error({ err }, 'mgraph:ingest-url failed');
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    'mgraph:ingest-text',
    async (_event, text: string, title?: string) => {
      if (!isMgraphEnabled()) return mgraphDisabled();
      try {
        return await ingestText(text, title);
      } catch (err) {
        logger.error({ err }, 'mgraph:ingest-text failed');
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('mgraph:ingest-resume', async (_event, jobId: string) => {
    if (!isMgraphEnabled()) return mgraphDisabled();
    try {
      return await resumeIngestJob(jobId);
    } catch (err) {
      logger.error({ err }, 'mgraph:ingest-resume failed');
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('mgraph:ingest-history', () => {
    if (!isMgraphEnabled()) return [];
    try {
      return getIngestHistory();
    } catch (err) {
      logger.error({ err }, 'mgraph:ingest-history failed');
      return [];
    }
  });

  ipcMain.handle('mgraph:ingest-cancel', (_event, jobId: string) => {
    if (!isMgraphEnabled()) return mgraphDisabled();
    cancelIngest(jobId);
    return { ok: true as const };
  });

  ipcMain.handle('mgraph:ingest-estimate', async (_event, filePath: string) => {
    if (!isMgraphEnabled()) return mgraphDisabled();
    try {
      return await estimateIngestFile(filePath);
    } catch (err) {
      logger.error({ err }, 'mgraph:ingest-estimate failed');
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('mgraph:ingest-discard', (_event, jobId: string) => {
    if (!isMgraphEnabled()) return mgraphDisabled();
    try {
      discardPartialJob(jobId);
      return { ok: true as const };
    } catch (err) {
      logger.error({ err }, 'mgraph:ingest-discard failed');
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('mgraph:ingest-accept', (_event, jobId: string) => {
    if (!isMgraphEnabled()) return mgraphDisabled();
    try {
      acceptPartialJob(jobId);
      return { ok: true as const };
    } catch (err) {
      logger.error({ err }, 'mgraph:ingest-accept failed');
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('mgraph:ingest-settings', () => {
    if (!isMgraphEnabled()) return mgraphDisabled();
    return {
      visionModel: (getSetting('ingest_vision_model') as string) || '',
      extractionModel: (getSetting('ingest_extraction_model') as string) || '',
      sttProvider: (getSetting('ingest_stt_provider') as string) || 'whisper',
      maxFileSizeMb: Number(getSetting('ingest_max_file_size_mb')) || 100,
      maxChunks: Number(getSetting('ingest_max_chunks')) || 30,
      autoConfirm: getSetting('ingest_auto_confirm') === 'true',
      pdfExtractor: (getSetting('ingest_pdf_extractor') as string) || 'auto',
      urlLevel: Number(getSetting('ingest_url_level')) || 3,
    };
  });

  ipcMain.handle(
    'mgraph:ingest-settings-update',
    (_event, settings: Record<string, string>) => {
      if (!isMgraphEnabled()) return mgraphDisabled();
      for (const [key, value] of Object.entries(settings)) {
        const settingKey = `ingest_${key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())}`;
        setSetting(settingKey, String(value));
      }
      return { ok: true as const };
    },
  );

  if (isMgraphEnabled()) {
    createVaultStructure();
    logger.info('Memory Graph handlers registered (enabled)');
  } else {
    logger.info(
      'Memory Graph handlers registered (disabled — handlers return error)',
    );
  }
}
