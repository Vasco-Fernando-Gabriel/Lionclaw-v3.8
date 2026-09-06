import fs from 'fs';
import path from 'path';
import type { SprintJsonEntry } from './harness-planner';

export const GIT_RESTRICTIONS_BLOCK = `
## Restricoes git (CRITICO)

Voce NUNCA deve executar comandos git que modifiquem state do repositorio. Os
seguintes comandos sao PROIBIDOS sem excecao:

- git commit (em qualquer forma)
- git push (em qualquer forma)
- git reset (--hard, --soft, --mixed)
- git rebase, git merge
- git rm (use Write/Edit pra deletar via filesystem)
- git stash drop, git tag, git remote add/set-url
- Qualquer comando com flags --force, -f

Voce PODE usar comandos git somente-leitura: git status, git diff, git log,
git show, git branch --list, git ls-files.

O usuario revisa as mudancas e ele mesmo faz commit/push manualmente. Sua
responsabilidade e EDITAR os arquivos corretamente; o controle de versao e do
usuario, NUNCA seu.
`.trimStart();

export function appendGitRestrictionsToPrompt(systemPrompt: string): string {
  if (systemPrompt.includes('Restricoes git (CRITICO)')) {
    return systemPrompt;
  }
  return systemPrompt.trimEnd() + '\n\n' + GIT_RESTRICTIONS_BLOCK.trim() + '\n';
}

export function buildCoderPrompt(
  sprint: SprintJsonEntry,
  specProgressContent: string,
  projectPath: string,
): string {
  const featuresBlock = sprint.features.map(f => {
    const criteria = f.acceptance_criteria.map(c => `  - ${c}`).join('\n');
    return `### ${f.name}\n${f.description}\n\nCriterios de aceite:\n${criteria}`;
  }).join('\n\n');

  const hintsBlock = [
    sprint.hints.existing_files.length > 0
      ? `Arquivos existentes: ${sprint.hints.existing_files.join(', ')}`
      : '',
    sprint.hints.key_interfaces.length > 0
      ? `Interfaces chave: ${sprint.hints.key_interfaces.join(', ')}`
      : '',
    sprint.hints.architecture_notes
      ? `Notas de arquitetura: ${sprint.hints.architecture_notes}`
      : '',
  ].filter(Boolean).join('\n');

  let projectContext = '';
  const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    try {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      projectContext = content.length > 4000
        ? content.substring(0, 4000) + '\n\n[... truncado por limite de tokens ...]'
        : content;
    } catch {
    }
  }

  const body = `Voce e um desenvolvedor implementando a sprint "${sprint.name}" de um projeto.

## Diretorio do Projeto
${projectPath}

${projectContext ? `## Contexto do Projeto (CLAUDE.md)\n${projectContext}\n` : ''}## Limites do SDK

- O tool Read tem limite de 25.000 tokens por chamada. Para arquivos grandes, use offset+limit para ler partes especificas.
- Prefira Grep para encontrar trechos relevantes em vez de ler arquivos inteiros.
- Nunca leia arquivos maiores que 500 linhas de uma vez. Use offset/limit para ler em partes.
- Se receber erro de token overflow, reduza o range de leitura.

## Progresso Anterior
${specProgressContent || 'Nenhuma sprint anterior concluida.'}

## Sprint: ${sprint.name}
${sprint.description}

## Features a Implementar
${featuresBlock}

${hintsBlock ? `## Dicas\n${hintsBlock}` : ''}

## Stack
${sprint.stack.join(', ')}

## Instrucoes
1. Implemente TODAS as features listadas acima
2. Garanta que todos os criterios de aceite sejam atendidos
3. Rode validacao tecnica antes de finalizar:
   - Typecheck (tsc --noEmit ou equivalente)
   - Lint (se configurado)
   - Build (npm run build ou equivalente)
