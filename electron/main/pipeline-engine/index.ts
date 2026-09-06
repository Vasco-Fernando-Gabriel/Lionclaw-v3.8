/**
 * PipelineEngine — Unified orchestrator for the full product development pipeline.
 *
 * Phase map:
 *  1  = Discovery (conversation)
 *  2  = PRD Generator mode 1 (auto) — generates stories-requisitos.md
 *  3  = PRD Validator (conversation)
 *  4  = PRD Generator mode 2 (auto) — generates PRD.md
 *  5  = Tech: Database (conversation) — tech-database agent discusses DB decisions
 *  6  = Tech: Backend (conversation) — tech-backend agent discusses backend decisions
 *  7  = Tech: Frontend (conversation) — tech-frontend agent discusses frontend decisions
 *  8  = Tech: Security (conversation) — tech-security agent discusses security decisions
 *  9  = Spec Generation (auto) — builder+validator loop generates SPEC.md from PRD.md + stories-requisitos.md
 * 10  = Spec Enricher (conversation)
 * 11  = Planner (auto)
 * 12  = Sprint Validator (conversation)
 * 13  = Coder (loop)
 * 14  = Evaluator (loop)
 */

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
import {
  ensureProjectLock,
} from '../pipeline-shared/lock';
import { PipelinePausedError } from '../agent-runtime/types';
import type { OllamaChatMessage, OllamaToolCallRecord } from '../ollama-client';
import { executeAgent } from '../agent-runtime';
import type { AgentExecutionRequest } from '../agent-runtime/types';
import {
  createSubagentDispatchContext,
  pendingSubagentProviderAuthError,
} from '../agent-runtime/subagent-dispatch';
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
import {
  reseedHarnessSprintsFromFile,
  checkHarnessSprintQueueIntegrity,
} from '../harness-planner';
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
  // 8A.4: DISCOVERY_AGENT_ID / PRD_VALIDATOR_ID / PIPE2_PRD_COMPLETO_ID /
  // PIPE2_SPEC_BUILDER_ID / PIPE2_SPEC_VALIDATOR_ID / PIPE2_SPEC_ENRICHER_ID moved
  // with the dev-v2 handler bodies into handlers/development-v2.ts.
  // 8A.5: RESOLUTION_TRACKER_ID moved to handlers/security.ts;
  // FEAT_PRD_GENERATOR_ID / FEAT_PRD_COMPLETO_ID moved to handlers/dev-feature.ts.
  PIPE2_TECH_FRONTEND_ID,
  // S8: o gate de 2 botoes da fase 3 do Bug Pipe flusha a metrica acumulada do
  // consolidador ANTES de encerrar o pipe (B-AC33 (b)).
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
import {
  getArchitectureReviewContext,
  patchArchitectureReviewManifest,
} from '../architecture-review-paths';
import { getBugContext, patchBugManifest } from '../bug-paths';

const logger = createLogger('pipeline-engine');

/**
 * Returns the model identifier that the agent will actually use at execution
 * time. For codex/local/external runtimes the user-facing `agent.model` field
 * is irrelevant (it's a leftover from when the agent was cloud) — the real
 * model lives in the runtime-specific config block. UI surfaces (badges,
 * footers) should call this so they don't display stale 'opus' / 'sonnet'
 * when a seed agent has been switched to a different runtime.
 */
function resolveModelForAgent(agent: AgentConfig | undefined | null): string | null {
  if (!agent) return null;
  if (agent.runtime === 'codex' && agent.codexConfig?.model) return agent.codexConfig.model;
  if (agent.runtime === 'local' && agent.localConfig?.model) return agent.localConfig.model;
  if (agent.runtime === 'external' && agent.externalConfig?.model) return agent.externalConfig.model;
  return agent.model ?? null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Sprint 5 (SPEC v3 §4.4 / SO-1 end): the 4 *_CONVERSATION_PHASES aliases
// (SECURITY / ARCHITECTURE / DEV / DEV_V2) that lived here are DELETED. They
// were a Sprint 3 bridge kept only because ipc-handlers.ts imported 3 of them;
// now ipc-handlers (and the store) derive conversation phases directly from
// conversationPhasesOf(type) in pipeline.ts (the single source of truth). The
// one remaining in-engine consumer — the auto-phase rejection guard in
// sendMessage — now calls conversationPhasesOf(project.pipelineType) inline
// (byte-identical: each alias WAS conversationPhasesOf(type)).

// Sprint 3 (SPEC v3 §4.2): the per-type AUTO/LOOP/RESETABLE Sets and the
// name/agentId/artifact Records were moved to ./registry. The auto/loop/
// resetable wrappers now delegate to the pure canonical derivations in
// pipeline.ts (single source of truth). The literal Sets are deleted; this
// file imports the dispatch wrappers + the dev-legacy PHASE_NAMES/
// PHASE_AGENT_IDS Records (still referenced directly at fallback call-sites)
// from ./registry.

// ---------------------------------------------------------------------------
// Architecture-review phase 4 — decision validation helpers
// ---------------------------------------------------------------------------

/**
 * Minimo de decisoes "fechadas" pro gate da fase 4 deixar avancar pra SPEC.
 * Veio do prompt do interviewer (heuristica de "cobriu o essencial" >= 3) — mais
 * baixo que isso geralmente indica entrevista atropelada e SPEC pobre adiante.
 */
const ARCHITECTURE_PHASE4_MIN_DECISIONS = 3;

/**
 * Campos obrigatorios em cada secao `## DN`. Labels canonicos vem do prompt
 * do `architecture-decision-interviewer`. Sinonimos abaixo sao tolerantes
 * (variantes acentuadas + traducoes mais comuns) pra evitar false-fail quando
 * o agente diverge ligeiramente do template.
 */
type DecisionField = 'pergunta' | 'decisao' | 'razao' | 'implica';

const DECISION_FIELD_LABEL: Record<DecisionField, string> = {
  pergunta: 'Pergunta',
  decisao:  'Decisao',
  razao:    'Razao',
  implica:  'Implica',
};

const DECISION_FIELD_PATTERNS: Record<DecisionField, RegExp> = {
  // **Pergunta:** ...  /  Pergunta: ...  /  - **Questao:** ... / Question: ...
  pergunta: /^[\s>*-]*\**\s*(?:Pergunta|Questa(?:o|ão)|Question|Quest(?:a|ã)o)\s*:\s*\**\s*\S/im,
  // Decisao / Decisão / Decision / Escolha
  decisao:  /^[\s>*-]*\**\s*(?:Decis(?:a|ã)o|Decision|Escolha|Choice)\s*:\s*\**\s*\S/im,
  // Razao / Razão / Motivo / Justificativa / Reason / Rationale
  razao:    /^[\s>*-]*\**\s*(?:Raz(?:a|ã)o|Motivo|Justificativa|Reason|Rationale)\s*:\s*\**\s*\S/im,
  // Implica / Implicacao / Implicação / Implies / Implication
  implica:  /^[\s>*-]*\**\s*(?:Implica(?:c(?:a|ã)o|tion)?s?|Implies|Consequencia|Consequência)s?\s*:\s*\**\s*\S/im,
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

/**
 * Le decisions.md e devolve {count, gaps}. Gap = decisao com pelo menos 1
 * campo obrigatorio ausente. Caller decide o que fazer com isso (gate).
 *
 * Regex de header: `^##\s*D<N>\s*[—\-:]?\s*<titulo>$` — mesma do
 * `parseDecisionsMd` no renderer (ArchitectureReviewArtifactView).
 */
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

// ---------------------------------------------------------------------------
// Dynamic phase resolution helpers
// ---------------------------------------------------------------------------

/**
 * Returns the phase definitions array for the given project.
 * Security projects use SECURITY_PIPELINE_PHASES; feature projects use FEATURE_PIPELINE_PHASES;
 * architecture-review projects use ARCHITECTURE_REVIEW_PIPELINE_PHASES;
 * development-v2 projects use DEVELOPMENT_V2_PIPELINE_PHASES;
 * all others use PIPELINE_PHASES.
 */
// Sprint 3 (SPEC v3 §4.2): getPhasesForProject / getAutoPhases / getLoopPhases /
// getResetablePhases moved to ./registry (wrappers now delegate to the pure
// canonical derivations in pipeline.ts). Imported back at the top of this file.

/**
 * Returns true if the project has destructive-unlock capability available.
 * Only meaningful for development-v2 after Design Lock.
 * UI and handler logic for this escape hatch is implemented in Sprint 5.
 */
export function canDestructiveUnlock(
  project: { pipelineType?: string; config?: { openDesign?: { locked?: boolean } } },
): boolean {
  return project.pipelineType === 'development-v2' && project.config?.openDesign?.locked === true;
}

// Sub-phase 8C.1 (SPEC v3 §4.9): getArchitectureReviewConversationGreeting moved
// verbatim to ./greetings. Re-exported here so phase-helpers.ts (which re-exports
// it from './index') stays unchanged (INV-17).
export { getArchitectureReviewConversationGreeting };

// Sprint 3 (SPEC v3 §4.2): getPhaseName / getPhaseNumberForAgent /
// getPhaseAgentId / getPhaseArtifactMap / getMaxPhase and the dev-legacy
// PHASE_ARTIFACT_MAP / PHASE_NAMES / PHASE_AGENT_IDS Records moved to ./registry.
// getPhaseAgentId and getPhaseNumberForAgent stay re-exported from this module
// (phase-helpers.ts re-exports them from './index'; T-1 / INV-17: both keep
// their OBJECT-FIRST signatures). They are imported from ./registry at the top
// of this file (used internally) and re-exported here for phase-helpers.ts.
export { getPhaseAgentId, getPhaseNumberForAgent };

/** Template for discovery-notes.md created at pipeline start. */
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Session state for continue:true phases. */
interface ContinueSessionState {
  /** Whether the SDK session is still alive (continue:true). */
  alive: boolean;
}

/** Internal state for a single project's pipeline execution. */
interface PhaseState {
  projectId: string;
  currentPhase: number;
  status: 'idle' | 'running' | 'paused' | 'aborted';
  abortController: AbortController;
  /** @deprecated Phase 1 blocks removed — kept for compat. */
  discoveryBlock: number;
  /** Conversation phases: SDK session continuity within the phase. */
  continueSessions: Map<string, ContinueSessionState>;
  /**
   * Codex runtime: live CodexSession handles keyed by `${agentId}:${phaseNumber}`.
   * Enables multi-turn continuation within the same phase (D2 in SPEC). Sessions
   * are closed and cleared on phase transition, abort, pause, and reset.
   * Pipeline-engine owns the lifecycle; codex-executor does not close these.
   */
  codexSessions: Map<string, CodexSession>;
  /**
   * Accumulated metrics per phase for incremental saving.
   *
   * SPEC-006 P1: tambem carrega campos de identidade do provider e flags de
   * estimativa/status que precisam chegar em `pipeline_phase_metrics.metadata`
   * via `flushAccumulatedMetrics`. Sem isso, fases conversacionais com follow-ups
   * (~20 callsites de `accumulateMetrics`) perdem o rotulo PAYG e a contagem de
   * `unknownCostCount`.
   *
   * `unknownRoundCount`: numero de rounds dentro da fase em que `costStatus` foi
   * `'unknown'`. Persistido como `unknownCostCount` no save. Permite a UI somar
   * fases parcialmente desconhecidas em totais.
   *
   * `tokenStatus` / `costStatus` / `costUnknownReason` no accumulator refletem o
   * "pior" estado entre todos os rounds: se algum marcar `unknown`/`not_reported`,
   * a fase agregada herda o pior sinal (conservador).
   */
  // 8C.2: tipo do accumulator movido para metrics.ts (AccumulatedMetrics).
  // Estruturalmente identico ao shape inline anterior (SpawnAgentResult['metrics']
  // & { model, runtime, provider?, costEstimationKind?, unknownRoundCount }).
  phaseMetricAccum: Map<number, AccumulatedMetrics>;
  /** Phases 13-14: current sprint being executed (0-based index). */
  currentSprintIndex: number;
  conversationAuthResume?: {
    phase: number;
    provider: 'codex' | 'grok' | 'kimi';
    message: string;
    finalMessage: string;
    isGreeting: boolean;
  };
}

/** Normalized result from spawnAgent(). */
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
    // SPEC-005: optional cost/token status fields from AgentExecutionResult.metrics
    costStatus?: 'known' | 'unknown' | 'estimated-partial';
    tokenStatus?: 'reported' | 'not_reported';
    costUnknownReason?: 'unknown-pricing' | 'no-usage-reported';
  };
  model: string;
  runtime: AgentConfig['runtime'];
  provider: string;
  /**
   * Per-turn tool call records (only populated for external runtime).
   * Used to persist full tool history (input + output) so subsequent turns
   * can rehydrate the conversation faithfully. Cloud SDK manages its own
   * session via continueSession and does not populate this field.
   */
  toolCalls?: OllamaToolCallRecord[];
  /**
   * Espelhamento de `AgentExecutionResult.metadata` (campo opcional aditivo).
   * Permite propagar sinais runtime-specific do executor para `collectMetrics`,
   * em particular `costEstimationKind` da SPEC-006 (subscription runtimes como
   * MiniMax TokenPlan). NAO mistura com `codex` que ja existe no namespace de
   * `AgentExecutionResult.metadata`; aceita ambos opcionalmente.
   */
  metadata?: {
    codex?: {
      applyPatchFailures?: number;
      applyPatchFailureSamples?: Array<{ source: string; text: string; ts: number }>;
    };
    costEstimationKind?: 'subscription-equivalent-payg';
  };
}

