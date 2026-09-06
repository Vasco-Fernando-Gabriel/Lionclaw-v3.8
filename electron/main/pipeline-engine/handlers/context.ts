/**
 * PipelineEngineContext — the explicit dependency surface the extracted
 * per-pipelineType handler modules (handlers/*.ts) close over.
 *
 * Sprint 8A (SPEC §4 / spec-pipeline-engine-sprint8a-handlers.md): the handler
 * bodies that used to live inline in `PipelineEngine` (index.ts) were moved
 * VERBATIM into handlers/<type>.ts and reparameterized from `this.X` to an
 * injected `ctx: PipelineEngineContext` — exactly the late-bound `buildXEngine`
 * pattern already used by reset.ts / message-router.ts / lifecycle.ts (waves
 * 3-5). `index.ts` builds the ctx per call (`buildXEngineContext()`) with bound
 * delegates so test spies on these methods are still observed and the methods
 * stay on the class (INV-16 / AC-9).
 *
 * This is a SHARED context: 8A.1 (architecture-review) defines it; 8A.2-8A.4
 * (security / dev-feature / development-v2) reuse and extend it. Only the subset
 * a given module actually touches has to be populated — but the interface
 * declares the full surface so every module sees a single consistent ctx type.
 *
 * INVARIANTS PRESERVED
 *  - INV-2 (R8): `spawnAgent` is the ONLY executeAgent entry point. It lives on
 *    the class in index.ts and is exposed here via ctx; the handlers NEVER call
 *    executeAgent directly nor hold a second copy. `caller-permission-snapshot`
 *    keeps seeing exactly 1 `executeAgent({` in index.ts.
 *  - INV-13 (SQL only in db.ts): the handlers go through the same db.ts helpers
 *    / persistMessage they used inline; no new SQL is introduced here.
 */

import type { AgentConfig } from '../../../../src/types';
import type { OllamaChatMessage, OllamaToolCallRecord } from '../../ollama-client';
import type { getHarnessProject } from '../../db';
import type { SecurityAuditRunner } from '../../security-audit-runner';
import type { BugAnalysisRunner } from '../../bug-analysis-runner';
import type { HarnessEngine } from '../../harness-engine';
import type { FailPhaseOptions } from '../lifecycle';

/**
 * Resolved-project shape the development-v2 runners take by parameter (8A.4).
 * Byte-identical to the index.ts method signatures
 * (`NonNullable<ReturnType<typeof getHarnessProject>>`) so the moved bodies and
 * the ctx.buildDesignLockPathsBlock delegate type-check exactly as inline.
 */
export type ResolvedHarnessProject = NonNullable<ReturnType<typeof getHarnessProject>>;

/**
 * Normalized result from spawnAgent(). Structural copy of the `SpawnAgentResult`
 * interface defined in index.ts (not exported there); kept in sync so ctx
 * delegates type-check at the boundary without index.ts having to export it.
 */
export interface SpawnAgentResult {
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

/** Options passed to spawnAgent(). Structural copy of index.ts `SpawnAgentOptions`. */
export interface SpawnAgentOptions {
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
  /**
   * SC-1 (SPEC robustez-chat, Pilar C): reconstroi o prompt de retomada CRU
   * (preambulo do first-turn + historico da fase + msg do usuario) para o retry
   * unico quando a CodexSession cacheada de um follow-up morreu (idle-reaper).
   * Copia estrutural do campo homonimo em index.ts `SpawnAgentOptions`.
   */
  rebuildPromptOnRetry?: () => string;
}

/**
 * Prior-message history shape `buildPriorMessagesForPhase` returns. This is the
 * EXACT declared return type of the index.ts method (the db.ts chat-history
 * element type), kept byte-identical so the ctx delegate and the handler
 * `priorMessages:` assignments type-check exactly as they did inline — including
 * the 4 pre-existing baseline tool_calls/arguments mismatches that simply
 * relocate from index.ts into the handler module (the 37-error conjunto is
 * preserved, not grown).
 */
export type PriorMessages = OllamaChatMessage[] | undefined;

/**
 * The PhaseState fields the extracted handlers touch DIRECTLY (abortController +
 * continueSessions). The full PhaseState (defined in index.ts) is a
 * width-superset; index.ts narrows it with an `as` cast at the ctx boundary
 * (the same trick reset.ts / lifecycle.ts use). `phaseMetricAccum` is touched
 * only inside `accumulateMetrics`, which is itself a ctx delegate, so it does
 * not need to appear here — the delegate receives the real PhaseState.
 */
export interface HandlerPhaseState {
  abortController: AbortController;
  continueSessions: Map<string, { alive: boolean }>;
  /**
   * 8A.4: runDevV2Phase6DesignLock writes `state.currentPhase = 5` /
   * `state.status = 'running'` directly on the rejection-final paths. These are a
   * subset of the index.ts `PhaseState` (same field types) so the `as PhaseState`
   * narrowing at the ctx boundary stays sound.
   */
  currentPhase: number;
  status: 'idle' | 'running' | 'paused' | 'aborted';
}

/** Resolved project (NonNullable<getHarnessProject>) passed opaquely to handlers. */
export type HandlerProject = { pipelineType?: string } & object;

/**
 * The PipelineEngine surface the handler modules call. PipelineEngine implements
 * it structurally; `buildXEngineContext()` in index.ts returns an object of bound
 * delegates (late-bound so spies are honoured). Each module uses only the subset
 * it needs.
 */
export interface PipelineEngineContext {
  sendMessage(
    projectId: string,
    message: string,
    opts?: { isGreeting?: boolean; rethrowPause?: boolean },
  ): Promise<{ error: string } | void>;

