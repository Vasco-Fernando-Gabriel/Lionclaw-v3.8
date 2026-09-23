import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import { extractJSON } from './json-extractor';
import { ensureNodeInPath } from './pipeline-shared/sdk-bootstrap';
import { emitIPC } from './pipeline-shared/ipc-emitter';
import { setProjectStatus } from './pipeline-shared/status';
import {
  persistClaimedHarnessEvaluatorCompletion,
  persistMessage,
  persistHarnessRound,
} from './pipeline-shared/persist';

import {
  getHarnessProject,
  updateHarnessProject,
  getHarnessSprints,
  updateHarnessSprint,
  getAgent,
  getAllAgents,
  getEnrichSession,
  updateEnrichSession,
  accumulateEnrichMetrics,
  advanceClaimedHarnessProviderAuthCheckpoint,
  claimHarnessProviderAuthCheckpoint,
  completeHarnessProviderAuthCheckpoint,
  getHarnessProviderAuthCheckpoint,
  persistHarnessProviderAuthCheckpoint,
} from './db';
import {
  buildPlannerPrompt,
  buildPlannerMarkdownPrompt,
  buildRegenerationPrompt,
  parsePlannerOutput,
  parsePlannerMarkdown,
  saveSprintsJson,
  readHarnessSprintsJson,
  reseedHarnessSprintsFromFile,
  checkHarnessSprintQueueIntegrity,
} from './harness-planner';
import type { SprintJsonEntry, SprintsJson } from './harness-planner';
import {
  buildCoderPrompt,
  buildCoderFeedbackPrompt,
  buildValidatorPrompt,
  buildEnricherPrompt,
  buildValidatorFollowUpPrompt,
  buildEnricherFollowUpPrompt,
} from './harness-prompts';
import {
  buildEvaluatorPrompt,
  parseEvaluationOutput,
  validateCriteria,
  updateSpecProgress,
  buildFeedbackFromEvaluation,
} from './harness-evaluator';
import { setActiveEnrichSpecPath, createEnrichPermissionGuard } from './permission-guard';
import { executeAgent } from './agent-runtime';
import {
  PipelinePausedError,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type SubagentDispatchContext,
} from './agent-runtime/types';
import { createSubagentDispatchContext, pendingSubagentProviderAuthError } from './agent-runtime/subagent-dispatch';
import { GrokAuthError } from './agent-runtime/grok-availability';
import { KimiAuthError } from './agent-runtime/kimi-availability';
import { CodexAuthError } from './codex-runtime/errors';
import { PERM_BYPASS_NO_GUARD, PERM_DEFAULT_WITH_GUARD } from './agent-runtime/permission-profiles';
import { ollamaChatWithTools } from './ollama-client';
import type { OllamaChatResult } from './ollama-client';
import { getSecret } from './vault-registry';
import type {
  EvaluationResult,
  CreateEnrichConfig,
  EnrichPhase,
  ExternalConfig,
  AgentConfig,
  HarnessProviderAuthCheckpoint,
} from '../../src/types';
import { getPhaseNumberForAgent } from '../../src/types/pipeline';
import { mergeUsageMetadata } from './pipeline-engine/metrics';
import { runSmokeTest, writeSmokeTestReport } from './smoke-test-runner';
import {
  getPipelineDocsContext,
  resolveSpecPath,
  resolveSpecProgressPath,
  resolveHarnessSprintsPath,
} from './pipeline-paths';
import { getArchitectureReviewContext } from './architecture-review-paths';
import { getBugContext } from './bug-paths';

const logger = createLogger('harness-engine');

export async function resolveExternalAuth(config: ExternalConfig): Promise<Record<string, string>> {
  const apiKey = await getSecret(config.apiKeyRef);
  if (!apiKey) {
    throw new Error(
      `API key nao encontrada no Vault para provider "${config.apiKeyRef}". ` + `Configure em Configuracoes > Vault.`,
    );
  }
  return {
    ...(config.extraHeaders ?? {}),
    'Authorization': `Bearer ${apiKey}`,
  };
}

export async function ollamaChatWithRetry(...args: Parameters<typeof ollamaChatWithTools>): Promise<OllamaChatResult> {
  const MAX_RETRIES = 5;
  const DEFAULT_429_WAIT_MS = 30_000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await ollamaChatWithTools(...args);
    } catch (err) {
      const errMsg = (err as Error).message || '';
      const is429 = errMsg.includes('HTTP 429');
      const is5xx = /HTTP 5\d\d/.test(errMsg);

      if ((!is429 && !is5xx) || attempt === MAX_RETRIES) {
        throw err;
      }

      let waitMs: number;
      if (is429) {
        const retryAfterMatch = errMsg.match(/Retry-After:\s*(\d+)/i);
        waitMs = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) * 1000 : DEFAULT_429_WAIT_MS;
      } else {
        waitMs = Math.min(2000 * Math.pow(2, attempt), 30_000);
      }

      logger.warn(
        {
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          waitMs,
          statusType: is429 ? '429' : '5xx',
          model: args[1],
          errPreview: errMsg.substring(0, 200),
        },
        'External request failed, retrying',
      );

      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  throw new Error('Retry exhausted');
}

export function computePricingKey(extCfg: ExternalConfig): string {
  if (extCfg.provider === 'openrouter') return `or:${extCfg.model}`;
  return extCfg.model;
}

export function mapReasoningParams(
  effort: AgentConfig['effort'] | undefined,
  thinking: AgentConfig['thinking'] | undefined,
  _thinkingBudget: number | undefined,
  provider: ExternalConfig['provider'],
  model: string,
): Partial<Record<string, unknown>> {
  const reasoningEffort = effort === 'max' ? 'high' : (effort ?? 'medium');

  if (provider === 'openai' && (model.startsWith('gpt-5.5') || model.startsWith('o'))) {
    if (thinking === 'disabled') return {};
    return { reasoning_effort: reasoningEffort };
  }

  if (provider === 'openrouter') {
    if (model.startsWith('openai/gpt-5')) {
      return thinking === 'disabled' ? {} : { reasoning_effort: reasoningEffort };
    }
    if (model.startsWith('qwen/qwen3.6') && thinking !== 'disabled') {
      return { thinking: { type: 'enabled' } };
    }
    // Kimi K2 Thinking e DeepSeek-Reasoner: reasoning embutido no slug, sem param adicional
  }

  return {};
}

export function isContextLengthError(errorMessage: string): boolean {
  return (
    /context.*(length|limit|exceed|too long)/i.test(errorMessage) ||
    /maximum.*tokens/i.test(errorMessage) ||
    /token.*limit.*exceeded/i.test(errorMessage) ||
    errorMessage.includes('context_length_exceeded')
  );
}

type SubscriptionProvider = 'grok' | 'codex' | 'kimi';
type SubscriptionAuthError = GrokAuthError | CodexAuthError | KimiAuthError;

function isSubscriptionAuthError(error: unknown): error is SubscriptionAuthError {
  return error instanceof GrokAuthError || error instanceof CodexAuthError || error instanceof KimiAuthError;
}

function subscriptionAuthProvider(error: SubscriptionAuthError): SubscriptionProvider {
  if (error instanceof GrokAuthError) return 'grok';
  if (error instanceof KimiAuthError) return 'kimi';
  return 'codex';
}

async function validateSubscriptionProviderAuth(provider: SubscriptionProvider): Promise<string | null> {
  if (provider === 'grok') {
    const { isGrokAvailable } = await import('./agent-runtime/grok-availability');
    const status = await isGrokAvailable();
    return status.usable ? null : (status.reason ?? 'Grok Build ainda nao esta autenticado e validado.');
  }
  if (provider === 'kimi') {
    const { isKimiAvailable } = await import('./agent-runtime/kimi-availability');
    const status = await isKimiAvailable();
    return status.usable ? null : (status.reason ?? 'Kimi ainda nao esta autenticado e validado.');
  }
  const { isCodexAvailable } = await import('./codex-runtime/binary');
  const status = await isCodexAvailable();
  if (!status.authenticated) return 'Codex ainda nao esta autenticado.';
  if (!status.appServerSupported) return status.error ?? 'Codex App Server indisponivel.';
  return null;
}

type CoderRunResult = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  apiRequests: number;
  output: string;
  toolCallsAccum: import('../../src/types').PersistedTimelineToolCall[];
  promptUsed: string;
  costSource: 'sdk_anthropic' | 'calculated' | 'reported' | 'fallback_zero';
  runtimeUsed: 'cloud' | 'local' | 'external' | 'codex' | 'zai' | 'minimax-tp' | 'kimi' | 'grok' | 'cursor';
  providerUsed: string;
  modelUsed: string;
  codexPatchFailures: number;
  costStatus?: 'known' | 'unknown' | 'estimated-partial';
  tokenStatus?: 'reported' | 'not_reported';
  costUnknownReason?: 'unknown-pricing' | 'no-usage-reported';
  costEstimationKind?: 'subscription-equivalent-payg';
  agentMetadata?: AgentExecutionResult['metadata'];
};

type EvaluatorRunResult = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  apiRequests: number;
  evaluation: EvaluationResult;
  output: string;
  toolCallsAccum: import('../../src/types').PersistedTimelineToolCall[];
  costSource: 'sdk_anthropic' | 'calculated' | 'reported' | 'fallback_zero';
  runtimeUsed: 'cloud' | 'local' | 'external' | 'codex' | 'zai' | 'minimax-tp' | 'kimi' | 'grok' | 'cursor';
  providerUsed: string;
  modelUsed: string;
  parseTier: string;
  costStatus?: 'known' | 'unknown' | 'estimated-partial';
  tokenStatus?: 'reported' | 'not_reported';
  costUnknownReason?: 'unknown-pricing' | 'no-usage-reported';
  costEstimationKind?: 'subscription-equivalent-payg';
  agentMetadata?: AgentExecutionResult['metadata'];
};

type HarnessRunCheckpoint = {
  sprintId: string;
  sprintIndex: number;
  roundNumber: number;
  roundId: string;
  lastFeedback?: string;
} & (
  | { stage: 'coder' }
  | { stage: 'evaluator'; coderMetrics: CoderRunResult }
  | { stage: 'evaluator-completed'; coderMetrics: CoderRunResult; evaluatorMetrics: EvaluatorRunResult }
);

type PipelineSprintCheckpoint = {
  sprintId: string;
  sprintIndex: number;
  roundNumber: number;
  roundId: string;
  totalRounds: number;
  lastFeedback?: string;
  aggCoder: SprintMetrics;
  aggEvaluator: SprintMetrics;
} & (
  | { stage: 'coder' }
  | { stage: 'evaluator'; coderMetrics: CoderRunResult }
  | { stage: 'evaluator-completed'; coderMetrics: CoderRunResult; evaluatorMetrics: EvaluatorRunResult }
);

type HarnessAuthResume = (
  | { kind: 'plan'; briefingPrefix?: string; executionOwner: HarnessExecutionOwner }
  | { kind: 'regenerate'; feedback: string }
  | { kind: 'run'; checkpoint: HarnessRunCheckpoint }
  | { kind: 'pipeline-run'; checkpoint: PipelineSprintCheckpoint }
) & { provider?: SubscriptionProvider };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isSubscriptionProvider(value: unknown): value is SubscriptionProvider {
  return value === 'codex' || value === 'grok' || value === 'kimi';
}

function hydrateHarnessAuthResume(persisted: HarnessProviderAuthCheckpoint): HarnessAuthResume | undefined {
  const resume = record(persisted.resume);
  if (!resume || !isSubscriptionProvider(resume['provider']) || resume['provider'] !== persisted.provider) {
    return undefined;
  }
  if (resume['kind'] === 'plan') {
    if (resume['executionOwner'] !== 'harness' && resume['executionOwner'] !== 'pipeline') return undefined;
    if (resume['briefingPrefix'] !== undefined && typeof resume['briefingPrefix'] !== 'string') return undefined;
    return resume as HarnessAuthResume;
  }
  if (resume['kind'] === 'regenerate') {
    return typeof resume['feedback'] === 'string' ? (resume as HarnessAuthResume) : undefined;
  }
  if (resume['kind'] !== 'run' && resume['kind'] !== 'pipeline-run') return undefined;
  const checkpoint = record(resume['checkpoint']);
  if (
    !checkpoint ||
    typeof checkpoint['sprintId'] !== 'string' ||
    !Number.isInteger(checkpoint['sprintIndex']) ||
    !Number.isInteger(checkpoint['roundNumber']) ||
    typeof checkpoint['roundId'] !== 'string' ||
    (checkpoint['stage'] !== 'coder' &&
      checkpoint['stage'] !== 'evaluator' &&
      checkpoint['stage'] !== 'evaluator-completed')
  ) {
    return undefined;
  }
  if (
    (checkpoint['stage'] === 'evaluator' || checkpoint['stage'] === 'evaluator-completed') &&
    !record(checkpoint['coderMetrics'])
  )
    return undefined;
  if (checkpoint['stage'] === 'evaluator-completed' && !record(checkpoint['evaluatorMetrics'])) return undefined;
  if (resume['kind'] === 'pipeline-run') {
    if (
      !Number.isInteger(checkpoint['totalRounds']) ||
      !record(checkpoint['aggCoder']) ||
      !record(checkpoint['aggEvaluator'])
    )
      return undefined;
  }
  return resume as HarnessAuthResume;
}

function authResumeRoundId(resume: HarnessAuthResume): string | undefined {
  return resume.kind === 'run' || resume.kind === 'pipeline-run' ? resume.checkpoint.roundId : undefined;
}

interface HarnessState {
  status: 'idle' | 'planning' | 'running' | 'paused';
  projectId: string | null;
  currentSprintIndex: number;
  abortController: AbortController | null;
  pauseRequested: boolean;
  authResume?: HarnessAuthResume;
  authCheckpointId?: string;
  pipelineAuthResumeArmed?: boolean;
}

type HarnessExecutionOwner = 'harness' | 'pipeline';

interface ActiveEnrichSession {
  sessionId: string;
  specPath: string;
  phase: EnrichPhase;
  abort: AbortController;
  authResume?: {
    prompt: string;
    agentId: string;
    phase: 'validator' | 'enricher';
    isFollowUp: boolean;
    provider?: SubscriptionProvider;
  };
}

export interface SprintMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  apiRequests: number;
  model: string | null;
  runtime: 'cloud' | 'local' | 'external' | 'codex' | 'zai' | 'minimax-tp' | 'kimi' | 'grok' | 'cursor' | null;
  costStatus?: 'known' | 'unknown' | 'estimated-partial';
  tokenStatus?: 'reported' | 'not_reported';
  costUnknownReason?: 'unknown-pricing' | 'no-usage-reported';
  unknownCostCount?: number;
  provider?: string;
  costEstimationKind?: 'subscription-equivalent-payg';
  sessionIds?: string[];
  costSource?: NonNullable<AgentExecutionResult['metadata']>['costSource'];
  pricingSnapshot?: NonNullable<AgentExecutionResult['metadata']>['pricingSnapshot'];
  modelUsage?: NonNullable<AgentExecutionResult['metadata']>['modelUsage'];
  grok?: NonNullable<AgentExecutionResult['metadata']>['grok'];
}

export interface SprintResult {
  verdict: string;
  rounds: number;
  metrics: { coder: SprintMetrics; evaluator: SprintMetrics };
  coderMetrics: SprintMetrics;
  evaluatorMetrics: SprintMetrics;
}

