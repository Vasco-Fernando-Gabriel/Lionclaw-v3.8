import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../logger';
import { emitIPC } from '../../pipeline-shared/ipc-emitter';
import { emitPipelineStream } from '../stream';
import { persistMessage } from '../../pipeline-shared/persist';
import { buildCodexResumePrompt } from '../codex-sessions';
import { rethrowPipelinePause } from '../provider-auth';
import { getHarnessProject, updateHarnessProject } from '../../db';
import {
  ensureArchitectureReviewContext,
  getArchitectureReviewContext,
  patchArchitectureReviewManifest,
} from '../../architecture-review-paths';
import {
  ARCHITECTURE_MAPPER_ID,
  ARCHITECTURE_TARGET_TRIAGE_ID,
  ARCHITECTURE_DIAGNOSTICIAN_ID,
  ARCHITECTURE_DECISION_INTERVIEWER_ID,
  ARCH_SPEC_VALIDATOR_ID,
  ARCHITECTURE_SPEC_ENRICHER_ID,
  SPEC_BUILDER_ID,
  SPEC_VALIDATOR_ID,
} from '../../seed-agents/index';
import { ARCHITECTURE_PHASE_NAMES } from '../registry';
import type { PipelineEngineContext, HandlerPhaseState } from './context';

const logger = createLogger('pipeline-engine');

export async function runArchitecturePhase1Map(
  ctx: PipelineEngineContext,
  projectId: string,
  project: ReturnType<typeof getHarnessProject> & object,
  state: HandlerPhaseState,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;

  const { context: archCtx, runIdGenerated } = ensureArchitectureReviewContext(project);

  if (runIdGenerated) {
    updateHarnessProject(projectId, {
      config: {
        ...project.config,
        architectureReview: {
          ...(project.config.architectureReview ?? {}),
          runId: archCtx.runId,
        },
      },
    });
    logger.info(
      { projectId, runId: archCtx.runId, runDir: archCtx.runDir },
      'Architecture Phase 1: runId persisted in DB',
    );
  }

  const prompt =
    `Mapeie a arquitetura top-level do projeto em: ${projectPath}\n\n` +
    `Voce e o Architecture Mapper do pipeline architecture-review.\n` +
    `INFORMACAO IMPORTANTE: NAO modifique nenhum arquivo do projeto-alvo. ` +
    `Voce DEVE escrever EXCLUSIVAMENTE dentro de:\n` +
    `  ${archCtx.runDir}\n\n` +
    `Outputs obrigatorios (escreva ambos):\n` +
    `  - Markdown: ${archCtx.mapMdPath}\n` +
    `  - JSON:     ${archCtx.mapJsonPath}\n\n` +
    `Use Read/Glob/Grep/Bash para inspecionar a codebase. NAO use Write/Edit ` +
    `em nenhum path fora do diretorio acima.\n\n` +
    `Siga o processo descrito no seu systemPrompt: reconhecimento inicial, ` +
    `mapeamento top-level, hotspots e honestidade sobre o que nao foi mapeado.`;

  let phase1Output = '';
  const result = await ctx.spawnAgent(ARCHITECTURE_MAPPER_ID, prompt, {
    projectId,
    phaseNumber: 1,
    cwd: projectPath,
    abortController: state.abortController,
    onText: (chunk) => {
      phase1Output += chunk;
      emitPipelineStream({ projectId, phase: 1, type: 'text', content: chunk });
    },
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 1, type: 'tool_call', tool: toolName });
    },
  });

  if (phase1Output) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 1 }, 'assistant', phase1Output);
  }

  ctx.collectMetrics(projectId, 1, ARCHITECTURE_MAPPER_ID, result, 'completed', {
    pipelineType: 'architecture-review',
  });

  if (!fs.existsSync(archCtx.mapMdPath) || !fs.existsSync(archCtx.mapJsonPath)) {
    throw new Error(
      `architecture-mapper did not produce required artefacts. ` +
        `Expected both:\n  - ${archCtx.mapMdPath}\n  - ${archCtx.mapJsonPath}\n` +
        `Reset phase 1 and try again.`,
    );
  }
  try {
    JSON.parse(fs.readFileSync(archCtx.mapJsonPath, 'utf-8'));
  } catch (err) {
    throw new Error(`architecture-mapper produced invalid JSON at ${archCtx.mapJsonPath}: ${(err as Error).message}`);
  }

  emitIPC('pipeline:document-updated', {
    projectId,
    path: archCtx.mapMdPath,
    content: fs.readFileSync(archCtx.mapMdPath, 'utf-8'),
  });

  emitPipelineStream({ projectId, phase: 1, type: 'done' });
  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 1,
    phaseName: ARCHITECTURE_PHASE_NAMES[1],
    status: 'completed',
    awaitingUser: false,
  });

  logger.info({ projectId, runId: archCtx.runId }, 'Architecture Phase 1 (Map) completed');

  await ctx.advanceToNextPhase(projectId, state);
}

