
import {
  getActiveChatSession,
  getDynamicWorkflowRun,
  listDynamicWorkflowRunsByStatus,
  listDynamicWorkflowNodeRuns,
  getDynamicWorkflowDefinition,
  createDynamicWorkflowDefinition,
  updateDynamicWorkflowDefinition,
  createDynamicWorkflowRun,
  getAllAgents,
  getAgent,
  insertAuditEntry,
} from '../db';
import { createHash } from 'node:crypto';
import { validateAuthoredAgentTypes } from './authored-agent-validation';
import {
  createWorkflow,
  type CreateWorkflowDeps,
} from './workflow-create';
import type {
  DynamicWorkflowAgentSummary,
  DynamicWorkflowAutonomyMode,
  DynamicWorkflowDefinition,
  DynamicWorkflowGateDecisionInput,
  DynamicWorkflowIntervention,
  DynamicWorkflowManifest,
  DynamicWorkflowManifestGate,
  DynamicWorkflowManifestNode,
  DynamicWorkflowRun,
  DynamicWorkflowRunStatus,
  DynamicWorkflowSnapshot,
} from './types';
import {
  resolveSwitchAgentVerdict,
  makePersistSwitchedDefinition,
  type SwitchAgentValidation,
} from './switch-agent-validation';
import { createLogger } from '../logger';

const logger = createLogger('dynamic-workflow-control-core');


export type WorkflowControlResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

function fail(error: string): WorkflowControlResult {
  return { ok: false, error };
}

function done(value: unknown): WorkflowControlResult {
  return { ok: true, value };
}


export const DYNAMIC_WORKFLOW_WRITE_ACTIONS = new Set<string>([
  'dynamic_workflow_start',
  'dynamic_workflow_author',
  'dynamic_workflow_reply',
  'dynamic_workflow_approve',
  'dynamic_workflow_intervene',
  'dynamic_workflow_abort',
  'dynamic_workflow_edit_coordinator',
]);

export function isDynamicWorkflowWriteAction(action: string): boolean {
  return DYNAMIC_WORKFLOW_WRITE_ACTIONS.has(action);
}


const TERMINAL_STATUSES = new Set<string>(['completed', 'aborted', 'failed']);

const ALREADY_RUNNING_STATUSES = new Set<string>(['running']);


const IN_PROGRESS_RUN_STATUSES: readonly DynamicWorkflowRunStatus[] = [
  'running',
  'blocked',
  'paused',
  'interrupted',
];

export function assertNoOtherActiveRun(selfRunId: string): string | null {
  for (const status of IN_PROGRESS_RUN_STATUSES) {
    for (const other of listDynamicWorkflowRunsByStatus(status)) {
      if (other.id !== selfRunId) {
        return (
          `single-active-run: ja existe um workflow ativo ("${other.id}", status "${other.status}"). ` +
          'Um workflow por vez - conclua, entregue ou aborte o run atual antes de iniciar outro.'
        );
      }
    }
  }
  return null;
}


const inFlight = new Set<string>();

const conductCount = new Map<string, number>();

export const MAX_CONDUCT_CALLS_PER_RUN = 200;


const authorCallTimestamps = new Map<string, number[]>();

export const AUTHOR_RATE_WINDOW_MS = 10 * 60_000;

export const MAX_AUTHOR_CALLS_PER_WINDOW = 20;

const NO_SESSION_AUTHOR_KEY = '__no-session__';

function bumpAuthorRateLimitOrReject(chatSessionId: string | undefined, nowMs: number): string | null {
  const key = chatSessionId ?? NO_SESSION_AUTHOR_KEY;
  const cutoff = nowMs - AUTHOR_RATE_WINDOW_MS;
  const recent = (authorCallTimestamps.get(key) ?? []).filter((t) => t > cutoff);
  if (recent.length >= MAX_AUTHOR_CALLS_PER_WINDOW) {
    authorCallTimestamps.set(key, recent);
    return (
      `anti-runaway de autoria: ja foram autorados ${MAX_AUTHOR_CALLS_PER_WINDOW} workflows nesta sessao ` +
      `nos ultimos ${Math.round(AUTHOR_RATE_WINDOW_MS / 60_000)} min. Pause a autoria automatica - ` +
      'peca orientacao ao humano no chat antes de criar mais workflows.'
    );
  }
  recent.push(nowMs);
  authorCallTimestamps.set(key, recent);
  return null;
}

