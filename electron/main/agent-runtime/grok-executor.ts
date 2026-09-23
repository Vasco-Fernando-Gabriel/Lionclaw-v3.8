import { createLogger } from '../logger';
import { calculateCost, hasKnownPricing } from '../pricing';
import { getGrokAcpDriver } from '../grok-acp/acp-driver';
import type { GrokAcpResponse } from '../grok-acp/acp-translator';
import { startGrokMcpBridge, type GrokMcpBridge } from '../grok-acp/mcp-http-bridge';
import type { GrokAcpProfile, GrokAcpRunOptions, GrokEffort } from '../grok-acp/types';
import { GROK_DEFAULT_EFFORT, clampGrokEffortForModel, grokEffortsForModel } from '../../../src/constants/grok-models';
import type { AgentQueryConfig } from '../agent-config-resolver';
import { emptyResponseExecutionError } from './llm-error';
import {
  buildGrokChildEnv,
  assertGrokWorkspaceIsolation,
  isGrokAvailable,
  prepareGrokWorkspace,
  resolveGrokBinary,
  resolveGrokHome,
  GrokAuthError,
  GrokBackendError,
  GrokCapabilityError,
  GrokIsolationError,
  GrokProcessError,
  GrokToolPolicyError,
  GrokUnavailableError,
} from './grok-availability';
import {
  acquireGrokSlot,
  configureGrokConcurrency,
  GrokConcurrencyError,
  GrokQuotaError,
  GROK_QUOTA_MESSAGE,
  isGrokQuotaFailure,
} from './grok-concurrency';
import { buildGrokNativeToolPolicy, buildGrokSessionTools, type GrokToolProfile } from './grok-session-config';
import {
  acquireGrokSandboxSpawnLock,
  assertGrokWorkspaceUnchanged,
  attestGrokSession,
  ensureGrokSandboxProfile,
  grokInputTouchesProtectedSource,
  resolveGrokWorkspaceGrant,
  snapshotGrokSandboxAttestation,
  waitForGrokSandboxApplied,
} from '../grok-sdk/workspace';
import type { AgentExecutionRequest, AgentExecutionResult, RuntimeExecutor } from './types';

export {
  GrokAuthError,
  GrokBackendError,
  GrokCapabilityError,
  GrokConcurrencyError,
  GrokIsolationError,
  GrokProcessError,
  GrokQuotaError,
  GrokToolPolicyError,
  GrokUnavailableError,
};

const logger = createLogger('grok-executor');

function toolProfile(req: AgentExecutionRequest, config: AgentQueryConfig): GrokToolProfile {
  if (req.projectId) return 'pipeline';
  if (config.allowedTools.length > 0) return 'agent-scoped';
  return 'one-shot';
}

function effectiveEffort(req: AgentExecutionRequest, config: AgentQueryConfig): GrokEffort {
  const requested =
    req.inheritedEffort?.grok ??
    (config.effort === 'low' || config.effort === 'medium' || config.effort === 'high'
      ? config.effort
      : GROK_DEFAULT_EFFORT);
  return clampGrokEffortForModel(requested, config.model);
}

function runtimePrompt(systemPrompt: string, model: string, effort: GrokEffort): string {
  return [
    systemPrompt,
    '',
    '## Runtime Atual',
    '',
    '- Runtime: grok',
    '- Provider: Grok Build (xAI) via CLI oficial e assinatura',
    `- Modelo selecionado: ${model}`,
    `- Reasoning effort: ${effort}`,
    '- Este runtime nao usa XAI_API_KEY nem a API pay-as-you-go.',
  ]
    .join('\n')
    .trim();
}

function usageReported(response: GrokAcpResponse): boolean {
  if (response.usage.cacheCreationTokens > 0) return false;
  return response.usage.reported ?? (response.usage.inputTokens > 0 && response.usage.outputTokens > 0);
}

