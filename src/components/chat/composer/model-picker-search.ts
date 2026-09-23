export interface ModelPickerSearchableModel {
  name: string;
  providerLabel: string;
  provider: string;
  modelId: string;
  isFavorite?: boolean;
}

const FAVORITE_SCORE_BOOST = 24;

export function normalizeSearchQuery(input: string): string {
  return input.trim().toLowerCase();
}

function lengthPenalty(value: string, query: string): number {
  return Math.min(64, Math.max(0, value.length - query.length));
}

const BOUNDARY_MARKERS: readonly string[] = [' ', '-', '_', '/', '.', ':'];

function findBoundaryMatchIndex(value: string, query: string): number | null {
  let bestIndex: number | null = null;
  for (const marker of BOUNDARY_MARKERS) {
    const index = value.indexOf(`${marker}${query}`);
    if (index === -1) continue;
    const matchIndex = index + marker.length;
    if (bestIndex === null || matchIndex < bestIndex) {
      bestIndex = matchIndex;
    }
  }
  return bestIndex;
}

function scoreQueryMatch(value: string, query: string, exactBase: number): number | null {
  if (!value || !query) return null;
  if (value === query) return exactBase;
  if (value.startsWith(query)) {
    return exactBase + 2 + lengthPenalty(value, query);
  }
  const boundaryIndex = findBoundaryMatchIndex(value, query);
  if (boundaryIndex !== null) {
    return exactBase + 4 + boundaryIndex * 2 + lengthPenalty(value, query);
  }
  const includesIndex = value.indexOf(query);
  if (includesIndex !== -1) {
    return exactBase + 6 + includesIndex * 2 + lengthPenalty(value, query);
  }
  return null;
}

function searchFields(model: ModelPickerSearchableModel): string[] {
  return [
    normalizeSearchQuery(model.name),
    normalizeSearchQuery(model.providerLabel),
    normalizeSearchQuery(model.provider),
    normalizeSearchQuery(model.modelId),
  ];
}

export function scoreModelPickerSearch(model: ModelPickerSearchableModel, query: string): number | null {
  const tokens = normalizeSearchQuery(query)
    .split(/\s+/u)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return 0;

  const fields = searchFields(model);
  let score = 0;

  for (const token of tokens) {
    const tokenScores: number[] = [];
    for (let index = 0; index < fields.length; index += 1) {
      const fieldScore = scoreQueryMatch(fields[index], token, index * 10);
      if (fieldScore !== null) tokenScores.push(fieldScore);
    }
    if (tokenScores.length === 0) return null;
    score += Math.min(...tokenScores);
  }

  return model.isFavorite ? score - FAVORITE_SCORE_BOOST : score;
}