  /** The ONLY executeAgent entry point (INV-2). Lives on the class. */
  spawnAgent(
    agentId: string,
    rawPrompt: string,
    opts: SpawnAgentOptions,
  ): Promise<SpawnAgentResult>;

  /** Persist + UPSERT phase metrics for a finished agent run (auto phases). */
  collectMetrics(
    projectId: string,
    phaseNumber: number,
    agentId: string,
    result: SpawnAgentResult,
    status: 'completed' | 'failed',
    projectCtx?: { pipelineType?: string },
  ): void;

  /** Accumulate metrics for a conversation/loop round into the PhaseState. */
  accumulateMetrics(
    state: HandlerPhaseState,
    phaseNumber: number,
    result: SpawnAgentResult,
  ): void;

  /**
   * Rehydrate/return the in-RAM PhaseState (the only writer of this.states lives
   * on the class). Exposed for runPhase9, the only dev-feature runner that does
   * NOT receive `state` by parameter (it's `runPhase9(projectId)`); the others
   * are handed `state` by the caller. The returned object is the full PhaseState
   * narrowed to HandlerPhaseState at the index.ts boundary (same width-superset
   * trick as the reset / lifecycle ctx).
   */
  getState(projectId: string): HandlerPhaseState;

  /**
   * Fresh zeroed metrics accumulator (8A.3 / runPhase9 builder+validator aggs).
   * Structural copy of the index.ts private createEmptyMetrics().
   */
  createEmptyMetrics(): SpawnAgentResult['metrics'];

  /**
   * Fold one run's metrics into an accumulator in place (8A.3 / runPhase9).
   * Structural copy of the index.ts private mergeMetrics(); propagates the
   * worst cost/token status across rounds, byte-identical to the inline body.
   */
  mergeMetrics(
    accum: SpawnAgentResult['metrics'],
    result: SpawnAgentResult['metrics'],
  ): void;

  /**
   * The unified fail-tail (Sprint 7 lifecycle.ts / LC-1). runPhase9 is the only
   * dev-feature method that fails a phase; it calls this with FAIL-site #2's
   * exact axes (pure-paused + error + phase-changed, no stream-done, sets
   * state.status). PhaseState is narrowed to HandlerPhaseState at the boundary.
   */
  failPhase(projectId: string, state: HandlerPhaseState, opts: FailPhaseOptions): void;

  /** Advance the pipeline to the next phase (auto-advance after an auto phase). */
  advanceToNextPhase(projectId: string, state: HandlerPhaseState): Promise<void>;

  /** Build prior-turn chat history for a conversation follow-up (external runtime). */
  buildPriorMessagesForPhase(projectId: string, phaseNumber: number): PriorMessages;

  /**
   * Build the streaming onText callback for a conversation phase (handles the
   * PHASE_COMPLETE marker + emits pipeline:stream / pipeline:agent-completed).
   */
  makeConversationOnText(
    projectId: string,
    phase: number,
    accumulatedRef: { text: string; completed: boolean },
  ): (chunk: string) => void;

