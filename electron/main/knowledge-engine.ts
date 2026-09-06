
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import { CohereClient } from 'cohere-ai';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import { getSecret } from './secrets-vault';
import { generateEmbedding } from './embedding-provider';
import { runStructuredMemoryLlm, CompactionProviderUnavailableError } from './memory-pipeline';
import {
  getDb,
  getKnowledgeSource,
  insertKnowledgeSource,
  insertKnowledgeChunk,
  insertKnowledgeChunkVec,
  insertKnowledgeChunkFts,
  getKnowledgeAgentConfig,
  type KnowledgeSourceRow,
} from './db';

const logger = createLogger('knowledge-engine');


export type ChunkStrategy = 'recursive' | 'semantic' | 'page' | 'csv' | 'agentic' | 'markdown';

export interface RawDocument {
  text: string;
  file_type: string;
  pages?: Array<{ page_number: number; content: string }>;
  headers?: string[];
  rows?: Array<Record<string, string>>;
  extracted_at: string;
}

export interface ChunkResult {
  content: string;
  metadata: Record<string, unknown>;
  token_count: number;
}

export interface KBSearchResult {
  found: boolean;
  degraded?: boolean;
  degradedReason?: string;
  strategy: 'hybrid_direct' | 'hyde_hybrid' | 'hybrid_fallback' | 'not_found';
  results: Array<{
    chunk_id: string;
    source_id: string;
    source_name: string;
    content: string;
    rerank_score: number;
    chunk_index: number;
    token_count: number;
    metadata: Record<string, unknown>;
  }>;
  query_used: string;
  latency_ms: number;
}

export interface KnowledgeSource extends KnowledgeSourceRow {}

export interface KnowledgeAgentConfig {
  agentId: string;
  hydeEnabled: boolean;
  hydeThreshold: number;
  minScore: number;
  defaultStrategy: ChunkStrategy;
  rerankEnabled: boolean;
  rerankTopK: number;
  searchTopK: number;
}


let enc: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!enc) enc = getEncoding('cl100k_base');
  return enc!;
}

export function countTokens(text: string): number {
  try {
    return getEncoder().encode(text).length;
  } catch {
    return Math.ceil(text.length / 3.8);
  }
}


function getKnowledgeDir(agentId: string, sourceId: string): string {
  return path.join(getLionClawHome(), 'knowledge', agentId, sourceId);
}

function saveRawDocument(agentId: string, sourceId: string, raw: RawDocument): void {
  const dir = getKnowledgeDir(agentId, sourceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'raw.json'), JSON.stringify(raw, null, 2), 'utf-8');
}

export function loadRawDocument(agentId: string, sourceId: string): RawDocument {
  const rawPath = path.join(getKnowledgeDir(agentId, sourceId), 'raw.json');
  const content = fs.readFileSync(rawPath, 'utf-8');
  return JSON.parse(content) as RawDocument;
}


interface PdfTextResult {
  text: string;
}

type LegacyPdfParse = (buffer: Buffer) => Promise<PdfTextResult>;

interface ModernPdfParser {
  getText: () => Promise<PdfTextResult>;
  destroy: () => Promise<void> | void;
}

type ModernPdfParserConstructor = new (options: { data: Buffer }) => ModernPdfParser;

export async function extractPdfText(
  buffer: Buffer,
  pdfParseModule: unknown,
): Promise<PdfTextResult> {
  if (typeof pdfParseModule === 'function') {
    return (pdfParseModule as LegacyPdfParse)(buffer);
  }

  if (typeof pdfParseModule !== 'object' || pdfParseModule === null) {
    throw new TypeError('pdf-parse export is not supported');
  }

  const moduleRecord = pdfParseModule as Record<string, unknown>;
  if (typeof moduleRecord.PDFParse === 'function') {
    const PDFParse = moduleRecord.PDFParse as ModernPdfParserConstructor;
    const parser = new PDFParse({ data: buffer });
    try {
      return await parser.getText();
    } finally {
      await parser.destroy();
    }
  }

  if (typeof moduleRecord.default === 'function') {
    return (moduleRecord.default as LegacyPdfParse)(buffer);
  }

  throw new TypeError('pdf-parse export is not supported');
}

