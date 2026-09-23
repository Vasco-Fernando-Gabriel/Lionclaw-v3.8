import { BrowserWindow } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from '../logger';
import { emitIPC } from '../pipeline-shared/ipc-emitter';
import { emitPipelineSprintsLoaded, emitPipelineStream, makeConversationOnText } from './stream';
import {
  createEmptyMetrics as createEmptyMetricsFn,
  mergeMetrics as mergeMetricsFn,
  accumulateMetrics as accumulateMetricsFn,
  flushAccumulatedMetrics as flushAccumulatedMetricsFn,
  collectMetrics as collectMetricsFn,
  type AccumulatedMetrics,
} from './metrics';
import {
  closeCodexSessions as closeCodexSessionsModule,
  hasCodexSessionForPhase as hasCodexSessionForPhaseModule,
  maybeKillIdleCodexOnGate as maybeKillIdleCodexOnGateModule,
  isTransientCodexSessionError,
} from './codex-sessions';
import { setProjectStatus } from '../pipeline-shared/status';
import { persistMessage } from '../pipeline-shared/persist';
import { ensureProjectLock } from '../pipeline-shared/lock';
import { PipelinePausedError } from '../agent-runtime/types';
import type { OllamaChatMessage, OllamaToolCallRecord } from '../ollama-client';
import { executeAgent } from '../agent-runtime';
import type { AgentExecutionRequest } from '../agent-runtime/types';
import { createSubagentDispatchContext, pendingSubagentProviderAuthError } from '../agent-runtime/subagent-dispatch';
import { PERM_BYPASS_NO_GUARD } from '../agent-runtime/permission-profiles';
import { CodexAuthError, CodexUnavailableError } from '../codex-runtime/errors';
import { GrokAuthError } from '../agent-runtime/grok-availability';
import { KimiAuthError } from '../agent-runtime/kimi-availability';
import type { CodexSession } from '../codex-runtime/types';
import {
  getHarnessProject,
  getAgent,
  updateHarnessProjectPipelineColumns,
  getPipelinePhaseMessagesAsChatHistory,
  savePipelinePhaseMetrics,
  getHarnessSprints,
  getPipelineMetrics,
  updateHarnessProject,
  updateHarnessSprint,
  getHarnessSprintByIndex,
  patchSecuritySummaryJson,
  getSecuritySummaryJson,
  PIPELINE_GREETING_AGENT_ID,
} from '../db';
import type { PipelineMetrics } from '../db';
import { reseedHarnessSprintsFromFile, checkHarnessSprintQueueIntegrity } from '../harness-planner';
import type { PipelineProject, PipelinePhaseNumber } from '../../../src/types/pipeline';
import type { AgentConfig } from '../../../src/types';
import { conversationPhasesOf } from '../../../src/types/pipeline';
import {
  getAutoPhases,
  getPhaseName,
  getPhaseAgentId,
  getPhaseNumberForAgent,
  PHASE_NAMES,
  PHASE_AGENT_IDS,
} from './registry';
import {
  getConversationGreeting as getConversationGreetingModule,
  getArchitectureReviewConversationGreeting,
} from './greetings';
import { getDevV2Briefing } from './dev-v2-briefings';
import { buildDesignLockPathsBlock as buildDesignLockPathsBlockHelper } from './dev-v2-lock-paths';
import { dispatchConversationMessage, isPureConversationPhase, type MessageRouterEngine } from './message-router';
import {
  resetPhase as resetPhaseModule,
  resetSprint as resetSprintModule,
  getResetPreview as getResetPreviewModule,
  type ResetEngineContext,
  type ResetPreview,
} from './reset';
import {
  completePipeline as completePipelineModule,
  failPhase as failPhaseModule,
  advanceToNextPhase as advanceToNextPhaseModule,
  advancePhase as advancePhaseModule,
  abortPipeline as abortPipelineModule,
  pausePipeline as pausePipelineModule,
  resumePipeline as resumePipelineModule,
  recoverInterruptedPipelines as recoverInterruptedPipelinesModule,
  type LifecycleEngineContext,
  type CompletePipelineOptions,
  type FailPhaseOptions,
} from './lifecycle';
import type { PipelineEngineContext, PriorMessages } from './handlers/context';
import {
  runArchitecturePhase1Map as runArchitecturePhase1MapModule,
  handleArchitecturePhase2TriageMessage as handleArchitecturePhase2TriageMessageModule,
  runArchitecturePhase3Diagnosis as runArchitecturePhase3DiagnosisModule,
  handleArchitecturePhase4DecisionMessage as handleArchitecturePhase4DecisionMessageModule,
  runArchitecturePhase5Spec as runArchitecturePhase5SpecModule,
  handleArchitecturePhase6SpecValidationMessage as handleArchitecturePhase6SpecValidationMessageModule,
  handleArchitecturePhase7SpecEnricherMessage as handleArchitecturePhase7SpecEnricherMessageModule,
} from './handlers/architecture-review';
import {
  runSecurityPhase1 as runSecurityPhase1Module,
  runSecurityPhase2 as runSecurityPhase2Module,
  runSecurityPhase3 as runSecurityPhase3Module,
  runSecurityPhase6 as runSecurityPhase6Module,
  handleSecurityPhase4Message as handleSecurityPhase4MessageModule,
  handleSecurityPhase5Message as handleSecurityPhase5MessageModule,
  handleSecurityPhase6SpecReviewMessage as handleSecurityPhase6SpecReviewMessageModule,
  handleSecurityPhase7Message as handleSecurityPhase7MessageModule,
  handleSecurityPhase9Message as handleSecurityPhase9MessageModule,
  runResolutionTracker as runResolutionTrackerModule,
} from './handlers/security';
import {
  runPhase2 as runPhase2Module,
  runPhase4 as runPhase4Module,
  runPhase9 as runPhase9Module,
  runPhase11 as runPhase11Module,
  handlePhase1Message as handlePhase1MessageModule,
  handlePhase3Message as handlePhase3MessageModule,
  handleTechPhaseMessage as handleTechPhaseMessageModule,
  handlePhase10Message as handlePhase10MessageModule,
  handlePhase12Message as handlePhase12MessageModule,
  handlePhase9Message as handlePhase9MessageModule,
  runPhase2Feature as runPhase2FeatureModule,
  runPhase4Feature as runPhase4FeatureModule,
} from './handlers/dev-feature';
import {
  runPhase2WithBriefing as runPhase2WithBriefingModule,
  runDevV2Phase4DesignPlan as runDevV2Phase4DesignPlanModule,
  runDevV2Phase6DesignLock as runDevV2Phase6DesignLockModule,
  runDevV2Phase7PrdCompleto as runDevV2Phase7PrdCompletoModule,
  runDevV2Phase12SpecGeneration as runDevV2Phase12SpecGenerationModule,
  runDevV2Phase14Planner as runDevV2Phase14PlannerModule,
  handleDevV2Phase12SpecReview as handleDevV2Phase12SpecReviewModule,
  handlePhase1MessageDevV2 as handlePhase1MessageDevV2Module,
  handlePhase3MessageDevV2 as handlePhase3MessageDevV2Module,
  handleDevV2Phase13SpecEnricher as handleDevV2Phase13SpecEnricherModule,
  finalizeDevV2ConversationPhase as finalizeDevV2ConversationPhaseModule,
} from './handlers/development-v2';
import {
  handleBugPhase1DiscoveryMessage as handleBugPhase1DiscoveryMessageModule,
  runBugPhase2ParallelAnalysis as runBugPhase2ParallelAnalysisModule,
  handleBugPhase3ConsolidationMessage as handleBugPhase3ConsolidationMessageModule,
  runBugPhase4Spec as runBugPhase4SpecModule,
  handleBugPhase5SpecValidatorMessage as handleBugPhase5SpecValidatorMessageModule,
  finalizeBugConversationPhase as finalizeBugConversationPhaseModule,
} from './handlers/bug';
import { HarnessEngine } from '../harness-engine';
import {
  PRD_GENERATOR_ID,
  SPEC_VALIDATOR_ID,
  SECURITY_SPEC_VALIDATOR_ID,
  TECH_DATABASE_ID,
  TECH_BACKEND_ID,
  TECH_FRONTEND_ID,
  TECH_SECURITY_ID,
  FEAT_TECH_DATABASE_ID,
  FEAT_TECH_BACKEND_ID,
  FEAT_TECH_FRONTEND_ID,
  FEAT_TECH_SECURITY_ID,
  PIPE2_TECH_FRONTEND_ID,
  BUG_SOLUTION_CONSOLIDATOR_ID,
} from '../seed-agents/index';
import { SecurityAuditRunner } from '../security-audit-runner';
import { BugAnalysisRunner } from '../bug-analysis-runner';
import { parseSecurityFindings } from '../security-findings-parser';
import {
  generatePipelineDocsId,
  getPipelineDocsContext,
  migrateLegacyDocsToFolder,
  migrateHarnessSprintsToPipelineDocs,
} from '../pipeline-paths';
import { getArchitectureReviewContext, patchArchitectureReviewManifest } from '../architecture-review-paths';
import { getBugContext, patchBugManifest } from '../bug-paths';

const logger = createLogger('pipeline-engine');

function resolveModelForAgent(agent: AgentConfig | undefined | null): string | null {
  if (!agent) return null;
  if (agent.runtime === 'codex' && agent.codexConfig?.model) return agent.codexConfig.model;
  if (agent.runtime === 'local' && agent.localConfig?.model) return agent.localConfig.model;
  if (agent.runtime === 'external' && agent.externalConfig?.model) return agent.externalConfig.model;
  return agent.model ?? null;
}

const ARCHITECTURE_PHASE4_MIN_DECISIONS = 3;

type DecisionField = 'pergunta' | 'decisao' | 'razao' | 'implica';

const DECISION_FIELD_LABEL: Record<DecisionField, string> = {
  pergunta: 'Pergunta',
  decisao: 'Decisao',
  razao: 'Razao',
  implica: 'Implica',
};

const DECISION_FIELD_PATTERNS: Record<DecisionField, RegExp> = {
  pergunta: /^[\s>*-]*\**\s*(?:Pergunta|Questa(?:o|ão)|Question|Quest(?:a|ã)o)\s*:\s*\**\s*\S/im,
  decisao: /^[\s>*-]*\**\s*(?:Decis(?:a|ã)o|Decision|Escolha|Choice)\s*:\s*\**\s*\S/im,
  razao: /^[\s>*-]*\**\s*(?:Raz(?:a|ã)o|Motivo|Justificativa|Reason|Rationale)\s*:\s*\**\s*\S/im,
  implica: /^[\s>*-]*\**\s*(?:Implica(?:c(?:a|ã)o|tion)?s?|Implies|Consequencia|Consequência)s?\s*:\s*\**\s*\S/im,
};

interface DecisionGap {
  decisionN: number;
  title: string;
  missing: DecisionField[];
}

interface DecisionValidation {
  count: number;
  gaps: DecisionGap[];
}

export function validateDecisionsMd(md: string): DecisionValidation {
  const headerRe = /^##\s*D(\d+)\s*[—\-:]?\s*(.+?)$/gm;
  const matches = Array.from(md.matchAll(headerRe));
  const gaps: DecisionGap[] = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const n = parseInt(m[1]!, 10);
    const title = (m[2] ?? '').trim();
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? md.length) : md.length;
    const body = md.slice(start, end);

    const missing: DecisionField[] = [];
    (Object.keys(DECISION_FIELD_PATTERNS) as DecisionField[]).forEach((field) => {
      if (!DECISION_FIELD_PATTERNS[field].test(body)) missing.push(field);
    });
    if (missing.length > 0) gaps.push({ decisionN: n, title, missing });
  }

  return { count: matches.length, gaps };
}

export function canDestructiveUnlock(project: {
  pipelineType?: string;
  config?: { openDesign?: { locked?: boolean } };
}): boolean {
  return project.pipelineType === 'development-v2' && project.config?.openDesign?.locked === true;
}

export { getArchitectureReviewConversationGreeting };

export { getPhaseAgentId, getPhaseNumberForAgent };

const DISCOVERY_NOTES_TEMPLATE = `# Discovery Notes

## Visao

### Problema
<!-- Qual problema esse produto resolve? -->

### Usuario principal
<!-- Quem eh o usuario principal? -->

### Referencia
<!-- Tem algum produto parecido como referencia? -->

### Pitch
<!-- Pitch do produto validado pelo usuario (2-3 frases) -->

## Funcionalidades

### Core features
<!-- As 3 funcionalidades principais -->

### Integracoes
<!-- Integracoes com sistemas externos -->

## Monetizacao

### Modelo
<!-- Como pretende monetizar? -->

### Planos
<!-- Quantos planos e o que diferencia cada um (se aplicavel) -->

## Tecnico

### Stack
<!-- Preferencias de tecnologia -->

### Plataforma
<!-- Mobile? Web? -->

### Database
<!-- Preferencias de banco de dados -->

### Backend
<!-- Preferencias de backend -->

### Frontend
<!-- Preferencias de frontend -->

### Security
<!-- Requisitos de seguranca -->

## Contexto

### Referencias visuais
<!-- Wireframes, links de Figma, referencias visuais -->

### Notas adicionais
<!-- Qualquer outra informacao relevante -->
`;

