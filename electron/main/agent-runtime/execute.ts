import { createLogger } from '../logger';
import { resolveAgentQueryConfig } from '../agent-config-resolver';
import { createWatchdog, WATCHDOG_TIMEOUT_MS } from './watchdog';
import { cloudExecutor } from './cloud-executor';
import { localExecutor } from './local-executor';
import { externalExecutor } from './external-executor';
import { codexExecutor } from './codex-executor';
import { zaiExecutor } from './zai-executor';
import { minimaxTokenplanExecutor } from './minimax-tokenplan-executor';
import { kimiExecutor } from './kimi-executor';
import { grokExecutor } from './grok-executor';
import { cursorExecutor } from './cursor-executor';
import {
  GrokAuthError,
  GrokBackendError,
  GrokCapabilityError,
  GrokIsolationError,
  GrokProcessError,
  GrokToolPolicyError,
  GrokUnavailableError,
} from './grok-availability';
import { CodexAuthError, CodexUnavailableError } from '../codex-runtime/errors';
import { KimiAuthError } from './kimi-availability';
import { CodexCapabilityUnsupportedError } from '../codex-runtime/errors';
import { TypedProviderError, translateProviderError } from './llm-error';
import { PipelinePausedError } from './types';
import type { AgentExecutionRequest, AgentExecutionResult } from './types';
import { brandLionDesignText } from '../liondesign-branding';
import { withResolvedRootSubagentGrants } from './subagent-dispatch';

const logger = createLogger('execute-agent');

const AUDIT_INPUT_MAX = 8000;

interface ExecutionAuditEntry {
  sessionId?: string;
  subagent?: string;
  eventType: 'tool_call' | 'error';
  toolName?: string;
  input?: string;
  output?: string;
  source: 'chat' | 'pipeline' | 'harness' | 'workflow' | 'enrich';
}

function createExecutionAuditor(req: AgentExecutionRequest): {
  auditToolUse: (tool: string, input: unknown) => void;
  auditError: (err: unknown) => void;
} {
  const source = req.executionContext?.ownerKind;
  const sessionId = req.executionContext?.sessionId;
  if (!source) {
    return { auditToolUse: () => {}, auditError: () => {} };
  }

  const record = (entry: Omit<ExecutionAuditEntry, 'source'>): void => {
    const full: ExecutionAuditEntry = { ...entry, source };
    void (async () => {
      try {
        const { insertAuditEntry } = await import('../db');
        insertAuditEntry(full);
        const { emitIPC } = await import('../pipeline-shared/ipc-emitter');
        emitIPC('logs:entry', { id: -1, createdAt: new Date().toISOString(), ...full });
      } catch (error) {
        logger.warn({ error, agentId: req.agentId }, 'Falha ao auditar execucao de agente');
      }
    })();
  };

  return {
    auditToolUse: (tool, input) => {
      let serialized: string | undefined;
      try {
        serialized = input === undefined ? undefined : JSON.stringify(input);
      } catch {
        serialized = String(input);
      }
      record({
        ...(sessionId ? { sessionId } : {}),
        subagent: req.agentId,
        eventType: 'tool_call',
        toolName: tool,
        ...(serialized !== undefined
          ? {
              input:
                serialized.length > AUDIT_INPUT_MAX
                  ? `${serialized.slice(0, AUDIT_INPUT_MAX)}... [truncado]`
                  : serialized,
            }
          : {}),
      });
    },
    auditError: (err) => {
      if (err instanceof PipelinePausedError) return;
      record({
        ...(sessionId ? { sessionId } : {}),
        subagent: req.agentId,
        eventType: 'error',
        output: err instanceof Error ? err.message : String(err),
      });
    },
  };
}