export async function handleArchitecturePhase2TriageMessage(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  project: ReturnType<typeof getHarnessProject> & object,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const sessionKey = 'architecture-phase2';
  let sessionEntry = state.continueSessions.get(sessionKey);

  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  const archCtx = getArchitectureReviewContext(project);
  if (!archCtx) {
    throw new Error(
      'architecture-review run context not found — phase 1 must have generated runId in config.architectureReview.runId before phase 2 starts',
    );
  }
  if (!fs.existsSync(archCtx.mapMdPath)) {
    throw new Error(`Architecture Map not found at ${archCtx.mapMdPath} — phase 1 must complete first`);
  }

  if (!sessionEntry.alive) {
    const triagePrompt =
      `Voce e o Architecture Target Triage do pipeline architecture-review.\n` +
      `INFORMACAO IMPORTANTE: NAO modifique codigo do projeto-alvo. ` +
      `Voce DEVE escrever EXCLUSIVAMENTE dentro de:\n` +
      `  ${archCtx.runDir}\n\n` +
      `## Entrada\n` +
      `- Architecture Map: ${archCtx.mapMdPath}\n` +
      `- Project root: ${projectPath}\n\n` +
      `## Outputs obrigatorios (escreva ambos)\n` +
      `- Markdown: ${archCtx.candidatesMdPath}\n` +
      `- JSON:     ${archCtx.candidatesJsonPath}\n\n` +
      `## Glossario arquitetural canonico (use esses termos exatamente)\n` +
      `- Module: qualquer coisa com interface + implementacao\n` +
      `- Interface: tudo que o chamador precisa saber (tipos, invariantes, ordenacao, modos de erro)\n` +
      `- Implementation: corpo interno do module\n` +
      `- Depth: leverage por unidade de interface; deep = muito comportamento atras de interface pequena\n` +
      `- Seam: lugar onde a interface existe e o comportamento pode mudar sem editar in-place\n` +
      `- Adapter: coisa concreta que satisfaz uma interface em um seam\n` +
      `- Leverage: ganho dos chamadores quando um module e deep\n` +
      `- Locality: ganho dos mantenedores; bugs/mudancas concentrados num lugar\n` +
      `- Deletion test: deletar este module concentra a complexidade ou apenas a move?\n\n` +
      `## Tarefa\n` +
      `1. Le o Map.\n` +
      `2. Reexplora areas relevantes do projeto via Read/Glob/Grep.\n` +
      `3. Aplica deletion test e produz lista numerada de 3-7 candidatos de aprofundamento.\n` +
      `4. Recomenda 1 candidato (maior payoff/risco) com justificativa de 2-3 frases.\n` +
      `5. Escreve MD + JSON na estrutura definida no seu systemPrompt. IDs no JSON DEVEM ser strings (ex: "C1", "C2").\n\n` +
      `## Restricoes\n` +
      `- NAO proponha interface final ainda.\n` +
      `- NAO invente candidatos sem evidencia em files reais.\n\n` +
      `## Mensagem do usuario\n${message}`;

    let triageOutput = '';
    const triageResult = await ctx.spawnAgent(ARCHITECTURE_TARGET_TRIAGE_ID, triagePrompt, {
      projectId,
      phaseNumber: 2,
      cwd: projectPath,
      abortController: state.abortController,
      onText: (chunk) => {
        triageOutput += chunk;
        emitPipelineStream({ projectId, phase: 2, type: 'text', content: chunk });
      },
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 2, type: 'tool_call', tool: toolName });
      },
    });

    if (triageOutput) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 2 }, 'assistant', triageOutput);
    }
    ctx.accumulateMetrics(state, 2, triageResult);
    sessionEntry.alive = true;

    if (fs.existsSync(archCtx.candidatesMdPath)) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: archCtx.candidatesMdPath,
        content: fs.readFileSync(archCtx.candidatesMdPath, 'utf-8'),
      });
    }

    emitIPC('pipeline:agent-completed', { projectId });
    emitPipelineStream({ projectId, phase: 2, type: 'done' });
  } else {
    const phase2Acc = { text: '', completed: false };
    const followupResult = await ctx.spawnAgent(ARCHITECTURE_TARGET_TRIAGE_ID, message, {
      projectId,
      phaseNumber: 2,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: true,
      priorMessages: ctx.buildPriorMessagesForPhase(projectId, 2),
      rebuildPromptOnRetry: () =>
        buildCodexResumePrompt({
          projectId,
          phaseNumber: 2,
          preamble:
            `Voce e o Architecture Target Triage do pipeline architecture-review.\n` +
            `INFORMACAO IMPORTANTE: NAO modifique codigo do projeto-alvo. ` +
            `Voce DEVE escrever EXCLUSIVAMENTE dentro de:\n  ${archCtx.runDir}\n\n` +
            `## Entrada\n` +
            `- Architecture Map: ${archCtx.mapMdPath}\n` +
            `- Project root: ${projectPath}\n\n` +
            `## Outputs\n` +
            `- Markdown: ${archCtx.candidatesMdPath}\n` +
            `- JSON:     ${archCtx.candidatesJsonPath}\n\n` +
            `Continue refinando a lista de candidatos com o usuario.`,
          userMessage: message,
        }),
      onText: ctx.makeConversationOnText(projectId, 2, phase2Acc),
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 2, type: 'tool_call', tool: toolName });
      },
    });

    ctx.accumulateMetrics(state, 2, followupResult);

    const cleanedText = phase2Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 2 }, 'assistant', cleanedText);
    }

    if (fs.existsSync(archCtx.candidatesMdPath)) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: archCtx.candidatesMdPath,
        content: fs.readFileSync(archCtx.candidatesMdPath, 'utf-8'),
      });
    }

    emitIPC('pipeline:agent-completed', { projectId });
    emitPipelineStream({ projectId, phase: 2, type: 'done' });
  }
}