/** Options passed to spawnAgent(). */
interface SpawnAgentOptions {
  projectId: string;
  phaseNumber: number;
  cwd: string;
  abortController: AbortController;
  onText?: (chunk: string) => void;
  onToolUse?: (toolName: string) => void;
  onToolUseComplete?: (toolName: string, input: unknown) => void;
  /** When true, uses continue:true for same-session follow-up turns. */
  continueSession?: boolean;
  /**
   * For external runtime (HTTP stateless): explicit prior conversation history
   * to inject between system prompt and current user prompt. Cloud SDK ignores
   * this and uses continueSession instead. Local runtime currently ignores it.
   */
  priorMessages?: OllamaChatMessage[];
  /**
   * Optional docs directory (from PipelineDocsContext) to inject into the
   * PROJECT ROOT prompt block so agents know where to write pipeline documents.
   */
  docsDir?: string;
  /**
   * When true, the prompt is passed verbatim without prepending PROJECT ROOT
   * boilerplate. Useful for agents whose prompt template already contains
   * filesystem context (e.g. audit agents via buildAuditPrompt).
   */
  skipProjectRootInjection?: boolean;
  /**
   * SC-1 (SPEC robustez-chat, Pilar C): callback que reconstroi o prompt de
   * retomada COMPLETO quando a CodexSession cacheada de um follow-up
   * conversacional morreu (idle-reaper) e o turno vai ser retentado UMA vez com
   * sessao nova. Retorna o prompt CRU (pre-`withProjectRoot`) contendo o
   * preambulo do first-turn da fase + historico da fase + a msg do usuario
   * (o codex-executor consome APENAS `req.prompt` e ignora `priorMessages`).
   * Handler que NAO passa o callback nao tem retry (fail-closed).
   */
  rebuildPromptOnRetry?: () => string;
}

// ---------------------------------------------------------------------------
// Pipeline-column writes (INV-13 / BUG-21)
//
// The raw `UPDATE harness_projects SET ...` now lives in db.ts
// (`updateHarnessProjectPipelineColumns`), so pipeline-engine carries ZERO
// inline SQL. `updateProjectColumns` (below) is the single class entry point:
// it calls that db.ts helper then emits `pipeline:project-updated` so the
// renderer stays in sync. Engine code must never call the db helper directly.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Concurrency: project lock per-project (S4.2 — Onda 4)
//
// O mutex global `_activeLoopProjectId` foi DELETADO. A regra atual e:
//   - 2 pipelines em projetos diferentes: rodam em paralelo livremente
//   - 2 pipelines no MESMO projeto: o segundo bate em `acquireProjectLock`
//     e recebe falha imediata
// Adquire/libera via helpers em `pipeline-shared/lock.ts` (R7 + D4 da SPEC).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PipelineEngine
// ---------------------------------------------------------------------------

export class PipelineEngine {
  private states: Map<string, PhaseState> = new Map();

  /** HarnessEngine instance reused for phase 11 (Planner). */
  private harnessEngine: HarnessEngine;

  constructor(_getWindow: () => BrowserWindow | null, harnessEngine: HarnessEngine) {
    this.harnessEngine = harnessEngine;
    this.recoverInterruptedPipelines();
  }

  // -------------------------------------------------------------------------
  // Project column updater (BUG-21)
  // -------------------------------------------------------------------------

  /**
   * Writes `columns` to harness_projects and emits `pipeline:project-updated`
   * so the renderer can patch its in-memory `PipelineProject` and keep the
   * status / currentPhase fields in sync.
   *
   * This is the single entry-point every phase/sprint handler must use to
   * mutate the project row. Direct calls to `updateHarnessProjectPipelineColumns`
   * from within PipelineEngine are forbidden: they would silently desync the
   * UI and reintroduce BUG-21 (duplicate "Pausado" + "Processando" badges).
   */
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

  // -------------------------------------------------------------------------
  // Phase complete detection
  // -------------------------------------------------------------------------

  private readonly PHASE_COMPLETE_MARKER = '[PHASE_COMPLETE]';

