
import type {
  RepoGraphTurnSample,
  RepoGraphSavingsGroup,
  RepoGraphSavingsMetrics,
} from './types';

export const REPO_GRAPH_METRICS_MIN_TURNS = 50;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function summarizeGroup(samples: RepoGraphTurnSample[]): RepoGraphSavingsGroup {
  if (samples.length === 0) {
    return { turns: 0, avgToolCalls: null, avgTokens: null };
  }
  let toolCalls = 0;
  let tokens = 0;
  for (const sample of samples) {
    toolCalls += sample.toolCalls;
    tokens += sample.tokens;
  }
  return {
    turns: samples.length,
    avgToolCalls: round1(toolCalls / samples.length),
    avgTokens: round1(tokens / samples.length),
  };
}

function savingsPct(withAvg: number | null, withoutAvg: number | null): number | null {
  if (withAvg === null || withoutAvg === null) return null;
  if (withoutAvg <= 0) return null;
  return round1(((withoutAvg - withAvg) / withoutAvg) * 100);
}

export function computeRepoGraphSavings(
  withRepoTurns: RepoGraphTurnSample[],
  withoutRepoTurns: RepoGraphTurnSample[],
): RepoGraphSavingsMetrics {
  const withRepo = summarizeGroup(withRepoTurns);
  const withoutRepo = summarizeGroup(withoutRepoTurns);
  const windowMet =
    withRepo.turns >= REPO_GRAPH_METRICS_MIN_TURNS &&
    withoutRepo.turns >= REPO_GRAPH_METRICS_MIN_TURNS;

  return {
    withRepo,
    withoutRepo,
    toolCallsSavingsPct: windowMet
      ? savingsPct(withRepo.avgToolCalls, withoutRepo.avgToolCalls)
      : null,
    tokensSavingsPct: windowMet ? savingsPct(withRepo.avgTokens, withoutRepo.avgTokens) : null,
    minTurnsWindow: REPO_GRAPH_METRICS_MIN_TURNS,
    windowMet,
  };
}