  /**
   * Composite pipeline_* column writer (D3) — also emits pipeline:project-updated.
   * runPhase4 uses it to persist prdPath. `status` is widened to string at the
   * ctx boundary (same as the reset / lifecycle ctx); index.ts narrows it back.
   */
  updateProjectColumns(
    projectId: string,
    columns: {
      pipelineCurrentPhase?: number | null;
      pipelineStartPhase?: number | null;
      discoveryNotesPath?: string | null;
      prdPath?: string | null;
      status?: string;
      pipelineSprintIndex?: number;
      pipelineDiscoveryBlock?: number;
    },
  ): void;

  /**
   * The live HarnessEngine, referenced (never contained) — same as the lifecycle
   * ctx's abortHarness. runPhase11 (Planner) drives it directly via
   * setStreamBridge / plan / clearStreamBridge; bridging those forwards the
   * harness stream as pipeline:stream. INV-14 unchanged: loop phases delegate to
   * the HarnessEngine, NOT spawnAgent.
   */
  readonly harnessEngine: HarnessEngine;

  /**
   * Flush the per-phase accumulated metrics (conversation/loop follow-ups) to the
   * DB (8A.4 / dev-v2). runDevV2Phase12SpecGeneration (fail tail) and
   * finalizeDevV2ConversationPhase call it; the lifecycle characterization spies
   * `engine.flushAccumulatedMetrics`, so this MUST be late-bound through the class
   * method (the index.ts ctx builder binds `this.flushAccumulatedMetrics`).
   * PhaseState is narrowed to HandlerPhaseState at the boundary.
   */
  flushAccumulatedMetrics(
    projectId: string,
    phaseNumber: number,
    agentId: string,
    state: HandlerPhaseState,
    status: 'completed' | 'failed',
    projectCtx?: { pipelineType?: string },
    includePersisted?: boolean,
  ): void;

  /**
   * Build the design-lock paths block injected into dev-v2 prompts when the Open
   * Design lock is approved (8A.4). Stays a class method because
   * buildMessageRouterEngine binds it for the tech-phase prefix; exposed here so
   * the moved runners (Phase7 PRD Completo, Phase12 Spec Generation, Phase12 Spec
   * Review) prefix the agent prompt identically to the inline code.
   */
  buildDesignLockPathsBlock(project: ResolvedHarnessProject): string | null;

  /**
   * Run the shared Planner (phase 11/14) with an optional briefing prefix (8A.4).
   * runDevV2Phase14Planner delegates here after extracting the design-contract
   * IDs. Stays on the class (it wraps the generic runPhase11, shared with
   * dev/feature/security); exposed via ctx so the dev-v2 runner can call it.
   * INV-14 unchanged: runPhase11 drives the HarnessEngine, NOT spawnAgent.
   */
  runPhase11WithBriefing(
    projectId: string,
    state: HandlerPhaseState,
    briefing: string | null,
  ): Promise<void>;

  /**
   * The dev-v2 phase-12 conversational review handler (8A.4). Kept a class method
   * (the dev-v2-phase12-gate test spies `engine.handleDevV2Phase12SpecReview`);
   * runDevV2Phase12SpecGeneration triggers the post-loop greeting through this
   * ctx delegate so the spy is observed exactly as inline.
   */
  handleDevV2Phase12SpecReview(
    projectId: string,
    message: string,
    state: HandlerPhaseState,
  ): Promise<void>;

  /**
   * Construct a SecurityAuditRunner bound to the live PipelineEngine instance
   * (8A.2 / security phase 2). The runner's constructor needs the engine `this`
   * so it can call `pipelineEngine.spawnAgent` for its 7 parallel specialists.
   * The factory lives on the class (index.ts builds it as `() => new
   * SecurityAuditRunner(this)`) so the `this`-binding stays where the engine
   * lives — INV-2 is unchanged because the runner reuses the SAME spawnAgent,
   * the single executeAgent entry point; no executeAgent is added here.
   */
  createSecurityAuditRunner(): SecurityAuditRunner;

  /**
   * Construct a BugAnalysisRunner bound to the live PipelineEngine (Bug Pipe
   * phase 2 / SPEC spec-sdk-e-bug-pipe.md secao 4.7). Exact mirror of
   * `createSecurityAuditRunner`: the factory lives on the class (index.ts builds
   * it as `() => new BugAnalysisRunner(this)`) so the `this`-binding stays where
   * the engine lives. INV-2 is unchanged — the runner reuses the SAME
   * spawnAgent for its 3 parallel analysts; no executeAgent is added here.
   */
  createBugAnalysisRunner(): BugAnalysisRunner;

  /** The literal [PHASE_COMPLETE] marker the agents emit to signal completion. */
  readonly PHASE_COMPLETE_MARKER: string;
}
