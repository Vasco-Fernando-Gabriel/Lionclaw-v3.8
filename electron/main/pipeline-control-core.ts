
import {
  getHarnessProject,
  listHarnessProjects,
  getPipelinePhaseMessagesAsChatHistory,
  getActiveChatSession,
  getDriveState,
  isDriveEngaged,
} from './db';
import { createPipelineProject, type CreatablePipelineType } from './pipeline-create';
import { getPipelineEngineRef } from './pipeline-engine-ref';
import { getPipelineDriveCoordinator } from './pipeline-drive-coordinator';
import { pipelineEventBus } from './pipeline-event-bus';
import { emitIPC } from './pipeline-shared/ipc-emitter';
import { ensureProjectLock } from './pipeline-shared/lock';
const tryBeginBackgroundWorkStart = (_lane: string): (() => void) | null => () => {};
const UPDATE_MAINTENANCE_START_REFUSED_MESSAGE =
  'Manutencao de atualizacao em andamento.';

import { textProbe } from './pipeline-shared/text-probe';
import {
  conversationPhasesOf,
  getPhaseNumberForAgent,
  getPhasesForProject,
} from '../../src/types/pipeline';
import type { PipelinePhaseNumber } from '../../src/types/pipeline';
import type { HarnessProject } from '../../src/types';
import { resolveBugPhaseDocument } from './bug-paths';
import { createLogger } from './logger';

const logger = createLogger('pipeline-control-core');

export const REPLY_TIMEOUT_MS = 30 * 60 * 1000;

export const PIPELINE_TYPES = [
  'development',
  'development-v2',
  'security',
  'feature',
  'architecture-review',
  'bug',
] as const;

export type PipelineControlType = (typeof PIPELINE_TYPES)[number];

export type ControlResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

function fail(error: string): ControlResult {
  return { ok: false, error };
}

function done(value: unknown): ControlResult {
  return { ok: true, value };
}

export function resolvePendingQuestion(
  projectId: string,
  pipelineType: string | undefined,
  phase: number,
): string | null {
  const conversational = conversationPhasesOf(pipelineType);
  if (!conversational.has(phase)) return null;
  try {
    const history = getPipelinePhaseMessagesAsChatHistory(projectId, phase);
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0) {
        logger.debug(
          { projectId, phase, probe: textProbe(m.content) },
          '(F8) resolvePendingQuestion saida',
        );
        return m.content;
      }
    }
  } catch (err) {
    logger.warn({ projectId, phase, error: (err as Error).message }, 'resolvePendingQuestion failed');
  }
  return null;
}


export interface PhaseChangedCacheEntry {
  phase: number | null;
  status: string;
  awaitingUser: boolean;
}

const phaseChangedCache = new Map<string, PhaseChangedCacheEntry>();
let phaseCacheCleanups: Array<() => void> | null = null;

const PHASE_CACHE_TERMINAL_STATUSES = new Set<string>([
  'done',
  'failed',
  'aborted',
  'pipeline-completed',
]);

export function startPipelineControlPhaseCache(): void {
  if (phaseCacheCleanups) return;
  phaseCacheCleanups = [
    pipelineEventBus.on('pipeline:phase-changed', (payload) => {
      const projectId = payload.projectId;
      if (!projectId) return;
      const status = payload.status ?? '';
      if (PHASE_CACHE_TERMINAL_STATUSES.has(status)) {
        phaseChangedCache.delete(projectId);
        return;
      }
      phaseChangedCache.set(projectId, {
        phase: typeof payload.phase === 'number' ? payload.phase : null,
        status,
        awaitingUser: payload.awaitingUser === true,
      });
    }),
    pipelineEventBus.on('pipeline:reset-complete', (payload) => {
      if (payload.projectId) phaseChangedCache.delete(payload.projectId);
    }),
  ];
  logger.info('pipeline-control phase-changed cache subscribed (F4)');
}

export function getCachedPhaseChanged(projectId: string): PhaseChangedCacheEntry | null {
  return phaseChangedCache.get(projectId) ?? null;
}

export function _resetPipelineControlPhaseCacheForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error(
      '_resetPipelineControlPhaseCacheForTesting can only be called in test environment',
    );
  }
  if (phaseCacheCleanups) {
    for (const off of phaseCacheCleanups) {
      try {
        off();
      } catch {
      }
    }
  }
  phaseCacheCleanups = null;
  phaseChangedCache.clear();
}

