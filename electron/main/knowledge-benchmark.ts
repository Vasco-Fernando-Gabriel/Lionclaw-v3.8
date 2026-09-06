
import { BrowserWindow } from 'electron';
import Anthropic from '@anthropic-ai/sdk';
import { CohereClient } from 'cohere-ai';
import { createLogger } from './logger';
import { getSecret } from './secrets-vault';
import {
  getKnowledgeSource,
  updateKnowledgeBenchmark,
  updateKnowledgeSource,
} from './db';
import {
  loadRawDocument,
  chunkDocument,
  countTokens,
  generateEmbeddingsBatch,
  reprocessDocument,
  type ChunkStrategy,
  type ChunkResult,
} from './knowledge-engine';

const logger = createLogger('knowledge-benchmark');


const MODEL_MAP = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
  haiku: 'claude-haiku-4-5-20251001',
} as const;

const COHERE_RATE_LIMIT_MS = 650;
let lastCohereCallAt = 0;

const STRATEGY_BY_TYPE: Record<string, ChunkStrategy[]> = {
  pdf: ['recursive', 'semantic', 'page', 'agentic'],
  docx: ['recursive', 'semantic', 'agentic'],
  txt: ['recursive', 'semantic', 'agentic'],
  md: ['recursive', 'semantic', 'agentic'],
  csv: ['csv', 'recursive'],
};


interface BenchmarkProgressData {
  benchmarkId: string;
  stage: string;
  strategy?: string;
  mode?: string;
  current: number;
  total: number;
  done?: boolean;
}


interface CombinationResult {
  avg_score: number;
  true_rate: number;
  llm_judge_avg: number;
  raw_scores: number[];
}


async function waitCohereRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCohereCallAt;
  if (elapsed < COHERE_RATE_LIMIT_MS) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, COHERE_RATE_LIMIT_MS - elapsed),
    );
  }
  lastCohereCallAt = Date.now();
}

async function localCohereRerank(
  query: string,
  documents: string[],
  topN: number,
): Promise<Array<{ index: number; relevanceScore: number }>> {
  if (documents.length === 0) {
    return [];
  }

  const apiKey = await getSecret('COHERE_API_KEY');
  if (!apiKey) {
    logger.warn('No COHERE_API_KEY configured, skipping rerank');
    return documents
      .slice(0, topN)
      .map((_, i) => ({ index: i, relevanceScore: 0 }));
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
    logger.warn({ err }, 'Cohere rerank failed in benchmark, using identity ranking');
    return documents
      .slice(0, topN)
      .map((_, i) => ({ index: i, relevanceScore: 0 }));
  }
}


function simpleBM25(
  query: string,
  docs: Array<{ id: string; content: string }>,
  topK: number,
): Array<{ id: string; score: number }> {
  const queryTerms = query.toLowerCase().split(/\s+/);
  const scores = docs.map((doc) => {
    const docTerms = doc.content.toLowerCase().split(/\s+/);
    let score = 0;
    for (const term of queryTerms) {
      const tf = docTerms.filter((t) => t === term).length;
      score += tf / (tf + 1.2);
    }
    return { id: doc.id, score };
  });
  return scores.sort((a, b) => b.score - a.score).slice(0, topK);
}


function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

function vectorSearch(
  queryEmb: Float32Array,
  index: Map<string, Float32Array>,
  topK: number,
): Array<{ id: string; score: number }> {
  const scores: Array<{ id: string; score: number }> = [];
  for (const [id, emb] of index) {
    scores.push({ id, score: cosineSimilarity(queryEmb, emb) });
  }
  return scores.sort((a, b) => b.score - a.score).slice(0, topK);
}


function rrfMerge(
  list1: Array<{ id: string }>,
  list2: Array<{ id: string }>,
  k: number = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  list1.forEach((item, rank) => {
    scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank + 1));
  });
  list2.forEach((item, rank) => {
    scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank + 1));
  });
  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}