export async function runArchitecturePhase3Diagnosis(
  ctx: PipelineEngineContext,
  projectId: string,
  project: ReturnType<typeof getHarnessProject> & object,
  state: HandlerPhaseState,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const archCtx = getArchitectureReviewContext(project);
  if (!archCtx) {
    throw new Error(
      'architecture-review run context not found — phase 1 must have generated runId before phase 3 starts',
    );
  }

  const selectedCandidateId = project.config.architectureReview?.selectedCandidateId;
  if (!selectedCandidateId) {
    throw new Error(
      'no selectedCandidateId in config.architectureReview — phase 2 must be approved with { selectedCandidateId } before phase 3 starts',
    );
  }
  if (!fs.existsSync(archCtx.mapMdPath) || !fs.existsSync(archCtx.candidatesMdPath)) {
    throw new Error(
      `Architecture Map or Candidates MD missing at ${archCtx.runDir} — phases 1 and 2 must complete first`,
    );
  }

  const prompt =
    `Voce e o Architecture Diagnostician do pipeline architecture-review.\n` +
    `INFORMACAO IMPORTANTE: NAO modifique codigo do projeto-alvo. ` +
    `Voce DEVE escrever EXCLUSIVAMENTE dentro de:\n` +
    `  ${archCtx.runDir}\n\n` +
    `## Candidato escolhido pelo usuario\n` +
    `selectedCandidateId: ${selectedCandidateId}\n\n` +
    `## Entradas\n` +
    `- Map:        ${archCtx.mapMdPath}\n` +
    `- Candidates: ${archCtx.candidatesMdPath}\n` +
    `- Project root: ${projectPath}\n\n` +
    `## Outputs obrigatorios (escreva ambos)\n` +
    `- Markdown: ${archCtx.diagnosisMdPath}\n` +
    `- JSON:     ${archCtx.diagnosisJsonPath}\n\n` +
    `## Tarefa\n` +
    `1. Leia Map e Candidates. Localize a entrada do candidato escolhido.\n` +
    `2. Reexplore arquivos citados do candidato (Read).\n` +
    `3. PROVE a friccao com evidencias concretas: arquivo:linhas + finding + impact.\n` +
    `4. Identifique a causa raiz arquitetural em 1-3 frases.\n` +
    `5. Liste seams atuais e seams ausentes.\n` +
    `6. Classifique dependencias (in-process / local-substitutable / remote-owned / external).\n` +
    `7. Indique impacto em testabilidade/manutencao/performance e riscos do nao-fazer.\n` +
    `8. Escreva MD + JSON na estrutura definida no seu systemPrompt. ` +
    `O campo \`candidateId\` no JSON DEVE ser exatamente "${selectedCandidateId}".\n\n` +
    `## Restricoes\n` +
    `- NAO invente evidencias. Cada evidencia deve citar path:lines real.\n` +
    `- Esta fase NAO corrige bugs — apenas diagnostica friccao arquitetural.`;

  let phase3Output = '';
  const result = await ctx.spawnAgent(ARCHITECTURE_DIAGNOSTICIAN_ID, prompt, {
    projectId,
    phaseNumber: 3,
    cwd: projectPath,
    abortController: state.abortController,
    onText: (chunk) => {
      phase3Output += chunk;
      emitPipelineStream({ projectId, phase: 3, type: 'text', content: chunk });
    },
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 3, type: 'tool_call', tool: toolName });
    },
  });

  if (phase3Output) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 3 }, 'assistant', phase3Output);
  }

  ctx.collectMetrics(projectId, 3, ARCHITECTURE_DIAGNOSTICIAN_ID, result, 'completed', {
    pipelineType: 'architecture-review',
  });

  if (!fs.existsSync(archCtx.diagnosisMdPath) || !fs.existsSync(archCtx.diagnosisJsonPath)) {
    throw new Error(
      `architecture-diagnostician did not produce required artefacts. ` +
        `Expected both:\n  - ${archCtx.diagnosisMdPath}\n  - ${archCtx.diagnosisJsonPath}\n` +
        `Reset phase 3 and try again.`,
    );
  }
  try {
    JSON.parse(fs.readFileSync(archCtx.diagnosisJsonPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `architecture-diagnostician produced invalid JSON at ${archCtx.diagnosisJsonPath}: ${(err as Error).message}`,
    );
  }

  emitIPC('pipeline:document-updated', {
    projectId,
    path: archCtx.diagnosisMdPath,
    content: fs.readFileSync(archCtx.diagnosisMdPath, 'utf-8'),
  });

  patchArchitectureReviewManifest(project, {});

  emitPipelineStream({ projectId, phase: 3, type: 'done' });
  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 3,
    phaseName: ARCHITECTURE_PHASE_NAMES[3],
    status: 'completed',
    awaitingUser: false,
  });

  logger.info({ projectId, runId: archCtx.runId, selectedCandidateId }, 'Architecture Phase 3 (Diagnosis) completed');

  await ctx.advanceToNextPhase(projectId, state);
}

