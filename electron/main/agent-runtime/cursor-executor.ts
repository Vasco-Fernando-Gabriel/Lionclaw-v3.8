import { randomUUID } from 'crypto';
import { createLogger } from '../logger';
import { calculateCost, getPricingSnapshot, hasKnownPricing } from '../pricing';
import { getSecret } from '../secrets-vault';
import { getCursorModel } from '../../../src/constants/cursor-models';
import { WATCHDOG_TIMEOUT_MS, createWatchdog } from './watchdog';
import { TypedProviderError, emptyResponseExecutionError } from './llm-error';
import { CursorSidecarError, runCursorSidecarExecution } from './cursor-sidecar/sidecar-manager';
import type { CursorSidecarStreamEvent } from './cursor-sidecar/sidecar-manager';
import { composeCursorToolDispatchers } from './cursor-sidecar/tool-dispatch';
import { CURSOR_GUARDED_NATIVE_ALLOWLIST, buildCursorGuardedToolset } from './cursor-sidecar/guarded-tools';
import { isCursorCatalogModel } from './cursor-sidecar/model-catalog';
import {
  buildCursorSessionKey,
  cursorSessionStoreDir,
  loadCursorSession,
  saveCursorSession,
} from './cursor-sidecar/session-registry';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { AgentExecutionRequest, AgentExecutionResult, RuntimeExecutor } from './types';

const logger = createLogger('cursor-executor');

const PROVIDER = 'cursor';
const CURSOR_VAULT_KEY = 'CURSOR_API_KEY';

export const CURSOR_FIRST_TOKEN_TIMEOUT_MS = 90_000;
export const CURSOR_STALL_TIMEOUT_MS = WATCHDOG_TIMEOUT_MS;

function appendCursorRuntimeContext(systemPrompt: string, model: string): string {
  const runtimeBlock = [
    '',
    '',
    '## Runtime Atual',
    '',
    '- Runtime: cursor',
    '- Provider: Cursor (@cursor/sdk) via assinatura',
    `- Modelo selecionado: ${model}`,
    '- O custo em dolar exibido e equivalente-API estimado; a cobranca real e o plano Cursor.',
    '- Use esta informacao quando o usuario perguntar qual modelo ou runtime esta executando este agente.',
  ].join('\n');
  return `${systemPrompt || ''}${runtimeBlock}`;
}

interface StreamCallbackStats {
  toolUses: number;
}

function relayStreamEvent(event: unknown, req: AgentExecutionRequest, stats: StreamCallbackStats): void {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    req.onActivity?.();
    return;
  }
  const evt = event as Record<string, unknown>;
  switch (evt['type']) {
    case 'assistant': {
      const message = evt['message'];
      const content =
        message && typeof message === 'object' && !Array.isArray(message)
          ? (message as Record<string, unknown>)['content']
          : undefined;
      let emitted = false;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === 'object' &&
            (block as Record<string, unknown>)['type'] === 'text' &&
            typeof (block as Record<string, unknown>)['text'] === 'string'
          ) {
            req.onText?.((block as Record<string, unknown>)['text'] as string);
            emitted = true;
          }
        }
      }
      if (!emitted) req.onActivity?.();
      break;
    }
    case 'thinking': {
      const text = typeof evt['text'] === 'string' ? (evt['text'] as string) : '';
      if (text.length > 0) req.onThinking?.(text);
      else req.onActivity?.();
      break;
    }
    case 'tool_call': {
      const name = typeof evt['name'] === 'string' ? (evt['name'] as string) : 'unknown';
      const status = evt['status'];
      if (status === 'running') {
        req.onToolUse?.(name);
      } else if (status === 'completed' || status === 'error') {
        stats.toolUses += 1;
        req.onToolUseComplete?.(name, evt['args']);
      } else {
        req.onActivity?.();
      }
      break;
    }
    default:
      req.onActivity?.();
  }
}

