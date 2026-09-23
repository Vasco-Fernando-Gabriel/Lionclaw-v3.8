import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { promisify } from 'util';
import dns from 'dns';
import { URL } from 'url';
import { BrowserWindow } from 'electron';
import { createLogger } from './logger';
import { getSetting, insertIngestJob, updateIngestJob, getIngestJob, getIngestJobByHash, getAllIngestJobs } from './db';
import {
  getVaultRoot,
  executeVaultOperation,
  regenerateVaultIndex,
  updateVaultHot,
  snapshotBeforeUpdate,
  cleanOldSnapshots,
  getExistingVaultFilesList,
  appendVaultLog,
  deleteVaultNote,
} from './mgraph-engine';
import type { IngestEstimate, IngestSettings, IngestJob, VaultOperation } from '../../src/types';
import { transcribeAudioFile } from './voice-engine';
import { assertKnowledgeIngestFileSupported } from '../../src/constants/knowledge-ingest-files';

const logger = createLogger('graph-ingest');
const dnsResolve = promisify(dns.resolve4);

const MAX_CHUNKS_PER_JOB = 30;
const CHUNK_SIZE = 25000;
const CHUNK_OVERLAP_RATIO = 0.1;
const QUALITY_THRESHOLD = 200;
const URL_MIN_CONTENT = 200;
const MAX_PDF_VISION_PAGES = 20;

const CLAUDE_INPUT_PRICE_PER_TOKEN = 3 / 1_000_000;
const CLAUDE_OUTPUT_PRICE_PER_TOKEN = 15 / 1_000_000;
const ESTIMATED_OUTPUT_TOKENS_PER_CHUNK = 800;

const PRIVATE_RANGES = [
  { prefix: '127.', mask: 8 },
  { prefix: '10.', mask: 8 },
  { prefix: '172.16.', mask: 12 },
  { prefix: '172.17.', mask: 12 },
  { prefix: '172.18.', mask: 12 },
  { prefix: '172.19.', mask: 12 },
  { prefix: '172.20.', mask: 12 },
  { prefix: '172.21.', mask: 12 },
  { prefix: '172.22.', mask: 12 },
  { prefix: '172.23.', mask: 12 },
  { prefix: '172.24.', mask: 12 },
  { prefix: '172.25.', mask: 12 },
  { prefix: '172.26.', mask: 12 },
  { prefix: '172.27.', mask: 12 },
  { prefix: '172.28.', mask: 12 },
  { prefix: '172.29.', mask: 12 },
  { prefix: '172.30.', mask: 12 },
  { prefix: '172.31.', mask: 12 },
  { prefix: '192.168.', mask: 16 },
  { prefix: '169.254.', mask: 16 },
  { prefix: '0.', mask: 8 },
];

function getIngestSettings(): IngestSettings {
  return {
    visionModel: (getSetting('ingest_vision_model') as string) || '',
    extractionModel: (getSetting('ingest_extraction_model') as string) || '',
    sttProvider: (getSetting('ingest_stt_provider') as 'elevenlabs' | 'whisper') || 'whisper',
    maxFileSizeMb: Number(getSetting('ingest_max_file_size_mb')) || 100,
    maxChunks: Number(getSetting('ingest_max_chunks')) || MAX_CHUNKS_PER_JOB,
    autoConfirm: getSetting('ingest_auto_confirm') === 'true',
    pdfExtractor: (getSetting('ingest_pdf_extractor') as 'auto' | 'pdfjs' | 'vision') || 'auto',
    urlLevel: (Number(getSetting('ingest_url_level')) as 1 | 2 | 3) || 3,
  };
}

function assertIngestFileSize(filePath: string): void {
  const { maxFileSizeMb } = getIngestSettings();
  const maxBytes = maxFileSizeMb * 1024 * 1024;
  const sizeBytes = fs.statSync(filePath).size;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error(`Invalid ingest file size limit: ${maxFileSizeMb} MB`);
  }
  if (sizeBytes > maxBytes) {
    throw new Error(`File too large: ${(sizeBytes / 1024 / 1024).toFixed(1)} MB (max ${maxFileSizeMb} MB)`);
  }
}

function isPrivateIP(ip: string): boolean {
  for (const range of PRIVATE_RANGES) {
    if (ip.startsWith(range.prefix)) return true;
  }
  if (ip === '::1' || ip === '::') return true;
  return false;
}

export async function validateUrlSafety(urlStr: string): Promise<{ safe: boolean; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { safe: false, error: 'Invalid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, error: `Schema not allowed: ${parsed.protocol}` };
  }

  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    return { safe: false, error: `Port not allowed: ${parsed.port}` };
  }

  try {
    const addresses = await dnsResolve(parsed.hostname);
    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        return { safe: false, error: `Private IP resolved: ${addr}` };
      }
    }
  } catch {
    if (isPrivateIP(parsed.hostname)) {
      return { safe: false, error: `Private IP not allowed: ${parsed.hostname}` };
    }
  }

  return { safe: true };
}