interface ContinueSessionState {
  alive: boolean;
}

interface PhaseState {
  projectId: string;
  currentPhase: number;
  status: 'idle' | 'running' | 'paused' | 'aborted';
  abortController: AbortController;
  discoveryBlock: number;
  continueSessions: Map<string, ContinueSessionState>;
  codexSessions: Map<string, CodexSession>;
  phaseMetricAccum: Map<number, AccumulatedMetrics>;
  currentSprintIndex: number;
  conversationAuthResume?: {
    phase: number;
    provider: 'codex' | 'grok' | 'kimi';
    message: string;
    finalMessage: string;
    isGreeting: boolean;
  };
}

interface SpawnAgentResult {
  output: string;
  metrics: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    toolUses: number;
    apiRequests: number;
    costUsd: number;
    durationMs: number;
    costStatus?: 'known' | 'unknown' | 'estimated-partial';
    tokenStatus?: 'reported' | 'not_reported';
    costUnknownReason?: 'unknown-pricing' | 'no-usage-reported';
  };
  model: string;
  runtime: AgentConfig['runtime'];
  provider: string;
  toolCalls?: OllamaToolCallRecord[];
  metadata?: {
    codex?: {
      applyPatchFailures?: number;
      applyPatchFailureSamples?: Array<{ source: string; text: string; ts: number }>;
    };
    costEstimationKind?: 'subscription-equivalent-payg';
  };
}

interface SpawnAgentOptions {
  projectId: string;
  phaseNumber: number;
  cwd: string;
  abortController: AbortController;
  onText?: (chunk: string) => void;
  onToolUse?: (toolName: string) => void;
  onToolUseComplete?: (toolName: string, input: unknown) => void;
  continueSession?: boolean;
  priorMessages?: OllamaChatMessage[];
  docsDir?: string;
  skipProjectRootInjection?: boolean;
  rebuildPromptOnRetry?: () => string;
}

export class PipelineEngine {
  private states: Map<string, PhaseState> = new Map();

  private harnessEngine: HarnessEngine;

  constructor(_getWindow: () => BrowserWindow | null, harnessEngine: HarnessEngine) {
    this.harnessEngine = harnessEngine;
    this.recoverInterruptedPipelines();
  }

  private updateProjectColumns(
    projectId: string,
    columns: {
      pipelineCurrentPhase?: number | null;
      pipelineStartPhase?: number | null;
      discoveryNotesPath?: string | null;
      prdPath?: string | null;
      status?: PipelineProject['status'];
      pipelineSprintIndex?: number;
      pipelineDiscoveryBlock?: number;
    },
  ): void {
    updateHarnessProjectPipelineColumns(projectId, columns);

    const patch: {
      status?: PipelineProject['status'];
      currentPhase?: PipelinePhaseNumber | null;
    } = {};
    if (columns.status !== undefined) {
      patch.status = columns.status;
    }
    if (columns.pipelineCurrentPhase !== undefined) {
      patch.currentPhase = columns.pipelineCurrentPhase as PipelinePhaseNumber | null;
    }
    if (Object.keys(patch).length > 0) {
      emitIPC('pipeline:project-updated', { projectId, patch });
    }
  }

  private readonly PHASE_COMPLETE_MARKER = '[PHASE_COMPLETE]';

  private withProjectRoot(projectPath: string, taskPrompt: string, docsDir?: string): string {
    return (
      `## PROJECT ROOT (raiz absoluta do projeto onde voce deve operar)\n` +
      `${projectPath}\n\n` +
      (docsDir ? `## DOCS DIR (onde voce DEVE gravar todos os documentos desta execucao)\n${docsDir}\n\n` : '') +
      `## REGRAS CRITICAS DE FILESYSTEM\n` +
      `- TODOS os paths em Read, Write, Edit, Glob e Grep DEVEM ser absolutos comecando com PROJECT ROOT acima.\n` +
      (docsDir ? `- TODA gravacao de documento (PRD, SPEC, stories, etc) DEVE ir para DOCS DIR acima.\n` : '') +
      `- NUNCA leia, escreva ou liste arquivos fora dessa raiz. Tentativas serao rejeitadas com erro.\n` +
      `- Se o prompt referenciar um caminho relativo, prefixe com PROJECT ROOT.\n\n` +
      `## TAREFA\n` +
      taskPrompt
    );
  }

  private makeConversationOnText(
    projectId: string,
    phase: number,
    accumulatedRef: { text: string; completed: boolean },
  ): (chunk: string) => void {
    return makeConversationOnText({
      projectId,
      phase,
      accumulatedRef,
      phaseCompleteMarker: this.PHASE_COMPLETE_MARKER,
      onPhaseComplete: () => {
        emitIPC('pipeline:agent-completed', { projectId });
        logger.info({ projectId, phase }, 'Agent signaled PHASE_COMPLETE');
      },
    });
  }

  private getState(projectId: string): PhaseState {
    if (!this.states.has(projectId)) {
      let persistedPhase = 0;
      let persistedStatus: PhaseState['status'] = 'idle';
      let persistedSprintIndex = 0;
      try {
        const project = getHarnessProject(projectId);
        if (project) {
          persistedPhase = project.pipelineCurrentPhase ?? 0;
          if (project.status === 'paused' || project.status === 'running') {
            persistedStatus = 'paused';
          } else {
            persistedStatus = 'idle';
          }
          persistedSprintIndex = project.pipelineSprintIndex ?? 0;
        }
      } catch (err) {
        logger.warn({ err, projectId }, 'getState: failed to rehydrate from DB, using defaults');
      }

      this.states.set(projectId, {
        projectId,
        currentPhase: persistedPhase,
        status: persistedStatus,
        abortController: new AbortController(),
        discoveryBlock: 1,
        continueSessions: new Map(),
        codexSessions: new Map(),
        phaseMetricAccum: new Map(),
        currentSprintIndex: persistedSprintIndex,
      });
    }
    return this.states.get(projectId)!;
  }

  private isConversationPhase(phase: number, project?: { pipelineType?: string }): boolean {
    return isPureConversationPhase(phase, project);
  }

  private resolveTechAgentIdForMessage(project: { pipelineType?: string } | undefined, phase: number): string {
    if (project?.pipelineType === 'development-v2') {
      switch (phase) {
        case 8:
          return TECH_DATABASE_ID;
        case 9:
          return TECH_BACKEND_ID;
        case 10:
          return PIPE2_TECH_FRONTEND_ID;
        case 11:
          return TECH_SECURITY_ID;
        default:
          return getPhaseAgentId(phase, project) ?? '';
      }
    }
    const isFeature = project?.pipelineType === 'feature';
    switch (phase) {
      case 5:
        return isFeature ? FEAT_TECH_DATABASE_ID : TECH_DATABASE_ID;
      case 6:
        return isFeature ? FEAT_TECH_BACKEND_ID : TECH_BACKEND_ID;
      case 7:
        return isFeature ? FEAT_TECH_FRONTEND_ID : TECH_FRONTEND_ID;
      case 8:
        return isFeature ? FEAT_TECH_SECURITY_ID : TECH_SECURITY_ID;
      default:
        return getPhaseAgentId(phase, project ?? {}) ?? '';
    }
  }

  private buildMessageRouterEngine(): MessageRouterEngine {
    return {
      handlePhase1Message: this.handlePhase1Message.bind(this),
      handlePhase3Message: this.handlePhase3Message.bind(this),
      handlePhase9Message: this.handlePhase9Message.bind(this),
      handlePhase10Message: this.handlePhase10Message.bind(this),
      handleTechPhaseMessage: this.handleTechPhaseMessage.bind(this),
      handlePhase12Message: this.handlePhase12Message.bind(this),
      handleSecurityPhase4Message: this.handleSecurityPhase4Message.bind(this),
      handleSecurityPhase5Message: this.handleSecurityPhase5Message.bind(this),
      handleSecurityPhase6SpecReviewMessage: this.handleSecurityPhase6SpecReviewMessage.bind(this),
      handleSecurityPhase7Message: this.handleSecurityPhase7Message.bind(this),
      handleSecurityPhase9Message: this.handleSecurityPhase9Message.bind(this),
      handleBugPhase1DiscoveryMessage: this.handleBugPhase1DiscoveryMessage.bind(this),
      handleBugPhase3ConsolidationMessage: this.handleBugPhase3ConsolidationMessage.bind(this),
      handleBugPhase5SpecValidatorMessage: this.handleBugPhase5SpecValidatorMessage.bind(this),
      handleArchitecturePhase2TriageMessage: this.handleArchitecturePhase2TriageMessage.bind(this),
      handleArchitecturePhase4DecisionMessage: this.handleArchitecturePhase4DecisionMessage.bind(this),
      handleArchitecturePhase6SpecValidationMessage: this.handleArchitecturePhase6SpecValidationMessage.bind(this),
      handleArchitecturePhase7SpecEnricherMessage: this.handleArchitecturePhase7SpecEnricherMessage.bind(this),
      handlePhase1MessageDevV2: this.handlePhase1MessageDevV2.bind(this),
      handlePhase3MessageDevV2: this.handlePhase3MessageDevV2.bind(this),
      handleDevV2Phase12SpecReview: this.handleDevV2Phase12SpecReview.bind(this),
      handleDevV2Phase13SpecEnricher: this.handleDevV2Phase13SpecEnricher.bind(this),
      buildDesignLockPathsBlock: this.buildDesignLockPathsBlock.bind(this),
    };
  }

  private recoverInterruptedPipelines(): void {
    recoverInterruptedPipelinesModule();
  }

