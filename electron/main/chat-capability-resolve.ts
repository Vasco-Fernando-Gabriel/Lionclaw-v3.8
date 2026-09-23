import { getChatFeatureToggles } from './db';
import { CHAT_CAPABILITIES_DEFAULT_OFF } from '../../src/types';
import type { ChatFeatureToggles } from '../../src/types';
import type { QueryOptions } from './orchestrator';

export function sanitizeChatFeatureToggles(input: unknown): ChatFeatureToggles | null {
  if (typeof input !== 'object' || input === null) return null;
  const candidate = input as Record<string, unknown>;
  if (
    typeof candidate['pipelineControl'] !== 'boolean' ||
    typeof candidate['dynamicWorkflows'] !== 'boolean' ||
    (candidate['swarm'] !== undefined && typeof candidate['swarm'] !== 'boolean')
  ) {
    return null;
  }
  return {
    pipelineControl: candidate['pipelineControl'],
    dynamicWorkflows: candidate['dynamicWorkflows'],
    swarm: candidate['swarm'] === true,
  };
}

export function sanitizeChatFeatureTogglesPatch(
  input: unknown,
): { ok: true; patch: Partial<ChatFeatureToggles> } | { ok: false } {
  if (typeof input !== 'object' || input === null) return { ok: false };
  const candidate = input as Record<string, unknown>;
  const patch: Partial<ChatFeatureToggles> = {};
  for (const key of ['pipelineControl', 'dynamicWorkflows', 'swarm'] as const) {
    const value = candidate[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return { ok: false };
    patch[key] = value;
  }
  return { ok: true, patch };
}

export function resolveChatCapabilitiesForTurn(input: {
  sessionId: string | null;
  options: Pick<QueryOptions, 'featureToggles'>;
}): ChatFeatureToggles {
  const fromOptions = sanitizeChatFeatureToggles(input.options.featureToggles);
  if (fromOptions) return fromOptions;

  if (input.sessionId) {
    const persisted = getChatFeatureToggles(input.sessionId);
    if (persisted) return persisted;
  }

  return { ...CHAT_CAPABILITIES_DEFAULT_OFF };
}
