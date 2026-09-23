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
import { ensureBugContext, getBugContext, patchBugManifest } from '../../bug-paths';
import { validateRepoRootPath } from '../../repo-graph/validate-root';
import {
  BUG_DISCOVERY_ID,
  BUG_SOLUTION_CONSOLIDATOR_ID,
  BUG_SPEC_VALIDATOR_ID,
  SPEC_BUILDER_ID,
} from '../../seed-agents/index';
import { BUG_ANALYSIS_PHASE_NAME, BUG_ANALYSIS_AGGREGATE_AGENT_ID } from '../../bug-analysis-runner';
import { BUG_PHASE_NAMES, getPhaseName, getPhaseAgentId, getPhaseNumberForAgent } from '../registry';
import type { PipelineEngineContext, HandlerPhaseState, ResolvedHarnessProject } from './context';

const logger = createLogger('pipeline-engine');

type BugProject = ReturnType<typeof getHarnessProject> & object;

export interface BugGraphBlock {
  block: string;
  available: boolean;
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

export async function buildBugGraphBlock(projectPath: string, task: string): Promise<BugGraphBlock> {
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

    const staleNote =
      repo.status === 'stale'
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
    projectWithRun = { ...project, config: nextConfig };
    logger.info({ projectId, runId: bugCtx.runId, runDir: bugCtx.runDir }, 'Bug Phase 1: runId persisted in DB');
  }

  if (!sessionEntry.alive) {
    const graph = await buildBugGraphBlock(projectPath, message.slice(0, 400));

    patchBugManifest(projectWithRun, {
      graphAvailable: graph.available,
      ...(graph.reason !== undefined && { graphUnavailableReason: graph.reason }),
    });

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

export async function runBugPhase2ParallelAnalysis(
  ctx: PipelineEngineContext,
  projectId: string,
  project: BugProject,
  state: HandlerPhaseState,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const bugCtx = getBugContext(project);
  if (!bugCtx) {
    throw new Error('bug run context not found — a fase 1 precisa ter gravado config.bug.runId antes da fase 2');
  }

  logger.info({ projectId, runId: bugCtx.runId }, 'Bug Phase 2: Analise Paralela starting');
  const startedAt = Date.now();

  const diagnosticoExists = fs.existsSync(bugCtx.diagnosticoPath);
  const task = diagnosticoExists ? fs.readFileSync(bugCtx.diagnosticoPath, 'utf-8').slice(0, 400) : 'bug';
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
    throw new Error(`Plano de correcao nao encontrado em ${bugCtx.planoPath} — a fase 3 precisa concluir primeiro.`);
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

  if (!fs.existsSync(bugCtx.specPath)) {
    throw new Error(
      `spec-builder did not write SPEC at expected path ${bugCtx.specPath}. ` + `Reset phase 4 and try again.`,
    );
  }

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

  logger.info({ projectId, runId: bugCtx.runId, specPath: bugCtx.specPath }, 'Bug Phase 4 (Spec Generation) completed');

  await ctx.advanceToNextPhase(projectId, state);
}

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

  const previousSpecContent = fs.existsSync(bugCtx.specPath) ? fs.readFileSync(bugCtx.specPath, 'utf-8') : '';

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

export async function finalizeBugConversationPhase(
  ctx: PipelineEngineContext,
  projectId: string,
  phase: number,
  state: HandlerPhaseState,
  project: ResolvedHarnessProject,
): Promise<void> {
  const phaseName = getPhaseName(phase, project) ?? `Phase ${phase}`;

  const agentId = getPhaseAgentId(phase, project) ?? 'unknown';
  ctx.flushAccumulatedMetrics(projectId, phase, agentId, state, 'completed', project);

  logger.info({ projectId, phase }, '[bug] Conversation phase finalized by user approval');

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
