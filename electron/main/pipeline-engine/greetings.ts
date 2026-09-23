import path from 'path';
import { getPipelineDocsContext } from '../pipeline-paths';

export function getArchitectureReviewConversationGreeting(phase: number, projectName: string): string | null {
  switch (phase) {
    case 2:
      return (
        `Projeto "${projectName}" (architecture-review). Inicie a triagem de alvos arquiteturais. ` +
        `Leia o Architecture Map gerado na fase anterior, proponha candidatos numerados de aprofundamento, ` +
        `recomende um candidato e aguarde a escolha do usuario.`
      );
    case 4:
      return (
        `Projeto "${projectName}" (architecture-review). Inicie a entrevista de decisao arquitetural. ` +
        `Use Map, Candidates e Diagnosis como contexto, conduza uma pergunta por vez, registre decisoes fechadas ` +
        `no arquivo ArchitectureDecisions do run e sugira fechar quando os pontos essenciais estiverem cobertos.`
      );
    case 6:
      return (
        `Projeto "${projectName}" (architecture-review). Inicie a validacao da SPEC arquitetural. ` +
        `Leia a SPEC e os artefatos Architecture Map, Candidates, Diagnosis e Decisions. ` +
        `Nao procure PRD.md nem stories-requisitos.md; este pipeline usa artefatos arquiteturais como fonte.`
      );
    case 7:
      return (
        `Projeto "${projectName}" (architecture-review). Inicie o enriquecimento da SPEC arquitetural. ` +
        `Leia a SPEC e os artefatos Architecture Map, Candidates, Diagnosis e Decisions. ` +
        `Enriqueça apenas gaps tecnicos de arquitetura, contratos, erros, permissoes, rollback, testes e criterios de aceite. ` +
        `Nao procure PRD.md, stories-requisitos.md ou design-contract.json.`
      );
    case 9:
      return (
        `Projeto "${projectName}" (architecture-review). Inicie a validacao do plano de sprints. ` +
        `Revise se os sprints implementam a SPEC arquitetural e se mantem rastreabilidade com as decisoes do run.`
      );
    default:
      return `Inicie a fase ${phase} do projeto "${projectName}" (architecture-review).`;
  }
}

export function getBugConversationGreeting(phase: number, projectName: string): string {
  switch (phase) {
    case 1:
      return (
        `Projeto "${projectName}" (bug). Inicie o diagnostico do bug. ` +
        `Faca as tres perguntas que mais reduzem incerteza e investigue o repo em paralelo. ` +
        `Descreva o PROBLEMA, nunca a solucao. ` +
        `Nao procure PRD.md nem stories-requisitos.md; este pipeline parte do relato do usuario.`
      );
    case 3:
      return (
        `Projeto "${projectName}" (bug). Consolide as tres analises paralelas num plano de correcao unico, ` +
        `resolva contradicoes e apresente ao usuario. ` +
        `Trate a refutacao adversarial como bloqueante. Preencha o campo "## Desfecho".`
      );
    case 5:
      return (
        `Projeto "${projectName}" (bug). Inicie a validacao da SPEC de correcao. ` +
        `Audite contra o plano de correcao aprovado e contra o codigo real. ` +
        `Corrija gaps objetivos, pergunte o que exige decisao e NAO adicione requisito novo.`
      );
    case 7:
      return (
        `Projeto "${projectName}" (bug). Inicie a validacao do plano de sprints. ` +
        `Revise se os sprints implementam a SPEC de correcao e se cobrem os testes de regressao.`
      );
    default:
      return `Inicie a fase ${phase} do projeto "${projectName}" (bug).`;
  }
}

