import { builtinToolsToOllamaSchemas } from './tool-schemas';

import { createLogger } from '../logger';
import { randomUUID } from 'crypto';
import { calculateCost, getPricingSnapshot } from '../pricing';
import {
  isKimiAvailable,
  resolveKimiBinary,
  KimiUnavailableError,
  KimiAuthError,
  type KimiAuthMode,
} from './kimi-availability';
import { acquireKimiSlot, isKimiQuotaFailure, KimiQuotaError, KIMI_QUOTA_MESSAGE } from './kimi-concurrency';
import { buildKimiSessionTools, type KimiToolProfile } from './kimi-session-config';
import { getKimiAcpDriver } from '../kimi-acp/acp-driver';
import { startKimiMcpBridge, type KimiMcpBridge } from '../kimi-acp/mcp-http-bridge';
import type { KimiAcpProfile } from '../kimi-acp/types';
import type { CliRunHandle } from './cli-agentic/contract';
import { resolveKimiEffectiveThinking } from '../../../src/constants/kimi-models';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { RuntimeExecutor, AgentExecutionRequest, AgentExecutionResult } from './types';
import { emptyResponseExecutionError } from './llm-error';

export { KimiAuthError, KimiUnavailableError } from './kimi-availability';
export { KimiQuotaError } from './kimi-concurrency';

const logger = createLogger('kimi-executor');

const KIMI_SUBSCRIPTION_MODEL = 'kimi-code/kimi-for-coding';
const KIMI_PRICING_MODEL = 'kimi-k2.7-code';
export const KIMI_PRICING_REMAP: Record<string, string> = {
  [KIMI_SUBSCRIPTION_MODEL]: KIMI_PRICING_MODEL,
  'kimi-code/k3': 'kimi-k3',
};

const PROVIDER = 'kimi';

function appendKimiRuntimeContext(systemPrompt: string, model: string, effort: string): string {
  const runtimeBlock = [
    '',
    '',
    '## Runtime Atual',
    '',
    '- Runtime: kimi',
    '- Provider: Kimi (Moonshot) via CLI nativo',
    `- Modelo selecionado: ${model}`,
    `- Reasoning effort efetivo: ${effort}`,
    '- Use esta informacao quando o usuario perguntar qual modelo ou runtime esta executando este agente.',
  ].join('\n');
  return `${systemPrompt || ''}${runtimeBlock}`;
}

function deriveKimiToolProfile(req: AgentExecutionRequest, config: AgentQueryConfig): KimiToolProfile {
  if (req.onCodexSessionCreated || req.codexSession || req.projectId) {
    return 'pipeline';
  }
  if (config.allowedTools.length > 0) {
    return 'agent-scoped';
  }
  return 'one-shot';
}

