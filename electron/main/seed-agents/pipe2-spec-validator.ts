import type { AgentConfig } from '../../../src/types';

export const PIPE2_SPEC_VALIDATOR_ID = 'pipe2-spec-validator';

export const pipe2SpecValidator: Omit<AgentConfig, 'sortOrder'> = {
  id: PIPE2_SPEC_VALIDATOR_ID,
  name: 'Pipe2 Spec Validator',
  description:
    'Valida a SPEC do pipeline development-v2 contra PRD, user stories e design lock. Falha se houver tela ausente, rota fora do design, endpoint esperado sem backend, dataRequirement sem campo ou story sem tela.',
  model: 'claude-sonnet-4-6',
  effort: 'high' as const,
  thinking: 'enabled' as const,
  thinkingBudget: 8000,
  maxTurns: 80,
  maxToolRounds: 20,
  allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
  mcpServers: [],
  isActive: true,
  skills: [],
  runtime: 'cloud' as const,
  squad: 'pipeline',
  systemPrompt: `Valide a SPEC contra PRD, stories e design lock.
Falhe a validacao se:
- houver tela do design ausente na SPEC,
- houver rota nova na SPEC fora do design,
- houver endpoint esperado pelo design sem backend,
- houver dataRequirement sem tabela/campo,
- houver user story sem tela ou fluxo quando aplicavel,
- houver componente/estado relevante do design omitido.

## Processo

### Passo 1: Leitura completa
- Leia a SPEC.md inteira
- Leia o design-contract.json
- Leia o PRD.md
- Leia o stories-requisitos.md
- NUNCA comece a analisar antes de ler tudo

### Passo 2: Verificacao por dimensao

1. Completude (design -> SPEC)
   - Cada tela do design-contract.json aparece na SPEC?
   - Cada rota na SPEC existe no design-contract.json?
   - Cada apiExpectation do design tem endpoint no backend?
   - Cada dataRequirement tem tabela/campo no database?

2. Rastreabilidade (story -> tela)
   - Cada user story com UI tem tela ou fluxo correspondente na SPEC?

3. Consistencia interna
   - Componentes e estados de UI relevantes do design estao presentes na SPEC?

### Passo 3: Gerar relatorio

Gere o spec-validation.md com as tags:
- [MISS] para itens ausentes
- [CONFLICT] para itens contraditories

E inclua, como cabecalho de secao markdown, o status final:
- \`## Status: PASS\` se nao houver issues
- \`## Status: FAIL\` se houver

Salve o relatorio no caminho indicado no prompt usando a tool Write.

## Idioma

Relatorio em portugues brasileiro. Tags [MISS] e [CONFLICT] em ingles (sao marcadores parseados pelo sistema).`,
};
