import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_UPLOAD_EXT_MIMES,
  assertKnowledgeIngestFileSupported,
  isKnowledgeVideoFile,
  knowledgeIngestExtension,
  validateKnowledgeUploadFile,
} from '../src/constants/knowledge-ingest-files';

describe('política de ingestão da Base de Conhecimento v4', () => {
  it.each([
    'video.mp4',
    'clip.WEBM',
    '/tmp/a path/movie.mov',
    'C:\\uploads\\capture.avi',
    'archive.mkv',
  ])('rejeita vídeo antes de criar job: %s', (file) => {
    expect(isKnowledgeVideoFile(file)).toBe(true);
    expect(() => assertKnowledgeIngestFileSupported(file)).toThrow(
      'Ingestão de vídeo não é suportada na Base de Conhecimento v4',
    );
  });

  it.each(['audio.mp3', 'audio.m4a', 'audio.wav', 'audio.ogg', 'audio.flac'])(
    'preserva formatos normais de áudio: %s',
    (file) => {
      expect(() => assertKnowledgeIngestFileSupported(file)).not.toThrow();
    },
  );

  it('não deixa filename falso ocultar extensão de vídeo do path', () => {
    expect(() =>
      assertKnowledgeIngestFileSupported('/tmp/payload.mp4', 'anotacoes.txt'),
    ).toThrow('(.mp4)');
    expect(knowledgeIngestExtension('/tmp/SEM-EXTENSAO')).toBe('');
  });

  it.each([
    ['movie.mp4', 'audio/mpeg'],
    ['movie.MP4', 'video/mp4'],
    ['recording.webm', 'audio/webm'],
    ['recording.WEBM', 'video/webm'],
    ['movie.mov', 'video/quicktime'],
    ['movie.avi', 'video/x-msvideo'],
    ['movie.mkv', 'video/x-matroska'],
    ['audio.mp3', 'video/mp4'],
    ['audio.m4a', 'video/mp4'],
  ])('UI rejeita extensão/MIME de vídeo: %s (%s)', (name, type) => {
    expect(validateKnowledgeUploadFile({ name, type, size: 1 }, 1024)).toEqual({
      ok: false,
      reason: expect.any(String),
    });
  });

  it.each([
    ['audio.mp3', 'audio/mpeg'],
    ['audio.m4a', 'audio/mp4'],
    ['audio.wav', 'audio/wav'],
    ['audio.ogg', 'audio/ogg'],
    ['audio.flac', 'audio/flac'],
  ])('UI preserva áudio suportado: %s (%s)', (name, type) => {
    expect(validateKnowledgeUploadFile({ name, type, size: 1 }, 1024)).toEqual({
      ok: true,
      extension: knowledgeIngestExtension(name),
    });
  });

  it('remove vídeo da UI e de todos os entrypoints backend sem tocar no áudio', () => {
    const root = process.cwd();
    const upload = readFileSync(
      join(root, 'src/components/graph-view/UploadDropZone.tsx'),
      'utf8',
    );
    expect(upload).not.toContain("'.mp4'");
    expect(upload).not.toContain("'.webm'");
    expect(upload).not.toContain('Vídeo');
    expect(Object.keys(KNOWLEDGE_UPLOAD_EXT_MIMES)).toEqual(expect.arrayContaining([
      '.mp3', '.m4a', '.wav', '.ogg', '.flac',
    ]));
    expect(upload).toContain('Imagens e Áudio');

    const ingest = readFileSync(join(root, 'electron/main/graph-ingest.ts'), 'utf8');
    expect(ingest).not.toContain('extractVideo');
    expect(ingest).not.toContain('checkFfmpegAvailable');
    expect(ingest).not.toContain('resolveFfmpegPath');
    expect(ingest).not.toContain('MAX_AUDIO_MINUTES');
    expect(ingest).toContain('return extractAudio(filePath)');
    expect(ingest).toMatch(
      /estimateIngestFile[\s\S]*assertKnowledgeIngestFileSupported\(filePath\)[\s\S]*assertIngestFileSize\(filePath\)/,
    );
    expect(ingest).toMatch(
      /ingestFile[\s\S]*assertKnowledgeIngestFileSupported\(filePath, fileName\)[\s\S]*assertIngestFileSize\(filePath\)/,
    );
    expect(ingest).toMatch(
      /resumeIngestJob[\s\S]*assertKnowledgeIngestFileSupported\(job\.fileName, job\.originalPath\)[\s\S]*assertIngestFileSize\(job\.originalPath\)/,
    );
  });

  it('mantém vídeo fora da Knowledge sem remover artifacts e Higgsfield', () => {
    const root = process.cwd();
    expect(
      readFileSync(join(root, 'electron/main/artifact-detector.ts'), 'utf8'),
    ).toContain("'.mp4': 'video/mp4'");
    expect(
      readFileSync(join(root, 'electron/main/vault-registry.ts'), 'utf8'),
    ).toContain('geracao de imagens, videos');
  });
});