function extractEvaluationJSON(
  result: import('./json-extractor').ExtractJSONSource,
  round: number,
  sprintId: string,
): { evaluation: EvaluationResult; tier: string } {
  const { value, tier } = extractJSON<EvaluationResult>(result, {
    parser: (text, outMeta) => parseEvaluationOutput(text, round, outMeta),
    contextLabel: 'Evaluator',
    round,
    sprintId,
  });
  return { evaluation: value, tier };
}

function mapRuntimeToCostMeta(
  runtime: AgentExecutionResult['runtime'],
  metadata?: AgentExecutionResult['metadata'],
): {
  costSource: 'sdk_anthropic' | 'calculated' | 'reported' | 'fallback_zero';
  runtimeUsed: 'cloud' | 'local' | 'external' | 'codex' | 'zai' | 'minimax-tp' | 'kimi' | 'grok' | 'cursor';
} {
  switch (runtime) {
    case 'cloud': {
      const sdkReported = metadata?.costSource === 'sdk_total_cost_usd' || metadata?.costSource === 'sdk_model_usage';
      return { costSource: sdkReported ? 'sdk_anthropic' : 'calculated', runtimeUsed: 'cloud' };
    }
    case 'codex':
      return { costSource: 'calculated', runtimeUsed: 'codex' };
    case 'zai':
      return { costSource: 'calculated', runtimeUsed: 'zai' };
    case 'local':
      return { costSource: 'calculated', runtimeUsed: 'local' };
    case 'external':
      return { costSource: 'reported', runtimeUsed: 'external' };
    case 'minimax-tp':
      return { costSource: 'calculated', runtimeUsed: 'minimax-tp' };
    case 'kimi':
      return { costSource: 'calculated', runtimeUsed: 'kimi' };
    case 'grok':
      return {
        costSource: metadata?.costSource === 'provider-reported-equivalent' ? 'reported' : 'calculated',
        runtimeUsed: 'grok',
      };
    case 'cursor':
      return { costSource: 'calculated', runtimeUsed: 'cursor' };
  }
}

export class HarnessEngine {
  private getWindow: () => BrowserWindow | null;
  private states: Map<string, HarnessState> = new Map();
  private activeEnrichSession: ActiveEnrichSession | null = null;
  private streamBridge: ((channel: string, data: unknown) => void) | null = null;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  hasActiveHarnessWork(): boolean {
    for (const state of this.states.values()) {
      if (state.status === 'planning' || state.status === 'running' || state.status === 'paused') {
        return true;
      }
    }
    return this.activeEnrichSession !== null;
  }

  setStreamBridge(bridge: (channel: string, data: unknown) => void): void {
    this.streamBridge = bridge;
  }

  clearStreamBridge(): void {
    this.streamBridge = null;
  }

  private getProjectDir(projectId: string): string {
    return path.join(getLionClawHome(), 'harness', 'projects', projectId);
  }

  private ensureProjectDirs(projectId: string): void {
    const projectDir = this.getProjectDir(projectId);
    fs.mkdirSync(path.join(projectDir, 'sprints'), { recursive: true });
  }

  private emitIPC(channel: string, data: unknown): void {
    try {
      if (this.streamBridge) {
        this.streamBridge(channel, data);
      }
    } catch {
      // Bridge target (PipelineEngine) window may have been destroyed
    }
    emitIPC(channel, data);
  }

