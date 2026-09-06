
import { createLogger } from '../logger';
import { calculateCost, MODEL_PRICING } from '../pricing';
import {
  getAgent,
  getCodexWindowsPrepConsent,
  CODEX_PREP_VERSION_CURRENT,
} from '../db';
import { emitIPC } from '../pipeline-shared/ipc-emitter';
import { CodexAuthError, CodexUnavailableError } from '../codex-runtime/errors';
import type { CodexResponse } from '../codex-runtime/types';
import { resolveCodexSessionForRun } from './codex-session-factory';

import {
  getCodexSessionSignature,
  getCodexUsageSemantics,
  settleCodexBilledUsage,
} from './codex-session-signature';
import {
  countActionableIssues,
  detectCodexWindowsIssues,
  resolveGitRoot,
  runPrep,
  shouldSilenceWarning,
} from '../codex-windows-prep';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { RuntimeExecutor, AgentExecutionRequest, AgentExecutionResult } from './types';
import { codexTurnFailureError } from './llm-error';

const APPLY_PATCH_FAILURE_WARN_THRESHOLD = 3;

const sessionPreparedRepos = new Set<string>();

function runPreFlight(req: AgentExecutionRequest): void {
  if (process.platform !== 'win32') return;

  const repoRoot = resolveGitRoot(req.cwd);
  if (!repoRoot) return;

  let issues = detectCodexWindowsIssues(repoRoot);
  let actionableCount = countActionableIssues(issues);

  const consent = getCodexWindowsPrepConsent(repoRoot);
  let prepSucceededThisRun = false;
  if (
    consent &&
    consent.prepVersion >= CODEX_PREP_VERSION_CURRENT &&
    consent.action === 'prepared' &&
    !sessionPreparedRepos.has(repoRoot)
  ) {
    if (actionableCount === 0) {
      sessionPreparedRepos.add(repoRoot);
      logger.info(
        { projectId: req.projectId, repoRoot },
        'codex auto-prep skipped: no actionable issues remain',
      );
    } else {
      const result = runPrep(repoRoot);
      if (result.applied) {
        sessionPreparedRepos.add(repoRoot);
        prepSucceededThisRun = true;
        logger.info(
          { projectId: req.projectId, repoRoot, filesAffected: result.filesAffected },
          'codex auto-prep applied silently',
        );
      } else {
        logger.warn(
          { projectId: req.projectId, repoRoot, reason: result.reason },
          'codex auto-prep skipped',
        );
        emitIPC('codex:windows-prep-skipped', {
          projectId: req.projectId,
          repoRoot,
          reason: result.reason,
          timestamp: Date.now(),
        });
      }
    }
  }

  if (shouldSilenceWarning(repoRoot)) return;

  if (prepSucceededThisRun) {
    issues = detectCodexWindowsIssues(repoRoot);
    actionableCount = countActionableIssues(issues);
  }

  if (actionableCount === 0) return;

  emitIPC('codex:windows-health-warning', {
    projectId: req.projectId,
    agentId: req.agentId,
    cwd: req.cwd,
    repoRoot,
    timestamp: Date.now(),
    issues,
  });
  logger.warn(
    { projectId: req.projectId, repoRoot, actionableCount, totalIssues: issues.length },
    'codex windows pre-flight warning',
  );
}

export { CodexAuthError, CodexUnavailableError };

const logger = createLogger('codex-executor');

const CODEX_TERMINAL_GUARDRAILS = `## Regras de terminal Codex

- Prefira comandos nao interativos. Use flags/env para evitar prompts quando possivel.
- Se um comando exigir input interativo ou retornar erro pedindo tty=true, rerode uma unica vez com tty=true.
- Nao tente escrever stdin repetidamente em uma sessao fechada. Se o erro persistir, pare e explique o bloqueio.`;