  /**
   * Returns an onText callback that strips [PHASE_COMPLETE] from streamed text,
   * emits pipeline:agent-completed when the marker is found, and forwards
   * cleaned text to the stream IPC channel.
   */
  /**
   * Wraps a task prompt with explicit PROJECT ROOT context. External runtime
   * agents (OpenRouter / openai-compatible) do not have implicit cwd awareness
   * like the Claude SDK and may hallucinate paths to other projects on the
   * filesystem. The Cloud SDK follows enriched prompts gracefully so the same
   * wrapping is safe to apply uniformly.
   *
   * Used together with the path sandbox in local-tool-executor.ts that rejects
   * Read/Write/Edit/Glob/Grep targeting paths outside cwd.
   */
  private withProjectRoot(projectPath: string, taskPrompt: string, docsDir?: string): string {
    return (
      `## PROJECT ROOT (raiz absoluta do projeto onde voce deve operar)\n` +
      `${projectPath}\n\n` +
      (docsDir
        ? `## DOCS DIR (onde voce DEVE gravar todos os documentos desta execucao)\n${docsDir}\n\n`
        : '') +
      `## REGRAS CRITICAS DE FILESYSTEM\n` +
      `- TODOS os paths em Read, Write, Edit, Glob e Grep DEVEM ser absolutos comecando com PROJECT ROOT acima.\n` +
      (docsDir
        ? `- TODA gravacao de documento (PRD, SPEC, stories, etc) DEVE ir para DOCS DIR acima.\n`
        : '') +
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
    // 8B: corpo movido para stream.ts (makeConversationOnText free fn). O metodo
    // permanece na classe (exposto via ctx). O side-effect de conclusao
    // (pipeline:agent-completed + log) e injetado para preservar comportamento.
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

  // -------------------------------------------------------------------------
  // State helpers
  // -------------------------------------------------------------------------

  private getState(projectId: string): PhaseState {
    if (!this.states.has(projectId)) {
      // Rehydrate from DB on cold start (e.g. after app restart). If the DB has
      // a persisted pipeline_current_phase, we restore it in-memory so that
      // approvePhase / sendMessage can correctly route to the right phase
      // handler even when the Electron main process was just restarted.
      //
      // NOTE: continueSessions (SDK session continuity) cannot be rehydrated,
      // so any ongoing conversation starts a fresh SDK session on the next
      // user message. approvePhase does not depend on continueSessions.
      let persistedPhase = 0;
      let persistedStatus: PhaseState['status'] = 'idle';
      let persistedSprintIndex = 0;
      try {
        const project = getHarnessProject(projectId);
        if (project) {
          persistedPhase = project.pipelineCurrentPhase ?? 0;
          // Map DB status to in-memory status. DB 'running' becomes in-memory
          // 'paused' because the main process was just restarted and nothing
          // is actually executing. 'done'/'failed' collapse to 'idle'.
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
    // Sprint 4 (SPEC §4.6): derived from the message-router module. This is the
    // PURE `!auto && !loop` predicate WITHOUT the conversation-over-auto
    // overrides — it drives the `awaitingUser` flag of pipeline:phase-changed
    // and the greeting auto-send, and must stay byte-identical to the old inline
    // computation. The routing TABLE (resolveConversationDescriptor) separately
    // includes the override phases (dev-9/feature-9/dev-v2-12) so a manual
    // message on them routes; the two notions are intentionally distinct.
    return isPureConversationPhase(phase, project);
  }

  /**
   * Sprint 4 (SPEC §4.6, descriptor `resolveAgentId`): the EXACT tech-phase agent
   * id the old sendMessage / handleDevV2Message dispatch used, kept here so the
   * id mapping is provably identical to the original literals (not re-derived).
   *  - dev/feature phases 5-8: isFeature ? FEAT_TECH_* : TECH_*
   *  - dev-v2 phases 8-11: TECH_DATABASE_ID / TECH_BACKEND_ID /
   *    PIPE2_TECH_FRONTEND_ID / TECH_SECURITY_ID
   */
  private resolveTechAgentIdForMessage(
    project: { pipelineType?: string } | undefined,
    phase: number,
  ): string {
    if (project?.pipelineType === 'development-v2') {
      switch (phase) {
        case 8: return TECH_DATABASE_ID;
        case 9: return TECH_BACKEND_ID;
        case 10: return PIPE2_TECH_FRONTEND_ID;
        case 11: return TECH_SECURITY_ID;
        default: return getPhaseAgentId(phase, project) ?? '';
      }
    }
    const isFeature = project?.pipelineType === 'feature';
    switch (phase) {
      case 5: return isFeature ? FEAT_TECH_DATABASE_ID : TECH_DATABASE_ID;
      case 6: return isFeature ? FEAT_TECH_BACKEND_ID : TECH_BACKEND_ID;
      case 7: return isFeature ? FEAT_TECH_FRONTEND_ID : TECH_FRONTEND_ID;
      case 8: return isFeature ? FEAT_TECH_SECURITY_ID : TECH_SECURITY_ID;
      default: return getPhaseAgentId(phase, project ?? {}) ?? '';
    }
  }

  /**
   * Sprint 4 (SPEC §4.6 / INV-16 / RK-6): build the `MessageRouterEngine` view
   * the router dispatches through. Each method is bound to `this` AT CALL TIME
   * (this helper runs inside `sendMessage`, after any test has replaced an
   * instance method), so late binding is preserved and spies on, e.g.,
   * `handleDevV2Phase12SpecReview` are observed. The handlers stay methods of
   * this class — the router never holds a free function nor a stale reference.
   * Referencing each `this.handleX` here also keeps them "used" for the compiler.
   */
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

  // -------------------------------------------------------------------------
  // Crash recovery: on boot, mark any 'running' pipelines as 'interrupted'
  // -------------------------------------------------------------------------

  private recoverInterruptedPipelines(): void {
    // Sprint 7 (SPEC §4.5): boot recovery moved to lifecycle.ts (verbatim).
    recoverInterruptedPipelinesModule();
  }

  // -------------------------------------------------------------------------
  // Public API: startPipeline
  // -------------------------------------------------------------------------

  async startPipeline(projectId: string, startPhase: number): Promise<{ error: string } | void> {
    const existingState = this.states.get(projectId);
    if (existingState && existingState.status === 'running') {
      logger.warn({ projectId }, 'startPipeline: pipeline ja esta rodando para este projeto, ignorando');
      return { error: 'Pipeline ja esta rodando para este projeto' };
    }

    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    // Lazy migration: feature/security projects without pipelineDocsId gain a new ID
    // and their legacy root-level docs are moved into docs/Docs<id>/
    if (
      (project.pipelineType === 'feature' || project.pipelineType === 'security') &&
      !project.pipelineDocsId
    ) {
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

    // If starting from phase 1, create discovery-notes.md template
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

    // Persist phase pointers
    this.updateProjectColumns(projectId, {
      pipelineStartPhase: startPhase,
      pipelineCurrentPhase: startPhase,
      status: 'running',
    });

    // Emit phase-changed for the first phase
    const firstPhaseIsConversation = this.isConversationPhase(startPhase, project);
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: startPhase,
      phaseName: getPhaseName(startPhase, project) ?? `Phase ${startPhase}`,
      status: 'started',
      awaitingUser: firstPhaseIsConversation,
      currentModel: this.resolveCurrentModelForPhase(project, startPhase),
    });

    // Auto phases start immediately; conversation phases auto-send greeting
    if (getAutoPhases(project).has(startPhase)) {
      await this.runAutoPhase(projectId, startPhase);
    } else if (firstPhaseIsConversation) {
      // Auto-trigger the first AI message so the agent starts the conversation
      // (e.g. Discovery asks questions, Spec Validator starts analysis, etc.)
      const greetingMsg = this.getConversationGreeting(startPhase, project.name, project);
      await this.sendMessage(projectId, greetingMsg, undefined, { isGreeting: true });
    }
    // Loop phases require explicit advancePhase call in normal flow
  }

  /**
   * Returns an initial user-side message to kick off a conversation phase.
   * The agent will then respond with its questions / analysis.
   * Accepts an optional project to handle security pipeline phases.
   */
  private getConversationGreeting(phase: number, projectName: string, project?: { pipelineType?: string; projectPath?: string; pipelineDocsId?: string | null }): string {
    // Sub-phase 8C.1 (SPEC v3 §4.9): body moved verbatim to ./greetings. Stays a
    // method (delegator) so internal callers, the lifecycle ctx bridge and any
    // spies see the same surface (INV-16).
    return getConversationGreetingModule(phase, projectName, project);
  }

  // -------------------------------------------------------------------------
  // Public API: advancePhase
  // -------------------------------------------------------------------------

  async advancePhase(projectId: string): Promise<void> {
    // Sprint 7 (SPEC §4.5): advance core moved to lifecycle.ts (verbatim; the
    // terminal branch routes through completePipeline with 'completed'). Stays a
    // delegator so callers/spies see the same method (AC-9).
    return advancePhaseModule(this.buildLifecycleEngineContext(), projectId);
  }

  // -------------------------------------------------------------------------
  // Public API: abortPipeline
  // -------------------------------------------------------------------------

  abortPipeline(projectId: string): void {
    // Sprint 7 (SPEC §4.5): moved to lifecycle.ts (verbatim). Delegator (AC-9).
    abortPipelineModule(this.buildLifecycleEngineContext(), projectId);
  }

  // -------------------------------------------------------------------------
  // Public API: pausePipeline
  // -------------------------------------------------------------------------

  pausePipeline(projectId: string): void {
    // Sprint 7 (SPEC §4.5): moved to lifecycle.ts (verbatim). Delegator (AC-9).
    pausePipelineModule(this.buildLifecycleEngineContext(), projectId);
  }

  /** Auth fail-closed: pausa todos os pipelines ativos sem perder journal/artefatos. */
  pauseAllForAuthorizationLoss(): number {
    let paused = 0;
    for (const [projectId, state] of this.states) {
      if (state.status !== 'running') continue;
      this.pausePipeline(projectId);
      paused += 1;
    }
    return paused;
  }

  // -------------------------------------------------------------------------
  // Public API: resumePipeline
  // -------------------------------------------------------------------------

  async resumePipeline(projectId: string): Promise<void> {
    // Sprint 7 (SPEC §4.5): moved to lifecycle.ts (verbatim). Delegator (AC-9).
    return resumePipelineModule(this.buildLifecycleEngineContext(), projectId);
  }

  // -------------------------------------------------------------------------
  // Public API: resumeAfterAuth — called when user re-logs into Codex CLI
  // and wants to continue a paused pipeline that stopped due to CodexAuthError.
  //
  // Flow (SPEC §12.3, §12.4):
  // 1. Verify auth is back via isCodexAvailable().
  // 2. Kill all bridge processes so the next call re-spawns with fresh auth.json.
  // 3. Clear stale codexSessions (they hold dead thread IDs).
  // 4. Delegate to the existing resumePipeline() which handles auto/loop/convo.
  // -------------------------------------------------------------------------

  async resumeAfterAuth(
    projectId: string,
    provider: 'codex' | 'grok' | 'kimi' = 'codex',
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (provider === 'grok' || provider === 'kimi') {
      const status = provider === 'grok'
        ? await (await import('../agent-runtime/grok-availability')).isGrokAvailable()
        : await (await import('../agent-runtime/kimi-availability')).isKimiAvailable();
      if (!status.usable) {
        return {
          ok: false,
          message: status.reason ?? `${provider === 'grok' ? 'Grok Build' : 'Kimi'} ainda nao esta autenticado e validado.`,
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

    const { closeAllCachedChatCodexSessions } = await import('../codex-sdk');
    closeAllCachedChatCodexSessions('resume-after-auth');
    const { closeAllOfficialRuns } = await import('../agent-runtime/codex-session-factory');
    await closeAllOfficialRuns('resume-after-auth');
    // Clear stale codex sessions — thread IDs from the old process are invalid.
    const state = this.getState(projectId);
    this.closeCodexSessions(state);

    // Reset abort controller in case it was aborted when the auth error hit.
    state.abortController = new AbortController();
    state.status = 'paused'; // resumePipeline expects paused

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

  // -------------------------------------------------------------------------
  // Private: spawnAgent — thin wrapper that injects PROJECT ROOT context
  // and delegates to the unified agent-runtime module (executeAgent).
  //
  // All runtime-specific logic (cloud/local/external) lives in:
  //   electron/main/agent-runtime/{cloud,local,external}-executor.ts
  // The watchdog is also centralised there (agent-runtime/watchdog.ts).
  // -------------------------------------------------------------------------

  public async spawnAgent(
    agentId: string,
    rawPrompt: string,
    opts: SpawnAgentOptions,
  ): Promise<SpawnAgentResult> {
    // Inject PROJECT ROOT explicitly so external runtime agents (no implicit cwd)
    // cannot wander outside the project. Skip when caller already embedded
    // filesystem context (e.g. audit agents via buildAuditPrompt).
    const prompt = opts.skipProjectRootInjection
      ? rawPrompt
      : this.withProjectRoot(opts.cwd, rawPrompt, opts.docsDir);

    // Codex session reuse: look up an existing CodexSession for this agent+phase
    // when continueSession=true, so the executor calls reply() instead of send().
    const state = this.states.get(opts.projectId);
    const codexSessionKey = `${agentId}:${opts.phaseNumber}`;
    const existingCodexSession = (opts.continueSession && state)
      ? state.codexSessions.get(codexSessionKey)
      : undefined;

    // NOTE: do NOT close other cached codex sessions here.
    // The security audit pipeline spawns up to 3 codex agents IN PARALLEL via
    // Promise.all. Closing "all other sessions" on each new spawn would race-kill
    // those concurrent siblings mid-execution. Cleanup of stale sessions happens
    // at deterministic transition hooks (closePhaseCodexSessions, advancePhase,
    // sprint round boundaries) — never as a side-effect of spawnAgent.

    // SC-1 (SPEC robustez-chat, Pilar C): flag LOCAL do proprio spawnAgent que
    // limita o retry de sessao Codex ceifada a UMA tentativa (sem recursao, sem
    // contador persistente). O caminho feliz nao a toca.
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
        // S4.3 (Onda 4): propaga projectId pra codex-executor isolar pool por projeto.
        projectId: opts.projectId,
        executionContext,
        onText: opts.onText,
        onToolUse: opts.onToolUse,
        onToolUseComplete: opts.onToolUseComplete,
        // Pass existing session for multi-turn reuse (codex only; ignored by other runtimes).
        codexSession: existingCodexSession,
        // When creating a new session, store it in the phase state for future turns.
        onCodexSessionCreated: state
          ? (session: CodexSession) => {
              state.codexSessions.set(codexSessionKey, session);
              logger.debug(
                { agentId, phaseNumber: opts.phaseNumber, projectId: opts.projectId },
                'spawnAgent: new CodexSession stored for phase',
              );
            }
          : undefined,
        // pipeline:stalled IPC stays here — agent-runtime emits only a generic onStalled callback.
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
        { agentId, phaseNumber: opts.phaseNumber, projectId: opts.projectId, durationMs: result.metrics.durationMs, outputLen: result.output.length, toolUses: result.metrics.toolUses },
        'spawnAgent: completed',
      );

      return result;
    } catch (caughtError) {
      let err: unknown = pendingSubagentProviderAuthError(executionContext) ?? caughtError;
      // -----------------------------------------------------------------------
      // SC-1 (SPEC robustez-chat, Pilar C): recuperacao de sessao Codex ceifada.
      // O idle-reaper mata o app-server ocioso (120s) enquanto uma fase
      // conversacional espera o usuario; o follow-up reusa a CodexSession morta
      // e lanca CodexUnavailableError transiente. Aqui: remove a sessao morta,
      // avisa a UI e retenta UMA vez com sessao nova + prompt de retomada
      // COMPLETO (rebuildPromptOnRetry — o codex-executor ignora priorMessages).
      // Branch ADITIVO: nao dispara sem sessao cacheada + continueSession +
      // callback + mensagem transiente. CodexAuthError/PipelinePausedError e
      // erros nao-transientes caem nos branches pre-existentes abaixo.
      // -----------------------------------------------------------------------
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
          // NOTA (caller-permission-snapshot R8): request montada em variavel
          // de proposito — o snapshot exige exatamente 1 literal de chamada
          // inline de executeAgent neste arquivo (o do caminho feliz acima).
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
            // Sessao NOVA: o executor chama send() (nao reply()) e recacheia via
            // onCodexSessionCreated, igual a um first-turn.
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
          // Fail-closed: o erro do retry cai nos branches pre-existentes abaixo
          // (2o CodexUnavailableError -> pipeline:error + throw; CodexAuthError
          // -> pausa; resto propaga). A flag impede novo retry.
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

      // Codex auth error: pause pipeline and notify frontend with a modal trigger.
      // Do NOT rethrow — the pipeline remains paused, waiting for user to re-login.
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
        // S3 (Onda 3): persist 'paused' via setProjectStatus and throw
        // PipelinePausedError so the calling phase short-circuits cleanly.
        // Replaces the pre-S3 "zeroed sentinel" return that silently
        // hid CodexAuthError from callers and produced bogus zero metrics.
        setProjectStatus(opts.projectId, 'paused');
        if (state) state.status = 'paused';
        throw new PipelinePausedError(
          (err as Error).message || 'Codex auth required',
          'codex-auth',
        );
      }

      // Codex unavailable: emit pipeline:error event and rethrow so the pipeline
      // marks the phase as failed (D8 — no fallback).
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

      // All other errors propagate normally.
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Private: closeCodexSessions — close and clear all live Codex sessions
  // for the given project state. Called on phase transition, abort, pause,
  // and reset so sessions are never leaked across phase boundaries (D2).
  // -------------------------------------------------------------------------

  // 8C.3: corpo movido para codex-sessions.ts (closeCodexSessions free fn). O
  // metodo PERMANECE na classe como delegador fino — e espiado por
  // codex-kill-on-approve.test.ts e consumido pelo ctx de lifecycle.ts (INV-16).
  private closeCodexSessions(state: PhaseState): void {
    closeCodexSessionsModule(state);
  }

  // -------------------------------------------------------------------------
  // Private: hasCodexSessionForPhase — sinal (2) da REGRA MAXIMA.
  // Leitura PURA: responde se ha ao menos uma sessao Codex rastreada para a
  // fase dada no estado do projeto. As chaves do mapa sao `${agentId}:${phase}`,
  // entao casar por sufixo precisa ser robusto a colisao de numero (ex.: a fase
  // 1 nao pode casar com a chave `x:11`). Casa pelo segmento numerico apos o
  // ULTIMO `:` da chave, nao por `endsWith` ingenuo (SPEC secao 12 ponto 6,
  // caveat 6). Cobre loops auto internos que usam multiplos agentIds na mesma
  // fase (ex.: spec-builder:9 e spec-validator:9 ambos contam para a fase 9).
  // -------------------------------------------------------------------------

  // 8C.3: corpo movido para codex-sessions.ts (hasCodexSessionForPhase free fn).
  // O metodo PERMANECE na classe como delegador fino — e espiado por
  // codex-kill-on-approve.test.ts (INV-16).
  private hasCodexSessionForPhase(state: PhaseState, phase: number): boolean {
    return hasCodexSessionForPhaseModule(state, phase);
  }

  // -------------------------------------------------------------------------
  // Private: maybeKillIdleCodexOnGate — kill cirurgico de processos Codex
  // orfaos nos gates de acao humana (approve / confirm-development). Encapsula
  // a Regra de 3 Condicoes da SPEC num UNICO ponto, para os dois gates (Sprint
  // 3) nao duplicarem logica. So chama `resetCodexPool(projectId)` quando as 3
  // condicoes passam. Decisao adotada (a): REGRA MAXIMA estrita, escopada a
  // fase deixada (SEM sweep project-wide).
  // -------------------------------------------------------------------------

  // 8C.3: corpo movido para codex-sessions.ts (maybeKillIdleCodexOnGate free fn).
  // O metodo PERMANECE na classe como delegador fino — e espiado por
  // codex-kill-on-approve.test.ts (INV-16). O ctx liga `hasCodexSessionForPhase`
  // a `this.hasCodexSessionForPhase` (late-bind) para preservar o contrato de
  // metodo / spy do sinal (2) da REGRA MAXIMA.
  private maybeKillIdleCodexOnGate(
    projectId: string,
    state: PhaseState,
    project: { pipelineType?: string },
  ): void {
    maybeKillIdleCodexOnGateModule(
      { hasCodexSessionForPhase: (s, p) => this.hasCodexSessionForPhase(s as PhaseState, p) },
      projectId,
      state,
      project,
    );
  }

  // -------------------------------------------------------------------------
  // Private: collectMetrics — save phase metrics to DB
  // -------------------------------------------------------------------------

  // 8C.2: corpo movido para metrics.ts (collectMetrics free fn). O metodo
  // permanece na classe (exposto via ctx aos handlers/*). Emite pipeline:metrics
  // + persiste via savePipelinePhaseMetrics dentro da free fn (D6: sem calculateCost).
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

  // -------------------------------------------------------------------------
  // Private: runAutoPhase — routes to correct phase handler for dev or security
  // -------------------------------------------------------------------------

  async runAutoPhase(projectId: string, phaseNumber: number): Promise<void> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const agentId = getPhaseAgentId(phaseNumber, project) ?? 'unknown';
    const phaseName = getPhaseName(phaseNumber, project) ?? `Phase ${phaseNumber}`;
    const state = this.getState(projectId);

    logger.info({ projectId, phaseNumber, phaseName, agentId, pipelineType: project.pipelineType }, 'Running auto phase');

    // BUG-21: force project.status='running' and currentPhase at entry so that
    // when resetPhase / approvePhase kicks this off in the background, the
    // frontend cannot linger on status='paused'. updateProjectColumns emits
    // pipeline:project-updated so the UI patches the project immediately.
    this.updateProjectColumns(projectId, {
      status: 'running',
      pipelineCurrentPhase: phaseNumber,
    });

    // Create initial metrics row with status 'running'
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

    // Auto-retry codex stalls ONCE with a fresh process before failing the phase.
    // gpt-5.5 via codex occasionally hangs producing no output; the idle-kill throws
    // CodexUnavailableError and a brand-new codex process usually succeeds (user-
    // confirmed: "reiniciei e funcionou"). Bounded to MAX_CODEX_AUTO_RETRIES.
    const MAX_CODEX_AUTO_RETRIES = 1;
    for (let codexAttempt = 0; ; codexAttempt++) {
    try {
      // ---- Architecture-review pipeline dispatch ----
      if (project.pipelineType === 'architecture-review') {
        if (phaseNumber === 1) {
          await this.runArchitecturePhase1Map(projectId, project, state);
        } else if (phaseNumber === 3) {
          await this.runArchitecturePhase3Diagnosis(projectId, project, state);
        } else if (phaseNumber === 5) {
          await this.runArchitecturePhase5Spec(projectId, project, state);
        } else if (phaseNumber === 8) {
          await this.runPhase11(projectId, state); // Planner: shared agent across pipelines
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
          await this.runPhase11(projectId, state); // Planner is the same in both pipelines
        } else {
          throw new Error(`Unknown security auto phase: ${phaseNumber}`);
        }
      } else if (project.pipelineType === 'bug') {
        // Bug Pipe (SPEC spec-sdk-e-bug-pipe.md secao 4.6). Fases auto: 2, 4 e 6.
        // A fase 6 e o Planner COMPARTILHADO (runPhase11), igual security (:8) e
        // architecture-review (:8). Sem este ramo o avanco 5 -> 6 -> 7 morre em
        // `Unknown auto phase: 6` (TB-32 / B-AC19).
        if (phaseNumber === 2) {
          await this.runBugPhase2ParallelAnalysis(projectId, project, state);
        } else if (phaseNumber === 4) {
          await this.runBugPhase4Spec(projectId, project, state);
        } else if (phaseNumber === 6) {
          await this.runPhase11(projectId, state); // Planner: shared agent across pipelines
        } else {
          throw new Error(`Unknown bug auto phase: ${phaseNumber}`);
        }
      } else if (project.pipelineType === 'development-v2') {
        await this.runDevV2AutoPhase(projectId, project, phaseNumber, state);
      } else {
        const isFeature = project.pipelineType === 'feature';
        // Development / Feature pipeline dispatch.
        // Feature pipeline reuses runPhase9/runPhase11 (shared agents) but has
        // its own runPhase4Feature for PRD Completo using FEAT_PRD_COMPLETO_ID.
        // Phase 2 only reaches this dispatch in dev pipeline (feature has it as conversation).
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
      return; // dispatch succeeded — exit the auto-retry loop
    } catch (err) {
      // Codex stalled/timed out (idle-kill or hard timeout) — retry the phase ONCE
      // with a fresh codex process before treating it as a failure. Bounded to
      // MAX_CODEX_AUTO_RETRIES. Only for CodexUnavailableError (NOT auth pauses,
      // which arrive as PipelinePausedError, nor user aborts).
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
          content: '\n[Codex parou sem produzir saida — reiniciando a fase automaticamente com um processo novo...]\n',
        });
        // Fresh codex: close cached sessions + reset the per-project pool so the
        // retry spawns a brand-new mcp-server process (the stalled one was killed).
        this.closeCodexSessions(state);
        continue; // re-run the dispatch from the top of the for-loop
      }

      // S3 (Onda 3): PipelinePausedError signals an EXPECTED pause (codex-auth,
      // user-abort). spawnAgent already persisted status + emitted the user-facing
      // IPC; the phase just stops here without recording it as a failure.
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

      // Sprint 7 (SPEC §4.5 / LC-1): FAIL-site #1 (runAutoPhase). Pure-paused +
      // error + phase-changed:failed; no stream done; sets state.status.
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
    } // end auto-retry for-loop
  }

  // -------------------------------------------------------------------------
  // Phase 2: PRD Generator mode 1 — user stories and requirements
  // -------------------------------------------------------------------------

  private async runPhase2(
    projectId: string,
    projectPath: string,
    state: PhaseState,
  ): Promise<void> {
    await runPhase2Module(this.buildPipelineEngineContext(), projectId, projectPath, state);
  }

  // -------------------------------------------------------------------------
  // Phase 4: PRD Generator mode 2 — full PRD document
  // -------------------------------------------------------------------------

  private async runPhase4(
    projectId: string,
    projectPath: string,
    state: PhaseState,
  ): Promise<void> {
    await runPhase4Module(this.buildPipelineEngineContext(), projectId, projectPath, state);
  }

  // -------------------------------------------------------------------------
  // Phase 2 (FEATURE pipeline only): PRD Generator (auto) via FEAT_PRD_GENERATOR_ID.
  //
  // Mirrors runPhase2 (dev pipeline) but uses the feature-specific agent and
  // the feature-discovery-notes file detected at the end of phase 1. Agent
  // analyses the existing repo + notes and writes stories-requisitos.md.
  // -------------------------------------------------------------------------

  private async runPhase2Feature(
    projectId: string,
    projectPath: string,
    state: PhaseState,
  ): Promise<void> {
    // Sprint 8A.5: body moved to handlers/dev-feature.ts (feature variant of phase 2).
    // Thin late-bound delegator.
    await runPhase2FeatureModule(this.buildPipelineEngineContext(), projectId, projectPath, state);
  }

  // -------------------------------------------------------------------------
  // Phase 4 (FEATURE pipeline only): PRD Completo via FEAT_PRD_COMPLETO_ID.
  //
  // Mirrors runPhase4 but uses the feature-specific agent and the feature
  // discovery notes file (feature-discovery-notes-{timestamp}.md) detected
  // and persisted by the feature pipeline at the end of phase 1.
  // -------------------------------------------------------------------------

  private async runPhase4Feature(
    projectId: string,
    projectPath: string,
    state: PhaseState,
  ): Promise<void> {
    // Sprint 8A.5: body moved to handlers/dev-feature.ts (feature variant of phase 4).
    // Thin late-bound delegator.
    await runPhase4FeatureModule(this.buildPipelineEngineContext(), projectId, projectPath, state);
  }

  // -------------------------------------------------------------------------
  // Phase 11: Planner — delegates to HarnessEngine.plan()
  // -------------------------------------------------------------------------

  /**
   * Thin wrapper: calls runPhase11 with an optional briefing prefix.
   * Used by development-v2 phase 13 (Planner) to inject DevelopmentV2SprintMetadata
   * rules and design contract IDs.
   */
  private async runPhase11WithBriefing(
    projectId: string,
    state: PhaseState,
    briefing: string | null,
  ): Promise<void> {
    return this.runPhase11(projectId, state, briefing ?? undefined);
  }

  private async runPhase11(
    projectId: string,
    state: PhaseState,
    briefingPrefix?: string,
  ): Promise<void> {
    await runPhase11Module(this.buildPipelineEngineContext(), projectId, state, briefingPrefix);
  }

  // -------------------------------------------------------------------------
  // Private: advanceToNextPhase — internal auto-advance helper
  // -------------------------------------------------------------------------

  private async advanceToNextPhase(projectId: string, state: PhaseState): Promise<void> {
    // Sprint 7 (SPEC §4.5): advance core moved to lifecycle.ts (verbatim; the
    // terminal branch routes through completePipeline with 'pipeline-completed').
    // Stays a class method (AC-9: dev-v2-phases / lifecycle-characterization spy
    // and the 8 internal auto-phase call-sites invoke this.advanceToNextPhase).
    return advanceToNextPhaseModule(this.buildLifecycleEngineContext(), projectId, state);
  }

  // -------------------------------------------------------------------------
  // Public API: sendMessage — routes to active conversation phase handler
  // -------------------------------------------------------------------------

  /**
   * BUG 4 (texto dobrado): tokens de posse do turno de fase EM VOO, chaveados
   * por `${projectId}:${phase}`. Dois sendMessage concorrentes na MESMA fase
   * dobravam cada delta (dois handlers no mesmo transport codex) e duplicavam
   * a persistencia; o guard serializa SO o turno da fase — orquestrador no
   * chat dele e fases de projetos diferentes seguem paralelos.
   *
   * `generation` e um contador monotonico do ENGINE (nao confundir com o
   * generation privado do driver codex) usado no compare-and-clear do finally
   * proprietario: um finally atrasado de turno antigo NUNCA libera o token de
   * um turno novo.
   */
  private inFlightSendTokens = new Map<
    string,
    { projectId: string; phaseNumber: number | null; generation: number }
  >();
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

    // Retomar fase conversacional INTERROMPIDA/PAUSADA (ex: Lion fechado no meio
    // da entrevista): enviar mensagem deve CONTINUAR a fase, nao ficar travado.
    // O status persistido pode estar 'interrupted'/'paused' apos restart, e a UI
    // mostrava so o botao de avancar. Aqui retomamos para 'running'.
    const resumeProject = getHarnessProject(projectId);
    if (resumeProject && (resumeProject.status === 'interrupted' || resumeProject.status === 'paused')) {
      state.abortController = new AbortController();
      state.status = 'running';
      setProjectStatus(projectId, 'running');
      emitIPC('pipeline:project-updated', { projectId, patch: { status: 'running' } });
      logger.info({ projectId, phase, prev: resumeProject.status }, 'sendMessage: retomando fase conversacional apos interrupcao/pausa');
    }

    // Auto-resume if the previous run aborted (pause) but the user is sending a
    // new message. Without this, spawnAgent would inherit the already-aborted
    // controller and throw AbortError immediately — the catch below swallows
    // that and the frontend never gets a 'done' event, leaving isStreaming stuck.
    if (state.abortController.signal.aborted) {
      state.abortController = new AbortController();
      state.status = 'running';
      setProjectStatus(projectId, 'running');
      logger.info({ projectId, phase }, 'sendMessage: auto-resuming from paused state');
    }

    // Process attachments: write base64 data to temp files and prepend path refs
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

    // Resolve project type for routing
    const msgProject = getHarnessProject(projectId);
    const isSecurity = msgProject?.pipelineType === 'security';

    // Validate that the current phase accepts manual messages (reject auto-phases).
    // Sprint 5 (SPEC v3 §4.4): the 4-branch alias chain collapses to the single
    // canonical conversationPhasesOf(type). Byte-identical: each deleted alias
    // WAS conversationPhasesOf(type), and the dev/feature fallback maps to
    // conversationPhasesOf('development') === conversationPhasesOf('feature')
    // (feature-9 override, R-1). The override phases (dev/feature-9, dev-v2-12)
    // are accepted here, matching the routing table (INV-8).
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

    // BUG 4 (texto dobrado): token de posse one-in-flight POR FASE, adquirido
    // SINCRONAMENTE depois da validacao de projeto/fase e ANTES do
    // persistMessage/thinking — um segundo sendMessage rejeitado nao pode ja
    // ter persistido user message duplicada nem emitido stream. A rejeicao e
    // SO o retorno { error }: um emitPipelineStream de erro aqui resolveria
    // como falso-erro o awaitNextPause do pipeline_reply do turno EM VOO (o
    // listener filtra apenas por projectId). O pipeline_reply propaga o
    // { error } e o drive re-tenta no proximo tick. Greeting adquire o token
    // normalmente (e o primeiro turno da fase por definicao). phase null
    // tambem adquire: persistMessage/thinking rodam mesmo sem dispatch.
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
      // Save user message (original text, not the path-enriched version).
      // Auto-sent greetings (the briefing that kicks off a conversation phase) get a
      // sentinel agent_id so the renderer read (getPipelinePhaseMessages) filters them
      // out — they must never render as a user bubble. The agent still sees them in
      // priorMessages (getPipelinePhaseMessagesAsChatHistory, which does NOT filter).
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

      // Emit thinking indicator immediately so the UI shows processing state
      emitPipelineStream({ projectId, phase, type: 'thinking' });

      try {
        // Sprint 4 (SPEC §4.6): declarative dispatch via the message-router. The
        // table replaces the 4-branch if(pipelineType) + per-branch switch(phase)
        // AND the handleDevV2Message if-chain. Handlers stay methods (late-bound
        // through `this`), so spies survive (INV-16 / RK-6). dev-v2 phase 5 is in
        // the conversation Set but refuses chat (refuseChat) -> silent `done`.
        // `phase` is non-null here (the auto-phase rejection above only runs when
        // phase !== null; conversation phases always carry a number).
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
            // dev-v2 phase 5: UI antiga / sessao residual mandou chat. Ignora sem
            // persistir placeholder; fecha o stream pra UI destravar.
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
        // S3 (Onda 3): expected pause — spawnAgent already persisted state and
        // emitted the user-facing IPC. Just close the stream gracefully.
        if (err instanceof PipelinePausedError) {
          if (phase !== null) {
            state.conversationAuthResume = {
              phase,
              provider: err.reason === 'grok-auth'
                ? 'grok'
                : err.reason === 'kimi-auth' ? 'kimi' : 'codex',
              message,
              finalMessage,
              isGreeting: opts?.isGreeting === true,
            };
          }
          logger.info(
            { projectId, phase, reason: err.reason },
            'sendMessage: PipelinePausedError — short-circuiting',
          );
          emitPipelineStream({ projectId, phase, type: 'done' });
          if (opts?.rethrowPause) throw err;
          return;
        }
        if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
          // Always emit 'done' on abort so the frontend unlocks isStreaming.
          // Previously we returned silently, leaving the UI stuck on "Processando".
          emitPipelineStream({ projectId, phase, type: 'done' });
          return;
        }
        logger.error({ err, projectId, phase }, 'sendMessage: error');
        emitIPC('pipeline:error', { projectId, phase, error: (err as Error).message });
        emitPipelineStream({ projectId, phase, type: 'done' });
      }
    } finally {
      // BUG 4: liberacao compare-and-clear pelo finally PROPRIETARIO — so
      // libera se ainda possui o MESMO token. Pause/abort/reset nao limpam o
      // token diretamente: eles abortam a execucao e este finally libera
      // quando ela assenta (anti-deadlock: o hard cap do driver garante
      // assentamento eventual).
      if (this.inFlightSendTokens.get(sendTokenKey) === sendToken) {
        this.inFlightSendTokens.delete(sendTokenKey);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public API: approvePhase — user clicked "Decidido" / "Aprovar"
  // -------------------------------------------------------------------------

  /**
   * Serializa chamadas concorrentes de `approvePhase` no MESMO projeto.
   * Sem isso, multiplos cliques no botao "Travar Design e Continuar"
   * (ou em "Aprovar" das fases conversational) disparavam advances
   * paralelos — cada um marchando o pipeline 1 fase pra frente. Resultado
   * observado no Chess: fase 6, 7 e 8 rodando ao mesmo tempo, com agentes
   * conversando em fases diferentes simultaneamente.
   *
   * O `ensureProjectLock` no IPC handler nao basta porque eh idempotente
   * (mesmo owner = no-op). Este Set rastreia se uma approvePhase para o
   * projectId ja esta em execucao. Chamadas concorrentes retornam imediato.
   */
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

    // Gate 1 (Sprint 3): kill cirurgico de processos Codex orfaos ANTES de
    // qualquer roteamento/spawn da proxima fase. No-op por design quando a fase
    // deixada nao usou Codex ou e loop (Regra de 3 Condicoes encapsulada no
    // helper). Reusa a referencia approveProject ja resolvida acima.
    if (approveProject) this.maybeKillIdleCodexOnGate(projectId, state, approveProject);

    const isSecurity = approveProject?.pipelineType === 'security';
    const isArchitectureReview = approveProject?.pipelineType === 'architecture-review';

    try {
      // ----------------------------------------------------------------
      // Architecture Review pipeline approval routing
      // ----------------------------------------------------------------
      if (isArchitectureReview) {
        // Conversation phases per ARCHITECTURE_REVIEW_PIPELINE_PHASES:
        //   2 (Triagem),  4 (Decisao),  6 (SpecValidation),  7 (SpecEnricher),  9 (SprintValidator)
        //
        // Phase 2 has a special payload: { selectedCandidateId } — must be
        // validated against the JSON of candidates and persisted before advancing.
        if (phase === 2) {
          const selectedCandidateId = metadata?.['selectedCandidateId'];
          if (typeof selectedCandidateId !== 'string' || selectedCandidateId.length === 0) {
            const errMsg = 'pipeline:approve fase 2 (architecture-review) requer { selectedCandidateId: string }';
            logger.warn({ projectId, phase, metadata }, errMsg);
            emitIPC('pipeline:error', { projectId, phase, error: errMsg });
            throw new Error(errMsg);
          }
          // Validate the candidate exists in the JSON.
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
          // Persist in BOTH the DB config and the manifest.
          // ORDER: DB first (more failure modes — locks, constraints), manifest after.
          // If DB throws, manifest is untouched and the user can retry approve. If manifest
          // throws after DB succeeds, the DB is the source of truth (manifest is rebuilt
          // from project.config on the next read via getArchitectureReviewContext).
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
          // Fase 3 (Diagnosis) é auto com opus — pode rodar 5-10min via spawnAgent.
          // Se awaitassemos finalizeConversationPhase aqui, o IPC `pipeline:approve`
          // ficaria bloqueado pelo tempo todo do Diagnosis — o user clica "Atacar este alvo"
          // e fica vendo "Aprovando..." por minutos achando que travou.
          // Solução: persistência já feita acima (síncrono), advance roda em background.
          // O frontend recebe pipeline:phase-changed events conforme a fase 3 progride.
          this.runFinalizeInBackground(projectId, phase, state, approveProject ?? undefined);
        } else if (phase === 4) {
          // Phase 4 (Decision Interview) gate: precisa de >=N decisoes "fechadas"
          // (## DN com Pergunta + Decisao + Razao + Implica). Mensagem de erro
          // detalhada permite o usuario corrigir manualmente ou pedir ao agente
          // pra completar a decisao incompleta antes de tentar avancar de novo.
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
              .map((g) => `D${g.decisionN}${g.title ? ` (${g.title})` : ''}: falta ${g.missing.map((f) => DECISION_FIELD_LABEL[f]).join(', ')}`)
              .join('; ');
            const errMsg = `Decisoes incompletas: ${detalhes}. Cada decisao precisa ter Pergunta, Decisao, Razao e Implica antes de gerar a SPEC.`;
            emitIPC('pipeline:error', { projectId, phase, error: errMsg });
            throw new Error(errMsg);
          }
          // Fase 5 (Spec Generation) é auto opus — também roda em background.
          this.runFinalizeInBackground(projectId, phase, state, approveProject ?? undefined);
        } else if (phase === 6 || phase === 7 || phase === 9) {
          // Fase 7 e 9 vão para conversation/loop sem auto longo no meio.
          // Fase 6 vai para fase 7 (conversation) — também rápido.
          await this.finalizeConversationPhase(projectId, phase, state, approveProject ?? undefined);
        } else {
          logger.warn({ projectId, phase }, 'approvePhase: no architecture-review handler for this phase');
        }
      } else if (isSecurity) {
        // Security pipeline conversation phases: 4 (Skeptic Security), 5 (Skeptic Quality),
        // 6 (SPEC review gate), 7 (SPEC Enricher), 9 (Sprint Validator).
        if (phase === 4 || phase === 5 || phase === 6 || phase === 7 || phase === 9) {
          // Write Site 2: after the second skeptic (phase 5) is approved, re-parse the
          // consolidated Security file to capture confirmedFindings and removedByValidator.
          if (phase === 5 && approveProject) {
            const projectPath = (approveProject as { projectPath: string }).projectPath;
            const securityDir = path.join(projectPath, '.lionclaw', 'Security');
            const consolidatedFiles = fs.existsSync(securityDir)
              ? fs.readdirSync(securityDir).filter((f) => /^Security-\d{8}-\d{4}\.md$/.test(f)).sort()
              : [];
            const securityReportPath = consolidatedFiles.length > 0
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
        // ----------------------------------------------------------------
        // Bug Pipe approval routing (SPEC spec-sdk-e-bug-pipe.md secao 4.10).
        //
        // O ramo cobre AS QUATRO fases conversacionais (1, 3, 5, 7), nao so a 3.
        // Se cobrisse so a 3, aprovar 1/5/7 cairia no `else` final — o switch do
        // DEVELOPMENT — que chama finalizeConversationPhase SEM projectCtx e
        // grava metrica com discovery-agent (1) / tech-database (5) /
        // tech-frontend (7) (B-AC22 / TB-40).
        //
        // RODADA 6 / DECISAO 7(a): NENHUM approve de projeto `bug` chama
        // runFinalizeInBackground nem finalizeConversationPhase. Fases 1, 3
        // (desfecho approve-plan) e 5 vao pelo delegador LOCAL
        // runBugFinalizeInBackground; a fase 7 vai por await
        // finalizeBugConversationPhase (retorna cedo no gate
        // awaiting-dev-confirmation, sem auto no meio).
        // ----------------------------------------------------------------
        if (phase === 3) {
          // Gate de 2 desfechos (D15/D16/D18). A validacao de metadata e
          // ESCOPADA a fase 3: as outras 3 fases conversacionais aprovam sem
          // payload.
          const action = metadata?.['action'];
          if (typeof action !== 'string') {
            const errMsg =
              'pipeline:approve fase 3 (bug) requer { action: "approve-plan" | "close-pipeline" }';
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
            // ORDER: DB first (more failure modes — locks, constraints), manifest
            // after. `config.bug.outcome` no DB e a FONTE DA VERDADE (lida por
            // O12/header/badge); se o manifest viesse primeiro e lancasse, o
            // desfecho nunca chegaria ao DB.
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
            // A fase 4 e AUTO e CARA (spec-builder em opus): sem background o IPC
            // pipeline:approve fica bloqueado e a UI trava em "Aprovando...".
            this.runBugFinalizeInBackground(projectId, phase, state, approveProject);
          } else {
            // close-pipeline: mesma ordem DB-antes-de-manifest. Falha de manifest
            // NAO pode impedir a gravacao do desfecho (senao O12 anuncia entrega
            // falsa num pipe encerrado sem correcao).
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
            // RODADA 6 / DECISAO 7(b) — B-AC33: a fase 3 e CONVERSACIONAL e
            // acumula metrica ao longo da conversa com o consolidador.
            // completePipeline (lifecycle.ts) NAO faz flush: sem esta chamada o
            // custo e a duracao do bug-solution-consolidator nunca sao
            // persistidos e o pipe encerrado sai do relatorio sem a linha da
            // fase 3. Tem que rodar ANTES de completePipeline.
            this.flushAccumulatedMetrics(
              projectId,
              3,
              BUG_SOLUTION_CONSOLIDATOR_ID,
              state,
              'completed',
              approveProject,
            );
            // D16: status persistido = 'done' (ja no CHECK constraint), sem
            // status novo e sem ALTER. completePipeline zera
            // pipelineCurrentPhase, libera o lock e emite phase-changed{phase:null}.
            this.completePipeline(projectId, state, {
              terminalStatusString: 'pipeline-completed',
              setStateIdle: false,
            });
          }
        } else if (phase === 1 || phase === 5) {
          // Fases conversacionais SEM metadata cuja PROXIMA fase e AUTO e CARA
          // (1 -> fase 2, 3 agentes em paralelo; 5 -> fase 6, harness-planner).
          this.runBugFinalizeInBackground(projectId, phase, state, approveProject);
        } else if (phase === 7) {
          // Sprint Validator: retorna cedo no gate awaiting-dev-confirmation,
          // sem auto no meio — mesmo criterio das fases 6/7/9 do arch-review.
          await this.finalizeBugConversationPhase(projectId, phase, state, approveProject);
        } else {
          logger.warn({ projectId, phase }, 'approvePhase: no bug handler for this phase');
        }
      } else if (approveProject?.pipelineType === 'development-v2') {
        // Sprint 4 (SPEC L821-873): fase 5 (Open Design Studio) so avanca via
        // `{ action: 'lock-and-continue' }`. PipelineEngine roda a fase 6
        // (Design Lock) internamente; nao expoe `open-design:lock` publicamente.
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
          // Pre-conditions: openDesign session ja bootstrappada (SPEC L832-841).
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
        // Development pipeline approval routing
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
      // S3 (Onda 3): expected pause — spawnAgent already persisted state and
      // emitted the user-facing IPC. Just exit silently without an error toast.
      if (err instanceof PipelinePausedError) {
        logger.info(
          { projectId, phase, reason: err.reason },
          'approvePhase: PipelinePausedError — short-circuiting',
        );
        return;
      }
      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        return;
      }
      logger.error({ err, projectId, phase }, 'approvePhase: error');
      emitIPC('pipeline:error', { projectId, phase, error: (err as Error).message });
      // Rethrow so the IPC handler returns { error } via withPipelineEngine
      // instead of { ok: true }. Without this, the frontend receives a fake
      // success and the UI looks like it approved when actually it failed
      // (e.g. invalid candidate id, missing decisions, etc).
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Phase 1: Discovery conversation handlers (continue:true within block)
  // -------------------------------------------------------------------------

  private async handlePhase1Message(
    projectId: string,
    message: string,
    state: PhaseState,
  ): Promise<void> {
    await handlePhase1MessageModule(this.buildPipelineEngineContext(), projectId, message, state);
  }

  // -------------------------------------------------------------------------
  // Phase 3: PRD Validator (persistent file memory, fresh query each turn)
  // -------------------------------------------------------------------------

  private async handlePhase3Message(
    projectId: string,
    message: string,
    state: PhaseState,
  ): Promise<void> {
    await handlePhase3MessageModule(this.buildPipelineEngineContext(), projectId, message, state);
  }

  // -------------------------------------------------------------------------
  // Phases 5-8: Tech conversation phases (Database, Backend, Frontend, Security)
  // Each phase uses its own dedicated agent and session key.
  // -------------------------------------------------------------------------

  private async handleTechPhaseMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    phaseNumber: number,
    agentId: string,
  ): Promise<void> {
    await handleTechPhaseMessageModule(this.buildPipelineEngineContext(), projectId, message, state, phaseNumber, agentId);
  }

  // -------------------------------------------------------------------------
  // Phase 10: Spec Enricher (session persists across turns for context)
  // -------------------------------------------------------------------------

  private async handlePhase10Message(
    projectId: string,
    message: string,
    state: PhaseState,
  ): Promise<void> {
    await handlePhase10MessageModule(this.buildPipelineEngineContext(), projectId, message, state);
  }

  // -------------------------------------------------------------------------
  // Phase 12: Sprint Validator (session persists across turns for context)
  // -------------------------------------------------------------------------

  private async handlePhase12Message(
    projectId: string,
    message: string,
    state: PhaseState,
    phaseNumber: number = 12,
    briefing?: string | null,
  ): Promise<void> {
    // Sprint Validator handler. Used by both:
    //   - dev/feature pipelines on phase 12 (default)
    //   - architecture-review pipeline on phase 9 (passed by caller)
    //   - development-v2 pipeline on phase 14 (with optional briefing)
    // The phaseNumber parameter is propagated to spawnAgent / persistMessage /
    // emit IPC so the UI sees messages on the correct channel.
    await handlePhase12MessageModule(this.buildPipelineEngineContext(), projectId, message, state, phaseNumber, briefing);
  }

  // =========================================================================
  // Security Pipeline Auto Phases
  // =========================================================================

  // -------------------------------------------------------------------------
  // Security Phase 1: Repo Profiler (deterministic, no LLM)
  // -------------------------------------------------------------------------

  private async runSecurityPhase1(
    projectId: string,
    projectPath: string,
    state: PhaseState,
  ): Promise<void> {
    await runSecurityPhase1Module(this.buildPipelineEngineContext(), projectId, projectPath, state);
  }

  // -------------------------------------------------------------------------
  // Security Phase 2: Security Audit (parallel multi-agent via SecurityAuditRunner)
  // -------------------------------------------------------------------------

  private async runSecurityPhase2(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    await runSecurityPhase2Module(this.buildPipelineEngineContext(), projectId, project, state);
  }

  // -------------------------------------------------------------------------
  // Security Phase 3: Deduplicador (auto, single agent)
  // -------------------------------------------------------------------------

  private async runSecurityPhase3(
    projectId: string,
    projectPath: string,
    state: PhaseState,
  ): Promise<void> {
    await runSecurityPhase3Module(this.buildPipelineEngineContext(), projectId, projectPath, state);
  }

  // -------------------------------------------------------------------------
  // Security Phase 6: SPEC Generator (auto with security prompt injection)
  // -------------------------------------------------------------------------

  private async runSecurityPhase6(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    await runSecurityPhase6Module(this.buildPipelineEngineContext(), projectId, project, state);
  }

  // =========================================================================
  // Security Pipeline Conversation Phases
  // =========================================================================

  // -------------------------------------------------------------------------
  // Security Phase 4: Validador Cetico
  // First runs security-skeptic-security then security-skeptic-quality automatically,
  // then opens human chat (awaitingUser=true).
  // -------------------------------------------------------------------------

  private async handleSecurityPhase4Message(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleSecurityPhase4MessageModule(this.buildPipelineEngineContext(), projectId, message, state, project);
  }

  // -------------------------------------------------------------------------
  // Security Phase 5: Skeptic Quality conversation
  // Runs the quality-focused skeptic once on first turn, then opens human chat.
  // -------------------------------------------------------------------------

  private async handleSecurityPhase5Message(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleSecurityPhase5MessageModule(this.buildPipelineEngineContext(), projectId, message, state, project);
  }

  // -------------------------------------------------------------------------
  // Security Phase 6: SPEC review conversation (builder<->validator loop gate)
  // -------------------------------------------------------------------------

  private async handleSecurityPhase6SpecReviewMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleSecurityPhase6SpecReviewMessageModule(this.buildPipelineEngineContext(), projectId, message, state, project);
  }

  // -------------------------------------------------------------------------
  // Security Phase 7: SPEC Enricher conversation
  // -------------------------------------------------------------------------

  private async handleSecurityPhase7Message(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleSecurityPhase7MessageModule(this.buildPipelineEngineContext(), projectId, message, state, project);
  }

  // -------------------------------------------------------------------------
  // Security Phase 9: Sprint Validator conversation
  // -------------------------------------------------------------------------

  private async handleSecurityPhase9Message(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleSecurityPhase9MessageModule(this.buildPipelineEngineContext(), projectId, message, state, project);
  }

  // =========================================================================
  // Security Resolution Tracker (post-pipeline, feat-026)
  // =========================================================================

  private async runResolutionTracker(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    // Sprint 8A.5: body moved to handlers/security.ts (security post-pipeline tracker).
    // Thin late-bound delegator.
    await runResolutionTrackerModule(this.buildPipelineEngineContext(), projectId, project);
  }

  // -------------------------------------------------------------------------
  // Phase 9: Spec Generation — auto loop spec-builder -> spec-validator
  // -------------------------------------------------------------------------

  async runPhase9(projectId: string): Promise<void> {
    await runPhase9Module(this.buildPipelineEngineContext(), projectId);
  }

  // =========================================================================
  // Architecture Review pipeline handlers (phases 1-7)
  // =========================================================================
  //
  // Phase 1 (Map):                runArchitecturePhase1Map           — auto
  // Phase 2 (Triage):             handleArchitecturePhase2TriageMessage — conversation
  // Phase 3 (Diagnosis):          runArchitecturePhase3Diagnosis     — auto (Sprint 5)
  // Phase 4 (Decision Interview): handleArchitecturePhase4DecisionMessage — conversation (Sprint 5)
  // Phase 5 (Spec Generation):    runArchitecturePhase5Spec          — auto (Sprint 6)
  // Phase 6 (Spec Validation):    handleArchitecturePhase6SpecValidationMessage — conversation (Sprint 6)
  // Phase 7 (Spec Enricher):      handleArchitecturePhase7SpecEnricherMessage   — conversation (Sprint 6)
  //
  // Phases 8-11 reuse harness handlers (Planner / Sprint Validator / Coder / Evaluator).
  // =========================================================================

  // -------------------------------------------------------------------------
  // Architecture Review Phase 1: Mapeamento Arquitetural (auto)
  // -------------------------------------------------------------------------
  //
  // Sprint 8A.1 (SPEC §4): the 7 architecture-review bodies moved VERBATIM to
  // handlers/architecture-review.ts and are reparameterized from `this.X` to an
  // injected PipelineEngineContext (buildPipelineEngineContext, late-bound). Each
  // method below stays on the class as a thin delegator so the existing dispatch
  // (sendMessage -> message-router -> this.handleArchitectureX; runAutoPhase ->
  // this.runArchitectureX) is unchanged.

  private async runArchitecturePhase1Map(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    await runArchitecturePhase1MapModule(this.buildPipelineEngineContext(), projectId, project, state);
  }

  // -------------------------------------------------------------------------
  // Architecture Review Phase 2: Triagem de Alvos (conversation)
  // -------------------------------------------------------------------------

  private async handleArchitecturePhase2TriageMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleArchitecturePhase2TriageMessageModule(this.buildPipelineEngineContext(), projectId, message, state, project);
  }

  // -------------------------------------------------------------------------
  // Architecture Review Phase 3: Diagnostico Arquitetural (auto)
  // -------------------------------------------------------------------------

  private async runArchitecturePhase3Diagnosis(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    await runArchitecturePhase3DiagnosisModule(this.buildPipelineEngineContext(), projectId, project, state);
  }

  // -------------------------------------------------------------------------
  // Architecture Review Phase 4: Entrevista de Decisao (conversation, append-only)
  // -------------------------------------------------------------------------

  private async handleArchitecturePhase4DecisionMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleArchitecturePhase4DecisionMessageModule(this.buildPipelineEngineContext(), projectId, message, state, project);
  }

  // -------------------------------------------------------------------------
  // Architecture Review Phase 5: Spec Generation (auto LOOP builder ↔ validator)
  // -------------------------------------------------------------------------

  private async runArchitecturePhase5Spec(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    await runArchitecturePhase5SpecModule(this.buildPipelineEngineContext(), projectId, project, state);
  }

  // -------------------------------------------------------------------------
  // Architecture Review Phase 6: Spec Validation (conversation, reuses spec-validator)
  // -------------------------------------------------------------------------

  private async handleArchitecturePhase6SpecValidationMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleArchitecturePhase6SpecValidationMessageModule(this.buildPipelineEngineContext(), projectId, message, state, project);
  }

  // -------------------------------------------------------------------------
  // Architecture Review Phase 7: Spec Enricher (conversation, architecture-specific)
  // -------------------------------------------------------------------------

  private async handleArchitecturePhase7SpecEnricherMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    await handleArchitecturePhase7SpecEnricherMessageModule(this.buildPipelineEngineContext(), projectId, message, state, project);
  }

  // -------------------------------------------------------------------------
  // Bug Pipe (S8): delegadores finos das 5 funcoes de fase de handlers/bug.ts.
  //
  // Mesmo padrao dos delegadores do architecture-review acima: o corpo vive no
  // handler e o metodo aqui so injeta o PipelineEngineContext (late-bound), para
  // o despacho existente (sendMessage -> message-router -> this.handleBugX;
  // runAutoPhase -> this.runBugX) ficar inalterado e os spies de teste sobre a
  // instancia continuarem sendo observados.
  // -------------------------------------------------------------------------

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
    await handleBugPhase3ConsolidationMessageModule(this.buildPipelineEngineContext(), projectId, message, state, project);
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
    await handleBugPhase5SpecValidatorMessageModule(this.buildPipelineEngineContext(), projectId, message, state, project);
  }