  private persistStreamEvent(
    projectId: string,
    sprintId: string,
    round: number,
    agent: string,
    event: { type: string; content?: string; tool?: string },
  ): void {
    try {
      const dir = path.join(this.getProjectDir(projectId), 'sprints', sprintId);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `round-${round}-${agent}.jsonl`);
      fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
    } catch {
      // Non-critical - don't break execution
    }
  }

  private persistFeedbackAudit(
    projectId: string,
    sprintId: string,
    round: number,
    evaluatorVerdict: string,
    evaluatorSummary: string,
    failedCriteria: { description: string; justification: string }[],
    feedbackInjected: string,
  ): void {
    try {
      const dir = path.join(this.getProjectDir(projectId), 'sprints', sprintId);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, 'feedback-audit.jsonl');
      const entry = {
        timestamp: new Date().toISOString(),
        round,
        evaluatorVerdict,
        evaluatorSummary,
        failedCriteria,
        feedbackInjectedIntoCoder: feedbackInjected,
      };
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
    } catch {
      // Non-critical
    }
  }

  getStreamLog(
    projectId: string,
    sprintId: string,
    round: number,
    agent: string,
  ): { type: string; content?: string; tool?: string }[] {
    const filePath = path.join(this.getProjectDir(projectId), 'sprints', sprintId, `round-${round}-${agent}.jsonl`);
    if (!fs.existsSync(filePath)) return [];
    try {
      return fs
        .readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  getLatestStreamLogs(
    projectId: string,
    sprintId: string,
  ): {
    coder: { type: string; content?: string; tool?: string }[];
    evaluator: { type: string; content?: string; tool?: string }[];
    round: number;
  } {
    const dir = path.join(this.getProjectDir(projectId), 'sprints', sprintId);
    if (!fs.existsSync(dir)) return { coder: [], evaluator: [], round: 0 };

    const files = fs.readdirSync(dir).filter((f) => f.startsWith('round-') && f.endsWith('.jsonl'));
    let maxRound = 0;
    for (const f of files) {
      const match = f.match(/^round-(\d+)-/);
      if (match) {
        const r = parseInt(match[1], 10);
        if (r > maxRound) maxRound = r;
      }
    }

    if (maxRound === 0) return { coder: [], evaluator: [], round: 0 };

    return {
      coder: this.getStreamLog(projectId, sprintId, maxRound, 'coder'),
      evaluator: this.getStreamLog(projectId, sprintId, maxRound, 'evaluator'),
      round: maxRound,
    };
  }

  private getState(projectId: string): HarnessState {
    if (!this.states.has(projectId)) {
      const persisted = getHarnessProviderAuthCheckpoint(projectId);
      const authResume = persisted ? hydrateHarnessAuthResume(persisted) : undefined;
      this.states.set(projectId, {
        status: 'idle',
        projectId,
        currentSprintIndex: -1,
        abortController: null,
        pauseRequested: false,
        ...(authResume ? { authResume } : {}),
        ...(persisted ? { authCheckpointId: persisted.checkpointId } : {}),
      });
    }
    return this.states.get(projectId)!;
  }

  private createExecutionContext(
    projectId: string,
    cwd: string,
    abortController: AbortController,
    ownerKind: HarnessExecutionOwner,
    surface: string,
    allowedTools: readonly string[],
  ): SubagentDispatchContext {
    return createSubagentDispatchContext({
      ownerKind,
      ownerId: projectId,
      lane: ownerKind === 'pipeline' ? 'pipeline' : 'desktop',
      surface,
      cwd,
      projectId,
      readRoots: [cwd],
      writeRoots: [cwd],
      allowedTools,
      permission: PERM_BYPASS_NO_GUARD,
      parentAbortSignal: abortController.signal,
      abortOwner: (reason) => abortController.abort(reason),
    });
  }

  private async executeAgentWithSubagentControl(
    request: AgentExecutionRequest,
    context: SubagentDispatchContext,
  ): Promise<AgentExecutionResult> {
    try {
      const result = await executeAgent(request);
      const childAuthError = pendingSubagentProviderAuthError(context);
      if (childAuthError) throw childAuthError;
      return result;
    } catch (error) {
      throw pendingSubagentProviderAuthError(context) ?? error;
    }
  }

  private pauseForProviderAuth(
    projectId: string,
    phaseNumber: number,
    agentId: string,
    error: SubscriptionAuthError,
    ownerKind: HarnessExecutionOwner,
    authResume?: HarnessAuthResume,
  ): PipelinePausedError | null {
    logger.warn(
      { projectId, phaseNumber, agentId, ownerKind, message: error.message },
      'Harness provider auth required — pausing without marking failure',
    );
    const state = this.getState(projectId);
    const provider = subscriptionAuthProvider(error);
    const resumable = authResume ? ({ ...authResume, provider } as HarnessAuthResume) : undefined;
    if (resumable) {
      const checkpoint: HarnessProviderAuthCheckpoint = {
        checkpointId: randomUUID(),
        pauseReason: 'provider-auth',
        provider,
        ownerKind,
        phaseNumber,
        agentId,
        ...(authResumeRoundId(resumable) ? { roundId: authResumeRoundId(resumable) } : {}),
        resume: resumable,
      };
      if (!persistHarnessProviderAuthCheckpoint(projectId, checkpoint)) {
        throw new Error(`Nao foi possivel persistir checkpoint de autenticacao do projeto ${projectId}.`);
      }
      state.authResume = resumable;
      state.authCheckpointId = checkpoint.checkpointId;
    } else {
      state.authResume = undefined;
      state.authCheckpointId = undefined;
      setProjectStatus(projectId, 'paused');
    }
    state.pipelineAuthResumeArmed = false;
    state.status = 'paused';
    this.emitIPC('harness:project-update', { projectId, status: 'paused' });
    this.emitIPC('pipeline:auth-required', {
      provider,
      runtime: provider,
      projectId,
      phaseNumber,
      agentId,
      message: error.message,
      ownerKind,
      ...(resumable && authResumeRoundId(resumable) ? { roundId: authResumeRoundId(resumable) } : {}),
    });
    return ownerKind === 'pipeline'
      ? new PipelinePausedError(
          error.message || 'Provider auth required',
          error instanceof GrokAuthError ? 'grok-auth' : error instanceof KimiAuthError ? 'kimi-auth' : 'codex-auth',
        )
      : null;
  }

  async plan(
    projectId: string,
    briefingPrefix?: string,
    executionOwner: HarnessExecutionOwner = 'harness',
  ): Promise<AgentExecutionResult | undefined> {
    ensureNodeInPath();

    const state = this.getState(projectId);
    const pipelinePlanResume = state.authResume?.kind === 'plan' && state.authResume.executionOwner === 'pipeline';
    if (pipelinePlanResume && !state.pipelineAuthResumeArmed) {
      const reason =
        state.authResume?.provider === 'grok'
          ? 'grok-auth'
          : state.authResume?.provider === 'kimi'
            ? 'kimi-auth'
            : 'codex-auth';
      throw new PipelinePausedError('Checkpoint do planner exige validacao de autenticacao antes do resume.', reason);
    }
    if (pipelinePlanResume) state.pipelineAuthResumeArmed = false;
    if (!pipelinePlanResume) state.authResume = undefined;
    state.status = 'planning';
    state.abortController = new AbortController();

    this.ensureProjectDirs(projectId);

    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    setProjectStatus(projectId, 'planning');
    this.emitIPC('harness:project-update', { projectId, status: 'planning' });

    const startedAt = Date.now();

    try {
      const specPath = resolveSpecPath(project);
      if (!fs.existsSync(specPath)) {
        throw new Error(`Spec file not found: ${specPath}`);
      }
      const specContent = fs.readFileSync(specPath, 'utf-8');

      const plannerAgent = getAgent(project.config.plannerAgentId);
      if (!plannerAgent) {
        throw new Error(`Planner agent not found: ${project.config.plannerAgentId}`);
      }

      const allAgents = getAllAgents();

      const outputFormat = project.config.plannerOutputFormat ?? 'json';
      const basePrompt =
        outputFormat === 'markdown'
          ? buildPlannerMarkdownPrompt(specContent, project, allAgents)
          : buildPlannerPrompt(specContent, project, allAgents);
      const prompt = briefingPrefix ? `${briefingPrefix}\n\n${basePrompt}` : basePrompt;

      if (!fs.existsSync(project.projectPath)) {
        throw new Error(`Project path does not exist: ${project.projectPath}. Create the directory first.`);
      }

      logger.info(
        {
          projectId,
          runtime: plannerAgent.runtime,
          model:
            plannerAgent.runtime === 'external'
              ? (plannerAgent.externalConfig?.model ?? plannerAgent.model)
              : plannerAgent.model,
          cwd: project.projectPath,
        },
        'Spawning Planner via executeAgent',
      );

      if (!state.abortController) {
        state.abortController = new AbortController();
      }
      const abortController = state.abortController;
      const executionContext = this.createExecutionContext(
        projectId,
        project.projectPath,
        abortController,
        executionOwner,
        'harness:planner',
        plannerAgent.allowedTools,
      );

      const plannerResult = await this.executeAgentWithSubagentControl(
        {
          agentId: plannerAgent.id,
          prompt,
          cwd: project.projectPath,
          abortController,
          permission: PERM_BYPASS_NO_GUARD,
          projectId,
          executionContext,
          onText: (text) => {
            this.emitIPC('harness:agent-stream', {
              projectId,
              agent: 'planner',
              event: { type: 'text', content: text },
            });
          },
          onThinking: (text) => {
            this.emitIPC('harness:agent-stream', {
              projectId,
              agent: 'planner',
              event: { type: 'thinking', content: text },
            });
          },
          onToolUse: (toolName) => {
            this.emitIPC('harness:agent-stream', {
              projectId,
              agent: 'planner',
              event: { type: 'tool_use', tool: toolName },
            });
          },
        },
        executionContext,
      );

      logger.info(
        { projectId, runtime: plannerResult.runtime, model: plannerResult.model },
        'Planner finished via executeAgent',
      );

      const fullOutput = plannerResult.output;
      const inputTokens = plannerResult.metrics.inputTokens;
      const outputTokens = plannerResult.metrics.outputTokens;
      const cacheReadTokens = plannerResult.metrics.cacheReadTokens;
      const cacheCreationTokens = plannerResult.metrics.cacheCreationTokens;
      const plannerExtractSource: import('./json-extractor').ExtractJSONSource | undefined =
        plannerResult.accumulatedText !== undefined && plannerResult.textBlocks !== undefined
          ? {
              output: fullOutput,
              accumulatedText: plannerResult.accumulatedText,
              textBlocks: plannerResult.textBlocks,
            }
          : undefined;

      if (state.abortController?.signal.aborted) {
        setProjectStatus(projectId, 'aborted');
        this.emitIPC('harness:project-update', { projectId, status: 'aborted' });
        state.status = 'idle';
        return;
      }

      let plannerParseTier: string | null = null;
      const sprintsJson =
        outputFormat === 'markdown'
          ? parsePlannerMarkdown(fullOutput, project)
          : (() => {
              if (plannerExtractSource) {
                const { value, tier } = extractJSON<SprintsJson>(plannerExtractSource, {
                  parser: (text, outMeta) => parsePlannerOutput(text, outMeta),
                  contextLabel: 'Planner',
                });
                plannerParseTier = tier;
                return value;
              }
              const meta: { repaired?: boolean } = {};
              const value = parsePlannerOutput(fullOutput, meta);
              plannerParseTier = meta.repaired ? 'jsonrepair' : 'result';
              return value;
            })();

      if (plannerParseTier && plannerParseTier !== 'result') {
        logger.info({ projectId, plannerParseTier }, 'Planner JSON extracted from fallback tier');
      }

      const projectFull = getHarnessProject(projectId);
      if (!projectFull) throw new Error(`Project ${projectId} not found when resolving sprints path`);
      let sprintsFilePath: string;
      if (projectFull.pipelineType === 'architecture-review') {
        const ctx = getArchitectureReviewContext(projectFull);
        if (!ctx) {
          throw new Error(
            'architecture-review run context missing when planner ran — fase 1 must have generated runId',
          );
        }
        sprintsFilePath = ctx.sprintsPath;
      } else if (projectFull.pipelineType === 'bug') {
        const bugCtx = getBugContext(projectFull);
        if (!bugCtx) {
          throw new Error('bug run context missing when planner ran — fase 1 must have generated config.bug.runId');
        }
        sprintsFilePath = bugCtx.sprintsPath;
      } else {
        sprintsFilePath = resolveHarnessSprintsPath(projectFull);
      }
      const { path: sprintsPath } = saveSprintsJson(
        projectId,
        sprintsFilePath,
        sprintsJson,
        project.config.evaluatorAgentId,
        outputFormat,
      );

      updateHarnessProject(projectId, {
        sprintsJsonPath: sprintsPath,
        status: 'reviewing',
        totalSprints: sprintsJson.metadata.total_sprints,
        totalFeatures: sprintsJson.metadata.total_features,
      });

      this.emitIPC('harness:planning-done', {
        projectId,
        sprintsPath,
        totalSprints: sprintsJson.metadata.total_sprints,
        totalFeatures: sprintsJson.metadata.total_features,
        version: sprintsJson.metadata.version,
      });

      const durationMs = Date.now() - startedAt;
      const costUsd = plannerResult.metrics.costUsd;
      const isPlannerUnknownCost = plannerResult.metrics.costStatus === 'unknown';

      updateHarnessProject(projectId, {
        plannerInputTokens: inputTokens,
        plannerOutputTokens: outputTokens,
        plannerCacheTokens: cacheReadTokens + cacheCreationTokens,
        plannerCostUsd: costUsd,
        plannerDurationMs: durationMs,
        config: {
          ...project.config,
          metricsQuality: {
            plannerCostStatus: plannerResult.metrics.costStatus ?? 'known',
            plannerTokenStatus: plannerResult.metrics.tokenStatus ?? 'reported',
            plannerCostUnknownReasons: plannerResult.metrics.costUnknownReason
              ? [plannerResult.metrics.costUnknownReason]
              : [],
            plannerSubscriptionEquivalentCostUsd:
              plannerResult.metadata?.costEstimationKind === 'subscription-equivalent-payg' ? costUsd : 0,
          },
        },
        ...(isPlannerUnknownCost && { plannerUnknownCostCount: 1 }),
      });

      logger.info(
        { projectId, totalSprints: sprintsJson.metadata.total_sprints, durationMs, costUsd },
        'Planning completed',
      );

      this.emitIPC('harness:project-update', { projectId, status: 'reviewing' });

      return plannerResult;
    } catch (err) {
      if (isSubscriptionAuthError(err)) {
        const pause = this.pauseForProviderAuth(
          projectId,
          getPhaseNumberForAgent(project.pipelineType, project.config.plannerAgentId) ?? 11,
          project.config.plannerAgentId,
          err,
          executionOwner,
          { kind: 'plan', ...(briefingPrefix ? { briefingPrefix } : {}), executionOwner },
        );
        if (pause) throw pause;
        return;
      }
      logger.error({ err, projectId }, 'Planning failed');
      setProjectStatus(projectId, 'failed');
      this.emitIPC('harness:project-update', { projectId, status: 'failed' });
      this.emitIPC('harness:error', { projectId, error: (err as Error).message });
      throw err;
    } finally {
      if (this.getState(projectId).status !== 'paused') state.status = 'idle';
    }
  }

  async regenerate(projectId: string, feedback: string): Promise<void> {
    const state = this.getState(projectId);
    state.authResume = undefined;
    state.status = 'planning';
    state.abortController = new AbortController();

    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    setProjectStatus(projectId, 'planning');
    this.emitIPC('harness:project-update', { projectId, status: 'planning' });

    const startedAt = Date.now();

    try {
      const previousJson = readHarnessSprintsJson(project);
      if (!previousJson) {
        throw new Error('No existing sprints.json found to regenerate from');
      }

      const specPath = resolveSpecPath(project);
      if (!fs.existsSync(specPath)) {
        throw new Error(`Spec file not found: ${specPath}`);
      }
      const specContent = fs.readFileSync(specPath, 'utf-8');

      const plannerAgent = getAgent(project.config.plannerAgentId);
      if (!plannerAgent) {
        throw new Error(`Planner agent not found: ${project.config.plannerAgentId}`);
      }

      const allAgents = getAllAgents();
      const regenFormat = project.config.plannerOutputFormat ?? 'json';
      const prompt = buildRegenerationPrompt(previousJson, feedback, specContent, allAgents, regenFormat);

      if (!fs.existsSync(project.projectPath)) {
        throw new Error(`Project path does not exist: ${project.projectPath}`);
      }

      logger.info(
        {
          projectId,
          runtime: plannerAgent.runtime,
          model:
            plannerAgent.runtime === 'external'
              ? (plannerAgent.externalConfig?.model ?? plannerAgent.model)
              : plannerAgent.model,
        },
        'Spawning Planner (regen) via executeAgent',
      );

      if (!state.abortController) {
        state.abortController = new AbortController();
      }
      const regenAbortController = state.abortController;
      const executionContext = this.createExecutionContext(
        projectId,
        project.projectPath,
        regenAbortController,
        'harness',
        'harness:planner-regenerate',
        plannerAgent.allowedTools,
      );

      const regenResult = await this.executeAgentWithSubagentControl(
        {
          agentId: plannerAgent.id,
          prompt,
          cwd: project.projectPath,
          abortController: regenAbortController,
          permission: PERM_BYPASS_NO_GUARD,
          projectId,
          executionContext,
          onText: (text) => {
            this.emitIPC('harness:agent-stream', { projectId, agent: 'planner', type: 'text', content: text });
          },
          onToolUse: (toolName) => {
            this.emitIPC('harness:agent-stream', { projectId, agent: 'planner', type: 'tool_use', tool: toolName });
          },
        },
        executionContext,
      );

      const fullOutput = regenResult.output;
      const inputTokens = regenResult.metrics.inputTokens;
      const outputTokens = regenResult.metrics.outputTokens;
      const cacheReadTokens = regenResult.metrics.cacheReadTokens;
      const cacheCreationTokens = regenResult.metrics.cacheCreationTokens;
      const regenExtractSource: import('./json-extractor').ExtractJSONSource | undefined =
        regenResult.accumulatedText !== undefined && regenResult.textBlocks !== undefined
          ? {
              output: fullOutput,
              accumulatedText: regenResult.accumulatedText,
              textBlocks: regenResult.textBlocks,
            }
          : undefined;

      if (state.abortController?.signal.aborted) {
        setProjectStatus(projectId, 'reviewing');
        this.emitIPC('harness:project-update', { projectId, status: 'reviewing' });
        state.status = 'idle';
        return;
      }

      let regenParseTier: string | null = null;
      const sprintsJson =
        regenFormat === 'markdown'
          ? parsePlannerMarkdown(fullOutput, project)
          : (() => {
              if (regenExtractSource) {
                const { value, tier } = extractJSON<SprintsJson>(regenExtractSource, {
                  parser: (text, outMeta) => parsePlannerOutput(text, outMeta),
                  contextLabel: 'Planner',
                });
                regenParseTier = tier;
                return value;
              }
              const meta: { repaired?: boolean } = {};
              const value = parsePlannerOutput(fullOutput, meta);
              regenParseTier = meta.repaired ? 'jsonrepair' : 'result';
              return value;
            })();

      if (regenParseTier && regenParseTier !== 'result') {
        logger.info({ projectId, regenParseTier }, 'Regen planner JSON extracted from fallback tier');
      }
      const sprintsFilePath = resolveHarnessSprintsPath(project);
      const { path: sprintsPath } = saveSprintsJson(
        projectId,
        sprintsFilePath,
        sprintsJson,
        project.config.evaluatorAgentId,
        regenFormat,
      );

      updateHarnessProject(projectId, {
        sprintsJsonPath: sprintsPath,
        status: 'reviewing',
        totalSprints: sprintsJson.metadata.total_sprints,
        totalFeatures: sprintsJson.metadata.total_features,
      });

      this.emitIPC('harness:planning-done', {
        projectId,
        sprintsPath,
        totalSprints: sprintsJson.metadata.total_sprints,
        totalFeatures: sprintsJson.metadata.total_features,
        version: sprintsJson.metadata.version,
        regenerated: true,
      });

      const durationMs = Date.now() - startedAt;
      const costUsd = regenResult.metrics.costUsd;

      const existingProject = getHarnessProject(projectId);
      const previousQuality = existingProject?.config.metricsQuality;
      const nextCostStatus = regenResult.metrics.costStatus ?? 'known';
      const mergedCostStatus =
        previousQuality?.plannerCostStatus === 'unknown' || nextCostStatus === 'unknown'
          ? 'unknown'
          : previousQuality?.plannerCostStatus === 'estimated-partial' || nextCostStatus === 'estimated-partial'
            ? 'estimated-partial'
            : 'known';
      updateHarnessProject(projectId, {
        plannerInputTokens: (existingProject?.plannerInputTokens ?? 0) + inputTokens,
        plannerOutputTokens: (existingProject?.plannerOutputTokens ?? 0) + outputTokens,
        plannerCacheTokens: (existingProject?.plannerCacheTokens ?? 0) + cacheReadTokens + cacheCreationTokens,
        plannerCostUsd: (existingProject?.plannerCostUsd ?? 0) + costUsd,
        plannerDurationMs: (existingProject?.plannerDurationMs ?? 0) + durationMs,
        config: {
          ...(existingProject?.config ?? project.config),
          metricsQuality: {
            plannerCostStatus: mergedCostStatus,
            plannerTokenStatus:
              previousQuality?.plannerTokenStatus === 'not_reported' ||
              regenResult.metrics.tokenStatus === 'not_reported'
                ? 'not_reported'
                : 'reported',
            plannerCostUnknownReasons: [
              ...new Set([
                ...(previousQuality?.plannerCostUnknownReasons ?? []),
                ...(regenResult.metrics.costUnknownReason ? [regenResult.metrics.costUnknownReason] : []),
              ]),
            ],
            plannerSubscriptionEquivalentCostUsd:
              (previousQuality?.plannerSubscriptionEquivalentCostUsd ?? 0) +
              (regenResult.metadata?.costEstimationKind === 'subscription-equivalent-payg' ? costUsd : 0),
          },
        },
        ...(regenResult.metrics.costStatus === 'unknown' && { plannerUnknownCostCount: 1 }),
      });

      logger.info({ projectId, version: sprintsJson.metadata.version, durationMs, costUsd }, 'Regeneration completed');

      this.emitIPC('harness:project-update', { projectId, status: 'reviewing' });
    } catch (err) {
      if (isSubscriptionAuthError(err)) {
        this.pauseForProviderAuth(
          projectId,
          getPhaseNumberForAgent(project.pipelineType, project.config.plannerAgentId) ?? 11,
          project.config.plannerAgentId,
          err,
          'harness',
          { kind: 'regenerate', feedback },
        );
        return;
      }
      logger.error({ err, projectId }, 'Regeneration failed');
      setProjectStatus(projectId, 'failed');
      this.emitIPC('harness:project-update', { projectId, status: 'failed' });
      this.emitIPC('harness:error', { projectId, error: (err as Error).message });
      throw err;
    } finally {
      if (this.getState(projectId).status !== 'paused') state.status = 'idle';
    }
  }

  private async spawnCoder(
    projectId: string,
    sprint: import('../../src/types').HarnessSprint,
    sprintJson: SprintJsonEntry,
    round: number,
    feedback?: string,
    briefingPrefix?: string,
    executionOwner: HarnessExecutionOwner = 'harness',
  ): Promise<CoderRunResult> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const coderAgentId = sprint.coderAgentId;
    if (!coderAgentId) throw new Error(`Sprint ${sprint.id} has no coderAgentId`);
    const coderAgent = getAgent(coderAgentId);
    if (!coderAgent) throw new Error(`Coder agent not found: ${coderAgentId}`);

    const specProgressPath = resolveSpecProgressPath(project);
    const specProgressContent = fs.existsSync(specProgressPath) ? fs.readFileSync(specProgressPath, 'utf-8') : '';

    const baseCoderPrompt =
      round === 1 && !feedback
        ? buildCoderPrompt(sprintJson, specProgressContent, project.projectPath)
        : buildCoderFeedbackPrompt(sprintJson, feedback ?? '');
    const prompt = briefingPrefix && round === 1 ? `${briefingPrefix}\n\n${baseCoderPrompt}` : baseCoderPrompt;

    if (!fs.existsSync(project.projectPath)) {
      throw new Error(`Project path does not exist: ${project.projectPath}`);
    }

    const state = this.getState(projectId);
    const startedAt = Date.now();

    const coderToolCallsAccum: import('../../src/types').PersistedTimelineToolCall[] = [];
    let coderTextOffset = 0;

    logger.info(
      {
        projectId,
        sprintId: sprint.id,
        round,
        runtime: coderAgent.runtime,
        model:
          coderAgent.runtime === 'external' ? (coderAgent.externalConfig?.model ?? coderAgent.model) : coderAgent.model,
      },
      'Spawning Coder via executeAgent',
    );

    if (!state.abortController) {
      state.abortController = new AbortController();
    }
    const coderAbortController = state.abortController;
    const executionContext = this.createExecutionContext(
      projectId,
      project.projectPath,
      coderAbortController,
      executionOwner,
      `harness:coder:${sprint.id}:round:${round}`,
      coderAgent.allowedTools,
    );

    const coderResult = await this.executeAgentWithSubagentControl(
      {
        agentId: coderAgent.id,
        prompt,
        cwd: project.projectPath,
        abortController: coderAbortController,
        permission: PERM_BYPASS_NO_GUARD,
        projectId,
        executionContext,
        onText: (text) => {
          coderTextOffset += text.length;
          const evt = { type: 'text', content: text };
          this.emitIPC('harness:agent-stream', { projectId, sprintId: sprint.id, round, agent: 'coder', event: evt });
          this.persistStreamEvent(projectId, sprint.id, round, 'coder', evt);
        },
        onToolUse: (toolName) => {
          coderToolCallsAccum.push({
            tool: toolName,
            input: null,
            sequence: coderToolCallsAccum.length,
            textOffset: coderTextOffset,
            status: 'running',
          });
          const evt = { type: 'tool_call', tool: toolName };
          this.emitIPC('harness:agent-stream', { projectId, sprintId: sprint.id, round, agent: 'coder', event: evt });
          this.persistStreamEvent(projectId, sprint.id, round, 'coder', evt);
        },
        onToolUseComplete: (toolName, input) => {
          const candidates = coderToolCallsAccum.filter((call) => call.tool === toolName && call.input === null);
          if (candidates.length === 1) candidates[0].input = input ?? {};
        },
      },
      executionContext,
    );

    const durationMs = Date.now() - startedAt;
    const costUsd = coderResult.metrics.costUsd;
    const { costSource, runtimeUsed } = mapRuntimeToCostMeta(coderResult.runtime, coderResult.metadata);

    logger.info(
      {
        projectId,
        sprintId: sprint.id,
        round,
        durationMs,
        costUsd,
        toolUses: coderResult.metrics.toolUses,
        apiRequests: coderResult.metrics.apiRequests,
        runtime: coderResult.runtime,
        costSource,
      },
      'Coder finished via executeAgent',
    );

    return {
      inputTokens: coderResult.metrics.inputTokens,
      outputTokens: coderResult.metrics.outputTokens,
      cacheReadTokens: coderResult.metrics.cacheReadTokens,
      cacheCreationTokens: coderResult.metrics.cacheCreationTokens,
      cacheTokens: coderResult.metrics.cacheReadTokens + coderResult.metrics.cacheCreationTokens,
      costUsd,
      durationMs,
      toolUses: coderResult.metrics.toolUses,
      apiRequests: coderResult.metrics.apiRequests,
      output: coderResult.output,
      toolCallsAccum: coderToolCallsAccum.map((call) => ({ ...call, status: 'done' })),
      promptUsed: prompt,
      costSource,
      runtimeUsed,
      providerUsed: coderResult.provider,
      modelUsed: coderResult.model,
      codexPatchFailures: coderResult.metadata?.codex?.applyPatchFailures ?? 0,
      costStatus: coderResult.metrics.costStatus,
      tokenStatus: coderResult.metrics.tokenStatus,
      costUnknownReason: coderResult.metrics.costUnknownReason,
      costEstimationKind: coderResult.metadata?.costEstimationKind,
      agentMetadata: coderResult.metadata,
    };
  }

  private async spawnEvaluator(
    projectId: string,
    sprint: import('../../src/types').HarnessSprint,
    sprintJson: SprintJsonEntry,
    round: number,
    executionOwner: HarnessExecutionOwner = 'harness',
  ): Promise<EvaluatorRunResult> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const evaluatorAgentId = sprint.evaluatorAgentId;
    if (!evaluatorAgentId) throw new Error(`Sprint ${sprint.id} has no evaluatorAgentId`);
    const evaluatorAgent = getAgent(evaluatorAgentId);
    if (!evaluatorAgent) throw new Error(`Evaluator agent not found: ${evaluatorAgentId}`);

    const evaluatorSpecPath = resolveSpecPath(project);
    const prompt = buildEvaluatorPrompt(sprintJson, project.projectPath, evaluatorSpecPath);

    if (!fs.existsSync(project.projectPath)) {
      throw new Error(`Project path does not exist: ${project.projectPath}`);
    }

    const state = this.getState(projectId);
    const startedAt = Date.now();

    const evalToolCallsAccum: import('../../src/types').PersistedTimelineToolCall[] = [];
    let evalTextOffset = 0;

    logger.info(
      {
        projectId,
        sprintId: sprint.id,
        round,
        runtime: evaluatorAgent.runtime,
        model:
          evaluatorAgent.runtime === 'external'
            ? (evaluatorAgent.externalConfig?.model ?? evaluatorAgent.model)
            : evaluatorAgent.model,
      },
      'Spawning Evaluator via executeAgent',
    );

    if (!state.abortController) {
      state.abortController = new AbortController();
    }
    const evalAbortController = state.abortController;
    const executionContext = this.createExecutionContext(
      projectId,
      project.projectPath,
      evalAbortController,
      executionOwner,
      `harness:evaluator:${sprint.id}:round:${round}`,
      evaluatorAgent.allowedTools,
    );

    const evalResult = await this.executeAgentWithSubagentControl(
      {
        agentId: evaluatorAgent.id,
        prompt,
        cwd: project.projectPath,
        abortController: evalAbortController,
        permission: PERM_BYPASS_NO_GUARD,
        projectId,
        executionContext,
        onText: (text) => {
          evalTextOffset += text.length;
          const evt = { type: 'text', content: text };
          this.emitIPC('harness:agent-stream', {
            projectId,
            sprintId: sprint.id,
            round,
            agent: 'evaluator',
            event: evt,
          });
          this.persistStreamEvent(projectId, sprint.id, round, 'evaluator', evt);
        },
        onToolUse: (toolName) => {
          evalToolCallsAccum.push({
            tool: toolName,
            input: null,
            sequence: evalToolCallsAccum.length,
            textOffset: evalTextOffset,
            status: 'running',
          });
          const evt = { type: 'tool_call', tool: toolName };
          this.emitIPC('harness:agent-stream', {
            projectId,
            sprintId: sprint.id,
            round,
            agent: 'evaluator',
            event: evt,
          });
          this.persistStreamEvent(projectId, sprint.id, round, 'evaluator', evt);
        },
        onToolUseComplete: (toolName, input) => {
          const candidates = evalToolCallsAccum.filter((call) => call.tool === toolName && call.input === null);
          if (candidates.length === 1) candidates[0].input = input ?? {};
        },
      },
      executionContext,
    );

    const fullOutput = evalResult.output;
    const evalInputTokens = evalResult.metrics.inputTokens;
    const evalOutputTokens = evalResult.metrics.outputTokens;
    const evalCacheTokens = evalResult.metrics.cacheReadTokens + evalResult.metrics.cacheCreationTokens;
    const evalToolUses = evalResult.metrics.toolUses;
    const evalApiRequests = evalResult.metrics.apiRequests;
    const { costSource: evalCostSource, runtimeUsed: evalRuntimeUsed } = mapRuntimeToCostMeta(
      evalResult.runtime,
      evalResult.metadata,
    );
    const evalProviderUsed = evalResult.provider;
    const evalModelUsed = evalResult.model;

    const evalExtractSource: import('./json-extractor').ExtractJSONSource | undefined =
      evalResult.accumulatedText !== undefined && evalResult.textBlocks !== undefined
        ? {
            output: fullOutput,
            accumulatedText: evalResult.accumulatedText,
            textBlocks: evalResult.textBlocks,
          }
        : undefined;

    const durationMs = Date.now() - startedAt;
    const costUsd = evalResult.metrics.costUsd;

    const { evaluation: rawEvaluation, tier: parseTier } = evalExtractSource
      ? extractEvaluationJSON(evalExtractSource, round, sprintJson.id)
      : (() => {
          const meta: { repaired?: boolean } = {};
          const evaluation = parseEvaluationOutput(fullOutput, round, meta);
          return { evaluation, tier: meta.repaired ? 'jsonrepair' : ('result' as const) };
        })();
    let evaluation = rawEvaluation;
    evaluation = validateCriteria(evaluation, sprintJson);

    const sprintDir = path.join(this.getProjectDir(projectId), 'sprints', sprintJson.id);
    fs.mkdirSync(sprintDir, { recursive: true });
    const evalPath = path.join(sprintDir, 'evaluation.json');
    fs.writeFileSync(evalPath, JSON.stringify(evaluation, null, 2), 'utf-8');

    logger.info(
      {
        projectId,
        sprintId: sprint.id,
        round,
        verdict: evaluation.verdict,
        durationMs,
        costUsd,
        toolUses: evalToolUses,
        apiRequests: evalApiRequests,
      },
      'Evaluator finished',
    );

    return {
      inputTokens: evalInputTokens,
      outputTokens: evalOutputTokens,
      cacheReadTokens: evalResult.metrics.cacheReadTokens,
      cacheCreationTokens: evalResult.metrics.cacheCreationTokens,
      cacheTokens: evalCacheTokens,
      costUsd,
      durationMs,
      toolUses: evalToolUses,
      apiRequests: evalApiRequests,
      evaluation,
      output: fullOutput,
      toolCallsAccum: evalToolCallsAccum.map((call) => ({ ...call, status: 'done' })),
      costSource: evalCostSource,
      runtimeUsed: evalRuntimeUsed,
      providerUsed: evalProviderUsed,
      modelUsed: evalModelUsed,
      parseTier,
      costStatus: evalResult.metrics.costStatus,
      tokenStatus: evalResult.metrics.tokenStatus,
      costUnknownReason: evalResult.metrics.costUnknownReason,
      costEstimationKind: evalResult.metadata?.costEstimationKind,
      agentMetadata: evalResult.metadata,
    };
  }

  async run(projectId: string, resumeCheckpoint?: HarnessRunCheckpoint): Promise<void> {
    const state = this.getState(projectId);
    if (!resumeCheckpoint) state.authResume = undefined;
    state.status = 'running';
    state.abortController = new AbortController();
    state.pauseRequested = false;

    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    try {
      reseedHarnessSprintsFromFile(project);
    } catch (reseedErr) {
      logger.error({ err: reseedErr, projectId }, 'run: reseed guard failed — pausing (fail-loud)');
      state.status = 'paused';
      updateHarnessProject(projectId, { status: 'paused' });
      this.emitIPC('harness:project-update', { projectId, status: 'paused' });
      this.emitIPC('harness:error', { projectId, error: (reseedErr as Error).message });
      return;
    }

    const sprints = getHarnessSprints(projectId);
    if (sprints.length === 0) throw new Error('No sprints found for project');

    setProjectStatus(projectId, 'running');
    this.emitIPC('harness:project-update', { projectId, status: 'running' });

    for (let i = 0; i < sprints.length; i++) {
      if (resumeCheckpoint && i < resumeCheckpoint.sprintIndex) continue;

      if (state.pauseRequested) {
        updateHarnessProject(projectId, { status: 'paused', currentSprintIndex: i });
        this.emitIPC('harness:project-update', { projectId, status: 'paused' });
        state.status = 'paused';
        return;
      }

      if (state.abortController?.signal.aborted) {
        break;
      }

      const sprint = sprints[i];
      if (sprint.status === 'passed' || sprint.status === 'skipped') continue;
      const sprintCheckpoint =
        resumeCheckpoint?.sprintIndex === i && resumeCheckpoint.sprintId === sprint.id ? resumeCheckpoint : undefined;

      const queueIntegrity = checkHarnessSprintQueueIntegrity(project, getHarnessSprints(projectId));
      if (!queueIntegrity.ok) {
        logger.error(
          { projectId, sprintId: sprint.id, kind: queueIntegrity.kind },
          'run: fila de sprints divergente do sprints.json — pausando',
        );
        updateHarnessProject(projectId, { status: 'paused', currentSprintIndex: i });
        this.emitIPC('harness:project-update', { projectId, status: 'paused' });
        this.emitIPC('harness:error', { projectId, error: queueIntegrity.message });
        state.status = 'paused';
        return;
      }
      if (queueIntegrity.warning) {
        logger.warn(
          { projectId, sprintId: sprint.id, warning: queueIntegrity.warning },
          'run: divergencia legada tolerada',
        );
      }

      state.currentSprintIndex = i;
      updateHarnessProject(projectId, { currentSprintIndex: i });

      updateHarnessSprint(sprint.id, {
        status: 'running',
        startedAt: new Date().toISOString(),
      });
      this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'running' });

      const sprintsJson = readHarnessSprintsJson(project);
      if (!sprintsJson) {
        logger.error({ projectId, sprintId: sprint.id }, 'No sprints.json found during run — pausing');
        updateHarnessSprint(sprint.id, { status: 'interrupted' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'interrupted' });
        updateHarnessProject(projectId, { status: 'paused', currentSprintIndex: i });
        this.emitIPC('harness:project-update', { projectId, status: 'paused' });
        this.emitIPC('harness:error', {
          projectId,
          error: `No sprints.json found for project ${projectId}. Resete a fase do Planner para regenerar o plano.`,
        });
        state.status = 'paused';
        return;
      }

      const sprintJson = sprintsJson.sprints.find((s) => s.id === sprint.sprintJsonId);
      if (!sprintJson) {
        logger.error(
          { projectId, sprintId: sprint.id, sprintJsonId: sprint.sprintJsonId },
          'Sprint JSON entry not found — pausing',
        );
        updateHarnessSprint(sprint.id, { status: 'interrupted' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'interrupted' });
        updateHarnessProject(projectId, { status: 'paused', currentSprintIndex: i });
        this.emitIPC('harness:project-update', { projectId, status: 'paused' });
        this.emitIPC('harness:error', {
          projectId,
          error: `Sprint ${sprint.sprintJsonId} sumiu do sprints.json. Reverta o arquivo ou resete a fase do Sprint Validator/Planner.`,
        });
        state.status = 'paused';
        return;
      }

      const maxRounds = sprint.maxRounds ?? project.config.maxRoundsPerSprint;
      let lastFeedback = sprintCheckpoint?.lastFeedback;
      let sprintPassed = false;

      for (let roundNum = sprintCheckpoint?.roundNumber ?? 1; roundNum <= maxRounds; roundNum++) {
        if (state.abortController?.signal.aborted) break;
        if (state.pauseRequested) break;

        logger.info({ projectId, sprintId: sprint.id, round: roundNum }, 'Starting coder round');

        const roundCheckpoint = sprintCheckpoint?.roundNumber === roundNum ? sprintCheckpoint : undefined;
        const roundRecord = roundCheckpoint
          ? { id: roundCheckpoint.roundId }
          : persistHarnessRound.insert({
              sprintId: sprint.id,
              roundNumber: roundNum,
            });

        let coderMetrics: CoderRunResult;
        if (roundCheckpoint?.stage === 'evaluator' || roundCheckpoint?.stage === 'evaluator-completed') {
          coderMetrics = roundCheckpoint.coderMetrics;
        } else {
          try {
            coderMetrics = await this.spawnCoder(
              projectId,
              sprint,
              sprintJson,
              roundNum,
              roundNum > 1 ? lastFeedback : undefined,
            );
          } catch (coderErr) {
            if (isSubscriptionAuthError(coderErr)) {
              persistHarnessRound.update(roundRecord.id, {
                feedbackSummary: coderErr.message,
                completedAt: new Date().toISOString(),
              });
              updateHarnessSprint(sprint.id, { status: 'interrupted' });
              this.emitIPC('harness:sprint-update', {
                projectId,
                sprintId: sprint.id,
                status: 'interrupted',
              });
              this.pauseForProviderAuth(
                projectId,
                getPhaseNumberForAgent(project.pipelineType, sprint.coderAgentId ?? 'harness-coder') ?? 13,
                sprint.coderAgentId ?? 'harness-coder',
                coderErr,
                'harness',
                {
                  kind: 'run',
                  checkpoint: {
                    stage: 'coder',
                    sprintId: sprint.id,
                    sprintIndex: i,
                    roundNumber: roundNum,
                    roundId: roundRecord.id,
                    lastFeedback,
                  },
                },
              );
              return;
            }
            logger.error({ err: coderErr, projectId, sprintId: sprint.id, round: roundNum }, 'Coder failed');
            persistHarnessRound.update(roundRecord.id, {
              verdict: 'fail',
              feedbackSummary: (coderErr as Error).message,
              completedAt: new Date().toISOString(),
            });
            break;
          }

          persistHarnessRound.update(roundRecord.id, {
            coderInputTokens: coderMetrics.inputTokens,
            coderOutputTokens: coderMetrics.outputTokens,
            coderCacheTokens: coderMetrics.cacheTokens,
            coderCostUsd: coderMetrics.costUsd,
            coderDurationMs: coderMetrics.durationMs,
            coderToolUses: coderMetrics.toolUses,
            coderApiRequests: coderMetrics.apiRequests,
            costSource: coderMetrics.costSource,
            runtimeUsed: coderMetrics.runtimeUsed,
            providerUsed: coderMetrics.providerUsed,
            modelUsed: coderMetrics.modelUsed,
            ...(coderMetrics.costStatus === 'unknown' && { unknownCostCount: 1 }),
            metadata: {
              coderCostStatus: coderMetrics.costStatus ?? 'known',
              coderTokenStatus: coderMetrics.tokenStatus ?? 'reported',
              ...(coderMetrics.costEstimationKind ? { coderCostEstimationKind: coderMetrics.costEstimationKind } : {}),
              ...(coderMetrics.costUnknownReason ? { coderCostUnknownReason: coderMetrics.costUnknownReason } : {}),
            },
            ...(coderMetrics.agentMetadata?.sessionIds !== undefined &&
              coderMetrics.agentMetadata.sessionIds.length > 0 && {
                coderSessionId: coderMetrics.agentMetadata.sessionIds.join(','),
              }),
          });

          updateHarnessSprint(sprint.id, { roundsUsed: roundNum });
          const claimedResume = state.authResume;
          if (roundCheckpoint?.stage === 'coder' && claimedResume?.kind === 'run' && claimedResume.provider) {
            const advanced = this.advanceAuthCheckpoint(projectId, {
              kind: 'run',
              provider: claimedResume.provider,
              checkpoint: {
                ...roundCheckpoint,
                stage: 'evaluator',
                coderMetrics,
              },
            });
            if (advanced.kind === 'run') resumeCheckpoint = advanced.checkpoint;
          }
        }

        const evaluatorAlreadyCompleted = roundCheckpoint?.stage === 'evaluator-completed';
        let evaluatorMetrics: EvaluatorRunResult;
        if (evaluatorAlreadyCompleted) {
          evaluatorMetrics = roundCheckpoint.evaluatorMetrics;
        } else {
          try {
            evaluatorMetrics = await this.spawnEvaluator(projectId, sprint, sprintJson, roundNum);
          } catch (evalErr) {
            if (isSubscriptionAuthError(evalErr)) {
              persistHarnessRound.update(roundRecord.id, {
                feedbackSummary: evalErr.message,
                completedAt: new Date().toISOString(),
              });
              updateHarnessSprint(sprint.id, { status: 'interrupted' });
              this.emitIPC('harness:sprint-update', {
                projectId,
                sprintId: sprint.id,
                status: 'interrupted',
              });
              this.pauseForProviderAuth(
                projectId,
                getPhaseNumberForAgent(project.pipelineType, sprint.evaluatorAgentId ?? 'harness-evaluator') ?? 14,
                sprint.evaluatorAgentId ?? 'harness-evaluator',
                evalErr,
                'harness',
                {
                  kind: 'run',
                  checkpoint: {
                    stage: 'evaluator',
                    sprintId: sprint.id,
                    sprintIndex: i,
                    roundNumber: roundNum,
                    roundId: roundRecord.id,
                    lastFeedback,
                    coderMetrics,
                  },
                },
              );
              return;
            }
            logger.error({ err: evalErr, projectId, sprintId: sprint.id, round: roundNum }, 'Evaluator failed');
            persistHarnessRound.update(roundRecord.id, {
              verdict: 'fail',
              feedbackSummary: (evalErr as Error).message,
              completedAt: new Date().toISOString(),
            });
            break;
          }

          const evaluatorRoundCompletion = {
            evaluatorInputTokens: evaluatorMetrics.inputTokens,
            evaluatorOutputTokens: evaluatorMetrics.outputTokens,
            evaluatorCacheTokens: evaluatorMetrics.cacheTokens,
            evaluatorCostUsd: evaluatorMetrics.costUsd,
            evaluatorDurationMs: evaluatorMetrics.durationMs,
            evaluatorToolUses: evaluatorMetrics.toolUses,
            evaluatorApiRequests: evaluatorMetrics.apiRequests,
            verdict: evaluatorMetrics.evaluation.verdict,
            feedbackSummary: evaluatorMetrics.evaluation.summary,
            completedAt: new Date().toISOString(),
            ...(evaluatorMetrics.costStatus === 'unknown' && { unknownCostCount: 1 }),
            metadata: {
              coderCostStatus: coderMetrics.costStatus ?? 'known',
              coderTokenStatus: coderMetrics.tokenStatus ?? 'reported',
              ...(coderMetrics.costEstimationKind ? { coderCostEstimationKind: coderMetrics.costEstimationKind } : {}),
              ...(coderMetrics.costUnknownReason ? { coderCostUnknownReason: coderMetrics.costUnknownReason } : {}),
              evaluatorCostStatus: evaluatorMetrics.costStatus ?? 'known',
              evaluatorTokenStatus: evaluatorMetrics.tokenStatus ?? 'reported',
              ...(evaluatorMetrics.costEstimationKind
                ? { evaluatorCostEstimationKind: evaluatorMetrics.costEstimationKind }
                : {}),
              ...(evaluatorMetrics.costUnknownReason
                ? { evaluatorCostUnknownReason: evaluatorMetrics.costUnknownReason }
                : {}),
            },
            ...(evaluatorMetrics.agentMetadata?.sessionIds !== undefined &&
              evaluatorMetrics.agentMetadata.sessionIds.length > 0 && {
                evaluatorSessionId: evaluatorMetrics.agentMetadata.sessionIds.join(','),
              }),
          };

          const claimedResume = state.authResume;
          if (
            claimedResume?.kind === 'run' &&
            claimedResume.provider &&
            claimedResume.checkpoint.sprintId === sprint.id &&
            claimedResume.checkpoint.roundNumber === roundNum
          ) {
            if (!state.authCheckpointId) {
              throw new Error('Checkpoint de autenticacao reivindicado sem identidade duravel.');
            }
            const terminalResume: HarnessAuthResume = {
              kind: 'run',
              provider: claimedResume.provider,
              checkpoint: {
                ...claimedResume.checkpoint,
                stage: 'evaluator-completed',
                coderMetrics,
                evaluatorMetrics,
              },
            };
            const persisted = persistClaimedHarnessEvaluatorCompletion({
              projectId,
              checkpointId: state.authCheckpointId,
              roundId: roundRecord.id,
              resume: terminalResume,
              round: evaluatorRoundCompletion,
            });
            const advanced = persisted ? hydrateHarnessAuthResume(persisted) : undefined;
            if (advanced?.kind !== 'run') {
              throw new Error('Checkpoint de autenticacao mudou durante o commit atomico do evaluator.');
            }
            state.authResume = advanced;
            resumeCheckpoint = advanced.checkpoint;
          } else {
            persistHarnessRound.update(roundRecord.id, evaluatorRoundCompletion);
          }
        }

        if (roundCheckpoint) resumeCheckpoint = undefined;

        this.emitIPC('harness:sprint-update', {
          projectId,
          sprintId: sprint.id,
          round: roundNum,
          verdict: evaluatorMetrics.evaluation.verdict,
          coderMetrics,
          evaluatorMetrics: {
            inputTokens: evaluatorMetrics.inputTokens,
            outputTokens: evaluatorMetrics.outputTokens,
            cacheTokens: evaluatorMetrics.cacheTokens,
            costUsd: evaluatorMetrics.costUsd,
            durationMs: evaluatorMetrics.durationMs,
            toolUses: evaluatorMetrics.toolUses,
            apiRequests: evaluatorMetrics.apiRequests,
          },
        });

        if (evaluatorMetrics.evaluation.verdict === 'pass') {
          const allSprints = getHarnessSprints(projectId);
          const completedCount = allSprints.filter((s) => s.status === 'passed' || s.id === sprint.id).length;
          updateSpecProgress(project.projectPath, project.name, sprintJson, sprints.length, completedCount);
          sprintPassed = true;
          break;
        } else {
          lastFeedback = buildFeedbackFromEvaluation(evaluatorMetrics.evaluation);

          this.persistFeedbackAudit(
            projectId,
            sprint.id,
            roundNum,
            evaluatorMetrics.evaluation.verdict,
            evaluatorMetrics.evaluation.summary,
            evaluatorMetrics.evaluation.criteria
              .filter((c) => c.result === 'fail')
              .map((c) => ({ description: c.description, justification: c.justification })),
            lastFeedback,
          );

          logger.info(
            { projectId, sprintId: sprint.id, round: roundNum, feedbackLen: lastFeedback.length },
            'Sprint failed evaluation, feedback persisted, retrying...',
          );
        }
      }

      if (state.pauseRequested) {
        updateHarnessSprint(sprint.id, { status: 'interrupted' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'interrupted' });
        updateHarnessProject(projectId, { status: 'paused', currentSprintIndex: i });
        this.emitIPC('harness:project-update', { projectId, status: 'paused' });
        state.status = 'paused';
        return;
      }

      if (state.abortController?.signal.aborted) {
        updateHarnessSprint(sprint.id, { status: 'pending' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'pending' });
        break;
      }

      if (sprintPassed) {
        updateHarnessSprint(sprint.id, {
          status: 'passed',
          completedAt: new Date().toISOString(),
        });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'passed' });
        logger.info({ projectId, sprintId: sprint.id }, 'Sprint passed');
        this.completeStandaloneRoundCheckpoint(projectId, sprint.id);
      } else {
        updateHarnessSprint(sprint.id, {
          status: 'failed',
          completedAt: new Date().toISOString(),
        });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'failed' });
        setProjectStatus(projectId, 'paused');
        this.emitIPC('harness:project-update', { projectId, status: 'paused' });
        state.status = 'paused';
        this.completeStandaloneRoundCheckpoint(projectId, sprint.id);
        logger.warn(
          { projectId, sprintId: sprint.id, maxRounds },
          'Sprint exhausted max rounds - harness paused for user intervention',
        );
        return;
      }
    }

    if (!state.abortController?.signal.aborted) {
      setProjectStatus(projectId, 'done');
      this.emitIPC('harness:project-update', { projectId, status: 'done' });

      try {
        const sprintsJson = readHarnessSprintsJson(project);
        const expectedFiles = sprintsJson?.sprints.flatMap((s) => s.hints?.existing_files ?? []) ?? [];
        const docsCtx = getPipelineDocsContext(project.projectPath, project.pipelineDocsId ?? null);
        const reportPath = docsCtx
          ? docsCtx.resolveDocPath('smoke-test.md')
          : path.join(project.projectPath, 'smoke-test.md');
        const smoke = await runSmokeTest(project.projectPath, expectedFiles);
        writeSmokeTestReport(smoke, reportPath);
        logger.info(
          {
            projectId,
            reportPath,
            typecheckOk: smoke.typecheck.ok,
            lintAvailable: smoke.lint.available,
            testsAvailable: smoke.tests.available,
            brokenImports: smoke.brokenImports.length,
            missingFiles: smoke.missingFiles.length,
          },
          'Smoke test completed',
        );
      } catch (smokeErr) {
        logger.warn({ err: smokeErr, projectId }, 'Smoke test failed (non-blocking)');
      }
    }
    state.status = 'idle';
  }

  async runSingleSprint(projectId: string, sprintIndex: number, coderBriefingPrefix?: string): Promise<SprintResult> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const sprints = getHarnessSprints(projectId);
    if (sprintIndex < 0 || sprintIndex >= sprints.length) {
      throw new Error(`Sprint index ${sprintIndex} out of range (0..${sprints.length - 1})`);
    }

    const sprint = sprints[sprintIndex];
    const sprintsJson = readHarnessSprintsJson(project);
    if (!sprintsJson) throw new Error('No sprints.json found');

    const sprintJson = sprintsJson.sprints.find((s) => s.id === sprint.sprintJsonId);
    if (!sprintJson) throw new Error(`Sprint JSON entry not found for ${sprint.sprintJsonId}`);

    const coderPhaseNumber = getPhaseNumberForAgent(project.pipelineType, 'harness-coder') ?? 13;
    const evaluatorPhaseNumber = getPhaseNumberForAgent(project.pipelineType, 'harness-evaluator') ?? 14;

    const state = this.getState(projectId);
    const pendingPipelineResume = state.authResume?.kind === 'pipeline-run' ? state.authResume : undefined;
    if (pendingPipelineResume && !state.pipelineAuthResumeArmed) {
      const reason =
        pendingPipelineResume.provider === 'grok'
          ? 'grok-auth'
          : pendingPipelineResume.provider === 'kimi'
            ? 'kimi-auth'
            : 'codex-auth';
      throw new PipelinePausedError('Checkpoint do loop exige validacao de autenticacao antes do resume.', reason);
    }
    const resumeCheckpoint = pendingPipelineResume?.checkpoint;
    if (resumeCheckpoint && (resumeCheckpoint.sprintId !== sprint.id || resumeCheckpoint.sprintIndex !== sprintIndex)) {
      throw new Error('Checkpoint de autenticacao pertence a outro sprint do pipeline.');
    }
    if (resumeCheckpoint) {
      state.pipelineAuthResumeArmed = false;
    }
    state.status = 'running';
    state.abortController = new AbortController();

    updateHarnessSprint(sprint.id, { status: 'running', startedAt: new Date().toISOString() });
    this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'running' });

    const maxRounds = sprint.maxRounds ?? project.config.maxRoundsPerSprint;
    let lastFeedback: string | undefined = resumeCheckpoint?.lastFeedback;
    let sprintPassed = false;
    let totalRounds = resumeCheckpoint?.totalRounds ?? 0;

    const aggCoder: SprintMetrics = resumeCheckpoint
      ? { ...resumeCheckpoint.aggCoder }
      : {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cacheTokens: 0,
          costUsd: 0,
          durationMs: 0,
          toolUses: 0,
          apiRequests: 0,
          model: null,
          runtime: null,
        };
    const aggEval: SprintMetrics = resumeCheckpoint
      ? { ...resumeCheckpoint.aggEvaluator }
      : {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cacheTokens: 0,
          costUsd: 0,
          durationMs: 0,
          toolUses: 0,
          apiRequests: 0,
          model: null,
          runtime: null,
        };
    let aggCoderProviderSet = aggCoder.apiRequests > 0;
    let aggEvalProviderSet = aggEval.apiRequests > 0;

    let activeResumeCheckpoint = resumeCheckpoint;
    for (let roundNum = resumeCheckpoint?.roundNumber ?? 1; roundNum <= maxRounds; roundNum++) {
      if (state.abortController?.signal.aborted) break;

      totalRounds = roundNum;
      logger.info({ projectId, sprintId: sprint.id, round: roundNum }, 'runSingleSprint: coder round');

      const roundCheckpoint = activeResumeCheckpoint?.roundNumber === roundNum ? activeResumeCheckpoint : undefined;
      const roundRecord = roundCheckpoint
        ? { id: roundCheckpoint.roundId }
        : persistHarnessRound.insert({ sprintId: sprint.id, roundNumber: roundNum });

      if (roundNum > 1) {
        const coderAgentForModel = sprint.coderAgentId ? getAgent(sprint.coderAgentId) : null;
        this.emitIPC('pipeline:phase-changed', {
          projectId,
          phase: 13,
          phaseName: 'Coder',
          status: 'running',
          awaitingUser: false,
          currentModel: coderAgentForModel?.model ?? null,
        });
      }

      let coderMetrics: CoderRunResult;
      const coderAlreadyCompleted =
        roundCheckpoint?.stage === 'evaluator' || roundCheckpoint?.stage === 'evaluator-completed';
      if (coderAlreadyCompleted) {
        coderMetrics = roundCheckpoint.coderMetrics;
      } else {
        try {
          coderMetrics = await this.spawnCoder(
            projectId,
            sprint,
            sprintJson,
            roundNum,
            roundNum > 1 ? lastFeedback : undefined,
            coderBriefingPrefix,
            'pipeline',
          );
        } catch (coderErr) {
          if (isSubscriptionAuthError(coderErr)) {
            persistHarnessRound.update(roundRecord.id, {
              feedbackSummary: coderErr.message,
              completedAt: new Date().toISOString(),
            });
            updateHarnessSprint(sprint.id, { status: 'interrupted' });
            this.emitIPC('harness:sprint-update', {
              projectId,
              sprintId: sprint.id,
              status: 'interrupted',
            });
            throw this.pauseForProviderAuth(
              projectId,
              coderPhaseNumber,
              sprint.coderAgentId ?? 'harness-coder',
              coderErr,
              'pipeline',
              {
                kind: 'pipeline-run',
                checkpoint: {
                  stage: 'coder',
                  sprintId: sprint.id,
                  sprintIndex,
                  roundNumber: roundNum,
                  roundId: roundRecord.id,
                  totalRounds,
                  lastFeedback,
                  aggCoder: { ...aggCoder },
                  aggEvaluator: { ...aggEval },
                },
              },
            )!;
          }
          logger.error({ err: coderErr, projectId, sprintId: sprint.id, round: roundNum }, 'Coder failed');
          persistHarnessRound.update(roundRecord.id, {
            verdict: 'fail',
            feedbackSummary: (coderErr as Error).message,
            completedAt: new Date().toISOString(),
          });
          break;
        }

        persistHarnessRound.update(roundRecord.id, {
          coderInputTokens: coderMetrics.inputTokens,
          coderOutputTokens: coderMetrics.outputTokens,
          coderCacheTokens: coderMetrics.cacheTokens,
          coderCostUsd: coderMetrics.costUsd,
          coderDurationMs: coderMetrics.durationMs,
          coderToolUses: coderMetrics.toolUses,
          coderApiRequests: coderMetrics.apiRequests,
          costSource: coderMetrics.costSource,
          runtimeUsed: coderMetrics.runtimeUsed,
          providerUsed: coderMetrics.providerUsed,
          modelUsed: coderMetrics.modelUsed,
          codexPatchFailures: coderMetrics.codexPatchFailures,
          ...(coderMetrics.costStatus === 'unknown' && { unknownCostCount: 1 }),
          metadata: {
            coderCostStatus: coderMetrics.costStatus ?? 'known',
            coderTokenStatus: coderMetrics.tokenStatus ?? 'reported',
            ...(coderMetrics.costEstimationKind ? { coderCostEstimationKind: coderMetrics.costEstimationKind } : {}),
            ...(coderMetrics.costUnknownReason ? { coderCostUnknownReason: coderMetrics.costUnknownReason } : {}),
          },
          ...(coderMetrics.agentMetadata?.sessionIds !== undefined &&
            coderMetrics.agentMetadata.sessionIds.length > 0 && {
              coderSessionId: coderMetrics.agentMetadata.sessionIds.join(','),
            }),
        });
        mergeUsageMetadata(aggCoder, coderMetrics.agentMetadata);
        aggCoder.inputTokens += coderMetrics.inputTokens;
        aggCoder.outputTokens += coderMetrics.outputTokens;
        aggCoder.cacheReadTokens += coderMetrics.cacheReadTokens;
        aggCoder.cacheCreationTokens += coderMetrics.cacheCreationTokens;
        aggCoder.cacheTokens = aggCoder.cacheReadTokens + aggCoder.cacheCreationTokens;
        aggCoder.costUsd += coderMetrics.costUsd;
        aggCoder.durationMs += coderMetrics.durationMs;
        aggCoder.toolUses += coderMetrics.toolUses;
        aggCoder.apiRequests += coderMetrics.apiRequests;
        aggCoder.model = coderMetrics.modelUsed;
        aggCoder.runtime = coderMetrics.runtimeUsed;
        if (coderMetrics.costStatus === 'unknown') {
          aggCoder.costStatus = 'unknown';
          aggCoder.costUnknownReason = coderMetrics.costUnknownReason;
          aggCoder.unknownCostCount = (aggCoder.unknownCostCount ?? 0) + 1;
        } else if (coderMetrics.costStatus === 'estimated-partial' && aggCoder.costStatus !== 'unknown') {
          aggCoder.costStatus = 'estimated-partial';
        }
        if (coderMetrics.tokenStatus === 'not_reported') aggCoder.tokenStatus = 'not_reported';
        if (!aggCoderProviderSet) {
          if (coderMetrics.providerUsed) aggCoder.provider = coderMetrics.providerUsed;
          if (coderMetrics.costEstimationKind !== undefined) {
            aggCoder.costEstimationKind = coderMetrics.costEstimationKind;
          }
          aggCoderProviderSet = true;
        }

        try {
          if (coderMetrics.promptUsed) {
            persistMessage(
              {
                kind: 'pipeline',
                projectId,
                phaseNumber: coderPhaseNumber,
                sprintIndex,
                roundIndex: roundNum,
                agentId: sprint.coderAgentId ?? 'harness-coder',
              },
              'user',
              coderMetrics.promptUsed,
            );
          }
          if (coderMetrics.output) {
            persistMessage(
              {
                kind: 'pipeline',
                projectId,
                phaseNumber: coderPhaseNumber,
                sprintIndex,
                roundIndex: roundNum,
                agentId: sprint.coderAgentId ?? 'harness-coder',
              },
              'assistant',
              coderMetrics.output,
              { toolCalls: coderMetrics.toolCallsAccum.length > 0 ? coderMetrics.toolCallsAccum : undefined },
            );
          }
        } catch (saveErr) {
          logger.warn(
            { err: saveErr, projectId, sprintId: sprint.id, round: roundNum },
            'Failed to save coder pipeline_message — non-critical',
          );
        }

        updateHarnessSprint(sprint.id, { roundsUsed: roundNum });
        const claimedResume = state.authResume;
        if (roundCheckpoint?.stage === 'coder' && claimedResume?.kind === 'pipeline-run' && claimedResume.provider) {
          const advanced = this.advanceAuthCheckpoint(projectId, {
            kind: 'pipeline-run',
            provider: claimedResume.provider,
            checkpoint: {
              ...claimedResume.checkpoint,
              stage: 'evaluator',
              coderMetrics,
              aggCoder: { ...aggCoder },
              aggEvaluator: { ...aggEval },
            },
          });
          if (advanced.kind === 'pipeline-run') activeResumeCheckpoint = advanced.checkpoint;
        }
      }

      const evaluatorAgentForModel = sprint.evaluatorAgentId ? getAgent(sprint.evaluatorAgentId) : null;
      this.emitIPC('pipeline:phase-changed', {
        projectId,
        phase: evaluatorPhaseNumber,
        phaseName: 'Evaluator',
        status: 'running',
        awaitingUser: false,
        currentModel: evaluatorAgentForModel?.model ?? null,
      });

      const MAX_EVAL_RETRIES = 1;
      const evaluatorAlreadyCompleted = roundCheckpoint?.stage === 'evaluator-completed';
      let evaluatorMetrics: EvaluatorRunResult | undefined = evaluatorAlreadyCompleted
        ? roundCheckpoint.evaluatorMetrics
        : undefined;
      let evalFinalError: Error | undefined;
      for (let evalAttempt = 0; !evaluatorAlreadyCompleted && evalAttempt <= MAX_EVAL_RETRIES; evalAttempt++) {
        try {
          evaluatorMetrics = await this.spawnEvaluator(projectId, sprint, sprintJson, roundNum, 'pipeline');
          break;
        } catch (evalErr) {
          if (isSubscriptionAuthError(evalErr)) {
            persistHarnessRound.update(roundRecord.id, {
              feedbackSummary: evalErr.message,
              completedAt: new Date().toISOString(),
            });
            updateHarnessSprint(sprint.id, { status: 'interrupted' });
            this.emitIPC('harness:sprint-update', {
              projectId,
              sprintId: sprint.id,
              status: 'interrupted',
            });
            throw this.pauseForProviderAuth(
              projectId,
              evaluatorPhaseNumber,
              sprint.evaluatorAgentId ?? 'harness-evaluator',
              evalErr,
              'pipeline',
              {
                kind: 'pipeline-run',
                checkpoint: {
                  stage: 'evaluator',
                  sprintId: sprint.id,
                  sprintIndex,
                  roundNumber: roundNum,
                  roundId: roundRecord.id,
                  totalRounds,
                  lastFeedback,
                  aggCoder: { ...aggCoder },
                  aggEvaluator: { ...aggEval },
                  coderMetrics,
                },
              },
            )!;
          }
          const msg = (evalErr as Error).message ?? '';
          const isParseError =
            msg.includes('contains no JSON object') ||
            msg.includes('contains no valid JSON') ||
            msg.includes('Evaluator returned empty output');
          if (isParseError && evalAttempt < MAX_EVAL_RETRIES) {
            logger.warn(
              {
                projectId,
                sprintId: sprint.id,
                round: roundNum,
                evalAttempt: evalAttempt + 1,
                totalAttempts: MAX_EVAL_RETRIES + 1,
              },
              'Evaluator JSON parse falhou — retrying',
            );
            continue;
          }
          evalFinalError = evalErr as Error;
          break;
        }
      }

      if (!evaluatorMetrics) {
        logger.error(
          { err: evalFinalError, projectId, sprintId: sprint.id, round: roundNum },
          'Evaluator failed (apos retries)',
        );
        persistHarnessRound.update(roundRecord.id, {
          verdict: 'fail',
          feedbackSummary: evalFinalError?.message ?? 'Evaluator falhou',
          completedAt: new Date().toISOString(),
        });
        break;
      }
      if (!evaluatorAlreadyCompleted) {
        const evaluatorRoundCompletion = {
          evaluatorInputTokens: evaluatorMetrics.inputTokens,
          evaluatorOutputTokens: evaluatorMetrics.outputTokens,
          evaluatorCacheTokens: evaluatorMetrics.cacheTokens,
          evaluatorCostUsd: evaluatorMetrics.costUsd,
          evaluatorDurationMs: evaluatorMetrics.durationMs,
          evaluatorToolUses: evaluatorMetrics.toolUses,
          evaluatorApiRequests: evaluatorMetrics.apiRequests,
          verdict: evaluatorMetrics.evaluation.verdict,
          feedbackSummary: evaluatorMetrics.evaluation.summary,
          completedAt: new Date().toISOString(),
          metadata: {
            evaluatorParseTier: evaluatorMetrics.parseTier,
            coderCostStatus: coderMetrics.costStatus ?? 'known',
            coderTokenStatus: coderMetrics.tokenStatus ?? 'reported',
            ...(coderMetrics.costEstimationKind ? { coderCostEstimationKind: coderMetrics.costEstimationKind } : {}),
            ...(coderMetrics.costUnknownReason ? { coderCostUnknownReason: coderMetrics.costUnknownReason } : {}),
            evaluatorCostStatus: evaluatorMetrics.costStatus ?? 'known',
            evaluatorTokenStatus: evaluatorMetrics.tokenStatus ?? 'reported',
            ...(evaluatorMetrics.costEstimationKind
              ? { evaluatorCostEstimationKind: evaluatorMetrics.costEstimationKind }
              : {}),
            ...(evaluatorMetrics.costUnknownReason
              ? { evaluatorCostUnknownReason: evaluatorMetrics.costUnknownReason }
              : {}),
          },
          ...(evaluatorMetrics.costStatus === 'unknown' && { unknownCostCount: 1 }),
          ...(evaluatorMetrics.agentMetadata?.sessionIds !== undefined &&
            evaluatorMetrics.agentMetadata.sessionIds.length > 0 && {
              evaluatorSessionId: evaluatorMetrics.agentMetadata.sessionIds.join(','),
            }),
        };
        mergeUsageMetadata(aggEval, evaluatorMetrics.agentMetadata);
        aggEval.inputTokens += evaluatorMetrics.inputTokens;
        aggEval.outputTokens += evaluatorMetrics.outputTokens;
        aggEval.cacheReadTokens += evaluatorMetrics.cacheReadTokens;
        aggEval.cacheCreationTokens += evaluatorMetrics.cacheCreationTokens;
        aggEval.cacheTokens = aggEval.cacheReadTokens + aggEval.cacheCreationTokens;
        aggEval.costUsd += evaluatorMetrics.costUsd;
        aggEval.durationMs += evaluatorMetrics.durationMs;
        aggEval.toolUses += evaluatorMetrics.toolUses;
        aggEval.apiRequests += evaluatorMetrics.apiRequests;
        aggEval.model = evaluatorMetrics.modelUsed;
        aggEval.runtime = evaluatorMetrics.runtimeUsed;
        if (evaluatorMetrics.costStatus === 'unknown') {
          aggEval.costStatus = 'unknown';
          aggEval.costUnknownReason = evaluatorMetrics.costUnknownReason;
          aggEval.unknownCostCount = (aggEval.unknownCostCount ?? 0) + 1;
        } else if (evaluatorMetrics.costStatus === 'estimated-partial' && aggEval.costStatus !== 'unknown') {
          aggEval.costStatus = 'estimated-partial';
        }
        if (evaluatorMetrics.tokenStatus === 'not_reported') aggEval.tokenStatus = 'not_reported';
        if (!aggEvalProviderSet) {
          if (evaluatorMetrics.providerUsed) aggEval.provider = evaluatorMetrics.providerUsed;
          if (evaluatorMetrics.costEstimationKind !== undefined) {
            aggEval.costEstimationKind = evaluatorMetrics.costEstimationKind;
          }
          aggEvalProviderSet = true;
        }

        const claimedResume = state.authResume;
        if (
          claimedResume?.kind === 'pipeline-run' &&
          claimedResume.provider &&
          claimedResume.checkpoint.sprintId === sprint.id &&
          claimedResume.checkpoint.roundNumber === roundNum
        ) {
          if (!state.authCheckpointId) {
            throw new Error('Checkpoint de autenticacao reivindicado sem identidade duravel.');
          }
          const terminalResume: HarnessAuthResume = {
            kind: 'pipeline-run',
            provider: claimedResume.provider,
            checkpoint: {
              ...claimedResume.checkpoint,
              stage: 'evaluator-completed',
              coderMetrics,
              evaluatorMetrics,
              aggCoder: { ...aggCoder },
              aggEvaluator: { ...aggEval },
            },
          };
          const persisted = persistClaimedHarnessEvaluatorCompletion({
            projectId,
            checkpointId: state.authCheckpointId,
            roundId: roundRecord.id,
            resume: terminalResume,
            round: evaluatorRoundCompletion,
            ...(evaluatorMetrics.output
              ? {
                  pipelineMessage: {
                    projectId,
                    phaseNumber: evaluatorPhaseNumber,
                    role: 'assistant' as const,
                    content: evaluatorMetrics.output,
                    toolCalls: evaluatorMetrics.toolCallsAccum.length > 0 ? evaluatorMetrics.toolCallsAccum : undefined,
                    sprintIndex,
                    roundIndex: roundNum,
                    agentId: sprint.evaluatorAgentId ?? 'harness-evaluator',
                  },
                }
              : {}),
          });
          const advanced = persisted ? hydrateHarnessAuthResume(persisted) : undefined;
          if (advanced?.kind !== 'pipeline-run') {
            throw new Error('Checkpoint de autenticacao mudou durante o commit atomico do evaluator.');
          }
          state.authResume = advanced;
          activeResumeCheckpoint = advanced.checkpoint;
        } else {
          persistHarnessRound.update(roundRecord.id, evaluatorRoundCompletion);
          try {
            if (evaluatorMetrics.output) {
              persistMessage(
                {
                  kind: 'pipeline',
                  projectId,
                  phaseNumber: evaluatorPhaseNumber,
                  sprintIndex,
                  roundIndex: roundNum,
                  agentId: sprint.evaluatorAgentId ?? 'harness-evaluator',
                },
                'assistant',
                evaluatorMetrics.output,
                { toolCalls: evaluatorMetrics.toolCallsAccum.length > 0 ? evaluatorMetrics.toolCallsAccum : undefined },
              );
            }
          } catch (saveErr) {
            logger.warn(
              { err: saveErr, projectId, sprintId: sprint.id, round: roundNum },
              'Failed to save evaluator pipeline_message — non-critical',
            );
          }
        }
      }
      activeResumeCheckpoint = undefined;

      this.emitIPC('harness:sprint-update', {
        projectId,
        sprintId: sprint.id,
        round: roundNum,
        verdict: evaluatorMetrics.evaluation.verdict,
        coderMetrics,
        evaluatorMetrics: {
          inputTokens: evaluatorMetrics.inputTokens,
          outputTokens: evaluatorMetrics.outputTokens,
          cacheReadTokens: evaluatorMetrics.cacheReadTokens,
          cacheCreationTokens: evaluatorMetrics.cacheCreationTokens,
          cacheTokens: evaluatorMetrics.cacheTokens,
          costUsd: evaluatorMetrics.costUsd,
          durationMs: evaluatorMetrics.durationMs,
          toolUses: evaluatorMetrics.toolUses,
          apiRequests: evaluatorMetrics.apiRequests,
        },
      });

      if (evaluatorMetrics.evaluation.verdict === 'pass') {
        const allSprints = getHarnessSprints(projectId);
        const completedCount = allSprints.filter((s) => s.status === 'passed' || s.id === sprint.id).length;
        updateSpecProgress(project.projectPath, project.name, sprintJson, sprints.length, completedCount);
        sprintPassed = true;
        break;
      } else {
        lastFeedback = buildFeedbackFromEvaluation(evaluatorMetrics.evaluation);
        this.persistFeedbackAudit(
          projectId,
          sprint.id,
          roundNum,
          evaluatorMetrics.evaluation.verdict,
          evaluatorMetrics.evaluation.summary,
          evaluatorMetrics.evaluation.criteria
            .filter((c) => c.result === 'fail')
            .map((c) => ({ description: c.description, justification: c.justification })),
          lastFeedback,
        );
      }
    }

    const finalVerdict = sprintPassed ? 'pass' : 'fail';

    if (sprintPassed) {
      updateHarnessSprint(sprint.id, { status: 'passed', completedAt: new Date().toISOString() });
      this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'passed' });
    } else {
      updateHarnessSprint(sprint.id, { status: 'failed', completedAt: new Date().toISOString() });
      this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'failed' });
    }

    state.status = 'idle';

    return {
      verdict: finalVerdict,
      rounds: totalRounds,
      metrics: { coder: aggCoder, evaluator: aggEval },
      coderMetrics: aggCoder,
      evaluatorMetrics: aggEval,
    };
  }

  pause(projectId: string): void {
    const state = this.getState(projectId);
    state.pauseRequested = true;
    logger.info({ projectId }, 'Pause requested');
  }

  pauseAllForAuthorizationLoss(): number {
    let paused = 0;
    for (const [projectId, state] of this.states) {
      if (state.status !== 'running' && state.status !== 'planning') continue;
      this.abort(projectId);
      paused += 1;
    }
    return paused;
  }

  private claimAuthCheckpoint(projectId: string, state: HarnessState): HarnessAuthResume | undefined {
    if (!state.authCheckpointId) return undefined;
    const persisted = claimHarnessProviderAuthCheckpoint(projectId, state.authCheckpointId);
    if (!persisted) return undefined;
    const resume = hydrateHarnessAuthResume(persisted);
    if (!resume) return undefined;
    state.authResume = resume;
    return resume;
  }

  private advanceAuthCheckpoint(projectId: string, resume: HarnessAuthResume): HarnessAuthResume {
    const state = this.getState(projectId);
    if (!state.authCheckpointId || !resume.provider) {
      throw new Error('Checkpoint de autenticacao nao esta reivindicado para avancar a etapa.');
    }
    const persisted = advanceClaimedHarnessProviderAuthCheckpoint(projectId, state.authCheckpointId, resume);
    const hydrated = persisted ? hydrateHarnessAuthResume(persisted) : undefined;
    if (!hydrated) {
      throw new Error('Checkpoint de autenticacao mudou antes do commit duravel da etapa.');
    }
    state.authResume = hydrated;
    return hydrated;
  }

  private completeAuthCheckpoint(projectId: string, checkpointId: string): boolean {
    if (!completeHarnessProviderAuthCheckpoint(projectId, checkpointId)) return false;
    const state = this.getState(projectId);
    if (state.authCheckpointId === checkpointId) {
      state.authCheckpointId = undefined;
      state.authResume = undefined;
      state.pipelineAuthResumeArmed = false;
    }
    return true;
  }

  private completeStandaloneRoundCheckpoint(projectId: string, sprintId: string): void {
    const state = this.getState(projectId);
    const resume = state.authResume;
    if (
      resume?.kind !== 'run' ||
      resume.checkpoint.stage !== 'evaluator-completed' ||
      resume.checkpoint.sprintId !== sprintId ||
      !state.authCheckpointId
    )
      return;
    if (!this.completeAuthCheckpoint(projectId, state.authCheckpointId)) {
      throw new Error('Checkpoint concluido do harness mudou antes do commit do sprint.');
    }
  }

  preparePipelineResumeAfterAuth(
    projectId: string,
    provider: SubscriptionProvider,
  ): { ok: true } | { ok: false; message: string } {
    const state = this.getState(projectId);
    if (
      state.pipelineAuthResumeArmed ||
      (state.authCheckpointId && (state.status === 'planning' || state.status === 'running'))
    ) {
      return { ok: false, message: 'Retomada do checkpoint de autenticacao ja esta em andamento.' };
    }
    const checkpoint = state.authResume;
    if (!checkpoint) {
      return state.authCheckpointId
        ? { ok: false, message: 'Checkpoint persistido de autenticacao do loop e invalido.' }
        : { ok: true };
    }
    const belongsToPipeline =
      checkpoint.kind === 'pipeline-run' || (checkpoint.kind === 'plan' && checkpoint.executionOwner === 'pipeline');
    if (!belongsToPipeline) {
      return { ok: false, message: 'Checkpoint de autenticacao pertence ao harness standalone.' };
    }
    if (checkpoint.provider !== provider) {
      return { ok: false, message: 'Checkpoint de autenticacao/provider do loop nao confere.' };
    }
    const claimed = this.claimAuthCheckpoint(projectId, state);
    if (!claimed || claimed.provider !== provider) {
      return { ok: false, message: 'Checkpoint de autenticacao do loop mudou durante a revalidacao.' };
    }
    state.pipelineAuthResumeArmed = true;
    return { ok: true };
  }

  completePipelineResumeAfterAuth(projectId: string, provider: SubscriptionProvider): boolean {
    const state = this.getState(projectId);
    if (!state.authCheckpointId) return true;
    const persisted = getHarnessProviderAuthCheckpoint(projectId);
    if (!persisted || persisted.provider !== provider || persisted.claimState !== 'claimed') return false;
    return this.completeAuthCheckpoint(projectId, persisted.checkpointId);
  }

  private resumeProject(
    projectId: string,
    authResume?: Exclude<HarnessAuthResume, { kind: 'pipeline-run' }>,
    authCheckpointId?: string,
  ): { ok: true } | { ok: false; message: string } {
    const project = getHarnessProject(projectId);
    if (!project) {
      logger.warn({ projectId }, 'Resume: project not found');
      return { ok: false, message: 'Projeto do harness nao encontrado.' };
    }

    const persistedCheckpoint = authCheckpointId ? getHarnessProviderAuthCheckpoint(projectId) : undefined;
    const recoveringClaimedCheckpoint =
      persistedCheckpoint?.checkpointId === authCheckpointId && persistedCheckpoint?.claimState === 'claimed';
    if (project.status !== 'paused' && !(recoveringClaimedCheckpoint && project.status === 'running')) {
      logger.warn({ projectId, status: project.status }, 'Resume: project is not paused');
      return { ok: false, message: `Projeto do harness nao esta pausado (status: ${project.status}).` };
    }

    const state = this.getState(projectId);
    state.authResume = authResume?.kind === 'run' ? authResume : undefined;
    state.pauseRequested = false;
    state.status = 'idle';

    const sprints = getHarnessSprints(projectId);
    for (const sprint of sprints) {
      if (sprint.status === 'interrupted') {
        updateHarnessSprint(sprint.id, { status: 'pending' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'pending' });
      }
    }

    const resumed =
      authResume?.kind === 'plan'
        ? this.plan(projectId, authResume.briefingPrefix, authResume.executionOwner)
        : authResume?.kind === 'regenerate'
          ? this.regenerate(projectId, authResume.feedback)
          : this.run(projectId, authResume?.kind === 'run' ? authResume.checkpoint : undefined);
    void Promise.resolve(resumed)
      .then(() => {
        if (authCheckpointId) this.completeAuthCheckpoint(projectId, authCheckpointId);
      })
      .catch((err) => {
        logger.error({ err, projectId }, 'Error resuming harness');
        this.emitIPC('harness:error', { projectId, error: (err as Error).message });
      });
    return { ok: true };
  }

  resume(projectId: string): { ok: true } | { ok: false; message: string } {
    const state = this.getState(projectId);
    if (state.authResume || state.authCheckpointId) {
      const provider = state.authResume?.provider ?? 'provider';
      logger.warn({ projectId, provider }, 'Resume exige revalidacao de autenticacao.');
      return {
        ok: false,
        message: `Retomada bloqueada: reconecte o ${provider} no aviso de autenticacao, verifique o login e tente novamente.`,
      };
    }
    return this.resumeProject(projectId);
  }

  async resumeAfterAuth(
    projectId: string,
    requestedProvider?: SubscriptionProvider,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const state = this.getState(projectId);
    if (state.authCheckpointId && (state.status === 'planning' || state.status === 'running')) {
      return { ok: false, message: 'Retomada do checkpoint de autenticacao ja esta em andamento.' };
    }
    const checkpoint = state.authResume;
    const provider = requestedProvider ?? checkpoint?.provider;
    if (!checkpoint || !provider || checkpoint.provider !== provider) {
      return { ok: false, message: 'Checkpoint de autenticacao/provider do harness nao confere.' };
    }
    if (checkpoint.kind === 'pipeline-run') {
      return { ok: false, message: 'Checkpoint de autenticacao pertence ao loop do pipeline.' };
    }
    const error = await validateSubscriptionProviderAuth(provider);
    if (error) return { ok: false, message: error };
    if (state.authResume !== checkpoint) {
      return { ok: false, message: 'Checkpoint de autenticacao do harness mudou durante a revalidacao.' };
    }
    const checkpointId = state.authCheckpointId;
    const claimed = this.claimAuthCheckpoint(projectId, state);
    if (!checkpointId || !claimed || claimed.provider !== provider || claimed.kind === 'pipeline-run') {
      return { ok: false, message: 'Checkpoint de autenticacao do harness mudou durante a revalidacao.' };
    }
    return this.resumeProject(projectId, claimed, checkpointId);
  }

  abort(projectId: string): void {
    const state = this.getState(projectId);
    if (state.abortController) {
      state.abortController.abort();
    }

    const sprints = getHarnessSprints(projectId);
    for (const sprint of sprints) {
      if (sprint.status === 'running') {
        updateHarnessSprint(sprint.id, { status: 'pending' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'pending' });
      }
    }

    state.status = 'idle';
    setProjectStatus(projectId, 'paused');
    this.emitIPC('harness:project-update', { projectId, status: 'paused' });
    logger.info({ projectId }, 'Harness aborted - project paused for resume');
  }

  getStatus(projectId: string): HarnessState {
    return this.getState(projectId);
  }

  hasActiveEnrichSession(): boolean {
    return this.activeEnrichSession !== null;
  }

  private async runEnrichExecuteAgent(
    prompt: string,
    agent: import('../../src/types').AgentConfig,
    specPath: string,
    sessionId: string,
    phase: 'validator' | 'enricher',
    isFollowUp?: boolean,
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    durationMs: number;
    toolUses: number;
    apiRequests: number;
    costStatus?: 'known' | 'unknown' | 'estimated-partial';
    tokenStatus?: 'reported' | 'not_reported';
    costUnknownReason?: string;
    costSource?: string;
    costEstimationKind?: 'subscription-equivalent-payg';
    unknownCostCount?: number;
    usageMetadata?: NonNullable<AgentExecutionResult['metadata']>;
  }> {
    const abort = this.activeEnrichSession?.abort ?? new AbortController();

    const cwd = path.dirname(specPath);

    logger.info(
      { sessionId, phase, agentId: agent.id, model: agent.model, cwd, isFollowUp },
      'Starting enrich agent via executeAgent',
    );

    let accumulatedText = '';
    const accumulatedToolCalls: Array<{ tool: string; input: unknown }> = [];

    const enrichGuard = createEnrichPermissionGuard(this.getWindow, sessionId);
    const enrichPermission = PERM_DEFAULT_WITH_GUARD(enrichGuard);
    const executionContext = createSubagentDispatchContext({
      ownerKind: 'enrich',
      ownerId: sessionId,
      lane: 'desktop',
      surface: `enrich:${phase}`,
      cwd,
      readRoots: [cwd],
      writeRoots: [cwd],
      allowedTools: agent.allowedTools,
      permission: enrichPermission,
      parentAbortSignal: abort.signal,
      abortOwner: (reason) => abort.abort(reason),
    });

    const startedAt = Date.now();

    const result = await this.executeAgentWithSubagentControl(
      {
        agentId: agent.id,
        prompt,
        cwd,
        abortController: abort,
        permission: enrichPermission,
        executionContext,
        onText: (text) => {
          accumulatedText += text;
          this.emitIPC('enrich:stream', {
            type: 'text',
            content: text,
            sessionId,
            phase,
          });
        },
        onThinking: (text) => {
          this.emitIPC('enrich:stream', {
            type: 'thinking',
            content: text,
            sessionId,
            phase,
          });
        },
        onToolUse: (toolName) => {
          this.emitIPC('enrich:stream', {
            type: 'tool_call',
            tool: toolName,
            sessionId,
            phase,
          });
        },
        onToolUseComplete: (toolName, input) => {
          accumulatedToolCalls.push({ tool: toolName, input: input ?? {} });
        },
      },
      executionContext,
    );

    if (result.output) {
      this.emitIPC('enrich:stream', {
        type: 'done',
        content: result.output,
        sessionId,
        phase,
      });
    } else {
      this.emitIPC('enrich:stream', {
        type: 'done',
        sessionId,
        phase,
      });
    }
    logger.info({ sessionId, phase }, 'Enrich agent turn completed');

    if (accumulatedText || accumulatedToolCalls.length > 0) {
      try {
        persistMessage({ kind: 'enrich', sessionId, phase }, 'assistant', accumulatedText, {
          toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
        });
      } catch (err) {
        logger.error({ err, sessionId, phase }, 'Failed to persist enrich assistant message');
      }
    }

    const durationMs = Date.now() - startedAt;
    const costUsd = result.metrics.costUsd;

    logger.info(
      {
        sessionId,
        phase,
        durationMs,
        costUsd,
        toolUses: result.metrics.toolUses,
        apiRequests: result.metrics.apiRequests,
        inputTokens: result.metrics.inputTokens,
        outputTokens: result.metrics.outputTokens,
      },
      'Enrich executeAgent metrics collected',
    );

    return {
      inputTokens: result.metrics.inputTokens,
      outputTokens: result.metrics.outputTokens,
      cacheReadTokens: result.metrics.cacheReadTokens,
      cacheCreationTokens: result.metrics.cacheCreationTokens,
      costUsd,
      durationMs,
      toolUses: result.metrics.toolUses,
      apiRequests: result.metrics.apiRequests,
      costStatus: result.metrics.costStatus,
      tokenStatus: result.metrics.tokenStatus,
      costUnknownReason: result.metrics.costUnknownReason,
      costSource: result.metadata?.costSource,
      costEstimationKind: result.metadata?.costEstimationKind,
      unknownCostCount: result.metrics.costStatus === 'unknown' ? 1 : 0,
      ...(result.metadata ? { usageMetadata: result.metadata } : {}),
    };
  }

  private pauseEnrichForProviderAuth(
    sessionId: string,
    resume: NonNullable<ActiveEnrichSession['authResume']>,
    error: SubscriptionAuthError,
  ): void {
    const active = this.activeEnrichSession;
    if (!active || active.sessionId !== sessionId) return;
    active.authResume = { ...resume, provider: subscriptionAuthProvider(error) };
    updateEnrichSession(sessionId, { status: 'paused' });
    this.emitIPC('enrich:status', { sessionId, phase: resume.phase, status: 'paused' });
    this.emitIPC('pipeline:auth-required', {
      provider: subscriptionAuthProvider(error),
      runtime: subscriptionAuthProvider(error),
      projectId: sessionId,
      phaseNumber: resume.phase === 'validator' ? 1 : 2,
      agentId: resume.agentId,
      message: error.message,
      ownerKind: 'enrich',
    });
  }

  async resumeEnrichAfterAuth(sessionId: string, requestedProvider?: SubscriptionProvider): Promise<void> {
    const active = this.activeEnrichSession;
    const resume = active?.authResume;
    if (!active || active.sessionId !== sessionId || !resume) {
      throw new Error(`Enrich session has no Grok auth checkpoint: ${sessionId}`);
    }
    const provider = requestedProvider ?? resume.provider;
    if (!provider || resume.provider !== provider) {
      throw new Error('Checkpoint de autenticacao/provider do enrich nao confere.');
    }
    const authError = await validateSubscriptionProviderAuth(provider);
    if (authError) throw new Error(authError);
    const agent = getAgent(resume.agentId);
    if (!agent) throw new Error(`Agent not found: ${resume.agentId}`);
    active.abort = new AbortController();
    updateEnrichSession(sessionId, { status: 'running' });
    this.emitIPC('enrich:status', { sessionId, phase: resume.phase, status: 'running' });
    try {
      const metrics = await this.runEnrichExecuteAgent(
        resume.prompt,
        agent,
        active.specPath,
        sessionId,
        resume.phase,
        resume.isFollowUp,
      );
      accumulateEnrichMetrics(sessionId, resume.phase, {
        ...metrics,
        messages: 1,
      });
      this.emitIPC('enrich:metrics', {
        sessionId,
        phase: resume.phase,
        metrics: { ...metrics, messages: 1 },
      });
      delete active.authResume;
      updateEnrichSession(sessionId, { status: 'waiting' });
      this.emitIPC('enrich:status', { sessionId, phase: resume.phase, status: 'waiting' });
    } catch (error) {
      if (isSubscriptionAuthError(error)) {
        this.pauseEnrichForProviderAuth(sessionId, resume, error);
        return;
      }
      updateEnrichSession(sessionId, { status: 'paused' });
      this.emitIPC('enrich:status', { sessionId, phase: resume.phase, status: 'paused' });
      throw error;
    }
  }

  async startEnrichSession(config: CreateEnrichConfig & { sessionId: string }): Promise<void> {
    if (this.activeEnrichSession !== null) {
      throw new Error(
        'Ja existe uma sessao de enrich ativa. Finalize ou aborte a sessao atual antes de iniciar uma nova.',
      );
    }

    logger.info({ sessionId: config.sessionId }, 'Starting enrich session');

    if (!fs.existsSync(config.specPath)) {
      throw new Error(`SPEC file not found: ${config.specPath}`);
    }

    if (config.prdPath && !fs.existsSync(config.prdPath)) {
      throw new Error(`PRD file not found: ${config.prdPath}`);
    }

    const validatorAgent = getAgent(config.validatorAgentId);
    if (!validatorAgent) {
      throw new Error(`Validator agent not found: ${config.validatorAgentId}`);
    }

    const prompt = buildValidatorPrompt(config.specPath, config.projectPath, config.prdPath, config.message);

    const abort = new AbortController();
    this.activeEnrichSession = {
      sessionId: config.sessionId,
      specPath: config.specPath,
      phase: 'validator',
      abort,
    };

    setActiveEnrichSpecPath(config.specPath);

    updateEnrichSession(config.sessionId, { status: 'running', phase: 'validator' });

    this.emitIPC('enrich:status', {
      sessionId: config.sessionId,
      phase: 'validator',
      status: 'running',
    });

    try {
      try {
        persistMessage({ kind: 'enrich', sessionId: config.sessionId, phase: 'validator' }, 'user', prompt);
      } catch (err) {
        logger.error({ err, sessionId: config.sessionId }, 'Failed to persist enrich initial user message');
      }

      const metrics = await this.runEnrichExecuteAgent(
        prompt,
        validatorAgent,
        config.specPath,
        config.sessionId,
        'validator',
      );

      accumulateEnrichMetrics(config.sessionId, 'validator', {
        ...metrics,
        messages: 1,
      });

      this.emitIPC('enrich:metrics', {
        sessionId: config.sessionId,
        phase: 'validator',
        metrics: { ...metrics, messages: 1 },
      });

      updateEnrichSession(config.sessionId, { status: 'waiting' });
      this.emitIPC('enrich:status', {
        sessionId: config.sessionId,
        phase: 'validator',
        status: 'waiting',
      });

      logger.info({ sessionId: config.sessionId }, 'Enrich session started - waiting for user');
    } catch (err) {
      logger.error({ err, sessionId: config.sessionId }, 'Enrich session failed during startup');
      if (isSubscriptionAuthError(err)) {
        this.pauseEnrichForProviderAuth(
          config.sessionId,
          {
            prompt,
            agentId: validatorAgent.id,
            phase: 'validator',
            isFollowUp: false,
          },
          err,
        );
        return;
      }
      updateEnrichSession(config.sessionId, { status: 'idle' });
      setActiveEnrichSpecPath(null);
      this.activeEnrichSession = null;
      this.emitIPC('enrich:status', {
        sessionId: config.sessionId,
        phase: 'validator',
        status: 'idle',
      });
      throw err;
    }
  }

  async sendEnrichMessage(sessionId: string, message: string): Promise<void> {
    if (!this.activeEnrichSession || this.activeEnrichSession.sessionId !== sessionId) {
      throw new Error(`No active enrich session for id: ${sessionId}`);
    }

    const session = getEnrichSession(sessionId);
    if (!session) throw new Error(`Enrich session not found: ${sessionId}`);

    const phase = this.activeEnrichSession.phase;
    const specPath = this.activeEnrichSession.specPath;

    let agentId: string;
    if (phase === 'validator') {
      agentId = session.validatorAgentId;
    } else if (phase === 'enricher') {
      agentId = session.enricherAgentId;
    } else {
      throw new Error(`Enrich session is in terminal phase: ${phase}`);
    }

    const agent = getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    logger.info({ sessionId, phase, agentId, messageLen: message.length }, 'Sending message to enrich agent');

    updateEnrichSession(sessionId, { status: 'running' });
    this.emitIPC('enrich:status', { sessionId, phase, status: 'running' });

    try {
      persistMessage({ kind: 'enrich', sessionId, phase: phase as 'validator' | 'enricher' }, 'user', message);
    } catch (err) {
      logger.error({ err, sessionId, phase }, 'Failed to persist enrich user message');
    }

    const fullPrompt =
      phase === 'validator'
        ? buildValidatorFollowUpPrompt(specPath, message)
        : buildEnricherFollowUpPrompt(specPath, message);

    try {
      const metrics = await this.runEnrichExecuteAgent(
        fullPrompt,
        agent,
        specPath,
        sessionId,
        phase as 'validator' | 'enricher',
        true,
      );

      accumulateEnrichMetrics(sessionId, phase as 'validator' | 'enricher', {
        ...metrics,
        messages: 1,
      });

      this.emitIPC('enrich:metrics', {
        sessionId,
        phase,
        metrics: { ...metrics, messages: 1 },
      });

      updateEnrichSession(sessionId, { status: 'waiting' });
      this.emitIPC('enrich:status', { sessionId, phase, status: 'waiting' });

      logger.info({ sessionId, phase }, 'Enrich message processed - waiting for next input');
    } catch (err) {
      logger.error({ err, sessionId, phase }, 'Enrich message failed');
      if (isSubscriptionAuthError(err)) {
        this.pauseEnrichForProviderAuth(
          sessionId,
          {
            prompt: fullPrompt,
            agentId,
            phase: phase as 'validator' | 'enricher',
            isFollowUp: true,
          },
          err,
        );
        return;
      }
      updateEnrichSession(sessionId, { status: 'waiting' });
      this.emitIPC('enrich:status', { sessionId, phase, status: 'waiting' });
      throw err;
    }
  }

  async approveEnrichPhase(sessionId: string): Promise<void> {
    if (!this.activeEnrichSession || this.activeEnrichSession.sessionId !== sessionId) {
      throw new Error(`No active enrich session for id: ${sessionId}`);
    }

    const session = getEnrichSession(sessionId);
    if (!session) throw new Error(`Enrich session not found: ${sessionId}`);
    if (session.phase !== 'validator') {
      throw new Error(`Cannot approve phase transition from phase: ${session.phase}`);
    }

    logger.info({ sessionId }, 'Approving phase transition: validator -> enricher');

    logger.info({ sessionId }, 'Aborting validator abort controller before enricher transition');
    this.activeEnrichSession.abort.abort();

    const enricherAgent = getAgent(session.enricherAgentId);
    if (!enricherAgent) throw new Error(`Enricher agent not found: ${session.enricherAgentId}`);

    const prompt = buildEnricherPrompt(session.specPath, session.projectPath ?? undefined);

    this.activeEnrichSession.phase = 'enricher';

    this.activeEnrichSession.abort = new AbortController();
    logger.info({ sessionId }, 'New AbortController created for enricher phase');

    updateEnrichSession(sessionId, { phase: 'enricher', status: 'running' });
    this.emitIPC('enrich:status', { sessionId, phase: 'enricher', status: 'running' });

    try {
      try {
        persistMessage({ kind: 'enrich', sessionId, phase: 'enricher' }, 'user', prompt);
      } catch (err) {
        logger.error({ err, sessionId }, 'Failed to persist enrich enricher initial user message');
      }

      const metrics = await this.runEnrichExecuteAgent(prompt, enricherAgent, session.specPath, sessionId, 'enricher');

      accumulateEnrichMetrics(sessionId, 'enricher', {
        ...metrics,
        messages: 1,
      });

      this.emitIPC('enrich:metrics', {
        sessionId,
        phase: 'enricher',
        metrics: { ...metrics, messages: 1 },
      });

      updateEnrichSession(sessionId, { status: 'waiting' });
      this.emitIPC('enrich:status', { sessionId, phase: 'enricher', status: 'waiting' });

      logger.info({ sessionId }, 'Enricher phase started - waiting for user');
    } catch (err) {
      logger.error({ err, sessionId }, 'Enricher phase launch failed');
      if (isSubscriptionAuthError(err)) {
        this.pauseEnrichForProviderAuth(
          sessionId,
          {
            prompt,
            agentId: enricherAgent.id,
            phase: 'enricher',
            isFollowUp: false,
          },
          err,
        );
        return;
      }
      updateEnrichSession(sessionId, { status: 'waiting' });
      this.emitIPC('enrich:status', { sessionId, phase: 'enricher', status: 'waiting' });
      throw err;
    }
  }

  finalizeEnrichSession(sessionId: string): string {
    logger.info({ sessionId }, 'Finalizing enrich session');

    if (!this.activeEnrichSession || this.activeEnrichSession.sessionId !== sessionId) {
      throw new Error(`No active enrich session for id: ${sessionId}`);
    }

    const session = getEnrichSession(sessionId);
    if (!session) {
      throw new Error(`Enrich session not found: ${sessionId}`);
    }

    if (!fs.existsSync(session.specPath)) {
      throw new Error(`SPEC file not found at finalization time: ${session.specPath}`);
    }
    const finalContent = fs.readFileSync(session.specPath, 'utf-8');
    logger.info({ sessionId, specPath: session.specPath, size: finalContent.length }, 'Read final SPEC content');

    const parsed = path.parse(session.specPath);
    let enrichedPath: string;
    if (parsed.name.endsWith('.enriched')) {
      enrichedPath = session.specPath;
      logger.info({ sessionId, enrichedPath }, 'SPEC already has .enriched suffix - using original path');
    } else {
      enrichedPath = path.join(parsed.dir, parsed.name + '.enriched' + parsed.ext);
      logger.info({ sessionId, enrichedPath }, 'Creating enriched copy');
      fs.writeFileSync(enrichedPath, finalContent, 'utf-8');
      logger.info({ sessionId, enrichedPath }, 'Enriched copy written');
    }

    updateEnrichSession(sessionId, {
      phase: 'done',
      status: 'done',
      finalSpecPath: enrichedPath,
    });

    setActiveEnrichSpecPath(null);
    this.activeEnrichSession = null;

    this.emitIPC('enrich:status', {
      sessionId,
      phase: 'done',
      status: 'done',
      finalSpecPath: enrichedPath,
    });

    logger.info({ sessionId, enrichedPath }, 'Enrich session finalized successfully');
    return enrichedPath;
  }

  abortEnrichSession(sessionId: string): void {
    logger.info({ sessionId }, 'Aborting enrich session');

    if (this.activeEnrichSession?.sessionId === sessionId) {
      const phase = this.activeEnrichSession.phase;
      logger.info({ sessionId, phase }, 'Aborting active enrich session abort controller');
      this.activeEnrichSession.abort.abort();
      setActiveEnrichSpecPath(null);
      this.activeEnrichSession = null;
    }

    const session = getEnrichSession(sessionId);
    const currentPhase = session?.phase ?? 'validator';

    updateEnrichSession(sessionId, { status: 'idle' });
    this.emitIPC('enrich:status', { sessionId, phase: currentPhase, status: 'idle' });
    logger.info({ sessionId, phase: currentPhase }, 'Enrich session aborted');
  }
}
