import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: new Map<string, string>([
    ['mgraph_mode', 'true'],
    ['ingest_stt_provider', 'whisper'],
    ['ingest_max_file_size_mb', '1'],
  ]),
  jobs: new Map<string, Record<string, unknown>>(),
  insertIngestJob: vi.fn(),
  updateIngestJob: vi.fn(),
  transcribeAudioFile: vi.fn(async () => 'whisper ok'),
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  getSecret: vi.fn(async () => 'elevenlabs-key'),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      state.ipcHandlers.set(channel, handler);
    },
  },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../db', () => ({
  getSetting: (key: string) => state.settings.get(key),
  setSetting: (key: string, value: string) => state.settings.set(key, value),
  insertIngestJob: state.insertIngestJob,
  updateIngestJob: state.updateIngestJob,
  getIngestJob: (id: string) => state.jobs.get(id),
  getIngestJobByHash: vi.fn(() => undefined),
  getAllIngestJobs: vi.fn(() => []),
}));

vi.mock('../mgraph-engine', () => ({
  getVaultRoot: () => path.join(os.tmpdir(), 'lionclaw-knowledge-video-vault'),
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
  transcribeAudioFile: state.transcribeAudioFile,
}));

vi.mock('../secrets-vault', () => ({
  getSecret: state.getSecret,
}));

import { estimateIngestFile, extractAudio, ingestFile, processIngestJob, resumeIngestJob } from '../graph-ingest';
import { registerMgraphHandlers } from '../ipc/mgraph';

const tempPaths: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-video-policy-'));
  tempPaths.push(dir);
  return dir;
}

beforeEach(() => {
  state.settings.set('mgraph_mode', 'true');
  state.settings.set('ingest_stt_provider', 'whisper');
  state.settings.set('ingest_max_file_size_mb', '1');
  state.jobs.clear();
  state.insertIngestJob.mockClear();
  state.updateIngestJob.mockClear();
  state.transcribeAudioFile.mockClear();
  state.getSecret.mockClear();
  state.ipcHandlers.clear();
});