export async function handleArchitecturePhase4DecisionMessage(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  project: ReturnType<typeof getHarnessProject> & object,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const sessionKey = 'architecture-phase4';
  let sessionEntry = state.continueSessions.get(sessionKey);

  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  const archCtx = getArchitectureReviewContext(project);
  if (!archCtx) {
    throw new Error('architecture-review run context not found — phases 1-3 must complete first');
  }

  const selectedCandidateId = project.config.architectureReview?.selectedCandidateId;
  if (!selectedCandidateId) {
    throw new Error('no selectedCandidateId in config — phase 2 approval missing');
  }

  if (!sessionEntry.alive) {
    if (!fs.existsSync(archCtx.decisionsMdPath)) {
      const header =
        `# Architecture Decisions: ${path.basename(projectPath)}/${archCtx.runId}\n\n` +
        `## Context\n` +
        `- **Selected candidate:** ${selectedCandidateId}\n` +
        `- **Source files:**\n` +
        `  - ${archCtx.mapMdPath}\n` +
        `  - ${archCtx.candidatesMdPath}\n` +
        `  - ${archCtx.diagnosisMdPath}\n\n` +
        `---\n\n`;
      fs.writeFileSync(archCtx.decisionsMdPath, header, 'utf-8');
      logger.info(
        { projectId, decisionsMdPath: archCtx.decisionsMdPath },
        'Architecture Phase 4: created decisions.md header',
      );
    }

    const decisionsContent = fs.readFileSync(archCtx.decisionsMdPath, 'utf-8');
    const decisionMatches = decisionsContent.match(/^##\s*D(\d+)/gm) ?? [];
    const nextDecisionN = decisionMatches.length + 1;

    const interviewPrompt =
      `Voce e o Architecture Decision Interviewer do pipeline architecture-review.\n` +
      `INFORMACAO IMPORTANTE: NAO modifique codigo do projeto-alvo. ` +
      `Escreva EXCLUSIVAMENTE em ${archCtx.decisionsMdPath} via Edit (append-only).\n\n` +
      `## Contexto da entrevista\n` +
      `- selectedCandidateId: ${selectedCandidateId}\n` +
      `- Map:        ${archCtx.mapMdPath}\n` +
      `- Candidates: ${archCtx.candidatesMdPath}\n` +
      `- Diagnosis:  ${archCtx.diagnosisMdPath}\n` +
      `- Decisions:  ${archCtx.decisionsMdPath}  (fonte de verdade — releia a CADA turno)\n\n` +
      `## Estado do arquivo de decisoes\n` +
      `- Cabecalho: JA CRIADO pelo engine. NAO escreva cabecalho novamente.\n` +
      `- Decisoes ja apendadas: ${decisionMatches.length}\n` +
      `- Proxima decisao DEVE ser: D${nextDecisionN}\n\n` +
      `## Regra de continuidade\n` +
      `Antes de fazer qualquer pergunta, LEIA o arquivo de decisions atual via Read. ` +
      `Decisoes nao persistidas ali nao existem para a SPEC.\n\n` +
      `## Tarefa neste turno\n` +
      `1. Leia o decisions.md (Read).\n` +
      `2. Leia Map+Candidates+Diagnosis se ainda nao houver ## DN no decisions.\n` +
      `3. Faca UMA pergunta arquitetural ao usuario sobre o candidato, com SUA recomendacao.\n` +
      `4. Quando o usuario fechar uma decisao, APENDE \`## D${nextDecisionN} — <titulo>\` no decisions.md ` +
      `via Edit (formato: Pergunta / Opcoes consideradas / Decisao / Razao / Implica / Timestamp). ` +
      `Sequencial. NUNCA renumere ou duplique decisoes anteriores.\n\n` +
      `## Quando sugerir fechar\n` +
      `Se ja ha 3+ decisoes apendadas e a ultima resposta nao gerou nova pergunta substantiva, ` +
      `SUGIRA (sem forcar): "Acho que cobrimos os pontos principais. Quer fechar e gerar a SPEC?". ` +
      `O fechamento de fase eh por botao na UI — voce so sugere.\n\n` +
      `## Mensagem do usuario\n${message}`;

    const phase4Acc = { text: '', completed: false };
    const interviewResult = await ctx.spawnAgent(ARCHITECTURE_DECISION_INTERVIEWER_ID, interviewPrompt, {
      projectId,
      phaseNumber: 4,
      cwd: projectPath,
      abortController: state.abortController,
      onText: ctx.makeConversationOnText(projectId, 4, phase4Acc),
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 4, type: 'tool_call', tool: toolName });
      },
    });

    const cleanedText = phase4Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 4 }, 'assistant', cleanedText);
    }
    ctx.accumulateMetrics(state, 4, interviewResult);
    sessionEntry.alive = true;

    if (fs.existsSync(archCtx.decisionsMdPath)) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: archCtx.decisionsMdPath,
        content: fs.readFileSync(archCtx.decisionsMdPath, 'utf-8'),
      });
    }

    emitIPC('pipeline:agent-completed', { projectId });
    emitPipelineStream({ projectId, phase: 4, type: 'done' });
  } else {
    const phase4Acc = { text: '', completed: false };
    const followupResult = await ctx.spawnAgent(ARCHITECTURE_DECISION_INTERVIEWER_ID, message, {
      projectId,
      phaseNumber: 4,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: true,
      priorMessages: ctx.buildPriorMessagesForPhase(projectId, 4),
      rebuildPromptOnRetry: () =>
        buildCodexResumePrompt({
          projectId,
          phaseNumber: 4,
          preamble:
            `Voce e o Architecture Decision Interviewer do pipeline architecture-review.\n` +
            `INFORMACAO IMPORTANTE: NAO modifique codigo do projeto-alvo. ` +
            `Escreva EXCLUSIVAMENTE em ${archCtx.decisionsMdPath} via Edit (append-only).\n\n` +
            `## Contexto da entrevista\n` +
            `- selectedCandidateId: ${selectedCandidateId}\n` +
            `- Map:        ${archCtx.mapMdPath}\n` +
            `- Candidates: ${archCtx.candidatesMdPath}\n` +
            `- Diagnosis:  ${archCtx.diagnosisMdPath}\n` +
            `- Decisions:  ${archCtx.decisionsMdPath}  (fonte de verdade — releia a CADA turno)\n\n` +
            `## Regra de continuidade\n` +
            `Antes de qualquer pergunta, LEIA o decisions.md via Read; a proxima decisao segue a numeracao sequencial ` +
            `dos \`## DN\` ja existentes. NUNCA renumere ou duplique decisoes anteriores.`,
          userMessage: message,
        }),
      onText: ctx.makeConversationOnText(projectId, 4, phase4Acc),
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 4, type: 'tool_call', tool: toolName });
      },
    });

    ctx.accumulateMetrics(state, 4, followupResult);

    const cleanedText = phase4Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 4 }, 'assistant', cleanedText);
    }

    if (fs.existsSync(archCtx.decisionsMdPath)) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: archCtx.decisionsMdPath,
        content: fs.readFileSync(archCtx.decisionsMdPath, 'utf-8'),
      });
    }

    emitIPC('pipeline:agent-completed', { projectId });
    emitPipelineStream({ projectId, phase: 4, type: 'done' });
  }
}