export async function executeAgent(req: AgentExecutionRequest): Promise<AgentExecutionResult> {
  let config = req.resolvedConfigOverride ?? (await resolveAgentQueryConfig(req.agentId));
  if (req.allowedToolsOverride !== undefined) {
    const requested = new Set(req.allowedToolsOverride);
    config = {
      ...config,
      allowedTools: config.allowedTools.filter((tool) => requested.has(tool)),
    };
  }

  if (req.systemPromptTransform !== undefined) {
    config = { ...config, systemPrompt: req.systemPromptTransform(config.systemPrompt) };
  }
  config = { ...config, systemPrompt: brandLionDesignText(config.systemPrompt) };

  let timeoutFinalized = false;
  const finishTimeout = (reason: 'timeout-idle' | 'timeout-hard'): void => {
    if (timeoutFinalized || req.abortController.signal.aborted) return;
    timeoutFinalized = true;
    req.swarmLifecycle?.onTimeout(reason);
    req.abortController.abort(new Error(reason));
  };
  const watchdog = createWatchdog(
    req.swarmLifecycle?.idleTimeoutMs ?? WATCHDOG_TIMEOUT_MS,
    (info) => {
      if (req.swarmLifecycle) {
        finishTimeout('timeout-idle');
        return;
      }
      logger.warn(
        { agentId: req.agentId, runtime: config.runtime, ...info },
        'executeAgent: agent stalled — no progress for 3min',
      );
      req.onStalled?.(info);
    },
    req.swarmLifecycle
      ? { limitMs: req.swarmLifecycle.hardTimeoutMs, onHardTimeout: () => finishTimeout('timeout-hard') }
      : undefined,
  );

  const auditor = createExecutionAuditor(req);
  const wrappedReq: AgentExecutionRequest = {
    ...req,
    executionContext: withResolvedRootSubagentGrants(req.executionContext, config),
    prompt: brandLionDesignText(req.prompt),
    onText: watchdog.wrapOnText(req.onText),
    onThinking: watchdog.wrapOnThinking(req.onThinking),
    onToolUse: watchdog.wrapOnToolUse(req.onToolUse),
    onToolUseComplete: watchdog.wrapOnToolUseComplete((tool, input) => {
      auditor.auditToolUse(tool, input);
      req.onToolUseComplete?.(tool, input);
    }),
    onActivity: watchdog.wrapOnActivity(req.onActivity),
  };

  try {
    switch (config.runtime) {
      case 'cloud':
        return await cloudExecutor.run(wrappedReq, config);

      case 'local':
        return await localExecutor.run(wrappedReq, config);

      case 'external':
        return await externalExecutor.run(wrappedReq, config);

      case 'codex':
        return await codexExecutor.run(wrappedReq, config);

      case 'zai':
        return await zaiExecutor.run(wrappedReq, config);

      case 'minimax-tp':
        return await minimaxTokenplanExecutor.run(wrappedReq, config);

      case 'kimi':
        return await kimiExecutor.run(wrappedReq, config);

      case 'grok':
        return await grokExecutor.run(wrappedReq, config);

      case 'cursor':
        return await cursorExecutor.run(wrappedReq, config);

      default: {
        const _exhaustive: never = config.runtime;
        throw new Error(`Runtime nao suportado: ${String(_exhaustive)}`);
      }
    }
  } catch (err) {
    auditor.auditError(err);
    if (
      err instanceof CodexUnavailableError ||
      err instanceof CodexAuthError ||
      err instanceof KimiAuthError ||
      err instanceof PipelinePausedError ||
      err instanceof TypedProviderError ||
      err instanceof CodexCapabilityUnsupportedError ||
      err instanceof GrokUnavailableError ||
      err instanceof GrokAuthError ||
      err instanceof GrokBackendError ||
      err instanceof GrokCapabilityError ||
      err instanceof GrokIsolationError ||
      err instanceof GrokProcessError ||
      err instanceof GrokToolPolicyError
    ) {
      throw err;
    }
    throw translateProviderError(err, {
      runtime: config.runtime,
      model: config.model,
    });
  } finally {
    watchdog.stop();
  }
}
