/**
 * Bug Pipe handlers (SPEC spec-sdk-e-bug-pipe.md secao 4.6).
 *
 * As 5 funcoes de fase do `pipelineType === 'bug'`, no molde exato de
 * `handlers/architecture-review.ts` (free functions com `ctx:
 * PipelineEngineContext` injetado):
 *
 *   - handleBugPhase1DiscoveryMessage   (fase 1, conversation — Bug Discovery)
 *   - runBugPhase2ParallelAnalysis      (fase 2, auto multi — 3 lentes)
 *   - handleBugPhase3ConsolidationMessage (fase 3, conversation — plano + gate)
 *   - runBugPhase4Spec                  (fase 4, auto — spec-builder REUSADO)
 *   - handleBugPhase5SpecValidatorMessage (fase 5, conversation — Spec Validator)
 *
 * As fases 6 (Planner), 7 (Sprint Validator), 8 e 9 (loop Coder/Evaluator) usam
 * os caminhos COMPARTILHADOS do engine — o wiring delas fica em index.ts.
 *
 * S8 acrescentou o tail de aprovacao PROPRIO do pipe:
 *
 *   - finalizeBugConversationPhase   (fases 1/3/5/7 — flush + gate/advance)
 *
 * Ele existe porque o predicado de Sprint Validator do finalizer compartilhado
 * (index.ts:2648-2670) e hardcoded em 9/12 e nao casa com a fase 7 do bug
 * (SPEC secao 4.12 / D33). Delta ZERO sobre os 5 pipelines existentes.
 *
 * INVARIANTES
 *  - INV-2 (R8): todo agente roda por `ctx.spawnAgent`, o unico ponto de
 *    `executeAgent` (que aplica `PERM_BYPASS_NO_GUARD`). Nenhum caller passa
 *    `permission`. A fase 2 abre 3 agentes pelo `ctx.createBugAnalysisRunner()`,
 *    que reusa o MESMO spawnAgent.
 *  - INV-13: nada de SQL aqui; tudo por helpers de `db.ts` / `persistMessage`.
 *  - R6 ADR: a fase 4 REUSA `spec-builder` com briefing no user message. O Bug
 *    Pipe NAO tem spec builder proprio (B-AC9).
 *  - Prompts referenciam SEMPRE o PATH ABSOLUTO do `BugContext`, nunca o
 *    basename (os arquivos reais carregam o sufixo `<runId>`).
 *  - D23: os agentes NAO tem o MCP repo-graph. O contexto do grafo e
 *    PRE-COMPUTADO aqui e injetado no user message; sem grafo, entra o bloco de
 *    degradacao com instrucao de grep + aviso DURAVEL em `pipeline_messages`.
 */

import * as fs from 'fs';
import { createLogger } from '../../logger';
import { emitIPC } from '../../pipeline-shared/ipc-emitter';
import { emitPipelineStream } from '../stream';
import { persistMessage } from '../../pipeline-shared/persist';
import { buildCodexResumePrompt } from '../codex-sessions';
import { rethrowPipelinePause } from '../provider-auth';
import {
  getHarnessProject,
  updateHarnessProject,
  savePipelinePhaseMetrics,
  getLocalRepositoryByCanonicalPath,
} from '../../db';
import {
  ensureBugContext,
  getBugContext,
  patchBugManifest,
} from '../../bug-paths';
import { validateRepoRootPath } from '../../repo-graph/validate-root';
import {
  BUG_DISCOVERY_ID,
  BUG_SOLUTION_CONSOLIDATOR_ID,
  BUG_SPEC_VALIDATOR_ID,
  SPEC_BUILDER_ID,
} from '../../seed-agents/index';
import {
  BUG_ANALYSIS_PHASE_NAME,
  BUG_ANALYSIS_AGGREGATE_AGENT_ID,
} from '../../bug-analysis-runner';
import {
  BUG_PHASE_NAMES,
  getPhaseName,
  getPhaseAgentId,
  getPhaseNumberForAgent,
} from '../registry';
import type {
  PipelineEngineContext,
  HandlerPhaseState,
  ResolvedHarnessProject,
} from './context';

const logger = createLogger('pipeline-engine');

type BugProject = ReturnType<typeof getHarnessProject> & object;

// -------------------------------------------------------------------------
// Contexto do grafo de codigo (secao 4.8 / D23)
// -------------------------------------------------------------------------

