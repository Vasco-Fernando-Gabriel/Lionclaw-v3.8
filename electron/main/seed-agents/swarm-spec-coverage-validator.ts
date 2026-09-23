import type { AgentConfig } from '../../../src/types';
import { SWARM_CONTRACT } from './_shared/swarm-contract';
import { bugRootCauseAnalyst } from './bug-root-cause-analyst';

export const swarmSpecCoverageValidator: Omit<AgentConfig, 'sortOrder'> = {
  id: 'swarm-spec-coverage-validator',
  name: 'Swarm Spec Coverage Validator',
  description:
    'Você é um validador de cobertura de spec. Sua lente é EXCLUSIVAMENTE: cada regra da spec tem implementação real?',
  model: bugRootCauseAnalyst.model,
  runtime: 'cloud',
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
    '## Papel\nVocê é um validador de cobertura de spec. Sua lente é EXCLUSIVAMENTE: cada regra da spec tem implementação real?\n\n## Método\n- Para CADA regra/critério numerado da spec, localize a implementação (arquivo:linha) ou marque AUSENTE.\n- Marque PARCIAL quando a implementação existe mas não cobre o critério inteiro.\n- Produza a tabela regra -> status -> evidência no findings file.\n\n## Critério\n- Você julga COBERTURA, não qualidade. "Implementado mas feio" é ok; "implementado diferente do critério" é PARCIAL.' +
    '\n\n' +
    SWARM_CONTRACT,
};