export function _resetWorkflowControlStateForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error(
      '_resetWorkflowControlStateForTesting so pode ser chamado em ambiente de teste',
    );
  }
  inFlight.clear();
  conductCount.clear();
  authorCallTimestamps.clear();
}

function bumpConductOrEscalate(runId: string): string | null {
  const next = (conductCount.get(runId) ?? 0) + 1;
  conductCount.set(runId, next);
  if (next > MAX_CONDUCT_CALLS_PER_RUN) {
    return (
      `anti-runaway: o run "${runId}" ja recebeu ${MAX_CONDUCT_CALLS_PER_RUN} acoes de conducao ` +
      'sem encerrar. Pausando a conducao automatica - peca orientacao ao humano no chat antes de continuar.'
    );
  }
  return null;
}

async function withInFlight(
  runId: string,
  work: () => Promise<WorkflowControlResult>,
): Promise<WorkflowControlResult> {
  if (inFlight.has(runId)) {
    return fail(
      `one-in-flight: ja ha uma acao de conducao em voo para o run "${runId}". ` +
        'Aguarde ela concluir e reavalie com dynamic_workflow_inspect.',
    );
  }
  inFlight.add(runId);
  try {
    return await work();
  } finally {
    inFlight.delete(runId);
  }
}


type RunnerLike = {
  start(runId: string): Promise<{ ok: true } | { error: string }>;
  abort(runId: string): Promise<{ ok: true } | { error: string }>;
  intervene(
    runId: string,
    intervention: DynamicWorkflowIntervention,
    source: 'human' | 'orchestrator' | 'workflow-orchestrator-agent',
  ): Promise<{ ok: true } | { error: string }>;
  approveGate(
    runId: string,
    gateId: string,
    decision: DynamicWorkflowGateDecisionInput,
    decidedBy: string,
  ): Promise<{ ok: true } | { error: string }>;
  getSnapshot(runId: string): DynamicWorkflowSnapshot | null;
  resume(runId: string): Promise<{ ok: true } | { error: string }>;
  editCoordinator(
    runId: string,
    input: { workflowJsSource: string; reason: string },
    source: 'human' | 'orchestrator' | 'workflow-orchestrator-agent',
  ): Promise<
    | { ok: true; newDefinitionId: string; revisionId: string; manifestHash: string }
    | { ok: false; error: string }
  >;
  switchAgent(
    runId: string,
    nodeId: string,
    newAgentId: string,
    reason: string,
    source: 'human' | 'orchestrator' | 'workflow-orchestrator-agent',
    s17Override: {
      validateSwitchAgent: () => SwitchAgentValidation;
      persistSwitchedDefinition: (input: {
        prevDefinition: DynamicWorkflowDefinition;
        nodeId: string;
        newAgentId: string;
      }) => { newDefinitionId: string };
    },
  ): Promise<{ ok: true } | { error: string }>;
  reopen(runId: string): Promise<{ ok: true } | { error: string }>;
};

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

function buildCreateDeps(): CreateWorkflowDeps {
  return {
    createDefinition: createDynamicWorkflowDefinition,
    createRun: createDynamicWorkflowRun,
    loadAgentCatalog: loadAgentCatalogSnapshot,
    getAgent,
  };
}

export async function ensureWorkflowRunner(): Promise<RunnerLike> {
  const [{ getWorkflowRunner }, { createDefaultRunnerDeps }] = await Promise.all([
    import('./workflow-runner'),
    import('./workflow-runner-deps'),
  ]);
  return getWorkflowRunner(createDefaultRunnerDeps()) as unknown as RunnerLike;
}