export async function awaitNextPause(
  projectId: string,
  send: () => { error: string } | void | Promise<{ error: string } | void>,
): Promise<{ status: 'completed' | 'error' | 'timeout'; detail?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: { status: 'completed' | 'error' | 'timeout'; detail?: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const off of cleanups) {
        try {
          off();
        } catch {
        }
      }
      resolve(result);
    };

    const matchesProject = (id: string | undefined): boolean => id === projectId;

    cleanups.push(
      pipelineEventBus.on('pipeline:agent-completed', (payload) => {
        if (matchesProject(payload.projectId)) finish({ status: 'completed' });
      }),
    );

    cleanups.push(
      pipelineEventBus.on('pipeline:stream', (payload) => {
        if (!matchesProject(payload.projectId)) return;
        if (payload.type === 'done') {
          finish({ status: 'completed' });
        } else if (payload.type === 'error') {
          finish({
            status: 'error',
            detail: typeof payload.message === 'string' ? payload.message : 'pipeline stream error',
          });
        }
      }),
    );

    cleanups.push(
      pipelineEventBus.on('pipeline:error', (payload) => {
        if (!matchesProject(payload.projectId)) return;
        finish({
          status: 'error',
          detail: typeof payload.error === 'string' ? payload.error : 'pipeline error',
        });
      }),
    );

    timer = setTimeout(() => {
      finish({
        status: 'timeout',
        detail:
          `sem evento de fim apos ${Math.round(REPLY_TIMEOUT_MS / 60_000)}min. ` +
          'A mensagem FOI entregue e o agente da fase pode continuar processando em background: ' +
          'use pipeline_inspect para checar o estado antes de reenviar (NAO reenvie a mesma resposta as cegas).',
      });
    }, REPLY_TIMEOUT_MS);

    Promise.resolve()
      .then(send)
      .then((res) => {
        if (res && typeof res === 'object' && 'error' in res) {
          finish({ status: 'error', detail: String(res.error) });
        }
      })
      .catch((err) => {
        finish({ status: 'error', detail: err instanceof Error ? err.message : String(err) });
      });
  });
}


export function pipelineListCore(): ControlResult {
  try {
    const projects = listHarnessProjects();
    const rows = projects.map((p) => ({
      id: p.id,
      name: p.name,
      pipelineType: p.pipelineType ?? 'development',
      status: p.status,
      currentPhase: p.pipelineCurrentPhase ?? p.pipelineStartPhase ?? null,
    }));
    return done(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'pipeline_list failed');
    return fail(`Erro ao listar pipelines: ${msg}`);
  }
}

export function resolvePhaseGateContract(
  pipelineType: string | undefined,
  phase: number,
): { requiredMetadata: string[]; options: string[] } | undefined {
  const type = pipelineType ?? 'development';
  if (type === 'bug' && phase === getPhaseNumberForAgent(type, 'bug-solution-consolidator')) {
    return { requiredMetadata: ['action'], options: ['approve-plan', 'close-pipeline'] };
  }
  if (
    type === 'architecture-review' &&
    phase === getPhaseNumberForAgent(type, 'architecture-target-triage')
  ) {
    return { requiredMetadata: ['selectedCandidateId'], options: [] };
  }
  if (
    type === 'development-v2' &&
    phase === getPhaseNumberForAgent(type, 'open-design-studio')
  ) {
    return { requiredMetadata: ['action'], options: ['lock-and-continue'] };
  }
  return undefined;
}

function resolveRunId(project: HarnessProject): string | undefined {
  switch (project.pipelineType) {
    case 'bug':
      return project.config?.bug?.runId;
    case 'architecture-review':
      return project.config?.architectureReview?.runId;
    case 'development-v2':
      return project.config?.openDesign?.runId;
    default:
      return undefined;
  }
}

function resolveGateDocumentPath(project: HarnessProject, phase: number): string | undefined {
  if (project.pipelineType !== 'bug') return undefined;
  if (phase !== getPhaseNumberForAgent('bug', 'bug-solution-consolidator')) return undefined;
  try {
    const doc = resolveBugPhaseDocument(project, phase as PipelinePhaseNumber);
    return typeof doc === 'string' ? doc : undefined;
  } catch {
    return undefined;
  }
}