async function parsePdf(filePath: string): Promise<RawDocument> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParseModule: unknown = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);
  const result = await extractPdfText(buffer, pdfParseModule);

  const rawPages = result.text.split('\f');
  const pages = rawPages
    .map((content: string, index: number) => ({ page_number: index + 1, content: content.trim() }))
    .filter((p: { content: string }) => p.content.length > 0);

  return {
    text: result.text,
    file_type: 'pdf',
    pages,
    headers: [],
    rows: [],
    extracted_at: new Date().toISOString(),
  };
}

async function parseDocx(filePath: string): Promise<RawDocument> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return {
    text: result.value,
    file_type: 'docx',
    pages: [],
    headers: [],
    rows: [],
    extracted_at: new Date().toISOString(),
  };
}

function parseTxt(filePath: string): RawDocument {
  const text = fs.readFileSync(filePath, 'utf-8');
  return {
    text,
    file_type: 'txt',
    pages: [],
    headers: [],
    rows: [],
    extracted_at: new Date().toISOString(),
  };
}

function parseMd(filePath: string): RawDocument {
  const text = fs.readFileSync(filePath, 'utf-8');
  const headerMatches = text.match(/^#{1,6}\s.+$/gm) ?? [];
  const headers = headerMatches.map((h) => h.trim());
  return {
    text,
    file_type: 'md',
    pages: [],
    headers,
    rows: [],
    extracted_at: new Date().toISOString(),
  };
}

async function parseCsv(filePath: string): Promise<RawDocument> {
  const { parse } = await import('csv-parse/sync');
  const content = fs.readFileSync(filePath, 'utf-8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<Record<string, string>>;

  const headers = records.length > 0 ? Object.keys(records[0]) : [];
  const text = records
    .map((row) =>
      headers.map((h) => `${h}: ${row[h] ?? ''}`).join(', '),
    )
    .join('\n');

  return {
    text,
    file_type: 'csv',
    pages: [],
    headers,
    rows: records,
    extracted_at: new Date().toISOString(),
  };
}

export async function parseFile(filePath: string, fileType: string): Promise<RawDocument> {
  switch (fileType) {
    case 'pdf':
      return parsePdf(filePath);
    case 'docx':
      return parseDocx(filePath);
    case 'txt':
      return parseTxt(filePath);
    case 'md':
      return parseMd(filePath);
    case 'csv':
      return parseCsv(filePath);
    default:
      throw new Error(`Unsupported file type: ${fileType}`);
  }
}


const SAFETY_TOKEN_LIMIT = 1500;
const SAFETY_CHAR_LIMIT = 5500;
const SAFETY_OVERLAP_CHARS = 200;

function recursiveSplit(text: string, chunkSize: number, overlap: number): string[] {
  const separators = ['\n\n', '\n', '. ', ' '];
  const chunks: string[] = [];

  function split(txt: string, sepIndex: number): void {
    if (txt.length <= chunkSize) {
      if (txt.trim().length > 0) chunks.push(txt.trim());
      return;
    }

    const sep = separators[sepIndex];
    if (!sep) {
      let start = 0;
      while (start < txt.length) {
        const end = Math.min(start + chunkSize, txt.length);
        chunks.push(txt.slice(start, end).trim());
        start = end - overlap;
        if (start >= txt.length) break;
      }
      return;
    }

    const parts = txt.split(sep);
    let current = '';
    for (const part of parts) {
      const candidate = current ? current + sep + part : part;
      if (candidate.length <= chunkSize) {
        current = candidate;
      } else {
        if (current.trim()) {
          if (current.length > chunkSize && sepIndex + 1 < separators.length) {
            split(current, sepIndex + 1);
          } else if (current.trim().length > 0) {
            chunks.push(current.trim());
          }
        }
        current = part;
      }
    }
    if (current.trim()) {
      if (current.length > chunkSize && sepIndex + 1 < separators.length) {
        split(current, sepIndex + 1);
      } else if (current.trim().length > 0) {
        chunks.push(current.trim());
      }
    }
  }

  split(text, 0);

  if (overlap <= 0 || chunks.length <= 1) return chunks;
  const withOverlap: string[] = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const overlapText = prev.slice(Math.max(0, prev.length - overlap));
    withOverlap.push(overlapText + ' ' + chunks[i]);
  }
  return withOverlap;
}

function applySafetyValve(chunks: ChunkResult[]): ChunkResult[] {
  const result: ChunkResult[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const tokenCount = countTokens(chunk.content);
    const charCount = chunk.content.length;

    const needsSplit = tokenCount > SAFETY_TOKEN_LIMIT || charCount > SAFETY_CHAR_LIMIT;
    if (!needsSplit) {
      result.push({ ...chunk, token_count: tokenCount });
      continue;
    }

    const subTexts = recursiveSplit(chunk.content, SAFETY_CHAR_LIMIT, SAFETY_OVERLAP_CHARS);
    for (const sub of subTexts) {
      result.push({
        content: sub,
        metadata: {
          ...chunk.metadata,
          safety_split: true,
          original_chunk_index: i,
        },
        token_count: countTokens(sub),
      });
    }
  }
  return result;
}


function chunkRecursive(text: string, chunkSize: number, chunkOverlap: number): ChunkResult[] {
  const texts = recursiveSplit(text, chunkSize, chunkOverlap);
  let offset = 0;
  return texts.map((content) => {
    const start = text.indexOf(content, offset);
    const charStart = start >= 0 ? start : offset;
    const charEnd = charStart + content.length;
    offset = charEnd;
    return {
      content,
      metadata: {
        char_offset_start: charStart,
        char_offset_end: charEnd,
      },
      token_count: 0,
    };
  });
}

async function chunkSemantic(text: string): Promise<ChunkResult[]> {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);

  if (sentences.length <= 1) {
    return [{ content: text, metadata: { breakpoint_score: 0 }, token_count: 0 }];
  }

  const embeddings: (number[] | null)[] = [];
  for (const sentence of sentences) {
    const result = await generateEmbedding(sentence);
    embeddings.push(result.ok ? result.embedding : null);
  }

  function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  const distances: number[] = [];
  for (let i = 0; i < sentences.length - 1; i++) {
    const a = embeddings[i];
    const b = embeddings[i + 1];
    if (a && b) {
      distances.push(1 - cosineSimilarity(a, b));
    } else {
      distances.push(0);
    }
  }

  const sorted = [...distances].sort((x, y) => x - y);
  const threshold = sorted[Math.floor(sorted.length * 0.75)] ?? 0.3;

  const chunks: ChunkResult[] = [];
  let currentSentences: string[] = [sentences[0]];
  let maxBreakScore = 0;

  for (let i = 0; i < distances.length; i++) {
    const dist = distances[i];
    if (dist > maxBreakScore) maxBreakScore = dist;

    if (dist >= threshold) {
      chunks.push({
        content: currentSentences.join(' '),
        metadata: { breakpoint_score: maxBreakScore },
        token_count: 0,
      });
      currentSentences = [sentences[i + 1]];
      maxBreakScore = 0;
    } else {
      currentSentences.push(sentences[i + 1]);
    }
  }

  if (currentSentences.length > 0) {
    chunks.push({
      content: currentSentences.join(' '),
      metadata: { breakpoint_score: maxBreakScore },
      token_count: 0,
    });
  }

  return chunks;
}