export async function recoverWorkflowRunsOnBoot(): Promise<{ recovered: number }> {
  await ensureWorkflowRunner();
  const { recoverInterruptedRuns } = await import('./workflow-runner');
  return recoverInterruptedRuns();
}


async function snapshotOf(runId: string): Promise<DynamicWorkflowSnapshot | null> {
  try {
    const runner = await ensureWorkflowRunner();
    return runner.getSnapshot(runId);
  } catch (err) {
    logger.warn({ runId, error: (err as Error).message }, 'snapshotOf falhou');
    return null;
  }
}


function resolveChatSessionId(): string | undefined {
  return getActiveChatSession()?.id;
}


export interface DynamicWorkflowAuthorInput {
  projectPath: string;
  name?: string;
  workflowJsSource: string;
  start?: boolean;
}

function emitAuthorAuditEvent(input: {
  workflowJsSource: string;
  chatSessionId: string | undefined;
  runId: string;
  timestamp: string;
}): void {
  try {
    const sourceHash = createHash('sha256').update(input.workflowJsSource).digest('hex');
    insertAuditEntry({
      eventType: 'tool_call',
      toolName: 'dynamic_workflow_author',
      source: 'workflow',
      ...(input.chatSessionId ? { sessionId: input.chatSessionId } : {}),
      input: JSON.stringify({
        action: 'author-workflow',
        runId: input.runId,
        chatSessionId: input.chatSessionId ?? null,
        workflowJsSourceSha256: sourceHash,
        workflowJsSourceBytes: Buffer.byteLength(input.workflowJsSource, 'utf8'),
        timestamp: input.timestamp,
      }),
    });
  } catch (err) {
    logger.warn(
      { runId: input.runId, error: err instanceof Error ? err.message : String(err) },
      'F4.8: falha ao emitir evento de auditoria de autoria (best-effort)',
    );
  }
}

