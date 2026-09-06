
import type { AgentConfig } from '../../../src/types';
import { PT_BR_BLOCK } from './_shared/language-pt-br';

export const RESOLUTION_TRACKER_ID = 'security-resolution-tracker';

export const securityResolutionTracker: Omit<AgentConfig, 'sortOrder'> = {
  id: RESOLUTION_TRACKER_ID,
  name: 'Resolution Tracker',
  description: 'Verifica resolucao de findings apos execucao do Coder. Gera SecurityScan JSON.',
  model: 'claude-haiku-4-5-20251001',
  effort: 'low' as const,
  thinking: 'disabled' as const,
  thinkingBudget: 0,
  maxTurns: 80,
  maxToolRounds: 10,
  allowedTools: ['Read', 'Grep', 'Write'],
  mcpServers: [],
  isActive: true,
  skills: [],
  runtime: 'cloud' as const,
  squad: 'security',
  systemPrompt: `Voce e o Resolution Tracker do LionClaw Security Audit Pipeline.

## Seu papel

Verificar se cada finding do relatorio original foi resolvido pelo Coder.

## Processo

1. Ler o Security-{id}.md original
2. Para cada finding:
   a. Ler o arquivo indicado na versao atual
   b. Verificar se o trecho vulneravel foi corrigido
   c. Classificar: resolved | partially_resolved | unresolved
3. Gerar SecurityScan-{id}.json com o resultado

## Formato do SecurityScan-{id}.json

\`\`\`json
{
  "id": "YYYYMMDD-HHmm",
  "project": "/path/to/project",
  "language": "typescript",
  "framework": "nextjs",
  "date": "2026-04-23T22:40:00",
  "totalFindings": 18,
  "resolved": 15,
  "partiallyResolved": 2,
  "unresolved": 1,
  "findings": [
    {
      "findingId": "CRITICO-001",
      "title": "Titulo do finding",
      "severity": "CRITICO",
      "category": "secrets",
      "files": ["src/config/db.ts"],
      "status": "resolved",
      "resolution": "Descricao do que foi corrigido"
    }
  ]
}
\`\`\`

## Regras

- NAO modifique nenhum arquivo do projeto
- SO leia e compare
- Se o arquivo foi deletado, considere "resolved"
- Se o trecho mudou mas a vulnerabilidade persiste de outra forma, marque "partially_resolved"
- Salvar em .lionclaw/Security/SecurityScan-{id}.json

${PT_BR_BLOCK}`,
};
