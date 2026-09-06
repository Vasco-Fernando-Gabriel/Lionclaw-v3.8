import { ipcMain, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../logger';
import type { IpcContext } from './context';
import {
  insertEnrichSession,
  getEnrichSession,
  listEnrichSessions,
  getEnrichMessages,
  deleteEnrichSession,
  getTaskExecutionRollup,
} from '../db';
import type { EnrichSessionRow, TaskExecutionRollup } from '../db';
import type { EnrichMetrics, EnrichSession } from '../../../src/types';

const logger = createLogger('ipc');

const COST_STATUS_RANK = { known: 0, 'estimated-partial': 1, unknown: 2 } as const;

export function mergeTaskExecutionMetrics(
  metrics: EnrichMetrics,
  rollup: TaskExecutionRollup,
): EnrichMetrics {
  const costStatus = rollup.costStatus
    && COST_STATUS_RANK[rollup.costStatus] > COST_STATUS_RANK[metrics.costStatus ?? 'known']
    ? rollup.costStatus
    : metrics.costStatus;
  const tokenStatus = metrics.tokenStatus === 'not_reported' || rollup.tokenStatus === 'not_reported'
    ? 'not_reported'
    : metrics.tokenStatus;
  const childSubscriptionEquivalentCost = rollup.usageMetadata.pricingProvenance
    .filter((entry) => entry.costEstimationKind === 'subscription-equivalent-payg')
    .reduce((sum, entry) => sum + entry.costUsd, 0);
  const totalCost = metrics.costUsd + rollup.metrics.costUsd;
  const subscriptionEquivalentCost = Math.min(totalCost, Math.max(
    0,
    (metrics.costEstimationKind === 'subscription-equivalent-payg' ? metrics.costUsd : 0)
      + childSubscriptionEquivalentCost,
  ));
  const entireCostIsSubscriptionEquivalent = totalCost > 0
    && Math.abs(totalCost - subscriptionEquivalentCost) <= 1e-9;
  return {
    ...metrics,
    inputTokens: metrics.inputTokens + rollup.metrics.inputTokens,
    outputTokens: metrics.outputTokens + rollup.metrics.outputTokens,
    cacheReadTokens: metrics.cacheReadTokens + rollup.metrics.cacheReadTokens,
    cacheCreationTokens: metrics.cacheCreationTokens + rollup.metrics.cacheCreationTokens,
    costUsd: totalCost,
    durationMs: metrics.durationMs + rollup.metrics.durationMs,
    toolUses: metrics.toolUses + rollup.metrics.toolUses,
    apiRequests: metrics.apiRequests + rollup.metrics.apiRequests,
    ...(costStatus ? { costStatus } : {}),
    ...(tokenStatus ? { tokenStatus } : {}),
    ...(!metrics.costUnknownReason && rollup.costUnknownReasons[0]
      ? { costUnknownReason: rollup.costUnknownReasons[0] }
      : {}),
    unknownCostCount: (metrics.unknownCostCount ?? 0) + rollup.unknownCostCount,
    costEstimationKind: entireCostIsSubscriptionEquivalent
      ? 'subscription-equivalent-payg'
      : undefined,
    costByRuntime: rollup.costByRuntime,
    subscriptionEquivalentCost,
  };
}

function mapEnrichSessionRowToApi(row: EnrichSessionRow): EnrichSession {
  const validatorSubagents = getTaskExecutionRollup({
    ownerKind: 'enrich',
    ownerId: row.id,
    surface: 'enrich:validator',
    executionKinds: ['subagent'],
  });
  const enricherSubagents = getTaskExecutionRollup({
    ownerKind: 'enrich',
    ownerId: row.id,
    surface: 'enrich:enricher',
    executionKinds: ['subagent'],
  });
  return {
    id: row.id,
    name: row.name,
    specPath: row.specPath,
    projectPath: row.projectPath ?? undefined,
    prdPath: row.prdPath ?? undefined,
    userMessage: row.userMessage ?? undefined,
    validatorAgentId: row.validatorAgentId,
    enricherAgentId: row.enricherAgentId,
    phase: row.phase,
    status: row.status,
    finalSpecPath: row.finalSpecPath ?? undefined,
    validatorMetrics: mergeTaskExecutionMetrics({
      inputTokens: row.validatorInputTokens,
      outputTokens: row.validatorOutputTokens,
      cacheReadTokens: row.validatorCacheReadTokens,
      cacheCreationTokens: row.validatorCacheCreationTokens,
      costUsd: row.validatorCostUsd,
      durationMs: row.validatorDurationMs,
      toolUses: row.validatorToolUses,
      apiRequests: row.validatorApiRequests,
      messages: row.validatorMessages,
      costStatus: row.validatorCostStatus,
      tokenStatus: row.validatorTokenStatus,
      ...(row.validatorCostUnknownReason ? { costUnknownReason: row.validatorCostUnknownReason } : {}),
      ...(row.validatorCostSource ? { costSource: row.validatorCostSource } : {}),
      ...(row.validatorCostEstimationKind ? { costEstimationKind: row.validatorCostEstimationKind } : {}),
      unknownCostCount: row.validatorUnknownCostCount,
      ...(row.validatorUsageMetadata ? { usageMetadata: row.validatorUsageMetadata } : {}),
    }, validatorSubagents),
    enricherMetrics: mergeTaskExecutionMetrics({
      inputTokens: row.enricherInputTokens,
      outputTokens: row.enricherOutputTokens,
      cacheReadTokens: row.enricherCacheReadTokens,
      cacheCreationTokens: row.enricherCacheCreationTokens,
      costUsd: row.enricherCostUsd,
      durationMs: row.enricherDurationMs,
      toolUses: row.enricherToolUses,
      apiRequests: row.enricherApiRequests,
      messages: row.enricherMessages,
      costStatus: row.enricherCostStatus,
      tokenStatus: row.enricherTokenStatus,
      ...(row.enricherCostUnknownReason ? { costUnknownReason: row.enricherCostUnknownReason } : {}),
      ...(row.enricherCostSource ? { costSource: row.enricherCostSource } : {}),
      ...(row.enricherCostEstimationKind ? { costEstimationKind: row.enricherCostEstimationKind } : {}),
      unknownCostCount: row.enricherUnknownCostCount,
      ...(row.enricherUsageMetadata ? { usageMetadata: row.enricherUsageMetadata } : {}),
    }, enricherSubagents),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function registerEnrichHandlers(ctx: IpcContext): void {
  const { getHarnessEngine } = ctx;


  ipcMain.handle(
    'enrich:start',
    async (
      _event,
      config: {
        name: string;
        specPath: string;
        projectPath?: string;
        prdPath?: string;
        message?: string;
        validatorAgentId: string;
      },
    ) => {
      if (!config || typeof config.name !== 'string' || !config.name.trim()) {
        return { error: 'Campo name e obrigatorio' };
      }
      if (typeof config.specPath !== 'string' || !config.specPath.trim()) {
        return { error: 'Campo specPath e obrigatorio' };
      }
      if (
        typeof config.validatorAgentId !== 'string' ||
        !config.validatorAgentId.trim()
      ) {
        return { error: 'Campo validatorAgentId e obrigatorio' };
      }
      if (!fs.existsSync(config.specPath)) {
        return { error: `Arquivo de spec nao encontrado: ${config.specPath}` };
      }

      const engine = getHarnessEngine();
      if (!engine) {
        logger.error(
          {},
          'HarnessEngine not initialized - cannot start enrich session',
        );
        return { error: 'HarnessEngine nao inicializado' };
      }

      if (engine.hasActiveEnrichSession()) {
        logger.warn(
          { name: config.name },
          'Enrich start rejected: another session already active',
        );
        return {
          error: 'already_active',
          message:
            'Ja existe uma sessao de enrich ativa. Finalize ou aborte a sessao atual antes de iniciar uma nova.',
        };
      }

      const sessionId = crypto.randomUUID();

      try {
        const session = insertEnrichSession({
          id: sessionId,
          name: config.name.trim(),
          specPath: config.specPath,
          projectPath: config.projectPath,
          prdPath: config.prdPath,
          userMessage: config.message,
          validatorAgentId: config.validatorAgentId,
        });
        logger.info(
          { sessionId, name: config.name },
          'Enrich session created - launching engine',
        );

        engine
          .startEnrichSession({
            sessionId: session.id,
            name: config.name.trim(),
            specPath: config.specPath,
            projectPath: config.projectPath,
            prdPath: config.prdPath,
            message: config.message,
            validatorAgentId: config.validatorAgentId,
          })
          .catch((err) => {
            logger.error({ err, sessionId }, 'Enrich session failed');
          });

        return { sessionId: session.id };
      } catch (err) {
        logger.error({ err, config }, 'Failed to create enrich session');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'enrich:send',
    async (_event, args: { sessionId: string; message: string }) => {
      if (
        !args ||
        typeof args.sessionId !== 'string' ||
        !args.sessionId.trim()
      ) {
        return { error: 'Campo sessionId e obrigatorio' };
      }
      if (typeof args.message !== 'string' || !args.message.trim()) {
        return { error: 'Campo message e obrigatorio' };
      }

      const session = getEnrichSession(args.sessionId);
      if (!session) {
        return { error: `Sessao enrich nao encontrada: ${args.sessionId}` };
      }

      const engine = getHarnessEngine();
      if (!engine) {
        return { error: 'HarnessEngine nao inicializado' };
      }

      logger.info(
        { sessionId: args.sessionId, messageLen: args.message.length },
        'Enrich message received',
      );

      engine.sendEnrichMessage(args.sessionId, args.message).catch((err) => {
        logger.error(
          { err, sessionId: args.sessionId },
          'Enrich sendMessage failed',
        );
      });

      return { ok: true };
    },
  );

  ipcMain.handle(
    'enrich:approve-phase',
    async (_event, args: { sessionId: string }) => {
      if (
        !args ||
        typeof args.sessionId !== 'string' ||
        !args.sessionId.trim()
      ) {
        return { error: 'Campo sessionId e obrigatorio' };
      }

      const session = getEnrichSession(args.sessionId);
      if (!session) {
        return { error: `Sessao enrich nao encontrada: ${args.sessionId}` };
      }
      if (session.phase !== 'validator') {
        return {
          error: `Fase invalida para aprovacao. Fase atual: ${session.phase}`,
        };
      }

      const engine = getHarnessEngine();
      if (!engine) {
        return { error: 'HarnessEngine nao inicializado' };
      }

      logger.info(
        { sessionId: args.sessionId },
        'Enrich phase approved - transitioning to enricher',
      );

      engine.approveEnrichPhase(args.sessionId).catch((err) => {
        logger.error(
          { err, sessionId: args.sessionId },
          'Enrich approvePhase failed',
        );
      });

      return { ok: true };
    },
  );

  ipcMain.handle(
    'enrich:resume-after-auth',
    async (_event, args: { sessionId: string; provider?: 'grok' | 'codex' | 'kimi' }) => {
      if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim()) {
        return { error: 'Campo sessionId e obrigatorio' };
      }
      const engine = getHarnessEngine();
      if (!engine) return { error: 'HarnessEngine nao inicializado' };
      try {
        await engine.resumeEnrichAfterAuth(args.sessionId, args.provider);
        return { ok: true };
      } catch (error) {
        logger.error({ err: error, sessionId: args.sessionId }, 'Enrich auth resume failed');
        return { error: (error as Error).message };
      }
    },
  );

  ipcMain.handle(
    'enrich:finalize',
    async (_event, args: { sessionId: string }) => {
      if (
        !args ||
        typeof args.sessionId !== 'string' ||
        !args.sessionId.trim()
      ) {
        return { error: 'Campo sessionId e obrigatorio' };
      }

      const session = getEnrichSession(args.sessionId);
      if (!session) {
        return { error: `Sessao enrich nao encontrada: ${args.sessionId}` };
      }
      if (session.phase !== 'enricher') {
        return {
          error: `Fase invalida para finalizacao. Fase atual: ${session.phase}`,
        };
      }

      const engine = getHarnessEngine();
      if (!engine) {
        return { error: 'HarnessEngine nao inicializado' };
      }

      logger.info({ sessionId: args.sessionId }, 'Enrich finalize requested');

      try {
        const finalSpecPath = engine.finalizeEnrichSession(args.sessionId);
        logger.info(
          { sessionId: args.sessionId, finalSpecPath },
          'Enrich session finalized',
        );
        return { ok: true, finalSpecPath };
      } catch (err) {
        logger.error(
          { err, sessionId: args.sessionId },
          'Enrich finalize failed',
        );
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle('enrich:get-spec', (_event, args: { sessionId: string }) => {
    if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim()) {
      return { error: 'Campo sessionId e obrigatorio' };
    }

    const session = getEnrichSession(args.sessionId);
    if (!session) {
      return { error: `Sessao enrich nao encontrada: ${args.sessionId}` };
    }

    return { finalSpecPath: session.finalSpecPath };
  });

  ipcMain.handle('enrich:list-sessions', () => {
    return listEnrichSessions().map(mapEnrichSessionRowToApi);
  });

  ipcMain.handle(
    'enrich:abort',
    async (_event, args: { sessionId: string }) => {
      if (!args?.sessionId) {
        return { error: 'sessionId obrigatorio' };
      }
      const engine = getHarnessEngine();
      if (!engine) {
        return { error: 'Engine nao inicializada' };
      }
      try {
        engine.abortEnrichSession(args.sessionId);
        logger.info(
          { sessionId: args.sessionId },
          'Enrich session aborted via IPC',
        );
        return { ok: true as const };
      } catch (err) {
        logger.error(
          { err, sessionId: args.sessionId },
          'Failed to abort enrich session',
        );
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'enrich:delete',
    async (_event, args: { sessionId: string }) => {
      if (!args?.sessionId) {
        return { error: 'sessionId obrigatorio' };
      }
      const engine = getHarnessEngine();
      if (engine) {
        try {
          engine.abortEnrichSession(args.sessionId);
        } catch {
        }
      }
      try {
        deleteEnrichSession(args.sessionId);
        logger.info({ sessionId: args.sessionId }, 'Enrich session deleted');
        return { ok: true as const };
      } catch (err) {
        logger.error(
          { err, sessionId: args.sessionId },
          'Failed to delete enrich session',
        );
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'enrich:open-spec',
    async (_event, args: { sessionId: string }) => {
      if (!args?.sessionId) {
        return { error: 'sessionId obrigatorio' };
      }
      const session = getEnrichSession(args.sessionId);
      if (!session) {
        return { error: 'Sessao nao encontrada' };
      }
      const targetPath = session.finalSpecPath || session.specPath;
      const resolved = path.resolve(targetPath);
      if (!fs.existsSync(resolved)) {
        return { error: 'Arquivo nao encontrado' };
      }
      shell.showItemInFolder(resolved);
      return { ok: true };
    },
  );

  ipcMain.handle(
    'enrich:get-messages',
    (_event, args: { sessionId: string; phase?: string }) => {
      if (
        !args ||
        typeof args.sessionId !== 'string' ||
        !args.sessionId.trim()
      ) {
        return { error: 'Campo sessionId e obrigatorio' };
      }
      return getEnrichMessages(args.sessionId, args.phase);
    },
  );
}