export async function dynamicWorkflowAuthorCore(
  input: DynamicWorkflowAuthorInput,
): Promise<WorkflowControlResult> {
  try {
    if (!input || !input.projectPath) {
      return fail('Erro: projectPath obrigatorio');
    }
    if (typeof input.workflowJsSource !== 'string' || input.workflowJsSource.trim().length === 0) {
      return fail('Erro: workflowJsSource obrigatorio (o workflow.js claude-code que o orquestrador escreveu)');
    }
    const chatSessionId = resolveChatSessionId();

    const rateError = bumpAuthorRateLimitOrReject(chatSessionId, Date.now());
    if (rateError) return fail(rateError);

    const secVerdict = validateAuthoredAgentTypes(input.workflowJsSource, { getAgent });
    if (!secVerdict.ok) {
      return fail(secVerdict.error);
    }

    const start = input.start !== false; // default true

    if (start) {
      const otherActiveAuthor = assertNoOtherActiveRun('');
      if (otherActiveAuthor) return fail(otherActiveAuthor);
    }

    const authoredAutonomy: DynamicWorkflowAutonomyMode = 'auto';
    const result = await createWorkflow(
      {
        projectPath: input.projectPath,
        name: input.name,
        workflowSource: input.workflowJsSource,
        origin: 'orchestrator',
        chatSessionId,
        autonomy: authoredAutonomy,
        pendingStart: start,
      },
      buildCreateDeps(),
    );
    if (!result.ok) {
      return fail(`Erro ao autorar o workflow: ${result.error}`);
    }

    const runId = result.runId;

    emitAuthorAuditEvent({
      workflowJsSource: input.workflowJsSource,
      chatSessionId,
      runId,
      timestamp: new Date().toISOString(),
    });

    if (!start) {
      return done({
        runId,
        definitionId: result.definitionId,
        authored: true,
        started: false,
        note:
          'workflow autorado (claude-code) e validado em .lionclaw/workflows/<runId>/. ' +
          'Mostre o resumo ao humano e use dynamic_workflow_start para iniciar, ou dynamic_workflow_inspect para revisar.',
      });
    }

    void (async () => {
      try {
        const runner = await ensureWorkflowRunner();
        const startRes = await runner.start(runId);
        if ('error' in startRes) {
          logger.error({ runId, error: startRes.error }, 'author: start falhou');
        }
      } catch (err) {
        logger.error(
          { runId, error: err instanceof Error ? err.message : String(err) },
          'author: start lancou apos early-ack',
        );
      }
    })();

    return done({
      runId,
      definitionId: result.definitionId,
      authored: true,
      started: true,
      note:
        'workflow autorado (claude-code) e iniciando em background. Reporte etapa por etapa ' +
        '(use dynamic_workflow_inspect antes de responder) e escale gate/permissao/custo de risco ao humano.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'dynamic_workflow_author failed');
    return fail(`Erro no author: ${msg}`);
  }
}

export async function dynamicWorkflowStartCore(runId: string): Promise<WorkflowControlResult> {
  if (!runId) return fail('Erro: runId obrigatorio');
  const run = getDynamicWorkflowRun(runId);
  if (!run) return fail(`Erro: run "${runId}" nao encontrado`);

  if (TERMINAL_STATUSES.has(run.status)) {
    return fail(
      `dynamic_workflow_start: o run "${runId}" esta "${run.status}" (encerrado) - nao ha o que iniciar. ` +
        'Crie um novo workflow se precisar repetir.',
    );
  }
  if (ALREADY_RUNNING_STATUSES.has(run.status)) {
    return done({
      runId,
      started: false,
      alreadyRunning: true,
      note: 'o run ja esta em execucao (start e no-op). Use dynamic_workflow_inspect para o estado atual.',
    });
  }
  const otherActive = assertNoOtherActiveRun(runId);
  if (otherActive) return fail(otherActive);
  const escalate = bumpConductOrEscalate(runId);
  if (escalate) return fail(escalate);

  return withInFlight(runId, async () => {
    try {
      const runner = await ensureWorkflowRunner();
      const res = await runner.start(runId);
      if ('error' in res) return fail(`dynamic_workflow_start falhou: ${res.error}`);
      return done({ runId, started: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ runId, error: msg }, 'dynamic_workflow_start failed');
      return fail(`Erro ao iniciar o run "${runId}": ${msg}`);
    }
  });
}

export async function dynamicWorkflowInspectCore(runId: string): Promise<WorkflowControlResult> {
  try {
    if (!runId) return fail('Erro: runId obrigatorio');
    const run = getDynamicWorkflowRun(runId);
    if (!run) return fail(`Erro: run "${runId}" nao encontrado`);
    const snapshot = await snapshotOf(runId);
    if (!snapshot) {
      return done(summarizeRun(run));
    }
    return done(snapshot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ runId, error: msg }, 'dynamic_workflow_inspect failed');
    return fail(`Erro ao inspecionar o run "${runId}": ${msg}`);
  }
}

function summarizeRun(run: DynamicWorkflowRun): Record<string, unknown> {
  return {
    runId: run.id,
    status: run.status,
    currentPhaseId: run.currentPhaseId,
    currentNodeId: run.currentNodeId,
    cost: { actualUsd: run.totalCostUsd },
  };
}

export async function dynamicWorkflowReplyCore(
  runId: string,
  message: string,
  targetNodeId?: string,
): Promise<WorkflowControlResult> {
  if (!runId || typeof message !== 'string') {
    return fail('Erro: runId e message sao obrigatorios');
  }
  const run = getDynamicWorkflowRun(runId);
  if (!run) return fail(`Erro: run "${runId}" nao encontrado`);
  if (TERMINAL_STATUSES.has(run.status)) {
    return fail(
      `dynamic_workflow_reply: o run "${runId}" esta "${run.status}" (encerrado) - nada para responder.`,
    );
  }
  const escalate = bumpConductOrEscalate(runId);
  if (escalate) return fail(escalate);

  if (targetNodeId) {
    const stale = await assertNotStaleNode(runId, targetNodeId);
    if (stale) return stale;
  }

  return withInFlight(runId, async () => {
    const intervention: DynamicWorkflowIntervention = targetNodeId
      ? { type: 'reply', message, targetNodeId }
      : { type: 'reply', message };
    return interveneViaRunner(runId, intervention);
  });
}

export async function dynamicWorkflowApproveCore(
  runId: string,
  gateId: string,
  decision: DynamicWorkflowGateDecisionInput,
): Promise<WorkflowControlResult> {
  if (!runId || !gateId) return fail('Erro: runId e gateId sao obrigatorios');
  if (!decision || (decision.decision !== 'approve' && decision.decision !== 'reject')) {
    return fail("Erro: decision.decision deve ser 'approve' ou 'reject'");
  }
  const run = getDynamicWorkflowRun(runId);
  if (!run) return fail(`Erro: run "${runId}" nao encontrado`);

  const gate = resolveGate(run, gateId);

  const escalate = bumpConductOrEscalate(runId);
  if (escalate) return fail(escalate);

  return withInFlight(runId, async () => {
    try {
      const runner = await ensureWorkflowRunner();
      const res = await runner.approveGate(runId, gateId, decision, 'orchestrator');
      if ('error' in res) return fail(`dynamic_workflow_approve falhou: ${res.error}`);
      const snapshot = await snapshotOf(runId);
      logger.info(
        { runId, gateId, gateMode: gate?.mode, gateKind: gate?.kind, decision: decision.decision },
        'dynamic_workflow_approve aplicado (SM-31: orquestrador/Maestro decide o gate por comando do humano)',
      );
      return done({ runId, gateId, decision: decision.decision, approved: true, snapshot });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ runId, gateId, error: msg }, 'dynamic_workflow_approve failed');
      return fail(`Erro ao aprovar o gate "${gateId}" do run "${runId}": ${msg}`);
    }
  });
}

