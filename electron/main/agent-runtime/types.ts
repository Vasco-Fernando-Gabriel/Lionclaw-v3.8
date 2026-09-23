import type { CanUseTool, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { OllamaChatMessage, OllamaToolCallRecord } from '../ollama-client';
import type { AgentConfig } from '../../../src/types';
import type { CodexSession } from '../codex-runtime/types';
import type { AgentExecutionError } from './llm-error';
import type { ChatInheritedEffort } from './chat-effort-inheritance';

export type ToolDecision =
  { behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string };

export interface AgentPermissionProfile {
  mode: PermissionMode;
  dangerouslySkipPermissions: boolean;
  canUseTool?: CanUseTool;
}

export interface SubagentDispatchContext {
  ownerKind: 'chat' | 'pipeline' | 'harness' | 'workflow' | 'enrich';
  ownerId: string;
  sessionId?: string;
  lane: 'desktop' | 'telegram' | 'cron' | 'pipeline' | 'workflow';
  surface: string;
  workspace: {
    cwd: string;
    projectId?: string;
    readRoots: string[];
    writeRoots: string[];
  };
  permission: AgentPermissionProfile;
  parentAbortSignal: AbortSignal;
  rootExecutionId: string;
  parentExecutionId: string;
  depth: number;
  remainingBudget: number;
  budgetState: { remaining: number };
  controlState?: {
    providerAuthError?: Error;
  };
  abortOwner?: (reason: Error) => void;
  capabilityCeiling: {
    allowedTools: readonly string[];
    allowedMcpServerIds: readonly string[];
  };
  inheritedEffort?: ChatInheritedEffort;
}

export interface AgentExecutionRequest {
  executionAgent?: AgentConfig;
  swarmFindingsMcpArgs?: string[];
  swarmFindingsMcpEnv?: Record<string, string>;
  swarmOwnerDirectory?: string;
  swarmLifecycle?: {
    idleTimeoutMs: number;
    hardTimeoutMs: number;
    onTimeout: (reason: 'timeout-idle' | 'timeout-hard') => void;
  };
  swarmToolDispatch?: (name: string, input: Record<string, unknown>) => Promise<{ result: string; isError: boolean }>;
  agentId: string;
  prompt: string;
  cwd: string;
  abortController: AbortController;
  permission: AgentPermissionProfile;
  continueSession?: boolean;
  priorMessages?: OllamaChatMessage[];
  systemPromptTransform?: (resolved: string) => string;
  onText?: (chunk: string) => void;
  onThinking?: (chunk: string) => void;
  onToolUse?: (tool: string) => void;
  onToolUseComplete?: (tool: string, input: unknown) => void;
  onActivity?: () => void;
  onStalled?: (info: { lastChunkAt: number; secondsSinceLastChunk: number }) => void;
  codexSession?: CodexSession;
  onCodexSessionCreated?: (session: CodexSession) => void;
  projectId?: string;
  inheritedEffort?: ChatInheritedEffort;
  effortOverride?: AgentQueryConfig['effort'];
  allowedToolsOverride?: readonly string[];
  resolvedConfigOverride?: AgentQueryConfig;
  executionContext?: SubagentDispatchContext;
}

export interface AgentExecutionResult {
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
    costStatusReasons?: readonly string[];
    tokenStatus?: 'reported' | 'not_reported';
    costUnknownReason?: 'unknown-pricing' | 'no-usage-reported';
  };
  model: string;
  runtime: AgentConfig['runtime'];
  provider: string;
  toolCalls?: OllamaToolCallRecord[];
  accumulatedText?: string;
  textBlocks?: string[];
  metadata?: {
    codex?: {
      applyPatchFailures?: number;
      applyPatchFailureSamples?: Array<{ source: string; text: string; ts: number }>;
    };
    costEstimationKind?: 'subscription-equivalent-payg';
    sessionIds?: string[];
    costSource?: 'sdk_total_cost_usd' | 'sdk_model_usage' | 'calculated' | 'provider-reported-equivalent';
    sdkReportedCostUsd?: number;
    costReconciliationRelativeDelta?: number;
    pricingSnapshot?: {
      pricingVersion: string;
      model: string;
      entry: {
        input: number;
        output: number;
        cacheRead: number;
        cacheCreation: number;
        cacheCreationBilling?: 'not-separately-reported';
        longContext?: { thresholdTokens: number; inputMultiplier: number; outputMultiplier: number };
      } | null;
    };
    modelUsage?: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        costUSD: number;
        reasoningTokens?: number;
        modelCalls?: number;
        costUsdTicks?: number;
      }
    >;
    grok?: {
      reasoningTokens?: number;
      modelCalls?: number;
      apiDurationMs?: number;
      numTurns?: number;
      costUsdTicks?: number;
      requestId?: string;
      rawUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        providerInputTokens?: number;
        reasoningTokens?: number;
        modelCalls?: number;
        apiDurationMs?: number;
        costUsdTicks?: number;
        numTurns?: number;
      };
    };
  };
  error?: AgentExecutionError;
}

export interface RuntimeExecutor {
  run(req: AgentExecutionRequest, config: AgentQueryConfig): Promise<AgentExecutionResult>;
}

export class PipelinePausedError extends Error {
  constructor(
    message: string,
    public readonly reason: 'codex-auth' | 'grok-auth' | 'kimi-auth' | 'user-abort' | 'other',
  ) {
    super(message);
    this.name = 'PipelinePausedError';
  }
}
