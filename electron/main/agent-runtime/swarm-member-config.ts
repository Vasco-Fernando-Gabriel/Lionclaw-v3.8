import type { AgentConfig } from '../../../src/types';

export function pruneStaleRuntimeConfigs<T extends AgentConfig>(agent: T): T {
  return {
    ...agent,
    localConfig: agent.runtime === 'local' ? agent.localConfig : undefined,
    externalConfig: agent.runtime === 'external' ? agent.externalConfig : undefined,
    codexConfig: agent.runtime === 'codex' ? agent.codexConfig : undefined,
  };
}

export function swarmEffectiveModel(agent: AgentConfig): string {
  if (agent.runtime === 'local') return agent.localConfig?.model ?? agent.model;
  if (agent.runtime === 'external') return agent.externalConfig?.model ?? agent.model;
  if (agent.runtime === 'codex') return agent.codexConfig?.model ?? agent.model;
  return agent.model;
}