const CODEX_WINDOWS_BLOCK = `## AMBIENTE WINDOWS PowerShell 5.1 - REGRAS OBRIGATORIAS

Voce esta rodando via PowerShell 5.1 (Windows). Default encoding e CP-1252 e CORROMPE arquivos UTF-8 sem BOM (acentos viram mojibake).

### Leitura de arquivos de codigo

PROIBIDO (corrompe acentos):
- Get-Content arquivo
- Get-Content arquivo -Raw
- type arquivo
- cat arquivo

OBRIGATORIO (preserva UTF-8):
1. node -e "process.stdout.write(require('fs').readFileSync('arquivo','utf8'))"
2. Get-Content arquivo -Raw -Encoding UTF8

Use a opcao 1 sempre que possivel - e independente de codepage do shell.

### Sinais de mojibake

Se voce ver no output: Ã§ Ã£ Ã© Ã­ Ã³ Ãº - leitura esta corrompida.
Arquivo real tem: c-cedilha a-til e-agudo i-agudo o-agudo u-agudo.

NAO use texto corrompido em apply_patch - match falha por bytes diferentes.

### Recovery de apply_patch failure

Se apply_patch retornar "Failed to find expected lines":
1. Releia o arquivo com node -e ... ou Get-Content -Raw -Encoding UTF8
2. Compare caracteres acentuados entre as duas leituras
3. Se viu Ã na primeira: era mojibake - reconstrua o patch a partir da leitura correta
4. NAO retente o mesmo patch - vai falhar igual`;

function appendCodexTerminalGuardrails(systemPrompt: string): string {
  let result = systemPrompt;

  if (!result.includes('## Regras de terminal Codex')) {
    result = `${result.trim()}\n\n${CODEX_TERMINAL_GUARDRAILS}`.trim();
  }

  if (process.platform === 'win32' && !result.includes('## AMBIENTE WINDOWS PowerShell 5.1')) {
    result = `${result.trim()}\n\n${CODEX_WINDOWS_BLOCK}`.trim();
  }

  return result;
}

