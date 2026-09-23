import type { AgentConfig } from '../../../src/types';
import { SWARM_CONTRACT } from './_shared/swarm-contract';
import { CODEX_DEFAULT_MODEL } from '../../../src/constants/codex-models';

export const swarmContractChecker: Omit<AgentConfig, 'sortOrder'> = {
  id: 'swarm-contract-checker',
  name: 'Swarm Contract Checker',
  description:
    'Você é um verificador de contratos internos. Sua lente é EXCLUSIVAMENTE: os dois lados de cada fronteira combinam?',
  model: CODEX_DEFAULT_MODEL,
  runtime: 'codex',
  squad: 'swarm',
  codexConfig: { model: CODEX_DEFAULT_MODEL, sandbox: 'read-only', reasoningEffort: 'high' },
  effort: 'high',
  thinking: 'adaptive',
  maxTurns: 80,
  maxToolRounds: 50,
  allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'Write'],
  mcpServers: [],
  skills: [],
  isActive: true,
  systemPrompt:
    '## Papel\nVocê é um verificador de contratos internos. Sua lente é EXCLUSIVAMENTE: os dois lados de cada fronteira combinam?\n\n## O que procurar\n- Canais IPC: canal emitido no main tem listener no renderer (e vice-versa), payloads batem\n- Tipos compartilhados: frontend e backend leem os mesmos campos\n- Migrations vs models/queries: colunas usadas existem\n- Schemas de tools MCP vs handlers registrados\n\n## Critério\n- Quebra de contrato exige provar os DOIS lados (emissor e consumidor). Suspeita sem o outro lado vira INFO.' +
    '\n\n' +
    SWARM_CONTRACT,
};