function chunkByPage(raw: RawDocument): ChunkResult[] {
  if (!raw.pages || raw.pages.length === 0) {
    return [{ content: raw.text, metadata: { page_number: 1 }, token_count: 0 }];
  }
  return raw.pages
    .filter((p) => p.content.trim().length > 0)
    .map((p) => ({
      content: p.content,
      metadata: { page_number: p.page_number },
      token_count: 0,
    }));
}


function chunkCsv(raw: RawDocument): ChunkResult[] {
  if (!raw.rows || raw.rows.length === 0) {
    return [{ content: raw.text, metadata: { row_index: 0 }, token_count: 0 }];
  }

  return raw.rows.map((row, index) => {
    const content = Object.entries(row)
      .map(([col, val]) => `${col}: ${val}`)
      .join(', ');
    return {
      content,
      metadata: {
        row_index: index,
        ...row,
      } as Record<string, unknown>,
      token_count: 0,
    };
  });
}

async function chunkAgentic(text: string): Promise<ChunkResult[]> {
  const WINDOW_TOKENS = 8000;
  const OVERLAP_TOKENS = 800;
  const WINDOW_CHARS = WINDOW_TOKENS * 3.8;
  const OVERLAP_CHARS = OVERLAP_TOKENS * 3.8;

  const chunks: ChunkResult[] = [];

  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + WINDOW_CHARS, text.length);
    const window = text.slice(start, end);

    try {
      const rawText = await runStructuredMemoryLlm(
        `Você receberá um trecho de texto. Segmente-o em partes semânticas independentes.\nCada parte deve ser autocontida - um leitor sem contexto anterior deve entendê-la.\nRetorne APENAS JSON, sem markdown:\n{ "chunks": [{ "topic": "título curto do tema", "content": "texto completo da parte" }] }\n\nSe o texto já for curto o suficiente para ser um chunk único, retorne como array de 1 elemento.\n\nTexto:\n${window}`,
        { maxTokens: 4096 },
      );
      const jsonText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
      const parsed = JSON.parse(jsonText) as { chunks: Array<{ topic: string; content: string }> };

      for (const c of parsed.chunks) {
        chunks.push({
          content: c.content,
          metadata: { topic: c.topic },
          token_count: 0,
        });
      }
    } catch (err) {
      if (err instanceof CompactionProviderUnavailableError) {
        logger.warn(
          { err },
          'Agentic chunking: provider da selecao indisponivel; caindo para chunkRecursive (nao-LLM)',
        );
        return chunkRecursive(text, 1000, 200);
      }
      logger.warn({ err, start, end }, 'Agentic chunking window failed, falling back for this window');
      chunks.push({
        content: window,
        metadata: { topic: 'unknown' },
        token_count: 0,
      });
    }

    if (end >= text.length) break;
    start = end - OVERLAP_CHARS;
    if (start < 0) start = 0;
  }

  return chunks;
}


