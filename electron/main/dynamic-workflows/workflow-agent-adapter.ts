
import { createLogger } from '../logger';
import { resolveAgentQueryConfig } from '../agent-config-resolver';
import { resolveCodexSessionForRun } from '../agent-runtime/codex-session-factory';
import {
  codexEffortToClaude,
} from '../agent-runtime/chat-effort-inheritance';
import { getAgent } from '../db';
import { hasKnownPricing, MODEL_PRICING } from '../pricing';
import {
  clampGrokEffortForModel,
  type GrokReasoningEffort,
} from '../../../src/constants/grok-models';
import {
  clampCursorEffortForModel,
  getCursorModel,
} from '../../../src/constants/cursor-models';
import { isCursorCatalogModel } from '../agent-runtime/cursor-sidecar/model-catalog';
import type { AgentConfig, CodexChatReasoningEffort } from '../../../src/types';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { CodexSessionOptions, CodexSession } from '../codex-runtime/types';
import {
  deriveNodeExecutionPolicy,
  GUARD_GATED_TOOL_NAMES,
  isSideRouteTool,
  type NodePolicyGrants,
  type PolicyWorkspace,
} from './workflow-policy';
import { preflightNode, type PreflightResult } from './workflow-preflight';
import { WorkflowPathGuard } from './workflow-path-guard';
import { normalizeCost, type NormalizedCost, mergeCostStatusReasons } from './workflow-cost';
import {
  classifyFailure,
  type WorkflowFailureRuntime,
} from './workflow-failure';
import {
  runLocalDispatcher,
  type LocalModelRound,
  type LocalToolExecutor,
} from './workflow-local-dispatcher';
import {
  resolveStructuredOutput,
  type SchemaAttemptFn,
  type SchemaValidator,
  type WorkflowOutputSchema,
} from './workflow-schema';
import type {
  DynamicWorkflowFailureClass,
  WorkflowNodeExecutionPolicy,
} from '../../../src/types/dynamic-workflow';

export type AdapterRuntime =
  | 'cloud'
  | 'local'
  | 'external'
  | 'codex'
  | 'kimi'
  | 'grok'
  | 'zai'
  | 'minimax-tp'
  | 'cursor';

const logger = createLogger('dynamic-workflow-agent-adapter');

export type AdapterDispatchFamily =
  | 'claude-compatible'
  | 'codex'
  | 'grok'
  | 'cursor'
  | 'local-family';

export const ADAPTER_RUNTIME_CASES: Record<AdapterRuntime, AdapterDispatchFamily> =
  {
    cloud: 'claude-compatible',
    zai: 'claude-compatible',
    'minimax-tp': 'claude-compatible',
    codex: 'codex',
    kimi: 'codex',
    grok: 'grok',
    cursor: 'cursor',
    local: 'local-family',
    external: 'local-family',
  };

export function dispatchFamilyOf(
  runtime: string,
): AdapterDispatchFamily | null {
  return runtime in ADAPTER_RUNTIME_CASES
    ? ADAPTER_RUNTIME_CASES[runtime as AdapterRuntime]
    : null;
}

export function runtimeSupportsModelOverride(runtime: AdapterRuntime): boolean {
  return (
    runtime === 'cloud' ||
    runtime === 'zai' ||
    runtime === 'minimax-tp' ||
    runtime === 'codex' ||
    runtime === 'grok' ||
    runtime === 'cursor'
  );
}

export function runtimeSupportsEffortOverride(runtime: AdapterRuntime): boolean {
  return runtimeSupportsModelOverride(runtime) || runtime === 'kimi';
}

export type ModelOverrideRuntime = Extract<
  AdapterRuntime,
  'cloud' | 'zai' | 'minimax-tp' | 'codex' | 'grok' | 'cursor'
>;

export function modelOverrideRuntimeFamily(model: string): ModelOverrideRuntime | null {
  const slug = model.trim().toLowerCase();
  if (slug.startsWith('claude-')) return 'cloud';
  if (slug.startsWith('glm-')) return 'zai';
  if (slug.startsWith('minimax-')) return 'minimax-tp';
  if (slug.startsWith('gpt-') || slug.startsWith('codex-')) return 'codex';
  if (slug.startsWith('grok-')) return 'grok';
  return null;
}

export function defaultCursorCatalogHasModel(model: string): boolean {
  return getCursorModel(model) !== undefined || isCursorCatalogModel(model);
}


