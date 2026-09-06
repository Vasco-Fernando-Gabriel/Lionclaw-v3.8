import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { storeExcalidrawView } from './excalidraw-views';
import type { ArtifactData } from '../../src/types';

const logger = createLogger('artifact-detector');


function isExcalidrawTool(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('excalidraw') && (
    lower.endsWith('create_view') ||
    lower.endsWith('export_to_excalidraw') ||
    lower.endsWith('save_checkpoint')
  );
}


function buildExcalidrawFile(elements: unknown[], appState: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'lionclaw',
    elements,
    appState: {
      gridSize: null,
      viewBackgroundColor: '#ffffff',
      ...appState,
    },
    files: {},
  }, null, 2);
}


function extractElements(input: Record<string, unknown>): {
  elements: unknown[];
  appState: Record<string, unknown>;
  title: string;
} | null {
  let rawElements: unknown[] | null = null;
  let appState: Record<string, unknown> = {};

  if (Array.isArray(input.elements)) {
    rawElements = input.elements;
    appState = (input.appState as Record<string, unknown>) || {};
  } else if (typeof input.elements === 'string') {
    try {
      const parsed = JSON.parse(input.elements);
      if (Array.isArray(parsed)) {
        rawElements = parsed;
        appState = (input.appState as Record<string, unknown>) || {};
      }
    } catch { /* ignore */ }
  } else if (typeof input.content === 'string') {
    try {
      const parsed = JSON.parse(input.content);
      if (Array.isArray(parsed.elements)) {
        rawElements = parsed.elements;
        appState = parsed.appState || {};
      } else if (Array.isArray(parsed)) {
        rawElements = parsed;
      }
    } catch { /* ignore */ }
  } else if (Array.isArray(input.content)) {
    rawElements = input.content;
  }

  if (!rawElements || rawElements.length === 0) return null;

  const title = (input.title as string) || (input.name as string) || 'Excalidraw';
  return { elements: rawElements, appState, title };
}

function cleanPathCandidate(raw: string): string {
  let candidate = raw.trim();
  candidate = candidate.replace(/^["'`<]+/, '').replace(/[>"'`]+$/, '');
  candidate = candidate.replace(/[),.;:]+$/, '');
  try {
    return decodeURI(candidate);
  } catch {
    return candidate;
  }
}

function isSupportedImagePath(candidate: string): boolean {
  const ext = path.extname(candidate).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext);
}