export async function chunkDocument(
  raw: RawDocument,
  strategy: ChunkStrategy,
  chunkSize: number,
  chunkOverlap: number,
): Promise<ChunkResult[]> {
  let chunks: ChunkResult[];

  switch (strategy) {
    case 'recursive':
      chunks = chunkRecursive(raw.text, chunkSize, chunkOverlap);
      break;
    case 'semantic':
      chunks = await chunkSemantic(raw.text);
      break;
    case 'page':
      chunks = chunkByPage(raw);
      break;
    case 'csv':
      chunks = chunkCsv(raw);
      break;
    case 'agentic':
      chunks = await chunkAgentic(raw.text);
      break;
    default:
      throw new Error(`Unknown chunking strategy: ${String(strategy)}`);
  }

  return applySafetyValve(chunks);
}


const EMBEDDING_BATCH_SIZE = 100;

export async function generateEmbeddingsBatch(texts: string[]): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = new Array(texts.length).fill(null);

  for (let batchStart = 0; batchStart < texts.length; batchStart += EMBEDDING_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + EMBEDDING_BATCH_SIZE, texts.length);
    const batch = texts.slice(batchStart, batchEnd);

    const batchResults = await Promise.allSettled(
      batch.map((text) => generateEmbedding(text)),
    );

    for (let i = 0; i < batchResults.length; i++) {
      const r = batchResults[i];
      if (r.status === 'fulfilled') {
        if (r.value.ok) {
          results[batchStart + i] = r.value.embedding;
        } else {
          logger.warn(
            {
              index: batchStart + i,
              code: r.value.code,
              provider: r.value.provider,
              status: r.value.status,
              reason: r.value.reason,
            },
            'Embedding failed for chunk',
          );
        }
      } else {
        logger.warn({ index: batchStart + i, err: r.reason }, 'Embedding failed for chunk');
      }
    }
  }

  return results;
}


const COHERE_RATE_LIMIT_MS = 650;
let lastCohereCallAt = 0;

async function waitCohereRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCohereCallAt;
  if (elapsed < COHERE_RATE_LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, COHERE_RATE_LIMIT_MS - elapsed));
  }
  lastCohereCallAt = Date.now();
}