export interface ComposedToolInput {
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolDecisionAllow {
  behavior: 'allow';
}
export interface ToolDecisionDeny {
  behavior: 'deny';
  message: string;
}
export type ToolDecision = ToolDecisionAllow | ToolDecisionDeny;

export function createComposedCanUseTool(
  policy: WorkflowNodeExecutionPolicy,
  pathGuard: WorkflowPathGuard,
): (input: ComposedToolInput) => ToolDecision {
  const isReadOnly = policy.access === 'read-only';
  const allowedCommands = policy.allowedCommands;
  const guardGated = new Set<string>(GUARD_GATED_TOOL_NAMES);
  const mcpToolSubset =
    policy.allowedMcpTools.length > 0
      ? new Set<string>(policy.allowedMcpTools)
      : null;

  return ({ toolName, input }): ToolDecision => {
    if (isSideRouteTool(toolName)) {
      return {
        behavior: 'deny',
        message: `tool ${toolName} e rota lateral de spawn e nunca e permitida em node de workflow`,
      };
    }

    if (mcpToolSubset && isMcpToolName(toolName) && !mcpToolSubset.has(toolName)) {
      return {
        behavior: 'deny',
        message: `tool MCP ${toolName} fora do allowedMcpTools do node (subset explicito; servidor concedido, tool nao)`,
      };
    }

    if (!guardGated.has(toolName)) {
      return { behavior: 'allow' };
    }

    if (isReadOnly) {
      return {
        behavior: 'deny',
        message: `node read-only: ${toolName} negada incondicionalmente (a policy limita tools antes da execucao, nao o prompt)`,
      };
    }

    if (toolName === 'Write' || toolName === 'Edit') {
      const fp = typeof input.file_path === 'string' ? input.file_path : null;
      if (fp === null) {
        return {
          behavior: 'deny',
          message: `${toolName}: file_path ausente ou invalido`,
        };
      }
      const verdict = pathGuard.checkWrite(fp);
      return verdict.ok
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: verdict.message };
    }

    if (toolName === 'Bash') {
      if (!policy.allowBash) {
        return {
          behavior: 'deny',
          message: 'Bash negado: o node nao concede allowBash',
        };
      }
      const command = typeof input.command === 'string' ? input.command : '';
      if (!isCommandAllowed(command, allowedCommands)) {
        return {
          behavior: 'deny',
          message: `Bash negado: comando fora do allowedCommands do node (${command})`,
        };
      }
      return { behavior: 'allow' };
    }

    return {
      behavior: 'deny',
      message: `tool ${toolName} guard-gated sem regra de liberacao no node`,
    };
  };
}

export function isMcpToolName(toolName: string): boolean {
  return /^mcp__[^_]+(?:_[^_]+)*__.+/.test(toolName);
}

export function isCommandAllowed(
  command: string,
  allowedCommands: string[],
): boolean {
  if (allowedCommands.length === 0) return false;
  const normalized = command.trim();
  if (!normalized) return false;
  return allowedCommands.some((allowed) => {
    const a = allowed.trim();
    if (!a) return false;
    if (normalized === a) return true;
    if (normalized.startsWith(a + ' ')) return true;
    return false;
  });
}


export function partitionSdkTools(policy: WorkflowNodeExecutionPolicy): {
  autoApproved: string[];
  guardRouted: string[];
} {
  const guardGated = new Set<string>(GUARD_GATED_TOOL_NAMES);
  const autoApproved: string[] = [];
  const guardRouted: string[] = [];
  for (const tool of policy.effectiveTools) {
    if (isSideRouteTool(tool)) continue; // nunca (defensivo).
    if (guardGated.has(tool)) {
      guardRouted.push(tool);
    } else {
      autoApproved.push(tool);
    }
  }
  return { autoApproved, guardRouted };
}


export interface NodeRunResult {
  ok: boolean;
  output: string;
  structuredOutput?: unknown;
  runtime: AdapterRuntime;
  family: AdapterDispatchFamily;
  cost?: NormalizedCost;
  failureClass?: DynamicWorkflowFailureClass;
  errorMessage?: string;
  policy: WorkflowNodeExecutionPolicy;
  mechanism: string;
  durationMs: number;
  aborted?: boolean;
}

export interface SdkPartialUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd?: number;
  apiRequests?: number;
  toolUses?: number;
}

export function readPartialUsageFromError(error: unknown): SdkPartialUsage | null {
  if (!error || typeof error !== 'object') return null;
  const raw = (error as { partialUsage?: unknown }).partialUsage;
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const n = (k: string): number | undefined =>
    typeof u[k] === 'number' && Number.isFinite(u[k] as number) ? (u[k] as number) : undefined;
  const inputTokens = n('inputTokens');
  const outputTokens = n('outputTokens');
  if (inputTokens === undefined && outputTokens === undefined) return null;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: n('cacheReadTokens') ?? 0,
    cacheCreationTokens: n('cacheCreationTokens') ?? 0,
    ...(n('costUsd') !== undefined ? { costUsd: n('costUsd') } : {}),
    ...(n('apiRequests') !== undefined ? { apiRequests: n('apiRequests') } : {}),
    ...(n('toolUses') !== undefined ? { toolUses: n('toolUses') } : {}),
  };
}

export type NodeRunResultSink = (result: NodeRunResult) => void;


export interface ClaudeCompatRunInput {
  agentId: string;
  runtime: AdapterRuntime;
  model: string;
  effort?: AgentQueryConfig['effort'];
  maxTurns?: number;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  allowedTools: string[];
  mcpServers: AgentQueryConfig['mcpServers'];
  canUseTool: (input: ComposedToolInput) => ToolDecision;
  abortSignal: AbortSignal;
  timeoutMs: number;
  onStreamChunk?: (partial: {
    type: 'text' | 'tool_call' | 'tool_call_start';
    content?: string;
    toolName?: string;
  }) => void;
}

export interface BackendRawResult {
  output: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  costStatus?: string;
  tokenStatus?: string;
  costUnknownReason?: string;
  costStatusReasons?: readonly string[];
  apiRequests?: number;
  toolUses?: number;
  structured?: unknown;
}

export type ClaudeCompatBackend = (
  input: ClaudeCompatRunInput,
) => Promise<BackendRawResult>;

export type CreateCodexSessionFn = (
  opts: CodexSessionOptions,
) => Promise<CodexSession>;

export type KimiBackend = (
  input: ClaudeCompatRunInput,
) => Promise<BackendRawResult>;

export type GrokBackend = (
  input: ClaudeCompatRunInput,
) => Promise<BackendRawResult>;