export function pipelineInspectCore(id: string): ControlResult {
  try {
    if (!id) return fail('Erro: id obrigatorio');
    const project = getHarnessProject(id);
    if (!project) {
      return fail(`Erro: pipeline "${id}" nao encontrado`);
    }
    const engine = getPipelineEngineRef();
    const live = engine ? engine.getCurrentPhase(id) : null;
    const terminalStatuses = new Set(['done', 'failed', 'aborted']);
    const isTerminal =
      (project.pipelineCurrentPhase === null || project.pipelineCurrentPhase === undefined) &&
      terminalStatuses.has(project.status);
    const phase = isTerminal
      ? null
      : project.pipelineCurrentPhase ?? project.pipelineStartPhase ?? live?.phase ?? 1;
    const status = isTerminal ? project.status : live?.status ?? project.status;
    const pendingQuestion = phase === null
      ? null
      : resolvePendingQuestion(id, project.pipelineType, phase);

    const phaseDef = phase === null
      ? undefined
      : getPhasesForProject({ pipelineType: project.pipelineType }).find((p) => p.number === phase);
    const gate = phase === null ? undefined : resolvePhaseGateContract(project.pipelineType, phase);
    const runId = resolveRunId(project);
    const gateDocumentPath = phase === null ? undefined : resolveGateDocumentPath(project, phase);

    return done({
      id: project.id,
      name: project.name,
      pipelineType: project.pipelineType ?? 'development',
      phase,
      status,
      projectPath: project.projectPath,
      specPath: project.specPath || null,
      pendingQuestion,
      ...(phaseDef ? { phaseName: phaseDef.name, phaseType: phaseDef.type } : {}),
      ...(gate ? { gate } : {}),
      ...(runId ? { runId } : {}),
      ...(gateDocumentPath ? { gateDocumentPath } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ id, error: msg }, 'pipeline_inspect failed');
    return fail(`Erro ao inspecionar pipeline "${id}": ${msg}`);
  }
}

export interface PipelineCreateInput {
  projectPath: string;
  pipelineType: PipelineControlType;
  name: string;
  brief: string;
  drive?: DriveMode;
}

export type DriveMode = 'semi' | 'full';

export function engageOrchestratorDrive(
  projectId: string,
  mode: DriveMode,
): { ok: true; sessionId: string } | { ok: false; error: string } {
  const coordinator = getPipelineDriveCoordinator();
  if (!coordinator) {
    return { ok: false, error: 'coordenador de drive nao inicializado' };
  }
  const sessionId = getActiveChatSession()?.id;
  if (!sessionId) {
    return {
      ok: false,
      error:
        'nenhuma sessao de chat ativa para dirigir o pipeline. Abra/foque um chat e tente de novo.',
    };
  }
  maybeResumePipelineBeforeEngage(projectId);
  const result = coordinator.startDrive(projectId, sessionId, mode);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, sessionId };
}

function maybeResumePipelineBeforeEngage(projectId: string): void {
  try {
    const engine = getPipelineEngineRef();
    if (!engine) return;
    const dbStatus = getHarnessProject(projectId)?.status;
    const liveStatus = engine.getCurrentPhase(projectId)?.status ?? null;
    const needsResume =
      dbStatus === 'interrupted' || dbStatus === 'paused' || liveStatus === 'paused';
    if (!needsResume) return;
    ensureProjectLock(projectId);
    logger.info(
      { projectId, dbStatus, liveStatus },
      '(F5) re-engage com pipeline pausado/interrompido: resumePipeline antes de avaliar o estado',
    );
    Promise.resolve(engine.resumePipeline(projectId)).catch((err: unknown) => {
      logger.error(
        { projectId, error: err instanceof Error ? err.message : String(err) },
        '(F5) resumePipeline no re-engage falhou',
      );
    });
  } catch (err) {
    logger.error(
      { projectId, error: err instanceof Error ? err.message : String(err) },
      '(F5) checagem de resume no re-engage falhou (engage segue)',
    );
  }
}

function runStartAndEngageInBackground(
  engine: NonNullable<ReturnType<typeof getPipelineEngineRef>>,
  projectId: string,
  drive: DriveMode | undefined,
): void {
  void (async () => {
    const startRes = await engine.startPipeline(projectId, 1);
    if (startRes && typeof startRes === 'object' && 'error' in startRes) {
      logger.error(
        { projectId, error: (startRes as { error: string }).error },
        'pipeline_create (background): pipeline criado mas nao iniciou',
      );
      return; // sem start nao ha o que dirigir; o inspect mostra o estado real
    }
    if (drive) {
      const engaged = engageOrchestratorDrive(projectId, drive);
      if (!engaged.ok) {
        logger.warn(
          { projectId, mode: drive, error: engaged.error },
          'pipeline_create (background): pipeline iniciado mas drive nao engatou',
        );
      }
    }
  })().catch((err: unknown) => {
    logger.error(
      { projectId, error: err instanceof Error ? err.message : String(err) },
      'pipeline_create (background): startPipeline/engage falhou apos early-ack',
    );
  });
}