export async function runArchitecturePhase5Spec(
  ctx: PipelineEngineContext,
  projectId: string,
  project: ReturnType<typeof getHarnessProject> & object,
  state: HandlerPhaseState,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const archCtx = getArchitectureReviewContext(project);
  if (!archCtx) {
    throw new Error('architecture-review run context not found — phases 1-4 must complete first');
  }

  for (const [label, p] of [
    ['Map', archCtx.mapMdPath],
    ['Candidates', archCtx.candidatesMdPath],
    ['Diagnosis', archCtx.diagnosisMdPath],
    ['Decisions', archCtx.decisionsMdPath],
  ] as const) {
    if (!fs.existsSync(p)) {
      throw new Error(`Architecture ${label} MD missing at ${p} — phases 1-4 must complete first`);
    }
  }

  const validationReportPath = path.join(archCtx.runDir, `spec-validation-${archCtx.runId}.md`);

  const phaseName = ARCHITECTURE_PHASE_NAMES[5] ?? 'Spec Generation';
  const MAX_ROUNDS = 3;
  let passed = false;

  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (state.abortController.signal.aborted) break;

      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: 5,
        phaseName,
        status: 'spec-builder-running',
        awaitingUser: false,
        metadata: { round, maxRounds: MAX_ROUNDS },
      });

      let builderPrompt: string;
      if (round === 1) {
        builderPrompt =
          `Gere o SPEC implementavel para o pipeline architecture-review.\n\n` +
          `INFORMACAO IMPORTANTE: Este projeto e um architecture review pipeline.\n` +
          `O INPUT para voce NAO e um PRD. Suas fontes sao quatro artefatos arquiteturais:\n\n` +
          `- Map:        ${archCtx.mapMdPath}\n` +
          `- Candidates: ${archCtx.candidatesMdPath}\n` +
          `- Diagnosis:  ${archCtx.diagnosisMdPath}\n` +
          `- Decisions:  ${archCtx.decisionsMdPath}  (FONTE PRIMARIA — nao invente decisoes ausentes)\n\n` +
          `## Regras\n` +
          `- Use Decisions como fonte primaria. Nao invente decisoes ausentes.\n` +
          `- Use Diagnosis como fonte de evidencias.\n` +
          `- Reexplore a codebase em ${projectPath} para confirmar paths e assinaturas atuais.\n` +
          `- Se houver drift relevante, registre no topo da SPEC.\n` +
          `- Se algo nao foi decidido, registre em "Open Questions" (NAO chute).\n` +
          `- Inclua TODAS as secoes: Goal, Context, Decisions (tabela), Module Map, ` +
          `Interface Changes, File-Level Changes (executavel), Migration Strategy, ` +
          `Tests, Rollback, **Riscos**, Acceptance Criteria, Open Questions.\n\n` +
          `## Output\n` +
          `Salve o SPEC em: ${archCtx.specPath}`;
      } else {
        const validationContent = fs.existsSync(validationReportPath)
          ? fs.readFileSync(validationReportPath, 'utf-8')
          : '';
        builderPrompt =
          `Corrija o SPEC com base no relatorio de validacao abaixo.\n\n` +
          `Salve o resultado corrigido em: ${archCtx.specPath}\n\n` +
          `SPEC atual: ${archCtx.specPath}\n` +
          `Fontes arquiteturais (consulte se precisar):\n` +
          `- Map:        ${archCtx.mapMdPath}\n` +
          `- Candidates: ${archCtx.candidatesMdPath}\n` +
          `- Diagnosis:  ${archCtx.diagnosisMdPath}\n` +
          `- Decisions:  ${archCtx.decisionsMdPath}\n\n` +
          `Validation Report:\n${validationContent}\n\n` +
          `Use Edit para mudancas cirurgicas, nao reescreva o doc inteiro.`;
      }

      let builderOutput = '';
      const builderResult = await ctx.spawnAgent(SPEC_BUILDER_ID, builderPrompt, {
        projectId,
        phaseNumber: 5,
        cwd: projectPath,
        abortController: state.abortController,
        onText: (chunk) => {
          builderOutput += chunk;
          emitPipelineStream({
            projectId,
            phase: 5,
            type: 'text',
            content: chunk,
            metadata: { agent: 'spec-builder', round },
          });
        },
        onToolUse: (toolName) => {
          emitPipelineStream({ projectId, phase: 5, type: 'tool_call', tool: toolName });
        },
      });

      if (builderOutput) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 5 }, 'assistant', builderOutput);
      }
      ctx.collectMetrics(projectId, 5, SPEC_BUILDER_ID, builderResult, 'completed', {
        pipelineType: 'architecture-review',
      });

      if (!fs.existsSync(archCtx.specPath)) {
        throw new Error(
          `spec-builder did not write SPEC at expected path ${archCtx.specPath} ` +
            `(round ${round}). Reset phase 5 and try again.`,
        );
      }

      emitIPC('pipeline:document-updated', {
        projectId,
        path: archCtx.specPath,
        content: fs.readFileSync(archCtx.specPath, 'utf-8'),
      });

      if (state.abortController.signal.aborted) break;

      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: 5,
        phaseName,
        status: 'spec-validator-running',
        awaitingUser: false,
        metadata: { round, maxRounds: MAX_ROUNDS },
      });

      const validatorPrompt =
        `Valide a SPEC contra os 4 artefatos arquiteturais.\n\n` +
        `INFORMACAO IMPORTANTE: O INPUT NAO e PRD/discovery. Sao 4 artefatos arquiteturais.\n\n` +
        `## Documentos\n` +
        `- SPEC:       ${archCtx.specPath}\n` +
        `- Map:        ${archCtx.mapMdPath}\n` +
        `- Candidates: ${archCtx.candidatesMdPath}\n` +
        `- Diagnosis:  ${archCtx.diagnosisMdPath}\n` +
        `- Decisions:  ${archCtx.decisionsMdPath}  (fonte primaria — toda decisao DEVE aparecer na SPEC)\n\n` +
        `## Validacoes obrigatorias\n` +
        `- Cada decisao do decisions.md aparece na SPEC.\n` +
        `- Nenhuma decisao foi inventada na SPEC.\n` +
        `- Cada File-Level Change referencia paths reais (use Read/Glob para verificar).\n` +
        `- Cada mudanca tem criterio de aceite verificavel.\n` +
        `- Estrategia de testes cruza a interface correta do module.\n` +
        `- **Riscos** e **Rollback** existem.\n` +
        `- Open Questions existem quando uma decisao nao foi fechada.\n\n` +
        `## Output\n` +
        `Salve o relatorio em: ${validationReportPath}\n` +
        `O relatorio DEVE comecar com \`# Validation Report\` e ter \`## Status: PASS\` ou \`## Status: FAIL\` ` +
        `na primeira secao apos o titulo. Use tags [MISS] e [CONFLICT] conforme seu systemPrompt.`;

      let validatorOutput = '';
      const validatorResult = await ctx.spawnAgent(SPEC_VALIDATOR_ID, validatorPrompt, {
        projectId,
        phaseNumber: 5,
        cwd: projectPath,
        abortController: state.abortController,
        onText: (chunk) => {
          validatorOutput += chunk;
          emitPipelineStream({
            projectId,
            phase: 5,
            type: 'text',
            content: chunk,
            metadata: { agent: 'spec-validator', round },
          });
        },
        onToolUse: (toolName) => {
          emitPipelineStream({ projectId, phase: 5, type: 'tool_call', tool: toolName });
        },
      });

      if (validatorOutput) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 5 }, 'assistant', validatorOutput);
      }
      ctx.collectMetrics(projectId, 5, SPEC_VALIDATOR_ID, validatorResult, 'completed', {
        pipelineType: 'architecture-review',
      });

      const validationReport = fs.existsSync(validationReportPath)
        ? fs.readFileSync(validationReportPath, 'utf-8')
        : '';
      if (validationReport.includes('## Status: PASS')) {
        passed = true;
        logger.info({ projectId, round }, 'Architecture Phase 5: Spec validation PASSED');
        break;
      }
      logger.info({ projectId, round }, 'Architecture Phase 5: Spec validation FAILED — continuing');
    }
  } catch (err) {
    rethrowPipelinePause(err);
    if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
      logger.info({ projectId }, 'Architecture Phase 5 aborted');
      return;
    }
    logger.error({ err, projectId }, 'Architecture Phase 5 error');
    throw err;
  }

  updateHarnessProject(projectId, { specPath: archCtx.specPath });

  patchArchitectureReviewManifest(project, {});

  emitPipelineStream({ projectId, phase: 5, type: 'done' });
  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 5,
    phaseName,
    status: 'completed',
    awaitingUser: false,
    metadata: { passed },
  });

  logger.info(
    { projectId, runId: archCtx.runId, specPath: archCtx.specPath, passed },
    `Architecture Phase 5 (Spec Generation) completed (validation: ${passed ? 'PASS' : 'FAIL after ' + MAX_ROUNDS + ' rounds'})`,
  );

  await ctx.advanceToNextPhase(projectId, state);
}