export type CursorBackend = (
  input: ClaudeCompatRunInput,
) => Promise<BackendRawResult>;

export type ResolveConfigFn = (agentId: string) => Promise<AgentQueryConfig>;

export interface WorkflowAdapterDeps {
  resolveConfig?: ResolveConfigFn;
  claudeCompat?: ClaudeCompatBackend;
  createCodexSession?: CreateCodexSessionFn;
  getAgentConfig?: (agentId: string) => AgentConfig | undefined;
  hasKnownPricing?: (model: string) => boolean;
  kimiBackend?: KimiBackend;
  grokBackend?: GrokBackend;
  cursorBackend?: CursorBackend;
  cursorCatalogHasModel?: (model: string) => boolean;
  localModelRound?: LocalModelRound;
  localToolExecutor?: LocalToolExecutor;
  onNodeRunResult?: NodeRunResultSink;
}


export interface RunNodeAgentInput {
  runId: string;
  agentId: string;
  grants: NodePolicyGrants;
  workspace: PolicyWorkspace;
  prompt: string;
  writeSet?: string[];
  protectedPaths?: string[];
  abortSignal?: AbortSignal;
  grantsUserQuestion?: boolean;
  role?: 'node' | 'closer';
  effectiveModel?: string;
  effectiveEffort?: CodexChatReasoningEffort;
  effectiveMaxTurns?: number;
  outputSchema?: WorkflowOutputSchema;
  schemaValidator?: SchemaValidator;
  maxSchemaAttempts?: number;
  onStreamChunk?: (partial: {
    type: 'text' | 'tool_call' | 'tool_call_start';
    content?: string;
    toolName?: string;
  }) => void;
}

function asAdapterRuntime(runtime: string): AdapterRuntime | null {
  return runtime in ADAPTER_RUNTIME_CASES ? (runtime as AdapterRuntime) : null;
}

function toPolicyConfig(resolved: AgentQueryConfig): {
  allowedTools: string[];
  mcpServers: Array<Record<string, unknown>>;
  runtime: string;
} {
  return {
    allowedTools: resolved.allowedTools,
    mcpServers: resolved.mcpServers as Array<Record<string, unknown>>,
    runtime: resolved.runtime,
  };
}

function preflightBlockToResult(
  block: Extract<PreflightResult, { ok: false }>,
  runtime: AdapterRuntime,
  family: AdapterDispatchFamily,
  policy: WorkflowNodeExecutionPolicy,
  startedAt: number,
): NodeRunResult {
  return {
    ok: false,
    output: '',
    runtime,
    family,
    failureClass: 'logic',
    errorMessage: `${block.message}. Sugestao: ${block.suggestion}`,
    policy,
    mechanism: 'preflight-block',
    durationMs: Date.now() - startedAt,
  };
}