async function run(req: AgentExecutionRequest, config: AgentQueryConfig): Promise<AgentExecutionResult> {
  if (req.abortController.signal.aborted) {
    throw new KimiUnavailableError('kimi run aborted before start');
  }

  const startedAt = Date.now();

  const availability = await isKimiAvailable(config.model);
  const authMode: KimiAuthMode = availability.authMode;

  if (authMode === 'none') {
    throw new KimiAuthError(
      'Kimi nao esta autenticado. Rode `/login` na CLI do Kimi (assinatura) antes de usar subagents runtime=kimi.',
    );
  }
  if (
    availability.managedProviderVerified === false ||
    availability.modelAvailable === false ||
    availability.usable === false
  ) {
    throw new KimiUnavailableError(
      `Modelo ${config.model} nao esta disponivel pelo provider managed/OAuth do Kimi CLI.`,
    );
  }

  const role = req.executionContext ? (req.executionContext.depth > 0 ? 'child' : 'parent') : 'standalone';
  const releaseSlot = await acquireKimiSlot({
    signal: req.abortController.signal,
    role,
    toolBearing: Boolean(req.executionContext && config.allowedTools.includes('Agent')),
    ...(req.executionContext ? { parentExecutionId: req.executionContext.parentExecutionId } : {}),
    ...(req.executionContext
      ? {
          rootExecutionId: req.executionContext.rootExecutionId,
          executionDepth: req.executionContext.depth,
        }
      : {}),
  });

  let bridge: KimiMcpBridge | null = null;
  let handle: CliRunHandle | undefined;
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
  };
  if (req.abortController.signal.aborted) {
    onAbort();
  } else {
    req.abortController.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const binary = await resolveKimiBinary();

    const thinking = config.thinking === 'enabled';
    const explicitEffort = req.effortOverride;
    const inheritedEffort = req.inheritedEffort?.kimi;
    const requestedEffort = explicitEffort ?? inheritedEffort ?? config.effort;
    const effectiveThinking = resolveKimiEffectiveThinking(
      config.model,
      requestedEffort,
      thinking,
      explicitEffort !== undefined ? 'explicit' : 'inherited',
    );

    const kimiProfile = deriveKimiToolProfile(req, config);
    const sessionTools = req.swarmToolDispatch
      ? {
          systemPrompt: config.systemPrompt,
          externalTools: builtinToolsToOllamaSchemas(config.allowedTools).map((schema) => ({
            name: schema.function.name,
            description: schema.function.description,
            parameters: schema.function.parameters,
            handler: async (input: Record<string, unknown>) => {
              const result = await req.swarmToolDispatch!(schema.function.name, input);
              req.onActivity?.();
              return { output: result.result, message: result.result, isError: result.isError };
            },
          })),
        }
      : await buildKimiSessionTools({
          profile: kimiProfile,
          config,
          cwd: req.cwd,
          abortController: req.abortController,
          ...(req.projectId ? { projectId: req.projectId } : {}),
          ...(req.executionContext ? { dispatchContext: req.executionContext } : {}),
        });

    if (sessionTools.externalTools.length > 0) {
      bridge = await startKimiMcpBridge({
        tools: sessionTools.externalTools,
        serverName: 'LionClaw Bridge',
      });
    }

    const driver = getKimiAcpDriver();
    const acpProfile: KimiAcpProfile = kimiProfile;
    handle = await driver.createRun({
      workDir: req.cwd,
      model: config.model,
      effort: effectiveThinking.envEffort,
      thinking,
      systemPrompt: '',
      ...(binary ? { executable: binary } : {}),
      abortSignal: req.abortController.signal,
      permission: req.permission,
      swarmSupervised: Boolean(req.executionAgent),
      swarmOwnerDirectory: req.swarmOwnerDirectory,
      profile: acpProfile,
      surface: req.projectId ? 'pipeline' : 'agent',
      ownerKind: req.projectId ? 'pipeline' : 'agent',
      runId: `kimi-exec-${randomUUID()}`,
      ...(req.projectId ? { projectId: req.projectId } : {}),
      ...(req.agentId ? { agentId: req.agentId } : {}),
      mcpServers: bridge ? [bridge.mcpServerEntry] : [],
    });

    const systemPromptWithContext = appendKimiRuntimeContext(
      sessionTools.systemPrompt,
      config.model,
      effectiveThinking.effective,
    );
    const leadingPrompt =
      systemPromptWithContext.trim().length > 0
        ? `## Instrucoes do agente\n\n${systemPromptWithContext}\n\n## Tarefa\n\n${req.prompt}`
        : req.prompt;

    const cliResponse = await handle.send(
      leadingPrompt,
      {
        onText: req.onText,
        onThinking: req.onThinking,
        onToolUse: req.onToolUse,
        onToolUseComplete: req.onToolUseComplete,
        onActivity: req.onActivity,
      },
      req.abortController.signal,
    );

    const durationMs = Date.now() - startedAt;

    const usageReported = cliResponse.usage.inputTokens > 0 && cliResponse.usage.outputTokens > 0;
    const pricingModel = KIMI_PRICING_REMAP[config.model] ?? config.model;
    const resultError = emptyResponseExecutionError({
      content: cliResponse.content,
      toolUses: cliResponse.toolUses,
      aborted,
      provider: PROVIDER,
      model: config.model,
    });

    if (!usageReported) {
      logger.warn(
        { agentId: req.agentId, model: config.model, toolUses: cliResponse.toolUses },
        'kimi (subscription): response omitted usage - marking usage as unreported',
      );
      return {
        output: cliResponse.content,
        metrics: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          toolUses: cliResponse.toolUses,
          apiRequests: 1,
          costUsd: 0,
          durationMs,
          costStatus: 'unknown',
          tokenStatus: 'not_reported',
          costUnknownReason: 'no-usage-reported',
        },
        model: config.model,
        runtime: 'kimi',
        provider: PROVIDER,
        metadata: {
          costEstimationKind: 'subscription-equivalent-payg',
        },
        ...(resultError !== undefined ? { error: resultError } : {}),
      };
    }

    const costUsd = calculateCost(
      pricingModel,
      cliResponse.usage.inputTokens,
      cliResponse.usage.outputTokens,
      cliResponse.usage.cacheReadTokens,
      cliResponse.usage.cacheCreationTokens,
    );

    logger.info(
      {
        agentId: req.agentId,
        model: config.model,
        authMode,
        inputTokens: cliResponse.usage.inputTokens,
        outputTokens: cliResponse.usage.outputTokens,
        costUsd,
        durationMs,
        toolUses: cliResponse.toolUses,
        status: cliResponse.status,
        requestedEffort,
        effectiveEffort: effectiveThinking.effective,
      },
      'kimi executor finished',
    );

    return {
      output: cliResponse.content,
      metrics: {
        inputTokens: cliResponse.usage.inputTokens,
        outputTokens: cliResponse.usage.outputTokens,
        cacheReadTokens: cliResponse.usage.cacheReadTokens,
        cacheCreationTokens: cliResponse.usage.cacheCreationTokens,
        toolUses: cliResponse.toolUses,
        apiRequests: 1,
        costUsd,
        durationMs,
        costStatus: 'known',
        tokenStatus: 'reported',
      },
      model: config.model,
      runtime: 'kimi',
      provider: PROVIDER,
      metadata: {
        costEstimationKind: 'subscription-equivalent-payg' as const,
        costSource: 'calculated' as const,
        pricingSnapshot: getPricingSnapshot(pricingModel),
        modelUsage: {
          [pricingModel]: {
            inputTokens: cliResponse.usage.inputTokens,
            outputTokens: cliResponse.usage.outputTokens,
            cacheReadInputTokens: cliResponse.usage.cacheReadTokens,
            cacheCreationInputTokens: cliResponse.usage.cacheCreationTokens,
            costUSD: costUsd,
            modelCalls: 1,
          },
        },
      },
      ...(resultError !== undefined ? { error: resultError } : {}),
    };
  } catch (err) {
    if (aborted) {
      throw new KimiUnavailableError('kimi run cancelled');
    }
    if (isKimiQuotaFailure(err)) {
      logger.warn({ agentId: req.agentId, err }, 'kimi run hit quota / rate limit');
      throw new KimiQuotaError(KIMI_QUOTA_MESSAGE, { cause: err });
    }
    throw err;
  } finally {
    req.abortController.signal.removeEventListener('abort', onAbort);
    if (handle) {
      try {
        await handle.close();
      } catch (closeErr) {
        logger.warn({ agentId: req.agentId, closeErr }, 'kimi acp handle.close() failed');
        if (req.executionAgent) throw closeErr;
      }
    }
    if (bridge) {
      try {
        await bridge.stop();
      } catch (bridgeErr) {
        logger.warn({ agentId: req.agentId, bridgeErr }, 'kimi acp bridge.stop() failed');
      }
    }
    releaseSlot();
  }
}

export const kimiExecutor: RuntimeExecutor = { run };
