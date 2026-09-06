import { ipcMain, shell } from 'electron';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from '../logger';
import {
  listDynamicWorkflowRuns,
  getDynamicWorkflowRun,
  listDynamicWorkflowNodes,
  listDynamicWorkflowEvents,
  listDynamicWorkflowRecentEvents,
  listDynamicWorkflowArtifacts,
  getDynamicWorkflowDefinition,
  createDynamicWorkflowDefinition,
  updateDynamicWorkflowDefinition,
  updateDynamicWorkflowRun,
  insertDynamicWorkflowEvent,
  insertDynamicWorkflowMessage,
  listDynamicWorkflowMessages,
  deleteDynamicWorkflowRun,
  getDynamicWorkflowRunCostAggregate,
  listDynamicWorkflowNodeRuns,
  listDynamicWorkflowGateDecisions,
  listDynamicWorkflowSprints,
  listDynamicWorkflowJournalEntries,
  getAllAgents,
} from '../db';
import { emitIPC } from '../pipeline-shared/ipc-emitter';
import { releaseProjectLock } from '../pipeline-shared/lock';
import { broadcastWorkflowStreamChunk } from '../dynamic-workflows/workflow-events';
import { initWorkflowActivityBridge } from '../dynamic-workflows/workflow-activity';
import { initWorkflowIgnitionBridge } from '../dynamic-workflows/workflow-ignition';
import {
  openCloserSession,
  sendCloserMessage,
  type CloserEngineDeps,
  type CloserSpawnContext,
  type CloserSpawnReason,
} from '../dynamic-workflows/workflow-closer';
import type {
  CloserGitAuditEvent,
  CloserGitConfirmRequest,
} from '../dynamic-workflows/closer-permission-guard';
import {
  createDefaultRunnerDeps,
  realCloserAgentTurn,
  makeRealCloserAgentTurn,
  closerGuardToSdkCanUseTool,
  type RealClaudeCompatBackendDeps,
} from '../dynamic-workflows/workflow-runner-deps';
import type { IpcContext } from './context';
import type {
  DynamicWorkflowRun,
  DynamicWorkflowNode,
  DynamicWorkflowEvent,
  DynamicWorkflowEventsQuery,
  DynamicWorkflowArtifact,
  DynamicWorkflowAgentSummary,
  DynamicWorkflowManifest,
  DynamicWorkflowDefinition,
  DynamicWorkflowDefinitionCreateInput,
  DynamicWorkflowMessage,
  DynamicWorkflowStreamChunk,
  DynamicWorkflowIntervention,
  DynamicWorkflowReplanRequest,
  DynamicWorkflowGateDecisionInput,
  DynamicWorkflowOkResult,
  DynamicWorkflowValidateResult,
  DynamicWorkflowReplanResult,
  DynamicWorkflowSnapshotResult,
  DynamicWorkflowResumeOptions,
} from '../dynamic-workflows/types';
import { runDirFor } from '../dynamic-workflows/workflow-create';
import { listRunBundle } from '../dynamic-workflows/run-bundle';
import type { RunBundleEntry } from '../../../src/types/dynamic-workflow-cockpit';
import { validateWorkflowPackage } from '../dynamic-workflows/workflow-validator';
import {
  WorkflowRunner,
  getWorkflowRunner,
} from '../dynamic-workflows/workflow-runner';
import { resolveAgentQueryConfig } from '../agent-config-resolver';
import {
  resolveSwitchAgentVerdict,
  makePersistSwitchedDefinition,
} from '../dynamic-workflows/switch-agent-validation';
import type { DynamicWorkflowManifest as DwManifest } from '../dynamic-workflows/types';

const logger = createLogger('dynamic-workflow-ipc');

export {
  makeRealCloserAgentTurn,
  closerGuardToSdkCanUseTool,
  type RealClaudeCompatBackendDeps,
};

function getRunner(): WorkflowRunner {
  return getWorkflowRunner(createDefaultRunnerDeps());
}


function loadAgentCatalogSnapshot(): DynamicWorkflowAgentSummary[] {
  return getAllAgents()
    .filter((a) => a.isActive)
    .map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      runtime: a.runtime,
      model: a.model,
      skills: a.skills,
      mcpServers: a.mcpServers,
    }));
}