export interface BugGraphBlock {
  /** Bloco pronto para injetar no user message. */
  block: string;
  available: boolean;
  /** Motivo canonico da indisponibilidade (vai para o manifest). */
  reason?: string;
}

const GRAPH_HEADING = '## Contexto do grafo de codigo (CodeGraph)';

function buildGraphUnavailableBlock(reason: string): string {
  return `${GRAPH_HEADING}

NAO DISPONIVEL. Motivo: ${reason}.

Investigue com Grep, Glob e Read. Comece pelos termos do diagnostico (nomes de
funcao, mensagens de erro, nomes de arquivo citados) e expanda a partir dos
resultados. Custa mais leitura; declare no seu documento que a investigacao foi
feita sem grafo.`;
}

/**
 * Aviso DURAVEL ao usuario (persistido em `pipeline_messages` da fase 1).
 *
 * O separador final NAO e decoracao: `getPipelinePhaseMessages` funde linhas
 * CONSECUTIVAS de mesmo role na leitura (merge do GAP-01, `db.ts:8604-8612`),
 * entao o aviso e a resposta do agente chegam ao renderer no mesmo balao. As
 * duas linhas seguem SEPARADAS em `pipeline_messages`; o `---` garante que a
 * fusao continue legivel em vez de emendar as duas frases.
 */
export function buildGraphDegradationNotice(reason: string): string {
  return `Contexto do grafo de codigo (CodeGraph) NAO DISPONIVEL neste run. Motivo: ${reason}.

A investigacao do bug vai rodar em modo grep (Grep, Glob e Read): custa mais
leitura e pode ser menos precisa em codebase grande.

Para criar o grafo, abra a pagina do pipeline deste projeto: o convite de criacao
do grafo aparece na fase 1. O pipeline nao espera pelo build — o grafo entra
assim que ficar pronto.

---

`;
}

/**
 * Pre-computa o contexto do grafo para o projeto (secao 4.8, passos 1-5).
 *
 * Resolucao do repositorio: `validateRepoRootPath` (realpath + git toplevel) e
 * `getLocalRepositoryByCanonicalPath`. NAO usar `path.resolve`: projeto em
 * subdiretorio de repo git ou path com symlink nao casaria, a busca falharia em
 * silencio e o bloco do grafo nunca seria injetado mesmo com o grafo `ready`.
 *
 * Registro do repositorio (secao 4.8.1 item 7): quando nao ha repo registrado, o
 * HANDLER chama `addRepository` — idempotente por canonical_root_path, so
 * valida/canonicaliza e faz detect lazy. NAO constroi grafo, NAO custa nada,
 * NAO pede consentimento (o consentimento continua sendo o gate do BUILD, no
 * modal da PipelinePage). Sem isso, todo run dirigido pelo orquestrador com a
 * PipelinePage fechada degradaria para grep mesmo em repo com `.codegraph`
 * pronto.
 */
export async function buildBugGraphBlock(
  projectPath: string,
  task: string,
): Promise<BugGraphBlock> {
  const unavailable = (reason: string): BugGraphBlock => ({
    block: buildGraphUnavailableBlock(reason),
    available: false,
    reason,
  });

  try {
    const validated = validateRepoRootPath(projectPath);
    if ('error' in validated) {
      return unavailable('sem repositorio registrado');
    }

    let repo = getLocalRepositoryByCanonicalPath(validated.canonicalRootPath);
    if (!repo) {
      // import dinamico (molde local-ipc/jsonrpc-methods.ts:1364-1365)
      const { getRepoGraphEngine } = await import('../../ipc/repo-graph');
      const added = await getRepoGraphEngine().addRepository(projectPath);
      if (!('error' in added)) {
        repo = added;
      }
    }
    if (!repo) {
      return unavailable('sem repositorio registrado');
    }

    if (repo.status === 'building') {
      return unavailable('indexacao em curso');
    }
    if (repo.status !== 'ready' && repo.status !== 'stale') {
      return unavailable('grafo nao criado');
    }

    const { getRepoGraphEngine } = await import('../../ipc/repo-graph');
    const context = await getRepoGraphEngine().asReader().minimalContext({
      rootPath: repo.canonicalRootPath,
      repositoryId: repo.id,
      task,
    });

    const staleNote = repo.status === 'stale'
      ? `\n\nO grafo esta DESATUALIZADO em relacao ao worktree. Use-o para navegar,\nmas confirme detalhes recentes lendo o arquivo.`
      : '';

    return {
      block: `${GRAPH_HEADING}

Status do grafo: ${repo.status}

${context.renderedMarkdown}${staleNote}`,
      available: true,
    };
  } catch (err) {
    logger.warn({ err, projectPath }, 'Bug Pipe: falha ao resolver o contexto do grafo');
    return unavailable('grafo nao criado');
  }
}