async function run(
  req: AgentExecutionRequest,
  config: AgentQueryConfig,
): Promise<AgentExecutionResult> {
  const agent = getAgent(req.agentId);
  if (!agent) {
    throw new Error(`Agent ${req.agentId} not found`);
  }
  if (!agent.codexConfig) {
    throw new Error(`Agent ${req.agentId} runtime=codex but no codexConfig`);
  }

  const startedAt = Date.now();

  let session = req.codexSession ?? null;
  let shouldClose = false;
  let isContinuation = session !== null;

  const requestedEffort =
    req.inheritedEffort !== undefined
      ? req.inheritedEffort.codex
      : agent.codexConfig.reasoningEffort;

  if (session) {
    const sig = getCodexSessionSignature(session);
    if (sig) {
      const stale =
        sig.model !== agent.codexConfig.model ||
        sig.requestedEffort !== (requestedEffort as string | undefined);
      if (stale) {
        logger.warn(
          {
            agentId: req.agentId,
            sessionModel: sig.model,
            requestedModel: agent.codexConfig.model,
          },
          'codex cached session signature is stale; closing and recreating via factory (spec-gpt56)',
        );
        try {
          session.close();
        } catch {
        }
        session = null;
        isContinuation = false;
      }
    }
  }

  if (!session) {
    runPreFlight(req);

    session = await resolveCodexSessionForRun({
      surface: req.onCodexSessionCreated ? 'pipeline' : 'agent-scoped',
      mcpProfile: req.onCodexSessionCreated ? 'pipeline' : 'agent-scoped',
      reasoningEffortOverride: requestedEffort,
      sessionOptions: {
        model: agent.codexConfig.model,
        cwd: req.cwd,
        systemPrompt: appendCodexTerminalGuardrails(config.systemPrompt),
        approvalPolicy: 'never',
        sandbox: agent.codexConfig.sandbox ?? 'workspace-write',
        reasoningEffort: requestedEffort,
        timeoutMs: 7_200_000,
        projectId: req.projectId,
      },
    });
    req.onCodexSessionCreated?.(session);
    shouldClose = !req.onCodexSessionCreated;
  }

  const activeSession = session;

  try {
    const callbacks = {
      onText: req.onText,
      onReasoning: req.onThinking,
      onToolUse: req.onToolUse,
      onToolUseComplete: req.onToolUseComplete,
      onActivity: req.onActivity,
    };
    const response: CodexResponse = isContinuation
      ? await activeSession.reply(req.prompt, callbacks, req.abortController.signal)
      : await activeSession.send(req.prompt, callbacks, req.abortController.signal);


    if (response.status === 'failed' || response.status === 'timeout') {
      logger.warn(
        {
          agentId: req.agentId,
          model: agent.codexConfig.model,
          status: response.status,
          errorCode: response.errorCode,
        },
        'Codex turn resolved as failure; surfacing classified error (SB-4 P6)',
      );
      throw codexTurnFailureError({
        status: response.status,
        ...(response.errorCode !== undefined ? { errorCode: response.errorCode } : {}),
        model: agent.codexConfig.model,
        ...(response.content ? { detail: response.content } : {}),
      });
    }

    const durationMs = Date.now() - startedAt;

    const usageSemantics = getCodexUsageSemantics(activeSession);
    const billedUsage =
      usageSemantics === 'thread-cumulative'
        ? settleCodexBilledUsage(activeSession, response.usage)
        : response.usage;

    const costUsd = calculateCost(
      agent.codexConfig.model,
      billedUsage.inputTokens,
      billedUsage.outputTokens,
      billedUsage.cachedInputTokens,
      0,
    );

    logger.info(
      {
        agentId: req.agentId,
        model: agent.codexConfig.model,
        inputTokens: billedUsage.inputTokens,
        outputTokens: billedUsage.outputTokens,
        usageSemantics,
        costUsd,
        costEstimatedPartial:
          (MODEL_PRICING[agent.codexConfig.model.trim().toLowerCase()]?.cacheCreation ?? 0) > 0 ||
          (() => {
            const lc = MODEL_PRICING[agent.codexConfig.model.trim().toLowerCase()]?.longContext;
            return lc !== undefined && billedUsage.inputTokens > lc.thresholdTokens;
          })(),
        durationMs,
        filesChanged: response.filesChanged.length,
        commandsRun: response.commandsRun.length,
        sessionReused: isContinuation,
        applyPatchFailures: response.applyPatchFailures,
      },
      'Codex executor finished',
    );

    if (response.applyPatchFailures >= APPLY_PATCH_FAILURE_WARN_THRESHOLD) {
      emitIPC('codex:patch-failure-warning', {
        projectId: req.projectId,
        agentId: req.agentId,
        cwd: req.cwd,
        count: response.applyPatchFailures,
        samples: response.applyPatchFailureSamples,
        timestamp: Date.now(),
      });
      logger.warn(
        {
          projectId: req.projectId,
          agentId: req.agentId,
          count: response.applyPatchFailures,
        },
        'codex apply_patch failures reached warn threshold',
      );
    }

    return {
      output: response.content,
      metrics: {
        inputTokens: billedUsage.inputTokens,
        outputTokens: billedUsage.outputTokens,
        cacheReadTokens: billedUsage.cachedInputTokens,
        cacheCreationTokens: 0,
        toolUses: response.commandsRun.length + response.filesChanged.length,
        apiRequests: 1,
        costUsd,
        durationMs,
      },
      model: agent.codexConfig.model,
      runtime: 'codex',
      provider: 'openai-codex',
      metadata: {
        codex: {
          applyPatchFailures: response.applyPatchFailures,
          applyPatchFailureSamples: response.applyPatchFailureSamples,
        },
      },
    };
  } finally {
    if (shouldClose) {
      activeSession.close();
    }
  }
}

export const codexExecutor: RuntimeExecutor = { run };