async function cohereRerank(
  query: string,
  documents: string[],
  topN: number,
): Promise<Array<{ index: number; relevanceScore: number }> | null> {
  const apiKey = await getSecret('COHERE_API_KEY');
  if (!apiKey || documents.length === 0) {
    return null;
  }

  await waitCohereRateLimit();

  try {
    const cohere = new CohereClient({ token: apiKey });
    const result = await cohere.v2.rerank({
      model: 'rerank-multilingual-v3.0',
      query,
      documents,
      topN,
    });

    return (result.results ?? []).map((r) => ({
      index: r.index,
      relevanceScore: r.relevanceScore,
    }));
  } catch (err) {
    logger.warn({ err }, 'Cohere rerank failed, falling back to RRF');
    return null;
  }
}


async function generateHypotheticalDocument(query: string): Promise<string | null> {
  try {
    const text = await runStructuredMemoryLlm(
      `Escreva um parágrafo denso e técnico que seria a resposta perfeita para:\n"${query}"\n\nUse terminologia específica do domínio. Não responda diretamente - simule o conteúdo de um documento real que conteria essa informação. Máximo 200 palavras.`,
      { maxTokens: 512 },
    );
    const trimmed = text.trim();
    return trimmed ? trimmed : null;
  } catch (err) {
    logger.warn({ err }, 'HyDE generation failed');
    return null;
  }
}


interface BM25Row {
  chunk_id: string;
  agent_id: string;
  bm25_score: number;
}

export function buildKnowledgeFtsQuery(query: string): string {
  const terms = query
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 32);

  if (terms.length === 0) return '';

  return terms
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' OR ');
}

function searchKnowledgeBM25(agentId: string, query: string, topK: number): BM25Row[] {
  const ftsQuery = buildKnowledgeFtsQuery(query);
  if (!ftsQuery) return [];

  const db = getDb();
  try {
    return db.prepare(`
      SELECT chunk_id, agent_id,
             bm25(knowledge_chunks_fts) AS bm25_score
      FROM knowledge_chunks_fts
      WHERE content MATCH ?
        AND agent_id = ?
      ORDER BY bm25_score ASC
      LIMIT ?
    `).all(ftsQuery, agentId, topK) as BM25Row[];
  } catch (err) {
    logger.warn({ err, query, ftsQuery }, 'BM25 knowledge search failed');
    return [];
  }
}


interface VecRow {
  chunk_id: string;
  agent_id: string;
  distance: number;
}

function searchKnowledgeVector(agentId: string, embedding: number[], topK: number): VecRow[] {
  const db = getDb();
  const buf = Buffer.from(new Float32Array(embedding).buffer);
  try {
    return db.prepare(`
      SELECT kc.id AS chunk_id, kc.agent_id,
             vec_distance_cosine(kcv.embedding, ?) AS distance
      FROM knowledge_chunks_vec kcv
      JOIN knowledge_chunks kc ON kc.id = kcv.chunk_id
      WHERE kc.agent_id = ?
      ORDER BY distance ASC
      LIMIT ?
    `).all(buf, agentId, topK) as VecRow[];
  } catch (err) {
    logger.warn({ err }, 'Vector knowledge search failed');
    return [];
  }
}


interface RRFEntry {
  chunk_id: string;
  score: number;
}

function rrfMerge(bm25Rows: BM25Row[], vecRows: VecRow[], k: number): RRFEntry[] {
  const scores = new Map<string, number>();

  bm25Rows.forEach((row, rank) => {
    const prev = scores.get(row.chunk_id) ?? 0;
    scores.set(row.chunk_id, prev + 1 / (k + rank + 1));
  });

  vecRows.forEach((row, rank) => {
    const prev = scores.get(row.chunk_id) ?? 0;
    scores.set(row.chunk_id, prev + 1 / (k + rank + 1));
  });

  return Array.from(scores.entries())
    .map(([chunk_id, score]) => ({ chunk_id, score }))
    .sort((a, b) => b.score - a.score);
}


interface ChunkDetail {
  id: string;
  source_id: string;
  source_name: string;
  content: string;
  chunk_index: number;
  token_count: number;
  metadata: Record<string, unknown>;
}

