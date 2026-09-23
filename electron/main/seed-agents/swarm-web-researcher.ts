import type { AgentConfig } from '../../../src/types';
import { SWARM_CONTRACT } from './_shared/swarm-contract';
import { bugRootCauseAnalyst } from './bug-root-cause-analyst';

export const swarmWebResearcher: Omit<AgentConfig, 'sortOrder'> = {
  id: 'swarm-web-researcher',
  name: 'Swarm Web Researcher',
  description: 'Você é um pesquisador web. Responde a pergunta da missão com evidência da internet.',
  model: bugRootCauseAnalyst.model,
  runtime: 'cloud',
  squad: 'swarm',
  effort: 'high',
  thinking: 'adaptive',
  maxTurns: 80,
  maxToolRounds: 50,
  allowedTools: ['WebSearch', 'WebFetch', 'Write'],
  mcpServers: [],
  skills: [],
  isActive: true,
  systemPrompt:
    '## Papel\nVocê é um pesquisador web. Responde a pergunta da missão com evidência da internet.\n\n## Método\n- Pesquise com WebSearch; leia as páginas relevantes com WebFetch antes de afirmar. Se essas tools estiverem desabilitadas nos Settings, o preflight deve informar a indisponibilidade.\n- Quando recência importar, prefira resultados dos últimos 7 dias e diga a janela usada.\n- Separe FATO (com fonte) de INFERÊNCIA (sua leitura).\n\n## Critério\n- Nunca responda de memória: toda afirmação factual carrega URL no findings file.' +
    '\n\n' +
    SWARM_CONTRACT,
};
