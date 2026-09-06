/**
 * execute.ts
 *
 * Central dispatch for all agent execution runtimes.
 * Resolves the agent config, creates the watchdog, injects watchdog-wrapped
 * callbacks into the request, and dispatches to the correct executor via an
 * exhaustive switch.
 *
 * When a new runtime (e.g. 'codex') is added to AgentConfig['runtime'], TypeScript
 * will produce a compile error at the `default: never` branch, forcing the developer
 * to add the corresponding case. This is the exhaustiveness guarantee.
 *
 * Constraints:
 * - Does NOT import from pipeline-engine, harness-engine, or security-audit-runner.
 */

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

/**
 * Auditoria de execucoes nao-chat (V144): quando o caller passa um
 * executionContext (pipeline/harness/enrich/workflow e toda a arvore de
 * subagents), cada tool call concluido e cada erro terminal viram entrada no
 * audit_log com `source` = ownerKind. O caminho de CHAT do orquestrador nao
 * passa por executeAgent (D6) e ja audita nos SDKs — aqui so entram execucoes
 * com contexto, entao nao ha dupla contagem. Auditoria nunca derruba a
 * execucao: os imports sao dinamicos (db carrega better-sqlite3; ipc-emitter
 * carrega electron — indisponiveis em alguns ambientes de teste) e qualquer
 * falha e logada e engolida.
 */
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
      // PipelinePausedError e controle de fluxo (pausa conversacional), nao erro.
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

/**
 * Execute an agent by delegating to the correct runtime executor.
 *
 * The watchdog is created here and wraps the onText / onToolUse callbacks
 * before passing them to the executor. The caller's `onStalled` handler
 * (e.g. pipeline-engine wrapping pipeline:stalled IPC) is used as the stall
 * callback so agent-runtime stays decoupled from IPC.
 *
 * @param req - The execution request, including agentId, prompt, and callbacks.
 * @returns The execution result with output, metrics, and runtime metadata.
 */
export async function executeAgent(req: AgentExecutionRequest): Promise<AgentExecutionResult> {
  let config = req.resolvedConfigOverride ?? await resolveAgentQueryConfig(req.agentId);
  if (req.allowedToolsOverride !== undefined) {
    const requested = new Set(req.allowedToolsOverride);
    config = {
      ...config,
      allowedTools: config.allowedTools.filter((tool) => requested.has(tool)),
    };
  }

  // Apply caller-supplied systemPrompt transform (e.g. Harness injecting git guardrails
  // into custom DB coders without mutating the stored agent record).
  // The transform receives the fully-resolved systemPrompt (RULES.md + agent.systemPrompt
  // + skills) and returns the final value used by the executor.
  if (req.systemPromptTransform !== undefined) {
    config = { ...config, systemPrompt: req.systemPromptTransform(config.systemPrompt) };
  }
  config = { ...config, systemPrompt: brandLionDesignText(config.systemPrompt) };

  const watchdog = createWatchdog(WATCHDOG_TIMEOUT_MS, (info) => {
    logger.warn(
      { agentId: req.agentId, runtime: config.runtime, ...info },
      'executeAgent: agent stalled — no progress for 3min',
    );
    req.onStalled?.(info);
  });

  // Inject watchdog wrapping into the callbacks so every progress signal resets it.
  // IMPORTANTE: todos os 4 sinais sao "prova de vida" do agente. Reasoning
  // (onThinking) e tool completion (onToolUseComplete) sao tao validos quanto
  // text/toolUse — sem wrappear esses dois, agentes que passam muito tempo
  // raciocinando ou executando tools longos sao mortos prematuramente. Ver
  // BUGFIXTESTESV1.md Bug #5.
  // NOTA: o codex-executor mapeia `onReasoning` (do bridge) -> `onThinking`
  // (canonical) pra que o reasoning do Codex tambem reset a watchdog aqui.
  const auditor = createExecutionAuditor(req);
  const wrappedReq: AgentExecutionRequest = {
    ...req,
    executionContext: withResolvedRootSubagentGrants(req.executionContext, config),
    prompt: brandLionDesignText(req.prompt),
    onText: watchdog.wrapOnText(req.onText),
    onThinking: watchdog.wrapOnThinking(req.onThinking),
    onToolUse: watchdog.wrapOnToolUse(req.onToolUse),
    // Auditoria V144: onToolUseComplete e o unico sinal que carrega o input do
    // tool, por isso a auditoria acopla aqui (e nao no onToolUse de inicio).
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
        // Exhaustiveness guard: if a new runtime is added to AgentConfig['runtime']
        // but not handled here, TypeScript will produce a compile error.
        const _exhaustive: never = config.runtime;
        throw new Error(`Runtime nao suportado: ${String(_exhaustive)}`);
      }
    }
  } catch (err) {
    // Auditoria V144: registra o erro terminal antes do enriquecimento/re-throw.
    // Nao altera o fluxo — auditError engole falhas proprias e ignora
    // PipelinePausedError (controle de fluxo).
    auditor.auditError(err);
    // SPEC robustez-chat SB-2 (P2, AC-B5) [INV]: catch de ENRIQUECIMENTO puro,
    // adicionado ANTES do finally existente. O caminho de sucesso e o despacho
    // (switch) sao byte-identicos ao baseline.
    //
    // Allowlist de re-throw CRU (obrigatoria, V4): erros de CONTROLE DE FLUXO
    // saem intocados — os `instanceof` a jusante (pipeline-engine/index.ts
    // :1083/:1108/:1315 e o retry do Pilar C) dependem disso. CADA termo tem o
    // SEU proprio `instanceof` (um `a instanceof X || Y` avalia ERRADO em JS).
    if (
      err instanceof CodexUnavailableError ||
      err instanceof CodexAuthError ||
      err instanceof KimiAuthError ||
      err instanceof PipelinePausedError ||
      err instanceof TypedProviderError ||
      // spec-gpt56 P1: erros ESTRUTURAIS do gate official-only e da validacao
      // de capabilities saem INTOCADOS — fora desta allowlist virariam
      // TypedProviderError e perderiam o `code` que os classificadores checam.
      err instanceof CodexCapabilityUnsupportedError
      || err instanceof GrokUnavailableError
      || err instanceof GrokAuthError
      || err instanceof GrokBackendError
      || err instanceof GrokCapabilityError
      || err instanceof GrokIsolationError
      || err instanceof GrokProcessError
      || err instanceof GrokToolPolicyError
    ) {
      throw err;
    }
    // So os erros CRUS restantes (HTTP/rede/vazio de cloud/compat/kimi/external)
    // viram TypedProviderError, com o erro original preservado em `cause`.
    throw translateProviderError(err, {
      runtime: config.runtime,
      model: config.model,
    });
  } finally {
    watchdog.stop();
  }
}