function existingImagePath(raw: string): string | null {
  const candidate = cleanPathCandidate(raw);
  if (!isSupportedImagePath(candidate)) return null;
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function firstExistingImagePath(content: string): { imagePath: string; title?: string } | null {
  const explicit = content.match(/ARQUIVO_IMAGEM:\s*((?:\/|[A-Za-z]:\\).+?)(?:\n|\\n|$)/);
  if (explicit) {
    const imagePath = existingImagePath(explicit[1]);
    if (imagePath) return { imagePath };
  }

  const markdownImages = content.matchAll(/!\[([^\]]*)]\(((?:\/|[A-Za-z]:\\)[^)]+)\)/g);
  for (const match of markdownImages) {
    const imagePath = existingImagePath(match[2]);
    if (imagePath) return { imagePath, title: match[1]?.trim() || undefined };
  }

  const labelled = content.matchAll(/(?:Arquivo|Imagem|Image|File):\s*((?:\/|[A-Za-z]:\\).+?\.(?:png|jpe?g|webp|gif))(?:\s|\\n|\n|$)/gi);
  for (const match of labelled) {
    const imagePath = existingImagePath(match[1]);
    if (imagePath) return { imagePath };
  }

  const barePaths = content.matchAll(/((?:\/|[A-Za-z]:\\)[^\n\r"'`<>]+?\.(?:png|jpe?g|webp|gif))(?:[\s).,;]|$)/gi);
  for (const match of barePaths) {
    const imagePath = existingImagePath(match[1]);
    if (imagePath) return { imagePath };
  }

  return null;
}

function buildImageArtifact(toolUseId: string, imagePath: string, content: string, title?: string): ArtifactData | null {
  try {
    const imageBuffer = fs.readFileSync(imagePath);
    const imageBase64 = imageBuffer.toString('base64');
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType =
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.webp' ? 'image/webp'
          : ext === '.gif' ? 'image/gif'
            : 'image/png';

    const promptMatch = content.match(/Prompt:\s*(.+?)(?:\n|\\n|$)/);
    const prompt = promptMatch ? promptMatch[1].trim() : (title || 'Imagem gerada');

    logger.info({ toolUseId, imagePath, sizeBytes: imageBuffer.length }, 'Image file read successfully for artifact');
    return {
      id: crypto.randomUUID(),
      type: 'image',
      title: `Imagem: ${prompt.substring(0, 50)}`,
      toolName: 'nano-banana',
      data: {
        imageBase64,
        mimeType,
        prompt,
        filePath: imagePath,
      },
    };
  } catch (err) {
    logger.warn({ toolUseId, imagePath, err }, 'Image file could not be read for artifact');
    return null;
  }
}


const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

function mimeTypeForExtension(filePath: string): string {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function firstDocumentArtifact(content: string): ArtifactData | null {
  const match = content.match(/ENVIAR_ARQUIVO:\s*((?:\/|[A-Za-z]:\\).+?)(?:\n|\\n|$)/);
  if (!match) return null;

  const filePath = cleanPathCandidate(match[1]);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const fileName = path.basename(filePath);
    logger.info({ filePath, sizeBytes: stat.size }, 'Document artifact detected via ENVIAR_ARQUIVO marker');
    return {
      id: crypto.randomUUID(),
      type: 'document',
      title: `Arquivo: ${fileName}`,
      toolName: 'file-output',
      data: {
        filePath,
        fileName,
        size: stat.size,
        mimeType: mimeTypeForExtension(filePath),
      },
    };
  } catch (err) {
    logger.warn({ filePath, err }, 'ENVIAR_ARQUIVO marker found but file is not accessible');
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeBase64Image(raw: string): { imageBase64: string; mimeType: string } | null {
  const trimmed = raw.trim();
  const dataUrl = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
  if (dataUrl) {
    return {
      mimeType: dataUrl[1].toLowerCase(),
      imageBase64: dataUrl[2].replace(/\s+/g, ''),
    };
  }

  const compact = trimmed.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(compact)) return null;
  if (compact.startsWith('iVBORw0KGgo')) return { imageBase64: compact, mimeType: 'image/png' };
  if (compact.startsWith('/9j/')) return { imageBase64: compact, mimeType: 'image/jpeg' };
  if (compact.startsWith('UklGR')) return { imageBase64: compact, mimeType: 'image/webp' };
  if (compact.startsWith('R0lGOD')) return { imageBase64: compact, mimeType: 'image/gif' };
  return null;
}

function firstString(record: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstInlineImage(content: string): {
  imageBase64: string;
  mimeType: string;
  prompt: string;
  title?: string;
  toolName: string;
} | null {
  const rawImage = normalizeBase64Image(content);
  if (rawImage) {
    return {
      ...rawImage,
      prompt: 'Imagem gerada',
      toolName: 'image-generation',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  const data = asRecord(record?.data);
  const imageRaw =
    firstString(record, ['imageBase64', 'image_base64', 'b64_json', 'result', 'image'])
    ?? firstString(data, ['imageBase64', 'image_base64', 'b64_json', 'result', 'image']);
  if (!imageRaw) return null;

  const image = normalizeBase64Image(imageRaw);
  if (!image) return null;

  const prompt =
    firstString(record, ['prompt', 'revised_prompt', 'revisedPrompt'])
    ?? firstString(data, ['prompt', 'revised_prompt', 'revisedPrompt'])
    ?? 'Imagem gerada';
  const title =
    firstString(record, ['title'])
    ?? firstString(data, ['title']);
  const toolName =
    firstString(record, ['toolName', 'tool_name'])
    ?? firstString(data, ['toolName', 'tool_name'])
    ?? 'image-generation';
  const mimeType =
    firstString(record, ['mimeType', 'mime_type'])
    ?? firstString(data, ['mimeType', 'mime_type'])
    ?? image.mimeType;

  return {
    imageBase64: image.imageBase64,
    mimeType,
    prompt,
    title,
    toolName,
  };
}

function buildInlineImageArtifact(
  toolUseId: string,
  image: {
    imageBase64: string;
    mimeType: string;
    prompt: string;
    title?: string;
    toolName: string;
  },
): ArtifactData {
  logger.info(
    { toolUseId, mimeType: image.mimeType, sizeBytesApprox: Math.floor(image.imageBase64.length * 0.75) },
    'Inline image artifact created',
  );
  return {
    id: crypto.randomUUID(),
    type: 'image',
    title: image.title ?? `Imagem: ${image.prompt.substring(0, 50)}`,
    toolName: image.toolName,
    data: {
      imageBase64: image.imageBase64,
      mimeType: image.mimeType,
      prompt: image.prompt,
    },
  };
}


export function captureToolUse(
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
): ArtifactData | null {
  logger.debug({ toolUseId, toolName }, 'captureToolUse called');

  let effectiveToolName = toolName;
  let effectiveInput = input;
  if (toolName === 'mcp_call') {
    const serverId = typeof input.server_id === 'string' ? input.server_id : '';
    const tool = typeof input.tool === 'string' ? input.tool : '';
    const args = asRecord(input.args);
    if (serverId && tool && args) {
      effectiveToolName = `mcp:${serverId}.${tool}`;
      effectiveInput = args;
    }
  } else if (toolName.startsWith('mcp:')) {
    const args = asRecord(input.args);
    if (args) {
      effectiveInput = args;
    }
  }

  if (!isExcalidrawTool(effectiveToolName)) return null;

  const extracted = extractElements(effectiveInput);
  if (!extracted) {
    logger.warn(
      { toolName: effectiveToolName, inputKeys: Object.keys(effectiveInput) },
      'Excalidraw tool detected but no elements found in input',
    );
    return null;
  }

  const viewId = crypto.randomUUID();

  storeExcalidrawView(viewId, {
    elements: extracted.elements,
    appState: extracted.appState,
    title: extracted.title,
  });

  const excalidrawFile = buildExcalidrawFile(extracted.elements, extracted.appState);

  logger.info(
    { toolName: effectiveToolName, viewId, elementCount: extracted.elements.length, title: extracted.title },
    'Excalidraw artifact created',
  );

  return {
    id: viewId,
    type: 'mcp_app',
    title: extracted.title,
    toolName: effectiveToolName,
    data: {
      viewId,
      excalidrawFile,
    },
  };
}

export function captureToolResult(
  toolUseId: string,
  content: string,
  isError: boolean,
): ArtifactData | null {
  if (isError) return null;

  const document = firstDocumentArtifact(content);
  if (document) return document;

  const inlineImage = firstInlineImage(content);
  if (inlineImage) {
    return buildInlineImageArtifact(toolUseId, inlineImage);
  }

  const image = firstExistingImagePath(content);
  if (image) {
    return buildImageArtifact(toolUseId, image.imagePath, content, image.title);
  }

  const audioMatch = content.match(/ARQUIVO_AUDIO:\s*((?:\/|[A-Za-z]:\\).+?)(?:\n|$)/);
  if (audioMatch) {
    const audioPath = audioMatch[1].trim();
    try {
      const audioBuffer = fs.readFileSync(audioPath);
      const audioBase64 = audioBuffer.toString('base64');
      logger.info({ audioPath, sizeBytes: audioBuffer.length }, 'Audio file read successfully for artifact');
      return {
        id: crypto.randomUUID(),
        type: 'audio',
        title: 'Audio gerado',
        toolName: 'elevenlabs',
        data: {
          audioBase64,
          mimeType: 'audio/mpeg',
          filePath: audioPath,
        },
      };
    } catch (err) {
      logger.warn({ audioPath, err }, 'Audio file could not be read for artifact -- check path exists and is accessible');
    }
  }

  return null;
}

export function resetArtifactDetector(): void {
}