export async function pipelineCreateCore(input: PipelineCreateInput): Promise<ControlResult> {
  const releaseUpdateLease = tryBeginBackgroundWorkStart('pipeline-create');
  if (releaseUpdateLease === null) return fail(UPDATE_MAINTENANCE_START_REFUSED_MESSAGE);
  try {
    return await pipelineCreateCoreWithLease(input);
  } finally {
    releaseUpdateLease();
  }
}

async function pipelineCreateCoreWithLease(input: PipelineCreateInput): Promise<ControlResult> {
  const { projectPath, pipelineType, name, brief, drive } = input;
  try {
    if (!projectPath || !name || !pipelineType) {
      return fail('Erro: projectPath, name e pipelineType sao obrigatorios');
    }
    if (!PIPELINE_TYPES.includes(pipelineType)) {
      return fail(`Erro: pipelineType invalido "${pipelineType}". Use: ${PIPELINE_TYPES.join(' | ')}`);
    }
    if (drive && drive !== 'semi' && drive !== 'full') {
      return fail(`Erro: drive invalido "${drive}". Use: semi | full`);
    }
    const engine = getPipelineEngineRef();
    if (!engine) {
      return fail('Erro: PipelineEngine nao inicializado');
    }
    const project = createPipelineProject({
      name,
      description: brief,
      projectPath,
      startPhase: 1,
      pipelineType: pipelineType as CreatablePipelineType,
    });

    runStartAndEngageInBackground(engine, project.id, drive);

    return done({
      id: project.id,
      name: project.name,
      pipelineType: project.pipelineType ?? pipelineType,
      started: false,
      driveEngaging: Boolean(drive),
      note:
        'pipeline criado; o inicio da fase 1' +
        (drive ? ' e o engate do drive rodam' : ' roda') +
        ' em background. Confirme o estado com pipeline_inspect.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ name, pipelineType, error: msg }, 'pipeline_create failed');
    return fail(`Erro ao criar pipeline: ${msg}`);
  }
}

export function pipelineDriveCore(id: string, mode: DriveMode): ControlResult {
  try {
    if (!id) return fail('Erro: id obrigatorio');
    if (mode !== 'semi' && mode !== 'full') {
      return fail(`Erro: mode invalido "${mode}". Use: semi | full`);
    }
    if (!getHarnessProject(id)) {
      return fail(`Erro: pipeline "${id}" nao encontrado`);
    }
    const engaged = engageOrchestratorDrive(id, mode);
    if (!engaged.ok) {
      return fail(`Erro ao iniciar o drive do pipeline "${id}": ${engaged.error}`);
    }
    return done({ id, driving: true, mode, sessionId: engaged.sessionId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ id, mode, error: msg }, 'pipeline_drive failed');
    return fail(`Erro ao iniciar o drive do pipeline "${id}": ${msg}`);
  }
}

const DB_TERMINAL_STATUSES = new Set<string>(['done', 'failed', 'aborted']);
const ENGINE_TERMINAL_STATUSES = new Set<string>(['aborted']);

export function notifyPipelineMessagesUpdated(projectId: string, phase: number): void {
  try {
    emitIPC('pipeline:messages-updated', { projectId, phase });
  } catch (err) {
    logger.warn(
      { projectId, phase, error: (err as Error).message },
      'notifyPipelineMessagesUpdated falhou (reply nao afetado)',
    );
  }
}


export function driveConductBlocked(projectId: string): string | null {
  const drive = getDriveState(projectId);
  if (!drive) return null;
  if (drive.driver === 'human') {
    return (
      'O humano ASSUMIU este pipeline (handoff permanente). NAO continue a conduzi-lo: ' +
      'nada de pipeline_reply/approve/abort/pause aqui, e NAO re-engaje com pipeline_drive ' +
      'por conta propria. Aguarde instrucoes do humano no chat.'
    );
  }
  if (drive.status === 'stopped') {
    return (
      'O drive deste pipeline foi PARADO pelo humano. NAO continue a conduzi-lo ' +
      '(sem pipeline_reply/approve/abort/pause) e NAO re-engaje com pipeline_drive por conta ' +
      'propria. Se o humano quiser que voce volte, ele vai pedir explicitamente (ou usar Retomar).'
    );
  }
  return null;
}

export async function pipelineReplyCore(id: string, message: string): Promise<ControlResult> {
  const releaseUpdateLease = tryBeginBackgroundWorkStart('pipeline-reply');
  if (releaseUpdateLease === null) return fail(UPDATE_MAINTENANCE_START_REFUSED_MESSAGE);
  try {
    return await pipelineReplyCoreWithLease(id, message);
  } finally {
    releaseUpdateLease();
  }
}

async function pipelineReplyCoreWithLease(id: string, message: string): Promise<ControlResult> {
  try {
    if (!id || typeof message !== 'string') {
      return fail('Erro: id e message sao obrigatorios');
    }
    const engine = getPipelineEngineRef();
    if (!engine) {
      return fail('Erro: PipelineEngine nao inicializado');
    }
    const project = getHarnessProject(id);
    if (!project) {
      return fail(`Erro: pipeline "${id}" nao encontrado`);
    }

    const conductBlocked = driveConductBlocked(id);
    if (conductBlocked) return fail(conductBlocked);

    const live = engine.getCurrentPhase(id);
    if (live && ENGINE_TERMINAL_STATUSES.has(live.status)) {
      return fail(
        `pipeline_reply: o pipeline "${id}" esta "${live.status}" (encerrado) - nao ha turno para responder. Reavalie com pipeline_inspect.`,
      );
    }
    if (DB_TERMINAL_STATUSES.has(project.status)) {
      return fail(
        `pipeline_reply: o pipeline "${id}" esta "${project.status}" (encerrado) - nao ha turno para responder. Reavalie com pipeline_inspect.`,
      );
    }

    const phaseAtReply = live?.phase ?? project.pipelineCurrentPhase ?? project.pipelineStartPhase ?? 1;

    if (project.status === 'interrupted') {
      if (!conversationPhasesOf(project.pipelineType).has(phaseAtReply)) {
        return fail(
          `pipeline_reply: o pipeline "${id}" esta "interrupted" numa fase nao-conversacional ` +
            `(${phaseAtReply}) - nao ha pergunta para responder. Use pipeline_drive(id, mode) para ` +
            're-engajar o drive (a retomada da fase e automatica) e reavalie com pipeline_inspect.',
        );
      }
      ensureProjectLock(id);
      logger.info(
        { id, phase: phaseAtReply },
        '(F5) reply em pipeline "interrupted" de fase conversacional: turno retomavel via sendMessage auto-resume',
      );
    }

    const result = await awaitNextPause(id, async () => {
      const sendResult = await engine.sendMessage(id, message, []);
      notifyPipelineMessagesUpdated(id, phaseAtReply);
      return sendResult;
    });

    if (result.status === 'completed') {
      const liveAfter = engine.getCurrentPhase(id);
      const phase = liveAfter?.phase ?? project.pipelineCurrentPhase ?? 1;
      const pendingQuestion = resolvePendingQuestion(id, project.pipelineType, phase);
      return done({
        id,
        status: 'completed',
        phase,
        liveStatus: liveAfter?.status ?? null,
        pendingQuestion,
      });
    }
    if (result.status === 'timeout') {
      return fail(
        `pipeline_reply: timeout aguardando o fim do turno (${result.detail}). O drive nao travou; reavalie com pipeline_inspect.`,
      );
    }
    return fail(`pipeline_reply falhou: ${result.detail ?? 'erro desconhecido'}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ id, error: msg }, 'pipeline_reply failed');
    return fail(`Erro no pipeline_reply "${id}": ${msg}`);
  }
}

interface EnginePhaseReader {
  getCurrentPhase(projectId: string): { phase: number; status: string } | null;
}

export const APPROVE_EARLY_ACK_GRACE_MS = 1500;

async function awaitAcceptanceWithGrace(
  work: Promise<void>,
  projectId: string,
  action: string,
): Promise<{ settledWithinGrace: boolean }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const outcome = await Promise.race([
    work.then(
      () => ({ kind: 'resolved' as const }),
      (err: unknown) => ({ kind: 'rejected' as const, err }),
    ),
    new Promise<{ kind: 'pending' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'pending' as const }), APPROVE_EARLY_ACK_GRACE_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome.kind === 'rejected') {
    throw outcome.err instanceof Error ? outcome.err : new Error(String(outcome.err));
  }
  if (outcome.kind === 'pending') {
    work.catch((err: unknown) => {
      logger.error(
        { projectId, action, error: err instanceof Error ? err.message : String(err) },
        '(F1) approve aceito (early-ack) mas o avanco em background falhou; use pipeline_inspect para o estado real',
      );
    });
    return { settledWithinGrace: false };
  }
  return { settledWithinGrace: true };
}

function buildApproveResult(
  engine: EnginePhaseReader,
  id: string,
  phaseBefore: number,
  action: 'approve-phase' | 'confirm-start-development',
): ControlResult {
  const liveAfter = engine.getCurrentPhase(id);
  const phaseAfter = liveAfter?.phase ?? null;
  const advanced = phaseAfter !== null && phaseAfter !== phaseBefore;

  const projectAfter = getHarnessProject(id);
  const terminalStatuses = new Set(['done', 'failed', 'aborted']);
  const closed =
    projectAfter !== null &&
    projectAfter !== undefined &&
    (projectAfter.pipelineCurrentPhase === null ||
      projectAfter.pipelineCurrentPhase === undefined) &&
    terminalStatuses.has(projectAfter.status);
  if (closed && projectAfter) {
    return done({
      id,
      approved: true,
      action,
      closed: true,
      ...(projectAfter.config?.bug?.outcome
        ? { outcome: projectAfter.config.bug.outcome }
        : {}),
      phase: null,
      liveStatus: projectAfter.status,
      advanced: false,
    });
  }

  let warning: string | undefined;
  if (!advanced) {
    const cachedAfter = getCachedPhaseChanged(id);
    if (action === 'approve-phase' && cachedAfter?.status === 'awaiting-dev-confirmation') {
      warning =
        'aprovacao aceita: a conversa do Sprint Validator finalizou e o gate pre-codigo abriu ' +
        '(awaiting-dev-confirmation). Chame pipeline_approve de novo neste pipeline para iniciar o Coder.';
    } else {
      warning =
        'aprovacao aceita mas a fase NAO avancou ate aqui (a proxima fase pode estar finalizando em ' +
        'background, ou o approve foi no-op no engine). Confirme o estado real com pipeline_inspect antes de repetir.';
    }
  }
  return done({
    id,
    approved: true,
    action,
    phase: phaseAfter,
    liveStatus: liveAfter?.status ?? null,
    advanced,
    ...(warning ? { warning } : {}),
  });
}

export async function pipelineApproveCore(
  id: string,
  metadata?: Record<string, unknown>,
): Promise<ControlResult> {
  const releaseUpdateLease = tryBeginBackgroundWorkStart('pipeline-approve');
  if (releaseUpdateLease === null) return fail(UPDATE_MAINTENANCE_START_REFUSED_MESSAGE);
  try {
    return await pipelineApproveCoreWithLease(id, metadata);
  } finally {
    releaseUpdateLease();
  }
}

async function pipelineApproveCoreWithLease(
  id: string,
  metadata?: Record<string, unknown>,
): Promise<ControlResult> {
  try {
    if (!id) return fail('Erro: id obrigatorio');
    const engine = getPipelineEngineRef();
    if (!engine) {
      return fail('Erro: PipelineEngine nao inicializado');
    }
    const project = getHarnessProject(id);
    if (!project) {
      return fail(`Erro: pipeline "${id}" nao encontrado`);
    }
    const conductBlocked = driveConductBlocked(id);
    if (conductBlocked) return fail(conductBlocked);

    const pipelineType = project.pipelineType ?? 'development';
    const live = engine.getCurrentPhase(id);
    const phaseBefore =
      live?.phase ?? project.pipelineCurrentPhase ?? project.pipelineStartPhase ?? 1;
    const cached = getCachedPhaseChanged(id);

    const sprintValidatorPhase = getPhaseNumberForAgent(pipelineType, 'sprint-validator');
    if (
      cached?.status === 'awaiting-dev-confirmation' &&
      sprintValidatorPhase !== undefined &&
      phaseBefore === sprintValidatorPhase
    ) {
      logger.info(
        { id, phase: phaseBefore, pipelineType },
        'pipeline_approve em awaiting-dev-confirmation -> confirmStartDevelopment (F4)',
      );
      await awaitAcceptanceWithGrace(
        Promise.resolve(engine.confirmStartDevelopment(id)),
        id,
        'confirm-start-development',
      );
      return buildApproveResult(engine, id, phaseBefore, 'confirm-start-development');
    }

    const allowedPhases = conversationPhasesOf(pipelineType);
    if (!allowedPhases.has(phaseBefore)) {
      const def = getPhasesForProject({ pipelineType }).find((p) => p.number === phaseBefore);
      const phaseLabel = def ? `${phaseBefore} (${def.name})` : String(phaseBefore);
      const phaseKind = def?.type === 'loop' ? 'loop' : 'auto';
      return fail(
        `pipeline_approve: fase ${phaseLabel} nao aceita aprovacao no pipeline ${pipelineType}; ` +
          `a fase atual e ${phaseKind} (sem gate de aprovacao). Use pipeline_inspect para ver o estado real.`,
      );
    }

    if (
      pipelineType === 'architecture-review' &&
      phaseBefore === getPhaseNumberForAgent(pipelineType, 'architecture-target-triage')
    ) {
      const selectedCandidateId = metadata?.['selectedCandidateId'];
      if (typeof selectedCandidateId !== 'string' || selectedCandidateId.trim().length === 0) {
        return fail(
          `pipeline_approve: a fase ${phaseBefore} (Triagem de Alvos) do architecture-review exige ` +
            'metadata.selectedCandidateId (string nao-vazia) com o id do candidato escolhido. ' +
            'Exemplo: pipeline_approve(id, { selectedCandidateId: "C1" }).',
        );
      }
    }
    if (
      pipelineType === 'development-v2' &&
      phaseBefore === getPhaseNumberForAgent(pipelineType, 'open-design-studio')
    ) {
      const driveEngaged = isDriveEngaged(id);
      if (driveEngaged && metadata?.['action'] === 'lock-and-continue') {
        return fail(
          'Design Lock e gate humano: o dono valida e trava na UI; voce sera ' +
            'acordado quando a fase avancar',
        );
      }
      if (metadata?.['action'] !== 'lock-and-continue') {
        return fail(
          `pipeline_approve: a fase ${phaseBefore} (LionDesign Studio) do development-v2 exige ` +
            'metadata.action === "lock-and-continue" para travar o design e avancar. ' +
            'Exemplo: pipeline_approve(id, { action: "lock-and-continue" }).',
        );
      }
    }
    if (
      pipelineType === 'bug' &&
      phaseBefore === getPhaseNumberForAgent(pipelineType, 'bug-solution-consolidator')
    ) {
      const action = metadata?.['action'];
      if (action !== 'approve-plan' && action !== 'close-pipeline') {
        const gateDoc = resolveGateDocumentPath(project, phaseBefore);
        return fail(
          `pipeline_approve: a fase ${phaseBefore} (Consolidacao) do pipeline bug e um gate de DOIS ` +
            'desfechos e exige metadata.action === "approve-plan" (gera a SPEC e segue) ou ' +
            '"close-pipeline" (encerra o pipeline com status done, sem SPEC). ' +
            (gateDoc
              ? `Leia ${gateDoc} e confira o campo "## Desfecho" antes de escolher. `
              : 'Consulte pipeline_inspect para o gateDocumentPath do plano antes de escolher. ') +
            'Exemplo: pipeline_approve(id, { action: "approve-plan" }).',
        );
      }
    }

    const pendingQuestion = resolvePendingQuestion(id, pipelineType, phaseBefore);
    const gateOpenCached =
      cached !== null && (cached.awaitingUser || cached.status === 'awaiting-dev-confirmation');
    if (live?.status === 'running' && pendingQuestion === null && !gateOpenCached) {
      return fail(
        `pipeline_approve: a fase ${phaseBefore} esta "running" SEM pergunta pendente nem gate aberto - ` +
          'o agente da fase provavelmente ainda esta trabalhando; aprovar agora agiria no gate errado. ' +
          'Aguarde o fim do turno e reavalie com pipeline_inspect.',
      );
    }

    await awaitAcceptanceWithGrace(
      Promise.resolve(engine.approvePhase(id, metadata)),
      id,
      'approve-phase',
    );
    return buildApproveResult(engine, id, phaseBefore, 'approve-phase');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ id, error: msg }, 'pipeline_approve failed');
    return fail(`Erro ao aprovar pipeline "${id}": ${msg}`);
  }
}

export function pipelineAbortCore(id: string): ControlResult {
  try {
    if (!id) return fail('Erro: id obrigatorio');
    const engine = getPipelineEngineRef();
    if (!engine) {
      return fail('Erro: PipelineEngine nao inicializado');
    }
    if (!getHarnessProject(id)) {
      return fail(`Erro: pipeline "${id}" nao encontrado`);
    }
    const conductBlocked = driveConductBlocked(id);
    if (conductBlocked) return fail(conductBlocked);
    engine.abortPipeline(id);
    return done({ id, aborted: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ id, error: msg }, 'pipeline_abort failed');
    return fail(`Erro ao abortar pipeline "${id}": ${msg}`);
  }
}

export function pipelinePauseCore(id: string): ControlResult {
  try {
    if (!id) return fail('Erro: id obrigatorio');
    const engine = getPipelineEngineRef();
    if (!engine) {
      return fail('Erro: PipelineEngine nao inicializado');
    }
    if (!getHarnessProject(id)) {
      return fail(`Erro: pipeline "${id}" nao encontrado`);
    }
    const conductBlocked = driveConductBlocked(id);
    if (conductBlocked) return fail(conductBlocked);
    engine.pausePipeline(id);
    return done({ id, paused: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ id, error: msg }, 'pipeline_pause failed');
    return fail(`Erro ao pausar pipeline "${id}": ${msg}`);
  }
}

export function pipelineEscalateCore(id: string, message: string): ControlResult {
  try {
    if (!id || typeof message !== 'string' || message.trim().length === 0) {
      return fail('Erro: id e message sao obrigatorios');
    }
    if (!getHarnessProject(id)) {
      return fail(`Erro: pipeline "${id}" nao encontrado`);
    }
    const conductBlocked = driveConductBlocked(id);
    if (conductBlocked) return fail(conductBlocked);
    const coordinator = getPipelineDriveCoordinator();
    if (!coordinator) {
      return fail('Erro: coordenador de drive nao inicializado');
    }
    const escalated = coordinator.escalateFromOrchestrator(id, message);
    if (!escalated.ok) {
      return fail(`Erro ao escalar o pipeline "${id}": ${escalated.error}`);
    }
    return done({ id, escalated: true, status: escalated.drive.status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ id, error: msg }, 'pipeline_escalate failed');
    return fail(`Erro ao escalar pipeline "${id}": ${msg}`);
  }
}

export interface DesignSessionConfigRequest {
  id: string;
  agentId?: string;
  model?: string;
  reasoning?: 'low' | 'medium' | 'high';
  designSystemId?: string;
}

export async function designSessionConfigCore(
  req: DesignSessionConfigRequest,
): Promise<ControlResult> {
  const { id, agentId, model, reasoning, designSystemId } = req;
  try {
    if (!id) {
      return fail('Erro: id e obrigatorio');
    }
    const conductBlocked = driveConductBlocked(id);
    if (conductBlocked) return fail(conductBlocked);

    const { applyDesignSessionConfig } = await import('./open-design/session-config-tool');
    const result = await applyDesignSessionConfig(id, {
      agentId,
      model,
      reasoning,
      designSystemId,
    });
    if ('error' in result) return fail(result.error);
    return done(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ id, error: msg }, 'design_session_config failed');
    return fail(`Erro no design_session_config "${id}": ${msg}`);
  }
}

export function normalizeApproveMetadata(
  metadata: Record<string, unknown> | string | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  if (typeof metadata !== 'string') return metadata;

  const hint =
    'metadata deve ser um objeto JSON (ou a string JSON equivalente). ' +
    'Exemplos: { "action": "lock-and-continue" } para o Design Lock do development-v2; ' +
    '{ "selectedCandidateId": "C1" } para a Triagem do architecture-review.';

  const trimmed = metadata.trim();
  if (trimmed.length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`metadata chegou como string mas nao e JSON valido (${msg}). ${hint}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'metadata chegou como string JSON mas nao representa um objeto ' +
        `(recebi ${Array.isArray(parsed) ? 'array' : typeof parsed}). ${hint}`,
    );
  }
  return parsed as Record<string, unknown>;
}

export const PIPELINE_WRITE_ACTIONS = new Set<string>([
  'pipeline_create',
  'pipeline_drive',
  'pipeline_reply',
  'pipeline_approve',
  'pipeline_escalate',
  'pipeline_abort',
  'pipeline_pause',
  'design_session_config',
]);

export function isPipelineWriteAction(action: string): boolean {
  return PIPELINE_WRITE_ACTIONS.has(action);
}
