export const KNOWLEDGE_VIDEO_EXTENSIONS = Object.freeze([
  '.mp4',
  '.webm',
  '.mov',
  '.avi',
  '.mkv',
]);

export const KNOWLEDGE_UPLOAD_EXT_MIMES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    '.pdf': ['application/pdf'],
    '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    '.csv': ['text/csv', 'application/csv', 'text/plain'],
    '.md': ['text/markdown', 'text/plain', 'text/x-markdown'],
    '.txt': ['text/plain'],
    '.png': ['image/png'],
    '.jpg': ['image/jpeg'],
    '.jpeg': ['image/jpeg'],
    '.webp': ['image/webp'],
    '.mp3': ['audio/mpeg', 'audio/mp3'],
    '.m4a': ['audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/mpeg'],
    '.wav': ['audio/wav', 'audio/wave', 'audio/x-wav'],
    '.ogg': ['audio/ogg'],
    '.flac': ['audio/flac', 'audio/x-flac'],
  });

export const KNOWLEDGE_AUDIO_EXTENSIONS = Object.freeze([
  '.mp3',
  '.m4a',
  '.wav',
  '.ogg',
  '.flac',
]);

const KNOWLEDGE_TEXT_LIKE_EXTENSIONS = new Set(['.md', '.csv', '.txt']);

const KNOWLEDGE_VIDEO_EXTENSION_SET = new Set<string>(KNOWLEDGE_VIDEO_EXTENSIONS);

export function knowledgeIngestExtension(filePathOrName: string): string {
  const normalized = filePathOrName.trim().toLowerCase();
  const separator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  const basename = normalized.slice(separator + 1);
  const dot = basename.lastIndexOf('.');
  return dot >= 0 ? basename.slice(dot) : '';
}

export function isKnowledgeVideoFile(filePathOrName: string): boolean {
  return KNOWLEDGE_VIDEO_EXTENSION_SET.has(knowledgeIngestExtension(filePathOrName));
}

export function assertKnowledgeIngestFileSupported(
  ...filePathsOrNames: string[]
): void {
  const video = filePathsOrNames.find(isKnowledgeVideoFile);
  if (video) {
    throw new Error(
      `Ingestão de vídeo não é suportada na Base de Conhecimento v4 (${knowledgeIngestExtension(video)}).`,
    );
  }
}

export function validateKnowledgeUploadFile(
  file: { name: string; type: string; size: number },
  maxBytes: number,
): { ok: true; extension: string } | { ok: false; reason: string } {
  const extension = knowledgeIngestExtension(file.name);
  const allowedMimes = KNOWLEDGE_UPLOAD_EXT_MIMES[extension];

  if (!allowedMimes) {
    return { ok: false, reason: 'tipo não suportado' };
  }
  if (file.size > maxBytes) {
    return {
      ok: false,
      reason: `excede ${(maxBytes / 1024 / 1024).toFixed(0)}MB`,
    };
  }
  if (
    file.type &&
    !allowedMimes.includes(file.type) &&
    !(KNOWLEDGE_TEXT_LIKE_EXTENSIONS.has(extension) && file.type === 'text/plain')
  ) {
    return { ok: false, reason: `MIME incompatível (${file.type})` };
  }

  return { ok: true, extension };
}