export async function runNodeAgent(
  input: RunNodeAgentInput,
  deps: WorkflowAdapterDeps = {},
): Promise<NodeRunResult> {
  const startedAt = Date.now();
  const resolveConfig = deps.resolveConfig ?? resolveAgentQueryConfig;

  if (!input.agentId || input.agentId.trim().length === 0) {
    const result: NodeRunResult = {
      ok: false,
      output: '',
      runtime: 'cloud',
      family: 'claude-compatible',
      failureClass: 'logic',
      errorMessage: 'node agent: agentId obrigatorio (label nunca resolve agente real)',
      policy: emptyPolicy(input),
      mechanism: 'none',
      durationMs: Date.now() - startedAt,
    };
    deps.onNodeRunResult?.(result);
    return result;
  }

  const resolved = await resolveConfig(input.agentId);
  const runtime = asAdapterRuntime(resolved.runtime);
  if (!runtime) {
    const result: NodeRunResult = {
      ok: false,
      output: '',
      runtime: 'cloud',
      family: 'claude-compatible',
      failureClass: 'logic',
      errorMessage: `runtime ${resolved.runtime} nao e um runtime de node valido`,
      policy: emptyPolicy(input),
      mechanism: 'none',
      durationMs: Date.now() - startedAt,
    };
    deps.onNodeRunResult?.(result);
    return result;
  }
  const family = ADAPTER_RUNTIME_CASES[runtime];

  if (input.effectiveModel && !runtimeSupportsModelOverride(runtime)) {
    const result: NodeRunResult = {
      ok: false,
      output: '',
      runtime,
      family,
      failureClass: 'logic',
      errorMessage: `model-unsupported-runtime: override de modelo '${input.effectiveModel}' nao e suportado no runtime '${runtime}' (cloud/zai/minimax-tp/codex/grok aceitam override por chamada)`,
      policy: emptyPolicy(input),
      mechanism: 'none',
      durationMs: Date.now() - startedAt,
    };
    deps.onNodeRunResult?.(result);
    return result;
  }

  if (input.effectiveEffort && !runtimeSupportsEffortOverride(runtime)) {
    const result: NodeRunResult = {
      ok: false,
      output: '',
      runtime,
      family,
      failureClass: 'logic',
      errorMessage: `effort-unsupported-runtime: override de effort '${input.effectiveEffort}' nao e suportado no runtime '${runtime}' (cloud/zai/minimax-tp/codex/grok aceitam; Kimi aceita apenas tiers anunciados pelo modelo)`,
      policy: emptyPolicy(input),
      mechanism: 'none',
      durationMs: Date.now() - startedAt,
    };
    deps.onNodeRunResult?.(result);
    return result;
  }

  if (input.effectiveModel && runtime === 'cursor') {
    const hasModel = deps.cursorCatalogHasModel ?? defaultCursorCatalogHasModel;
    if (!hasModel(input.effectiveModel)) {
      const result: NodeRunResult = {
        ok: false,
        output: '',
        runtime,
        family,
        failureClass: 'logic',
        errorMessage: `model-cross-family: modelo '${input.effectiveModel}' nao pertence ao catalogo do runtime cursor (validacao por PERTENCIMENTO ao catalogo — estatico G6 + Cursor.models.list cacheado — nunca por prefixo de familia). O provider vem do agentType; escolha um model do catalogo Cursor.`,
        policy: emptyPolicy(input),
        mechanism: 'none',
        durationMs: Date.now() - startedAt,
      };
      deps.onNodeRunResult?.(result);
      return result;
    }
  }
  if (input.effectiveModel && runtime !== 'cursor') {
    const modelFamily = modelOverrideRuntimeFamily(input.effectiveModel);
    if (modelFamily !== runtime) {
      const reason =
        modelFamily === null
          ? 'nao casa com nenhuma familia conhecida (claude-*/glm-*/minimax-*/gpt-*|codex-*); fail-closed'
          : `pertence a familia '${modelFamily}'`;
      const result: NodeRunResult = {
        ok: false,
        output: '',
        runtime,
        family,
        failureClass: 'logic',
        errorMessage: `model-cross-family: modelo '${input.effectiveModel}' nao pertence a familia do runtime '${runtime}' do node (${reason}). O provider vem do agentType; escolha um model da mesma familia.`,
        policy: emptyPolicy(input),
        mechanism: 'none',
        durationMs: Date.now() - startedAt,
      };
      deps.onNodeRunResult?.(result);
      return result;
    }
  }

  if (input.effectiveEffort && runtime === 'cursor') {
    const clamped = clampCursorEffortForModel(
      input.effectiveEffort,
      input.effectiveModel ?? resolved.model,
    );
    if (clamped === null) {
      const result: NodeRunResult = {
        ok: false,
        output: '',
        runtime,
        family,
        failureClass: 'logic',
        errorMessage: `effort-unsupported-model: o modelo '${input.effectiveModel ?? resolved.model}' do catalogo Cursor nao anuncia tiers de reasoning/effort enderecaveis pelo @cursor/sdk (mapa por modelo do catalogo; nenhum modelo do 1.0.30 aceita). Remova o effort do node ou use um runtime que o aplique (cloud/zai/minimax-tp/codex/grok).`,
        policy: emptyPolicy(input),
        mechanism: 'none',
        durationMs: Date.now() - startedAt,
      };
      deps.onNodeRunResult?.(result);
      return result;
    }
  }

  const preflight = preflightNode({
    grants: input.grants,
    runtime: resolved.runtime,
    grantsUserQuestion: input.grantsUserQuestion,
    role: input.role ?? 'node',
  });
  if (!preflight.ok) {
    const policy = emptyPolicy(input);
    const result = preflightBlockToResult(preflight, runtime, family, policy, startedAt);
    deps.onNodeRunResult?.(result);
    return result;
  }

  const policy = deriveNodeExecutionPolicy(
    toPolicyConfig(resolved),
    input.grants,
    input.workspace,
    preflight.mechanism,
  );

  const abortSignal = input.abortSignal ?? new AbortController().signal;

  const sdkPartition = partitionSdkTools(policy);
  logger.info(
    {
      phase: 'node-start',
      runId: input.runId,
      nodeId: input.grants.nodeId,
      agentId: input.agentId,
      runtime,
      family,
      model: resolved.model,
      cwd: policy.cwd,
      workspaceRoot: policy.workspaceRoot,
      access: policy.access,
      permissionMechanism: preflight.mechanism,
      allowedToolsAutoApproved: sdkPartition.autoApproved,
      guardRoutedTools: sdkPartition.guardRouted,
      disallowedTools: policy.deniedTools,
      effectiveMcpServers: policy.effectiveMcpServers,
      allowBash: policy.allowBash,
      allowNetwork: policy.allowNetwork,
      timeoutMs: policy.timeoutMs,
      idleTimeoutMs: policy.idleTimeoutMs,
      hasSchema: input.outputSchema !== undefined,
      role: input.role ?? 'node',
      policyHash: policy.policyHash,
    },
    'node iniciando (policy efetiva + options do executor)',
  );

  if (input.effectiveMaxTurns !== undefined && family !== 'claude-compatible') {
    logger.warn(
      { runId: input.runId, nodeId: input.grants.nodeId, runtime, effectiveMaxTurns: input.effectiveMaxTurns },
      'agent({ maxTurns }) ignorado: o runtime do node nao expoe teto de turnos (so cloud/zai/minimax-tp aplicam)',
    );
  }

  const dispatchOnce = (extraPrompt: string): Promise<BackendRawResult> => {
    const attemptInput =
      extraPrompt.length > 0
        ? { ...input, prompt: `${input.prompt}\n\n${extraPrompt}` }
        : input;
    if (family === 'claude-compatible') {
      return dispatchClaudeCompat(attemptInput, resolved, policy, runtime, abortSignal, deps);
    }
    if (family === 'codex') {
      if (runtime === 'kimi') {
        return dispatchKimi(attemptInput, resolved, policy, abortSignal, deps);
      }
      return dispatchCodex(attemptInput, resolved, policy, abortSignal, deps);
    }
    if (family === 'grok') {
      return dispatchGrok(attemptInput, resolved, policy, abortSignal, deps);
    }
    if (family === 'cursor') {
      return dispatchCursor(attemptInput, resolved, policy, abortSignal, deps);
    }
    return dispatchLocalFamily(attemptInput, resolved, policy, abortSignal, deps);
  };

  let raw: BackendRawResult;
  let failure: { failureClass: DynamicWorkflowFailureClass; message: string } | null =
    null;
  let structuredOutput: unknown = undefined;

  try {
    if (input.outputSchema) {
      const accumulated = createCostAccumulator(input.effectiveModel ?? resolved.model);
      const schemaAttempt: SchemaAttemptFn = async ({ feedback }) => {
        const out = await dispatchOnce(buildSchemaFeedbackPrompt(input.outputSchema, feedback));
        accumulated.add(out);
        return { text: out.output, structured: out.structured };
      };
      const resolution = await resolveStructuredOutput({
        runtime,
        schema: input.outputSchema,
        attempt: schemaAttempt,
        validator: input.schemaValidator,
        maxAttempts: input.maxSchemaAttempts,
      });
      raw = accumulated.toRaw();
      if (resolution.ok) {
        structuredOutput = resolution.value;
      } else {
        failure = {
          failureClass: resolution.failureClass,
          message: `${resolution.message}: ${resolution.errors.join('; ')}`,
        };
      }
    } else {
      raw = await dispatchOnce('');
    }
  } catch (error) {
    const failureClass = classifyFailure({
      runtime: runtime as WorkflowFailureRuntime,
      error,
      aborted: abortSignal.aborted,
    });
    failure = {
      failureClass,
      message: error instanceof Error ? error.message : String(error),
    };
    const partial = readPartialUsageFromError(error);
    raw = partial
      ? {
          output: '',
          model: input.effectiveModel ?? resolved.model,
          inputTokens: partial.inputTokens,
          outputTokens: partial.outputTokens,
          cacheReadTokens: partial.cacheReadTokens,
          cacheCreationTokens: partial.cacheCreationTokens,
          ...(partial.costUsd !== undefined ? { costUsd: partial.costUsd } : {}),
          ...(partial.apiRequests !== undefined ? { apiRequests: partial.apiRequests } : {}),
          ...(partial.toolUses !== undefined ? { toolUses: partial.toolUses } : {}),
        }
      : {
          output: '',
          model: resolved.model,
          costStatus: 'unknown',
          costUnknownReason: 'error-without-usage',
        };
  }

  const cost = normalizeCost({
    runtime,
    model: raw.model,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    cacheReadTokens: raw.cacheReadTokens,
    cacheCreationTokens: raw.cacheCreationTokens,
    costUsd: raw.costUsd,
    costStatus: raw.costStatus,
    tokenStatus: raw.tokenStatus,
    costUnknownReason: raw.costUnknownReason,
    costStatusReasons: raw.costStatusReasons,
    apiRequests: raw.apiRequests,
    toolUses: raw.toolUses,
  });

  const result: NodeRunResult = failure
    ? {
        ok: false,
        output: raw.output,
        runtime,
        family,
        cost,
        failureClass: failure.failureClass,
        errorMessage: failure.message,
        policy,
        mechanism: preflight.mechanism,
        durationMs: Date.now() - startedAt,
        aborted: abortSignal.aborted,
      }
    : {
        ok: true,
        output: raw.output,
        ...(structuredOutput !== undefined ? { structuredOutput } : {}),
        runtime,
        family,
        cost,
        policy,
        mechanism: preflight.mechanism,
        durationMs: Date.now() - startedAt,
        aborted: abortSignal.aborted,
      };

  const endFields = {
    phase: 'node-end',
    runId: input.runId,
    nodeId: input.grants.nodeId,
    agentId: input.agentId,
    runtime,
    family,
    status: result.ok ? 'ok' : 'failed',
    failureClass: result.failureClass,
    error: result.errorMessage,
    costUsd: result.cost?.costUsd,
    costStatus: result.cost?.costStatus,
    inputTokens: result.cost?.inputTokens,
    outputTokens: result.cost?.outputTokens,
    cacheReadTokens: result.cost?.cacheReadTokens,
    cacheCreationTokens: result.cost?.cacheCreationTokens,
    durationMs: result.durationMs,
    abortedSignal: abortSignal.aborted,
  };
  if (result.ok) {
    logger.info(endFields, 'node concluido');
  } else {
    logger.warn(endFields, 'node falhou');
  }

  deps.onNodeRunResult?.(result);
  return result;
}


