import { MODEL_CATALOG } from './provider-presets';
import type { AgentConfig } from '../types/index';

export function resolveContextWindow(agent: AgentConfig): number | null {
  if (agent.runtime !== 'external' || !agent.externalConfig) return null;

  const { provider, model, contextWindow } = agent.externalConfig;

  if (provider === 'openai-compatible') {
    return contextWindow ?? null;
  }

  const catalogedModel = MODEL_CATALOG[provider]?.find((m) => m.id === model);
  return catalogedModel?.contextWindow ?? null;
}

export function getEffectiveModel(agent: AgentConfig): string {
  switch (agent.runtime) {
    case 'codex':
      return agent.codexConfig?.model ?? agent.model;
    case 'local':
      return agent.localConfig?.model ?? agent.model;
    case 'external':
      return agent.externalConfig?.model ?? agent.model;
    default:
      return agent.model;
  }
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return m === Math.floor(m) ? `${m}M tokens` : `${m.toFixed(1)}M tokens`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k tokens`;
  }
  return `${tokens} tokens`;
}