function equivalentCost(
  response: GrokAcpResponse,
  model: string,
): {
  value: number;
  status: 'known' | 'unknown';
  source?: 'provider-reported-equivalent' | 'calculated';
  reason?: 'no-usage-reported' | 'unknown-pricing';
} {
  if (!usageReported(response)) return { value: 0, status: 'unknown', reason: 'no-usage-reported' };
  const ticks = response.usage.costUsdTicks;
  if (ticks !== undefined && Number.isSafeInteger(ticks) && ticks >= 0) {
    return { value: ticks / 10_000_000_000, status: 'known', source: 'provider-reported-equivalent' };
  }
  const totalModelCalls = response.usage.modelCalls ?? 1;
  const modelUsage = response.usage.modelUsage;
  if (modelUsage && Object.keys(modelUsage).length > 0) {
    const rows = Object.entries(modelUsage);
    const detailedCalls = rows.reduce((sum, [, usage]) => sum + (usage.modelCalls ?? 0), 0);
    const detailedInput = rows.reduce((sum, [, usage]) => sum + usage.inputTokens, 0);
    const detailedOutput = rows.reduce((sum, [, usage]) => sum + usage.outputTokens, 0);
    const detailedCacheRead = rows.reduce((sum, [, usage]) => sum + usage.cachedReadTokens, 0);
    const detailedReasoning = rows.reduce((sum, [, usage]) => sum + usage.reasoningTokens, 0);
    if (
      rows.length === 0 ||
      detailedCalls !== totalModelCalls ||
      detailedInput !== response.usage.inputTokens ||
      detailedOutput !== response.usage.outputTokens ||
      detailedCacheRead !== response.usage.cacheReadTokens ||
      (response.usage.reasoningTokens !== undefined && detailedReasoning !== response.usage.reasoningTokens) ||
      rows.some(([usageModel, usage]) => usage.modelCalls !== 1 || !hasKnownPricing(usageModel))
    ) {
      return { value: 0, status: 'unknown', reason: 'unknown-pricing' };
    }
    return {
      value: rows.reduce(
        (sum, [usageModel, usage]) =>
          sum +
          calculateCost(usageModel, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens, 0, 0, {
            perRequestInput: true,
          }),
        0,
      ),
      status: 'known',
      source: 'calculated',
    };
  }
  if (totalModelCalls > 1) {
    return { value: 0, status: 'unknown', reason: 'unknown-pricing' };
  }
  if (!hasKnownPricing(model)) {
    return { value: 0, status: 'unknown', reason: 'unknown-pricing' };
  }
  return {
    value: calculateCost(
      model,
      response.usage.inputTokens,
      response.usage.outputTokens,
      response.usage.cacheReadTokens,
      0,
      0,
      { perRequestInput: true },
    ),
    status: 'known',
    source: 'calculated',
  };
}

function metadataModelUsage(
  response: GrokAcpResponse,
): NonNullable<NonNullable<AgentExecutionResult['metadata']>['modelUsage']> | undefined {
  if (!response.usage.modelUsage) return undefined;
  return Object.fromEntries(
    Object.entries(response.usage.modelUsage).map(([model, usage]) => {
      const reportedTicks = usage.costUsdTicks;
      const costUSD =
        typeof reportedTicks === 'number' && Number.isSafeInteger(reportedTicks) && reportedTicks >= 0
          ? reportedTicks / 10_000_000_000
          : usage.modelCalls === 1 && hasKnownPricing(model)
            ? calculateCost(model, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens, 0, 0, {
                perRequestInput: true,
              })
            : 0;
      return [
        model,
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cachedReadTokens,
          cacheCreationInputTokens: 0,
          costUSD,
          reasoningTokens: usage.reasoningTokens,
          ...(usage.modelCalls !== undefined ? { modelCalls: usage.modelCalls } : {}),
          ...(usage.costUsdTicks !== undefined ? { costUsdTicks: usage.costUsdTicks } : {}),
        },
      ];
    }),
  );
}