// -------------------------------------------------------------------------
// Bug Phase 1: Bug Discovery (conversation)
// -------------------------------------------------------------------------

export async function handleBugPhase1DiscoveryMessage(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  project: BugProject,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const sessionKey = 'bug-phase1';
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  // Gating write do runId. Sem ele NENHUMA fase seguinte acha o runDir.
  // O DUPLO SPREAD e obrigatorio: preserva o resto de `config` e o resto de
  // `config.bug` (molde handlers/architecture-review.ts:78-98).
  const { context: bugCtx, runIdGenerated } = ensureBugContext(project);
  let projectWithRun = project;
  if (runIdGenerated) {
    const nextConfig = {
      ...project.config,
      bug: {
        ...(project.config.bug ?? {}),
        runId: bugCtx.runId,
      },
    };
    updateHarnessProject(projectId, { config: nextConfig });
    // A copia em memoria recebida por parametro ainda esta SEM o runId. Toda
    // leitura posterior nesta chamada (patchBugManifest -> getBugContext) usa
    // `config.bug.runId`, entao precisa da versao ja atualizada.
    projectWithRun = { ...project, config: nextConfig };
    logger.info(
      { projectId, runId: bugCtx.runId, runDir: bugCtx.runDir },
      'Bug Phase 1: runId persisted in DB',
    );
  }

  if (!sessionEntry.alive) {
    // Contexto do grafo: pre-computado UMA vez, no primeiro turno da fase.
    const graph = await buildBugGraphBlock(projectPath, message.slice(0, 400));

    // Estado no manifest (leitura posterior por UI/relatorio).
    patchBugManifest(projectWithRun, {
      graphAvailable: graph.available,
      ...(graph.reason !== undefined && { graphUnavailableReason: graph.reason }),
    });

    // Aviso DURAVEL (secao 4.8): chunk de `pipeline:stream` NAO e persistido e
    // evapora no primeiro `loadPhaseHistory`. Persistido ANTES do spawn para
    // nao se colar no texto do agente.
    if (!graph.available) {
      persistMessage(
        { kind: 'pipeline', projectId, phaseNumber: 1 },
        'assistant',
        buildGraphDegradationNotice(graph.reason ?? 'grafo nao criado'),
      );
    }

    const discoveryPrompt =
      `Voce e o Bug Discovery do pipeline bug. Fase 1 de 9.\n\n` +
      `INFORMACAO IMPORTANTE: NAO modifique codigo do projeto-alvo. Voce escreve\n` +
      `EXCLUSIVAMENTE no arquivo de diagnostico abaixo.\n\n` +
      `## Entrada\n` +
      `- PROJECT ROOT: ${projectPath}\n` +
      `- Arquivo de diagnostico (escreva AQUI, com Write/Edit): ${bugCtx.diagnosticoPath}\n\n` +
      `${graph.block}\n\n` +
      `## Tarefa\n` +
      `1. Cumprimente curto e faca as 3 perguntas que mais reduzem incerteza agora.\n` +
      `2. Investigue o repo em paralelo com a conversa (Read/Glob/Grep e Bash em modo\n` +
      `   leitura). Volte com achado concreto e file:line.\n` +
      `3. Classifique cada item como OBSERVADO, VERIFICADO ou RELATADO.\n` +
      `4. Atualize ${bugCtx.diagnosticoPath} a cada rodada relevante, no formato\n` +
      `   definido no seu systemPrompt.\n` +
      `5. NUNCA proponha solucao. Esta fase descreve o PROBLEMA.\n\n` +
      `## Conclusao\n` +
      `Quando o diagnostico tiver comportamento esperado, comportamento observado,\n` +
      `reproducao (ou a declaracao de que nao foi obtida), area afetada com file:line e\n` +
      `evidencia, escreva o marcador ${ctx.PHASE_COMPLETE_MARKER} no final da sua mensagem.\n\n` +
      `## Mensagem do usuario\n${message}`;

    const phase1Acc = { text: '', completed: false };
    const result = await ctx.spawnAgent(BUG_DISCOVERY_ID, discoveryPrompt, {
      projectId,
      phaseNumber: 1,
      cwd: projectPath,
      abortController: state.abortController,
      onText: ctx.makeConversationOnText(projectId, 1, phase1Acc),
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 1, type: 'tool_call', tool: toolName });
      },
    });

    const cleanedText = phase1Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 1 }, 'assistant', cleanedText);
    }
    ctx.accumulateMetrics(state, 1, result);
    sessionEntry.alive = true;
  } else {
    const phase1Acc = { text: '', completed: false };
    const followupResult = await ctx.spawnAgent(BUG_DISCOVERY_ID, message, {
      projectId,
      phaseNumber: 1,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: true,
      priorMessages: ctx.buildPriorMessagesForPhase(projectId, 1),
      // SC-1 (Pilar C): prompt de retomada para retry de sessao Codex ceifada.
      rebuildPromptOnRetry: () =>
        buildCodexResumePrompt({
          projectId,
          phaseNumber: 1,
          preamble:
            `Voce e o Bug Discovery do pipeline bug. Fase 1 de 9.\n` +
            `INFORMACAO IMPORTANTE: NAO modifique codigo do projeto-alvo. Voce escreve\n` +
            `EXCLUSIVAMENTE no arquivo de diagnostico abaixo.\n\n` +
            `## Entrada\n` +
            `- PROJECT ROOT: ${projectPath}\n` +
            `- Arquivo de diagnostico (escreva AQUI, com Write/Edit): ${bugCtx.diagnosticoPath}\n\n` +
            `Continue investigando o problema com o usuario. NUNCA proponha solucao: ` +
            `esta fase descreve o PROBLEMA.`,
          userMessage: message,
        }),
      onText: ctx.makeConversationOnText(projectId, 1, phase1Acc),
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 1, type: 'tool_call', tool: toolName });
      },
    });

    ctx.accumulateMetrics(state, 1, followupResult);

    const cleanedText = phase1Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 1 }, 'assistant', cleanedText);
    }
  }

  if (fs.existsSync(bugCtx.diagnosticoPath)) {
    emitIPC('pipeline:document-updated', {
      projectId,
      path: bugCtx.diagnosticoPath,
      content: fs.readFileSync(bugCtx.diagnosticoPath, 'utf-8'),
    });
  }

  emitIPC('pipeline:agent-completed', { projectId });
  emitPipelineStream({ projectId, phase: 1, type: 'done' });
}