  async startPipeline(projectId: string, startPhase: number): Promise<{ error: string } | void> {
    const existingState = this.states.get(projectId);
    if (existingState && existingState.status === 'running') {
      logger.warn({ projectId }, 'startPipeline: pipeline ja esta rodando para este projeto, ignorando');
      return { error: 'Pipeline ja esta rodando para este projeto' };
    }

    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    if ((project.pipelineType === 'feature' || project.pipelineType === 'security') && !project.pipelineDocsId) {
      const newId = generatePipelineDocsId();
      const result = migrateLegacyDocsToFolder(project.projectPath, newId);
      const ctx = getPipelineDocsContext(project.projectPath, newId);
      const updates: Record<string, unknown> = { pipelineDocsId: newId };
      if (ctx) {
        if (project.specPath && project.specPath.endsWith('/SPEC.md')) {
          updates['specPath'] = ctx.resolveDocPath('SPEC.md');
        }
        if (project.prdPath && project.prdPath.endsWith('/PRD.md')) {
          updates['prdPath'] = ctx.resolveDocPath('PRD.md');
        }
        if (project.sprintsJsonPath && project.sprintsJsonPath.endsWith('/sprints.json')) {
          const sprintsMigration = migrateHarnessSprintsToPipelineDocs(project, newId);
          updates['sprintsJsonPath'] = sprintsMigration.pathToPersist;
          logger.info(
            { projectId, newDocsId: newId, sprintsMigration },
            'Lazy migration for sprints JSON to docs/Docs<id>/ folder applied',
          );
        }
      }
      updateHarnessProject(projectId, updates as never);
      logger.info(
        { projectId, newDocsId: newId, migrated: result.migrated, errors: result.errors },
        'Lazy migration to docs/Docs<id>/ folder applied',
      );
    }

    logger.info({ projectId, startPhase }, 'Starting pipeline');

    const state = this.getState(projectId);
    state.abortController = new AbortController();
    state.currentPhase = startPhase;
    state.status = 'running';

    if (startPhase === 1) {
      const docsCtx = getPipelineDocsContext(project.projectPath, project.pipelineDocsId ?? null);
      const notesPath = docsCtx
        ? docsCtx.resolveDocPath('discovery.md')
        : path.join(project.projectPath, 'discovery-notes.md');
      if (!fs.existsSync(notesPath)) {
        fs.mkdirSync(docsCtx ? docsCtx.docsDir : project.projectPath, { recursive: true });
        fs.writeFileSync(notesPath, DISCOVERY_NOTES_TEMPLATE, 'utf-8');
        logger.info({ notesPath }, 'Created discovery-notes.md template');
      }
      this.updateProjectColumns(projectId, {
        discoveryNotesPath: notesPath,
      });
    }

    this.updateProjectColumns(projectId, {
      pipelineStartPhase: startPhase,
      pipelineCurrentPhase: startPhase,
      status: 'running',
    });

    const firstPhaseIsConversation = this.isConversationPhase(startPhase, project);
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: startPhase,
      phaseName: getPhaseName(startPhase, project) ?? `Phase ${startPhase}`,
      status: 'started',
      awaitingUser: firstPhaseIsConversation,
      currentModel: this.resolveCurrentModelForPhase(project, startPhase),
    });

    if (getAutoPhases(project).has(startPhase)) {
      await this.runAutoPhase(projectId, startPhase);
    } else if (firstPhaseIsConversation) {
      const greetingMsg = this.getConversationGreeting(startPhase, project.name, project);
      await this.sendMessage(projectId, greetingMsg, undefined, { isGreeting: true });
    }
    // Loop phases require explicit advancePhase call in normal flow
  }

  private getConversationGreeting(
    phase: number,
    projectName: string,
    project?: { pipelineType?: string; projectPath?: string; pipelineDocsId?: string | null },
  ): string {
    return getConversationGreetingModule(phase, projectName, project);
  }

  async advancePhase(projectId: string): Promise<void> {
    return advancePhaseModule(this.buildLifecycleEngineContext(), projectId);
  }

  abortPipeline(projectId: string): void {
    abortPipelineModule(this.buildLifecycleEngineContext(), projectId);
  }

  pausePipeline(projectId: string): void {
    pausePipelineModule(this.buildLifecycleEngineContext(), projectId);
  }

  pauseAllForAuthorizationLoss(): number {
    let paused = 0;
    for (const [projectId, state] of this.states) {
      if (state.status !== 'running') continue;
      this.pausePipeline(projectId);
      paused += 1;
    }
    return paused;
  }

  async resumePipeline(projectId: string): Promise<void> {
    return resumePipelineModule(this.buildLifecycleEngineContext(), projectId);
  }

  async resumeAfterAuth(
    projectId: string,
    provider: 'codex' | 'grok' | 'kimi' = 'codex',
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (provider === 'grok' || provider === 'kimi') {
      const status =
        provider === 'grok'
          ? await (await import('../agent-runtime/grok-availability')).isGrokAvailable()
          : await (await import('../agent-runtime/kimi-availability')).isKimiAvailable();
      if (!status.usable) {
        return {
          ok: false,
          message:
            status.reason ?? `${provider === 'grok' ? 'Grok Build' : 'Kimi'} ainda nao esta autenticado e validado.`,
        };
      }
      if (provider === 'grok') {
        const { getGrokAcpDriver } = await import('../grok-acp/acp-driver');
        await getGrokAcpDriver().closeMatching({ projectId });
      } else {
        const { getKimiAcpDriver } = await import('../kimi-acp/acp-driver');
        await getKimiAcpDriver().closeMatching({ projectId });
      }
      const state = this.getState(projectId);
      state.abortController = new AbortController();
      state.status = 'paused';
      logger.info({ projectId, provider }, 'resumeAfterAuth: provider validado; resuming pipeline');
      const checkpoint = state.conversationAuthResume;
      if (checkpoint?.provider === provider && checkpoint.phase === state.currentPhase) {
        await this.sendMessage(projectId, checkpoint.message, undefined, {
          isGreeting: checkpoint.isGreeting,
          skipUserPersistence: true,
          finalMessageOverride: checkpoint.finalMessage,
          expectedPhase: checkpoint.phase,
        });
        return state.conversationAuthResume === checkpoint
          ? { ok: false, message: 'A fase pausou novamente antes de concluir o turno.' }
          : { ok: true };
      }
      if (checkpoint && checkpoint.phase !== state.currentPhase) state.conversationAuthResume = undefined;
      const loopResume = this.harnessEngine.preparePipelineResumeAfterAuth(projectId, provider);
      if (!loopResume.ok) return loopResume;
      await this.resumePipeline(projectId);
      if (!this.harnessEngine.completePipelineResumeAfterAuth(projectId, provider)) {
        return { ok: false, message: 'A retomada concluiu, mas o checkpoint persistente mudou antes do commit.' };
      }
      return { ok: true };
    }
    const { isCodexAvailable } = await import('../codex-runtime/binary');
    const status = await isCodexAvailable();
    if (!status.authenticated) {
      return { ok: false, message: 'Codex ainda nao autenticado. Rode `codex login` e tente novamente.' };
    }
    if (!status.appServerSupported) {
      return {
        ok: false,
        message: status.error ?? 'O Codex CLI instalado nao oferece App Server.',
      };
    }

    logger.info({ projectId }, 'resumeAfterAuth: auth e App Server verificados');

    const { closeIdleCachedChatCodexSessions } = await import('../codex-sdk');
    closeIdleCachedChatCodexSessions('resume-after-auth');
    const { closeAllOfficialRuns } = await import('../agent-runtime/codex-session-factory');
    await closeAllOfficialRuns('resume-after-auth');
    const state = this.getState(projectId);
    this.closeCodexSessions(state);

    state.abortController = new AbortController();
    state.status = 'paused';

    logger.info({ projectId }, 'resumeAfterAuth: resuming pipeline');
    const checkpoint = state.conversationAuthResume;
    if (checkpoint?.provider === provider && checkpoint.phase === state.currentPhase) {
      await this.sendMessage(projectId, checkpoint.message, undefined, {
        isGreeting: checkpoint.isGreeting,
        skipUserPersistence: true,
        finalMessageOverride: checkpoint.finalMessage,
        expectedPhase: checkpoint.phase,
      });
      return state.conversationAuthResume === checkpoint
        ? { ok: false, message: 'A fase pausou novamente antes de concluir o turno.' }
        : { ok: true };
    }
    if (checkpoint && checkpoint.phase !== state.currentPhase) state.conversationAuthResume = undefined;
    const loopResume = this.harnessEngine.preparePipelineResumeAfterAuth(projectId, provider);
    if (!loopResume.ok) return loopResume;
    await this.resumePipeline(projectId);
    if (!this.harnessEngine.completePipelineResumeAfterAuth(projectId, provider)) {
      return { ok: false, message: 'A retomada concluiu, mas o checkpoint persistente mudou antes do commit.' };
    }

    return { ok: true };
  }

  public async spawnAgent(agentId: string, rawPrompt: string, opts: SpawnAgentOptions): Promise<SpawnAgentResult> {
    const prompt = opts.skipProjectRootInjection ? rawPrompt : this.withProjectRoot(opts.cwd, rawPrompt, opts.docsDir);

    const state = this.states.get(opts.projectId);
    const codexSessionKey = `${agentId}:${opts.phaseNumber}`;
    const existingCodexSession = opts.continueSession && state ? state.codexSessions.get(codexSessionKey) : undefined;

    let codexSessionRetryAttempted = false;
    const parentAgent = getAgent(agentId);
    const executionContext = createSubagentDispatchContext({
      ownerKind: 'pipeline',
      ownerId: opts.projectId,
      lane: 'pipeline',
      surface: `pipeline:phase:${opts.phaseNumber}`,
      cwd: opts.cwd,
      projectId: opts.projectId,
      readRoots: [opts.cwd],
      writeRoots: [opts.cwd],
      allowedTools: parentAgent?.allowedTools ?? [],
      permission: PERM_BYPASS_NO_GUARD,
      parentAbortSignal: opts.abortController.signal,
      abortOwner: (reason) => opts.abortController.abort(reason),
    });

    try {
      const result = await executeAgent({
        agentId,
        prompt,
        cwd: opts.cwd,
        abortController: opts.abortController,
        permission: PERM_BYPASS_NO_GUARD,
        continueSession: opts.continueSession,
        priorMessages: opts.priorMessages,
        projectId: opts.projectId,
        executionContext,
        onText: opts.onText,
        onToolUse: opts.onToolUse,
        onToolUseComplete: opts.onToolUseComplete,
        codexSession: existingCodexSession,
        onCodexSessionCreated: state
          ? (session: CodexSession) => {
              state.codexSessions.set(codexSessionKey, session);
              logger.debug(
                { agentId, phaseNumber: opts.phaseNumber, projectId: opts.projectId },
                'spawnAgent: new CodexSession stored for phase',
              );
            }
          : undefined,
        onStalled: (info) => {
          logger.warn(
            { agentId, phaseNumber: opts.phaseNumber, projectId: opts.projectId, ...info },
            'spawnAgent: agent stalled — no progress for 3min',
          );
          emitIPC('pipeline:stalled', {
            projectId: opts.projectId,
            phase: opts.phaseNumber,
            agentId,
            ...info,
          });
        },
      });
      const childAuthError = pendingSubagentProviderAuthError(executionContext);
      if (childAuthError) throw childAuthError;

      logger.info(
        {
          agentId,
          phaseNumber: opts.phaseNumber,
          projectId: opts.projectId,
          durationMs: result.metrics.durationMs,
          outputLen: result.output.length,
          toolUses: result.metrics.toolUses,
        },
        'spawnAgent: completed',
      );

      return result;
    } catch (caughtError) {
      let err: unknown = pendingSubagentProviderAuthError(executionContext) ?? caughtError;
      if (
        err instanceof CodexUnavailableError &&
        !codexSessionRetryAttempted &&
        opts.continueSession === true &&
        existingCodexSession !== undefined &&
        typeof opts.rebuildPromptOnRetry === 'function' &&
        isTransientCodexSessionError((err as Error).message)
      ) {
        codexSessionRetryAttempted = true;
        if (state) state.codexSessions.delete(codexSessionKey);
        logger.warn(
          {
            projectId: opts.projectId,
            agentId,
            phaseNumber: opts.phaseNumber,
            message: (err as Error).message,
            attempt: 1,
          },
          'codex continuation session unavailable; recreating',
        );
        emitPipelineStream({
          projectId: opts.projectId,
          phase: opts.phaseNumber,
          type: 'text',
          content: '\n[Reconectando o Codex e retomando de onde parou...]\n',
        });
        try {
          const rawResumePrompt = opts.rebuildPromptOnRetry();
          const resumePrompt = opts.skipProjectRootInjection
            ? rawResumePrompt
            : this.withProjectRoot(opts.cwd, rawResumePrompt, opts.docsDir);
          const retryRequest: AgentExecutionRequest = {
            agentId,
            prompt: resumePrompt,
            cwd: opts.cwd,
            abortController: opts.abortController,
            permission: PERM_BYPASS_NO_GUARD,
            executionContext,
            continueSession: opts.continueSession,
            priorMessages: opts.priorMessages,
            projectId: opts.projectId,
            onText: opts.onText,
            onToolUse: opts.onToolUse,
            onToolUseComplete: opts.onToolUseComplete,
            codexSession: undefined,
            onCodexSessionCreated: state
              ? (session: CodexSession) => {
                  state.codexSessions.set(codexSessionKey, session);
                  logger.debug(
                    { agentId, phaseNumber: opts.phaseNumber, projectId: opts.projectId },
                    'spawnAgent: new CodexSession stored for phase (after transient retry)',
                  );
                }
              : undefined,
            onStalled: (info) => {
              logger.warn(
                { agentId, phaseNumber: opts.phaseNumber, projectId: opts.projectId, ...info },
                'spawnAgent: agent stalled — no progress for 3min',
              );
              emitIPC('pipeline:stalled', {
                projectId: opts.projectId,
                phase: opts.phaseNumber,
                agentId,
                ...info,
              });
            },
          };
          const retryResult = await executeAgent(retryRequest);
          const childAuthError = pendingSubagentProviderAuthError(executionContext);
          if (childAuthError) throw childAuthError;
          logger.info(
            {
              agentId,
              phaseNumber: opts.phaseNumber,
              projectId: opts.projectId,
              durationMs: retryResult.metrics.durationMs,
              outputLen: retryResult.output.length,
              toolUses: retryResult.metrics.toolUses,
              codexSessionRetried: true,
            },
            'spawnAgent: completed (codex session recreated after transient failure)',
          );
          return retryResult;
        } catch (retryErr) {
          err = retryErr;
        }
      }

      if (err instanceof GrokAuthError) {
        logger.warn(
          { agentId, phaseNumber: opts.phaseNumber, projectId: opts.projectId, message: err.message },
          'spawnAgent: GrokAuthError — pausing pipeline',
        );
        emitIPC('pipeline:auth-required', {
          provider: 'grok',
          runtime: 'grok',
          projectId: opts.projectId,
          phaseNumber: opts.phaseNumber,
          agentId,
          message: err.message,
        });
        setProjectStatus(opts.projectId, 'paused');
        if (state) state.status = 'paused';
        throw new PipelinePausedError(err.message || 'Grok auth required', 'grok-auth');
      }

      if (err instanceof KimiAuthError) {
        logger.warn(
          { agentId, phaseNumber: opts.phaseNumber, projectId: opts.projectId, message: err.message },
          'spawnAgent: KimiAuthError — pausing pipeline',
        );
        emitIPC('pipeline:auth-required', {
          provider: 'kimi',
          runtime: 'kimi',
          projectId: opts.projectId,
          phaseNumber: opts.phaseNumber,
          agentId,
          message: err.message,
        });
        setProjectStatus(opts.projectId, 'paused');
        if (state) state.status = 'paused';
        throw new PipelinePausedError(err.message || 'Kimi auth required', 'kimi-auth');
      }

      if (err instanceof CodexAuthError) {
        logger.warn(
          { agentId, phaseNumber: opts.phaseNumber, projectId: opts.projectId, message: (err as Error).message },
          'spawnAgent: CodexAuthError — pausing pipeline',
        );
        emitIPC('pipeline:auth-required', {
          provider: 'codex',
          runtime: 'codex',
          projectId: opts.projectId,
          phaseNumber: opts.phaseNumber,
          agentId,
          message: (err as Error).message,
        });
        setProjectStatus(opts.projectId, 'paused');
        if (state) state.status = 'paused';
        throw new PipelinePausedError((err as Error).message || 'Codex auth required', 'codex-auth');
      }

      if (err instanceof CodexUnavailableError) {
        logger.error(
          { agentId, phaseNumber: opts.phaseNumber, projectId: opts.projectId, message: (err as Error).message },
          'spawnAgent: CodexUnavailableError — pipeline will fail',
        );
        emitIPC('pipeline:error', {
          projectId: opts.projectId,
          phase: opts.phaseNumber,
          title: 'CODEX FALHOU',
          detail: (err as Error).message,
          error: (err as Error).message,
        });
        throw err;
      }

      throw err;
    }
  }

  private closeCodexSessions(state: PhaseState): void {
    closeCodexSessionsModule(state);
  }

  private hasCodexSessionForPhase(state: PhaseState, phase: number): boolean {
    return hasCodexSessionForPhaseModule(state, phase);
  }

  private maybeKillIdleCodexOnGate(projectId: string, state: PhaseState, project: { pipelineType?: string }): void {
    maybeKillIdleCodexOnGateModule(
      { hasCodexSessionForPhase: (s, p) => this.hasCodexSessionForPhase(s as PhaseState, p) },
      projectId,
      state,
      project,
    );
  }

  private collectMetrics(
    projectId: string,
    phaseNumber: number,
    agentId: string,
    result: SpawnAgentResult,
    status: 'completed' | 'failed',
    projectCtx?: { pipelineType?: string },
  ): void {
    collectMetricsFn(projectId, phaseNumber, agentId, result, status, projectCtx);
  }

  async runAutoPhase(projectId: string, phaseNumber: number): Promise<void> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const agentId = getPhaseAgentId(phaseNumber, project) ?? 'unknown';
    const phaseName = getPhaseName(phaseNumber, project) ?? `Phase ${phaseNumber}`;
    const state = this.getState(projectId);

    logger.info(
      { projectId, phaseNumber, phaseName, agentId, pipelineType: project.pipelineType },
      'Running auto phase',
    );

    this.updateProjectColumns(projectId, {
      status: 'running',
      pipelineCurrentPhase: phaseNumber,
    });

    savePipelinePhaseMetrics({
      projectId,
      phaseNumber,
      phaseName,
      agentId,
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: phaseNumber,
      phaseName,
      status: 'running',
      awaitingUser: false,
      currentModel: this.resolveCurrentModelForPhase(project, phaseNumber),
    });

    const MAX_CODEX_AUTO_RETRIES = 1;
    for (let codexAttempt = 0; ; codexAttempt++) {
      try {
        if (project.pipelineType === 'architecture-review') {
          if (phaseNumber === 1) {
            await this.runArchitecturePhase1Map(projectId, project, state);
          } else if (phaseNumber === 3) {
            await this.runArchitecturePhase3Diagnosis(projectId, project, state);
          } else if (phaseNumber === 5) {
            await this.runArchitecturePhase5Spec(projectId, project, state);
          } else if (phaseNumber === 8) {
            await this.runPhase11(projectId, state);
          } else {
            throw new Error(`Unknown architecture-review auto phase: ${phaseNumber}`);
          }
        } else if (project.pipelineType === 'security') {
          if (phaseNumber === 1) {
            await this.runSecurityPhase1(projectId, project.projectPath, state);
          } else if (phaseNumber === 2) {
            await this.runSecurityPhase2(projectId, project, state);
          } else if (phaseNumber === 3) {
            await this.runSecurityPhase3(projectId, project.projectPath, state);
          } else if (phaseNumber === 6) {
            await this.runSecurityPhase6(projectId, project, state);
          } else if (phaseNumber === 8) {
            await this.runPhase11(projectId, state);
          } else {
            throw new Error(`Unknown security auto phase: ${phaseNumber}`);
          }
        } else if (project.pipelineType === 'bug') {
          if (phaseNumber === 2) {
            await this.runBugPhase2ParallelAnalysis(projectId, project, state);
          } else if (phaseNumber === 4) {
            await this.runBugPhase4Spec(projectId, project, state);
          } else if (phaseNumber === 6) {
            await this.runPhase11(projectId, state);
          } else {
            throw new Error(`Unknown bug auto phase: ${phaseNumber}`);
          }
        } else if (project.pipelineType === 'development-v2') {
          await this.runDevV2AutoPhase(projectId, project, phaseNumber, state);
        } else {
          const isFeature = project.pipelineType === 'feature';
          if (phaseNumber === 2) {
            if (isFeature) {
              await this.runPhase2Feature(projectId, project.projectPath, state);
            } else {
              await this.runPhase2(projectId, project.projectPath, state);
            }
          } else if (phaseNumber === 4) {
            if (isFeature) {
              await this.runPhase4Feature(projectId, project.projectPath, state);
            } else {
              await this.runPhase4(projectId, project.projectPath, state);
            }
          } else if (phaseNumber === 9) {
            await this.runPhase9(projectId);
          } else if (phaseNumber === 11) {
            await this.runPhase11(projectId, state);
          } else {
            throw new Error(`Unknown auto phase: ${phaseNumber}`);
          }
        }
        return;
      } catch (err) {
        if (
          err instanceof CodexUnavailableError &&
          codexAttempt < MAX_CODEX_AUTO_RETRIES &&
          !state.abortController.signal.aborted
        ) {
          logger.warn(
            { projectId, phaseNumber, attempt: codexAttempt + 1, message: (err as Error).message },
            'Auto phase codex stalled — auto-retrying once with a fresh codex process',
          );
          emitPipelineStream({
            projectId,
            phase: phaseNumber,
            type: 'text',
            content:
              '\n[Codex parou sem produzir saida — reiniciando a fase automaticamente com um processo novo...]\n',
          });
          this.closeCodexSessions(state);
          continue;
        }

        if (err instanceof PipelinePausedError) {
          logger.info(
            { projectId, phaseNumber, reason: err.reason },
            'Auto phase paused (PipelinePausedError) — short-circuiting',
          );
          savePipelinePhaseMetrics({
            projectId,
            phaseNumber,
            phaseName,
            agentId,
            status: 'interrupted',
            completedAt: new Date().toISOString(),
          });
          return;
        }

        if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
          logger.info({ projectId, phaseNumber }, 'Auto phase aborted');
          savePipelinePhaseMetrics({
            projectId,
            phaseNumber,
            phaseName,
            agentId,
            status: 'interrupted',
            completedAt: new Date().toISOString(),
          });
          return;
        }

        const errorMsg = (err as Error).message;
        logger.error({ err, projectId, phaseNumber }, 'Auto phase failed');

        savePipelinePhaseMetrics({
          projectId,
          phaseNumber,
          phaseName,
          agentId,
          status: 'failed',
          completedAt: new Date().toISOString(),
        });

        this.failPhase(projectId, state, {
          phase: phaseNumber,
          phaseName,
          errorMessage: errorMsg,
          statusUpdate: 'pure-paused',
          emitError: true,
          emitPhaseChanged: true,
          emitStreamDone: false,
          setStateStatusPaused: true,
        });
        return;
      }
    }
  }

  private async runPhase2(projectId: string, projectPath: string, state: PhaseState): Promise<void> {
    await runPhase2Module(this.buildPipelineEngineContext(), projectId, projectPath, state);
  }

  private async runPhase4(projectId: string, projectPath: string, state: PhaseState): Promise<void> {
    await runPhase4Module(this.buildPipelineEngineContext(), projectId, projectPath, state);
  }

  private async runPhase2Feature(projectId: string, projectPath: string, state: PhaseState): Promise<void> {
    await runPhase2FeatureModule(this.buildPipelineEngineContext(), projectId, projectPath, state);
  }

  private async runPhase4Feature(projectId: string, projectPath: string, state: PhaseState): Promise<void> {
    await runPhase4FeatureModule(this.buildPipelineEngineContext(), projectId, projectPath, state);
  }

  private async runPhase11WithBriefing(projectId: string, state: PhaseState, briefing: string | null): Promise<void> {
    return this.runPhase11(projectId, state, briefing ?? undefined);
  }

  private async runPhase11(projectId: string, state: PhaseState, briefingPrefix?: string): Promise<void> {
    await runPhase11Module(this.buildPipelineEngineContext(), projectId, state, briefingPrefix);
  }

  private async advanceToNextPhase(projectId: string, state: PhaseState): Promise<void> {
    return advanceToNextPhaseModule(this.buildLifecycleEngineContext(), projectId, state);
  }

  private inFlightSendTokens = new Map<string, { projectId: string; phaseNumber: number | null; generation: number }>();
  private sendTokenGeneration = 0;

  async sendMessage(
    projectId: string,
    message: string,
    attachments?: Array<{ id: string; type: string; filename: string; mimeType: string; data: string; size: number }>,
    opts?: {
      isGreeting?: boolean;
      skipUserPersistence?: boolean;
      finalMessageOverride?: string;
      expectedPhase?: number;
      rethrowPause?: boolean;
    },
  ): Promise<{ error: string } | void> {
    const state = this.getState(projectId);

    if (state.status === 'aborted') {
      logger.warn({ projectId }, 'sendMessage: pipeline aborted');
      return;
    }

    const phase = state.currentPhase;
    if (opts?.expectedPhase !== undefined && phase !== opts.expectedPhase) {
      return { error: `A fase mudou de ${opts.expectedPhase} para ${phase}; o turno nao sera repetido.` };
    }

    const resumeProject = getHarnessProject(projectId);
    if (resumeProject && (resumeProject.status === 'interrupted' || resumeProject.status === 'paused')) {
      state.abortController = new AbortController();
      state.status = 'running';
      setProjectStatus(projectId, 'running');
      emitIPC('pipeline:project-updated', { projectId, patch: { status: 'running' } });
      logger.info(
        { projectId, phase, prev: resumeProject.status },
        'sendMessage: retomando fase conversacional apos interrupcao/pausa',
      );
    }

    if (state.abortController.signal.aborted) {
      state.abortController = new AbortController();
      state.status = 'running';
      setProjectStatus(projectId, 'running');
      logger.info({ projectId, phase }, 'sendMessage: auto-resuming from paused state');
    }

    let finalMessage = opts?.finalMessageOverride ?? message;
    if (opts?.finalMessageOverride === undefined && attachments && attachments.length > 0) {
      const mediaRefs: string[] = [];
      for (const att of attachments) {
        if (att.type === 'image') {
          const ext = att.mimeType.split('/')[1] || 'png';
          const tmpPath = path.join(os.tmpdir(), `lionclaw-pipeline-img-${Date.now()}-${att.id}.${ext}`);
          fs.writeFileSync(tmpPath, Buffer.from(att.data, 'base64'));
          mediaRefs.push(`[Imagem: ${tmpPath}]`);
        } else if (att.type === 'audio') {
          const ext = att.mimeType.split('/')[1] || 'webm';
          const tmpPath = path.join(os.tmpdir(), `lionclaw-pipeline-audio-${Date.now()}-${att.id}.${ext}`);
          fs.writeFileSync(tmpPath, Buffer.from(att.data, 'base64'));
          mediaRefs.push(`[Audio: ${tmpPath}]`);
        }
      }
      if (mediaRefs.length > 0) {
        const refs = mediaRefs.join('\n');
        finalMessage = `${refs}\n\n${message || 'O usuario enviou midia. Use a ferramenta Read para visualizar e responda sobre o conteudo.'}`;
      }
    }

    const msgProject = getHarnessProject(projectId);
    const isSecurity = msgProject?.pipelineType === 'security';

    if (phase !== null) {
      const conversationPhases = conversationPhasesOf(msgProject?.pipelineType);
      if (!conversationPhases.has(phase)) {
        logger.warn({ projectId, phase }, 'sendMessage: rejected — auto-phase');
        emitPipelineStream({
          projectId,
          phase,
          type: 'error',
          message: 'Esta fase nao aceita mensagens manuais (auto-phase). Aguarde o agente terminar.',
        });
        return { error: 'Auto-phase nao aceita mensagens manuais' };
      }
    }

    const sendTokenKey = `${projectId}:${String(phase)}`;
    const inFlightToken = this.inFlightSendTokens.get(sendTokenKey);
    if (inFlightToken) {
      logger.warn(
        { projectId, phase, generation: inFlightToken.generation },
        'sendMessage: rejeitado — turno da fase em andamento (one-in-flight por fase)',
      );
      return { error: 'turno da fase em andamento' };
    }
    const sendToken = {
      projectId,
      phaseNumber: phase,
      generation: ++this.sendTokenGeneration,
    };
    this.inFlightSendTokens.set(sendTokenKey, sendToken);

    try {
      if (!opts?.skipUserPersistence) {
        persistMessage(
          {
            kind: 'pipeline',
            projectId,
            phaseNumber: phase,
            agentId: opts?.isGreeting ? PIPELINE_GREETING_AGENT_ID : undefined,
          },
          'user',
          message,
        );
      }

      emitPipelineStream({ projectId, phase, type: 'thinking' });

      try {
        if (phase !== null) {
          const outcome = await dispatchConversationMessage(
            {
              engine: this.buildMessageRouterEngine(),
              projectId,
              message: finalMessage,
              state,
              project: msgProject!,
              resolveTechAgentId: (techPhase) => this.resolveTechAgentIdForMessage(msgProject, techPhase),
            },
            phase,
          );
          if (outcome === 'refused') {
            logger.warn(
              { projectId, phase },
              '[development-v2] phase 5 nao aceita chat — use a UI do Studio (botao Travar Design e Continuar)',
            );
            emitPipelineStream({ projectId, phase, type: 'done' });
          } else if (outcome === 'none') {
            const noHandlerMsg =
              msgProject?.pipelineType === 'architecture-review'
                ? 'sendMessage: no architecture-review handler for this phase'
                : isSecurity
                  ? 'sendMessage: no security handler for this phase'
                  : msgProject?.pipelineType === 'development-v2'
                    ? '[development-v2] sendMessage: no handler for this phase'
                    : 'sendMessage: no handler for this phase';
            logger.warn({ projectId, phase }, noHandlerMsg);
          }
        }
        if (phase !== null && state.conversationAuthResume?.phase === phase) {
          state.conversationAuthResume = undefined;
        }
      } catch (err) {
        if (err instanceof PipelinePausedError) {
          if (phase !== null) {
            state.conversationAuthResume = {
              phase,
              provider: err.reason === 'grok-auth' ? 'grok' : err.reason === 'kimi-auth' ? 'kimi' : 'codex',
              message,
              finalMessage,
              isGreeting: opts?.isGreeting === true,
            };
          }
          logger.info({ projectId, phase, reason: err.reason }, 'sendMessage: PipelinePausedError — short-circuiting');
          emitPipelineStream({ projectId, phase, type: 'done' });
          if (opts?.rethrowPause) throw err;
          return;
        }
        if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
          emitPipelineStream({ projectId, phase, type: 'done' });
          return;
        }
        logger.error({ err, projectId, phase }, 'sendMessage: error');
        emitIPC('pipeline:error', { projectId, phase, error: (err as Error).message });
        emitPipelineStream({ projectId, phase, type: 'done' });
      }
    } finally {
      if (this.inFlightSendTokens.get(sendTokenKey) === sendToken) {
        this.inFlightSendTokens.delete(sendTokenKey);
      }
    }
  }

  private inFlightApproveByProject = new Set<string>();

  async approvePhase(projectId: string, metadata?: Record<string, unknown>): Promise<void> {
    if (this.inFlightApproveByProject.has(projectId)) {
      logger.warn(
        { projectId },
        'approvePhase: chamada concorrente ignorada (ja ha approvePhase em andamento neste projeto)',
      );
      return;
    }
    this.inFlightApproveByProject.add(projectId);
    try {
      await this.approvePhaseInner(projectId, metadata);
    } finally {
      this.inFlightApproveByProject.delete(projectId);
    }
  }

  private async approvePhaseInner(projectId: string, metadata?: Record<string, unknown>): Promise<void> {
    const state = this.getState(projectId);

    if (state.status === 'aborted') {
      logger.warn({ projectId }, 'approvePhase: pipeline aborted');
      return;
    }

    const phase = state.currentPhase;
    const approveProject = getHarnessProject(projectId);

    if (approveProject) this.maybeKillIdleCodexOnGate(projectId, state, approveProject);

    const isSecurity = approveProject?.pipelineType === 'security';
    const isArchitectureReview = approveProject?.pipelineType === 'architecture-review';

    try {
      if (isArchitectureReview) {
        if (phase === 2) {
          const selectedCandidateId = metadata?.['selectedCandidateId'];
          if (typeof selectedCandidateId !== 'string' || selectedCandidateId.length === 0) {
            const errMsg = 'pipeline:approve fase 2 (architecture-review) requer { selectedCandidateId: string }';
            logger.warn({ projectId, phase, metadata }, errMsg);
            emitIPC('pipeline:error', { projectId, phase, error: errMsg });
            throw new Error(errMsg);
          }
          const ctx = approveProject ? getArchitectureReviewContext(approveProject) : null;
          if (!ctx) {
            throw new Error('architecture-review context not found — cannot validate candidate');
          }
          if (!fs.existsSync(ctx.candidatesJsonPath)) {
            throw new Error(`Candidates JSON not found at ${ctx.candidatesJsonPath}`);
          }
          let candidates: Array<{ id?: string }> = [];
          try {
            const parsed = JSON.parse(fs.readFileSync(ctx.candidatesJsonPath, 'utf-8'));
            candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
          } catch (err) {
            throw new Error(`Invalid candidates JSON: ${(err as Error).message}`);
          }
          if (!candidates.some((c) => c.id === selectedCandidateId)) {
            const errMsg = `invalid candidate id "${selectedCandidateId}" — not found in candidates JSON`;
            logger.warn({ projectId, selectedCandidateId, knownIds: candidates.map((c) => c.id) }, errMsg);
            emitIPC('pipeline:error', { projectId, phase, error: errMsg });
            throw new Error(errMsg);
          }
          updateHarnessProject(projectId, {
            config: {
              ...approveProject.config,
              architectureReview: {
                ...(approveProject.config.architectureReview ?? {}),
                selectedCandidateId,
              },
            },
          });
          patchArchitectureReviewManifest(approveProject, {
            selectedCandidateId,
          });
          this.runFinalizeInBackground(projectId, phase, state, approveProject ?? undefined);
        } else if (phase === 4) {
          const ctx = approveProject ? getArchitectureReviewContext(approveProject) : null;
          if (!ctx) {
            throw new Error('architecture-review context not found — cannot validate decisions');
          }
          if (!fs.existsSync(ctx.decisionsMdPath)) {
            const errMsg = `A entrevista ainda nao tem decisoes registradas. Registre pelo menos ${ARCHITECTURE_PHASE4_MIN_DECISIONS} decisoes (D1/D2/D3) com Pergunta, Decisao, Razao e Implica antes de gerar a SPEC.`;
            emitIPC('pipeline:error', { projectId, phase, error: errMsg });
            throw new Error(errMsg);
          }
          const decisionsContent = fs.readFileSync(ctx.decisionsMdPath, 'utf-8');
          const validation = validateDecisionsMd(decisionsContent);
          if (validation.count < ARCHITECTURE_PHASE4_MIN_DECISIONS) {
            const errMsg = `A entrevista ainda nao tem decisoes suficientes (atual: ${validation.count}, minimo: ${ARCHITECTURE_PHASE4_MIN_DECISIONS}). Registre pelo menos ${ARCHITECTURE_PHASE4_MIN_DECISIONS} decisoes (D1/D2/D3) com Pergunta, Decisao, Razao e Implica antes de gerar a SPEC.`;
            emitIPC('pipeline:error', { projectId, phase, error: errMsg });
            throw new Error(errMsg);
          }
          if (validation.gaps.length > 0) {
            const detalhes = validation.gaps
              .map(
                (g) =>
                  `D${g.decisionN}${g.title ? ` (${g.title})` : ''}: falta ${g.missing.map((f) => DECISION_FIELD_LABEL[f]).join(', ')}`,
              )
              .join('; ');
            const errMsg = `Decisoes incompletas: ${detalhes}. Cada decisao precisa ter Pergunta, Decisao, Razao e Implica antes de gerar a SPEC.`;
            emitIPC('pipeline:error', { projectId, phase, error: errMsg });
            throw new Error(errMsg);
          }
          this.runFinalizeInBackground(projectId, phase, state, approveProject ?? undefined);
        } else if (phase === 6 || phase === 7 || phase === 9) {
          await this.finalizeConversationPhase(projectId, phase, state, approveProject ?? undefined);
        } else {
          logger.warn({ projectId, phase }, 'approvePhase: no architecture-review handler for this phase');
        }
      } else if (isSecurity) {
        if (phase === 4 || phase === 5 || phase === 6 || phase === 7 || phase === 9) {
          if (phase === 5 && approveProject) {
            const projectPath = (approveProject as { projectPath: string }).projectPath;
            const securityDir = path.join(projectPath, '.lionclaw', 'Security');
            const consolidatedFiles = fs.existsSync(securityDir)
              ? fs
                  .readdirSync(securityDir)
                  .filter((f) => /^Security-\d{8}-\d{4}\.md$/.test(f))
                  .sort()
              : [];
            const securityReportPath =
              consolidatedFiles.length > 0
                ? path.join(securityDir, consolidatedFiles[consolidatedFiles.length - 1]!)
                : null;
            if (securityReportPath) {
              try {
                const reParsed = parseSecurityFindings(securityReportPath);
                const existingSummary = getSecuritySummaryJson(projectId);
                const originalTotal = existingSummary?.totalFindings ?? reParsed.total;
                patchSecuritySummaryJson(projectId, {
                  bySeverity: reParsed.bySeverity,
                  confirmedFindings: reParsed.total,
                  removedByValidator: Math.max(0, originalTotal - reParsed.total),
                });
                logger.info(
                  { projectId, confirmed: reParsed.total, removed: originalTotal - reParsed.total },
                  'SecuritySummary: confirmedFindings + removedByValidator written after phase 5 approval',
                );
              } catch (err) {
                logger.warn({ err, projectId }, 'SecuritySummary: failed to re-parse findings after phase 5, skipping');
              }
            }
          }
          await this.finalizeConversationPhase(projectId, phase, state, approveProject ?? undefined);
        } else {
          logger.warn({ projectId, phase }, 'approvePhase: no security handler for this phase');
        }
      } else if (approveProject?.pipelineType === 'bug') {
        if (phase === 3) {
          const action = metadata?.['action'];
          if (typeof action !== 'string') {
            const errMsg = 'pipeline:approve fase 3 (bug) requer { action: "approve-plan" | "close-pipeline" }';
            logger.warn({ projectId, phase, metadata }, errMsg);
            emitIPC('pipeline:error', { projectId, phase, error: errMsg });
            throw new Error(errMsg);
          }
          if (action !== 'approve-plan' && action !== 'close-pipeline') {
            const errMsg =
              `pipeline:approve fase 3 (bug): action invalida "${action}". ` +
              'Use "approve-plan" (segue para a SPEC) ou "close-pipeline" (encerra sem correcao).';
            logger.warn({ projectId, phase, metadata }, errMsg);
            emitIPC('pipeline:error', { projectId, phase, error: errMsg });
            throw new Error(errMsg);
          }
          const bugCtx = getBugContext(approveProject);
          if (!bugCtx) {
            throw new Error('bug run context not found — cannot record the phase 3 outcome');
          }
          if (!fs.existsSync(bugCtx.planoPath)) {
            throw new Error(`Plano de correcao nao encontrado em ${bugCtx.planoPath}`);
          }

          if (action === 'approve-plan') {
            updateHarnessProject(projectId, {
              config: {
                ...approveProject.config,
                bug: {
                  ...(approveProject.config.bug ?? {}),
                  outcome: 'fix',
                },
              },
            });
            patchBugManifest(approveProject, { outcome: 'fix' });
            this.runBugFinalizeInBackground(projectId, phase, state, approveProject);
          } else {
            updateHarnessProject(projectId, {
              config: {
                ...approveProject.config,
                bug: {
                  ...(approveProject.config.bug ?? {}),
                  outcome: 'no-bug',
                },
              },
            });
            patchBugManifest(approveProject, { outcome: 'no-bug' });
            this.flushAccumulatedMetrics(
              projectId,
              3,
              BUG_SOLUTION_CONSOLIDATOR_ID,
              state,
              'completed',
              approveProject,
            );
            this.completePipeline(projectId, state, {
              terminalStatusString: 'pipeline-completed',
              setStateIdle: false,
            });
          }
        } else if (phase === 1 || phase === 5) {
          this.runBugFinalizeInBackground(projectId, phase, state, approveProject);
        } else if (phase === 7) {
          await this.finalizeBugConversationPhase(projectId, phase, state, approveProject);
        } else {
          logger.warn({ projectId, phase }, 'approvePhase: no bug handler for this phase');
        }
      } else if (approveProject?.pipelineType === 'development-v2') {
        if (phase === 5) {
          const action = metadata?.['action'];
          if (action !== 'lock-and-continue') {
            const errMsg =
              'pipeline:approve fase 5 (development-v2) requer { action: "lock-and-continue" }. ' +
              'Use o botao "Travar Design e Continuar" no StudioView; nao chame open-design:lock direto.';
            logger.warn({ projectId, phase, metadata }, errMsg);
            emitIPC('pipeline:error', { projectId, phase, error: errMsg });
            throw new Error(errMsg);
          }
          const od = approveProject.config?.openDesign;
          if (!od?.openDesignProjectId || !od?.conversationId) {
            const errMsg =
              'Design Lock impossivel: sessao LionDesign nao bootstrappada ' +
              '(openDesignProjectId / conversationId ausentes em config.openDesign).';
            logger.warn({ projectId, phase, od }, errMsg);
            emitIPC('pipeline:error', { projectId, phase, error: errMsg });
            throw new Error(errMsg);
          }
          await this.finalizeDevV2ConversationPhase(projectId, phase, state, approveProject);
        } else {
          await this.finalizeDevV2ConversationPhase(projectId, phase, state, approveProject);
        }
      } else {
        switch (phase) {
          case 1:
          case 3:
          case 5:
          case 6:
          case 7:
          case 8:
          case 9:
          case 10:
          case 12:
            await this.finalizeConversationPhase(projectId, phase, state);
            break;
          default:
            logger.warn({ projectId, phase }, 'approvePhase: no handler for this phase');
        }
      }
    } catch (err) {
      if (err instanceof PipelinePausedError) {
        logger.info({ projectId, phase, reason: err.reason }, 'approvePhase: PipelinePausedError — short-circuiting');
        return;
      }
      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        return;
      }
      logger.error({ err, projectId, phase }, 'approvePhase: error');
      emitIPC('pipeline:error', { projectId, phase, error: (err as Error).message });
      throw err;
    }
  }

  private async handlePhase1Message(projectId: string, message: string, state: PhaseState): Promise<void> {
    await handlePhase1MessageModule(this.buildPipelineEngineContext(), projectId, message, state);
  }

  private async handlePhase3Message(projectId: string, message: string, state: PhaseState): Promise<void> {
    await handlePhase3MessageModule(this.buildPipelineEngineContext(), projectId, message, state);
  }

  private async handleTechPhaseMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    phaseNumber: number,
    agentId: string,
  ): Promise<void> {
    await handleTechPhaseMessageModule(
      this.buildPipelineEngineContext(),
      projectId,
      message,
      state,
      phaseNumber,
      agentId,
    );
  }

  private async handlePhase10Message(projectId: string, message: string, state: PhaseState): Promise<void> {
    await handlePhase10MessageModule(this.buildPipelineEngineContext(), projectId, message, state);
  }

  private async handlePhase12Message(
    projectId: string,
    message: string,
    state: PhaseState,
    phaseNumber: number = 12,
    briefing?: string | null,
  ): Promise<void> {
    await handlePhase12MessageModule(
      this.buildPipelineEngineContext(),
      projectId,
      message,
      state,
      phaseNumber,
      briefing,
    );
  }

  private async runSecurityPhase1(projectId: string, projectPath: string, state: PhaseState): Promise<void> {
    await runSecurityPhase1Module(this.buildPipelineEngineContext(), projectId, projectPath, state);
  }

  private async runSecurityPhase2(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    await runSecurityPhase2Module(this.buildPipelineEngineContext(), projectId, project, state);
  }

  private async runSecurityPhase3(projectId: string, projectPath: string, state: PhaseState): Promise<void> {
    await runSecurityPhase3Module(this.buildPipelineEngineContext(), projectId, projectPath, state);
  }

  private async runSecurityPhase6(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    await runSecurityPhase6Module(this.buildPipelineEngineContext(), projectId, project, state);
  }

  private async handleSecurityPhase4Message(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleSecurityPhase4MessageModule(this.buildPipelineEngineContext(), projectId, message, state, project);
  }

  private async handleSecurityPhase5Message(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleSecurityPhase5MessageModule(this.buildPipelineEngineContext(), projectId, message, state, project);
  }

  private async handleSecurityPhase6SpecReviewMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleSecurityPhase6SpecReviewMessageModule(
      this.buildPipelineEngineContext(),
      projectId,
      message,
      state,
      project,
    );
  }

  private async handleSecurityPhase7Message(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleSecurityPhase7MessageModule(this.buildPipelineEngineContext(), projectId, message, state, project);
  }

  private async handleSecurityPhase9Message(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleSecurityPhase9MessageModule(this.buildPipelineEngineContext(), projectId, message, state, project);
  }

  private async runResolutionTracker(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await runResolutionTrackerModule(this.buildPipelineEngineContext(), projectId, project);
  }

  async runPhase9(projectId: string): Promise<void> {
    await runPhase9Module(this.buildPipelineEngineContext(), projectId);
  }

  private async runArchitecturePhase1Map(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    await runArchitecturePhase1MapModule(this.buildPipelineEngineContext(), projectId, project, state);
  }

  private async handleArchitecturePhase2TriageMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleArchitecturePhase2TriageMessageModule(
      this.buildPipelineEngineContext(),
      projectId,
      message,
      state,
      project,
    );
  }

  private async runArchitecturePhase3Diagnosis(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    await runArchitecturePhase3DiagnosisModule(this.buildPipelineEngineContext(), projectId, project, state);
  }

  private async handleArchitecturePhase4DecisionMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleArchitecturePhase4DecisionMessageModule(
      this.buildPipelineEngineContext(),
      projectId,
      message,
      state,
      project,
    );
  }

  private async runArchitecturePhase5Spec(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    await runArchitecturePhase5SpecModule(this.buildPipelineEngineContext(), projectId, project, state);
  }

  private async handleArchitecturePhase6SpecValidationMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleArchitecturePhase6SpecValidationMessageModule(
      this.buildPipelineEngineContext(),
      projectId,
      message,
      state,
      project,
    );
  }

  private async handleArchitecturePhase7SpecEnricherMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleArchitecturePhase7SpecEnricherMessageModule(
      this.buildPipelineEngineContext(),
      projectId,
      message,
      state,
      project,
    );
  }

  private async handleBugPhase1DiscoveryMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleBugPhase1DiscoveryMessageModule(this.buildPipelineEngineContext(), projectId, message, state, project);
  }

  private async runBugPhase2ParallelAnalysis(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    await runBugPhase2ParallelAnalysisModule(this.buildPipelineEngineContext(), projectId, project, state);
  }

  private async handleBugPhase3ConsolidationMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleBugPhase3ConsolidationMessageModule(
      this.buildPipelineEngineContext(),
      projectId,
      message,
      state,
      project,
    );
  }

  private async runBugPhase4Spec(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    await runBugPhase4SpecModule(this.buildPipelineEngineContext(), projectId, project, state);
  }

  private async handleBugPhase5SpecValidatorMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleBugPhase5SpecValidatorMessageModule(
      this.buildPipelineEngineContext(),
      projectId,
      message,
      state,
      project,
    );
  }

  private async finalizeBugConversationPhase(
    projectId: string,
    phase: number,
    state: PhaseState,
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
  ): Promise<void> {
    await finalizeBugConversationPhaseModule(this.buildPipelineEngineContext(), projectId, phase, state, project);
  }

  private runBugFinalizeInBackground(
    projectId: string,
    phase: number,
    state: PhaseState,
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
  ): void {
    void this.finalizeBugConversationPhase(projectId, phase, state, project).catch((err) => {
      if (err instanceof PipelinePausedError) {
        logger.info(
          { projectId, phase, reason: err.reason },
          'Background bug finalize: PipelinePausedError — short-circuiting',
        );
        return;
      }
      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        return;
      }
      logger.error({ err, projectId, phase }, 'Background finalizeBugConversationPhase failed');
      emitIPC('pipeline:error', { projectId, phase, error: (err as Error).message });
    });
  }

  private async handlePhase9Message(projectId: string, message: string, state: PhaseState): Promise<void> {
    await handlePhase9MessageModule(this.buildPipelineEngineContext(), projectId, message, state);
  }

  private async finalizeConversationPhase(
    projectId: string,
    phase: number,
    state: PhaseState,
    projectCtx?: { pipelineType?: string },
  ): Promise<void> {
    const agentId = (projectCtx ? getPhaseAgentId(phase, projectCtx) : PHASE_AGENT_IDS[phase]) ?? 'unknown';
    this.flushAccumulatedMetrics(projectId, phase, agentId, state, 'completed', projectCtx);

    if (phase === 9 && projectCtx?.pipelineType !== 'security') {
      this.flushAccumulatedMetrics(projectId, 91, SPEC_VALIDATOR_ID, state, 'completed', undefined, true);
    }

    if (phase === 6 && projectCtx?.pipelineType === 'security') {
      this.flushAccumulatedMetrics(projectId, 61, SECURITY_SPEC_VALIDATOR_ID, state, 'completed', undefined, true);
    }

    logger.info({ projectId, phase }, 'Conversation phase finalized by user approval');

    const phaseName = (projectCtx ? getPhaseName(phase, projectCtx) : PHASE_NAMES[phase]) ?? `Phase ${phase}`;

    const isSprintValidatorPhase =
      (projectCtx?.pipelineType === 'security' && phase === 9) ||
      (projectCtx?.pipelineType === 'architecture-review' && phase === 9) ||
      (projectCtx?.pipelineType !== 'security' && projectCtx?.pipelineType !== 'architecture-review' && phase === 12);

    if (isSprintValidatorPhase) {
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

    await this.advanceToNextPhase(projectId, state);
  }

  private buildPriorMessagesForPhase(projectId: string, phaseNumber: number): PriorMessages {
    try {
      const history = getPipelinePhaseMessagesAsChatHistory(projectId, phaseNumber);
      return history.length > 0
        ? history.map((m) => ({
            ...m,
            tool_calls: m.tool_calls?.map((tc) => ({
              id: tc.id,
              function: {
                name: tc.function.name,
                arguments: (() => {
                  try {
                    return JSON.parse(tc.function.arguments) as Record<string, unknown>;
                  } catch {
                    return {};
                  }
                })(),
              },
            })),
          }))
        : undefined;
    } catch (err) {
      logger.warn({ err, projectId, phaseNumber }, 'buildPriorMessagesForPhase: failed to load history');
      return undefined;
    }
  }

  private runFinalizeInBackground(
    projectId: string,
    phase: number,
    state: PhaseState,
    project: NonNullable<ReturnType<typeof getHarnessProject>> | undefined,
  ): void {
    void this.finalizeConversationPhase(projectId, phase, state, project).catch((err) => {
      if (err instanceof PipelinePausedError) {
        logger.info(
          { projectId, phase, reason: err.reason },
          'Background finalize: PipelinePausedError — short-circuiting',
        );
        return;
      }
      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        return;
      }
      logger.error({ err, projectId, phase }, 'Background finalizeConversationPhase failed');
      emitIPC('pipeline:error', { projectId, phase, error: (err as Error).message });
    });
  }

  async confirmStartDevelopment(projectId: string): Promise<void> {
    const state = this.getState(projectId);
    if (state.status === 'aborted') {
      logger.warn({ projectId }, 'confirmStartDevelopment: pipeline aborted');
      return;
    }

    const confirmProject = getHarnessProject(projectId);

    if (confirmProject) {
      const reseed = reseedHarnessSprintsFromFile(confirmProject);
      if (reseed.action !== 'noop') {
        logger.info(
          { projectId, action: reseed.action, totalSprints: reseed.totalSprints, totalFeatures: reseed.totalFeatures },
          'confirmStartDevelopment: fila de sprints reconciliada com o sprints.json aprovado',
        );
      }
      emitPipelineSprintsLoaded(projectId);
    }

    if (confirmProject) this.maybeKillIdleCodexOnGate(projectId, state, confirmProject);

    const sprintValidatorPhase =
      (confirmProject ? getPhaseNumberForAgent(confirmProject, 'sprint-validator') : undefined) ?? 12;
    const sprintValidatorName =
      (confirmProject ? getPhaseName(sprintValidatorPhase, confirmProject) : PHASE_NAMES[12]) ??
      `Phase ${sprintValidatorPhase}`;

    logger.info(
      { projectId, sprintValidatorPhase },
      'User confirmed start of development — advancing from Sprint Validator to Coder/Evaluator',
    );

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: sprintValidatorPhase,
      phaseName: sprintValidatorName,
      status: 'completed',
      awaitingUser: false,
    });

    await this.advanceToNextPhase(projectId, state);
  }

  private createEmptyMetrics(): SpawnAgentResult['metrics'] {
    return createEmptyMetricsFn();
  }

  private mergeMetrics(accum: SpawnAgentResult['metrics'], result: SpawnAgentResult['metrics']): void {
    mergeMetricsFn(accum, result);
  }

  private accumulateMetrics(state: PhaseState, phaseNumber: number, result: SpawnAgentResult): void {
    accumulateMetricsFn(state, phaseNumber, result);
  }

  private flushAccumulatedMetrics(
    projectId: string,
    phaseNumber: number,
    agentId: string,
    state: PhaseState,
    status: 'completed' | 'failed',
    projectCtx?: { pipelineType?: string },
    includePersisted = false,
  ): void {
    flushAccumulatedMetricsFn(projectId, phaseNumber, agentId, state, status, projectCtx, includePersisted);
  }

  private resolveCurrentModelForPhase(
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
    phaseNumber: number,
    sprintIndex?: number,
  ): string | null {
    const coderPhase = getPhaseNumberForAgent(project, 'harness-coder');
    const evaluatorPhase = getPhaseNumberForAgent(project, 'harness-evaluator');
    const isCoderPhase = coderPhase !== undefined && phaseNumber === coderPhase;
    const isEvaluatorPhase = evaluatorPhase !== undefined && phaseNumber === evaluatorPhase;

    if (sprintIndex !== undefined && (isCoderPhase || isEvaluatorPhase)) {
      const sprint = getHarnessSprintByIndex(project.id, sprintIndex);
      if (!sprint) return null;
      const agentId = isCoderPhase ? sprint.coderAgentId : sprint.evaluatorAgentId;
      if (!agentId) return null;
      const agent = getAgent(agentId);
      return resolveModelForAgent(agent);
    }
    const agentId = getPhaseAgentId(phaseNumber, project) ?? null;
    if (!agentId) return null;
    const agent = getAgent(agentId);
    return resolveModelForAgent(agent);
  }

  releaseLoopPhase(projectId: string): void {
    logger.debug({ projectId }, 'releaseLoopPhase called (no-op pos-S4.2 — lock held until terminal state)');
  }

  getCurrentPhase(projectId: string): { phase: number; status: string } | null {
    if (!this.states.has(projectId)) return null;
    const s = this.states.get(projectId)!;
    return { phase: s.currentPhase, status: s.status };
  }

  async runSprint(projectId: string, sprintIndex: number): Promise<void> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const sprints = getHarnessSprints(projectId);
    if (sprintIndex < 0 || sprintIndex >= sprints.length) {
      throw new Error(`Sprint index ${sprintIndex} out of range (project has ${sprints.length} sprints)`);
    }

    const coderPhase =
      getPhaseNumberForAgent(project, 'harness-coder') ??
      (project.pipelineType === 'security' || project.pipelineType === 'architecture-review' ? 10 : 13);
    const evaluatorPhase =
      getPhaseNumberForAgent(project, 'harness-evaluator') ??
      (project.pipelineType === 'security' || project.pipelineType === 'architecture-review' ? 11 : 14);
    const coderPhaseName = getPhaseName(coderPhase, project) ?? `Phase ${coderPhase}`;

    const state = this.getState(projectId);

    const queueIntegrity = checkHarnessSprintQueueIntegrity(project, sprints);
    if (!queueIntegrity.ok) {
      logger.error(
        { projectId, sprintIndex, kind: queueIntegrity.kind },
        'runSprint: fila de sprints divergente do sprints.json — pausando (fail-loud)',
      );
      this.failPhase(projectId, state, {
        phase: coderPhase,
        errorMessage: queueIntegrity.message,
        statusUpdate: 'pure-paused',
        emitError: true,
        emitPhaseChanged: false,
        emitStreamDone: false,
        setStateStatusPaused: true,
        errorFirst: true,
      });
      return;
    }
    if (queueIntegrity.warning) {
      logger.warn(
        { projectId, sprintIndex, warning: queueIntegrity.warning },
        'runSprint: divergencia legada tolerada',
      );
    }

    state.currentSprintIndex = sprintIndex;
    state.currentPhase = coderPhase;
    state.status = 'running';

    this.updateProjectColumns(projectId, {
      pipelineCurrentPhase: coderPhase,
      pipelineSprintIndex: sprintIndex,
      status: 'running',
    });

    const sprint = sprints[sprintIndex];
    logger.info(
      { projectId, sprintIndex, sprintName: sprint.name, coderPhase },
      'runSprint: starting coder+evaluator loop',
    );

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: coderPhase,
      phaseName: coderPhaseName,
      status: 'running',
      awaitingUser: false,
      metadata: { sprintIndex, sprintName: sprint.name },
    });

    ensureProjectLock(projectId, 'pipeline-engine');

    const seenDeltas = new Set<string>();
    this.harnessEngine.setStreamBridge((channel, data) => {
      if (channel === 'harness:agent-stream') {
        const d = data as {
          projectId?: string;
          agent?: string;
          sprintId?: string;
          round?: number;
          event?: { type?: string; content?: string; tool?: string };
        };
        if (d.projectId !== projectId || !d.event?.type) return;
        const phase = d.agent === 'evaluator' ? evaluatorPhase : coderPhase;
        const tupleKey = `${d.sprintId ?? ''}:${d.round ?? 0}:${d.agent ?? ''}`;

        if (d.event.type === 'text_delta' && d.event.content) {
          seenDeltas.add(tupleKey);
          emitPipelineStream({ projectId, phase, type: 'text', content: d.event.content });
        } else if (d.event.type === 'text' && d.event.content) {
          if (!seenDeltas.has(tupleKey)) {
            emitPipelineStream({ projectId, phase, type: 'text', content: d.event.content });
          }
        } else if ((d.event.type === 'tool_use' || d.event.type === 'tool_call') && d.event.tool) {
          emitPipelineStream({ projectId, phase, type: 'tool_call', tool: d.event.tool });
        } else if (d.event.type === 'thinking') {
          emitPipelineStream({ projectId, phase, type: 'thinking' });
        }
      }
    });

    let coderBriefingPrefix: string | undefined;
    if (project.pipelineType === 'development-v2') {
      try {
        const { readHarnessSprintsJson } = await import('../harness-planner');
        const sprintsJson = readHarnessSprintsJson(project);
        const sprintJson = sprintsJson?.sprints[sprintIndex];
        if (sprintJson?.metadata) {
          const meta = sprintJson.metadata;
          const metaForBriefing = {
            touchesUI: meta.touchesUI,
            affectedScreenIds: meta.affectedScreenIds,
            affectedComponentIds: meta.affectedComponentIds,
            designArtifactPath: meta.designArtifactPath,
          };
          const coderBriefing = getDevV2Briefing('harness-coder', { sprintMetadata: metaForBriefing });
          if (coderBriefing) coderBriefingPrefix = coderBriefing;
        }
      } catch (briefingErr) {
        logger.warn(
          { projectId, sprintIndex, err: briefingErr },
          'runSprint: could not build dev-v2 coder briefing, proceeding without it',
        );
      }
    }

    let sprintResult: import('../harness-engine').SprintResult;
    try {
      sprintResult = await this.harnessEngine.runSingleSprint(projectId, sprintIndex, coderBriefingPrefix);
    } catch (err) {
      this.harnessEngine.clearStreamBridge();
      if (err instanceof PipelinePausedError) {
        logger.info(
          { projectId, sprintIndex, reason: err.reason },
          'runSprint: provider auth pause propagated without marking sprint failed',
        );
        throw err;
      }
      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        logger.info({ projectId, sprintIndex }, 'runSprint: aborted during coder/evaluator loop');
        return;
      }
      const errMsg = (err as Error).message;
      logger.error({ err, projectId, sprintIndex }, 'runSprint: HarnessEngine.runSingleSprint failed');
      this.failPhase(projectId, state, {
        phase: coderPhase,
        errorMessage: errMsg,
        statusUpdate: 'pure-paused',
        emitError: true,
        emitPhaseChanged: false,
        emitStreamDone: false,
        setStateStatusPaused: true,
        errorFirst: true,
      });
      return;
    }

    this.harnessEngine.clearStreamBridge();

    if (state.abortController.signal.aborted) {
      logger.info({ projectId, sprintIndex }, 'runSprint: aborted after coder/evaluator loop');
      return;
    }

    const actualCoderAgent = sprint.coderAgentId || (getPhaseAgentId(coderPhase, project) ?? 'harness-coder');
    const actualEvaluatorAgent =
      sprint.evaluatorAgentId || (getPhaseAgentId(evaluatorPhase, project) ?? 'harness-evaluator');

    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: coderPhase,
      sprintIndex,
      phaseName: getPhaseName(coderPhase, project) ?? `Phase ${coderPhase}`,
      agentId: actualCoderAgent,
      status: 'completed',
      inputTokens: sprintResult.coderMetrics.inputTokens,
      outputTokens: sprintResult.coderMetrics.outputTokens,
      cacheReadTokens: sprintResult.coderMetrics.cacheReadTokens,
      cacheCreationTokens: sprintResult.coderMetrics.cacheCreationTokens,
      costUsd: sprintResult.coderMetrics.costUsd,
      durationMs: sprintResult.coderMetrics.durationMs,
      toolUses: sprintResult.coderMetrics.toolUses,
      apiRequests: sprintResult.coderMetrics.apiRequests,
      model: sprintResult.coderMetrics.model ?? undefined,
      runtime: sprintResult.coderMetrics.runtime ?? undefined,
      completedAt: new Date().toISOString(),
      metadata: {
        sprintIndex,
        sprintName: sprint.name,
        ...(sprintResult.coderMetrics.provider !== undefined && {
          provider: sprintResult.coderMetrics.provider,
        }),
        ...(sprintResult.coderMetrics.costEstimationKind !== undefined && {
          costEstimationKind: sprintResult.coderMetrics.costEstimationKind,
        }),
        ...(sprintResult.coderMetrics.costStatus !== undefined && {
          costStatus: sprintResult.coderMetrics.costStatus,
        }),
        ...(sprintResult.coderMetrics.tokenStatus !== undefined && {
          tokenStatus: sprintResult.coderMetrics.tokenStatus,
        }),
        ...(sprintResult.coderMetrics.costUnknownReason !== undefined && {
          costUnknownReason: sprintResult.coderMetrics.costUnknownReason,
        }),
        ...(sprintResult.coderMetrics.sessionIds !== undefined &&
          sprintResult.coderMetrics.sessionIds.length > 0 && {
            sessionIds: sprintResult.coderMetrics.sessionIds,
          }),
        ...(sprintResult.coderMetrics.costSource !== undefined && {
          costSource: sprintResult.coderMetrics.costSource,
        }),
        ...(sprintResult.coderMetrics.pricingSnapshot !== undefined && {
          pricingSnapshot: sprintResult.coderMetrics.pricingSnapshot,
        }),
        ...(sprintResult.coderMetrics.modelUsage !== undefined && {
          modelUsage: sprintResult.coderMetrics.modelUsage,
        }),
        ...(sprintResult.coderMetrics.grok !== undefined && {
          grok: sprintResult.coderMetrics.grok,
        }),
      },
      unknownCostCount: sprintResult.coderMetrics.unknownCostCount ?? 0,
    });

    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: evaluatorPhase,
      sprintIndex,
      phaseName: getPhaseName(evaluatorPhase, project) ?? `Phase ${evaluatorPhase}`,
      agentId: actualEvaluatorAgent,
      status: 'completed',
      inputTokens: sprintResult.evaluatorMetrics.inputTokens,
      outputTokens: sprintResult.evaluatorMetrics.outputTokens,
      cacheReadTokens: sprintResult.evaluatorMetrics.cacheReadTokens,
      cacheCreationTokens: sprintResult.evaluatorMetrics.cacheCreationTokens,
      costUsd: sprintResult.evaluatorMetrics.costUsd,
      durationMs: sprintResult.evaluatorMetrics.durationMs,
      toolUses: sprintResult.evaluatorMetrics.toolUses,
      apiRequests: sprintResult.evaluatorMetrics.apiRequests,
      model: sprintResult.evaluatorMetrics.model ?? undefined,
      runtime: sprintResult.evaluatorMetrics.runtime ?? undefined,
      completedAt: new Date().toISOString(),
      metadata: {
        sprintIndex,
        sprintName: sprint.name,
        ...(sprintResult.evaluatorMetrics.provider !== undefined && {
          provider: sprintResult.evaluatorMetrics.provider,
        }),
        ...(sprintResult.evaluatorMetrics.costEstimationKind !== undefined && {
          costEstimationKind: sprintResult.evaluatorMetrics.costEstimationKind,
        }),
        ...(sprintResult.evaluatorMetrics.costStatus !== undefined && {
          costStatus: sprintResult.evaluatorMetrics.costStatus,
        }),
        ...(sprintResult.evaluatorMetrics.tokenStatus !== undefined && {
          tokenStatus: sprintResult.evaluatorMetrics.tokenStatus,
        }),
        ...(sprintResult.evaluatorMetrics.costUnknownReason !== undefined && {
          costUnknownReason: sprintResult.evaluatorMetrics.costUnknownReason,
        }),
        ...(sprintResult.evaluatorMetrics.sessionIds !== undefined &&
          sprintResult.evaluatorMetrics.sessionIds.length > 0 && {
            sessionIds: sprintResult.evaluatorMetrics.sessionIds,
          }),
        ...(sprintResult.evaluatorMetrics.costSource !== undefined && {
          costSource: sprintResult.evaluatorMetrics.costSource,
        }),
        ...(sprintResult.evaluatorMetrics.pricingSnapshot !== undefined && {
          pricingSnapshot: sprintResult.evaluatorMetrics.pricingSnapshot,
        }),
        ...(sprintResult.evaluatorMetrics.modelUsage !== undefined && {
          modelUsage: sprintResult.evaluatorMetrics.modelUsage,
        }),
        ...(sprintResult.evaluatorMetrics.grok !== undefined && {
          grok: sprintResult.evaluatorMetrics.grok,
        }),
      },
      unknownCostCount: sprintResult.evaluatorMetrics.unknownCostCount ?? 0,
    });

    emitIPC('pipeline:sprint-complete', {
      projectId,
      sprintIndex,
      sprintName: sprint.name,
      verdict: sprintResult.verdict,
      rounds: sprintResult.rounds,
      metrics: sprintResult.metrics,
    });

    logger.info(
      { projectId, sprintIndex, verdict: sprintResult.verdict, rounds: sprintResult.rounds },
      'runSprint: coder+evaluator loop done — advancing to next sprint or completing pipeline',
    );

    const allSprints = getHarnessSprints(projectId);
    const nextSprintIndex = sprintIndex + 1;

    if (nextSprintIndex < allSprints.length) {
      this.updateProjectColumns(projectId, { pipelineSprintIndex: nextSprintIndex });
      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: coderPhase,
        phaseName: coderPhaseName,
        status: 'next-sprint',
        awaitingUser: false,
        metadata: { sprintIndex: nextSprintIndex, sprintName: allSprints[nextSprintIndex]?.name },
      });
      await this.runSprint(projectId, nextSprintIndex);
    } else {
      this.completePipeline(projectId, state, {
        terminalStatusString: 'pipeline-completed',
        setStateIdle: true,
        metadata: { totalSprints: allSprints.length },
        onCompleted:
          project.pipelineType === 'security'
            ? () => {
                void this.runResolutionTracker(projectId, project).catch((err) => {
                  logger.error({ err, projectId }, 'Resolution Tracker failed (non-fatal)');
                });
              }
            : undefined,
      });
    }
  }

  async acceptSprint(projectId: string, sprintIndex: number): Promise<void> {
    const state = this.getState(projectId);

    if (state.status === 'aborted') {
      logger.warn({ projectId, sprintIndex }, 'acceptSprint: pipeline aborted');
      return;
    }

    const sprints = getHarnessSprints(projectId);
    if (sprintIndex < 0 || sprintIndex >= sprints.length) {
      throw new Error(`Sprint index ${sprintIndex} out of range (project has ${sprints.length} sprints)`);
    }

    const sprint = sprints[sprintIndex];
    logger.info(
      { projectId, sprintIndex, sprintName: sprint.name },
      'acceptSprint: user accepted sprint with restrictions',
    );

    updateHarnessSprint(sprint.id, { status: 'passed', completedAt: new Date().toISOString() });

    emitIPC('pipeline:sprint-complete', {
      projectId,
      sprintIndex,
      sprintName: sprint.name,
      verdict: 'accepted-with-restrictions',
      rounds: sprint.roundsUsed ?? 0,
      metrics: {},
    });

    const acceptProject = getHarnessProject(projectId);
    const acceptCoderPhase = (acceptProject ? getPhaseNumberForAgent(acceptProject, 'harness-coder') : undefined) ?? 13;
    const acceptCoderName =
      (acceptProject ? getPhaseName(acceptCoderPhase, acceptProject) : PHASE_NAMES[13]) ?? `Phase ${acceptCoderPhase}`;

    const nextSprintIndex = sprintIndex + 1;
    if (nextSprintIndex < sprints.length) {
      this.updateProjectColumns(projectId, { pipelineSprintIndex: nextSprintIndex, status: 'running' });
      state.status = 'running';
      state.abortController = new AbortController();
      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: acceptCoderPhase,
        phaseName: acceptCoderName,
        status: 'next-sprint',
        awaitingUser: false,
        metadata: { sprintIndex: nextSprintIndex, sprintName: sprints[nextSprintIndex]?.name },
      });
      await this.runSprint(projectId, nextSprintIndex);
    } else {
      this.completePipeline(projectId, state, {
        terminalStatusString: 'pipeline-completed',
        setStateIdle: true,
        metadata: { totalSprints: sprints.length },
        onCompleted:
          acceptProject?.pipelineType === 'security'
            ? () => {
                void this.runResolutionTracker(projectId, acceptProject).catch((err) => {
                  logger.error({ err, projectId }, 'Resolution Tracker failed (non-fatal)');
                });
              }
            : undefined,
      });
    }
  }

  async rejectSprint(projectId: string, sprintIndex: number): Promise<void> {
    const state = this.getState(projectId);

    if (state.status === 'aborted') {
      logger.warn({ projectId, sprintIndex }, 'rejectSprint: pipeline aborted');
      return;
    }

    const sprints = getHarnessSprints(projectId);
    if (sprintIndex < 0 || sprintIndex >= sprints.length) {
      throw new Error(`Sprint index ${sprintIndex} out of range (project has ${sprints.length} sprints)`);
    }

    const sprint = sprints[sprintIndex];
    logger.info({ projectId, sprintIndex, sprintName: sprint.name }, 'rejectSprint: user rejected sprint — retrying');

    const rejectProject = getHarnessProject(projectId);
    const rejectCoderPhase = (rejectProject ? getPhaseNumberForAgent(rejectProject, 'harness-coder') : undefined) ?? 13;
    const rejectCoderName =
      (rejectProject ? getPhaseName(rejectCoderPhase, rejectProject) : PHASE_NAMES[13]) ?? `Phase ${rejectCoderPhase}`;

    updateHarnessSprint(sprint.id, { status: 'pending', completedAt: null });

    state.status = 'running';
    state.abortController = new AbortController();
    this.updateProjectColumns(projectId, {
      pipelineCurrentPhase: rejectCoderPhase,
      pipelineSprintIndex: sprintIndex,
      status: 'running',
    });

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: rejectCoderPhase,
      phaseName: rejectCoderName,
      status: 'running',
      awaitingUser: false,
      metadata: { sprintIndex, sprintName: sprint.name, retrying: true },
    });

    await this.runSprint(projectId, sprintIndex);
  }

  getPipelineReport(projectId: string): PipelineMetrics {
    return getPipelineMetrics(projectId);
  }

  async resetPhase(projectId: string, phase: number): Promise<{ ok: boolean; error?: string }> {
    return resetPhaseModule(this.buildResetEngineContext(), projectId, phase);
  }

  private buildResetEngineContext(): ResetEngineContext {
    return {
      getState: (projectId) => this.getState(projectId),
      updateProjectColumns: (projectId, columns) =>
        this.updateProjectColumns(projectId, columns as Parameters<typeof this.updateProjectColumns>[1]),
      runAutoPhase: (projectId, phase) => this.runAutoPhase(projectId, phase),
      runSprint: (projectId, sprintIndex) => this.runSprint(projectId, sprintIndex),
    };
  }

  private buildLifecycleEngineContext(): LifecycleEngineContext {
    return {
      getState: (projectId) => this.getState(projectId),
      updateProjectColumns: (projectId, columns) =>
        this.updateProjectColumns(projectId, columns as Parameters<typeof this.updateProjectColumns>[1]),
      closeCodexSessions: (state) => this.closeCodexSessions(state as PhaseState),
      isConversationPhase: (phase, project) => this.isConversationPhase(phase, project),
      resolveCurrentModelForPhase: (project, phaseNumber, sprintIndex) =>
        this.resolveCurrentModelForPhase(
          project as NonNullable<ReturnType<typeof getHarnessProject>>,
          phaseNumber,
          sprintIndex,
        ),
      getConversationGreeting: (phase, projectName, project) =>
        this.getConversationGreeting(phase, projectName, project),
      runAutoPhase: (projectId, phase) => this.runAutoPhase(projectId, phase),
      runSprint: (projectId, sprintIndex) => this.runSprint(projectId, sprintIndex),
      sendMessage: (projectId, message, opts) => this.sendMessage(projectId, message, undefined, opts),
      abortHarness: (projectId) => this.harnessEngine.abort(projectId),
    };
  }

  private buildPipelineEngineContext(): PipelineEngineContext {
    return {
      sendMessage: (projectId, message, opts) => this.sendMessage(projectId, message, undefined, opts),
      spawnAgent: (agentId, rawPrompt, opts) => this.spawnAgent(agentId, rawPrompt, opts),
      collectMetrics: (projectId, phaseNumber, agentId, result, status, projectCtx) =>
        this.collectMetrics(projectId, phaseNumber, agentId, result, status, projectCtx),
      accumulateMetrics: (state, phaseNumber, result) =>
        this.accumulateMetrics(state as PhaseState, phaseNumber, result),
      getState: (projectId) => this.getState(projectId),
      createEmptyMetrics: () => this.createEmptyMetrics(),
      mergeMetrics: (accum, result) => this.mergeMetrics(accum, result),
      failPhase: (projectId, state, opts) => this.failPhase(projectId, state as PhaseState, opts),
      advanceToNextPhase: (projectId, state) => this.advanceToNextPhase(projectId, state as PhaseState),
      buildPriorMessagesForPhase: (projectId, phaseNumber) => this.buildPriorMessagesForPhase(projectId, phaseNumber),
      makeConversationOnText: (projectId, phase, accumulatedRef) =>
        this.makeConversationOnText(projectId, phase, accumulatedRef),
      updateProjectColumns: (projectId, columns) =>
        this.updateProjectColumns(projectId, columns as Parameters<typeof this.updateProjectColumns>[1]),
      flushAccumulatedMetrics: (projectId, phaseNumber, agentId, state, status, projectCtx, includePersisted) =>
        this.flushAccumulatedMetrics(
          projectId,
          phaseNumber,
          agentId,
          state as PhaseState,
          status,
          projectCtx,
          includePersisted,
        ),
      buildDesignLockPathsBlock: (project) => this.buildDesignLockPathsBlock(project),
      runPhase11WithBriefing: (projectId, state, briefing) =>
        this.runPhase11WithBriefing(projectId, state as PhaseState, briefing),
      handleDevV2Phase12SpecReview: (projectId, message, state) =>
        this.handleDevV2Phase12SpecReview(projectId, message, state as PhaseState),
      harnessEngine: this.harnessEngine,
      createSecurityAuditRunner: () => new SecurityAuditRunner(this),
      createBugAnalysisRunner: () => new BugAnalysisRunner(this),
      PHASE_COMPLETE_MARKER: this.PHASE_COMPLETE_MARKER,
    };
  }

  private completePipeline(projectId: string, state: PhaseState, opts: CompletePipelineOptions): void {
    completePipelineModule(this.buildLifecycleEngineContext(), projectId, state, opts);
  }

  private failPhase(projectId: string, state: PhaseState, opts: FailPhaseOptions): void {
    failPhaseModule(this.buildLifecycleEngineContext(), projectId, state, opts);
  }

  async resetSprint(projectId: string, sprintIndex: number): Promise<{ ok: boolean; error?: string }> {
    return resetSprintModule(this.buildResetEngineContext(), projectId, sprintIndex);
  }

  getResetPreview(projectId: string, target: { phase?: number; sprintIndex?: number }): ResetPreview {
    return getResetPreviewModule(this.buildResetEngineContext(), projectId, target);
  }

  private async runDevV2AutoPhase(
    projectId: string,
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
    phaseNumber: number,
    state: PhaseState,
  ): Promise<void> {
    if (phaseNumber === 2) {
      const briefing = getDevV2Briefing(PRD_GENERATOR_ID);
      await this.runPhase2WithBriefing(projectId, project.projectPath, state, briefing);
    } else if (phaseNumber === 4) {
      await this.runDevV2Phase4DesignPlan(projectId, project, state);
    } else if (phaseNumber === 6) {
      await this.runDevV2Phase6DesignLock(projectId, state);
    } else if (phaseNumber === 7) {
      await this.runDevV2Phase7PrdCompleto(projectId, project, state);
    } else if (phaseNumber === 12) {
      await this.runDevV2Phase12SpecGeneration(projectId, project, state);
    } else if (phaseNumber === 14) {
      await this.runDevV2Phase14Planner(projectId, project, state);
    } else {
      throw new Error(`Unknown development-v2 auto phase: ${phaseNumber}`);
    }
  }

  private async runPhase2WithBriefing(
    projectId: string,
    projectPath: string,
    state: PhaseState,
    briefing: string | null,
  ): Promise<void> {
    await runPhase2WithBriefingModule(this.buildPipelineEngineContext(), projectId, projectPath, state, briefing);
  }

  private async runDevV2Phase4DesignPlan(
    projectId: string,
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
    state: PhaseState,
  ): Promise<void> {
    await runDevV2Phase4DesignPlanModule(this.buildPipelineEngineContext(), projectId, project, state);
  }

  private buildDesignLockPathsBlock(project: NonNullable<ReturnType<typeof getHarnessProject>>): string | null {
    return buildDesignLockPathsBlockHelper({
      id: project.id,
      projectPath: project.projectPath,
      pipelineType: project.pipelineType,
      pipelineDocsId: project.pipelineDocsId ?? null,
      config: project.config,
    });
  }

  private async runDevV2Phase6DesignLock(projectId: string, state: PhaseState): Promise<void> {
    await runDevV2Phase6DesignLockModule(this.buildPipelineEngineContext(), projectId, state);
  }

  private async runDevV2Phase7PrdCompleto(
    projectId: string,
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
    state: PhaseState,
  ): Promise<void> {
    await runDevV2Phase7PrdCompletoModule(this.buildPipelineEngineContext(), projectId, project, state);
  }

  private async runDevV2Phase12SpecGeneration(
    projectId: string,
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
    state: PhaseState,
  ): Promise<void> {
    await runDevV2Phase12SpecGenerationModule(this.buildPipelineEngineContext(), projectId, project, state);
  }

  private async handleDevV2Phase12SpecReview(projectId: string, message: string, state: PhaseState): Promise<void> {
    await handleDevV2Phase12SpecReviewModule(this.buildPipelineEngineContext(), projectId, message, state);
  }

  private async runDevV2Phase14Planner(
    projectId: string,
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
    state: PhaseState,
  ): Promise<void> {
    await runDevV2Phase14PlannerModule(this.buildPipelineEngineContext(), projectId, project, state);
  }

  private async handlePhase1MessageDevV2(
    projectId: string,
    message: string,
    state: PhaseState,
    briefing: string | null,
  ): Promise<void> {
    await handlePhase1MessageDevV2Module(this.buildPipelineEngineContext(), projectId, message, state, briefing);
  }

  private async handlePhase3MessageDevV2(
    projectId: string,
    message: string,
    state: PhaseState,
    briefing: string | null,
  ): Promise<void> {
    await handlePhase3MessageDevV2Module(this.buildPipelineEngineContext(), projectId, message, state, briefing);
  }

  private async handleDevV2Phase13SpecEnricher(projectId: string, message: string, state: PhaseState): Promise<void> {
    await handleDevV2Phase13SpecEnricherModule(this.buildPipelineEngineContext(), projectId, message, state);
  }

  private async finalizeDevV2ConversationPhase(
    projectId: string,
    phase: number,
    state: PhaseState,
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
  ): Promise<void> {
    await finalizeDevV2ConversationPhaseModule(this.buildPipelineEngineContext(), projectId, phase, state, project);
  }
}
