import { createLogger } from './logger';
import { getSetting } from './db';
import { getSecret } from './secrets-vault';

const logger = createLogger('embedding-provider');

const OPENAI_TIMEOUT_MS = 15_000;
const OLLAMA_TIMEOUT_MS = 30_000;

type ProviderAttempt =
  { embedding: number[] } | { failure: { reason: string; status?: number; notConfigured?: boolean } };

export const EMBEDDING_DIMS = 1536;
export const EMBEDDING_MODEL = 'text-embedding-3-small';

function normalizeL2(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

async function generateEmbeddingOpenAI(text: string): Promise<ProviderAttempt> {
  const apiKey = await getSecret('OPENAI_API_KEY');
  if (!apiKey) {
    logger.debug('OpenAI embedding skipped: no API key');
    return { failure: { reason: 'OPENAI_API_KEY nao configurada', notConfigured: true } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text,
        dimensions: EMBEDDING_DIMS,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      logger.warn({ status: response.status, body: errText.substring(0, 200) }, 'OpenAI embedding failed');
      return {
        failure: {
          reason: `OpenAI embeddings HTTP ${response.status}${errText ? `: ${errText.substring(0, 200)}` : ''}`,
          status: response.status,
        },
      };
    }

    const data = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };

    const embedding = data.data?.[0]?.embedding;
    if (!embedding || embedding.length === 0) {
      return { failure: { reason: 'OpenAI embeddings: resposta sem embedding' } };
    }

    return { embedding: normalizeL2(embedding) };
  } catch (err) {
    logger.warn({ err }, 'OpenAI embedding request failed');
    return {
      failure: { reason: `OpenAI embeddings: ${err instanceof Error ? err.message : String(err)}` },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function generateEmbeddingOllama(text: string): Promise<ProviderAttempt> {
  const ollamaEnabled = getSetting('ollama_enabled') === 'true';
  if (!ollamaEnabled) {
    return { failure: { reason: 'Ollama desabilitado', notConfigured: true } };
  }

  const baseUrl = getSetting('ollama_base_url') || 'http://localhost:11434';
  const model = getSetting('ollama_embedding_model') || 'nomic-embed-text';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        failure: { reason: `Ollama embeddings HTTP ${response.status}`, status: response.status },
      };
    }

    const data = (await response.json()) as { embedding?: number[] };
    if (!data.embedding || data.embedding.length === 0) {
      return { failure: { reason: 'Ollama embeddings: resposta sem embedding' } };
    }

    const normalized = normalizeL2(data.embedding);

    if (normalized.length !== EMBEDDING_DIMS) {
      logger.warn(
        { expected: EMBEDDING_DIMS, got: normalized.length, model },
        'Ollama embedding dimensions mismatch, discarding',
      );
      return {
        failure: {
          reason: `Ollama embeddings: dimensoes incompativeis (esperado ${EMBEDDING_DIMS}, veio ${normalized.length})`,
        },
      };
    }

    return { embedding: normalized };
  } catch (err) {
    return {
      failure: { reason: `Ollama embeddings: ${err instanceof Error ? err.message : String(err)}` },
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface EmbeddingResult {
  embedding: number[];
  provider: 'openai' | 'ollama';
  model: string;
  dimensions: number;
}

export type EmbeddingSuccess = { ok: true } & EmbeddingResult;

export interface EmbeddingFailure {
  ok: false;
  code: 'EMBED-FAIL';
  reason: string;
  provider: 'openai' | 'ollama' | 'none';
  status?: number;
}

export type EmbeddingOutcome = EmbeddingSuccess | EmbeddingFailure;

function pickFailure(
  openai: { reason: string; status?: number; notConfigured?: boolean },
  ollama: { reason: string; status?: number; notConfigured?: boolean },
): EmbeddingFailure {
  if (!openai.notConfigured) {
    return {
      ok: false,
      code: 'EMBED-FAIL',
      reason: openai.reason,
      provider: 'openai',
      ...(openai.status !== undefined ? { status: openai.status } : {}),
    };
  }
  if (!ollama.notConfigured) {
    return {
      ok: false,
      code: 'EMBED-FAIL',
      reason: ollama.reason,
      provider: 'ollama',
      ...(ollama.status !== undefined ? { status: ollama.status } : {}),
    };
  }
  return {
    ok: false,
    code: 'EMBED-FAIL',
    reason: 'Nenhum provider de embeddings configurado (OpenAI/Ollama)',
    provider: 'none',
  };
}

export async function generateEmbedding(text: string): Promise<EmbeddingOutcome> {
  const openaiResult = await generateEmbeddingOpenAI(text);
  if ('embedding' in openaiResult) {
    return {
      ok: true,
      embedding: openaiResult.embedding,
      provider: 'openai',
      model: EMBEDDING_MODEL,
      dimensions: openaiResult.embedding.length,
    };
  }

  const ollamaResult = await generateEmbeddingOllama(text);
  if ('embedding' in ollamaResult) {
    return {
      ok: true,
      embedding: ollamaResult.embedding,
      provider: 'ollama',
      model: getSetting('ollama_embedding_model') || 'nomic-embed-text',
      dimensions: ollamaResult.embedding.length,
    };
  }

  const failure = pickFailure(openaiResult.failure, ollamaResult.failure);
  logger.warn(
    { code: failure.code, provider: failure.provider, status: failure.status, reason: failure.reason },
    'All embedding providers failed',
  );
  return failure;
}

export async function generateEmbeddings(texts: string[]): Promise<EmbeddingOutcome[]> {
  return Promise.all(texts.map((t) => generateEmbedding(t)));
}