// -------------------------------------------------------------------------
// Bug Phase 2: Analise Paralela (auto, multi-agente via BugAnalysisRunner)
// -------------------------------------------------------------------------

export async function runBugPhase2ParallelAnalysis(
  ctx: PipelineEngineContext,
  projectId: string,
  project: BugProject,
  state: HandlerPhaseState,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const bugCtx = getBugContext(project);
  if (!bugCtx) {
    throw new Error(
      'bug run context not found — a fase 1 precisa ter gravado config.bug.runId antes da fase 2',
    );
  }

  logger.info({ projectId, runId: bugCtx.runId }, 'Bug Phase 2: Analise Paralela starting');
  const startedAt = Date.now();

  // Reconsulta do grafo (secao 4.8.1 item 5): o pipeline nao bloqueia esperando
  // o build da fase 1; se ele terminou no meio tempo, a fase 2 ja recebe o
  // bloco do grafo.
  const diagnosticoExists = fs.existsSync(bugCtx.diagnosticoPath);
  const task = diagnosticoExists
    ? fs.readFileSync(bugCtx.diagnosticoPath, 'utf-8').slice(0, 400)
    : 'bug';
  const graph = await buildBugGraphBlock(projectPath, task);

  const runner = ctx.createBugAnalysisRunner();
  const outcome = await runner.run({
    project: { id: projectId, projectPath },
    bugCtx,
    graphBlock: graph.block,
    abortController: state.abortController,
    callbacks: {
      onText: (chunk) => {
        emitPipelineStream({ projectId, phase: 2, type: 'text', content: chunk });
      },
      onDone: () => {
        emitPipelineStream({ projectId, phase: 2, type: 'done' });
      },
    },
  });

  for (const docPath of outcome.writtenPaths) {
    try {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: docPath,
        content: fs.readFileSync(docPath, 'utf-8'),
      });
    } catch (err) {
      logger.warn({ err, docPath }, 'Failed to emit bug analysis document');
    }
  }

  if (state.abortController.signal.aborted) return;

  logger.info(
    { projectId, written: outcome.writtenPaths.length, failed: outcome.failed.length },
    'Bug Phase 2: Analise Paralela completed',
  );

  // Linha AGREGADA da fase (sprint_index = -1). O runner ja gravou UMA linha
  // POR AGENTE com sprint_index = order (1..3). Sem esta linha o agregado fica
  // preso em 'running' desde o insert do runAutoPhase (molde
  // handlers/security.ts:193-202).
  savePipelinePhaseMetrics({
    projectId,
    phaseNumber: 2,
    phaseName: BUG_PHASE_NAMES[2] ?? BUG_ANALYSIS_PHASE_NAME,
    agentId: BUG_ANALYSIS_AGGREGATE_AGENT_ID,
    status: 'completed',
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
    metadata: { aggregateOnly: true },
  });

  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 2,
    phaseName: BUG_PHASE_NAMES[2],
    status: 'completed',
    awaitingUser: false,
  });

  await ctx.advanceToNextPhase(projectId, state);
}

