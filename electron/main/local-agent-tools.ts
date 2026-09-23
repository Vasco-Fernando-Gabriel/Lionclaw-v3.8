import { getAllAgents } from './db';
import type { AgentConfig } from '../../src/types';

export function getLocalAgentsDescription(): string {
  const agents = getAllAgents().filter((a: AgentConfig) => a.isActive && a.runtime === 'local' && a.localConfig);

  if (agents.length === 0) return '';

  const providerLabel: Record<string, string> = {
    ollama: 'Ollama',
    lmstudio: 'LM Studio',
    'openai-compatible': 'OpenAI-compatible',
  };

  const lines = agents.map((a) => {
    const mode = a.localMode === 'smart' ? 'smart (com tools)' : 'simple (text-only)';
    const tools = a.localMode === 'smart' && a.allowedTools.length > 0 ? ` | tools: ${a.allowedTools.join(', ')}` : '';
    const provider = providerLabel[a.localConfig?.provider || 'ollama'] || 'Local';
    return `  - agentId: "${a.id}" | nome: ${a.name} | ${a.description} | modo: ${mode} | provider: ${provider} | modelo: ${a.localConfig?.model}${tools}`;
  });

  return (
    `\n## Agentes Locais Disponiveis (via run_local_agent)\n\n` +
    `Use a tool run_local_agent para delegar tarefas a estes agentes locais.\n` +
    `Eles rodam em modelos locais (Ollama/LM Studio) na maquina, sem custo de API.\n\n` +
    lines.join('\n') +
    '\n'
  );
}

export function getExternalAgentsDescription(): string {
  const agents = getAllAgents().filter((a: AgentConfig) => a.isActive && a.runtime === 'external' && a.externalConfig);

  if (agents.length === 0) return '';

  const providerLabel: Record<string, string> = {
    openrouter: 'OpenRouter',
    openai: 'OpenAI',
    'openai-compatible': 'Custom API',
  };

  const lines = agents.map((a) => {
    const mode = a.localMode === 'smart' ? 'smart (com tools)' : 'simple (text-only)';
    const tools = a.localMode === 'smart' && a.allowedTools.length > 0 ? ` | tools: ${a.allowedTools.join(', ')}` : '';
    const provider = providerLabel[a.externalConfig?.provider || 'openrouter'] || 'External';
    return `  - agentId: "${a.id}" | nome: ${a.name} | ${a.description} | modo: ${mode} | provider: ${provider} | modelo: ${a.externalConfig?.model}${tools}`;
  });

  return (
    `\n## Agentes Externos Disponiveis (via run_external_agent)\n\n` +
    `Use a tool run_external_agent para delegar tarefas a estes agentes externos.\n` +
    `Eles rodam em APIs externas (OpenRouter, OpenAI, etc) via HTTP.\n\n` +
    lines.join('\n') +
    '\n'
  );
}