async function run(req: AgentExecutionRequest, config: AgentQueryConfig): Promise<AgentExecutionResult> {
  if (req.abortController.signal.aborted) throw new GrokUnavailableError('Grok run aborted before start.');
  assertGrokWorkspaceIsolation(req.cwd);
  if (grokEffortsForModel(config.model).length === 0) {
    throw new GrokBackendError(`Modelo Grok nao allowlisted: ${config.model}`);
  }

  const availability = await isGrokAvailable();
  if (!availability.installed) throw new GrokUnavailableError('Grok Build CLI nao esta instalado.');
  if (!availability.authenticated) throw new GrokAuthError();
  if (!availability.usable || !availability.subscriptionRouteVerified || availability.modelAvailable !== true) {
    throw new GrokBackendError(availability.reason ?? 'Grok subscription route/model was not verified.');
  }

  const startedAt = Date.now();
  const workspaceGrant = resolveGrokWorkspaceGrant({
    lane: 'desktop',
    repoRootSnapshot: req.cwd,
  });
  const grokHome = resolveGrokHome();
  const env = buildGrokChildEnv(grokHome);
  const binary = await resolveGrokBinary();
  if (!binary) throw new GrokUnavailableError('Grok Build CLI nao encontrado.');
  await prepareGrokWorkspace(workspaceGrant, binary, env);
  let configuredConcurrency = 3;
  try {
    const { getSetting } = await import('../db');
    configuredConcurrency = Number.parseInt(getSetting('grok_max_concurrency') || '', 10);
  } catch {
    configuredConcurrency = 3;
  }
  configureGrokConcurrency(
    Number.isInteger(configuredConcurrency) && configuredConcurrency >= 1 && configuredConcurrency <= 16
      ? configuredConcurrency
      : 3,
  );
  const profile = toolProfile(req, config);
  const effort = effectiveEffort(req, config);
  const sessionTools = await buildGrokSessionTools({
    profile,
    config,
    cwd: req.cwd,
    abortController: req.abortController,
    ...(req.projectId ? { projectId: req.projectId } : {}),
    ...(req.executionContext ? { dispatchContext: req.executionContext } : {}),
  });
  const externalTools = sessionTools.externalTools.map((tool) => ({
    ...tool,
    async handler(input: Record<string, unknown>, callContext?: { toolUseId: string }) {
      assertGrokWorkspaceUnchanged(workspaceGrant);
      if (grokInputTouchesProtectedSource(workspaceGrant, input)) {
        throw new GrokIsolationError('Tool LionClaw tentou alterar fonte/configuracao protegida do Grok.');
      }
      const result = await tool.handler(input, callContext);
      assertGrokWorkspaceUnchanged(workspaceGrant);
      return result;
    },
  }));
  const nativePolicy = buildGrokNativeToolPolicy(profile, config.allowedTools);
  const role = req.executionContext ? (req.executionContext.depth > 0 ? 'child' : 'parent') : 'standalone';
  const release = await acquireGrokSlot({
    signal: req.abortController.signal,
    role,
    toolBearing: externalTools.length > 0 || nativePolicy.effectiveTools.length > 0,
    ...(req.executionContext ? { parentExecutionId: req.executionContext.parentExecutionId } : {}),
    ...(req.executionContext
      ? {
          rootExecutionId: req.executionContext.rootExecutionId,
          executionDepth: req.executionContext.depth,
        }
      : {}),
  });

  let bridge: GrokMcpBridge | null = null;
  let handle: Awaited<ReturnType<ReturnType<typeof getGrokAcpDriver>['createRun']>> | null = null;
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
  };
  req.abortController.signal.addEventListener('abort', onAbort, { once: true });

  try {
    if (externalTools.length > 0) {
      bridge = await startGrokMcpBridge({ tools: externalTools, serverName: 'lionclaw' });
    }
    const driver = getGrokAcpDriver();
    const surface: GrokAcpRunOptions['surface'] = req.projectId ? 'pipeline' : 'agent';
    const acpProfile: GrokAcpProfile = profile;
    const releaseSandboxSpawn = await acquireGrokSandboxSpawnLock();
    try {
      const sandbox = ensureGrokSandboxProfile(workspaceGrant, grokHome, profile === 'one-shot' ? 'strict' : undefined);
      const sandboxAttestation = snapshotGrokSandboxAttestation(
        grokHome,
        sandbox,
        workspaceGrant.processCwd,
        workspaceGrant.projectSources.map((source) => source.path),
      );
      handle = await driver.createRun({
        workDir: req.cwd,
        processCwd: workspaceGrant.processCwd,
        model: config.model,
        effort,
        thinking: true,
        systemPrompt: '',
        executable: binary,
        env,
        abortSignal: req.abortController.signal,
        profile: acpProfile,
        permission: req.permission,
        sandbox,
        nativeToolArgs: nativePolicy.argv,
        surface,
        ownerKind: req.projectId ? 'pipeline' : 'agent',
        runId: `${req.projectId ?? 'agent'}:${req.agentId}:${Date.now()}`,
        ...(req.projectId ? { projectId: req.projectId } : {}),
        ...(req.agentId ? { agentId: req.agentId } : {}),
        mcpServers: bridge ? [bridge.mcpServerEntry] : [],
        attestSession: (sessionId) => attestGrokSession(workspaceGrant, grokHome, sessionId),
        assertWorkspaceUnchanged: () => assertGrokWorkspaceUnchanged(workspaceGrant),
      });
      await waitForGrokSandboxApplied(sandboxAttestation);
    } finally {
      releaseSandboxSpawn();
    }

    const fullPrompt = runtimePrompt(sessionTools.systemPrompt, config.model, effort);
    const leadingPrompt = fullPrompt
      ? `## Instrucoes do agente\n\n${fullPrompt}\n\n## Tarefa\n\n${req.prompt}`
      : req.prompt;
    const response = (await handle.send(
      leadingPrompt,
      {
        onText: req.onText,
        onThinking: req.onThinking,
        onToolUse: req.onToolUse,
        onToolUseComplete: req.onToolUseComplete,
        onActivity: req.onActivity,
      },
      req.abortController.signal,
    )) as GrokAcpResponse;
    assertGrokWorkspaceUnchanged(workspaceGrant);
    const durationMs = Date.now() - startedAt;
    const cost = equivalentCost(response, config.model);
    const reported = usageReported(response);
    const modelUsage = reported ? metadataModelUsage(response) : undefined;
    const auditRawUsage = response.metadata?.rawUsage;
    const auditProviderInputTokens = auditRawUsage?.providerInputTokens ?? response.usage.providerInputTokens;
    const auditReasoningTokens = auditRawUsage?.reasoningTokens ?? response.usage.reasoningTokens;
    const auditModelCalls = auditRawUsage?.modelCalls ?? response.usage.modelCalls;
    const auditApiDurationMs = auditRawUsage?.apiDurationMs ?? response.usage.apiDurationMs;
    const auditCostUsdTicks = auditRawUsage?.costUsdTicks ?? response.usage.costUsdTicks;
    const auditNumTurns = auditRawUsage?.numTurns ?? response.usage.numTurns;
    const canonicalUsage = reported
      ? response.usage
      : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const resultError = emptyResponseExecutionError({
      content: response.content,
      toolUses: response.toolUses,
      aborted,
      provider: 'grok',
      model: config.model,
    });

    const richMetadata: AgentExecutionResult['metadata'] = {
      costEstimationKind: 'subscription-equivalent-payg',
      ...(cost.source ? { costSource: cost.source } : {}),
      ...(modelUsage ? { modelUsage } : {}),
      grok: {
        ...(response.usage.reasoningTokens !== undefined ? { reasoningTokens: response.usage.reasoningTokens } : {}),
        ...(response.usage.modelCalls !== undefined ? { modelCalls: response.usage.modelCalls } : {}),
        ...(response.usage.apiDurationMs !== undefined ? { apiDurationMs: response.usage.apiDurationMs } : {}),
        ...(response.usage.costUsdTicks !== undefined ? { costUsdTicks: response.usage.costUsdTicks } : {}),
        ...(response.usage.numTurns !== undefined ? { numTurns: response.usage.numTurns } : {}),
        ...(!reported
          ? {
              rawUsage: {
                inputTokens: auditRawUsage?.inputTokens ?? response.usage.inputTokens,
                outputTokens: auditRawUsage?.outputTokens ?? response.usage.outputTokens,
                cacheReadTokens: auditRawUsage?.cacheReadTokens ?? response.usage.cacheReadTokens,
                cacheCreationTokens: auditRawUsage?.cacheCreationTokens ?? response.usage.cacheCreationTokens,
                ...(auditProviderInputTokens !== undefined ? { providerInputTokens: auditProviderInputTokens } : {}),
                ...(auditReasoningTokens !== undefined ? { reasoningTokens: auditReasoningTokens } : {}),
                ...(auditModelCalls !== undefined ? { modelCalls: auditModelCalls } : {}),
                ...(auditApiDurationMs !== undefined ? { apiDurationMs: auditApiDurationMs } : {}),
                ...(auditCostUsdTicks !== undefined ? { costUsdTicks: auditCostUsdTicks } : {}),
                ...(auditNumTurns !== undefined ? { numTurns: auditNumTurns } : {}),
              },
            }
          : {}),
      },
    };

    logger.info(
      {
        agentId: req.agentId,
        model: config.model,
        effort,
        inputTokens: canonicalUsage.inputTokens,
        outputTokens: canonicalUsage.outputTokens,
        reasoningTokens: response.usage.reasoningTokens,
        modelCalls: response.usage.modelCalls,
        costUsd: cost.value,
        costStatus: cost.status,
        durationMs,
      },
      'Grok executor finished',
    );

    return {
      output: response.content,
      metrics: {
        inputTokens: canonicalUsage.inputTokens,
        outputTokens: canonicalUsage.outputTokens,
        cacheReadTokens: canonicalUsage.cacheReadTokens,
        cacheCreationTokens: canonicalUsage.cacheCreationTokens,
        toolUses: response.toolUses,
        apiRequests: reported ? (response.usage.modelCalls ?? 1) : 0,
        costUsd: cost.value,
        durationMs,
        costStatus: cost.status,
        tokenStatus: reported ? 'reported' : 'not_reported',
        ...(cost.status === 'unknown' ? { costUnknownReason: cost.reason ?? ('unknown-pricing' as const) } : {}),
      },
      model: config.model,
      runtime: 'grok',
      provider: 'grok',
      metadata: richMetadata,
      ...(resultError ? { error: resultError } : {}),
    };
  } catch (error) {
    if (aborted) throw new GrokProcessError('Grok run cancelled.', { cause: error });
    if (isGrokQuotaFailure(error)) throw new GrokQuotaError(GROK_QUOTA_MESSAGE, { cause: error });
    throw error;
  } finally {
    req.abortController.signal.removeEventListener('abort', onAbort);
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        logger.warn({ error }, 'Grok handle close failed');
      }
    }
    if (bridge) {
      try {
        await bridge.stop();
      } catch (error) {
        logger.warn({ error }, 'Grok MCP bridge stop failed');
      }
    }
    release();
  }
}

export const grokExecutor: RuntimeExecutor = { run };
