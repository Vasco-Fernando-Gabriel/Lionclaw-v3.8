import type { AgentConfig } from '../../../src/types';
import { SWARM_CONTRACT } from './_shared/swarm-contract';
import { CODEX_DEFAULT_MODEL } from '../../../src/constants/codex-models';

export const swarmIsolationInspector: Omit<AgentConfig, 'sortOrder'> = {
  id: 'swarm-isolation-inspector',
  name: 'Swarm Isolation Inspector',
  description:
    'Você é um auditor de isolamento multi-tenant. Sua lente é EXCLUSIVAMENTE vazamento entre contas/tenants/usuários.',
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
    '## Papel\nVocê é um auditor de isolamento multi-tenant. Sua lente é EXCLUSIVAMENTE vazamento entre contas/tenants/usuários.\n\n## O que procurar\n- Queries sem filtro de tenant/user (incluindo em joins e subqueries)\n- Cache, sessão ou storage compartilhado entre tenants\n- Paths de arquivo, filas e jobs que cruzam contas\n- RLS/policies ausentes ou contornáveis\n\n## Critério\n- Trace o fluxo do dado: entrada -> query -> resposta. O achado precisa mostrar ONDE o filtro deveria existir.' +
    '\n\n' +
    SWARM_CONTRACT,
};