async function generateQuestions(
  rawText: string,
  n: number,
  client: Anthropic,
): Promise<string[]> {
  const prompt = `Voce recebera o conteudo de um documento. Gere ${n} perguntas variadas que esse documento responde.
Inclua: perguntas factuais diretas, perguntas que exigem sintese de multiplas partes, e perguntas
sobre detalhes tecnicos. Escreva as perguntas como um usuario real as faria, em linguagem natural.
Retorne APENAS JSON sem markdown: { "questions": ["pergunta 1", "pergunta 2", ...] }

Documento:
${rawText.slice(0, 12000)}`;

  const response = await client.messages.create({
    model: MODEL_MAP.sonnet,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text : '';
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const parsed = JSON.parse(cleaned) as { questions: string[] };
  return parsed.questions.slice(0, n);
}


async function judgeRelevance(
  query: string,
  content: string,
  model: 'sonnet' | 'opus',
  client: Anthropic,
): Promise<number> {
  const prompt = `Pergunta: ${query}

Trecho recuperado:
${content}

O trecho acima responde a pergunta? Avalie de 0 a 100:
0-30:   Irrelevante ou sem relacao
31-60:  Tangencialmente relacionado mas nao responde
61-80:  Responde parcialmente, faltam informacoes
81-100: Responde diretamente com qualidade

Retorne APENAS JSON sem markdown: { "score": N, "reason": "explicacao em 1 linha" }`;

  try {
    const response = await client.messages.create({
      model: MODEL_MAP[model],
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content[0].type === 'text' ? response.content[0].text : '';
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const parsed = JSON.parse(cleaned) as { score: number; reason: string };
    return Math.min(100, Math.max(0, parsed.score));
  } catch (err) {
    logger.warn({ err }, 'Judge evaluation failed, defaulting to 0');
    return 0;
  }
}


async function generateHypotheticalDoc(
  query: string,
  client: Anthropic,
): Promise<string | null> {
  try {
    const response = await client.messages.create({
      model: MODEL_MAP.haiku,
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `Escreva um paragrafo denso e tecnico que seria a resposta perfeita para:\n"${query}"\n\nUse terminologia especifica do dominio. Nao responda diretamente - simule o conteudo de um documento real que conteria essa informacao. Maximo 200 palavras.`,
        },
      ],
    });
    return response.content[0].type === 'text' ? response.content[0].text.trim() : null;
  } catch (err) {
    logger.warn({ err }, 'HyDE generation failed');
    return null;
  }
}


interface InMemoryIndices {
  vectorIndex: Map<string, Float32Array>;
  bm25Docs: Array<{ id: string; content: string }>;
  idToContent: Map<string, string>;
}

async function searchInMemory(
  query: string,
  mode: 'standard' | 'hybrid',
  indices: InMemoryIndices,
  hydeThreshold: number,
  client: Anthropic,
): Promise<{ topContent: string; topScore: number }> {
  const { vectorIndex, bm25Docs, idToContent } = indices;

  const embResults = await generateEmbeddingsBatch([query]);
  const embRaw = embResults[0];
  if (!embRaw) {
    return { topContent: '', topScore: 0 };
  }
  const queryEmb = new Float32Array(embRaw);

  const TOP_K = 20;

  let candidateIds: string[];

  if (mode === 'standard') {
    const vecResults = vectorSearch(queryEmb, vectorIndex, TOP_K);
    candidateIds = vecResults.map((r) => r.id);
  } else {
    const bm25Results = simpleBM25(query, bm25Docs, TOP_K);
    const vecResults = vectorSearch(queryEmb, vectorIndex, TOP_K);
    const merged = rrfMerge(bm25Results, vecResults, 60);
    candidateIds = merged.map((r) => r.id);
  }

  if (candidateIds.length === 0) {
    return { topContent: '', topScore: 0 };
  }

  const candidateContents = candidateIds
    .map((id) => idToContent.get(id) ?? '')
    .filter((c) => c.length > 0);

  const rerankResults = await localCohereRerank(query, candidateContents, 1);
  const topResult = rerankResults[0];
  const topScore = topResult?.relevanceScore ?? 0;
  const topContent = topResult !== undefined
    ? (candidateContents[topResult.index] ?? '')
    : '';

  if (mode === 'hybrid' && topScore < hydeThreshold) {
    const hypothetical = await generateHypotheticalDoc(query, client);
    if (hypothetical) {
      const hydeEmbResults = await generateEmbeddingsBatch([hypothetical]);
      const hydeEmbRaw = hydeEmbResults[0];
      if (hydeEmbRaw) {
        const hydeEmb = new Float32Array(hydeEmbRaw);
        const hydeBm25 = simpleBM25(hypothetical, bm25Docs, TOP_K);
        const hydeVec = vectorSearch(hydeEmb, vectorIndex, TOP_K);
        const hydeMerged = rrfMerge(hydeBm25, hydeVec, 60);
        const hydeCandidateIds = hydeMerged.map((r) => r.id);
        const hydeCandidateContents = hydeCandidateIds
          .map((id) => idToContent.get(id) ?? '')
          .filter((c) => c.length > 0);

        if (hydeCandidateContents.length > 0) {
          const hydeRerankResults = await localCohereRerank(query, hydeCandidateContents, 1);
          const hydeTopResult = hydeRerankResults[0];
          const hydeScore = hydeTopResult?.relevanceScore ?? 0;
          if (hydeScore > topScore) {
            const hydeContent = hydeTopResult !== undefined
              ? (hydeCandidateContents[hydeTopResult.index] ?? '')
              : '';
            return { topContent: hydeContent, topScore: hydeScore };
          }
        }
      }
    }
  }

  return { topContent, topScore };
}


export async function runBenchmarkPipeline(
  benchmarkId: string,
  payload: {
    sourceIds: string[];
    agentId: string;
    config: {
      totalQuestions: number;
      modelJudge: 'sonnet' | 'opus';
      threshold: number;
    };
  },
  mainWindow: BrowserWindow | null,
): Promise<void> {
  const { sourceIds, agentId, config } = payload;
  const sourceId = sourceIds[0];
  const startTime = Date.now();

  function emitProgress(data: BenchmarkProgressData): void {
    mainWindow?.webContents.send('knowledge:benchmark:progress', data);
  }

  try {
    logger.info({ benchmarkId, sourceId, agentId }, 'Starting benchmark pipeline');

    const source = getKnowledgeSource(sourceId);
    if (!source) {
      throw new Error(`Knowledge source not found: ${sourceId}`);
    }

    const fileType = source.fileType;
    const strategies = STRATEGY_BY_TYPE[fileType] ?? ['recursive'];

    const totalCombinations = strategies.length * 2;
    let combinationIndex = 0;

    const apiKey = await getSecret('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY nao configurada');
    }
    const client = new Anthropic({ apiKey });

    emitProgress({
      benchmarkId,
      stage: 'Carregando documento',
      current: 0,
      total: totalCombinations,
    });

    const raw = loadRawDocument(agentId, sourceId);

    emitProgress({
      benchmarkId,
      stage: 'Gerando perguntas',
      current: 0,
      total: totalCombinations,
    });

    const questions = await generateQuestions(raw.text, config.totalQuestions, client);

    logger.info({ benchmarkId, questionCount: questions.length }, 'Questions generated');

    const strategiesResults: Record<string, Record<string, CombinationResult>> = {};

    for (const strategy of strategies) {
      strategiesResults[strategy] = {};

      emitProgress({
        benchmarkId,
        stage: `Gerando chunks: ${strategy}`,
        strategy,
        current: combinationIndex,
        total: totalCombinations,
      });

      let chunks: ChunkResult[];
      try {
        chunks = await chunkDocument(raw, strategy, 1000, 200);
      } catch (err) {
        logger.warn({ err, strategy }, 'chunkDocument failed for strategy, skipping');
        combinationIndex += 2;
        continue;
      }

      for (const chunk of chunks) {
        if (!chunk.token_count) {
          chunk.token_count = countTokens(chunk.content);
        }
      }

      emitProgress({
        benchmarkId,
        stage: `Gerando embeddings: ${strategy}`,
        strategy,
        current: combinationIndex,
        total: totalCombinations,
      });

      const embeddingArrays = await generateEmbeddingsBatch(
        chunks.map((c) => c.content),
      );

      const vectorIndex = new Map<string, Float32Array>();
      const bm25Docs: Array<{ id: string; content: string }> = [];
      const idToContent = new Map<string, string>();

      for (let i = 0; i < chunks.length; i++) {
        const chunkId = `bench_${strategy}_${i}`;
        const emb = embeddingArrays[i];
        if (emb) {
          vectorIndex.set(chunkId, new Float32Array(emb));
        }
        bm25Docs.push({ id: chunkId, content: chunks[i].content });
        idToContent.set(chunkId, chunks[i].content);
      }

      const indices: InMemoryIndices = { vectorIndex, bm25Docs, idToContent };

      for (const mode of ['standard', 'hybrid'] as const) {
        combinationIndex++;

        emitProgress({
          benchmarkId,
          stage: `Testando ${strategy} -> ${mode}`,
          strategy,
          mode,
          current: combinationIndex,
          total: totalCombinations,
        });

        const rawScores: number[] = [];
        const judgeScores: number[] = [];

        for (let qIdx = 0; qIdx < questions.length; qIdx++) {
          const question = questions[qIdx];

          emitProgress({
            benchmarkId,
            stage: `${strategy} (${mode}): pergunta ${qIdx + 1}/${questions.length}`,
            strategy,
            mode,
            current: combinationIndex,
            total: totalCombinations,
          });

          const { topContent, topScore } = await searchInMemory(
            question,
            mode,
            indices,
            config.threshold,
            client,
          );

          rawScores.push(topScore);

          if (topContent.length > 0) {
            emitProgress({
              benchmarkId,
              stage: `${strategy} (${mode}): judge avaliando ${qIdx + 1}/${questions.length}`,
              strategy,
              mode,
              current: combinationIndex,
              total: totalCombinations,
            });

            const judgeScore = await judgeRelevance(
              question,
              topContent,
              config.modelJudge,
              client,
            );
            judgeScores.push(judgeScore);
          } else {
            judgeScores.push(0);
          }
        }

        const avgScore =
          rawScores.length > 0
            ? rawScores.reduce((a, b) => a + b, 0) / rawScores.length
            : 0;

        const trueRate =
          rawScores.length > 0
            ? rawScores.filter((s) => s >= config.threshold).length / rawScores.length
            : 0;

        const llmJudgeAvg =
          judgeScores.length > 0
            ? judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length
            : 0;

        strategiesResults[strategy][mode] = {
          avg_score: avgScore,
          true_rate: trueRate,
          llm_judge_avg: llmJudgeAvg,
          raw_scores: rawScores,
        };

        logger.info(
          { benchmarkId, strategy, mode, avgScore, trueRate, llmJudgeAvg },
          'Combination evaluated',
        );
      }

      vectorIndex.clear();
      bm25Docs.length = 0;
      idToContent.clear();
    }

    let winnerKey = '';
    let winnerScore = -1;

    for (const [strategy, modes] of Object.entries(strategiesResults)) {
      for (const [mode, result] of Object.entries(modes)) {
        const compositeScore = result.true_rate * 0.6 + (result.llm_judge_avg / 100) * 0.4;
        if (compositeScore > winnerScore) {
          winnerScore = compositeScore;
          winnerKey = `${strategy}_${mode}`;
        }
      }
    }

    const [winnerStrategy] = winnerKey.split('_');

    logger.info(
      { benchmarkId, winnerKey, winnerScore },
      'Benchmark winner determined',
    );

    const executionTimeSec = Math.round((Date.now() - startTime) / 1000);

    const resultPayload = {
      benchmark_id: benchmarkId,
      winner: winnerKey,
      winner_score: winnerScore,
      execution_time_s: executionTimeSec,
      questions,
      strategies: strategiesResults,
    };

    updateKnowledgeBenchmark(benchmarkId, {
      status: 'completed',
      winnerStrategy: winnerKey,
      winnerScore,
      questions,
      results: resultPayload,
      executionTime: executionTimeSec,
      modelJudge: config.modelJudge,
      completedAt: new Date().toISOString(),
    });

    emitProgress({
      benchmarkId,
      stage: `Aplicando estrategia vencedora: ${winnerStrategy}`,
      current: totalCombinations,
      total: totalCombinations,
    });

    const winnerChunkStrategy = (winnerStrategy ?? 'recursive') as ChunkStrategy;

    await reprocessDocument(
      sourceId,
      winnerChunkStrategy,
      1000,
      200,
      (data) => {
        emitProgress({
          benchmarkId,
          stage: `Reprocessando: ${data.stage}`,
          current: totalCombinations,
          total: totalCombinations,
        });
      },
    );

    updateKnowledgeSource(sourceId, {
      bestStrategy: winnerChunkStrategy,
      qualityScore: winnerScore,
    });

    logger.info({ benchmarkId, winnerKey, winnerScore }, 'Benchmark pipeline complete');

    emitProgress({
      benchmarkId,
      stage: 'Concluido',
      current: totalCombinations,
      total: totalCombinations,
      done: true,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, benchmarkId }, 'Benchmark pipeline failed');

    try {
      updateKnowledgeBenchmark(benchmarkId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
      });
    } catch (dbErr) {
      logger.error({ dbErr }, 'Failed to update benchmark status to failed');
    }

    emitProgress({
      benchmarkId,
      stage: `Erro: ${errMsg}`,
      current: 0,
      total: 0,
      done: true,
    });

    throw err;
  }
}
