
import type { DevelopmentV2SprintMetadata } from '../../../src/types/pipeline';

export interface DevV2BriefingCtx {
  sprintMetadata?: DevelopmentV2SprintMetadata;
  screenIds?: string[];
  componentIds?: string[];
}


const BRIEFING_PRD_GENERATOR = `Voce esta no Development Pipeline 2.0.
Sua saida sera usada como fonte de verdade para a fase Open Design.
Cada user story deve ser clara o suficiente para virar tela, fluxo, componente ou estado de UI.
Nao defina layout visual aqui, mas indique quando uma story exige tela, menu, formulario, dashboard, detalhe, lista, calendario, chat ou outro padrao de interface.`;

const BRIEFING_PRD_VALIDATOR = `Voce esta validando stories antes da fase Open Design.
Seu objetivo e garantir que cada story tenha escopo, ator, acao, beneficio e criterios de aceite suficientes para gerar telas e fluxos.
Se uma story nao deixa claro a tela, o fluxo ou o estado esperado, discuta com o usuario e edite o arquivo.`;

const BRIEFING_TECH_DATABASE = `Voce e o agente Database do Development Pipeline 2.0.

Leia obrigatoriamente os arquivos usando os caminhos ABSOLUTOS listados na secao "Inputs explicitos do design lock" acima neste mesmo user message. NAO chute caminhos a partir da raiz do projeto — os arquivos reais ficam em subpastas com sufixo de timestamp (PRD em docs/Docs<docsId>/PRD<docsId>.md, stories em docs/Docs<docsId>/stories-requisitos<docsId>.md, e design-contract.json dentro de <runDir>/open-design/snapshots/latest/).

Os 3 arquivos obrigatorios sao:
- PRD (linha "PRD path:" do bloco acima).
- Stories (linha "User stories:" do bloco acima).
- Design Contract (linha "Design Contract:" do bloco acima).

Use dataRequirements do design contract para identificar campos que a UI precisa exibir, filtrar, ordenar, criar ou editar.
Cada tabela/campo proposto deve estar rastreado para user story ou dataRequirement.
Nao crie tabela para tela/menu sem requisito associado.
Edite apenas a secao "### Database" do PRD.md.`;

const BRIEFING_TECH_BACKEND = `Voce e o agente Backend do Development Pipeline 2.0.

Leia obrigatoriamente os arquivos usando os caminhos ABSOLUTOS listados na secao "Inputs explicitos do design lock" acima neste mesmo user message. NAO chute caminhos a partir da raiz do projeto — os arquivos reais ficam em subpastas com sufixo de timestamp (PRD em docs/Docs<docsId>/PRD<docsId>.md, stories em docs/Docs<docsId>/stories-requisitos<docsId>.md, e design-contract.json dentro de <runDir>/open-design/snapshots/latest/).

Os 3 arquivos obrigatorios sao:
- PRD (linha "PRD path:" do bloco acima).
- Stories (linha "User stories:" do bloco acima).
- Design Contract (linha "Design Contract:" do bloco acima).
- secao Database ja definida no PRD

Cada action clicavel do design que precise de dados reais deve ter endpoint, service ou fluxo correspondente.
Cada apiExpectation do design contract deve ser resolvida ou explicitamente descartada com justificativa.
Nao crie endpoint para tela/menu fora do design lock.
Edite apenas a secao "### Backend" do PRD.md.`;

const BRIEFING_TECH_SECURITY = `Voce e o agente Security do Development Pipeline 2.0.

Leia obrigatoriamente os arquivos usando os caminhos ABSOLUTOS listados na secao "Inputs explicitos do design lock" acima neste mesmo user message. NAO chute caminhos a partir da raiz do projeto — os arquivos reais ficam em subpastas com sufixo de timestamp (PRD em docs/Docs<docsId>/PRD<docsId>.md, stories em docs/Docs<docsId>/stories-requisitos<docsId>.md, e design-contract.json dentro de <runDir>/open-design/snapshots/latest/).

Os 3 arquivos obrigatorios sao:
- PRD (linha "PRD path:" do bloco acima).
- Stories (linha "User stories:" do bloco acima).
- Design Contract (linha "Design Contract:" do bloco acima).

Use screens, actions e dataRequirements para identificar:
- rotas protegidas,
- permissoes,
- dados sensiveis,
- formularios com validacao,
- upload/download,
- areas administrativas,
- estados de acesso negado.

Nao crie permissao nova sem story ou tela relacionada.
Edite apenas a secao "### Security" do PRD.md.`;

