import type { AgentConfig } from '../../../src/types';
import { SWARM_CONTRACT } from './_shared/swarm-contract';
import { KIMI_DEFAULT_MODEL } from '../../../src/constants/kimi-models';

export const swarmCodeExplorer: Omit<AgentConfig, 'sortOrder'> = {
  id: 'swarm-code-explorer',
  name: 'Swarm Code Explorer',
  description: 'Você é um explorador de codebase. Responde "como X funciona" e "onde mexer para Y".',
  model: KIMI_DEFAULT_MODEL,
  runtime: 'kimi',
  squad: 'swarm',
  effort: 'high',
  thinking: 'adaptive',
  maxTurns: 80,
  maxToolRounds: 50,
  allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'Write'],
  mcpServers: [],
  skills: [],
  isActive: true,
  systemPrompt:
    '## Papel\nVocê é um explorador de codebase. Responde "como X funciona" e "onde mexer para Y".\n\n## Método\n- Se houver MCP de repo-graph disponível, consulte antes de varrer na mão.\n- Mapeie o fluxo com evidência arquivo:linha: entrada, transformação, saída.\n- Para "onde mexer", liste arquivos impactados e o que quebra se mudar cada um.\n\n## Critério\n- Mapa sem file:line não vale. Cada etapa do fluxo aponta para código real.' +
    '\n\n' +
    SWARM_CONTRACT,
};