async function callClaudeVision(imageBase64: string, mimeType: string, prompt: string): Promise<string> {
  const { runVisionPrompt, normalizeVisionMediaType } = await import('./memory-pipeline/oneshot-vision');
  const settings = getIngestSettings();
  return runVisionPrompt(
    [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: normalizeVisionMediaType(mimeType),
          data: imageBase64,
        },
      },
      { type: 'text', text: prompt },
    ],
    { modelOverride: settings.visionModel, maxTokens: 4096 },
  );
}

export async function extractPdfText(filePath: string): Promise<{ text: string; quality: 'good' | 'poor' }> {
  const { getDocumentProxy, extractText } = await import('unpdf');

  const buffer = fs.readFileSync(filePath);
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });

  const charsPerPage = totalPages > 0 ? text.length / totalPages : 0;
  const quality = charsPerPage > QUALITY_THRESHOLD ? 'good' : 'poor';

  logger.info(
    { filePath, totalPages, charsPerPage: Math.round(charsPerPage), quality },
    'PDF text extracted via unpdf',
  );
  return { text, quality };
}

export async function extractPdfVision(filePath: string): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist');
  const { createCanvas } = await import('@napi-rs/canvas');

  const buffer = fs.readFileSync(filePath);
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({ data, useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const totalPages = pdf.numPages;
  const pagesToProcess = Math.min(totalPages, MAX_PDF_VISION_PAGES);

  logger.info({ filePath, totalPages, pagesToProcess }, 'PDF Vision OCR starting');

  const pageTexts: string[] = [];
  const SCALE = 2.0;

  for (let i = 1; i <= pagesToProcess; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: SCALE });

    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');

    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
    }).promise;

    const pngBuffer = canvas.toBuffer('image/png');
    const pngBase64 = pngBuffer.toString('base64');

    const pageText = await callClaudeVision(
      pngBase64,
      'image/png',
      `Extract ALL text from this PDF page image (page ${i} of ${totalPages}). Preserve structure including headings, paragraphs, lists, and tables. Output raw text only, no commentary.`,
    );

    pageTexts.push(pageText);
    logger.info({ filePath, page: i, textLength: pageText.length }, 'PDF page OCR complete');
  }

  const text = pageTexts.join('\n\n---\n\n');
  logger.info({ filePath, textLength: text.length }, 'PDF Vision OCR complete');
  return text;
}

export async function extractPdf(filePath: string): Promise<string> {
  const settings = getIngestSettings();

  if (settings.pdfExtractor === 'vision') {
    return extractPdfVision(filePath);
  }

  if (settings.pdfExtractor === 'pdfjs') {
    const { text } = await extractPdfText(filePath);
    return text;
  }

  const { text, quality } = await extractPdfText(filePath);
  if (quality === 'good') {
    return text;
  }

  logger.info({ filePath }, 'PDF text quality poor, falling back to Vision OCR');
  return extractPdfVision(filePath);
}

export async function extractDocx(filePath: string): Promise<string> {
  const mammoth = await import('mammoth');
  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });

  logger.info({ filePath, textLength: result.value.length }, 'DOCX text extracted');
  return result.value;
}

export async function extractSpreadsheet(filePath: string): Promise<string> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(fs.readFileSync(filePath));
  const parts: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    parts.push(`## ${sheetName}\n`);

    const jsonData = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 });
    if (jsonData.length === 0) continue;

    const headers = (jsonData[0] || []).map((h) => String(h ?? ''));
    const separator = headers.map(() => '---');

    parts.push(`| ${headers.join(' | ')} |`);
    parts.push(`| ${separator.join(' | ')} |`);

    for (let i = 1; i < jsonData.length; i++) {
      const row = (jsonData[i] || []).map((c) => String(c ?? ''));
      while (row.length < headers.length) row.push('');
      parts.push(`| ${row.join(' | ')} |`);
    }

    parts.push('');
  }

  const text = parts.join('\n');
  logger.info({ filePath, textLength: text.length, sheets: workbook.SheetNames.length }, 'Spreadsheet extracted');
  return text;
}

export function extractPlainText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

export async function extractImage(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  };

  const mimeType = mimeMap[ext];
  if (!mimeType) {
    throw new Error(`Unsupported image format: ${ext}. Supported: .png, .jpg, .jpeg, .webp`);
  }

  const imageBase64 = fs.readFileSync(filePath).toString('base64');

  const text = await callClaudeVision(
    imageBase64,
    mimeType,
    'Extract all text and meaningful content from this image. Include any text, labels, data, diagrams, or visual information. Output as structured text/markdown.',
  );

  logger.info({ filePath, textLength: text.length }, 'Image content extracted via Vision');
  return text;
}