function buildSchemaFeedbackPrompt(
  schema: WorkflowOutputSchema | undefined,
  feedback: string[],
): string {
  const name = schema?.name ? ` "${schema.name}"` : '';
  if (feedback.length === 0) {
    return `Retorne SOMENTE o objeto JSON que satisfaz o schema${name}. Nada de prosa ou markdown fora do JSON.`;
  }
  const lines = feedback.map((f) => `- ${f}`).join('\n');
  return [
    `A saida anterior NAO bateu o schema${name}. Corrija e retorne SOMENTE o objeto JSON valido:`,
    lines,
  ].join('\n');
}

export function createCostAccumulator(fallbackModel: string): {
  add: (r: BackendRawResult) => void;
  toRaw: () => BackendRawResult;
} {
  let lastOutput = '';
  let lastStructured: unknown = undefined;
  let model = fallbackModel;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let costUsd = 0;
  let anyCost = false;
  let costStatus: string | undefined;
  let tokenStatus: string | undefined;
  let costUnknownReason: string | undefined;
  const costStatusReasons: string[] = [];
  let apiRequests = 0;
  let toolUses = 0;

  return {
    add(r: BackendRawResult): void {
      lastOutput = r.output;
      lastStructured = r.structured;
      model = r.model || model;
      inputTokens += r.inputTokens ?? 0;
      outputTokens += r.outputTokens ?? 0;
      cacheReadTokens += r.cacheReadTokens ?? 0;
      cacheCreationTokens += r.cacheCreationTokens ?? 0;
      apiRequests += r.apiRequests ?? 0;
      toolUses += r.toolUses ?? 0;
      if (r.costUsd !== undefined) {
        costUsd += r.costUsd;
        anyCost = true;
      }
      if (r.costStatus === 'unknown') costStatus = 'unknown';
      else if (r.costStatus === 'estimated-partial' && costStatus !== 'unknown') {
        costStatus = 'estimated-partial';
      } else if (costStatus === undefined) costStatus = r.costStatus;
      if (r.costStatusReasons) costStatusReasons.push(...r.costStatusReasons);
      if (r.tokenStatus !== undefined) tokenStatus = r.tokenStatus;
      if (r.costUnknownReason !== undefined) costUnknownReason = r.costUnknownReason;
    },
    toRaw(): BackendRawResult {
      return {
        output: lastOutput,
        structured: lastStructured,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        apiRequests,
        toolUses,
        ...(anyCost ? { costUsd } : {}),
        ...(costStatus !== undefined ? { costStatus } : {}),
        ...(costStatusReasons.length > 0
          ? { costStatusReasons: mergeCostStatusReasons(costStatusReasons) }
          : {}),
        ...(tokenStatus !== undefined ? { tokenStatus } : {}),
        ...(costUnknownReason !== undefined ? { costUnknownReason } : {}),
      };
    },
  };
}