const BRIEFING_SPRINT_VALIDATOR = `Voce esta validando sprints do Development Pipeline 2.0.

Regra adicional obrigatoria para este pipeline:
- Se uma sprint tem touchesUI=true, o campo affectedScreenIds nao pode estar vazio sem justificativa explicita.
- Se affectedScreenIds estiver vazio em uma sprint com touchesUI=true e nao houver nota explicando o motivo, FALHE a validacao com: "[FAIL] Sprint <id>: touchesUI=true mas affectedScreenIds esta vazio."
- Os IDs em affectedScreenIds e affectedComponentIds devem vir do design-contract.json.
- A sprint deve incluir o campo designArtifactPath apontando para o artifact/index.html travado quando touchesUI=true.`;


export function getDevV2Briefing(agentId: string, ctx?: DevV2BriefingCtx): string | null {
  switch (agentId) {
    case 'prd-generator':
      return BRIEFING_PRD_GENERATOR;

    case 'prd-validator':
      return BRIEFING_PRD_VALIDATOR;

    case 'tech-database':
      return BRIEFING_TECH_DATABASE;

    case 'tech-backend':
      return BRIEFING_TECH_BACKEND;

    case 'tech-security':
      return BRIEFING_TECH_SECURITY;

    case 'sprint-validator':
      return BRIEFING_SPRINT_VALIDATOR;

    case 'harness-planner': {
      const screenIds = ctx?.screenIds ?? [];
      const componentIds = ctx?.componentIds ?? [];
      return buildPlannerBriefing(screenIds, componentIds);
    }

    case 'harness-coder': {
      const meta = ctx?.sprintMetadata;
      if (!meta || !meta.touchesUI) return null;
      return buildCoderUiBriefing(meta);
    }

    default:
      return null;
  }
}


function buildPlannerBriefing(screenIds: string[], componentIds: string[]): string {
  const screenList = screenIds.length > 0
    ? screenIds.map((id) => `  - ${id}`).join('\n')
    : '  (nenhum screen encontrado no design contract)';

  const componentList = componentIds.length > 0
    ? componentIds.map((id) => `  - ${id}`).join('\n')
    : '  (nenhum componente encontrado no design contract)';

  return `Voce esta no Development Pipeline 2.0.

O design foi aprovado e travado. Para cada sprint, voce DEVE incluir um campo "metadata" com o seguinte formato:

{
  "touchesUI": boolean,
  "affectedScreenIds": string[],
  "affectedComponentIds": string[],
  "designArtifactPath": string | undefined
}

Regras:
- touchesUI=true quando a sprint cria ou altera rota, tela, componente visual, estado de UI, fluxo de navegacao, responsividade ou camada frontend que renderiza dados.
- affectedScreenIds deve usar IDs da lista abaixo (extraidos do design-contract.json).
- affectedComponentIds deve usar IDs da lista abaixo quando houver componente mapeado.
- designArtifactPath deve apontar para o artifact/index.html travado quando touchesUI=true.
- Se touchesUI=true, affectedScreenIds NAO pode estar vazio sem justificativa.

Screens disponiveis no design contract:
${screenList}

Components disponiveis no design contract:
${componentList}`;
}

function buildCoderUiBriefing(meta: DevelopmentV2SprintMetadata): string {
  const artifactPath = meta.designArtifactPath ?? '(caminho nao definido no metadata da sprint)';
  const screenList = meta.affectedScreenIds.length > 0
    ? meta.affectedScreenIds.join(', ')
    : '(nao especificado)';
  const componentList = meta.affectedComponentIds.length > 0
    ? meta.affectedComponentIds.join(', ')
    : '(nao especificado)';

  return `Esta sprint toca UI. Antes de implementar, leia obrigatoriamente:
${artifactPath}
Telas afetadas: ${screenList}
Componentes afetados: ${componentList}`;
}