export async function handleArchitecturePhase6SpecValidationMessage(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  project: ReturnType<typeof getHarnessProject> & object,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const archCtx = getArchitectureReviewContext(project);
  if (!archCtx) {
    throw new Error('architecture-review context missing — phase 5 must complete first');
  }
  if (!fs.existsSync(archCtx.specPath)) {
    throw new Error(`SPEC not found at ${archCtx.specPath} — phase 5 must complete first`);
  }

  const sessionKey = 'architecture-phase6';
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  if (!sessionEntry.alive) {
    const validatorPrompt =
      `Voce e o Spec Validator deste pipeline architecture-review.\n` +
      `INFORMACAO IMPORTANTE: O INPUT NAO e um PRD/discovery — sao 4 artefatos arquiteturais ` +
      `que devem ser cruzados contra a SPEC gerada.\n\n` +
      `## Documentos\n` +
      `- SPEC:       ${archCtx.specPath}\n` +
      `- Map:        ${archCtx.mapMdPath}\n` +
      `- Candidates: ${archCtx.candidatesMdPath}\n` +
      `- Diagnosis:  ${archCtx.diagnosisMdPath}\n` +
      `- Decisions:  ${archCtx.decisionsMdPath}  (fonte primaria — toda decisao DEVE aparecer na SPEC)\n\n` +
      `## Validacoes obrigatorias\n` +
      `- Cada decisao do decisions.md aparece na SPEC.\n` +
      `- Nenhuma decisao foi inventada na SPEC (sem fonte em decisions/diagnosis).\n` +
      `- Cada File-Level Change referencia paths reais (use Read/Glob para verificar).\n` +
      `- Cada mudanca tem criterio de aceite verificavel.\n` +
      `- Estrategia de testes cruza a interface correta do module.\n` +
      `- Riscos e Rollback existem.\n` +
      `- Open Questions existem quando uma decisao nao foi fechada.\n\n` +
      `## Tarefa\n` +
      `Reporte tags [MISS] (algo do decisions/diagnosis nao apareceu na SPEC) e [CONFLICT] ` +
      `(SPEC contradiz decisions ou paths reais). Se TUDO ok, reporte PASS.\n` +
      `Apos primeira analise, fica disponivel para responder duvidas do usuario sobre a SPEC. ` +
      `O usuario aprova a fase via botao na UI.\n\n` +
      `## Mensagem do usuario\n${message}`;

    const phase6Acc = { text: '', completed: false };
    const previousSpecContent = fs.existsSync(archCtx.specPath) ? fs.readFileSync(archCtx.specPath, 'utf-8') : '';
    const result = await ctx.spawnAgent(ARCH_SPEC_VALIDATOR_ID, validatorPrompt, {
      projectId,
      phaseNumber: 6,
      cwd: projectPath,
      abortController: state.abortController,
      onText: ctx.makeConversationOnText(projectId, 6, phase6Acc),
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 6, type: 'tool_call', tool: toolName });
      },
    });

    const cleanedText = phase6Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 6 }, 'assistant', cleanedText);
    }
    ctx.accumulateMetrics(state, 6, result);
    sessionEntry.alive = true;

    if (fs.existsSync(archCtx.specPath)) {
      const currentSpecContent = fs.readFileSync(archCtx.specPath, 'utf-8');
      if (currentSpecContent !== previousSpecContent) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: archCtx.specPath,
          content: currentSpecContent,
        });
      }
    }
    emitIPC('pipeline:agent-completed', { projectId });
    emitPipelineStream({ projectId, phase: 6, type: 'done' });
  } else {
    const phase6Acc = { text: '', completed: false };
    const previousSpecContent = fs.existsSync(archCtx.specPath) ? fs.readFileSync(archCtx.specPath, 'utf-8') : '';
    const followupResult = await ctx.spawnAgent(ARCH_SPEC_VALIDATOR_ID, message, {
      projectId,
      phaseNumber: 6,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: true,
      priorMessages: ctx.buildPriorMessagesForPhase(projectId, 6),
      rebuildPromptOnRetry: () =>
        buildCodexResumePrompt({
          projectId,
          phaseNumber: 6,
          preamble:
            `Voce e o Spec Validator deste pipeline architecture-review.\n\n` +
            `## Documentos\n` +
            `- SPEC:       ${archCtx.specPath}\n` +
            `- Map:        ${archCtx.mapMdPath}\n` +
            `- Candidates: ${archCtx.candidatesMdPath}\n` +
            `- Diagnosis:  ${archCtx.diagnosisMdPath}\n` +
            `- Decisions:  ${archCtx.decisionsMdPath}\n\n` +
            `Continue respondendo duvidas do usuario sobre a SPEC (tags [MISS]/[CONFLICT]/PASS). ` +
            `O usuario aprova a fase via botao na UI.`,
          userMessage: message,
        }),
      onText: ctx.makeConversationOnText(projectId, 6, phase6Acc),
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 6, type: 'tool_call', tool: toolName });
      },
    });

    ctx.accumulateMetrics(state, 6, followupResult);

    const cleanedText = phase6Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 6 }, 'assistant', cleanedText);
    }

    if (fs.existsSync(archCtx.specPath)) {
      const currentSpecContent = fs.readFileSync(archCtx.specPath, 'utf-8');
      if (currentSpecContent !== previousSpecContent) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: archCtx.specPath,
          content: currentSpecContent,
        });
      }
    }
    emitIPC('pipeline:agent-completed', { projectId });
    emitPipelineStream({ projectId, phase: 6, type: 'done' });
  }
}