// -------------------------------------------------------------------------
// Bug Phase 3: Consolidacao e Validacao (conversation + gate de 2 botoes)
// -------------------------------------------------------------------------

export async function handleBugPhase3ConsolidationMessage(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  project: BugProject,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const bugCtx = getBugContext(project);
  if (!bugCtx) {
    throw new Error('bug run context not found — as fases 1 e 2 precisam ter rodado antes da fase 3');
  }

  const sessionKey = 'bug-phase3';
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  const consolidatorPreamble =
    `Voce e o Bug Solution Consolidator do pipeline bug. Fase 3 de 9.\n\n` +
    `INFORMACAO IMPORTANTE: NAO modifique codigo do projeto-alvo. Voce escreve\n` +
    `EXCLUSIVAMENTE no arquivo de plano abaixo.\n\n` +
    `## Entrada\n` +
    `- PROJECT ROOT: ${projectPath}\n` +
    `- Analise por fluxo de execucao:  ${bugCtx.analise01Path}\n` +
    `- Analise historica:              ${bugCtx.analise02Path}\n` +
    `- Refutacao adversarial:          ${bugCtx.analise03Path}\n` +
    `- Diagnostico original:           ${bugCtx.diagnosticoPath}\n\n` +
    `## Output obrigatorio\n` +
    `- Plano de correcao (escreva AQUI, com Write/Edit): ${bugCtx.planoPath}\n`;

  if (!sessionEntry.alive) {
    const consolidatorPrompt =
      `${consolidatorPreamble}\n` +
      `## Tarefa\n` +
      `1. Leia as tres analises e o diagnostico inteiros antes de escrever.\n` +
      `2. Consolide no formato definido no seu systemPrompt, incluindo o campo\n` +
      `   "## Desfecho" (CORRIGIR | NAO HA BUG | BLOQUEADO POR INCERTEZA).\n` +
      `3. Trate a refutacao adversarial como BLOQUEANTE quando ela derrubar a hipotese\n` +
      `   em que as outras duas se apoiam.\n` +
      `4. Apresente ao usuario o resumo da causa, onde as lentes concordaram e\n` +
      `   divergiram, e as decisoes que voce tomou.\n` +
      `5. Atualize ${bugCtx.planoPath} a cada rodada relevante da conversa.\n\n` +
      `## Gate desta fase\n` +
      `Ao final o usuario tem DUAS saidas legitimas: Aprovar (o plano vira SPEC) e\n` +
      `Encerrar Pipeline (nao ha correcao a fazer). Voce NAO escolhe por ele e NAO\n` +
      `pressiona. Diga sua recomendacao e que a decisao e dele.\n\n` +
      `## Mensagem do usuario\n${message}`;

    const phase3Acc = { text: '', completed: false };
    const result = await ctx.spawnAgent(BUG_SOLUTION_CONSOLIDATOR_ID, consolidatorPrompt, {
      projectId,
      phaseNumber: 3,
      cwd: projectPath,
      abortController: state.abortController,
      onText: ctx.makeConversationOnText(projectId, 3, phase3Acc),
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 3, type: 'tool_call', tool: toolName });
      },
    });

    const cleanedText = phase3Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 3 }, 'assistant', cleanedText);
    }
    ctx.accumulateMetrics(state, 3, result);
    sessionEntry.alive = true;
  } else {
    const phase3Acc = { text: '', completed: false };
    const followupResult = await ctx.spawnAgent(BUG_SOLUTION_CONSOLIDATOR_ID, message, {
      projectId,
      phaseNumber: 3,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: true,
      priorMessages: ctx.buildPriorMessagesForPhase(projectId, 3),
      rebuildPromptOnRetry: () =>
        buildCodexResumePrompt({
          projectId,
          phaseNumber: 3,
          preamble:
            `${consolidatorPreamble}\n` +
            `Continue consolidando o plano com o usuario. O gate desta fase tem DUAS\n` +
            `saidas legitimas: Aprovar e Encerrar Pipeline. A decisao e do usuario.`,
          userMessage: message,
        }),
      onText: ctx.makeConversationOnText(projectId, 3, phase3Acc),
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 3, type: 'tool_call', tool: toolName });
      },
    });

    ctx.accumulateMetrics(state, 3, followupResult);

    const cleanedText = phase3Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 3 }, 'assistant', cleanedText);
    }
  }

  if (fs.existsSync(bugCtx.planoPath)) {
    emitIPC('pipeline:document-updated', {
      projectId,
      path: bugCtx.planoPath,
      content: fs.readFileSync(bugCtx.planoPath, 'utf-8'),
    });
  }

  emitIPC('pipeline:agent-completed', { projectId });
  emitPipelineStream({ projectId, phase: 3, type: 'done' });
}