export function getConversationGreeting(
  phase: number,
  projectName: string,
  project?: {
    pipelineType?: string;
    projectPath?: string;
    pipelineDocsId?: string | null;
  },
): string {
  if (project?.pipelineType === 'architecture-review') {
    return getArchitectureReviewConversationGreeting(phase, projectName)!;
  }

  if (project?.pipelineType === 'bug') {
    return getBugConversationGreeting(phase, projectName);
  }

  if (project?.pipelineType === 'development-v2') {
    switch (phase) {
      case 1:
        return (
          `Estou iniciando o projeto "${projectName}" com o pipeline Development 2.0. ` +
          `Se apresente de forma breve e amigavel, explique que voce vai conduzir o Discovery ` +
          `fazendo perguntas sobre Visao, User Stories, Requisitos, referencias visuais e contexto, ` +
          `e ja faca a primeira pergunta.`
        );
      case 3:
        return (
          `Projeto "${projectName}" (Development 2.0). Se apresente brevemente como o validador de user stories, ` +
          `explique que vai analisar o documento em busca de gaps e inconsistencias, ` +
          `e comece a analise.`
        );
      case 5:
        return (
          `Projeto "${projectName}" (Development 2.0). Fase 5: Open Design Studio. ` +
          `Esta fase usa a UI dedicada do Studio — bootstrap, design e travamento ocorrem fora do chat.`
        );
      case 8:
        return (
          `Projeto "${projectName}" (Development 2.0). Se apresente brevemente como o especialista em Database, ` +
          `explique que vai conduzir as decisoes tecnicas de banco de dados considerando o design aprovado, ` +
          `e comece a discussao. Quando o usuario confirmar com APROVAR, a fase esta concluida.`
        );
      case 9:
        return (
          `Projeto "${projectName}" (Development 2.0). Se apresente brevemente como o especialista em Backend, ` +
          `explique que vai conduzir as decisoes tecnicas de backend considerando o design aprovado, ` +
          `e comece a discussao. Quando o usuario confirmar com APROVAR, a fase esta concluida.`
        );
      case 10:
        return (
          `Projeto "${projectName}" (Development 2.0). Se apresente brevemente como o especialista em Frontend Tecnico, ` +
          `explique que vai conduzir as decisoes tecnicas de frontend considerando o design lock aprovado, ` +
          `e comece a discussao. Quando o usuario confirmar com APROVAR, a fase esta concluida.`
        );
      case 11:
        return (
          `Projeto "${projectName}" (Development 2.0). Se apresente brevemente como o especialista em Security, ` +
          `explique que vai conduzir as decisoes tecnicas de seguranca considerando o design aprovado, ` +
          `e comece a discussao. Quando o usuario confirmar com APROVAR, a fase esta concluida.`
        );
      case 13:
        return (
          `Projeto "${projectName}" (Development 2.0). Se apresente brevemente como o enriquecedor de SPEC, ` +
          `explique que vai analisar a spec buscando gaps, edge cases e melhorias de acordo com o design lock, ` +
          `e comece a analise.`
        );
      case 15:
        return (
          `Projeto "${projectName}" (Development 2.0). Se apresente brevemente como o validador de sprints, ` +
          `explique que vai revisar o plano de sprints verificando coerencia, completude e alinhamento com o design lock, ` +
          `e comece a revisao.`
        );
      default:
        return `Inicie a fase ${phase} do projeto "${projectName}" (Development 2.0).`;
    }
  }

  if (project?.pipelineType === 'security') {
    switch (phase) {
      case 4:
        return (
          `Projeto "${projectName}". Se apresente brevemente como o Validador Cetico de Seguranca, ` +
          `explique que vai revisar o relatorio com ceticismo focado em seguranca (falsos positivos, ` +
          `priorizacao por impacto de negocio, quais corrigir ja vs deferir) e comece a analise. ` +
          `Ao final, peca ao usuario confirmacao ou ajustes antes de avancar para o Skeptic Quality.`
        );
      case 5:
        return (
          `Projeto "${projectName}". Se apresente brevemente como o Validador Cetico de Qualidade, ` +
          `explique que o Skeptic Security ja revisou os findings e voce agora foca em qualidade: ` +
          `informacoes suficientes para implementar, gaps de cobertura, qualidade das solucoes. ` +
          `Ao final, peca ao usuario confirmacao ou ajustes antes de avancar para geracao de SPEC.`
        );
      case 7:
        return (
          `Projeto "${projectName}". Se apresente brevemente como o enriquecedor de SPEC de seguranca, ` +
          `explique que vai analisar a spec de correcoes buscando gaps, edge cases e melhorias, ` +
          `e comece a analise.`
        );
      case 9:
        return (
          `Projeto "${projectName}". Se apresente brevemente como o validador de sprints, ` +
          `explique que vai revisar o plano de sprints verificando coerencia e completude, ` +
          `e comece a revisao.`
        );
      default:
        return `Inicie a fase ${phase} do projeto "${projectName}".`;
    }
  }

  if (project?.pipelineType === 'feature') {
    if (phase === 1) {
      const fDocsCtx = project.projectPath
        ? getPipelineDocsContext(project.projectPath, project.pipelineDocsId ?? null)
        : null;
      const discoveryPath = fDocsCtx
        ? fDocsCtx.resolveDocPath('discovery.md')
        : project.projectPath
          ? path.join(project.projectPath, 'discovery-notes.md')
          : 'discovery-notes.md';
      return (
        `Projeto "${projectName}" (feature em repositorio existente). ` +
        `Se apresente de forma breve como o Feature Discovery Agent. ` +
        `Antes de qualquer pergunta, faca a analise inicial obrigatoria do repositorio: ` +
        `verifique se existe CLAUDE.md (gere se nao existir), identifique a stack e a estrutura, ` +
        `e leia os arquivos chave para entender as convencoes do projeto. ` +
        `Em seguida, conduza uma conversa exploratoria livre sobre a feature que o usuario quer construir, ` +
        `aprofundando em escopo, integracao com o codigo existente, edge cases e impacto. ` +
        `NAO use o roteiro de 11 perguntas do Discovery padrao (esse pipeline e para projetos do zero, nao para features). ` +
        `O arquivo de discovery deste projeto e EXATAMENTE: ${discoveryPath}. ` +
        `Apos cada troca relevante, e obrigatoriamente ao final, escreva/atualize TODO o discovery da feature ` +
        `NESSE caminho exato (crie ou sobrescreva). Nao use outro nome de arquivo nem crie um ` +
        `feature-discovery-notes separado: esse arquivo canonico e o unico que as proximas fases leem.`
      );
    }
  }

  switch (phase) {
    case 1:
      return (
        `Estou iniciando o projeto "${projectName}". ` +
        `Se apresente de forma breve e amigavel, explique que voce vai conduzir o Discovery ` +
        `fazendo 11 perguntas divididas em 5 blocos (Visao, Funcionalidades, Monetizacao, Tecnico e Contexto), ` +
        `e ja faca a primeira pergunta (Q1).`
      );
    case 3:
      return (
        `Projeto "${projectName}". Se apresente brevemente como o validador de PRD, ` +
        `explique que vai analisar o documento em busca de gaps e inconsistencias, ` +
        `e comece a analise.`
      );
    case 5:
      return (
        `Projeto "${projectName}". Se apresente brevemente como o especialista em Database, ` +
        `explique que vai conduzir as decisoes tecnicas de banco de dados para o projeto, ` +
        `leia o stories-requisitos.md e o PRD.md, e comece a discussao sobre as escolhas de database. ` +
        `Quando o usuario confirmar as decisoes com APROVAR, a fase esta concluida.`
      );
    case 6:
      return (
        `Projeto "${projectName}". Se apresente brevemente como o especialista em Backend, ` +
        `explique que vai conduzir as decisoes tecnicas de backend para o projeto, ` +
        `leia o stories-requisitos.md e o PRD.md, e comece a discussao sobre a arquitetura e stack de backend. ` +
        `Quando o usuario confirmar as decisoes com APROVAR, a fase esta concluida.`
      );
    case 7:
      return (
        `Projeto "${projectName}". Se apresente brevemente como o especialista em Frontend, ` +
        `explique que vai conduzir as decisoes tecnicas de frontend para o projeto, ` +
        `leia o stories-requisitos.md e o PRD.md, e comece a discussao sobre a stack e abordagem de frontend. ` +
        `Quando o usuario confirmar as decisoes com APROVAR, a fase esta concluida.`
      );
    case 8:
      return (
        `Projeto "${projectName}". Se apresente brevemente como o especialista em Security, ` +
        `explique que vai conduzir as decisoes tecnicas de seguranca para o projeto, ` +
        `leia o stories-requisitos.md e o PRD.md, e comece a discussao sobre requisitos e estrategias de seguranca. ` +
        `Quando o usuario confirmar as decisoes com APROVAR, a fase esta concluida.`
      );
    case 10:
      return (
        `Projeto "${projectName}". Se apresente brevemente como o enriquecedor de SPEC, ` +
        `explique que vai analisar a spec buscando gaps, edge cases e melhorias, ` +
        `e comece a analise.`
      );
    case 12:
      return (
        `Projeto "${projectName}". Se apresente brevemente como o validador de sprints, ` +
        `explique que vai revisar o plano de sprints verificando coerencia e completude, ` +
        `e comece a revisao.`
      );
    default:
      return `Inicie a fase ${phase} do projeto "${projectName}".`;
  }
}