function fetchChunkDetails(chunkIds: string[]): ChunkDetail[] {
  if (chunkIds.length === 0) return [];
  const db = getDb();
  const placeholders = chunkIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT kc.id, kc.source_id, ks.file_name AS source_name,
           kc.content, kc.chunk_index, kc.token_count, kc.metadata
    FROM knowledge_chunks kc
    JOIN knowledge_sources ks ON ks.id = kc.source_id
    WHERE kc.id IN (${placeholders})
  `).all(...chunkIds) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: r['id'] as string,
    source_id: r['source_id'] as string,
    source_name: r['source_name'] as string,
    content: r['content'] as string,
    chunk_index: r['chunk_index'] as number,
    token_count: r['token_count'] as number,
    metadata: JSON.parse((r['metadata'] as string) || '{}'),
  }));
}


async function runRetrievalPipeline(
  agentId: string,
  query: string,
  config: {
    rerankEnabled: boolean;
    rerankTopK: number;
    searchTopK: number;
  },
): Promise<{ results: KBSearchResult['results']; topScore: number; degradedReason?: string }> {
  const embResult = await generateEmbedding(query);
  if (!embResult.ok) {
    return { results: [], topScore: 0, degradedReason: embResult.reason };
  }

  const bm25Rows = searchKnowledgeBM25(agentId, query, config.searchTopK);
  const vecRows = searchKnowledgeVector(agentId, embResult.embedding, config.searchTopK);
  const rrfEntries = rrfMerge(bm25Rows, vecRows, 60).slice(0, config.searchTopK);

  if (rrfEntries.length === 0) {
    return { results: [], topScore: 0 };
  }

  const chunkIds = rrfEntries.map((e) => e.chunk_id);
  const details = fetchChunkDetails(chunkIds);

  const detailMap = new Map(details.map((d) => [d.id, d]));
  const orderedDetails = chunkIds.map((id) => detailMap.get(id)).filter((d): d is ChunkDetail => d !== undefined);

  if (config.rerankEnabled && orderedDetails.length > 0) {
    const rerankResults = await cohereRerank(
      query,
      orderedDetails.map((d) => d.content),
      config.rerankTopK,
    );

    if (rerankResults !== null) {
      const rerankScores = new Array(orderedDetails.length).fill(0);
      for (const r of rerankResults) {
        rerankScores[r.index] = r.relevanceScore;
      }
      const indexed = orderedDetails.map((d, i) => ({ d, score: rerankScores[i] as number }));
      indexed.sort((a, b) => b.score - a.score);
      const topK = indexed.slice(0, config.rerankTopK);
      const finalResults: KBSearchResult['results'] = topK.map(({ d, score }) => ({
        chunk_id: d.id,
        source_id: d.source_id,
        source_name: d.source_name,
        content: d.content,
        rerank_score: score,
        chunk_index: d.chunk_index,
        token_count: d.token_count,
        metadata: d.metadata,
      }));
      const topScore = finalResults.length > 0 ? finalResults[0].rerank_score : 0;
      return { results: finalResults, topScore };
    }
  }

  {
    const topDetails = orderedDetails.slice(0, config.rerankTopK);
    const maxRrf = rrfEntries[0]?.score ?? 1;
    const finalResults: KBSearchResult['results'] = topDetails.map((d, i) => ({
      chunk_id: d.id,
      source_id: d.source_id,
      source_name: d.source_name,
      content: d.content,
      rerank_score: maxRrf > 0 ? (rrfEntries[i]?.score ?? 0) / maxRrf : 0,
      chunk_index: d.chunk_index,
      token_count: d.token_count,
      metadata: d.metadata,
    }));
    const topScore = finalResults.length > 0 ? 1.0 : 0;
    return { results: finalResults, topScore };
  }
}


export async function hybridKnowledgeSearch(
  agentId: string,
  query: string,
): Promise<KBSearchResult> {
  const startMs = Date.now();

  const dbConfig = getKnowledgeAgentConfig(agentId);
  const config = {
    hydeEnabled: dbConfig?.hydeEnabled ?? true,
    hydeThreshold: dbConfig?.hydeThreshold ?? 0.5,
    minScore: dbConfig?.minScore ?? 0.4,
    rerankEnabled: dbConfig?.rerankEnabled ?? true,
    rerankTopK: dbConfig?.rerankTopK ?? 3,
    searchTopK: dbConfig?.searchTopK ?? 20,
  };

  try {
    const { results, topScore, degradedReason } = await runRetrievalPipeline(agentId, query, config);

    if (degradedReason !== undefined) {
      return {
        found: false,
        degraded: true,
        degradedReason,
        strategy: 'not_found',
        results: [],
        query_used: query,
        latency_ms: Date.now() - startMs,
      };
    }

    if (results.length === 0) {
      return {
        found: false,
        strategy: 'not_found',
        results: [],
        query_used: query,
        latency_ms: Date.now() - startMs,
      };
    }

    if (topScore >= config.hydeThreshold) {
      return {
        found: true,
        strategy: 'hybrid_direct',
        results,
        query_used: query,
        latency_ms: Date.now() - startMs,
      };
    }

    if (config.hydeEnabled) {
      const hypotheticalDoc = await generateHypotheticalDocument(query);
      if (hypotheticalDoc) {
        const hydeResult = await runRetrievalPipeline(agentId, hypotheticalDoc, config);

        if (hydeResult.topScore > topScore) {
          if (hydeResult.topScore >= config.minScore) {
            return {
              found: true,
              strategy: 'hyde_hybrid',
              results: hydeResult.results,
              query_used: hypotheticalDoc,
              latency_ms: Date.now() - startMs,
            };
          }
        }
      }
    }

    if (topScore >= config.minScore) {
      return {
        found: true,
        strategy: 'hybrid_fallback',
        results,
        query_used: query,
        latency_ms: Date.now() - startMs,
      };
    }

    return {
      found: false,
      strategy: 'not_found',
      results: [],
      query_used: query,
      latency_ms: Date.now() - startMs,
    };
  } catch (err) {
    logger.error({ err, agentId, query }, 'hybridKnowledgeSearch failed');
    return {
      found: false,
      degraded: true,
      degradedReason: err instanceof Error ? err.message : String(err),
      strategy: 'not_found',
      results: [],
      query_used: query,
      latency_ms: Date.now() - startMs,
    };
  }
}


export type ProgressEmitter = (data: { sourceId: string; stage: string; progress: number }) => void;

export async function ingestDocument(
  payload: {
    agentId: string;
    filePath: string;
    config: {
      strategy: ChunkStrategy;
      chunkSize: number;
      chunkOverlap: number;
      title?: string;
    };
  },
  emitProgress: ProgressEmitter,
): Promise<KnowledgeSource> {
  const { agentId, filePath, config } = payload;
  const ext = path.extname(filePath).toLowerCase().replace('.', '') as KnowledgeSourceRow['fileType'];
  const validTypes = ['pdf', 'docx', 'txt', 'md', 'csv'] as const;
  type ValidType = typeof validTypes[number];

  if (!(validTypes as readonly string[]).includes(ext)) {
    throw new Error(`Unsupported file type: ${ext}`);
  }
  const fileType = ext as ValidType;

  const fileStat = fs.statSync(filePath);
  if (fileStat.size > 100 * 1024 * 1024) {
    throw new Error('File exceeds 100MB limit');
  }

  const sourceId = crypto.randomUUID();
  const fileName = path.basename(filePath);
  const knowledgeDir = getKnowledgeDir(agentId, sourceId);
  fs.mkdirSync(knowledgeDir, { recursive: true });

  const destPath = path.join(knowledgeDir, `original.${fileType}`);

  let source = insertKnowledgeSource({
    id: sourceId,
    agentId,
    fileName,
    fileType,
    fileSize: fileStat.size,
    filePath: destPath,
    title: config.title,
    description: undefined,
    status: 'processing',
    chunksCount: 0,
    chunkStrategy: config.strategy,
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
    qualityScore: undefined,
    bestStrategy: undefined,
    errorMessage: undefined,
    processedAt: undefined,
  });

  emitProgress({ sourceId, stage: 'parsing', progress: 10 });

  try {
    fs.copyFileSync(filePath, destPath);

    const raw = await parseFile(destPath, fileType);
    saveRawDocument(agentId, sourceId, raw);

    emitProgress({ sourceId, stage: 'chunking', progress: 30 });

    const chunks = await chunkDocument(raw, config.strategy, config.chunkSize, config.chunkOverlap);

    for (const chunk of chunks) {
      if (!chunk.token_count) {
        chunk.token_count = countTokens(chunk.content);
      }
    }

    emitProgress({ sourceId, stage: 'embedding', progress: 60 });

    const embeddings = await generateEmbeddingsBatch(chunks.map((c) => c.content));

    emitProgress({ sourceId, stage: 'indexing', progress: 85 });

    const db = getDb();
    const insertAll = db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        const chunkId = crypto.randomUUID();
        insertKnowledgeChunk({
          id: chunkId,
          sourceId,
          agentId,
          chunkIndex: i,
          content: chunks[i].content,
          tokenCount: chunks[i].token_count,
          metadata: chunks[i].metadata,
          strategyUsed: config.strategy,
        });

        if (embeddings[i]) {
          insertKnowledgeChunkVec(chunkId, embeddings[i] as number[]);
        }

        insertKnowledgeChunkFts(chunkId, agentId, chunks[i].content);
      }

      db.prepare(`
        UPDATE knowledge_sources
        SET status = 'completed', chunks_count = ?, processed_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(chunks.length, sourceId);
    });
    insertAll();

    emitProgress({ sourceId, stage: 'completed', progress: 100 });

    source = getKnowledgeSource(sourceId)!;
    return source;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sourceId }, 'Document ingestion failed');

    getDb().prepare(`
      UPDATE knowledge_sources
      SET status = 'failed', error_message = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(errMsg, sourceId);

    emitProgress({ sourceId, stage: 'failed', progress: 0 });
    throw err;
  }
}


export async function reprocessDocument(
  sourceId: string,
  newStrategy: ChunkStrategy,
  chunkSize: number,
  chunkOverlap: number,
  emitProgress: ProgressEmitter,
): Promise<void> {
  const source = getKnowledgeSource(sourceId);
  if (!source) throw new Error(`Knowledge source not found: ${sourceId}`);

  const { agentId } = source;

  getDb().prepare(`
    UPDATE knowledge_sources
    SET status = 'processing', chunk_strategy = ?, chunk_size = ?,
        chunk_overlap = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(newStrategy, chunkSize, chunkOverlap, sourceId);

  emitProgress({ sourceId, stage: 'parsing', progress: 10 });

  try {
    const raw = loadRawDocument(agentId, sourceId);

    emitProgress({ sourceId, stage: 'chunking', progress: 30 });
    const chunks = await chunkDocument(raw, newStrategy, chunkSize, chunkOverlap);

    for (const chunk of chunks) {
      if (!chunk.token_count) {
        chunk.token_count = countTokens(chunk.content);
      }
    }

    emitProgress({ sourceId, stage: 'embedding', progress: 60 });
    const embeddings = await generateEmbeddingsBatch(chunks.map((c) => c.content));

    emitProgress({ sourceId, stage: 'indexing', progress: 85 });

    const swapChunks = getDb().transaction(() => {
      const oldChunkIds = getDb().prepare(
        'SELECT id FROM knowledge_chunks WHERE source_id = ?',
      ).all(sourceId) as Array<{ id: string }>;

      for (const { id: cid } of oldChunkIds) {
        getDb().prepare('DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?').run(cid);
        getDb().prepare('DELETE FROM knowledge_chunks_vec WHERE chunk_id = ?').run(cid);
      }
      getDb().prepare('DELETE FROM knowledge_chunks WHERE source_id = ?').run(sourceId);

      for (let i = 0; i < chunks.length; i++) {
        const chunkId = crypto.randomUUID();
        insertKnowledgeChunk({
          id: chunkId,
          sourceId,
          agentId,
          chunkIndex: i,
          content: chunks[i].content,
          tokenCount: chunks[i].token_count,
          metadata: chunks[i].metadata,
          strategyUsed: newStrategy,
        });

        if (embeddings[i]) {
          insertKnowledgeChunkVec(chunkId, embeddings[i] as number[]);
        }

        insertKnowledgeChunkFts(chunkId, agentId, chunks[i].content);
      }

      getDb().prepare(`
        UPDATE knowledge_sources
        SET status = 'completed', chunks_count = ?, processed_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(chunks.length, sourceId);
    });

    swapChunks();

    emitProgress({ sourceId, stage: 'completed', progress: 100 });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sourceId }, 'Reprocess failed');

    getDb().prepare(`
      UPDATE knowledge_sources
      SET status = 'failed', error_message = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(errMsg, sourceId);

    emitProgress({ sourceId, stage: 'failed', progress: 0 });
    throw err;
  }
}