4. Se alguma validacao falhar, corrija antes de finalizar
5. Responda em portugues brasileiro`;

  return appendGitRestrictionsToPrompt(body);
}

export function getValidatorReportPath(specPath: string): string {
  return path.join(path.dirname(specPath), '.validator-report.md');
}

export function getEnricherSuggestionsPath(specPath: string): string {
  return path.join(path.dirname(specPath), '.enricher-suggestions.md');
}

export function buildValidatorPrompt(
  specPath: string,
  projectPath?: string,
  prdPath?: string,
  userMessage?: string,
): string {
  const reportPath = getValidatorReportPath(specPath);
  const parts: string[] = [];

  parts.push(`Voce iniciou uma sessao de validacao de SPEC.`);
  parts.push('');
  parts.push(`## Arquivo da SPEC`);
  parts.push(`Use Read para ler o arquivo da SPEC em ${specPath} antes de qualquer acao.`);
  parts.push(`Quando o usuario aprovar uma correcao, altere o arquivo diretamente via Write ou Edit.`);

  parts.push('');
  parts.push(`## Arquivo de relatorio persistente`);
  parts.push(`Caminho: ${reportPath}`);
  parts.push(`Este arquivo e sua MEMORIA entre turnos. Voce perde o contexto da conversa a cada turno, mas este arquivo permanece.`);
  parts.push(`Apos concluir sua analise, salve o relatorio completo neste arquivo ANTES de apresentar no chat.`);
  parts.push(`Use IDs sequenciais (V1, V2, V3...) e marcadores de status: [PENDENTE], [APROVADO], [APLICADO], [REJEITADO].`);

  if (projectPath) {
    parts.push('');
    parts.push(`## Projeto de referencia`);
    parts.push(`Use Glob, Grep e Read para explorar a estrutura real do projeto em ${projectPath} antes de emitir qualquer opiniao. Cruze o que a SPEC descreve com o que o codigo realmente implementa.`);
  }

  if (prdPath) {
    parts.push('');
    parts.push(`## PRD (Documento de Requisitos)`);
    parts.push(`Use Read para ler o PRD em ${prdPath}. Cruze o PRD com a SPEC para identificar requisitos presentes no PRD mas ausentes na SPEC, e vice-versa.`);
  }

  if (userMessage) {
    parts.push('');
    parts.push(`## Contexto adicional do usuario`);
    parts.push('');
    parts.push(userMessage);
  }

  parts.push('');
  parts.push(`## Instrucoes`);
  parts.push(`1. Use Read para ler a SPEC completa em ${specPath} antes de qualquer acao`);
  parts.push(`2. ${projectPath ? 'Explore o projeto de referencia com Glob/Grep/Read' : 'Analise a SPEC de forma autonoma'}`);
  parts.push(`3. ${prdPath ? 'Use Read para ler o PRD e cruzar com a SPEC' : ''}`);
  parts.push(`4. Salve o relatorio completo no arquivo ${reportPath} via Write`);
  parts.push(`5. Apresente o relatorio estruturado de validacao ao usuario no chat`);
  parts.push(`6. Aguarde aprovacao do usuario para cada correcao antes de editar`);
  parts.push(`7. Edite o arquivo da SPEC diretamente em ${specPath} via Write ou Edit apos aprovacao`);
  parts.push(`8. Atualize o status dos itens no arquivo de relatorio apos cada edicao`);
  parts.push(`9. Responda em portugues brasileiro`);

  return parts.join('\n');
}