// -------------------------------------------------------------------------
// Bug Phase 4: Spec Generation (auto — spec-builder REUSADO por briefing, D21)
// -------------------------------------------------------------------------

export async function runBugPhase4Spec(
  ctx: PipelineEngineContext,
  projectId: string,
  project: BugProject,
  state: HandlerPhaseState,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const bugCtx = getBugContext(project);
  if (!bugCtx) {
    throw new Error('bug run context not found — as fases 1 a 3 precisam ter rodado antes da fase 4');
  }
  if (!fs.existsSync(bugCtx.planoPath)) {
    throw new Error(
      `Plano de correcao nao encontrado em ${bugCtx.planoPath} — a fase 3 precisa concluir primeiro.`,
    );
  }

  const phaseName = BUG_PHASE_NAMES[4] ?? 'Spec Generation';

  const builderPrompt =
    `Gere o SPEC implementavel para o pipeline bug.\n\n` +
    `INFORMACAO IMPORTANTE: Este projeto e um pipeline de correcao de BUG.\n` +
    `O INPUT para voce NAO e um PRD. Suas fontes sao dois artefatos:\n\n` +
    `- Plano de correcao: ${bugCtx.planoPath}   (FONTE PRIMARIA - nao invente correcao ausente)\n` +
    `- Diagnostico:       ${bugCtx.diagnosticoPath}  (contexto do problema)\n\n` +
    `## Regras\n` +
    `- Use o Plano de correcao como fonte primaria. Cada item C1/C2/... do plano vira\n` +
    `  trabalho especificado na SPEC. Nao adicione correcao que nao esta no plano.\n` +
    `- Use o Diagnostico como fonte de evidencia do comportamento errado.\n` +
    `- Reexplore a codebase em ${projectPath} para confirmar paths e assinaturas\n` +
    `  atuais. Se houver drift em relacao ao plano, registre no topo da SPEC.\n` +
    `- Este pipe e CURTO de proposito: sem enricher, sem edge case inventado, sem\n` +
    `  requisito que ninguem pediu.\n` +
    `- Se algo nao foi decidido, registre em "Open Questions" (NAO chute).\n` +
    `- Inclua TODAS as secoes: Objetivo, Contexto do bug (comportamento esperado x\n` +
    `  observado), Causa consolidada com file:line, Mudancas por arquivo (executavel),\n` +
    `  Riscos e o que NAO pode quebrar, Testes de regressao (o teste que falha hoje e\n` +
    `  passa depois), Rollback, Criterios de aceite verificaveis por comando,\n` +
    `  Open Questions.\n\n` +
    `## Output\n` +
    `Salve o SPEC em: ${bugCtx.specPath}`;

  let builderOutput = '';
  let result;
  try {
    result = await ctx.spawnAgent(SPEC_BUILDER_ID, builderPrompt, {
      projectId,
      phaseNumber: 4,
      cwd: projectPath,
      abortController: state.abortController,
      onText: (chunk) => {
        builderOutput += chunk;
        emitPipelineStream({ projectId, phase: 4, type: 'text', content: chunk });
      },
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 4, type: 'tool_call', tool: toolName });
      },
    });
  } catch (err) {
    rethrowPipelinePause(err);
    if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
      logger.info({ projectId }, 'Bug Phase 4 aborted');
      return;
    }
    logger.error({ err, projectId }, 'Bug Phase 4 error');
    throw err;
  }

  if (builderOutput) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 4 }, 'assistant', builderOutput);
  }
  ctx.collectMetrics(projectId, 4, SPEC_BUILDER_ID, result, 'completed', { pipelineType: 'bug' });

  // Hard fail: sem SPEC no path esperado, as fases 5 a 9 morrem com erro tardio.
  if (!fs.existsSync(bugCtx.specPath)) {
    throw new Error(
      `spec-builder did not write SPEC at expected path ${bugCtx.specPath}. ` +
      `Reset phase 4 and try again.`,
    );
  }

  // Persist specPath in DB so subsequent phases find it.
  // Sem esta linha `resolveSpecPath` cai no fallback `<projectPath>/SPEC.md` e o
  // Planner/Coder/Evaluator ou morrem com "Spec file not found" ou — pior —
  // planejam a SPEC de uma feature antiga em silencio (B-AC27).
  updateHarnessProject(projectId, { specPath: bugCtx.specPath });

  patchBugManifest(project, {});

  emitIPC('pipeline:document-updated', {
    projectId,
    path: bugCtx.specPath,
    content: fs.readFileSync(bugCtx.specPath, 'utf-8'),
  });

  emitPipelineStream({ projectId, phase: 4, type: 'done' });
  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 4,
    phaseName,
    status: 'completed',
    awaitingUser: false,
  });

  logger.info(
    { projectId, runId: bugCtx.runId, specPath: bugCtx.specPath },
    'Bug Phase 4 (Spec Generation) completed',
  );

  await ctx.advanceToNextPhase(projectId, state);
}