async function dispatchClaudeCompat(
  input: RunNodeAgentInput,
  resolved: AgentQueryConfig,
  policy: WorkflowNodeExecutionPolicy,
  runtime: AdapterRuntime,
  abortSignal: AbortSignal,
  deps: WorkflowAdapterDeps,
): Promise<BackendRawResult> {
  const backend = deps.claudeCompat ?? defaultClaudeCompatBackend;
  const effectiveModel = input.effectiveModel ?? resolved.model;
  const effectiveEffort =
    input.effectiveEffort !== undefined
      ? codexEffortToClaude(input.effectiveEffort)
      : undefined;
  const pathGuard = new WorkflowPathGuard({
    workspaceRoot: policy.workspaceRoot,
    writeSet: input.writeSet,
    protectedPaths: input.protectedPaths,
  });
  const { autoApproved } = partitionSdkTools(policy);
  const canUseTool = createComposedCanUseTool(policy, pathGuard);
  const allowedMcp = filterMcpServersByPolicy(resolved.mcpServers, policy);

  const dispatchStartedAt = Date.now();
  logger.info(
    {
      phase: 'executor-dispatch',
      runId: input.runId,
      nodeId: input.grants.nodeId,
      agentId: input.agentId,
      runtime,
      model: effectiveModel,
      ...(effectiveEffort !== undefined ? { effortOverride: effectiveEffort } : {}),
      cwd: policy.cwd,
      access: policy.access,
      permissionMode: 'default',
      dangerouslySkipPermissions: false,
      allowedTools: autoApproved,
      guardRoutedTools: partitionSdkTools(policy).guardRouted,
      mcpServerCount: allowedMcp.length,
      timeoutMs: policy.timeoutMs,
      promptChars: input.prompt.length,
      abortedBeforeDispatch: abortSignal.aborted,
    },
    'despacho ao executor claude-compat (antes da 1a request da API)',
  );
  try {
    const out = await backend({
      agentId: input.agentId,
      runtime,
      model: effectiveModel,
      ...(effectiveEffort !== undefined ? { effort: effectiveEffort } : {}),
      ...(input.effectiveMaxTurns !== undefined ? { maxTurns: input.effectiveMaxTurns } : {}),
      systemPrompt: resolved.systemPrompt,
      prompt: input.prompt,
      cwd: policy.cwd,
      allowedTools: autoApproved,
      mcpServers: allowedMcp,
      canUseTool,
      abortSignal,
      timeoutMs: policy.timeoutMs,
      onStreamChunk: input.onStreamChunk,
    });
    logger.info(
      {
        phase: 'executor-returned',
        runId: input.runId,
        nodeId: input.grants.nodeId,
        agentId: input.agentId,
        runtime,
        outputChars: out.output.length,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        durationMs: Date.now() - dispatchStartedAt,
        abortedAfterDispatch: abortSignal.aborted,
      },
      'executor claude-compat retornou',
    );
    return out;
  } catch (err) {
    logger.warn(
      {
        phase: 'executor-threw',
        runId: input.runId,
        nodeId: input.grants.nodeId,
        agentId: input.agentId,
        runtime,
        durationMs: Date.now() - dispatchStartedAt,
        abortedAfterDispatch: abortSignal.aborted,
        error: err instanceof Error ? err.message : String(err),
      },
      'executor claude-compat lancou (sera classificado pelo runNodeAgent)',
    );
    throw err;
  }
}