export async function extractAudio(filePath: string): Promise<string> {
  const settings = getIngestSettings();

  if (settings.sttProvider === 'elevenlabs') {
    return transcribeWithElevenLabs(filePath);
  }

  return transcribeWithOpenAI(filePath);
}

async function transcribeWithOpenAI(filePath: string): Promise<string> {
  const text = await transcribeAudioFile(filePath);
  logger.info({ filePath, textLength: text.length }, 'OpenAI audio transcription complete');
  return text;
}

async function transcribeWithElevenLabs(filePath: string): Promise<string> {
  const { getSecret } = await import('./secrets-vault');
  const apiKey = await getSecret('ELEVENLABS_API_KEY');
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured for ElevenLabs STT');

  const audioBuffer = fs.readFileSync(filePath);
  const blob = new Blob([audioBuffer], { type: 'audio/mpeg' });

  const formData = new FormData();
  formData.append('file', blob, path.basename(filePath));
  formData.append('model_id', 'scribe_v1');

  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs STT failed: ${response.status} ${errorText}`);
  }

  const result = (await response.json()) as { text?: string };
  logger.info({ filePath, textLength: result.text?.length }, 'ElevenLabs transcription complete');
  return result.text || '';
}

export async function extractUrlLight(url: string): Promise<string> {
  const { JSDOM } = await import('jsdom');
  const { Readability } = await import('@mozilla/readability');
  const TurndownService = (await import('turndown')).default;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LionClaw/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();

    if (!article || !article.content) {
      return '';
    }

    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    });
    const markdown = turndown.turndown(article.content);

    logger.info({ url, textLength: markdown.length }, 'URL extracted via light fetch');
    return markdown;
  } finally {
    clearTimeout(timeout);
  }
}

export async function extractUrlElectron(url: string): Promise<string> {
  const { JSDOM } = await import('jsdom');
  const { Readability } = await import('@mozilla/readability');
  const TurndownService = (await import('turndown')).default;

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  try {
    await win.loadURL(url);

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');

    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();

    if (!article || !article.content) {
      return '';
    }

    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    });
    const markdown = turndown.turndown(article.content);

    logger.info({ url, textLength: markdown.length }, 'URL extracted via Electron BrowserWindow');
    return markdown;
  } finally {
    win.destroy();
  }
}

export async function extractUrlJina(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const response = await fetch(jinaUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'text/markdown',
        'User-Agent': 'Mozilla/5.0 (compatible; LionClaw/1.0)',
      },
    });

    if (!response.ok) {
      throw new Error(`Jina API returned ${response.status}`);
    }

    const markdown = await response.text();
    logger.info({ url, textLength: markdown.length }, 'URL extracted via Jina Reader');
    return markdown;
  } finally {
    clearTimeout(timeout);
  }
}

export async function extractUrl(url: string): Promise<string> {
  const safety = await validateUrlSafety(url);
  if (!safety.safe) {
    throw new Error(`URL blocked (SSRF): ${safety.error}`);
  }

  const settings = getIngestSettings();
  const maxLevel = settings.urlLevel;

  try {
    const text = await extractUrlLight(url);
    if (text.length >= URL_MIN_CONTENT) return text;
    logger.info({ url, textLength: text.length }, 'Level 1 extraction insufficient');
  } catch (err) {
    logger.warn({ url, err }, 'Level 1 extraction failed');
  }

  if (maxLevel < 2) {
    return '';
  }

  try {
    const text = await extractUrlElectron(url);
    if (text.length >= URL_MIN_CONTENT) return text;
    logger.info({ url, textLength: text.length }, 'Level 2 extraction insufficient');
  } catch (err) {
    logger.warn({ url, err }, 'Level 2 extraction failed');
  }

  if (maxLevel < 3) {
    return '';
  }

  try {
    const text = await extractUrlJina(url);
    if (text.length >= URL_MIN_CONTENT) return text;
    logger.info({ url, textLength: text.length }, 'Level 3 extraction insufficient');
  } catch (err) {
    logger.warn({ url, err }, 'Level 3 extraction failed');
  }

  return '';
}

function isTableRow(line: string): boolean {
  return /^\|.*\|$/.test(line.trim());
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line);
}

export function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) {
    return [text];
  }

  const lines = text.split('\n');
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentLength = 0;

  let insideTable = false;
  let tableBuffer: string[] = [];

  function flushChunk() {
    if (currentChunk.length === 0) return;
    chunks.push(currentChunk.join('\n'));
    currentChunk = [];
    currentLength = 0;
  }

  function addOverlap() {
    if (chunks.length === 0) return;
    const lastChunk = chunks[chunks.length - 1];
    const overlapSize = Math.floor(lastChunk.length * CHUNK_OVERLAP_RATIO);
    const overlapText = lastChunk.slice(-overlapSize);

    const newlineIdx = overlapText.indexOf('\n');
    const cleanOverlap = newlineIdx >= 0 ? overlapText.slice(newlineIdx + 1) : overlapText;

    if (cleanOverlap.length > 0) {
      currentChunk.push(cleanOverlap);
      currentLength += cleanOverlap.length;
    }
  }

  for (const line of lines) {
    const lineLen = line.length + 1;

    if (isTableRow(line)) {
      if (!insideTable) {
        insideTable = true;
        tableBuffer = [];
      }
      tableBuffer.push(line);
      continue;
    } else if (insideTable) {
      insideTable = false;
      const tableText = tableBuffer.join('\n');
      const tableLen = tableText.length + 1;

      if (currentLength + tableLen > CHUNK_SIZE && currentChunk.length > 0) {
        flushChunk();
        addOverlap();
      }

      currentChunk.push(tableText);
      currentLength += tableLen;
      tableBuffer = [];
    }

    if (isHeading(line) && currentLength + lineLen > CHUNK_SIZE && currentChunk.length > 0) {
      flushChunk();
      addOverlap();
    }

    if (currentLength + lineLen > CHUNK_SIZE) {
      if (line.trim() === '' && currentChunk.length > 0) {
        flushChunk();
        addOverlap();
        continue;
      }

      if (currentChunk.length > 0) {
        flushChunk();
        addOverlap();
      }
    }

    currentChunk.push(line);
    currentLength += lineLen;
  }

  if (tableBuffer.length > 0) {
    const tableText = tableBuffer.join('\n');
    currentChunk.push(tableText);
  }

  if (currentChunk.length > 0) {
    flushChunk();
  }

  return chunks;
}

function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / 3.5);
}

export function estimateCost(totalInputTokens: number, nChunks: number): number {
  const inputCost = totalInputTokens * CLAUDE_INPUT_PRICE_PER_TOKEN;
  const outputCost = nChunks * ESTIMATED_OUTPUT_TOKENS_PER_CHUNK * CLAUDE_OUTPUT_PRICE_PER_TOKEN;
  return Math.round((inputCost + outputCost) * 10000) / 10000;
}

export function estimateIngest(text: string): IngestEstimate {
  const allChunks = chunkText(text);
  const originalChunkCount = allChunks.length;
  const truncated = originalChunkCount > MAX_CHUNKS_PER_JOB;
  const effectiveChunks = allChunks.slice(0, MAX_CHUNKS_PER_JOB);
  const totalChunks = effectiveChunks.length;

  const totalChars = effectiveChunks.reduce((sum, c) => sum + c.length, 0);
  const estimatedTokens = estimateTokens(totalChars);
  const estimatedCostUsd = estimateCost(estimatedTokens, totalChunks);
  const requiresConfirmation = totalChunks > 5;

  return {
    totalChunks,
    estimatedTokens,
    estimatedCostUsd,
    requiresConfirmation,
    truncated,
    originalChunkCount,
  };
}

export async function estimateIngestFile(filePath: string): Promise<IngestEstimate> {
  assertKnowledgeIngestFileSupported(filePath);
  assertIngestFileSize(filePath);
  const text = await extractByExtension(filePath);
  return estimateIngest(text);
}

const INGEST_PROMPT = `You are a knowledge extraction system. Analyze the following content and produce vault operations to populate a persistent knowledge graph.

SOURCE_NAME: {{SOURCE_NAME}}
SOURCE_TYPE: {{SOURCE_TYPE}}

CONTENT:
{{CONTENT}}

EXISTING NOTES (avoid duplicating these):
{{EXISTING_NOTES}}

RULES:
- Extract SIGNIFICANT knowledge: entities (people, tools, services), decisions, projects, meetings, references
- Each note must be self-contained with enough context to be useful standalone
- Use [[wiki-links]] to connect related notes (e.g. "Related to [[project-name]]")
- Path format: {type}/{slug}.md where type is one of: entities, meetings, decisions, projects, references
- Slug must be lowercase, a-z 0-9 hyphens only, max 50 chars
- For updates to existing notes, use action "update" with append=true to add new information
- IGNORE trivial or ephemeral information

Respond with a JSON array of vault operations. Each operation:
{
  "action": "create" or "update",
  "path": "type/slug.md",
  "type": "entity" | "meeting" | "decision" | "project" | "reference",
  "title": "Human readable title",
  "tags": ["tag1", "tag2"],
  "content": "Markdown content with [[wiki-links]]",
  "append": true  // only for updates
}

If no significant information found, return an empty array: []

CRITICAL: Output ONLY valid JSON array, no markdown fences, no explanation.`;

const MAX_RETRIES = 3;

let currentJobId: string | null = null;
let cancelledJobs = new Set<string>();

function getUploadsDir(): string {
  const dir = path.join(getVaultRoot(), '..', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function emitProgress(job: IngestJob): void {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0 && !wins[0].isDestroyed()) {
    wins[0].webContents.send('mgraph:ingest-progress', job);
  }
}

function emitUpdated(): void {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0 && !wins[0].isDestroyed()) {
    wins[0].webContents.send('mgraph:updated');
  }
}

async function extractByExtension(filePath: string): Promise<string> {
  assertKnowledgeIngestFileSupported(filePath);
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf':
      return extractPdf(filePath);
    case '.docx':
      return extractDocx(filePath);
    case '.xlsx':
    case '.csv':
      return extractSpreadsheet(filePath);
    case '.md':
    case '.txt':
    case '.json':
    case '.yaml':
    case '.yml':
      return extractPlainText(filePath);
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.webp':
      return extractImage(filePath);
    case '.mp3':
    case '.wav':
    case '.ogg':
    case '.m4a':
    case '.flac':
      return extractAudio(filePath);
    default:
      return extractPlainText(filePath);
  }
}

function computeFileHash(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function callClaudeForIngest(prompt: string): Promise<VaultOperation[]> {
  const { runStructuredMemoryLlm } = await import('./memory-pipeline');
  const settings = getIngestSettings();

  const text = await runStructuredMemoryLlm(prompt, {
    maxTokens: 8192,
    ...(settings.extractionModel ? { modelOverride: settings.extractionModel } : {}),
  });

  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error('Response is not a JSON array');
  return parsed as VaultOperation[];
}

async function processContent(
  chunks: string[],
  sourceName: string,
  sourceType: string,
  jobId: string,
  startChunk: number = 0,
): Promise<void> {
  const job = getIngestJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  let notesCreated = job.notesCreated;
  let notesUpdated = job.notesUpdated;
  const createdNotePaths: string[] = [...(job.createdNotePaths || [])];

  for (let i = startChunk; i < chunks.length; i++) {
    if (cancelledJobs.has(jobId)) {
      cancelledJobs.delete(jobId);
      updateIngestJob(jobId, {
        status: 'partial',
        processedChunks: i,
        lastProcessedChunk: i - 1,
        notesCreated,
        notesUpdated,
        createdNotePaths,
      });
      logger.info({ jobId, chunk: i }, 'Ingest cancelled');
      return;
    }

    const chunk = chunks[i];

    const existingNotes = getExistingVaultFilesList();

    const prompt = INGEST_PROMPT.replace('{{SOURCE_NAME}}', sourceName)
      .replace('{{SOURCE_TYPE}}', sourceType)
      .replace('{{CONTENT}}', chunk.substring(0, 50000))
      .replace('{{EXISTING_NOTES}}', existingNotes || '(none)');

    let operations: VaultOperation[] = [];
    let retries = 0;

    while (retries <= MAX_RETRIES) {
      try {
        operations = await callClaudeForIngest(prompt);
        break;
      } catch (err) {
        retries++;
        if (retries > MAX_RETRIES) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error({ jobId, chunk: i, error: errMsg }, 'Chunk processing failed after retries');

          if (i > startChunk) {
            updateIngestJob(jobId, {
              status: 'partial',
              processedChunks: i,
              lastProcessedChunk: i - 1,
              notesCreated,
              notesUpdated,
              error: `Chunk ${i} failed: ${errMsg}`,
              createdNotePaths,
            });
            const partialJob = getIngestJob(jobId);
            if (partialJob) emitProgress(partialJob);
            return;
          }

          updateIngestJob(jobId, {
            status: 'failed',
            error: `Chunk ${i} failed: ${errMsg}`,
            completedAt: new Date().toISOString(),
          });
          const failedJob = getIngestJob(jobId);
          if (failedJob) emitProgress(failedJob);
          return;
        }
        logger.warn({ jobId, chunk: i, retry: retries }, 'Chunk failed, retrying');
      }
    }

    for (const op of operations) {
      if (op.action === 'update') {
        snapshotBeforeUpdate(op.path);
      }

      const fullPath = path.join(getVaultRoot(), op.path);
      if (op.action === 'create' && fs.existsSync(fullPath)) {
        op.action = 'update';
        op.append = true;
      }

      const result = executeVaultOperation(op);
      if (result.success) {
        if (op.action === 'create') {
          notesCreated++;
          createdNotePaths.push(op.path);
        } else {
          notesUpdated++;
        }
        appendVaultLog(
          `[${new Date().toISOString()}] INGEST ${op.action.toUpperCase()} ${op.path} "${op.title}" (job:${jobId})`,
        );
      } else {
        logger.warn({ jobId, op: op.path, error: result.error }, 'Vault operation failed');
      }
    }

    updateIngestJob(jobId, {
      processedChunks: i + 1,
      lastProcessedChunk: i,
      notesCreated,
      notesUpdated,
      createdNotePaths,
    });

    const updatedJob = getIngestJob(jobId);
    if (updatedJob) emitProgress(updatedJob);
  }

  regenerateVaultIndex();
  updateVaultHot();

  updateIngestJob(jobId, {
    status: 'completed',
    processedChunks: chunks.length,
    lastProcessedChunk: chunks.length - 1,
    notesCreated,
    notesUpdated,
    completedAt: new Date().toISOString(),
    createdNotePaths,
  });

  emitUpdated();

  const doneJob = getIngestJob(jobId);
  if (doneJob) emitProgress(doneJob);

  logger.info({ jobId, notesCreated, notesUpdated }, 'Ingest job completed');
}

export async function ingestFile(filePath: string, fileName: string): Promise<IngestJob> {
  assertKnowledgeIngestFileSupported(filePath, fileName);
  assertIngestFileSize(filePath);
  const jobId = crypto.randomUUID();

  const uploadsDir = getUploadsDir();
  const uniqueName = `${Date.now()}-${fileName}`;
  const uploadPath = path.join(uploadsDir, uniqueName);
  fs.copyFileSync(filePath, uploadPath);

  const fileHash = computeFileHash(filePath);

  const existingJob = getIngestJobByHash(fileHash);
  const duplicateWarning = existingJob
    ? `Duplicate detected: file was previously ingested (job ${existingJob.id}, ${existingJob.completedAt})`
    : undefined;

  insertIngestJob({
    id: jobId,
    fileName,
    sourceType: path.extname(fileName).replace('.', '') || 'file',
    originalPath: uploadPath,
    fileHash,
  });

  if (duplicateWarning) {
    logger.warn({ jobId, fileHash }, duplicateWarning);
  }

  let job = getIngestJob(jobId)!;
  emitProgress(job);

  currentJobId = jobId;
  processFileAsync(jobId, uploadPath, fileName)
    .catch((err) => {
      logger.error({ jobId, err }, 'ingestFile processing failed');
    })
    .finally(() => {
      if (currentJobId === jobId) currentJobId = null;
    });

  return job;
}

async function processFileAsync(jobId: string, filePath: string, fileName: string): Promise<void> {
  try {
    assertIngestFileSize(filePath);
    updateIngestJob(jobId, { status: 'extracting' });
    const text = await extractByExtension(filePath);

    if (!text || text.trim().length === 0) {
      updateIngestJob(jobId, {
        status: 'failed',
        error: 'No text extracted from file',
        completedAt: new Date().toISOString(),
      });
      const failedJob = getIngestJob(jobId);
      if (failedJob) emitProgress(failedJob);
      return;
    }

    updateIngestJob(jobId, { status: 'estimating' });
    const allChunks = chunkText(text);
    const effectiveChunks = allChunks.slice(0, MAX_CHUNKS_PER_JOB);
    const estimate = estimateIngest(text);

    updateIngestJob(jobId, {
      totalChunks: effectiveChunks.length,
      estimatedCostUsd: estimate.estimatedCostUsd,
    });

    updateIngestJob(jobId, { status: 'processing' });
    let job = getIngestJob(jobId);
    if (job) emitProgress(job);

    await processContent(effectiveChunks, fileName, path.extname(fileName).replace('.', '') || 'file', jobId);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    updateIngestJob(jobId, {
      status: 'failed',
      error: errMsg,
      completedAt: new Date().toISOString(),
    });
    const failedJob = getIngestJob(jobId);
    if (failedJob) emitProgress(failedJob);
  }
}

export async function ingestUrl(url: string): Promise<IngestJob> {
  const jobId = crypto.randomUUID();

  insertIngestJob({
    id: jobId,
    fileName: url,
    sourceType: 'url',
    originalPath: url,
  });

  let job = getIngestJob(jobId)!;
  emitProgress(job);

  currentJobId = jobId;
  processUrlAsync(jobId, url)
    .catch((err) => {
      logger.error({ jobId, err }, 'ingestUrl processing failed');
    })
    .finally(() => {
      if (currentJobId === jobId) currentJobId = null;
    });

  return job;
}

async function processUrlAsync(jobId: string, url: string): Promise<void> {
  try {
    updateIngestJob(jobId, { status: 'extracting' });
    const text = await extractUrl(url);

    if (!text || text.trim().length === 0) {
      updateIngestJob(jobId, {
        status: 'failed',
        error: 'No content extracted from URL',
        completedAt: new Date().toISOString(),
      });
      const failedJob = getIngestJob(jobId);
      if (failedJob) emitProgress(failedJob);
      return;
    }

    updateIngestJob(jobId, { status: 'estimating' });
    const allChunks = chunkText(text);
    const effectiveChunks = allChunks.slice(0, MAX_CHUNKS_PER_JOB);
    const estimate = estimateIngest(text);

    updateIngestJob(jobId, {
      totalChunks: effectiveChunks.length,
      estimatedCostUsd: estimate.estimatedCostUsd,
      status: 'processing',
    });

    let job = getIngestJob(jobId);
    if (job) emitProgress(job);

    await processContent(effectiveChunks, url, 'url', jobId);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    updateIngestJob(jobId, {
      status: 'failed',
      error: errMsg,
      completedAt: new Date().toISOString(),
    });
    const failedJob = getIngestJob(jobId);
    if (failedJob) emitProgress(failedJob);
  }
}

export async function ingestText(text: string, title?: string): Promise<IngestJob> {
  const jobId = crypto.randomUUID();
  const name = title || `text-${Date.now()}`;

  insertIngestJob({
    id: jobId,
    fileName: name,
    sourceType: 'text',
  });

  let job = getIngestJob(jobId)!;
  emitProgress(job);

  currentJobId = jobId;
  processTextAsync(jobId, text, name)
    .catch((err) => {
      logger.error({ jobId, err }, 'ingestText processing failed');
    })
    .finally(() => {
      if (currentJobId === jobId) currentJobId = null;
    });

  return job;
}

async function processTextAsync(jobId: string, text: string, name: string): Promise<void> {
  try {
    updateIngestJob(jobId, { status: 'estimating' });
    const allChunks = chunkText(text);
    const effectiveChunks = allChunks.slice(0, MAX_CHUNKS_PER_JOB);
    const estimate = estimateIngest(text);

    updateIngestJob(jobId, {
      totalChunks: effectiveChunks.length,
      estimatedCostUsd: estimate.estimatedCostUsd,
      status: 'processing',
    });

    let job = getIngestJob(jobId);
    if (job) emitProgress(job);

    await processContent(effectiveChunks, name, 'text', jobId);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    updateIngestJob(jobId, {
      status: 'failed',
      error: errMsg,
      completedAt: new Date().toISOString(),
    });
    const failedJob = getIngestJob(jobId);
    if (failedJob) emitProgress(failedJob);
  }
}

export async function resumeIngestJob(jobId: string): Promise<IngestJob> {
  const job = getIngestJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (job.status !== 'partial' && job.status !== 'failed') {
    throw new Error(`Job ${jobId} cannot be resumed (status: ${job.status})`);
  }

  let text: string;
  if (job.sourceType === 'url') {
    text = await extractUrl(job.originalPath || job.fileName);
  } else if (job.sourceType === 'text') {
    throw new Error('Text jobs cannot be resumed - please re-ingest the text');
  } else {
    if (!job.originalPath || !fs.existsSync(job.originalPath)) {
      throw new Error('Original file not found for resume');
    }
    assertKnowledgeIngestFileSupported(job.fileName, job.originalPath);
    assertIngestFileSize(job.originalPath);
    text = await extractByExtension(job.originalPath);
  }

  const allChunks = chunkText(text);
  const effectiveChunks = allChunks.slice(0, MAX_CHUNKS_PER_JOB);
  const startFrom = job.lastProcessedChunk + 1;

  updateIngestJob(jobId, {
    status: 'processing',
    error: undefined,
  });

  const updatedJob = getIngestJob(jobId)!;
  emitProgress(updatedJob);

  currentJobId = jobId;
  processContent(effectiveChunks, job.fileName, job.sourceType, jobId, startFrom)
    .catch((err) => {
      logger.error({ jobId, err }, 'resumeIngestJob processing failed');
    })
    .finally(() => {
      if (currentJobId === jobId) currentJobId = null;
    });

  return updatedJob;
}

export function cancelIngest(jobId: string): void {
  cancelledJobs.add(jobId);
  logger.info({ jobId }, 'Ingest cancel requested');
}

export function discardPartialJob(jobId: string): void {
  const job = getIngestJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  if (job.createdNotePaths && job.createdNotePaths.length > 0) {
    for (const notePath of job.createdNotePaths) {
      try {
        deleteVaultNote(notePath, { force: true });
      } catch (err) {
        logger.warn({ jobId, notePath, err }, 'Failed to delete note during discard');
      }
    }

    regenerateVaultIndex();
    updateVaultHot();
    emitUpdated();
  }

  updateIngestJob(jobId, {
    status: 'failed',
    error: 'Discarded by user',
    completedAt: new Date().toISOString(),
    createdNotePaths: [],
  });

  logger.info({ jobId, removedNotes: job.createdNotePaths?.length || 0 }, 'Partial job discarded');
}

export function acceptPartialJob(jobId: string): void {
  const job = getIngestJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  updateIngestJob(jobId, {
    status: 'completed',
    completedAt: new Date().toISOString(),
  });

  logger.info({ jobId, notesKept: job.createdNotePaths?.length || 0 }, 'Partial job accepted');
}

export function getIngestHistory(): IngestJob[] {
  return getAllIngestJobs();
}

export function cleanOldUploads(): { removed: number } {
  const uploadsDir = path.join(getVaultRoot(), '..', 'uploads');
  if (!fs.existsSync(uploadsDir)) return { removed: 0 };

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let removed = 0;

  const allJobs = getAllIngestJobs();
  const completedJobPaths = new Set<string>();

  for (const job of allJobs) {
    if (job.status === 'completed' && job.completedAt) {
      const completedTime = new Date(job.completedAt).getTime();
      if (completedTime < thirtyDaysAgo && job.originalPath) {
        completedJobPaths.add(job.originalPath);
      }
    }
  }

  for (const uploadPath of completedJobPaths) {
    try {
      if (fs.existsSync(uploadPath)) {
        fs.unlinkSync(uploadPath);
        removed++;
      }
    } catch (err) {
      logger.warn({ uploadPath, err }, 'Failed to remove old upload');
    }
  }

  cleanOldSnapshots();

  logger.info({ removed }, 'Old uploads cleaned');
  return { removed };
}

const INGEST_QUEUE_DIR = path.join(getVaultRoot(), '.ingest-queue');

export async function processIngestJob(jobFilePath: string): Promise<void> {
  try {
    if (!fs.existsSync(jobFilePath)) return;

    const raw = fs.readFileSync(jobFilePath, 'utf-8');
    const job = JSON.parse(raw) as {
      type: 'text' | 'file' | 'url';
      content: string;
      title?: string | null;
      timestamp: string;
    };

    logger.info({ jobFilePath, type: job.type }, 'Processing ingest queue job');

    if (job.type === 'file') {
      assertKnowledgeIngestFileSupported(job.content, job.title || path.basename(job.content));
    }

    fs.unlinkSync(jobFilePath);

    if (job.type === 'text') {
      await ingestText(job.content, job.title || undefined);
    } else if (job.type === 'file') {
      const fileName = job.title || path.basename(job.content);
      await ingestFile(job.content, fileName);
    } else if (job.type === 'url') {
      await ingestUrl(job.content);
    } else {
      logger.warn({ type: (job as { type: string }).type }, 'Unknown ingest job type, skipping');
    }
  } catch (err) {
    logger.error({ jobFilePath, err }, 'Failed to process ingest queue job');
  }
}

let ingestQueueWatcher: fs.FSWatcher | null = null;

export function startIngestQueueWatcher(): void {
  fs.mkdirSync(INGEST_QUEUE_DIR, { recursive: true });

  const allJobs = getAllIngestJobs();
  const stuckStatuses = ['processing', 'extracting', 'estimating'];
  const stuckJobs = allJobs.filter((j) => stuckStatuses.includes(j.status));
  if (stuckJobs.length > 0) {
    for (const job of stuckJobs) {
      updateIngestJob(job.id, {
        status: 'failed',
        error: 'Processo interrompido por reinicio do app',
      });
      logger.warn(
        { jobId: job.id, fileName: job.fileName, previousStatus: job.status },
        'Recovered stuck ingest job on boot',
      );
    }
    logger.info({ count: stuckJobs.length }, 'Marked stuck ingest jobs as failed on boot');
  }

  const existingFiles = fs.readdirSync(INGEST_QUEUE_DIR).filter((f) => f.endsWith('.json'));
  for (const file of existingFiles) {
    processIngestJob(path.join(INGEST_QUEUE_DIR, file)).catch((err) => {
      logger.error({ file, err }, 'Failed to process pre-existing ingest job');
    });
  }

  ingestQueueWatcher = fs.watch(INGEST_QUEUE_DIR, (_event, filename) => {
    if (!filename || !filename.endsWith('.json')) return;
    const jobFilePath = path.join(INGEST_QUEUE_DIR, filename);
    setTimeout(() => {
      processIngestJob(jobFilePath).catch((err) => {
        logger.error({ jobFilePath, err }, 'Ingest queue watcher: job processing failed');
      });
    }, 200);
  });

  ingestQueueWatcher.on('error', (err) => {
    logger.error({ err }, 'Ingest queue watcher error');
  });

  logger.info({ dir: INGEST_QUEUE_DIR }, 'Ingest queue watcher started');
}

export function stopIngestQueueWatcher(): void {
  if (ingestQueueWatcher) {
    ingestQueueWatcher.close();
    ingestQueueWatcher = null;
    logger.info('Ingest queue watcher stopped');
  }
}