export async function dynamicWorkflowInterveneCore(
  runId: string,
  intervention: DynamicWorkflowIntervention,
): Promise<WorkflowControlResult> {
  if (!runId || !intervention || typeof intervention.type !== 'string') {
    return fail('Erro: runId e intervention sao obrigatorios');
  }
  const run = getDynamicWorkflowRun(runId);
  if (!run) return fail(`Erro: run "${runId}" nao encontrado`);

  if (intervention.type === 'approve-gate') {
    return dynamicWorkflowApproveCore(runId, intervention.gateId, {
      decision: intervention.decision,
      reason: intervention.reason,
      ...(intervention.payload ? { payload: intervention.payload } : {}),
    });
  }

  if (intervention.type === 'switch-agent') {
    return dynamicWorkflowSwitchAgentCore(
      runId,
      intervention.nodeId,
      intervention.newAgentId,
      intervention.reason,
    );
  }

  if (
    TERMINAL_STATUSES.has(run.status) &&
    intervention.type !== 'resume' &&
    intervention.type !== 'rerun-node'
  ) {
    return fail(
      `dynamic_workflow_intervene: o run "${runId}" esta "${run.status}" (encerrado) - intervencao nao se aplica.`,
    );
  }

  const escalate = bumpConductOrEscalate(runId);
  if (escalate) return fail(escalate);

  if (intervention.type === 'adjust-next-node' && intervention.nodeId !== '*') {
    const started = await assertNotStartedNode(runId, intervention.nodeId);
    if (started) return started;
  }
  const targetNodeId = intervention.type === 'reply' ? intervention.targetNodeId : undefined;
  if (targetNodeId) {
    const stale = await assertNotStaleNode(runId, targetNodeId);
    if (stale) return stale;
  }

  if (intervention.type === 'rerun-node') {
    if (typeof intervention.nodeId !== 'string' || !intervention.nodeId) {
      return fail('rerun-node: nodeId obrigatorio (o node CONCLUIDO a re-executar)');
    }
    if (typeof intervention.instruction !== 'string' || !intervention.instruction.trim()) {
      return fail('rerun-node: instruction obrigatoria (anexada ao prompt como [AJUSTE DO ORQUESTRADOR])');
    }
  }
  if (intervention.type === 'adjust-next-node') {
    if (typeof intervention.instruction !== 'string' || !intervention.instruction.trim()) {
      return fail('adjust-next-node: instruction obrigatoria');
    }
  }

  return withInFlight(runId, async () =>
    interveneViaRunner(runId, intervention, interventionNote(intervention)),
  );
}