async function run(req: AgentExecutionRequest, config: AgentQueryConfig): Promise<AgentExecutionResult> {
  if (req.abortController.signal.aborted) {
    throw new CursorSidecarError('Execucao cursor abortada antes do start.', 'aborted');
  }

  const guarded = !req.permission.dangerouslySkipPermissions;
  const composedGuard = req.permission.canUseTool;
  if (guarded && !composedGuard) {
    throw new Error(
      'Runtime cursor: perfil guardado sem canUseTool (PERM_DEFAULT_NO_BYPASS) nao e suportado — ' +
        'o enforcement guardado exige a policy composta no canUseTool do profile ' +
        '(SPEC cursor-runtime, "Enforcement de tools nativas"). Fail-closed.',
    );
  }
  const guardedToolset =
    guarded && composedGuard ? buildCursorGuardedToolset({ cwd: req.cwd, canUseTool: composedGuard }) : null;

  if (!getCursorModel(config.model) && !isCursorCatalogModel(config.model)) {
    throw new TypedProviderError('LLM-MODEL-404', {
      message: `Modelo "${config.model}" nao pertence ao catalogo do runtime Cursor.`,
      raw: `model=${config.model} runtime=cursor`,
    });
  }

  const apiKey = await getSecret(CURSOR_VAULT_KEY);
  if (!apiKey) {
    throw new TypedProviderError('LLM-AUTH-401', {
      message:
        'Cursor API key ausente do Vault (CURSOR_API_KEY). ' +
        'Gere uma User API key em cursor.com/dashboard e cadastre em Settings > Providers.',
      raw: `vaultKey=${CURSOR_VAULT_KEY}`,
    });
  }

  const startedAt = Date.now();
  const sessionKey = buildCursorSessionKey({
    agentId: req.agentId,
    cwd: req.cwd,
    ...(req.projectId ? { projectId: req.projectId } : {}),
  });
  const storeDir = cursorSessionStoreDir(sessionKey);
  const priorSession = req.continueSession ? loadCursorSession(sessionKey) : null;
  const resumeAgentId = priorSession?.cursorAgentId;

  const systemPromptWithContext = appendCursorRuntimeContext(config.systemPrompt, config.model);
  const prompt = resumeAgentId
    ? req.prompt
    : systemPromptWithContext.trim().length > 0
      ? `## Instrucoes do agente\n\n${systemPromptWithContext}\n\n## Tarefa\n\n${req.prompt}`
      : req.prompt;

  const executionId = `cursor-${randomUUID()}`;

  const childAbort = new AbortController();
  const onParentAbort = (): void => {
    if (!childAbort.signal.aborted) childAbort.abort();
  };
  if (req.abortController.signal.aborted) {
    childAbort.abort();
  } else {
    req.abortController.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const cleanupParentListener = (): void => {
    req.abortController.signal.removeEventListener('abort', onParentAbort);
  };

  let watchdogError: TypedProviderError | null = null;
  const abortWithTimeout = (error: TypedProviderError): void => {
    if (watchdogError !== null || childAbort.signal.aborted) return;
    watchdogError = error;
    logger.warn(
      { executionId, agentId: req.agentId, model: config.model, message: error.message },
      'Watchdog cursor disparou — abortando a execucao de verdade',
    );
    childAbort.abort();
  };

  const stallWatchdog = createWatchdog(CURSOR_STALL_TIMEOUT_MS, (info) => {
    abortWithTimeout(
      new TypedProviderError('LLM-TIMEOUT', {
        message:
          `Runtime cursor sem progresso ha ${info.secondsSinceLastChunk}s — ` +
          'execucao abortada pelo watchdog de stall.',
        raw: `executionId=${executionId} lastChunkAt=${info.lastChunkAt}`,
      }),
    );
  });
  let firstEventSeen = false;
  const firstTokenTimer = setTimeout(() => {
    abortWithTimeout(
      new TypedProviderError('LLM-TIMEOUT', {
        message:
          `Runtime cursor nao emitiu nenhum evento em ${CURSOR_FIRST_TOKEN_TIMEOUT_MS}ms — ` +
          'execucao abortada pelo watchdog de primeiro token.',
        raw: `executionId=${executionId}`,
      }),
    );
  }, CURSOR_FIRST_TOKEN_TIMEOUT_MS);
  firstTokenTimer.unref?.();

  const stats: StreamCallbackStats = { toolUses: 0 };
  const onEvent = (relayed: CursorSidecarStreamEvent): void => {
    if (!firstEventSeen) {
      firstEventSeen = true;
      clearTimeout(firstTokenTimer);
    }
    stallWatchdog.reset();
    relayStreamEvent(relayed.event, req, stats);
  };

  try {
    const result = await runCursorSidecarExecution({
      config: {
        executionId,
        model: config.model,
        apiKey,
        cwd: req.cwd,
        storeDir,
        prompt,
        settingSources: [],
        guarded,
        ...(guardedToolset !== null ? { allowedTools: [...CURSOR_GUARDED_NATIVE_ALLOWLIST] } : {}),
        ...(!guarded && process.platform !== 'win32' ? { sandbox: true } : {}),
        customTools: guardedToolset?.declarations ?? [],
        ...(resumeAgentId !== undefined ? { resumeAgentId } : {}),
      },
      abortController: childAbort,
      dispatchTool: composeCursorToolDispatchers(guardedToolset?.handlers ?? {}),
      onEvent,
    });

    if (watchdogError !== null) throw watchdogError;
    if (result.status === 'cancelled') {
      throw new CursorSidecarError(`Execucao cursor ${executionId} cancelada pelo abort.`, 'aborted');
    }
    if (result.status !== 'finished') {
      throw new Error(
        `Run cursor terminou com status "${result.status}"` +
          `${result.errorCode !== undefined ? ` (code=${result.errorCode})` : ''}` +
          `${result.errorMessage !== undefined ? `: ${result.errorMessage}` : ''}`,
      );
    }

    if (result.agentId !== undefined && result.agentId.length > 0) {
      saveCursorSession(sessionKey, {
        cursorAgentId: result.agentId,
        model: config.model,
        updatedAt: new Date().toISOString(),
      });
    }

    const durationMs = result.durationMs ?? Date.now() - startedAt;
    const output = result.finalText.length > 0 ? result.finalText : (result.resultText ?? '');
    const usage = result.usage;
    const resultError = emptyResponseExecutionError({
      content: output,
      toolUses: stats.toolUses,
      provider: PROVIDER,
      model: config.model,
    });

    if (!usage) {
      logger.warn(
        { executionId, agentId: req.agentId, model: config.model },
        'cursor: run terminou sem usage inline — custo marcado como nao-reportado',
      );
      return {
        output,
        metrics: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          toolUses: stats.toolUses,
          apiRequests: 1,
          costUsd: 0,
          durationMs,
          costStatus: 'unknown',
          tokenStatus: 'not_reported',
          costUnknownReason: 'no-usage-reported',
        },
        model: config.model,
        runtime: 'cursor',
        provider: PROVIDER,
        metadata: {
          costEstimationKind: 'subscription-equivalent-payg',
          ...(result.agentId !== undefined ? { sessionIds: [result.agentId] } : {}),
        },
        ...(resultError !== undefined ? { error: resultError } : {}),
      };
    }

    const aggregatedInputTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    const pricingKnown = hasKnownPricing(config.model);
    const pricingSnapshot = getPricingSnapshot(config.model);
    const cacheWriteUnpriced =
      pricingSnapshot.entry?.cacheCreationBilling === 'not-separately-reported' && usage.cacheWriteTokens > 0;
    const costUsd = pricingKnown
      ? calculateCost(
          config.model,
          aggregatedInputTokens,
          usage.outputTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
        )
      : 0;
    const costStatus: 'known' | 'unknown' | 'estimated-partial' = !pricingKnown
      ? 'unknown'
      : cacheWriteUnpriced
        ? 'estimated-partial'
        : 'known';

    logger.info(
      {
        executionId,
        agentId: req.agentId,
        model: config.model,
        inputTokens: aggregatedInputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        reasoningTokens: usage.reasoningTokens,
        toolUses: stats.toolUses,
        costUsd,
        costStatus,
        durationMs,
        resumed: resumeAgentId !== undefined,
      },
      'cursor executor finished',
    );

    return {
      output,
      metrics: {
        inputTokens: aggregatedInputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheWriteTokens,
        toolUses: stats.toolUses,
        apiRequests: 1,
        costUsd,
        durationMs,
        costStatus,
        tokenStatus: 'reported',
        ...(costStatus === 'unknown' ? { costUnknownReason: 'unknown-pricing' as const } : {}),
        ...(costStatus === 'estimated-partial' ? { costStatusReasons: ['cache-write-not-reported'] as const } : {}),
      },
      model: config.model,
      runtime: 'cursor',
      provider: PROVIDER,
      metadata: {
        costEstimationKind: 'subscription-equivalent-payg',
        costSource: 'calculated',
        pricingSnapshot,
        ...(result.agentId !== undefined ? { sessionIds: [result.agentId] } : {}),
        modelUsage: {
          [config.model]: {
            inputTokens: aggregatedInputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadTokens,
            cacheCreationInputTokens: usage.cacheWriteTokens,
            costUSD: costUsd,
            ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
            modelCalls: 1,
          },
        },
      },
      ...(resultError !== undefined ? { error: resultError } : {}),
    };
  } catch (err) {
    if (watchdogError !== null) throw watchdogError;
    throw err;
  } finally {
    clearTimeout(firstTokenTimer);
    stallWatchdog.stop();
    cleanupParentListener();
  }
}

export const cursorExecutor: RuntimeExecutor = { run };