async function dispatchCodex(
  input: RunNodeAgentInput,
  resolved: AgentQueryConfig,
  policy: WorkflowNodeExecutionPolicy,
  abortSignal: AbortSignal,
  deps: WorkflowAdapterDeps,
): Promise<BackendRawResult> {
  let agentEffort: CodexChatReasoningEffort | undefined;
  try {
    agentEffort = (deps.getAgentConfig ?? getAgent)(input.agentId)?.codexConfig?.reasoningEffort;
  } catch {
    agentEffort = undefined;
  }

  const effectiveModel = input.effectiveModel ?? resolved.model;

  const nodeEffort: CodexChatReasoningEffort | undefined =
    input.effectiveEffort ?? agentEffort;

  const create =
    deps.createCodexSession ??
    ((opts: CodexSessionOptions) =>
      resolveCodexSessionForRun({
        surface: 'agent-scoped',
        mcpProfile: 'agent-scoped',
        sessionOptions: opts,
        disableGlobalMcp: true, // A2b
        reasoningEffortOverride: nodeEffort,
      }));
  const sandbox: CodexSessionOptions['sandbox'] =
    policy.access === 'workspace-write' ? 'workspace-write' : 'read-only';

  const reasoningEffort: CodexSessionOptions['reasoningEffort'] = nodeEffort;

  const session = await create({
    model: effectiveModel,
    cwd: policy.cwd,
    systemPrompt: resolved.systemPrompt,
    approvalPolicy: 'never',
    sandbox,
    timeoutMs: policy.timeoutMs,
    idleTimeoutMs: policy.idleTimeoutMs,
    reasoningEffort,
    ownerKind: 'pipeline',
    projectId: input.runId,
    ownerId: `dynamic-workflow:${input.runId}:${input.grants.nodeId}`,
  });

  try {
    const response = await session.send(input.prompt, undefined, abortSignal);
    if (response.status === 'auth_required') {
      const err = new Error('codex auth required') as Error & { name: string };
      err.name = 'CodexAuthError';
      throw err;
    }
    const pricingKnown = (deps.hasKnownPricing ?? hasKnownPricing)(effectiveModel);
    const pricingEntry = MODEL_PRICING[effectiveModel.trim().toLowerCase()];
    const partialReasons: string[] = [];
    if (pricingKnown && pricingEntry) {
      if (pricingEntry.cacheCreation > 0) partialReasons.push('cache-write-not-reported');
      if (
        pricingEntry.longContext &&
        response.usage.inputTokens > pricingEntry.longContext.thresholdTokens
      ) {
        partialReasons.push('long-context-unpriced');
      }
    }
    return {
      output: response.content,
      model: effectiveModel,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cacheReadTokens: response.usage.cachedInputTokens,
      cacheCreationTokens: 0,
      costStatus: pricingKnown
        ? partialReasons.length > 0
          ? 'estimated-partial'
          : 'known'
        : 'unknown',
      ...(pricingKnown ? {} : { costUnknownReason: 'unknown-pricing' }),
      ...(partialReasons.length > 0 ? { costStatusReasons: partialReasons } : {}),
      apiRequests: 1,
    };
  } finally {
    session.close();
  }
}

async function dispatchKimi(
  input: RunNodeAgentInput,
  resolved: AgentQueryConfig,
  policy: WorkflowNodeExecutionPolicy,
  abortSignal: AbortSignal,
  deps: WorkflowAdapterDeps,
): Promise<BackendRawResult> {
  const backend = deps.kimiBackend ?? defaultKimiBackend;
  const { autoApproved } = partitionSdkTools(policy);
  const allowedMcp = filterMcpServersByPolicy(resolved.mcpServers, policy);
  return backend({
    agentId: input.agentId,
    runtime: 'kimi',
    model: resolved.model,
    ...(input.effectiveEffort
      ? { effort: input.effectiveEffort === 'xhigh' || input.effectiveEffort === 'ultra'
          ? 'max'
          : input.effectiveEffort as AgentQueryConfig['effort'] }
      : {}),
    systemPrompt: resolved.systemPrompt,
    prompt: input.prompt,
    cwd: policy.cwd,
    allowedTools: autoApproved,
    mcpServers: allowedMcp,
    canUseTool: createComposedCanUseTool(
      policy,
      new WorkflowPathGuard({
        workspaceRoot: policy.workspaceRoot,
        writeSet: input.writeSet,
        protectedPaths: input.protectedPaths,
      }),
    ),
    abortSignal,
    timeoutMs: policy.timeoutMs,
    onStreamChunk: input.onStreamChunk,
  });
}

async function dispatchGrok(
  input: RunNodeAgentInput,
  resolved: AgentQueryConfig,
  policy: WorkflowNodeExecutionPolicy,
  abortSignal: AbortSignal,
  deps: WorkflowAdapterDeps,
): Promise<BackendRawResult> {
  const backend = deps.grokBackend ?? defaultGrokBackend;
  const { autoApproved } = partitionSdkTools(policy);
  const allowedMcp = filterMcpServersByPolicy(resolved.mcpServers, policy);
  const rawEffort = input.effectiveEffort;
  const grokModel = input.effectiveModel ?? resolved.model;
  const effort =
    rawEffort === undefined
      ? undefined
      : clampGrokEffortForModel(
          (rawEffort === 'low' || rawEffort === 'medium' || rawEffort === 'high'
            ? rawEffort
            : 'high') as GrokReasoningEffort,
          grokModel,
        );
  if (rawEffort !== undefined && effort !== rawEffort) {
    logger.info(
      { agentId: input.agentId, rawEffort, effort, model: grokModel },
      'dispatchGrok: effort clampado para o suportado pelo modelo',
    );
  }
  return backend({
    agentId: input.agentId,
    runtime: 'grok',
    model: input.effectiveModel ?? resolved.model,
    ...(effort ? { effort } : {}),
    systemPrompt: resolved.systemPrompt,
    prompt: input.prompt,
    cwd: policy.cwd,
    allowedTools: autoApproved,
    mcpServers: allowedMcp,
    canUseTool: createComposedCanUseTool(
      policy,
      new WorkflowPathGuard({
        workspaceRoot: policy.workspaceRoot,
        writeSet: input.writeSet,
        protectedPaths: input.protectedPaths,
      }),
    ),
    abortSignal,
    timeoutMs: policy.timeoutMs,
    onStreamChunk: input.onStreamChunk,
  });
}

