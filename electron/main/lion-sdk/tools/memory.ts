
import { searchSemanticMemories } from '../../memory-pipeline';

export interface MemorySearchInput {
  query: string;
  limit?: number;
}

export interface MemorySearchHit {
  content: string;
  score: number;
  createdAt: string;
}

export interface MemorySearchResult {
  ok: boolean;
  results?: MemorySearchHit[];
  error?: string;
}

export interface MemoryDeps {
  search?: typeof searchSemanticMemories;
}

export async function lionMemorySearch(
  input: MemorySearchInput,
  deps: MemoryDeps = {},
): Promise<MemorySearchResult> {
  if (!input || typeof input.query !== 'string' || input.query.trim().length === 0) {
    return { ok: false, error: 'memory_search: query obrigatoria.' };
  }
  const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 100) : 10;
  const search = deps.search ?? searchSemanticMemories;

  try {
    const rows = await search(input.query, limit);
    const results: MemorySearchHit[] = rows.map((r) => ({
      content: r.content,
      score: r.rrf_score,
      createdAt: r.created_at,
    }));
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: `memory_search falhou: ${(e as Error).message}` };
  }
}
