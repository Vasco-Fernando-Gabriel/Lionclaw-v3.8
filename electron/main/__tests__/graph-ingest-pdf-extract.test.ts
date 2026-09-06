import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../db', () => ({
  getSetting: vi.fn(() => undefined),
  setSetting: vi.fn(),
  insertIngestJob: vi.fn(),
  updateIngestJob: vi.fn(),
  getIngestJob: vi.fn(() => undefined),
  getIngestJobByHash: vi.fn(() => undefined),
  getAllIngestJobs: vi.fn(() => []),
}));

vi.mock('../mgraph-engine', () => ({
  getVaultRoot: () => path.join(os.tmpdir(), 'lionclaw-pdf-extract-vault'),
  executeVaultOperation: vi.fn(),
  regenerateVaultIndex: vi.fn(),
  updateVaultHot: vi.fn(),
  snapshotBeforeUpdate: vi.fn(),
  cleanOldSnapshots: vi.fn(),
  getExistingVaultFilesList: vi.fn(() => []),
  appendVaultLog: vi.fn(),
  deleteVaultNote: vi.fn(),
  buildGraphData: vi.fn(),
  readVaultNote: vi.fn(),
  searchVault: vi.fn(),
  createVaultStructure: vi.fn(),
  getVaultStats: vi.fn(),
  seedVault: vi.fn(),
  listNotesByType: vi.fn(),
  findBacklinks: vi.fn(),
}));

vi.mock('../voice-engine', () => ({
  transcribeAudioFile: vi.fn(),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(),
}));

import { extractPdfText } from '../graph-ingest';

describe('extractPdfText (Knowledge v4, unpdf real)', () => {
  it('extrai texto de um PDF minimo com o unpdf instalado', async () => {
    const fixture = path.join(__dirname, 'fixtures', 'hello-lionclaw.pdf');
    const { text, quality } = await extractPdfText(fixture);
    expect(text).toContain('Hello LionClaw');
    expect(quality).toBe('poor');
  });
});