afterEach(() => {
  while (tempPaths.length > 0) {
    fs.rmSync(tempPaths.pop() as string, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

describe('Knowledge rejeita vídeo antes de qualquer mutação', () => {
  it.each(['MP4', 'webm', 'MoV', 'AVI', 'mKv'])(
    'ingestFile rejeita .%s antes de copiar ou criar job',
    async (extension) => {
      const dir = tempDir();
      const source = path.join(dir, `payload.${extension}`);
      fs.writeFileSync(source, 'canary');
      const copySpy = vi.spyOn(fs, 'copyFileSync');

      await expect(ingestFile(source, 'documento.txt')).rejects.toThrow('Ingestão de vídeo não é suportada');
      expect(copySpy).not.toHaveBeenCalled();
      expect(state.insertIngestJob).not.toHaveBeenCalled();
      expect(state.updateIngestJob).not.toHaveBeenCalled();
      copySpy.mockRestore();
    },
  );

  it('estimate rejeita pelo path antes de ler ou transcrever', async () => {
    await expect(estimateIngestFile('/arquivo/inexistente/clipe.mp4')).rejects.toThrow(
      'Ingestão de vídeo não é suportada',
    );
    expect(state.transcribeAudioFile).not.toHaveBeenCalled();
  });

  it('resume rejeita filename/path spoof antes de atualizar estado', async () => {
    const dir = tempDir();
    const originalPath = path.join(dir, 'upload.txt');
    fs.writeFileSync(originalPath, 'canary');
    state.jobs.set('video-job', {
      id: 'video-job',
      fileName: 'original.WEBM',
      originalPath,
      sourceType: 'txt',
      status: 'failed',
      lastProcessedChunk: 0,
      notesCreated: 0,
      notesUpdated: 0,
    });

    await expect(resumeIngestJob('video-job')).rejects.toThrow('Ingestão de vídeo não é suportada');
    expect(state.updateIngestJob).not.toHaveBeenCalled();
  });

  it('fila rejeita vídeo antes de apagar o arquivo do job', async () => {
    const dir = tempDir();
    const queued = path.join(dir, 'job.json');
    fs.writeFileSync(
      queued,
      JSON.stringify({
        type: 'file',
        content: path.join(dir, 'payload.mp4'),
        title: 'anotacoes.txt',
        timestamp: new Date(0).toISOString(),
      }),
    );

    await processIngestJob(queued);

    expect(fs.existsSync(queued)).toBe(true);
    expect(state.insertIngestJob).not.toHaveBeenCalled();
    expect(state.updateIngestJob).not.toHaveBeenCalled();
  });

  it('IPC devolve {error} tipado sem criar job', async () => {
    registerMgraphHandlers({ getMainWindow: () => null } as never);
    const handler = state.ipcHandlers.get('mgraph:ingest-file');
    expect(handler).toBeTypeOf('function');

    const result = await handler?.({}, '/tmp/video.mp4', 'nota.txt');

    expect(result).toEqual({
      error: expect.stringContaining('Ingestão de vídeo não é suportada'),
    });
    expect(state.insertIngestJob).not.toHaveBeenCalled();
  });
});

describe('áudio permanece funcional e limitado', () => {
  it.each(['mp3', 'm4a', 'wav', 'ogg', 'flac'])(
    'encaminha .%s para a API OpenAI pelo mesmo seam',
    async (extension) => {
      await expect(extractAudio(`/tmp/audio.${extension}`)).resolves.toBe('whisper ok');
      expect(state.transcribeAudioFile).toHaveBeenLastCalledWith(`/tmp/audio.${extension}`);
    },
  );

  it('mantém ElevenLabs scribe_v1', async () => {
    const dir = tempDir();
    const audioPath = path.join(dir, 'audio.m4a');
    fs.writeFileSync(audioPath, 'audio');
    state.settings.set('ingest_stt_provider', 'elevenlabs');
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const formData = init?.body as FormData;
      expect(formData.get('model_id')).toBe('scribe_v1');
      return new Response(JSON.stringify({ text: 'elevenlabs ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(extractAudio(audioPath)).resolves.toBe('elevenlabs ok');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.elevenlabs.io/v1/speech-to-text',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('limite de arquivo e autoritativo no backend', () => {
  function oversizedFile(extension = 'txt'): string {
    const dir = tempDir();
    const filePath = path.join(dir, `oversized.${extension}`);
    fs.writeFileSync(filePath, '0123456789');
    state.settings.set('ingest_max_file_size_mb', '0.000001');
    return filePath;
  }

  it('estimateIngestFile rejeita antes de extrair', async () => {
    const filePath = oversizedFile();
    await expect(estimateIngestFile(filePath)).rejects.toThrow('File too large');
  });

  it('ingestFile rejeita antes de copiar ou criar job', async () => {
    const filePath = oversizedFile();
    const copySpy = vi.spyOn(fs, 'copyFileSync');

    await expect(ingestFile(filePath, 'oversized.txt')).rejects.toThrow('File too large');
    expect(copySpy).not.toHaveBeenCalled();
    expect(state.insertIngestJob).not.toHaveBeenCalled();
    copySpy.mockRestore();
  });

  it('resumeIngestJob rejeita antes de atualizar estado', async () => {
    const filePath = oversizedFile();
    state.jobs.set('oversized-job', {
      id: 'oversized-job',
      fileName: 'oversized.txt',
      originalPath: filePath,
      sourceType: 'txt',
      status: 'failed',
      lastProcessedChunk: 0,
      notesCreated: 0,
      notesUpdated: 0,
    });

    await expect(resumeIngestJob('oversized-job')).rejects.toThrow('File too large');
    expect(state.updateIngestJob).not.toHaveBeenCalled();
  });
});