// -------------------------------------------------------------------------
// Bug Phase 5: Spec Validator (conversation, SEM enricher)
// -------------------------------------------------------------------------

export async function handleBugPhase5SpecValidatorMessage(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  project: BugProject,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const bugCtx = getBugContext(project);
  if (!bugCtx) {
    throw new Error('bug run context not found — a fase 4 precisa concluir antes da fase 5');
  }
  if (!fs.existsSync(bugCtx.specPath)) {
    throw new Error(`SPEC nao encontrada em ${bugCtx.specPath} — a fase 4 precisa concluir primeiro`);
  }

  const sessionKey = 'bug-phase5';
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  const validatorPreamble =
    `Voce e o Bug Spec Validator do pipeline bug. Fase 5 de 9.\n\n` +
    `## Entrada\n` +
    `- PROJECT ROOT: ${projectPath}\n` +
    `- SPEC a auditar (voce PODE editar este arquivo): ${bugCtx.specPath}\n` +
    `- Plano de correcao aprovado (referencia, NAO editar): ${bugCtx.planoPath}\n`;

  const previousSpecContent = fs.existsSync(bugCtx.specPath)
    ? fs.readFileSync(bugCtx.specPath, 'utf-8')
    : '';

  if (!sessionEntry.alive) {
    const validatorPrompt =
      `${validatorPreamble}\n` +
      `## Tarefa\n` +
      `Audite a SPEC contra o plano e contra o codigo real, nos 5 eixos do seu\n` +
      `systemPrompt (cobertura, ancoragem, escopo, verificabilidade, regressao).\n` +
      `Corrija direto na SPEC os gaps objetivos; pergunte ao usuario o que exige\n` +
      `decisao. Nao adicione requisito novo.\n\n` +
      `Quando a SPEC estiver aprovada, escreva o marcador ${ctx.PHASE_COMPLETE_MARKER} no final da\n` +
      `sua mensagem.\n\n` +
      `## Mensagem do usuario\n${message}`;

    const phase5Acc = { text: '', completed: false };
    const result = await ctx.spawnAgent(BUG_SPEC_VALIDATOR_ID, validatorPrompt, {
      projectId,
      phaseNumber: 5,
      cwd: projectPath,
      abortController: state.abortController,
      onText: ctx.makeConversationOnText(projectId, 5, phase5Acc),
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 5, type: 'tool_call', tool: toolName });
      },
    });

    const cleanedText = phase5Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 5 }, 'assistant', cleanedText);
    }
    ctx.accumulateMetrics(state, 5, result);
    sessionEntry.alive = true;
  } else {
    const phase5Acc = { text: '', completed: false };
    const followupResult = await ctx.spawnAgent(BUG_SPEC_VALIDATOR_ID, message, {
      projectId,
      phaseNumber: 5,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: true,
      priorMessages: ctx.buildPriorMessagesForPhase(projectId, 5),
      rebuildPromptOnRetry: () =>
        buildCodexResumePrompt({
          projectId,
          phaseNumber: 5,
          preamble:
            `${validatorPreamble}\n` +
            `Continue respondendo o usuario sobre a auditoria da SPEC. Corrija direto na\n` +
            `SPEC os gaps objetivos e nao adicione requisito novo.`,
          userMessage: message,
        }),
      onText: ctx.makeConversationOnText(projectId, 5, phase5Acc),
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 5, type: 'tool_call', tool: toolName });
      },
    });

    ctx.accumulateMetrics(state, 5, followupResult);

    const cleanedText = phase5Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 5 }, 'assistant', cleanedText);
    }
  }

  // A UI so re-busca a SPEC editada por este evento. Emite so quando muda.
  if (fs.existsSync(bugCtx.specPath)) {
    const currentSpecContent = fs.readFileSync(bugCtx.specPath, 'utf-8');
    if (currentSpecContent !== previousSpecContent) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: bugCtx.specPath,
        content: currentSpecContent,
      });
    }
  }

  emitIPC('pipeline:agent-completed', { projectId });
  emitPipelineStream({ projectId, phase: 5, type: 'done' });
}