async function dispatchCursor(
  input: RunNodeAgentInput,
  resolved: AgentQueryConfig,
  policy: WorkflowNodeExecutionPolicy,
  abortSignal: AbortSignal,
  deps: WorkflowAdapterDeps,
): Promise<BackendRawResult> {
  const backend = deps.cursorBackend ?? defaultCursorBackend;
  const { autoApproved } = partitionSdkTools(policy);
  const allowedMcp = filterMcpServersByPolicy(resolved.mcpServers, policy);
  const effectiveModel = input.effectiveModel ?? resolved.model;
  const clampedEffort =
    input.effectiveEffort !== undefined
      ? clampCursorEffortForModel(input.effectiveEffort, effectiveModel)
      : null;
  return backend({
    agentId: input.agentId,
    runtime: 'cursor',
    model: effectiveModel,
    ...(clampedEffort !== null
      ? { effort: clampedEffort === 'xhigh' ? ('max' as const) : clampedEffort }
      : {}),
    systemPrompt: resolved.systemPrompt,
    prompt: input.prompt,
    cwd: policy.cwd,
    allowedTools: autoApproved,
    mcpServers: allowedMcp,
    canUseTool: createComposedCanUseTool(
      policy,
      new WorkflowPathGuard({
        workspaceRoot: policy.workspaceRoot,
        writeSet: input.writeSet,
        protectedPaths: input.protectedPaths,
      }),
    ),
    abortSignal,
    timeoutMs: policy.timeoutMs,
    onStreamChunk: input.onStreamChunk,
  });
}

async function dispatchLocalFamily(
  input: RunNodeAgentInput,
  resolved: AgentQueryConfig,
  policy: WorkflowNodeExecutionPolicy,
  abortSignal: AbortSignal,
  deps: WorkflowAdapterDeps,
): Promise<BackendRawResult> {
  if (!deps.localModelRound) {
    throw new Error(
      'local-family: localModelRound nao fornecido (o runner deve injetar o round do modelo)',
    );
  }
  const pathGuard = new WorkflowPathGuard({
    workspaceRoot: policy.workspaceRoot,
    writeSet: input.writeSet,
    protectedPaths: input.protectedPaths,
  });
  const dispatched = await runLocalDispatcher({
    policy,
    prompt: input.prompt,
    systemPrompt: resolved.systemPrompt,
    modelRound: deps.localModelRound,
    abortSignal,
    pathGuard,
    toolExecutor: deps.localToolExecutor,
  });
  return {
    output: dispatched.output,
    model: resolved.model,
  };
}


export function filterMcpServersByPolicy(
  entries: AgentQueryConfig['mcpServers'],
  policy: WorkflowNodeExecutionPolicy,
): AgentQueryConfig['mcpServers'] {
  const allowed = new Set(policy.effectiveMcpServers);
  return entries.filter((entry) =>
    Object.keys(entry).some((serverId) => allowed.has(serverId)),
  );
}

const defaultClaudeCompatBackend: ClaudeCompatBackend = async () => {
  throw new Error(
    'claudeCompat backend nao injetado: o runner (S11) deve fornecer o executor Claude-compatible com as options montadas',
  );
};

const defaultKimiBackend: KimiBackend = async () => {
  throw new Error(
    'kimiBackend nao injetado: o runner (S11) deve fornecer o executor Kimi (executeAgent -> kimiExecutor) com as options montadas',
  );
};

const defaultGrokBackend: GrokBackend = async () => {
  throw new Error(
    'grokBackend nao injetado: o runner deve fornecer o executor Grok ACP com model/effort efetivos',
  );
};

const defaultCursorBackend: CursorBackend = async () => {
  throw new Error(
    'cursorBackend nao injetado: o runner (workflow-runner-deps) deve fornecer o executor Cursor (executeAgent -> cursorExecutor) com as options montadas',
  );
};

function emptyPolicy(input: RunNodeAgentInput): WorkflowNodeExecutionPolicy {
  return {
    runId: input.runId,
    nodeId: input.grants.nodeId,
    agentId: input.agentId || input.grants.agentId,
    workspaceRoot: input.workspace.workspaceRoot,
    cwd: input.workspace.cwd,
    access: input.grants.access ?? 'read-only',
    allowedTools: [],
    deniedTools: [...GUARD_GATED_TOOL_NAMES, 'Task', 'Agent'],
    allowedMcpServers: [],
    allowedMcpTools: [],
    allowedCommands: [],
    effectiveTools: [],
    effectiveMcpServers: [],
    policyHash: '',
    allowBash: false,
    allowNetwork: false,
    timeoutMs: input.grants.timeoutMs ?? 0,
    idleTimeoutMs: input.grants.idleTimeoutMs ?? 0,
    costCeilingUsd: input.grants.costCeilingUsd ?? 0,
  };
}
