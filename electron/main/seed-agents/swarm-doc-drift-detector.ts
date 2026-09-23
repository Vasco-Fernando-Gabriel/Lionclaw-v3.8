import type { AgentConfig } from '../../../src/types';
import { SWARM_CONTRACT } from './_shared/swarm-contract';
import { KIMI_DEFAULT_MODEL } from '../../../src/constants/kimi-models';

export const swarmDocDriftDetector: Omit<AgentConfig, 'sortOrder'> = {
  id: 'swarm-doc-drift-detector',
  name: 'Swarm Doc Drift Detector',
  description:
    'Você é um detector de drift de documentação. Sua lente é EXCLUSIVAMENTE: a doc ainda descreve o código real?',
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
    '## Papel\nVocê é um detector de drift de documentação. Sua lente é EXCLUSIVAMENTE: a doc ainda descreve o código real?\n\n## Método\n- Verifique cada afirmação verificável de README, AGENTS.md e docs/ contra o código (paths, contagens, comandos, canais, tabelas, fases).\n- Cada divergência: mostre o que a doc diz E o que o código faz, ambos com evidência.\n\n## Critério\n- Opinião e aspiracional não são drift. Drift é fato documental falso ou obsoleto.' +
    '\n\n' +
    SWARM_CONTRACT,
};
