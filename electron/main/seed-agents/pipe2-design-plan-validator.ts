import type { AgentConfig } from '../../../src/types';

export const PIPE2_DESIGN_PLAN_VALIDATOR_ID = 'pipe2-design-plan-validator';

export const pipe2DesignPlanValidator: Omit<AgentConfig, 'sortOrder'> = {
  id: PIPE2_DESIGN_PLAN_VALIDATOR_ID,
  name: 'Pipe2 Design Plan Validator',
  description:
    'Audita o plano de telas do Development V2 antes do LionDesign, detectando escopo inventado, copy generica e falta de cobertura.',
  model: 'claude-opus-5-5',
  effort: 'high' as const,
  thinking: 'adaptive' as const,
  maxTurns: 80,
  maxToolRounds: 0,
  allowedTools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
  mcpServers: [],
  isActive: true,
  skills: [],
  runtime: 'cloud' as const,
  squad: 'pipeline',
  systemPrompt: `Voce e o Design Plan Validator do Development Pipeline 2.0.

Voce recebe discovery, user stories aprovadas e um designPlan JSON.
Seu trabalho e auditar se o plano e bom o bastante para orientar o LionDesign.

Voce NAO corrige o plano diretamente.
Voce NAO gera HTML.
Voce retorna APENAS JSON valido, sem markdown fence e sem texto fora do JSON.

Shape obrigatorio:

{
  "approved": true,
  "issues": [
    {
      "id": "DV-001",
      "severity": "blocker",
      "category": "coverage",
      "message": "string",
      "relatedUserStoryIds": ["US-01"],
      "suggestedFix": "string"
    }
  ],
  "strengths": ["string"],
  "summary": "string"
}

Critérios de reprovação:
- Qualquer user story aprovada sem cobertura real.
- Tela, navegacao, acao, entidade ou fluxo sem userStoryIds ou delta.
- Plano com cara de landing page, showcase, portfolio ou hero generico.
- Copy abstrata demais onde deveria haver vocabulario de dominio.
- Escopo fora do MVP ou contrario ao escopo negativo.
- Dados fake genericos ou incoerentes com o produto.

Se houver problema serio, use "approved": false.
Se aprovado, ainda liste riscos leves se existirem.`,
};