function interventionNote(intervention: DynamicWorkflowIntervention): string | undefined {
  if (intervention.type === 'rerun-node') {
    return (
      `rerun-node: journal truncado a partir do node "${intervention.nodeId}" e run retomado; o node ` +
      're-executa com [AJUSTE DO ORQUESTRADOR] anexado ao prompt (e os nodes seguintes re-rodam). ' +
      'Commits posteriores na worktree NAO sao desfeitos (mesma limitacao do edit_coordinator).'
    );
  }
  if (intervention.type === 'adjust-next-node') {
    return intervention.nodeId === '*'
      ? "adjust-next-node: nodeId '*' aplica ao PROXIMO node que iniciar; em fan-out paralelo so o primeiro a iniciar recebe o ajuste - para fan-out use o nodeId exato."
      : `adjust-next-node: o ajuste sera anexado ao prompt do node "${intervention.nodeId}" quando ele iniciar (nodes ja concluidos exigem rerun-node).`;
  }
  return undefined;
}

let persistSwitchedDefinitionRealMemo: ReturnType<typeof makePersistSwitchedDefinition> | undefined;
function getPersistSwitchedDefinitionReal(): ReturnType<typeof makePersistSwitchedDefinition> {
  if (!persistSwitchedDefinitionRealMemo) {
    persistSwitchedDefinitionRealMemo = makePersistSwitchedDefinition({
      createDefinition: createDynamicWorkflowDefinition,
      updateDefinition: updateDynamicWorkflowDefinition,
    });
  }
  return persistSwitchedDefinitionRealMemo;
}

export async function dynamicWorkflowSwitchAgentCore(
  runId: string,
  nodeId: string,
  newAgentId: string,
  reason: string,
): Promise<WorkflowControlResult> {
  if (!runId || !nodeId || !newAgentId) {
    return fail('Erro: runId, nodeId e newAgentId sao obrigatorios');
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return fail('Erro: reason obrigatorio (motivo da troca, para a trilha auditavel)');
  }
  const run = getDynamicWorkflowRun(runId);
  if (!run) return fail(`Erro: run "${runId}" nao encontrado`);
  if (TERMINAL_STATUSES.has(run.status)) {
    return fail(
      `dynamic_workflow switch-agent: o run "${runId}" esta "${run.status}" (encerrado) - nada para trocar. ` +
        'Retome o run (resume) primeiro se quiser continuar.',
    );
  }

  const node = resolveManifestNode(run, nodeId);
  if (!node) {
    return fail(
      `switch-agent: node "${nodeId}" nao existe no manifest do run "${runId}". Reavalie com dynamic_workflow_inspect.`,
    );
  }

  const escalate = bumpConductOrEscalate(runId);
  if (escalate) return fail(escalate);

  return withInFlight(runId, async () => {
    try {
      const { resolveAgentQueryConfig } = await import('../agent-config-resolver');
      const verdict = await resolveSwitchAgentVerdict(node, newAgentId, {
        resolveAgent: resolveAgentQueryConfig,
        loadActiveAgentIds: () => getAllAgents().filter((a) => a.isActive).map((a) => a.id),
      });

      const runner = await ensureWorkflowRunner();
      const res = await runner.switchAgent(runId, nodeId, newAgentId, reason, 'orchestrator', {
        validateSwitchAgent: () => verdict,
        persistSwitchedDefinition: getPersistSwitchedDefinitionReal(),
      });
      if ('error' in res) return fail(`dynamic_workflow switch-agent falhou: ${res.error}`);
      const snapshot = await snapshotOf(runId);
      return done({ runId, nodeId, newAgentId, switched: true, snapshot });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ runId, nodeId, newAgentId, error: msg }, 'dynamic_workflow switch-agent failed');
      return fail(`Erro ao trocar o agente do node "${nodeId}" do run "${runId}": ${msg}`);
    }
  });
}

