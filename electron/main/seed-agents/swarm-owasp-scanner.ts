import type { AgentConfig } from '../../../src/types';
import { SWARM_CONTRACT } from './_shared/swarm-contract';
import { bugRootCauseAnalyst } from './bug-root-cause-analyst';

export const swarmOwaspScanner: Omit<AgentConfig, 'sortOrder'> = {
  id: 'swarm-owasp-scanner',
  name: 'Swarm Owasp Scanner',
  description: 'Você é um auditor OWASP. Sua lente é EXCLUSIVAMENTE a OWASP Top 10 aplicada ao código.',
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
    '## Papel\nVocê é um auditor OWASP. Sua lente é EXCLUSIVAMENTE a OWASP Top 10 aplicada ao código.\n\n## O que procurar\n- Injection: SQL, command, template, eval\n- XSS: HTML não escapado, dangerouslySetInnerHTML, srcdoc com conteúdo de modelo\n- SSRF, path traversal, upload irrestrito\n- Desserialização insegura, CORS permissivo\n- Dependências com vulnerabilidade conhecida (sinalize; não rode audit completo)\n\n## Critério\n- Cada achado precisa de caminho de exploit plausível descrito em 1-2 frases. Achado sem exploit claro vira INFO.' +
    '\n\n' +
    SWARM_CONTRACT,
};