// -------------------------------------------------------------------------
// Finalize de fase conversacional do Bug Pipe (SPEC secao 4.12 (a) / D33)
// -------------------------------------------------------------------------

/**
 * Tail de aprovacao das fases conversacionais do Bug Pipe (1, 3, 5 e 7).
 *
 * Espelho de `finalizeDevV2ConversationPhase` (`handlers/development-v2.ts:1062-1110`),
 * pelo mesmo motivo: o predicado de Sprint Validator do finalizer COMPARTILHADO
 * (`index.ts:2648-2670`) e hardcoded em 9 (security / architecture-review) e 12
 * (dev / feature). No Bug Pipe o Sprint Validator e a fase **7** e nenhum dos
 * tres ramos casa — o gate `awaiting-dev-confirmation` nunca abriria e o pipe
 * entraria no loop Coder/Evaluator sem confirmacao humana (RB-1).
 *
 * D33 / DECISAO 3 da rodada 5: a generalizacao do predicado compartilhado esta
 * CANCELADA (passar `projectCtx` no switch de `index.ts:2244-2258` trocaria o
 * fallback legado `PHASE_AGENT_IDS` pela tabela do tipo real e quebraria a
 * continuidade de `pipeline_phase_metrics.agent_id` de todo projeto `feature`
 * existente). O Bug Pipe resolve o gate LOCALMENTE: delta ZERO de codigo
 * compartilhado.
 *
 * Sem sub-linha de metrica extra: o Bug Pipe nao tem equivalente do 91 / 61 /
 * 121 — a fase 4 e `spec-builder` puro (secao 4.1).
 */
export async function finalizeBugConversationPhase(
  ctx: PipelineEngineContext,
  projectId: string,
  phase: number,
  state: HandlerPhaseState,
  project: ResolvedHarnessProject,
): Promise<void> {
  const phaseName = getPhaseName(phase, project) ?? `Phase ${phase}`;

  // Metrica acumulada da conversa desta fase. O `project` SEMPRE desce, entao o
  // agentId vem de BUG_PHASE_AGENT_IDS (bug-discovery / bug-solution-consolidator
  // / bug-spec-validator / sprint-validator) e nunca do fallback do development
  // (discovery-agent / tech-database / tech-frontend) — B-AC22.
  const agentId = getPhaseAgentId(phase, project) ?? 'unknown';
  ctx.flushAccumulatedMetrics(projectId, phase, agentId, state, 'completed', project);

  logger.info({ projectId, phase }, '[bug] Conversation phase finalized by user approval');

  // Gate humano antes do loop Coder: resolve a fase do Sprint Validator
  // DINAMICAMENTE (7 no Bug Pipe). Mesmo padrao do dev-v2.
  const sprintValidatorPhase = getPhaseNumberForAgent(project, 'sprint-validator');
  if (sprintValidatorPhase !== undefined && phase === sprintValidatorPhase) {
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase,
      phaseName,
      status: 'awaiting-dev-confirmation',
      awaitingUser: true,
    });
    return;
  }

  emitIPC('pipeline:phase-changed', {
    projectId,
    phase,
    phaseName,
    status: 'completed',
    awaitingUser: false,
  });

  await ctx.advanceToNextPhase(projectId, state);
}