export async function dynamicWorkflowAbortCore(runId: string): Promise<WorkflowControlResult> {
  if (!runId) return fail('Erro: runId obrigatorio');
  const run = getDynamicWorkflowRun(runId);
  if (!run) return fail(`Erro: run "${runId}" nao encontrado`);

  if (TERMINAL_STATUSES.has(run.status)) {
    return done({
      runId,
      aborted: false,
      alreadyTerminal: true,
      note: `o run ja esta "${run.status}" (encerrado); abort e no-op. A branch dynworkflow/<runId> permanece para autopsia.`,
    });
  }
  const escalate = bumpConductOrEscalate(runId);
  if (escalate) return fail(escalate);

  return withInFlight(runId, async () => {
    try {
      const runner = await ensureWorkflowRunner();
      const res = await runner.abort(runId);
      if ('error' in res) return fail(`dynamic_workflow_abort falhou: ${res.error}`);
      return done({ runId, aborted: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ runId, error: msg }, 'dynamic_workflow_abort failed');
      return fail(`Erro ao abortar o run "${runId}": ${msg}`);
    }
  });
}

export interface DynamicWorkflowEditCoordinatorInput {
  runId: string;
  workflowJsSource: string;
  reason: string;
  resume?: boolean;
}

export async function dynamicWorkflowEditCoordinatorCore(
  input: DynamicWorkflowEditCoordinatorInput,
): Promise<WorkflowControlResult> {
  if (!input || !input.runId) return fail('Erro: runId obrigatorio');
  if (typeof input.workflowJsSource !== 'string' || input.workflowJsSource.length === 0) {
    return fail('Erro: workflowJsSource obrigatorio (o JS reescrito do coordenador)');
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    return fail('Erro: reason obrigatorio (motivo/escopo da edicao, para a trilha auditavel)');
  }
  const runId = input.runId;
  const run = getDynamicWorkflowRun(runId);
  if (!run) return fail(`Erro: run "${runId}" nao encontrado`);
  if (TERMINAL_STATUSES.has(run.status)) {
    return fail(
      `dynamic_workflow_edit_coordinator: o run "${runId}" esta "${run.status}" (encerrado) - nada para editar.`,
    );
  }

  {
    const editVerdict = validateAuthoredAgentTypes(input.workflowJsSource, { getAgent });
    if (!editVerdict.ok) {
      return fail(`dynamic_workflow_edit_coordinator: ${editVerdict.error}`);
    }
  }

  const escalate = bumpConductOrEscalate(runId);
  if (escalate) return fail(escalate);

  return withInFlight(runId, async () => {
    try {
      const runner = await ensureWorkflowRunner();
      const editRes = await runner.editCoordinator(
        runId,
        {
          workflowJsSource: input.workflowJsSource,
          reason: input.reason,
        },
        'orchestrator',
      );
      if (!editRes.ok) {
        return fail(`dynamic_workflow_edit_coordinator: ${editRes.error}`);
      }

      let resumed = false;
      let resumeError: string | undefined;
      if (input.resume) {
        const resumeRes = await runner.resume(runId);
        if ('error' in resumeRes) resumeError = resumeRes.error;
        else resumed = true;
      }

      const snapshot = await snapshotOf(runId);
      return done({
        runId,
        edited: true,
        newDefinitionId: editRes.newDefinitionId,
        revisionId: editRes.revisionId,
        manifestHash: editRes.manifestHash,
        resumed,
        ...(resumeError ? { resumeError } : {}),
        snapshot,
        note: input.resume
          ? 'coordenador editado (nova revisao auditavel) e run re-apontado; resume disparado para re-rodar do ponto de divergencia via journal.'
          : 'coordenador editado (nova revisao auditavel) e run re-apontado. Use dynamic_workflow_intervene { type: "resume" } para re-rodar do ponto de divergencia.',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ runId, error: msg }, 'dynamic_workflow_edit_coordinator failed');
      return fail(`Erro ao editar o coordenador do run "${runId}": ${msg}`);
    }
  });
}


