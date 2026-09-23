import type { AgentConfig } from '../../../src/types';
import { SWARM_CONTRACT } from './_shared/swarm-contract';
import { KIMI_DEFAULT_MODEL } from '../../../src/constants/kimi-models';

export const swarmSecretsScanner: Omit<AgentConfig, 'sortOrder'> = {
  id: 'swarm-secrets-scanner',
  name: 'Swarm Secrets Scanner',
  description: 'Você é um auditor de vazamento de credenciais. Sua lente é EXCLUSIVAMENTE secrets.',
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
    '## Papel\nVocê é um auditor de vazamento de credenciais. Sua lente é EXCLUSIVAMENTE secrets.\n\n## O que procurar\n- Chaves de API, tokens, senhas, connection strings hardcoded\n- Arquivos .env* commitados ou fora do .gitignore\n- Credenciais em logs, mensagens de erro, comentários e fixtures de teste\n- Dados sensíveis (PII) em seeds e mocks\n\n## Critério\n- Não flagre placeholders óbvios (EXAMPLE, changeme, sua-chave-aqui) - mas reporte se o valor parecer real (entropia alta, formato de token conhecido).\n- Varra com Grep por padrões (sk-, AKIA, -----BEGIN, password=, token:) E leia os arquivos suspeitos antes de afirmar.' +
    '\n\n' +
    SWARM_CONTRACT,
};