function listSchemaFiles(runDir: string): string[] {
  const schemasDir = join(runDir, 'schemas');
  if (!existsSync(schemasDir)) return [];
  try {
    return readdirSync(schemasDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}


function buildCloserDeps(): CloserEngineDeps {
  return {
    getRun: getDynamicWorkflowRun,
    updateRun: updateDynamicWorkflowRun,
    insertMessage: insertDynamicWorkflowMessage,
    listMessages: listDynamicWorkflowMessages,
    recentEvents: listDynamicWorkflowRecentEvents,
    costAggregate: getDynamicWorkflowRunCostAggregate,
    runAgentTurn: realCloserAgentTurn,
    confirmGitWrite: (req) => confirmCloserGitWrite(req),
    auditGit: (event) => auditCloserGit(event),
    emitEvent: ({ runId, type, payload }) => {
      try {
        insertDynamicWorkflowEvent({
          runId,
          type,
          payloadJson: JSON.stringify(payload ?? {}),
        });
      } catch (err) {
        logger.warn({ err, runId, type }, 'closer emitEvent falhou (ignorado)');
      }
    },
    releaseRunLock: (runId) => releaseProjectLock(runId),
  };
}

function auditCloserGit(event: CloserGitAuditEvent): void {
  try {
    insertDynamicWorkflowEvent({
      runId: event.runId,
      type: `closer-git-${event.decision}`,
      payloadJson: JSON.stringify(event),
    });
  } catch (err) {
    logger.warn({ err, runId: event.runId }, 'closer auditGit (persist) falhou (ignorado)');
  }
  try {
    broadcastWorkflowStreamChunk(
      { emit: emitIPC },
      {
        runId: event.runId,
        kind: 'runner',
        type: 'text',
        content: `git ${event.subcommand}: ${event.decision === 'approved' ? 'aprovado' : 'negado'} (${event.reason})`,
      },
    );
  } catch (err) {
    logger.warn({ err, runId: event.runId }, 'closer auditGit (broadcast) falhou (ignorado)');
  }
}

function confirmCloserGitWrite(req: CloserGitConfirmRequest): boolean {
  try {
    insertDynamicWorkflowEvent({
      runId: req.runId,
      type: 'closer-git-confirm-requested',
      payloadJson: JSON.stringify(req),
    });
    broadcastWorkflowStreamChunk(
      { emit: emitIPC },
      {
        runId: req.runId,
        kind: 'runner',
        type: 'text',
        content: `git ${req.subcommand} pediu confirmacao inline (em ${req.cwd}); aguardando habilitacao do round-trip de aprovacao.`,
      },
    );
  } catch (err) {
    logger.warn({ err, runId: req.runId }, 'closer confirmGitWrite (emit) falhou (ignorado)');
  }
  return false;
}

function resolveRepoRootForRun(run: DynamicWorkflowRun): string {
  const def = getDynamicWorkflowDefinition(run.definitionId);
  return def?.projectPath ?? '';
}

const MERGE_FRICTION_EVENT_TYPES = new Set<string>([
  'merge-conflict',
  'merge-recheck-failed',
]);

export function closerReasonFromState(
  run: DynamicWorkflowRun,
  recentEvents: DynamicWorkflowEvent[],
): CloserSpawnReason {
  if (run.status === 'delivered') return 'delivery';

  const inFriction =
    run.status === 'blocked' ||
    run.status === 'failed' ||
    run.status === 'interrupted';
  const liveWorktree =
    run.workspaceMode === 'run-worktree' && !!run.worktreePath;
  const hasMergeConflictSignal = recentEvents.some((ev) =>
    MERGE_FRICTION_EVENT_TYPES.has(ev.type),
  );

  if (inFriction && liveWorktree && hasMergeConflictSignal) {
    return 'merge-conflict';
  }
  return 'user-request';
}

function closerReasonForRun(run: DynamicWorkflowRun): CloserSpawnReason {
  if (run.status === 'delivered') return 'delivery';
  let recentEvents: DynamicWorkflowEvent[] = [];
  try {
    recentEvents = listDynamicWorkflowRecentEvents(run.id, 20);
  } catch (err) {
    logger.warn({ err, runId: run.id }, 'closerReasonForRun: leitura de eventos falhou (degrada para user-request)');
  }
  return closerReasonFromState(run, recentEvents);
}

function broadcastCloserMessage(runId: string, message: DynamicWorkflowMessage): void {
  const chunk: DynamicWorkflowStreamChunk = {
    kind: 'closer',
    runId,
    type: 'text',
    content: message.content,
  };
  broadcastWorkflowStreamChunk({ emit: emitIPC }, chunk);
}


export function buildReplanLinkage(
  prevDef: DynamicWorkflowDefinition,
  newDefinitionId: string,
): {
  newDefInput: DynamicWorkflowDefinitionCreateInput;
  prevDefPatch: { supersedesDefinitionId: string };
} {
  const newDefInput: DynamicWorkflowDefinitionCreateInput = {
    id: newDefinitionId,
    name: prevDef.name,
    definitionVersion: prevDef.definitionVersion + 1,
    parentDefinitionId: prevDef.id,
    supersedesDefinitionId: null,
    sourceType: prevDef.sourceType,
    projectPath: prevDef.projectPath,
    specPath: prevDef.specPath,
    specSha256: prevDef.specSha256,
    workflowJsPath: prevDef.workflowJsPath,
    manifestPath: prevDef.manifestPath,
    manifestJson: prevDef.manifestJson,
    manifestHash: prevDef.manifestHash,
    contextBundlePath: prevDef.contextBundlePath,
    builderModel: prevDef.builderModel,
    status: prevDef.status,
  };
  return { newDefInput, prevDefPatch: { supersedesDefinitionId: newDefinitionId } };
}


const persistSwitchedDefinitionReal = makePersistSwitchedDefinition({
  createDefinition: createDynamicWorkflowDefinition,
  updateDefinition: updateDynamicWorkflowDefinition,
});

async function handleSwitchAgentIntervention(
  runId: string,
  intervention: Extract<DynamicWorkflowIntervention, { type: 'switch-agent' }>,
): Promise<DynamicWorkflowOkResult> {
  const { nodeId, newAgentId, reason } = intervention;
  const run = getDynamicWorkflowRun(runId);
  if (!run) return { error: `run nao encontrado: ${runId}` };
  const definition = getDynamicWorkflowDefinition(run.definitionId);
  if (!definition) return { error: `definition nao encontrada: ${run.definitionId}` };

  let manifest: DwManifest;
  try {
    manifest = JSON.parse(definition.manifestJson) as DwManifest;
  } catch (err) {
    return { error: `manifest invalido: ${(err as Error).message}` };
  }
  const node = (manifest.nodes ?? []).find((n) => n.id === nodeId);
  if (!node) return { error: `node ${nodeId} nao existe no manifest` };

  const validation = await resolveSwitchAgentVerdict(node, newAgentId, {
    resolveAgent: resolveAgentQueryConfig,
    loadActiveAgentIds: () => loadAgentCatalogSnapshot().map((a) => a.id),
  });

  return getRunner().switchAgent(runId, nodeId, newAgentId, reason, 'human', {
    validateSwitchAgent: () => validation,
    persistSwitchedDefinition: persistSwitchedDefinitionReal,
  });
}

export function registerDynamicWorkflowHandlers(ctx: IpcContext): void {
  initWorkflowActivityBridge(ctx.getMainWindow);

  initWorkflowIgnitionBridge(ctx.getMainWindow, {
    pause: async (runId) => {
      await getRunner().pause(runId);
    },
  });


  ipcMain.handle('dynamic-workflow:list-runs', (): DynamicWorkflowRun[] => {
    try {
      return listDynamicWorkflowRuns();
    } catch (err) {
      logger.error({ err }, 'dynamic-workflow:list-runs failed');
      return [];
    }
  });

  ipcMain.handle(
    'dynamic-workflow:get-run',
    (_event, runId: string): DynamicWorkflowRun | null => {
      try {
        const run = getDynamicWorkflowRun(runId);
        if (!run) return null;
        const def = getDynamicWorkflowDefinition(run.definitionId);
        const p = def?.projectPath;
        const projectPath = p && p.trim() ? p : null;
        return { ...run, projectPath };
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:get-run failed');
        return null;
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:get-nodes',
    (_event, runId: string): DynamicWorkflowNode[] => {
      try {
        const run = getDynamicWorkflowRun(runId);
        if (!run) return [];
        return listDynamicWorkflowNodes(run.definitionId);
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:get-nodes failed');
        return [];
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:get-events',
    (_event, runId: string, opts?: DynamicWorkflowEventsQuery): DynamicWorkflowEvent[] => {
      try {
        if (!opts || typeof opts !== 'object') {
          return listDynamicWorkflowRecentEvents(runId, 1000);
        }
        return listDynamicWorkflowEvents(runId, {
          ...(typeof opts.afterSeq === 'number' ? { afterSeq: opts.afterSeq } : {}),
          ...(typeof opts.beforeSeq === 'number' ? { beforeSeq: opts.beforeSeq } : {}),
          ...(typeof opts.limit === 'number' ? { limit: opts.limit } : {}),
          ...(Array.isArray(opts.types) ? { types: opts.types } : {}),
        });
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:get-events failed');
        return [];
      }
    },
  );

  const resolveRunDirForIpc = (runId: unknown): { runDir: string } | { error: string } => {
    if (typeof runId !== 'string' || !runId.trim()) return { error: 'runId obrigatorio' };
    const run = getDynamicWorkflowRun(runId);
    if (!run) return { error: `run nao encontrado: ${runId}` };
    const definition = getDynamicWorkflowDefinition(run.definitionId);
    if (!definition?.projectPath?.trim()) {
      return { error: `run ${runId} sem projectPath na definition; pasta do run nao resolvida` };
    }
    const runDir = runDirFor(definition.projectPath, runId);
    if (!existsSync(runDir)) return { error: `pasta do run nao existe: ${runDir}` };
    return { runDir };
  };

  ipcMain.handle(
    'dynamic-workflow:get-run-bundle',
    (_event, runId: string): RunBundleEntry[] | { error: string } => {
      try {
        const resolved = resolveRunDirForIpc(runId);
        if ('error' in resolved) return resolved;
        return listRunBundle(resolved.runDir);
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:get-run-bundle failed');
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:open-run-dir',
    async (_event, runId: string): Promise<{ ok: true } | { error: string }> => {
      try {
        const resolved = resolveRunDirForIpc(runId);
        if ('error' in resolved) return resolved;
        const failure = await shell.openPath(resolved.runDir);
        if (failure) return { error: failure };
        return { ok: true };
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:open-run-dir failed');
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:get-artifacts',
    (_event, runId: string): DynamicWorkflowArtifact[] => {
      try {
        return listDynamicWorkflowArtifacts(runId);
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:get-artifacts failed');
        return [];
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:get-messages',
    (_event, runId: string): DynamicWorkflowMessage[] => {
      try {
        return listDynamicWorkflowMessages(runId);
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:get-messages failed');
        return [];
      }
    },
  );


  ipcMain.handle(
    'dynamic-workflow:validate',
    (_event, runId: string): DynamicWorkflowValidateResult => {
      try {
        const run = getDynamicWorkflowRun(runId);
        if (!run) return { error: `run nao encontrado: ${runId}` };
        const def = getDynamicWorkflowDefinition(run.definitionId);
        if (!def) {
          return { error: `definition nao encontrada: ${run.definitionId}` };
        }
        const workflowJsSource = readFileSync(def.workflowJsPath, 'utf8');
        const manifest = JSON.parse(def.manifestJson) as DynamicWorkflowManifest;
        const catalogAgentIds = loadAgentCatalogSnapshot().map((a) => a.id);
        const runDir = dirname(def.workflowJsPath);
        const schemaFileNames = listSchemaFiles(runDir);
        const report = validateWorkflowPackage({
          workflowJsSource,
          manifest,
          catalogAgentIds,
          schemaFileNames,
        });
        return { ok: true, report };
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:validate failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:start',
    async (_event, runId: string): Promise<DynamicWorkflowOkResult> => {
      try {
        return await getRunner().start(runId);
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:start failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:pause',
    async (_event, runId: string): Promise<DynamicWorkflowOkResult> => {
      try {
        return await getRunner().pause(runId);
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:pause failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:resume',
    async (
      _event,
      runId: string,
      opts?: DynamicWorkflowResumeOptions,
    ): Promise<DynamicWorkflowOkResult> => {
      try {
        return await getRunner().resume(runId, opts);
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:resume failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:abort',
    async (_event, runId: string): Promise<DynamicWorkflowOkResult> => {
      try {
        return await getRunner().abort(runId);
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:abort failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:reopen',
    async (_event, runId: string): Promise<DynamicWorkflowOkResult> => {
      try {
        return await getRunner().reopen(runId);
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:reopen failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:delete',
    async (_event, runId: string): Promise<DynamicWorkflowOkResult> => {
      try {
        const run = getDynamicWorkflowRun(runId);
        if (!run) return { error: `run nao encontrado: ${runId}` };
        try {
          await getRunner().abort(runId);
        } catch (abortErr) {
          logger.warn(
            { err: abortErr, runId },
            'dynamic-workflow:delete: abort previo falhou (segue para remocao)',
          );
        }
        try {
          releaseProjectLock(runId);
        } catch {
        }
        try {
          const definition = getDynamicWorkflowDefinition(run.definitionId);
          if (definition?.projectPath) {
            const runDir = runDirFor(definition.projectPath, runId);
            if (existsSync(runDir)) {
              const finalRun = getDynamicWorkflowRun(runId) ?? run;
              const nodeRuns = listDynamicWorkflowNodeRuns(runId);
              const summary = {
                exportedAt: new Date().toISOString(),
                run: finalRun,
                cost: getDynamicWorkflowRunCostAggregate(runId),
                nodeRuns: nodeRuns.map((nr) => ({
                  id: nr.id,
                  nodeId: nr.nodeId,
                  phaseId: nr.phaseId,
                  agentId: nr.agentId,
                  status: nr.status,
                  attempt: nr.attempt,
                  failureClass: nr.failureClass ?? null,
                  error: nr.error ?? null,
                  inputTokens: nr.inputTokens,
                  outputTokens: nr.outputTokens,
                  costUsd: nr.costUsd,
                  startedAt: nr.startedAt ?? null,
                  completedAt: nr.completedAt ?? null,
                })),
                gateDecisions: listDynamicWorkflowGateDecisions(runId),
                sprints: listDynamicWorkflowSprints(runId),
                events: listDynamicWorkflowEvents(runId, { limit: Number.MAX_SAFE_INTEGER }),
                journal: listDynamicWorkflowJournalEntries(runId),
              };
              writeFileSync(
                join(runDir, 'run-summary.json'),
                JSON.stringify(summary, null, 2),
                'utf8',
              );
              logger.info({ runId }, 'dynamic-workflow:delete: run-summary.json exportado');
            }
          }
        } catch (exportErr) {
          logger.warn(
            { err: exportErr, runId },
            'dynamic-workflow:delete: export do run-summary falhou (segue para remocao)',
          );
        }
        const removed = deleteDynamicWorkflowRun(runId);
        if (!removed) return { error: `run nao encontrado: ${runId}` };
        logger.info({ runId }, 'dynamic-workflow:delete: run removido (acao explicita do dono)');
        return { ok: true };
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:delete failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:send-message',
    async (
      _event,
      runId: string,
      message: string,
      _attachments?: string[],
    ): Promise<DynamicWorkflowOkResult> => {
      try {
        const run = getDynamicWorkflowRun(runId);
        if (!run) return { error: `run nao encontrado: ${runId}` };
        const text = (message ?? '').trim();
        if (text.length === 0) return { error: 'mensagem vazia' };

        const targetNodeId = run.currentNodeId ?? undefined;
        const active = run.status === 'running' || run.status === 'blocked';

        const intervention: DynamicWorkflowIntervention = active
          ? {
              type: 'adjust-next-node',
              nodeId: targetNodeId ?? '',
              instruction: text,
            }
          : {
              type: 'reply',
              message: text,
              targetNodeId,
            };

        return await getRunner().intervene(runId, intervention, 'human');
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:send-message failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:intervene',
    async (
      _event,
      runId: string,
      intervention: DynamicWorkflowIntervention,
    ): Promise<DynamicWorkflowOkResult> => {
      try {
        if (intervention.type === 'switch-agent') {
          return await handleSwitchAgentIntervention(runId, intervention);
        }
        return await getRunner().intervene(runId, intervention, 'human');
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:intervene failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:request-replan',
    (
      _event,
      runId: string,
      request: DynamicWorkflowReplanRequest,
    ): DynamicWorkflowReplanResult => {
      try {
        const run = getDynamicWorkflowRun(runId);
        if (!run) return { error: `run nao encontrado: ${runId}` };
        const prevDef = getDynamicWorkflowDefinition(run.definitionId);
        if (!prevDef) {
          return { error: `definition nao encontrada: ${run.definitionId}` };
        }

        const newDefinitionId = `dwfd_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 10)}`;
        const { newDefInput, prevDefPatch } = buildReplanLinkage(
          prevDef,
          newDefinitionId,
        );

        createDynamicWorkflowDefinition(newDefInput);
        updateDynamicWorkflowDefinition(prevDef.id, prevDefPatch);

        insertDynamicWorkflowEvent({
          runId,
          type: 'replan-requested',
          payloadJson: JSON.stringify({
            scope: request.scope,
            reason: request.reason,
            nodeId: request.nodeId ?? null,
            fromDefinitionId: prevDef.id,
            toDefinitionId: newDefinitionId,
            newVersion: newDefInput.definitionVersion,
          }),
        });
        insertDynamicWorkflowMessage({
          runId,
          nodeId: request.nodeId ?? null,
          role: 'user',
          source: 'human',
          kind: 'replan',
          content: `replan (${request.scope}): ${request.reason}`,
        });

        return { ok: true, definitionId: newDefinitionId };
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:request-replan failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:approve-gate',
    async (
      _event,
      runId: string,
      gateId: string,
      decision: DynamicWorkflowGateDecisionInput,
    ): Promise<DynamicWorkflowOkResult> => {
      try {
        return await getRunner().approveGate(runId, gateId, decision, 'human');
      } catch (err) {
        logger.error({ err, runId, gateId }, 'dynamic-workflow:approve-gate failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:resolve-with-closer',
    async (_event, runId: string, reason: string): Promise<DynamicWorkflowOkResult> => {
      try {
        const run = getDynamicWorkflowRun(runId);
        if (!run) return { error: `run nao encontrado: ${runId}` };
        const context: CloserSpawnContext = {
          reason: closerReasonForRun(run),
          motive:
            (reason ?? '').trim() ||
            'Usuario pediu ajuda do agente de fechamento (Resolver com agente).',
        };
        const result = await openCloserSession(
          runId,
          context,
          buildCloserDeps(),
          { repoRoot: resolveRepoRootForRun(run) },
        );
        broadcastCloserMessage(runId, result.message);
        return { ok: true };
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:resolve-with-closer failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:closer-message',
    async (_event, runId: string, message: string): Promise<DynamicWorkflowOkResult> => {
      try {
        const run = getDynamicWorkflowRun(runId);
        if (!run) return { error: `run nao encontrado: ${runId}` };
        const text = (message ?? '').trim();
        if (text.length === 0) return { error: 'mensagem vazia' };
        const context: CloserSpawnContext = {
          reason: closerReasonForRun(run),
          motive: 'Conversa de fechamento (closer).',
        };
        const result = await sendCloserMessage(
          runId,
          text,
          context,
          buildCloserDeps(),
          { repoRoot: resolveRepoRootForRun(run) },
        );
        broadcastCloserMessage(runId, result.message);
        return { ok: true };
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:closer-message failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:finalize',
    (_event, runId: string): DynamicWorkflowOkResult => {
      try {
        return getRunner().finalize(runId);
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:finalize failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'dynamic-workflow:get-snapshot',
    (_event, runId: string): DynamicWorkflowSnapshotResult => {
      try {
        const snapshot = getRunner().getSnapshot(runId);
        if (!snapshot) return { error: `run nao encontrado: ${runId}` };
        return snapshot;
      } catch (err) {
        logger.error({ err, runId }, 'dynamic-workflow:get-snapshot failed');
        return { error: (err as Error).message };
      }
    },
  );
}