  /**
   * Tail de aprovacao das fases conversacionais do Bug Pipe (SPEC secao 4.12 (b)
   * item 1 / D33). Delegador LOCAL: `finalizeConversationPhase` NAO e usado por
   * projeto `bug` — o predicado de Sprint Validator dela (:2648-2670, agora
   * deslocado pelas linhas acrescentadas) e hardcoded em 9/12 e nao casa com a
   * fase 7 do bug.
   */
  private async finalizeBugConversationPhase(
    projectId: string,
    phase: number,
    state: PhaseState,
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
  ): Promise<void> {
    await finalizeBugConversationPhaseModule(this.buildPipelineEngineContext(), projectId, phase, state, project);
  }

  /**
   * Espelho de `runFinalizeInBackground` para o Bug Pipe (SPEC secao 4.12 (b)
   * item 2). Mesmo tratamento de PipelinePausedError / AbortError /
   * `pipeline:error`, chamando o finalizer LOCAL.
   *
   * Usado nas fases 1, 3 (desfecho `approve-plan`) e 5, cuja PROXIMA fase e AUTO
   * e CARA (fase 2: 3 agentes em paralelo; fase 4: `spec-builder` em opus; fase
   * 6: `harness-planner`). Sem o background o IPC `pipeline:approve` fica
   * bloqueado pela duracao inteira e a UI trava em "Aprovando...", indistinguivel
   * de freeze (mesmo modo de falha documentado em `runFinalizeInBackground`).
   */
  private runBugFinalizeInBackground(
    projectId: string,
    phase: number,
    state: PhaseState,
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
  ): void {
    void this.finalizeBugConversationPhase(projectId, phase, state, project).catch((err) => {
      if (err instanceof PipelinePausedError) {
        logger.info({ projectId, phase, reason: err.reason }, 'Background bug finalize: PipelinePausedError — short-circuiting');
        return;
      }
      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        return;
      }
      logger.error({ err, projectId, phase }, 'Background finalizeBugConversationPhase failed');
      emitIPC('pipeline:error', { projectId, phase, error: (err as Error).message });
    });
  }

  // -------------------------------------------------------------------------
  // Phase 9: Spec Validator conversation (post auto-loop review)
  // -------------------------------------------------------------------------

  private async handlePhase9Message(
    projectId: string,
    message: string,
    state: PhaseState,
  ): Promise<void> {
    await handlePhase9MessageModule(this.buildPipelineEngineContext(), projectId, message, state);
  }

  // -------------------------------------------------------------------------
  // Helpers: conversation phase finalize (all pipelines)
  // -------------------------------------------------------------------------

  private async finalizeConversationPhase(
    projectId: string,
    phase: number,
    state: PhaseState,
    projectCtx?: { pipelineType?: string },
  ): Promise<void> {
    // Flush accumulated metrics for this phase
    const agentId = (projectCtx ? getPhaseAgentId(phase, projectCtx) : PHASE_AGENT_IDS[phase]) ?? 'unknown';
    this.flushAccumulatedMetrics(projectId, phase, agentId, state, 'completed', projectCtx);

    // Dev pipeline phase 9 also accumulates conversation-turn metrics under key 91 (Spec Validator review)
    if (phase === 9 && projectCtx?.pipelineType !== 'security') {
      this.flushAccumulatedMetrics(projectId, 91, SPEC_VALIDATOR_ID, state, 'completed', undefined, true);
    }

    // Security pipeline phase 6 also accumulates conversation-turn metrics under key 61 (SPEC review Validator)
    if (phase === 6 && projectCtx?.pipelineType === 'security') {
      this.flushAccumulatedMetrics(projectId, 61, SECURITY_SPEC_VALIDATOR_ID, state, 'completed', undefined, true);
    }

    logger.info({ projectId, phase }, 'Conversation phase finalized by user approval');

    const phaseName = (projectCtx ? getPhaseName(phase, projectCtx) : PHASE_NAMES[phase]) ?? `Phase ${phase}`;

    // Sprint Validator gate — requires explicit user confirmation before
    // starting the Coder/Evaluator loop. Phase number depends on pipelineType:
    //   - security:            phase 9
    //   - architecture-review: phase 9
    //   - dev / feature:       phase 12
    const isSprintValidatorPhase =
      (projectCtx?.pipelineType === 'security' && phase === 9) ||
      (projectCtx?.pipelineType === 'architecture-review' && phase === 9) ||
      (projectCtx?.pipelineType !== 'security' &&
        projectCtx?.pipelineType !== 'architecture-review' &&
        phase === 12);

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

  /**
   * Build priorMessages array for a conversation follow-up turn.
   *
   * Why: cloud SDK and Codex maintain server-side conversation state, so
   * `continueSession: true` is enough. But local (Ollama) and external
   * (HTTP) runtimes are stateless — they need the full chat history
   * passed in `priorMessages` to maintain context across turns. Without
   * this, those runtimes "forget" everything between turns.
   *
   * The cloud/Codex executors ignore `priorMessages` (they prefer the
   * server-side session), so passing it is harmless on every runtime.
   */
  private buildPriorMessagesForPhase(
    projectId: string,
    phaseNumber: number,
  ): PriorMessages {
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

  /**
   * Run finalizeConversationPhase in background, returning IMMEDIATELY.
   *
   * Use case: approval transitions where the next phase is `auto` and may run
   * a long agent (opus, 5-10min). Without this, the `pipeline:approve` IPC
   * blocks for the entire duration, leaving the UI in an "Aprovando..." state
   * that looks like a freeze. The frontend instead listens to subsequent
   * `pipeline:phase-changed` / `pipeline:stream` events as the next phase
   * progresses.
   *
   * Errors are caught and emitted via `pipeline:error` so the frontend still
   * surfaces failures (just decoupled from the original IPC).
   */
  private runFinalizeInBackground(
    projectId: string,
    phase: number,
    state: PhaseState,
    project: NonNullable<ReturnType<typeof getHarnessProject>> | undefined,
  ): void {
    void this.finalizeConversationPhase(projectId, phase, state, project).catch((err) => {
      if (err instanceof PipelinePausedError) {
        logger.info({ projectId, phase, reason: err.reason }, 'Background finalize: PipelinePausedError — short-circuiting');
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

    // BUG 2 (bug-atividade-toolcalls-codex.md P2): re-semeia a fila
    // harness_sprints a partir do sprints.json editado pelo Sprint Validator,
    // ANTES de advanceToNextPhase. Funil unico dos 5 pipelines (dev/feature/
    // security/arch-review via finalizeConversationPhase, dev-v2 via
    // finalizeDevV2ConversationPhase, gate F4 do orquestrador) — todos chegam
    // aqui. Fail-loud: o erro propaga para o padrao { error } do
    // withPipelineEngine e o gate NAO avanca com plano stale.
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

    // Gate 2 (Sprint 3): kill cirurgico de processos Codex orfaos ANTES de
    // emitir/avancar (advanceToNextPhase). A fase deixada e o Sprint Validator
    // (conversation, nao loop -> Condicao 1 naturalmente satisfeita); Condicoes
    // 2 e 3 ainda decidem dentro do helper. Reusa confirmProject ja resolvido.
    if (confirmProject) this.maybeKillIdleCodexOnGate(projectId, state, confirmProject);

    // For security pipeline, the Sprint Validator is phase 8; for dev pipeline it is phase 12.
    const sprintValidatorPhase = (confirmProject ? getPhaseNumberForAgent(confirmProject, 'sprint-validator') : undefined) ?? 12;
    const sprintValidatorName = (confirmProject ? getPhaseName(sprintValidatorPhase, confirmProject) : PHASE_NAMES[12]) ?? `Phase ${sprintValidatorPhase}`;

    logger.info({ projectId, sprintValidatorPhase }, 'User confirmed start of development — advancing from Sprint Validator to Coder/Evaluator');

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: sprintValidatorPhase,
      phaseName: sprintValidatorName,
      status: 'completed',
      awaitingUser: false,
    });

    await this.advanceToNextPhase(projectId, state);
  }

  // -------------------------------------------------------------------------
  // Helpers: metric accumulation across turns
  // -------------------------------------------------------------------------

  // 8C.2: corpos movidos para metrics.ts (free fns). Os metodos permanecem na
  // classe — createEmptyMetrics/mergeMetrics/accumulateMetrics chegam aos
  // handlers/* via ctx, e flushAccumulatedMetrics e espiado pela caracterizacao
  // de lifecycle / dev-v2-phase12-gate. So o CORPO move; comportamento identico.
  // D6: nenhum calculateCost — soma result.metrics.costUsd.
  private createEmptyMetrics(): SpawnAgentResult['metrics'] {
    return createEmptyMetricsFn();
  }

  private mergeMetrics(
    accum: SpawnAgentResult['metrics'],
    result: SpawnAgentResult['metrics'],
  ): void {
    mergeMetricsFn(accum, result);
  }

  private accumulateMetrics(
    state: PhaseState,
    phaseNumber: number,
    result: SpawnAgentResult,
  ): void {
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

  // -------------------------------------------------------------------------
  // Private: resolve the model name for a given phase (for pipeline:phase-changed)
  // -------------------------------------------------------------------------

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
    // All other phases: resolve via the phase-to-agent mapping
    const agentId = getPhaseAgentId(phaseNumber, project) ?? null;
    if (!agentId) return null;
    const agent = getAgent(agentId);
    return resolveModelForAgent(agent);
  }

  // -------------------------------------------------------------------------
  // Public: notify loop phase released (called by HarnessEngine when sprint ends)
  //
  // S4.2: NAO libera o lock per-projeto aqui. O lock so e liberado quando o
  // pipeline atinge estado terminal (done/failed/aborted) ou no recovery on
  // boot. Sprints intermediarios continuam segurando o lock pra impedir
  // segundo `pipeline:start` no mesmo projeto.
  // -------------------------------------------------------------------------

  releaseLoopPhase(projectId: string): void {
    logger.debug({ projectId }, 'releaseLoopPhase called (no-op pos-S4.2 — lock held until terminal state)');
  }

  // -------------------------------------------------------------------------
  // Public: get current phase state (for IPC queries)
  // -------------------------------------------------------------------------

  getCurrentPhase(projectId: string): { phase: number; status: string } | null {
    if (!this.states.has(projectId)) return null;
    const s = this.states.get(projectId)!;
    return { phase: s.currentPhase, status: s.status };
  }

  // -------------------------------------------------------------------------
  // Public API: runSprint — phases 13+14 loop
  // -------------------------------------------------------------------------

  /**
   * Run the Coder+Evaluator loop (phases 13/14) for a single sprint,
   * then automatically advance to the next sprint or mark the pipeline complete.
   *
   * Called by the IPC layer / HarnessEngine integration after the sprint plan
   * has been validated (phase 12 approved).
   */
  async runSprint(projectId: string, sprintIndex: number): Promise<void> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const sprints = getHarnessSprints(projectId);
    if (sprintIndex < 0 || sprintIndex >= sprints.length) {
      throw new Error(`Sprint index ${sprintIndex} out of range (project has ${sprints.length} sprints)`);
    }

    // Resolve coder/evaluator phase numbers per pipelineType from the canonical
    // phases array (single source of truth). Hardcoded 10/11/13/14 was wrong for
    // architecture-review (coder=10, evaluator=11).
    const coderPhase = getPhaseNumberForAgent(project, 'harness-coder')
      ?? (project.pipelineType === 'security' || project.pipelineType === 'architecture-review' ? 10 : 13);
    const evaluatorPhase = getPhaseNumberForAgent(project, 'harness-evaluator')
      ?? (project.pipelineType === 'security' || project.pipelineType === 'architecture-review' ? 11 : 14);
    const coderPhaseName = getPhaseName(coderPhase, project) ?? `Phase ${coderPhase}`;

    const state = this.getState(projectId);

    // BUG 2 (bug-atividade-toolcalls-codex.md P3): invariante fail-loud
    // fila==arquivo ANTES de rodar o Coder (defesa em profundidade — cobre
    // retry/resume/acceptSprint/rejectSprint/resetSprint, que nao passam pelo
    // reseed do confirmStartDevelopment). Como runSprint roda a cada sprint
    // (auto-advance), o re-check por sprint vem de graca. NUNCA prossegue com
    // plano divergente: pausa com o mesmo padrao do catch de runSingleSprint.
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
      logger.warn({ projectId, sprintIndex, warning: queueIntegrity.warning }, 'runSprint: divergencia legada tolerada');
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
    logger.info({ projectId, sprintIndex, sprintName: sprint.name, coderPhase }, 'runSprint: starting coder+evaluator loop');

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: coderPhase,
      phaseName: coderPhaseName,
      status: 'running',
      awaitingUser: false,
      metadata: { sprintIndex, sprintName: sprint.name },
    });

    // S4.2: o lock per-projeto ja foi adquirido em pipeline:start. ensureProjectLock
    // e idempotente — no-op pra esse projeto. Pipelines de OUTROS projetos podem
    // rodar loops Coder/Evaluator em paralelo (cross-project livre per R7/D4).
    ensureProjectLock(projectId, 'pipeline-engine');

    // Bridge: use HarnessEngine's stream bridge API to forward events as pipeline:stream.
    // External runtime emits BOTH 'text_delta' (per-token chunks) and 'text' (full final
    // assistant response). Forward 'text_delta' so the UI sees streaming live, and SKIP
    // the final 'text' to avoid duplicating content already streamed via deltas.
    // Local/cloud paths only emit 'text' (no deltas), so 'text' continues being forwarded
    // for those — we detect external by presence of any earlier 'text_delta' for the same
    // (sprintId, round) tuple.
    const seenDeltas = new Set<string>();
    this.harnessEngine.setStreamBridge((channel, data) => {
      if (channel === 'harness:agent-stream') {
        const d = data as { projectId?: string; agent?: string; sprintId?: string; round?: number; event?: { type?: string; content?: string; tool?: string } };
        if (d.projectId !== projectId || !d.event?.type) return;
        const phase = d.agent === 'evaluator' ? evaluatorPhase : coderPhase;
        const tupleKey = `${d.sprintId ?? ''}:${d.round ?? 0}:${d.agent ?? ''}`;

        if (d.event.type === 'text_delta' && d.event.content) {
          seenDeltas.add(tupleKey);
          emitPipelineStream({ projectId, phase, type: 'text', content: d.event.content });
        } else if (d.event.type === 'text' && d.event.content) {
          // Skip final 'text' if we already streamed deltas for this round (external runtime).
          // For local/cloud (no deltas), forward as before.
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

    // For development-v2, build the coder briefing from the sprint metadata
    // (touchesUI flag, designArtifactPath, affected screen/component IDs).
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
        logger.warn({ projectId, sprintIndex, err: briefingErr }, 'runSprint: could not build dev-v2 coder briefing, proceeding without it');
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
      // S4.2: NAO libera o lock per-projeto aqui. O sprint falhou mas o pipeline
      // entra em 'paused' aguardando user — paused mantem o lock ativo (R7/D4).
      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        logger.info({ projectId, sprintIndex }, 'runSprint: aborted during coder/evaluator loop');
        return;
      }
      const errMsg = (err as Error).message;
      logger.error({ err, projectId, sprintIndex }, 'runSprint: HarnessEngine.runSingleSprint failed');
      // Sprint 7 (SPEC §4.5 / LC-1): FAIL-site #3 (runSprint). The only fail-site
      // that emits pipeline:error BEFORE the paused status (errorFirst), the only
      // one with NO phase-changed, NO stream done, and that does NOT release the
      // lock (paused keeps it, INV-4). Pure-paused; sets state.status.
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

    // Clear bridge
    this.harnessEngine.clearStreamBridge();

    // S4.2: NAO libera o lock per-projeto aqui. O loop terminou mas o pipeline
    // continua (proximo sprint ou advance). Lock so libera em terminal state
    // (done/failed/aborted) ou recovery on boot.

    if (state.abortController.signal.aborted) {
      logger.info({ projectId, sprintIndex }, 'runSprint: aborted after coder/evaluator loop');
      return;
    }

    // Persist aggregated metrics for Coder and Evaluator phases.
    // Each sprint gets its own row via the sprint_index column.
    // Use the ACTUAL agent IDs from the sprint config.
    const actualCoderAgent = sprint.coderAgentId || (getPhaseAgentId(coderPhase, project) ?? 'harness-coder');
    const actualEvaluatorAgent = sprint.evaluatorAgentId || (getPhaseAgentId(evaluatorPhase, project) ?? 'harness-evaluator');

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
        // SPEC-006: propaga provider e costEstimationKind para fases agregadas (Coder).
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
        // BUG 3 F1 (bug-atividade-toolcalls-codex.md 3.3): sessionIds (uniao
        // do sprint; o merge do save em db.ts faz uniao array-aware entre
        // saves), proveniencia, snapshot de preco e breakdown por modelo —
        // sem isso a fase 13 (onde mora o grosso do residuo) fica cega pro F6.
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
        // SPEC-006: propaga provider e costEstimationKind para fases agregadas (Evaluator).
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
        // BUG 3 F1: mesmos campos novos da fase Coder acima (fase 14).
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

    // Automatically advance to next sprint or mark pipeline as complete
    const allSprints = getHarnessSprints(projectId);
    const nextSprintIndex = sprintIndex + 1;

    if (nextSprintIndex < allSprints.length) {
      // More sprints remaining — advance automatically
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
      // Last sprint completed — pipeline is done. Sprint 7 (SPEC §4.5 / LC-1):
      // unified done-tail. setStateIdle=true (runSprint sets idle BEFORE the
      // column write); the security-only Resolution Tracker runs POST-emit via
      // onCompleted (fire-and-forget, matches `void this.runResolutionTracker`).
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

  // -------------------------------------------------------------------------
  // Public API: acceptSprint / rejectSprint — user decision after max loops
  // -------------------------------------------------------------------------

  /**
   * Accept the current sprint with restrictions after max loops were exhausted.
   * Marks the sprint as accepted and advances to the next sprint (or completes
   * the pipeline if this was the last sprint).
   */
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
    logger.info({ projectId, sprintIndex, sprintName: sprint.name }, 'acceptSprint: user accepted sprint with restrictions');

    // Mark sprint as accepted (treat as passed despite failing evaluator)
    updateHarnessSprint(sprint.id, { status: 'passed', completedAt: new Date().toISOString() });

    emitIPC('pipeline:sprint-complete', {
      projectId,
      sprintIndex,
      sprintName: sprint.name,
      verdict: 'accepted-with-restrictions',
      rounds: sprint.roundsUsed ?? 0,
      metrics: {},
    });

    // Advance to next sprint or complete the pipeline
    const acceptProject = getHarnessProject(projectId);
    const acceptCoderPhase = (acceptProject ? getPhaseNumberForAgent(acceptProject, 'harness-coder') : undefined) ?? 13;
    const acceptCoderName = (acceptProject ? getPhaseName(acceptCoderPhase, acceptProject) : PHASE_NAMES[13]) ?? `Phase ${acceptCoderPhase}`;

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
      // Last sprint completed — pipeline is done. Sprint 7 (SPEC §4.5 / LC-1):
      // unified done-tail. setStateIdle=true (acceptSprint sets idle BEFORE the
      // column write); the security-only Resolution Tracker runs POST-emit via
      // onCompleted (fire-and-forget, matches `void this.runResolutionTracker`).
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

  /**
   * Reject the current sprint after max loops were exhausted and re-run it.
   * Resets the sprint status and reruns the coder+evaluator loop from scratch.
   * The sprintIndex parameter identifies which sprint to retry.
   */
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
    const rejectCoderName = (rejectProject ? getPhaseName(rejectCoderPhase, rejectProject) : PHASE_NAMES[13]) ?? `Phase ${rejectCoderPhase}`;

    // Reset sprint to pending so it can be re-executed
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

  // -------------------------------------------------------------------------
  // Public API: getPipelineReport — metrics summary at any point in time
  // -------------------------------------------------------------------------

  /**
   * Return aggregated pipeline metrics from the DB for a project.
   * Safe to call at any point in the pipeline execution.
   */
  getPipelineReport(projectId: string): PipelineMetrics {
    return getPipelineMetrics(projectId);
  }

  // -------------------------------------------------------------------------
  // Public API: resetPhase — reset a phase and everything after it
  // -------------------------------------------------------------------------

  /**
   * Reset the pipeline to a given phase.
   *
   * Only phases in RESETABLE_PHASES (1, 2, 4, 9, 11, 12) can be reset.
   * The method:
   *   1. Validates the phase is resetable.
   *   2. Aborts any in-flight execution for this project.
   *   3. Deletes artifact files produced from that phase onwards.
   *   4. Deletes DB rows (pipeline_messages, pipeline_phase_metrics, harness_sprints) from the phase.
   *   5. Updates the project status to idle at the reset phase.
   *   6. Emits pipeline:reset-complete to the renderer.
   *   7. If the phase is an AUTO phase, restarts it immediately.
   */
  async resetPhase(projectId: string, phase: number): Promise<{ ok: boolean; error?: string }> {
    return resetPhaseModule(this.buildResetEngineContext(), projectId, phase);
  }

  /**
   * Sprint 6 (SPEC §4.7 / INV-16): the engine surface the reset module calls.
   * Built per-call (like buildMessageRouterEngine) with bound delegates so test
   * spies on getState/updateProjectColumns/runAutoPhase/runSprint are honoured
   * and the methods stay private on this class.
   */
  private buildResetEngineContext(): ResetEngineContext {
    return {
      getState: (projectId) => this.getState(projectId),
      // The reset module only ever passes status 'idle' | 'running' (both valid
      // PipelineProject['status'] literals). The ctx type widens status to
      // `string`, so narrow it back at the boundary.
      updateProjectColumns: (projectId, columns) =>
        this.updateProjectColumns(projectId, columns as Parameters<typeof this.updateProjectColumns>[1]),
      runAutoPhase: (projectId, phase) => this.runAutoPhase(projectId, phase),
      runSprint: (projectId, sprintIndex) => this.runSprint(projectId, sprintIndex),
    };
  }

  /**
   * Sprint 7 (SPEC §4.5 / INV-16): the engine surface the lifecycle module calls.
   * Built per-call (like buildResetEngineContext / buildMessageRouterEngine) with
   * bound delegates so test spies on getState / closeCodexSessions /
   * resolveCurrentModelForPhase / runAutoPhase / runSprint are honoured and the
   * methods stay private on this class (AC-9). PhaseState is a width-superset of
   * LifecyclePhaseState; the `as` casts narrow at the boundary (the same trick as
   * the reset ctx).
   */
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

  /**
   * Sprint 8A (SPEC §4 / INV-16): the engine surface the per-pipelineType handler
   * modules (handlers/*.ts) call. Built per-call (like buildLifecycleEngineContext
   * / buildResetEngineContext) with bound delegates so test spies on spawnAgent /
   * collectMetrics / accumulateMetrics / advanceToNextPhase /
   * buildPriorMessagesForPhase / makeConversationOnText are honoured and the
   * methods stay on this class (AC-9). spawnAgent is exposed here, never copied —
   * it remains the ONLY executeAgent entry point (INV-2). PhaseState is a
   * width-superset of HandlerPhaseState; the `as` casts narrow at the boundary
   * (the same trick as the reset / lifecycle ctx).
   */
  private buildPipelineEngineContext(): PipelineEngineContext {
    return {
      sendMessage: (projectId, message, opts) => this.sendMessage(projectId, message, undefined, opts),
      spawnAgent: (agentId, rawPrompt, opts) => this.spawnAgent(agentId, rawPrompt, opts),
      collectMetrics: (projectId, phaseNumber, agentId, result, status, projectCtx) =>
        this.collectMetrics(projectId, phaseNumber, agentId, result, status, projectCtx),
      accumulateMetrics: (state, phaseNumber, result) =>
        this.accumulateMetrics(state as PhaseState, phaseNumber, result),
      // 8A.3: getState / failPhase / createEmptyMetrics / mergeMetrics /
      // updateProjectColumns are needed by the dev-feature runners (runPhase9 the
      // only one that calls getState/failPhase/merge; runPhase4 calls
      // updateProjectColumns). PhaseState is a width-superset of HandlerPhaseState;
      // narrow at the boundary (same trick as the reset / lifecycle ctx).
      getState: (projectId) => this.getState(projectId),
      createEmptyMetrics: () => this.createEmptyMetrics(),
      mergeMetrics: (accum, result) => this.mergeMetrics(accum, result),
      failPhase: (projectId, state, opts) =>
        this.failPhase(projectId, state as PhaseState, opts),
      advanceToNextPhase: (projectId, state) =>
        this.advanceToNextPhase(projectId, state as PhaseState),
      buildPriorMessagesForPhase: (projectId, phaseNumber) =>
        this.buildPriorMessagesForPhase(projectId, phaseNumber),
      makeConversationOnText: (projectId, phase, accumulatedRef) =>
        this.makeConversationOnText(projectId, phase, accumulatedRef),
      updateProjectColumns: (projectId, columns) =>
        this.updateProjectColumns(projectId, columns as Parameters<typeof this.updateProjectColumns>[1]),
      // 8A.4: dev-v2 runners need flushAccumulatedMetrics / buildDesignLockPathsBlock /
      // runPhase11WithBriefing / handleDevV2Phase12SpecReview. All bound late so the
      // lifecycle + dev-v2-phase12-gate spies on flushAccumulatedMetrics /
      // handleDevV2Phase12SpecReview are honoured and the methods stay on the class.
      flushAccumulatedMetrics: (projectId, phaseNumber, agentId, state, status, projectCtx, includePersisted) =>
        this.flushAccumulatedMetrics(projectId, phaseNumber, agentId, state as PhaseState, status, projectCtx, includePersisted),
      buildDesignLockPathsBlock: (project) => this.buildDesignLockPathsBlock(project),
      runPhase11WithBriefing: (projectId, state, briefing) =>
        this.runPhase11WithBriefing(projectId, state as PhaseState, briefing),
      handleDevV2Phase12SpecReview: (projectId, message, state) =>
        this.handleDevV2Phase12SpecReview(projectId, message, state as PhaseState),
      harnessEngine: this.harnessEngine,
      // 8A.2: bind the SecurityAuditRunner to the live engine `this` so phase 2's
      // multi-agent fan-out keeps using the single spawnAgent (INV-2 unchanged).
      createSecurityAuditRunner: () => new SecurityAuditRunner(this),
      createBugAnalysisRunner: () => new BugAnalysisRunner(this),
      PHASE_COMPLETE_MARKER: this.PHASE_COMPLETE_MARKER,
    };
  }

  /**
   * Sprint 7 (SPEC §4.5 / LC-1): thin wrapper the 4 done-sites call so the
   * "pipeline complete" tail lives once in lifecycle.ts. Keeps the divergent
   * axes (terminalStatusString / setStateIdle / metadata / onCompleted) explicit
   * at each call-site.
   */
  private completePipeline(
    projectId: string,
    state: PhaseState,
    opts: CompletePipelineOptions,
  ): void {
    completePipelineModule(this.buildLifecycleEngineContext(), projectId, state, opts);
  }

  /**
   * Sprint 7 (SPEC §4.5 / LC-1 / RK-8): thin wrapper the 5 fail-sites call so the
   * "phase failed -> pause (never persist 'failed', INV-6)" tail lives once. The
   * per-site metric writes stay at the call-site (they run BEFORE this).
   */
  private failPhase(projectId: string, state: PhaseState, opts: FailPhaseOptions): void {
    failPhaseModule(this.buildLifecycleEngineContext(), projectId, state, opts);
  }

  // -------------------------------------------------------------------------
  // Public API: resetSprint — reset a single sprint and re-run from it
  // -------------------------------------------------------------------------

  /**
   * Reset a specific sprint by index.
   *
   * Deletes the round data, messages, and metrics for that sprint, resets its
   * status to pending, and then re-runs it followed by any remaining pending
   * sprints.
   */
  async resetSprint(projectId: string, sprintIndex: number): Promise<{ ok: boolean; error?: string }> {
    return resetSprintModule(this.buildResetEngineContext(), projectId, sprintIndex);
  }

  // -------------------------------------------------------------------------
  // Public API: getResetPreview — preview what will be deleted on reset
  // -------------------------------------------------------------------------

  /**
   * Return a preview of what a reset operation would delete, without
   * performing any destructive action.
   *
   * Accepts either `phase` or `sprintIndex` in the `target` object.
   */
  getResetPreview(
    projectId: string,
    target: { phase?: number; sprintIndex?: number },
  ): ResetPreview {
    return getResetPreviewModule(this.buildResetEngineContext(), projectId, target);
  }

  // -------------------------------------------------------------------------
  // Development-v2 pipeline handlers
  // -------------------------------------------------------------------------

  /**
   * Dispatches auto phases for the development-v2 pipeline.
   * Phase 4 generates the Design Plan prompt; phase 6 runs the Design Lock.
   */
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

  /**
   * Runs Phase 2 of development-v2 (User Stories/PRD) with an optional briefing.
   * Reuses the standard prd-generator agent.
   */
  private async runPhase2WithBriefing(
    projectId: string,
    projectPath: string,
    state: PhaseState,
    briefing: string | null,
  ): Promise<void> {
    // Sprint 8A.4: body moved to handlers/development-v2.ts. Thin late-bound
    // delegator (ctx built per call) so the dispatch via this.runPhase2WithBriefing
    // is unchanged.
    await runPhase2WithBriefingModule(this.buildPipelineEngineContext(), projectId, projectPath, state, briefing);
  }

  /**
   * Phase 4 of development-v2: explicit Design Plan.
   *
   * Produces the official `open-design-prompt.md` consumed by phase 5. This is
   * intentionally not hidden inside the Open Design bootstrap.
   */
  private async runDevV2Phase4DesignPlan(
    projectId: string,
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
    state: PhaseState,
  ): Promise<void> {
    // Sprint 8A.4: body moved to handlers/development-v2.ts. Thin late-bound delegator.
    await runDevV2Phase4DesignPlanModule(this.buildPipelineEngineContext(), projectId, project, state);
  }

  // -------------------------------------------------------------------------
  // Sprint 4 (SPEC L875-903): Design Lock paths block — injected into user
  // messages of dev-v2 phases 7, 8, 9, 10, 11, 12 quando o lock esta aprovado.
  // Delegamos ao helper standalone em ./dev-v2-lock-paths para facilitar
  // teste unitario.
  // -------------------------------------------------------------------------

  private buildDesignLockPathsBlock(
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
  ): string | null {
    return buildDesignLockPathsBlockHelper({
      id: project.id,
      projectPath: project.projectPath,
      pipelineType: project.pipelineType,
      pipelineDocsId: project.pipelineDocsId ?? null,
      config: project.config,
    });
  }

  // -------------------------------------------------------------------------
  // Phase 6 of development-v2: Design Lock gate (Sprint 5)
  // -------------------------------------------------------------------------

  private async runDevV2Phase6DesignLock(
    projectId: string,
    state: PhaseState,
  ): Promise<void> {
    // Sprint 8A.4: body moved to handlers/development-v2.ts. Thin late-bound delegator.
    await runDevV2Phase6DesignLockModule(this.buildPipelineEngineContext(), projectId, state);
  }

  /**
   * Phase 7 of development-v2: PRD Completo using pipe2-prd-completo agent.
   */
  private async runDevV2Phase7PrdCompleto(
    projectId: string,
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
    state: PhaseState,
  ): Promise<void> {
    // Sprint 8A.4: body moved to handlers/development-v2.ts. Thin late-bound delegator.
    await runDevV2Phase7PrdCompletoModule(this.buildPipelineEngineContext(), projectId, project, state);
  }

  /**
   * Phase 12 of development-v2: SPEC Generation.
   *
   * Espelha runPhase9 (dev/feature): loop builder -> validator (max 3 rounds)
   * e, ao terminar, entra em revisao conversacional (status awaiting-spec-review)
   * na MESMA fase 12, com o pipe2-spec-validator. Sem renumeracao e sem fase nova.
   *
   * INVARIANTE (R6 ADR / SPEC-007 2.1.1): usa PIPE2_SPEC_VALIDATOR_ID (validator
   * DEDICADO do dev-v2 que valida a SPEC contra o contrato de design/frontend) —
   * NUNCA o SPEC_VALIDATOR_ID compartilhado.
   */
  private async runDevV2Phase12SpecGeneration(
    projectId: string,
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
    state: PhaseState,
  ): Promise<void> {
    // Sprint 8A.4: body moved to handlers/development-v2.ts. STAYS a class method
    // (dev-v2-phase12-gate + lifecycle characterization spy this directly on the
    // instance). Thin late-bound delegator; the moved body reaches
    // handleDevV2Phase12SpecReview / flushAccumulatedMetrics back through ctx.
    await runDevV2Phase12SpecGenerationModule(this.buildPipelineEngineContext(), projectId, project, state);
  }

  /**
   * Phase 12 of development-v2 (conversational review): continues the
   * pipe2-spec-validator session opened after the auto loop. Espelha
   * handlePhase9Message adaptado para o validator DEDICADO do dev-v2.
   */
  private async handleDevV2Phase12SpecReview(
    projectId: string,
    message: string,
    state: PhaseState,
  ): Promise<void> {
    // Sprint 8A.4: body moved to handlers/development-v2.ts. STAYS a class method
    // (dev-v2-phase12-gate spies engine.handleDevV2Phase12SpecReview). Thin
    // late-bound delegator.
    await handleDevV2Phase12SpecReviewModule(this.buildPipelineEngineContext(), projectId, message, state);
  }

  /**
   * Phase 14 of development-v2: Planner with DevelopmentV2SprintMetadata briefing.
   *
   * Reads the locked design-contract.json (if available) to extract screenIds and
   * componentIds, builds the dev-v2 planner briefing, then delegates to runPhase11
   * (which calls harnessEngine.plan with the briefing).
   *
   * Per Sprint 6 task 6.4 and SPEC L946-974.
   */
  private async runDevV2Phase14Planner(
    projectId: string,
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
    state: PhaseState,
  ): Promise<void> {
    // Sprint 8A.4: body moved to handlers/development-v2.ts. Thin late-bound delegator.
    await runDevV2Phase14PlannerModule(this.buildPipelineEngineContext(), projectId, project, state);
  }

  // Sprint 4 (SPEC §4.6): `handleDevV2Message` was inlined into the
  // message-router (DEV_V2_ROUTES + devV2Briefing/devV2LockPrefix/devV2TechInvoke
  // in ./message-router). The per-phase briefing (briefingPhases [1,2,3,8,9,11,15])
  // and the design-lock prefix (tech phases 8-11, first turn only) are replicated
  // there byte-for-byte. Phase 5's refuse-chat is the descriptor's `refuseChat`
  // flag (sendMessage emits the silent `done`). The per-phase dev-v2 sub-handlers
  // (handlePhase1MessageDevV2, handlePhase3MessageDevV2, handleDevV2Phase12SpecReview,
  // handleDevV2Phase13SpecEnricher) remain methods of this class and are invoked
  // late-bound through `this` by the router (spies preserved, INV-16).

  /**
   * Phase 1 of development-v2: Discovery conversation (reuses discovery-agent with optional briefing).
   */
  private async handlePhase1MessageDevV2(
    projectId: string,
    message: string,
    state: PhaseState,
    briefing: string | null,
  ): Promise<void> {
    // Sprint 8A.4: body moved to handlers/development-v2.ts. Thin late-bound delegator.
    await handlePhase1MessageDevV2Module(this.buildPipelineEngineContext(), projectId, message, state, briefing);
  }

  /**
   * Phase 3 of development-v2: PRD Validator conversation (reuses prd-validator with optional briefing).
   */
  private async handlePhase3MessageDevV2(
    projectId: string,
    message: string,
    state: PhaseState,
    briefing: string | null,
  ): Promise<void> {
    // Sprint 8A.4: body moved to handlers/development-v2.ts. Thin late-bound delegator.
    await handlePhase3MessageDevV2Module(this.buildPipelineEngineContext(), projectId, message, state, briefing);
  }

  /**
   * Phase 13 of development-v2: Spec Enricher conversation using pipe2-spec-enricher.
   */
  private async handleDevV2Phase13SpecEnricher(
    projectId: string,
    message: string,
    state: PhaseState,
  ): Promise<void> {
    // Sprint 8A.4: body moved to handlers/development-v2.ts. Thin late-bound delegator.
    await handleDevV2Phase13SpecEnricherModule(this.buildPipelineEngineContext(), projectId, message, state);
  }

  /**
   * Finalizes a development-v2 conversation phase approval and advances.
   */
  private async finalizeDevV2ConversationPhase(
    projectId: string,
    phase: number,
    state: PhaseState,
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
  ): Promise<void> {
    // Sprint 8A.4: body moved to handlers/development-v2.ts. Thin late-bound delegator.
    await finalizeDevV2ConversationPhaseModule(this.buildPipelineEngineContext(), projectId, phase, state, project);
  }
}