export async function handleArchitecturePhase7SpecEnricherMessage(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  project: ReturnType<typeof getHarnessProject> & object,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const archCtx = getArchitectureReviewContext(project);
  if (!archCtx) {
    throw new Error('architecture-review context missing — phase 5 must complete first');
  }
  if (!fs.existsSync(archCtx.specPath)) {
    throw new Error(`SPEC not found at ${archCtx.specPath} — phase 5 must complete first`);
  }

  const sessionKey = 'architecture-phase7';
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  if (!sessionEntry.alive) {
    const enricherPrompt =
      `Voce e o Architecture Spec Enricher deste pipeline architecture-review.\n` +
      `INFORMACAO IMPORTANTE: A SPEC ja foi validada na fase anterior. ` +
      `Sua tarefa e enriquecer a SPEC com gaps tecnicos de arquitetura, contratos, ` +
      `edge cases de runtime, estados de erro, permissoes, rollback, testes e criterios de aceite — ` +
      `usando os 4 artefatos arquiteturais como contexto extra.\n` +
      `NAO procure PRD.md, stories-requisitos.md, discovery-notes.md ou design-contract.json.\n\n` +
      `## Documentos\n` +
      `- SPEC (alvo de edicao): ${archCtx.specPath}\n` +
      `- Map:        ${archCtx.mapMdPath}\n` +
      `- Candidates: ${archCtx.candidatesMdPath}\n` +
      `- Diagnosis:  ${archCtx.diagnosisMdPath}\n` +
      `- Decisions:  ${archCtx.decisionsMdPath}\n\n` +
      `## Tarefa\n` +
      `1. Releia a SPEC + Decisions.\n` +
      `2. Identifique gaps: contratos de interface, cenarios extremos, estados de erro, ` +
      `concorrencia/streaming/cache, permissoes implicitas, migracao, rollback e testes.\n` +
      `3. Edite a SPEC via Edit (NAO reescreva — adicione secoes/itens).\n` +
      `4. Apresente o que adicionou e fica disponivel para conversa multi-turn.\n` +
      `5. NUNCA contradiga decisoes ja fechadas. Em caso de conflito, registre em Open Questions.\n\n` +
      `## Mensagem do usuario\n${message}`;

    const phase7Acc = { text: '', completed: false };
    const result = await ctx.spawnAgent(ARCHITECTURE_SPEC_ENRICHER_ID, enricherPrompt, {
      projectId,
      phaseNumber: 7,
      cwd: projectPath,
      abortController: state.abortController,
      onText: ctx.makeConversationOnText(projectId, 7, phase7Acc),
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 7, type: 'tool_call', tool: toolName });
      },
    });

    const cleanedText = phase7Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 7 }, 'assistant', cleanedText);
    }
    ctx.accumulateMetrics(state, 7, result);
    sessionEntry.alive = true;

    if (fs.existsSync(archCtx.specPath)) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: archCtx.specPath,
        content: fs.readFileSync(archCtx.specPath, 'utf-8'),
      });
    }
    emitIPC('pipeline:agent-completed', { projectId });
    emitPipelineStream({ projectId, phase: 7, type: 'done' });
  } else {
    const phase7Acc = { text: '', completed: false };
    const followupResult = await ctx.spawnAgent(ARCHITECTURE_SPEC_ENRICHER_ID, message, {
      projectId,
      phaseNumber: 7,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: true,
      priorMessages: ctx.buildPriorMessagesForPhase(projectId, 7),
      rebuildPromptOnRetry: () =>
        buildCodexResumePrompt({
          projectId,
          phaseNumber: 7,
          preamble:
            `Voce e o Architecture Spec Enricher deste pipeline architecture-review.\n\n` +
            `## Documentos\n` +
            `- SPEC (alvo de edicao): ${archCtx.specPath}\n` +
            `- Map:        ${archCtx.mapMdPath}\n` +
            `- Candidates: ${archCtx.candidatesMdPath}\n` +
            `- Diagnosis:  ${archCtx.diagnosisMdPath}\n` +
            `- Decisions:  ${archCtx.decisionsMdPath}\n\n` +
            `Continue enriquecendo a SPEC via Edit (NAO reescreva — adicione secoes/itens). ` +
            `NUNCA contradiga decisoes ja fechadas; conflitos vao para Open Questions.`,
          userMessage: message,
        }),
      onText: ctx.makeConversationOnText(projectId, 7, phase7Acc),
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 7, type: 'tool_call', tool: toolName });
      },
    });

    ctx.accumulateMetrics(state, 7, followupResult);

    const cleanedText = phase7Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 7 }, 'assistant', cleanedText);
    }

    if (fs.existsSync(archCtx.specPath)) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: archCtx.specPath,
        content: fs.readFileSync(archCtx.specPath, 'utf-8'),
      });
    }
    emitIPC('pipeline:agent-completed', { projectId });
    emitPipelineStream({ projectId, phase: 7, type: 'done' });
  }
}
