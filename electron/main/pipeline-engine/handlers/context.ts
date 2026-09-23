import type { AgentConfig } from '../../../../src/types';
import type { OllamaChatMessage, OllamaToolCallRecord } from '../../ollama-client';
import type { getHarnessProject } from '../../db';
import type { SecurityAuditRunner } from '../../security-audit-runner';
import type { BugAnalysisRunner } from '../../bug-analysis-runner';
import type { HarnessEngine } from '../../harness-engine';
import type { FailPhaseOptions } from '../lifecycle';

export type ResolvedHarnessProject = NonNullable<ReturnType<typeof getHarnessProject>>;

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
  rebuildPromptOnRetry?: () => string;
}

export type PriorMessages = OllamaChatMessage[] | undefined;

export interface HandlerPhaseState {
  abortController: AbortController;
  continueSessions: Map<string, { alive: boolean }>;
  currentPhase: number;
  status: 'idle' | 'running' | 'paused' | 'aborted';
}

export type HandlerProject = { pipelineType?: string } & object;

export interface PipelineEngineContext {
  sendMessage(
    projectId: string,
    message: string,
    opts?: { isGreeting?: boolean; rethrowPause?: boolean },
  ): Promise<{ error: string } | void>;

  spawnAgent(agentId: string, rawPrompt: string, opts: SpawnAgentOptions): Promise<SpawnAgentResult>;

  collectMetrics(
    projectId: string,
    phaseNumber: number,
    agentId: string,
    result: SpawnAgentResult,
    status: 'completed' | 'failed',
    projectCtx?: { pipelineType?: string },
  ): void;

  accumulateMetrics(state: HandlerPhaseState, phaseNumber: number, result: SpawnAgentResult): void;

  getState(projectId: string): HandlerPhaseState;

  createEmptyMetrics(): SpawnAgentResult['metrics'];

  mergeMetrics(accum: SpawnAgentResult['metrics'], result: SpawnAgentResult['metrics']): void;

  failPhase(projectId: string, state: HandlerPhaseState, opts: FailPhaseOptions): void;

  advanceToNextPhase(projectId: string, state: HandlerPhaseState): Promise<void>;

  buildPriorMessagesForPhase(projectId: string, phaseNumber: number): PriorMessages;

  makeConversationOnText(
    projectId: string,
    phase: number,
    accumulatedRef: { text: string; completed: boolean },
  ): (chunk: string) => void;

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

  readonly harnessEngine: HarnessEngine;

  flushAccumulatedMetrics(
    projectId: string,
    phaseNumber: number,
    agentId: string,
    state: HandlerPhaseState,
    status: 'completed' | 'failed',
    projectCtx?: { pipelineType?: string },
    includePersisted?: boolean,
  ): void;

  buildDesignLockPathsBlock(project: ResolvedHarnessProject): string | null;

  runPhase11WithBriefing(projectId: string, state: HandlerPhaseState, briefing: string | null): Promise<void>;

  handleDevV2Phase12SpecReview(projectId: string, message: string, state: HandlerPhaseState): Promise<void>;

  createSecurityAuditRunner(): SecurityAuditRunner;

  createBugAnalysisRunner(): BugAnalysisRunner;

  readonly PHASE_COMPLETE_MARKER: string;
}