function resolveGate(
  run: DynamicWorkflowRun,
  gateId: string,
): DynamicWorkflowManifestGate | undefined {
  const def = getDynamicWorkflowDefinition(run.definitionId);
  if (!def) return undefined;
  let manifest: DynamicWorkflowManifest;
  try {
    manifest = JSON.parse(def.manifestJson) as DynamicWorkflowManifest;
  } catch (err) {
    logger.warn(
      { runId: run.id, gateId, error: (err as Error).message },
      'manifest da definition ilegivel ao resolver o gate',
    );
    return undefined;
  }
  const gates = Array.isArray(manifest.gates) ? manifest.gates : [];
  return gates.find((g) => g.id === gateId);
}

function resolveManifestNode(
  run: DynamicWorkflowRun,
  nodeId: string,
): DynamicWorkflowManifestNode | undefined {
  const def = getDynamicWorkflowDefinition(run.definitionId);
  if (!def) return undefined;
  let manifest: DynamicWorkflowManifest;
  try {
    manifest = JSON.parse(def.manifestJson) as DynamicWorkflowManifest;
  } catch (err) {
    logger.warn(
      { runId: run.id, nodeId, error: (err as Error).message },
      'manifest da definition ilegivel ao resolver o node (switch-agent)',
    );
    return undefined;
  }
  const nodes = Array.isArray(manifest.nodes) ? manifest.nodes : [];
  return nodes.find((n) => n.id === nodeId);
}

async function assertNotStaleNode(
  runId: string,
  targetNodeId: string,
): Promise<WorkflowControlResult | null> {
  const snapshot = await snapshotOf(runId);
  const current = snapshot?.currentNodeId;
  if (!current) return null;
  if (current !== targetNodeId) {
    return fail(
      `comando defasado: a acao mira o node "${targetNodeId}", mas o run "${runId}" esta no node ` +
        `"${current}" agora. Reavalie com o snapshot atual e mire o node correto.`,
    );
  }
  return null;
}

async function assertNotStartedNode(
  runId: string,
  targetNodeId: string,
): Promise<WorkflowControlResult | null> {
  let runs: Array<{ nodeId: string; status: string }>;
  try {
    runs = listDynamicWorkflowNodeRuns(runId);
  } catch (err) {
    logger.warn({ runId, targetNodeId, error: (err as Error).message }, 'assertNotStartedNode: leitura de node_runs falhou (aceita)');
    return null;
  }
  const hit = runs.find((nr) => nr.nodeId === targetNodeId);
  if (!hit) return null;
  const snapshot = await snapshotOf(runId);
  const current = snapshot?.currentNodeId;
  return fail(
    `adjust-next-node: o node "${targetNodeId}" ja ${hit.status === 'running' ? 'esta em execucao' : `tem attempt (${hit.status})`} no run "${runId}"` +
      ` - o ajuste so vale para node que AINDA NAO iniciou (o proximo a reivindicar). Use '*' para o proximo node que iniciar` +
      `${current ? `, ou rerun-node para re-executar "${targetNodeId}"` : ''}.`,
  );
}

async function interveneViaRunner(
  runId: string,
  intervention: DynamicWorkflowIntervention,
  note?: string,
): Promise<WorkflowControlResult> {
  try {
    const runner = await ensureWorkflowRunner();
    const res = await runner.intervene(runId, intervention, 'orchestrator');
    if ('error' in res) return fail(`dynamic_workflow_intervene falhou: ${res.error}`);
    const snapshot = await snapshotOf(runId);
    return done({
      runId,
      intervention: intervention.type,
      applied: true,
      ...(note ? { note } : {}),
      snapshot,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ runId, type: intervention.type, error: msg }, 'intervene via runner failed');
    return fail(`Erro na intervencao "${intervention.type}" do run "${runId}": ${msg}`);
  }
}