export function buildEnricherPrompt(
  specPath: string,
  projectPath?: string,
): string {
  const suggestionsPath = getEnricherSuggestionsPath(specPath);
  const parts: string[] = [];

  parts.push(`Voce iniciou uma sessao de enriquecimento de SPEC.`);
  parts.push('');
  parts.push(`## Arquivo da SPEC`);
  parts.push(`Use Read para ler o arquivo da SPEC em ${specPath} antes de qualquer acao.`);
  parts.push(`Quando o usuario aprovar uma resposta, incorpore as definicoes diretamente no arquivo via Write ou Edit.`);

  parts.push('');
  parts.push(`## Arquivo de sugestoes persistente`);
  parts.push(`Caminho: ${suggestionsPath}`);
  parts.push(`Este arquivo e sua MEMORIA entre turnos. Voce perde o contexto da conversa a cada turno, mas este arquivo permanece.`);
  parts.push(`Apos concluir sua analise, salve todas as sugestoes neste arquivo ANTES de apresentar no chat.`);
  parts.push(`Use IDs sequenciais (E1, E2, E3...) e marcadores de status: [PENDENTE], [APROVADO], [APLICADO], [REJEITADO].`);

  if (projectPath) {
    parts.push('');
    parts.push(`## Projeto de referencia`);
    parts.push(`Use Glob, Grep e Read para explorar a estrutura e os padroes do projeto em ${projectPath}. Use o que encontrar para embasar suas sugestoes de enriquecimento.`);
  }

  parts.push('');
  parts.push(`## Instrucoes`);
  parts.push(`1. Use Read para ler a SPEC completa em ${specPath} antes de qualquer acao`);
  parts.push(`2. ${projectPath ? 'Explore o projeto de referencia com Glob/Grep/Read' : 'Analise a SPEC de forma autonoma'}`);
  parts.push(`3. Mapeie cada feature e identifique lacunas (edge cases, estados de UI, textos, limites, permissoes)`);
  parts.push(`4. Salve todas as sugestoes no arquivo ${suggestionsPath} via Write`);
  parts.push(`5. Apresente todas as perguntas/sugestoes de uma vez no chat, agrupadas por feature`);
  parts.push(`6. Aguarde o usuario responder antes de editar a SPEC`);
  parts.push(`7. Edite o arquivo da SPEC diretamente em ${specPath} via Write ou Edit apos aprovacao de cada item`);
  parts.push(`8. Atualize o status dos itens no arquivo de sugestoes apos cada edicao`);
  parts.push(`9. Responda em portugues brasileiro`);

  return parts.join('\n');
}

export function buildValidatorFollowUpPrompt(
  specPath: string,
  userMessage: string,
): string {
  const reportPath = getValidatorReportPath(specPath);
  return `## Continuacao da sessao de validacao

IMPORTANTE: Voce NAO tem memoria da conversa anterior. Seu contexto esta no arquivo de relatorio persistente.

1. Use Read para ler seu relatorio em ${reportPath} - ele contem todos os itens que voce identificou e seus status atuais
2. Use Read para ler a SPEC atual em ${specPath} (pode ter sido editada desde seu ultimo turno)
3. Processe a mensagem do usuario abaixo
4. Apos aplicar qualquer edicao na SPEC, atualize o status dos itens no arquivo de relatorio

## Mensagem do usuario
${userMessage}`;
}

export function buildEnricherFollowUpPrompt(
  specPath: string,
  userMessage: string,
): string {
  const suggestionsPath = getEnricherSuggestionsPath(specPath);
  return `## Continuacao da sessao de enriquecimento

IMPORTANTE: Voce NAO tem memoria da conversa anterior. Seu contexto esta no arquivo de sugestoes persistente.

1. Use Read para ler suas sugestoes em ${suggestionsPath} - ele contem todos os itens que voce sugeriu e seus status atuais
2. Use Read para ler a SPEC atual em ${specPath} (pode ter sido editada desde seu ultimo turno)
3. Processe a mensagem do usuario abaixo
4. Apos aplicar qualquer edicao na SPEC, atualize o status dos itens no arquivo de sugestoes

## Mensagem do usuario
${userMessage}`;
}

export function buildCoderFeedbackPrompt(
  sprint: SprintJsonEntry,
  evaluatorFeedback: string,
): string {
  const feedback = `O Evaluator rejeitou a implementacao anterior. Corrija os problemas abaixo:

## Feedback do Evaluator
${evaluatorFeedback}

## Criterios que DEVEM passar
${sprint.features.map(f =>
  f.acceptance_criteria.map(c => `- ${c}`).join('\n')
).join('\n')}

## Limites do SDK

- O tool Read tem limite de 25.000 tokens por chamada. Para arquivos grandes, use offset+limit para ler partes especificas.
- Prefira Grep para encontrar trechos relevantes em vez de ler arquivos inteiros.
- Nunca leia arquivos maiores que 500 linhas de uma vez. Use offset/limit para ler em partes.
- Se receber erro de token overflow, reduza o range de leitura.

Corrija os problemas e garanta que TODOS os criterios passem. Rode a validacao tecnica novamente antes de finalizar.`;

  return appendGitRestrictionsToPrompt(feedback);
}
