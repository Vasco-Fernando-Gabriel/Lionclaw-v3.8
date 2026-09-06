
import path from 'path';
import { BrowserWindow } from 'electron';
import type { DriveState, HarnessProject, LiveActivityEvent, StreamChunk } from '../../src/types';
import {
  getDriveState,
  setDriveState,
  getHarnessProject,
  listHarnessProjects,
  getLatestUserTurnIndex,
} from './db';
import {
  pipelineEventBus,
  type PipelinePhaseChangedEvent,
  type PipelineStreamEvent,
  type PipelineSprintCompleteEvent,
  type PipelineErrorEvent,
} from './pipeline-event-bus';
import {
  acquireDriveLock,
  releaseDriveLock,
  activeDriveProjectId,
} from './drive-lock';
import { pushAssistantMessage, pushDrivePaused } from './chat-push';
import { onDriveTurnUsage, onDriveTurnComplete } from './drive-usage-sink';
import {
  checkAntiRunaway,
  mintDriveTurnId as mintDriveTurnIdCore,
  decideOneInFlight,
  type DriveTurnSeq,
} from './drive-turn-core';
import { recordActivity } from './activity-log';
import { emitIPC } from './pipeline-shared/ipc-emitter';
import { submitMessage } from './orchestrator';
import {
  createInternalCapabilityLease,
  type InternalCapabilityCoordinator,
} from './chat-capability-lease';
import type { ChatCapabilityName } from './chat-capability-context';
import { resolvePendingQuestion, getCachedPhaseChanged } from './pipeline-control-core';
import {
  getPhasesForProject,
  conversationPhasesOf,
  type PhaseDefinition,
  type PipelinePhaseNumber,
} from '../../src/types/pipeline';
import { resolveBugPhaseDocument } from './bug-paths';
import { createLogger } from './logger';

const logger = createLogger('pipeline-drive-coordinator');


export const MAX_ORCHESTRATOR_TURNS_PER_PHASE = 15;

export const MAX_TURNS_PER_DRIVE = 60;

export const DRIVE_TOKEN_BUDGET = 15_000_000;

export const TURN_INFLIGHT_TIMEOUT_MS = 10 * 60_000;

export const DRIVE_LEASE_TTL_MS = 30 * 60_000;

export const DRIVE_LEASE_MAX_USES = 64;

export const GREETING_DONE_TIMEOUT_MS = 3 * 60_000;

export const DRIVE_TICK_INTERVAL_MS = 5 * 60_000;

export const DRIVE_TICK_MAX_IDLE = 3;


const CONTROL_GATE_AGENT_IDS: Record<string, string[]> = {
  development: ['prd-validator', 'spec-enricher', 'sprint-validator'],
  feature: ['feat-prd-validator', 'spec-enricher', 'sprint-validator'],
  'development-v2': ['prd-validator', 'pipe2-spec-enricher', 'sprint-validator'],
  security: [
    'security-skeptic-security',
    'security-skeptic-quality',
    'spec-enricher',
    'sprint-validator',
  ],
  'architecture-review': [
    'architecture-decision-interviewer',
    'arch-spec-validator',
    'architecture-spec-enricher',
    'sprint-validator',
  ],
  bug: ['bug-solution-consolidator', 'bug-spec-validator', 'sprint-validator'],
};

const HUMAN_GATE_AGENT_IDS: Record<string, string[]> = {
  'development-v2': ['open-design-studio'],
  'architecture-review': ['architecture-target-triage'],
};

const REQUIRES_HUMAN_AGENT_IDS: Record<string, string[]> = {
  'development-v2': ['design-lock'],
};

function resolveRequiresHumanPhases(pipelineType: string | undefined): number[] {
  const agentIds = REQUIRES_HUMAN_AGENT_IDS[pipelineType ?? 'development'] ?? [];
  if (agentIds.length === 0) return [];
  const phases = getPhasesForProject({ pipelineType });
  return phases.filter((p) => agentIds.includes(p.agentId)).map((p) => p.number);
}

export function isControlGate(pipelineType: string | undefined, phase: number): boolean {
  const agentIds = CONTROL_GATE_AGENT_IDS[pipelineType ?? 'development'] ?? [];
  if (agentIds.length === 0) return false;
  const def = getPhasesForProject({ pipelineType }).find((p) => p.number === phase);
  return def ? agentIds.includes(def.agentId) : false;
}

export function isHumanGate(pipelineType: string | undefined, phase: number): boolean {
  const agentIds = HUMAN_GATE_AGENT_IDS[pipelineType ?? 'development'] ?? [];
  if (agentIds.length === 0) return false;
  const def = getPhasesForProject({ pipelineType }).find((p) => p.number === phase);
  return def ? agentIds.includes(def.agentId) : false;
}


function phaseNumberByAgentId(pipelineType: string | undefined, agentId: string): number | null {
  const def = getPhasesForProject({ pipelineType }).find((p) => p.agentId === agentId);
  return def ? def.number : null;
}

function resolveBugPlanPath(project: HarnessProject): string | null {
  if (project.pipelineType !== 'bug') return null;
  try {
    const phase = phaseNumberByAgentId('bug', 'bug-solution-consolidator') ?? 3;
    const doc = resolveBugPhaseDocument(project, phase as PipelinePhaseNumber);
    return typeof doc === 'string' ? doc : null;
  } catch {
    return null;
  }
}

function gateContractLines(
  pipelineType: string | undefined,
  gateDocumentPath?: string | null,
): string[] {
  const type = pipelineType ?? 'development';
  if (type === 'bug') {
    const consolidationPhase = phaseNumberByAgentId(type, 'bug-solution-consolidator');
    const sprintValidatorPhase = phaseNumberByAgentId(type, 'sprint-validator');
    const planoLine = gateDocumentPath
      ? `  Antes de escolher, LEIA ${gateDocumentPath} e confira o campo "## Desfecho".`
      : '  Antes de escolher, consulte pipeline_inspect para o gateDocumentPath e leia o campo "## Desfecho" do plano.';
    return [
      'CONTRATO DE GATES deste pipeline (bug):',
      `- Fase ${consolidationPhase ?? '?'} (Consolidacao): gate de DOIS desfechos, metadata OBRIGATORIA.`,
      "  pipeline_approve(id, { action: 'approve-plan' })   -> gera a SPEC e segue.",
      "  pipeline_approve(id, { action: 'close-pipeline' }) -> encerra o pipeline com",
      '  status done, sem gerar SPEC. Use quando o plano concluir que NAO ha bug, que o',
      '  bug ja estava corrigido, ou que o escopo esta errado.',
      planoLine,
      `- Fase ${sprintValidatorPhase ?? '?'} (Sprint Validator): gate pre-codigo. Confirmacao de inicio de ` +
        'desenvolvimento; nao aceita metadata.',
    ];
  }
  if (type === 'architecture-review') {
    const triagePhase = phaseNumberByAgentId(type, 'architecture-target-triage');
    const decisionPhase = phaseNumberByAgentId(type, 'architecture-decision-interviewer');
    return [
      'CONTRATO DE GATES deste pipeline (architecture-review):',
      `- Gate da fase ${triagePhase ?? '?'} (Triagem de Alvos): pipeline_approve(id, { selectedCandidateId }) ` +
        'com o candidato escolhido a partir do pipeline_inspect; sem esse metadata o approve nao passa.',
      `- Gate da fase ${decisionPhase ?? '?'} (Entrevista de Decisao): so aprove quando o decisions.md tiver ` +
        'pelo menos 1 secao "## DN"; se faltar, conduza a conversa (pipeline_reply) ate a decisao existir.',
      '- Demais gates: pipeline_approve(id) simples, sem metadata.',
    ];
  }
  if (type === 'development-v2') {
    const studioPhase = phaseNumberByAgentId(type, 'open-design-studio');
    return [
      'CONTRATO DE GATES deste pipeline (development-v2):',
      `- Gate do Design Lock (fase ${studioPhase ?? '?'} - LionDesign Studio): NAO e seu. ` +
        'A fase do design e do DONO, na UI - ele escolhe provider/modelo, inicia a geracao ' +
        'e trava o layout. Voce NAO aprova o lock por tool e NAO interage com a sessao: voce ' +
        'DORME nesta fase e e acordado no proximo ponto acionavel pos-lock (fase Database).',
      '- Demais gates: pipeline_approve(id) simples, sem metadata.',
    ];
  }
  return [
    `CONTRATO DE GATES deste pipeline (${type}): nao ha metadata especial de gate; ` +
      'pipeline_approve(id) simples.',
  ];
}


function previewOpenLines(
  project: NonNullable<ReturnType<typeof getHarnessProject>>,
  phaseDef: PhaseDefinition | undefined,
): string[] {
  const openDesign = project.config?.openDesign;
  const postLock = project.pipelineType === 'development-v2' && openDesign?.locked === true;
  const executionPhase = phaseDef?.type === 'loop';
  if (!postLock && !executionPhase) return [];

  const lines: string[] = [
    'PREVIEW VISUAL (tool preview_open):',
    '- Para mostrar o resultado ao humano, use preview_open com o path do artifact. ' +
      'PROPONHA antes; nao abra sem o humano pedir/concordar.',
  ];
  if (postLock) {
    const artifactPath =
      openDesign?.artifactHtmlPath ??
      (openDesign?.runDir
        ? path.join(openDesign.runDir, 'open-design', 'snapshots', 'latest', 'artifact', 'index.html')
        : '<runDir>/open-design/snapshots/latest/artifact/index.html');
    lines.push(`- Artifact canonico do design (pos Design Lock): ${artifactPath}`);
  }
  if (executionPhase) {
    lines.push(
      '- Fases de execucao: use o caminho ABSOLUTO do HTML navegavel que o coder produziu ' +
        `(dentro de ${project.projectPath}); urls http(s) de localhost tambem passam na validacao.`,
    );
  }
  return lines;
}


function operatingContractLines(
  phaseDef: PhaseDefinition | undefined,
  specReviewOpen = false,
): string[] {
  const lines: string[] = ['COMO VOCE OPERA:'];
  lines.push(
    '- Voce opera em turnos REATIVOS. Faca a acao deste turno, reporte no chat se relevante, ' +
      'e ENCERRE o turno.',
  );
  lines.push(
    '- NUNCA monitore, aguarde, faca polling (ls/ps/tail/sleep, pipeline_inspect repetido) ' +
      'nem leia o banco de dados direto (Bash sqlite / .lionclaw/data/lionclaw.db). ' +
      'Vigiar dentro do turno NAO acelera nada: o proximo turno so pode chegar quando este encerrar.',
  );
  lines.push('- Voce SERA acordado automaticamente por um turno novo quando:');
  lines.push('  - a fase mudar (inclusive quando o dono travar o Design Lock);');
  lines.push('  - uma pergunta abrir;');
  lines.push('  - um erro/stall ocorrer (eu pauso e te pergunto como seguir);');
  lines.push('  - o humano intervir.');
  lines.push(
    '- NAO especule nem anuncie a proxima fase ("depois vem a SPEC, os sprints..."). Aja apenas ' +
      'sobre a fase ATUAL deste turno; voce sera acordado quando for a hora da proxima.',
  );
  if (specReviewOpen) {
    lines.push(
      '- Fase da SPEC em REVISAO CONVERSACIONAL: o loop automatico (builder/validator) TERMINOU ' +
        'e o validator abriu a revisao. Este gate e SEU neste turno: leia a saida pendente, converse ' +
        'com pipeline_reply se precisar de ajustes na SPEC e, quando ela estiver alinhada a intencao, ' +
        'aprove com pipeline_approve. NAO encerre o turno sem decidir (responder ou aprovar).',
    );
  } else if (phaseDef?.agentId === 'open-design-studio') {
    lines.push(
      '- Fase do LionDesign: esta fase e 100% do DONO, na UI. Ele escolhe o provider/modelo, ' +
        'inicia a geracao e VALIDA/TRAVA o layout (Design Lock). Voce NAO inicia nada, NAO ' +
        'configura a sessao e NAO interage: voce DORME nesta fase. O lock do dono avanca a fase ' +
        'e te acorda no proximo ponto acionavel (fase Database).',
    );
  } else if (phaseDef?.type === 'conversation') {
    lines.push(
      '- Fase CONVERSACIONAL: responda com pipeline_reply. O RESULTADO da tool ja traz a proxima ' +
        'pergunta do agente (ou o fim da fase), entao encadeie as respostas no MESMO turno. Quando o ' +
        'resultado indicar fim de fase ou gate, encerre o turno.',
    );
  } else if (phaseDef?.type === 'auto') {
    lines.push(
      '- Fase AUTOMATICA rodando: NAO ha nada a fazer. Encerre o turno IMEDIATAMENTE; o aviso de ' +
        'conclusao e o seu proximo turno.',
    );
  } else if (phaseDef?.type === 'loop') {
    lines.push(
      '- Fase de EXECUCAO (loop): voce sera acordado por MARCO (sprint concluida / avaliacao ' +
        'fechada), nao por progresso. Encerre o turno.',
    );
  }
  return lines;
}


type PhaseChangedPayload = PipelinePhaseChangedEvent;
type StreamPayload = PipelineStreamEvent;
type SprintCompletePayload = PipelineSprintCompleteEvent;
type ErrorPayload = PipelineErrorEvent;

interface DriveRuntimeState {
  drive: DriveState;
  lastTurnPhase: number | null;
  turnsThisPhase: number;
  turnsThisDrive: number;
  tokensSpent: number;
  handoffTemporaryPhase: number | null;
  reacting: boolean;
  activityPhaseStart: Map<number, string>;
  pendingHumanInterject: string | null;
  turnInFlightSince: number | null;
  currentDriveTurnId: string | null;
  pendingFollowup: { reason: string } | null;
  tickTimer: NodeJS.Timeout | null;
  tickIdleCount: number;
  tickLastSnapshot: string | null;
  pendingTickTurn: boolean;
  designBandAnnounced: boolean;
}


export class PipelineDriveCoordinator {
  private readonly states = new Map<string, DriveRuntimeState>();
  private readonly cleanups: Array<() => void> = [];
  private started = false;
  private readonly globalTurnSeq: DriveTurnSeq = { value: 0 };

  private readonly pendingGreetings = new Map<
    string,
    { armedAt: number; timer: NodeJS.Timeout | null; timedOut: boolean }
  >();
  private readonly greetingDoneSeen = new Set<string>();

  private readonly completionAnnounced = new Set<string>();

  private readonly tickTurnIds = new Set<string>();

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  private greetingKey(projectId: string, phase: number): string {
    return `${projectId}:${phase}`;
  }

  private armGreetingGate(projectId: string, phase: number): void {
    const key = this.greetingKey(projectId, phase);
    const existing = this.pendingGreetings.get(key);
    if (existing && !existing.timedOut) return;
    if (existing?.timer) clearTimeout(existing.timer);
    this.greetingDoneSeen.delete(key);

    const entry: { armedAt: number; timer: NodeJS.Timeout | null; timedOut: boolean } = {
      armedAt: Date.now(),
      timer: null,
      timedOut: false,
    };
    entry.timer = setTimeout(() => {
      this.onGreetingTimeout(projectId, phase);
    }, GREETING_DONE_TIMEOUT_MS);
    this.pendingGreetings.set(key, entry);
    logger.info({ projectId, phase }, 'armGreetingGate: greeting-gate armado (aguardando stream done)');
  }

  private touchGreetingGate(projectId: string, phase: number): void {
    const entry = this.pendingGreetings.get(this.greetingKey(projectId, phase));
    if (!entry || entry.timedOut || !entry.timer) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      this.onGreetingTimeout(projectId, phase);
    }, GREETING_DONE_TIMEOUT_MS);
  }

  private disarmGreetingGate(projectId: string, phase: number): void {
    const key = this.greetingKey(projectId, phase);
    const entry = this.pendingGreetings.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
    this.pendingGreetings.delete(key);
    this.greetingDoneSeen.add(key);
  }

  private onGreetingTimeout(projectId: string, phase: number): void {
    const key = this.greetingKey(projectId, phase);
    const entry = this.pendingGreetings.get(key);
    if (!entry) return; // ja desarmado pelo done (corrida benigna).
    entry.timedOut = true;
    entry.timer = null;
    const rt = this.liveStateOf(projectId);
    if (rt) {
      this.escalate(
        projectId,
        rt,
        `A fase ${phase} ficou em silencio ao iniciar (nenhuma atividade do agente por ` +
          `${Math.round(GREETING_DONE_TIMEOUT_MS / 60_000)} minutos; o greeting nao fechou). ` +
          `O drive pausou aguardando voce. Quer que eu tente de novo (responda "retomar") ou prefere assumir?`,
        { reason: 'greeting-timeout' },
      );
    } else {
      logger.info(
        { projectId, phase },
        'onGreetingTimeout: greeting nao fechou e sem drive engajado; marcado timedOut (escala no engate tardio)',
      );
    }
  }

  private clearGreetingGatesForProject(projectId: string): void {
    const prefix = `${projectId}:`;
    for (const [key, entry] of this.pendingGreetings) {
      if (!key.startsWith(prefix)) continue;
      if (entry.timer) clearTimeout(entry.timer);
      this.pendingGreetings.delete(key);
    }
  }

  private clearTickTurnIdsForProject(projectId: string): void {
    const prefix = `${projectId}:`;
    for (const id of this.tickTurnIds) {
      if (id.startsWith(prefix)) this.tickTurnIds.delete(id);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;


    this.cleanups.push(
      pipelineEventBus.on('pipeline:phase-changed', (p) => this.onPhaseChanged(p)),
    );
    this.cleanups.push(
      pipelineEventBus.on('pipeline:phase-changed', (p) =>
        this.onPipelineCompleted(p),
      ),
    );
    this.cleanups.push(
      pipelineEventBus.on('pipeline:stream', (p) => this.onStream(p)),
    );
    this.cleanups.push(
      pipelineEventBus.on('pipeline:sprint-complete', (p) => this.onSprintComplete(p)),
    );
    this.cleanups.push(
      pipelineEventBus.on('pipeline:error', (p) => this.onError(p)),
    );
    this.cleanups.push(
      pipelineEventBus.on('pipeline:human-message', (p) => this.onHumanMessage(p)),
    );

    this.cleanups.push(
      onDriveTurnUsage((usage) => this.onDriveTurnUsage(usage)),
    );

    this.cleanups.push(
      onDriveTurnComplete((complete) => this.onDriveTurnComplete(complete)),
    );

    logger.info('PipelineDriveCoordinator started (bus subscribed)');
  }

  stop(): void {
    for (const off of this.cleanups) {
      try {
        off();
      } catch {
      }
    }
    this.cleanups.length = 0;
    for (const rt of this.states.values()) {
      if (rt.tickTimer) clearTimeout(rt.tickTimer);
    }
    this.states.clear();
    for (const entry of this.pendingGreetings.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.pendingGreetings.clear();
    this.greetingDoneSeen.clear();
    this.tickTurnIds.clear();
    this.completionAnnounced.clear();
    this.started = false;
  }


  startDrive(
    projectId: string,
    sessionId: string,
    mode: 'semi' | 'full',
  ): { ok: true; drive: DriveState } | { ok: false; error: string } {
    const project = getHarnessProject(projectId);
    if (!project) {
      return { ok: false, error: `pipeline "${projectId}" nao encontrado` };
    }

    const existingRt = this.states.get(projectId);
    if (
      existingRt &&
      existingRt.drive.driver === 'orchestrator' &&
      existingRt.drive.status === 'driving'
    ) {
      return { ok: true, drive: existingRt.drive };
    }

    const lock = acquireDriveLock(projectId);
    if (!lock.ok) {
      return {
        ok: false,
        error: `ja existe um drive ativo no projeto "${lock.activeProjectId}". Pare-o (ou Assumir) antes de iniciar outro.`,
      };
    }

    const requiresHumanPhases = resolveRequiresHumanPhases(project.pipelineType);
    const drive = setDriveState(projectId, {
      driver: 'orchestrator',
      status: 'driving',
      handoff: 'none',
      mode,
      sessionId,
      requiresHumanPhases,
      startedAt: new Date().toISOString(),
    });

    this.states.set(projectId, {
      drive,
      lastTurnPhase: null,
      turnsThisPhase: 0,
      turnsThisDrive: 0,
      tokensSpent: 0,
      reacting: false,
      activityPhaseStart: new Map(),
      handoffTemporaryPhase: null,
      pendingHumanInterject: null,
      turnInFlightSince: null,
      currentDriveTurnId: null,
      pendingFollowup: null,
      tickTimer: null,
      tickIdleCount: 0,
      tickLastSnapshot: null,
      pendingTickTurn: false,
      designBandAnnounced: false,
    });

    logger.info({ projectId, sessionId, mode }, 'startDrive: orchestrator now driving');
    this.notifyDriveChanged(projectId, drive);

    this.armTick(projectId);

    this.evaluateNow(projectId);

    return { ok: true, drive };
  }

  getDrive(projectId: string): DriveState | null {
    const rt = this.states.get(projectId);
    return rt ? rt.drive : getDriveState(projectId);
  }


  assumirDrive(projectId: string): { ok: true; drive: DriveState } | { ok: false; error: string } {
    const existing = this.getDrive(projectId);
    if (!existing) {
      return { ok: false, error: `nenhum drive em "${projectId}"` };
    }
    const drive = setDriveState(projectId, {
      driver: 'human',
      status: 'stopped',
      handoff: 'permanent',
    });
    const rtAssume = this.states.get(projectId);
    if (rtAssume?.tickTimer) clearTimeout(rtAssume.tickTimer);
    this.states.delete(projectId);
    if (activeDriveProjectId() === projectId) {
      releaseDriveLock();
    }
    logger.info({ projectId }, 'assumirDrive: human took over (drive ended)');
    this.notifyDriveChanged(projectId, drive);
    return { ok: true, drive };
  }

  stopDrive(projectId: string, reason?: string): void {
    const rt = this.states.get(projectId);
    if (!rt && !getDriveState(projectId)) return;
    if (rt?.tickTimer) clearTimeout(rt.tickTimer);
    this.clearTickTurnIdsForProject(projectId);
    const drive = setDriveState(projectId, { status: 'stopped' });
    this.states.delete(projectId);
    this.clearGreetingGatesForProject(projectId);
    if (activeDriveProjectId() === projectId) {
      releaseDriveLock();
    }
    logger.info({ projectId, reason }, 'stopDrive: drive stopped');
    this.notifyDriveChanged(projectId, drive);
  }

  resumeDrive(
    projectId: string,
    opts?: { humanInterject?: string; fromHuman?: boolean },
  ): { ok: true; drive: DriveState } | { ok: false; error: string } {
    const persisted = getDriveState(projectId);
    if (!persisted) {
      return { ok: false, error: `nenhum drive em "${projectId}"` };
    }
    if (persisted.driver !== 'orchestrator') {
      return { ok: false, error: 'o humano assumiu este projeto; nao ha drive de orquestrador para retomar' };
    }
    const project = getHarnessProject(projectId);
    if (!project) {
      return { ok: false, error: `pipeline "${projectId}" nao encontrado` };
    }

    const lock = acquireDriveLock(projectId);
    if (!lock.ok) {
      return {
        ok: false,
        error: `ja existe um drive ativo no projeto "${lock.activeProjectId}".`,
      };
    }

    const drive = setDriveState(projectId, {
      status: 'driving',
      handoff: 'none',
      startedAt: new Date().toISOString(),
    });
    const prev = this.states.get(projectId);
    if (prev?.tickTimer) clearTimeout(prev.tickTimer);
    this.states.set(projectId, {
      drive,
      lastTurnPhase: prev?.lastTurnPhase ?? null,
      turnsThisPhase: 0,
      turnsThisDrive: opts?.fromHuman ? 0 : (prev?.turnsThisDrive ?? 0),
      tokensSpent: opts?.fromHuman ? 0 : (prev?.tokensSpent ?? 0),
      reacting: false,
      activityPhaseStart: prev?.activityPhaseStart ?? new Map(),
      handoffTemporaryPhase: null,
      pendingHumanInterject: opts?.humanInterject ?? prev?.pendingHumanInterject ?? null,
      turnInFlightSince: null,
      currentDriveTurnId: null,
      pendingFollowup: null,
      tickTimer: null,
      tickIdleCount: 0,
      tickLastSnapshot: null,
      pendingTickTurn: false,
      designBandAnnounced: prev?.designBandAnnounced ?? false,
    });
    logger.info({ projectId }, 'resumeDrive: orchestrator drive resumed');
    this.notifyDriveChanged(projectId, drive);
    this.armTick(projectId);
    this.evaluateNow(projectId);
    return { ok: true, drive };
  }

  escalateFromOrchestrator(
    projectId: string,
    message: string,
  ): { ok: true; drive: DriveState } | { ok: false; error: string } {
    const rt = this.states.get(projectId);
    if (!rt) {
      return {
        ok: false,
        error: `nenhum drive ativo dirigindo "${projectId}" para escalar (ja parado, assumido ou inexistente).`,
      };
    }
    if (rt.drive.driver !== 'orchestrator') {
      return { ok: false, error: 'o humano assumiu este projeto; nao ha drive de orquestrador para escalar.' };
    }
    this.escalate(projectId, rt, message, { reason: 'orchestrator-escalate' });
    return { ok: true, drive: rt.drive };
  }

  tryInterceptChatForDrive(sessionId: string, content: string): boolean {
    if (!sessionId) return false;
    for (const project of listHarnessProjects()) {
      const persisted = getDriveState(project.id);
      if (
        persisted &&
        persisted.driver === 'orchestrator' &&
        persisted.status === 'awaiting-human' &&
        persisted.sessionId === sessionId
      ) {
        const text = content.slice(0, 2000);
        const resumed = this.resumeDrive(project.id, { humanInterject: text, fromHuman: true });
        if (!resumed.ok) {
          logger.warn(
            { projectId: project.id, error: resumed.error },
            'tryInterceptChatForDrive: resumeDrive falhou',
          );
          return false;
        }
        logger.info(
          { projectId: project.id, sessionId },
          'tryInterceptChatForDrive: drive retomado pela mensagem no chat principal',
        );
        return true;
      }
    }
    return false;
  }

  setMode(
    projectId: string,
    mode: 'semi' | 'full',
  ): { ok: true; drive: DriveState } | { ok: false; error: string } {
    const existing = this.getDrive(projectId);
    if (!existing) {
      return { ok: false, error: `nenhum drive em "${projectId}"` };
    }
    const drive = setDriveState(projectId, { mode });
    const rt = this.states.get(projectId);
    if (rt) rt.drive = drive;
    logger.info({ projectId, mode }, 'setMode: drive autonomy updated');
    this.notifyDriveChanged(projectId, drive);
    return { ok: true, drive };
  }


  recoverInterruptedDrives(): void {
    let recovered = 0;
    for (const project of listHarnessProjects()) {
      const drive = project.config?.drive;
      if (!drive || drive.driver !== 'orchestrator' || drive.status !== 'driving') {
        continue;
      }
      try {
        const recoveredDrive = setDriveState(project.id, { status: 'awaiting-human' });
        recovered++;
        this.notifyDriveChanged(project.id, recoveredDrive);
        if (drive.sessionId) {
          pushAssistantMessage(
            drive.sessionId,
            `O drive do projeto "${project.name}" foi interrompido pelo restart do app. ` +
              `Quer que eu retome a conducao ou prefere parar? (responda "retomar" ou "parar")`,
            { getWindow: this.getWindow },
          );
        }
        logger.info(
          { projectId: project.id, sessionId: drive.sessionId },
          'recoverInterruptedDrives: drive marcado awaiting-human (nao retoma sozinho)',
        );
      } catch (err) {
        logger.error(
          { projectId: project.id, error: (err as Error).message },
          'recoverInterruptedDrives: falha ao recuperar drive',
        );
      }
    }
    if (recovered > 0) {
      logger.info({ recovered }, 'recoverInterruptedDrives: concluido');
    }
  }


  private liveStateOf(projectId: string): DriveRuntimeState | null {
    const rt = this.states.get(projectId);
    if (!rt) return null;
    if (rt.drive.driver !== 'orchestrator' || rt.drive.status !== 'driving') {
      return null;
    }
    return rt;
  }

  private maybeAutoResumeFromTemporaryHandoff(payload: PhaseChangedPayload): boolean {
    const projectId = payload.projectId;
    const rt = this.states.get(projectId);
    if (!rt) return false;
    const drive = rt.drive;
    if (
      drive.driver !== 'orchestrator' ||
      drive.status !== 'awaiting-human' ||
      drive.handoff !== 'temporary' ||
      rt.handoffTemporaryPhase === null
    ) {
      return false;
    }

    const cededPhase = rt.handoffTemporaryPhase;
    const phase = typeof payload.phase === 'number' ? payload.phase : null;
    const status = payload.status ?? '';

    const isProgress = !['failed', 'paused', 'aborted', 'interrupted'].includes(status);
    const advanced = phase !== null && phase > cededPhase && isProgress;
    if (!advanced) return false;

    logger.info(
      { projectId, cededPhase, newPhase: phase, status },
      'maybeAutoResumeFromTemporaryHandoff: fase requiresHuman concluida pelo humano; auto-retomando o drive',
    );

    if (drive.sessionId) {
      pushAssistantMessage(
        drive.sessionId,
        `Voce concluiu a fase ${cededPhase}. Retomei a conducao do pipeline automaticamente.`,
        { getWindow: this.getWindow },
      );
    }

    const result = this.resumeDrive(projectId);
    if (!result.ok) {
      logger.warn(
        { projectId, error: result.error },
        'maybeAutoResumeFromTemporaryHandoff: resumeDrive falhou',
      );
      return false;
    }
    return true;
  }

  private onPhaseChanged(payload: PhaseChangedPayload): void {
    const projectId = payload.projectId;
    if (!projectId) return;

    {
      const armPhase = typeof payload.phase === 'number' ? payload.phase : null;
      const armStatus = payload.status ?? '';
      if (
        armStatus === 'started' &&
        armPhase !== null &&
        !this.isTerminalStatus(armStatus) &&
        this.isConversationPhase(projectId, armPhase) &&
        !this.isOpenDesignStudioPhase(projectId, armPhase) &&
        !this.isSpecLoopActive(projectId, armPhase, armStatus)
      ) {
        this.armGreetingGate(projectId, armPhase);
      }
    }

    if (this.maybeAutoResumeFromTemporaryHandoff(payload)) {
      return; // resumeDrive ja re-avaliou o estado atual.
    }

    const rt = this.liveStateOf(projectId);
    if (!rt) return;

    this.releaseTurnGate(projectId, rt, 'phase-changed');

    const status = payload.status ?? '';

    this.recordPipelineBlockStart(rt, payload, status);

    if (this.isTerminalStatus(status)) {
      this.handleTerminal(projectId, rt, status, payload);
      return;
    }

    const phase = typeof payload.phase === 'number' ? payload.phase : null;
    const realTransition = phase !== null && phase !== rt.lastTurnPhase;
    if (realTransition) {
      rt.turnsThisPhase = 0;
      rt.lastTurnPhase = phase;

      this.resetTickIdle(projectId);

      if (this.isLoopPhase(projectId, phase)) {
        this.stopDrive(projectId, 'desenvolvimento-iniciado');
        return;
      }
    }

    if (phase !== null && this.isOpenDesignStudioPhase(projectId, phase)) {
      this.announceDesignBand(projectId, rt);
      return;
    }

    if (phase !== null && !payload.awaitingUser && !this.isConversationPhase(projectId, phase)) {
      this.reconcileWithDb(projectId, phase);
      return;
    }

    if (
      (payload.awaitingUser || (phase !== null && this.isConversationPhase(projectId, phase))) &&
      !(phase !== null && this.isSpecLoopActive(projectId, phase, status))
    ) {
      this.evaluate(projectId, rt, { phase, status });
    }

    this.reconcileWithDb(projectId, phase);
  }

  private onStream(payload: StreamPayload): void {
    const projectId = payload.projectId;
    if (!projectId) return;

    if (payload.type === 'done' && typeof payload.phase === 'number') {
      this.disarmGreetingGate(projectId, payload.phase);
    } else if (payload.type !== 'done' && payload.type !== 'error' && typeof payload.phase === 'number') {
      this.touchGreetingGate(projectId, payload.phase);
    } else if (payload.type === 'done') {
      logger.warn(
        { projectId, phase: payload.phase },
        'onStream: done sem phase numerico; greeting-gate NAO desarmado (timeout cobre)',
      );
    }

    const rt = this.liveStateOf(projectId);
    if (!rt) return;

    if (payload.type !== 'done') return;

    const phase = typeof payload.phase === 'number' ? payload.phase : rt.lastTurnPhase;

    if (phase !== null) {
      this.recordPipelineBlockEnd(rt, projectId, phase, 'done');
      this.notifyMessagesUpdated(projectId, phase);
    }

    const specLoopStandDown =
      phase !== null &&
      this.isSpecLoopPhase(projectId, phase) &&
      this.isSpecLoopActive(projectId, phase, getCachedPhaseChanged(projectId)?.status ?? '');
    if (phase === null || !this.isConversationPhase(projectId, phase) || specLoopStandDown) {
      this.reconcileWithDb(projectId, phase);
      return;
    }

    if (rt.pendingFollowup?.reason === 'greeting-gate') {
      rt.pendingFollowup = null;
    }

    this.evaluate(projectId, rt, { phase, status: 'turn-done' });

    this.reconcileWithDb(projectId, phase);
  }

  private onSprintComplete(payload: SprintCompletePayload): void {
    const projectId = payload.projectId;
    if (!projectId) return;
    const rt = this.liveStateOf(projectId);
    if (!rt) return;

    this.resetTickIdle(projectId);

    rt.tokensSpent += this.tokensFromMetrics(payload.metrics);
    const drive = rt.drive;
    if (drive.sessionId) {
      const verdict = payload.verdict ?? 'concluido';
      pushAssistantMessage(
        drive.sessionId,
        `Sprint ${(payload.sprintIndex ?? 0) + 1}` +
          (payload.sprintName ? ` (${payload.sprintName})` : '') +
          ` finalizou: ${verdict}.`,
        { getWindow: this.getWindow },
      );
    }
    this.enforceBudget(projectId, rt);
  }

  private onDriveTurnUsage(usage: { sessionId: string; tokens: number }): void {
    if (usage.tokens <= 0) return;
    for (const [projectId, rt] of this.states) {
      if (rt.drive.sessionId !== usage.sessionId) continue;
      rt.tokensSpent += usage.tokens;
      const inFlightTurnId = rt.currentDriveTurnId;
      const isTickUsage = inFlightTurnId !== null && this.tickTurnIds.has(inFlightTurnId);
      if (!isTickUsage) {
        this.resetTickIdle(projectId);
      }
      this.releaseTurnGate(projectId, rt, 'usage');
      if (rt.drive.driver === 'orchestrator' && rt.drive.status === 'driving') {
        this.enforceBudget(projectId, rt);
      }
      return; // 1 drive ativo por vez; sessionId e unico.
    }
  }

  private onDriveTurnComplete(complete: { projectId: string; driveTurnId?: string }): void {
    const isTickTurn =
      complete.driveTurnId !== undefined && this.tickTurnIds.has(complete.driveTurnId);
    if (isTickTurn) {
      this.tickTurnIds.delete(complete.driveTurnId!);
    }

    const rt = this.liveStateOf(complete.projectId);
    if (!rt) return;

    if (complete.driveTurnId === undefined || complete.driveTurnId !== rt.currentDriveTurnId) {
      logger.info(
        {
          projectId: complete.projectId,
          driveTurnId: complete.driveTurnId,
          currentDriveTurnId: rt.currentDriveTurnId,
        },
        'onDriveTurnComplete: complete de turno DEFASADO (id nao bate) - ignorado, gate intacto',
      );
      return;
    }

    if (!isTickTurn) {
      this.resetTickIdle(complete.projectId);
    }

    this.releaseTurnGate(complete.projectId, rt, 'turn-complete');
  }

  private releaseTurnGate(
    projectId: string,
    rt: DriveRuntimeState,
    via: 'turn-complete' | 'usage' | 'phase-changed',
  ): void {
    rt.turnInFlightSince = null;
    rt.currentDriveTurnId = null;
    const followup = rt.pendingFollowup;
    if (!followup) return;
    rt.pendingFollowup = null;
    logger.info(
      { projectId, via, reason: followup.reason },
      'releaseTurnGate: disparando follow-up coalescido (estado fresco do DB)',
    );
    this.evaluateNow(projectId);
  }

  private onError(payload: ErrorPayload): void {
    const projectId = payload.projectId;
    if (!projectId) return;
    const rt = this.liveStateOf(projectId);
    if (!rt) return;
    this.escalate(
      projectId,
      rt,
      `O pipeline reportou um erro na fase ${payload.phase ?? '?'}: ${payload.error ?? 'erro desconhecido'}. ` +
        `O drive pausou. Como prefere seguir?`,
      { reason: 'phase-error' },
    );
  }


  private onHumanMessage(payload: { projectId: string; content: string }): void {
    const { projectId, content } = payload;
    const persisted = getDriveState(projectId);
    if (!persisted || persisted.driver !== 'orchestrator') return;
    if (persisted.status === 'stopped') return;
    const text = content.slice(0, 2000);
    if (persisted.status === 'awaiting-human') {
      const resumed = this.resumeDrive(projectId, { humanInterject: text, fromHuman: true });
      if (!resumed.ok) {
        logger.warn(
          { projectId, error: resumed.error },
          'onHumanMessage: resume pos-interject falhou',
        );
      } else {
        logger.info({ projectId }, 'onHumanMessage: drive retomado pela resposta direta na fase');
      }
      return;
    }
    const rt = this.states.get(projectId);
    if (rt) {
      rt.pendingHumanInterject = text;
      this.resetTickIdle(projectId);
      logger.info({ projectId }, 'onHumanMessage: interject registrado para o proximo turno');
    }
  }


  private evaluateNow(projectId: string): void {
    const rt = this.liveStateOf(projectId);
    if (!rt) return;
    const project = getHarnessProject(projectId);
    const phase =
      project?.pipelineCurrentPhase ?? project?.pipelineStartPhase ?? rt.lastTurnPhase ?? 1;
    if (phase !== rt.lastTurnPhase) {
      rt.turnsThisPhase = 0;
      rt.lastTurnPhase = phase;
    }
    this.evaluate(projectId, rt, { phase, status: 'initial' });
  }

  private reconcileWithDb(projectId: string, livePhase: number | null): void {
    const rt = this.liveStateOf(projectId);
    if (!rt) return;

    const project = getHarnessProject(projectId);
    if (!project) return;

    const dbPhase =
      project.pipelineCurrentPhase ?? project.pipelineStartPhase ?? rt.lastTurnPhase ?? null;
    if (dbPhase === null) return;

    if (this.isTerminalStatus(project.status)) return;

    if (this.isOpenDesignStudioPhase(projectId, dbPhase)) {
      return;
    }

    const cached = getCachedPhaseChanged(projectId);

    if (this.isSpecLoopActive(projectId, dbPhase, cached?.status ?? '')) {
      return;
    }

    const gateOpenInDb =
      cached !== null &&
      cached.phase === dbPhase &&
      (cached.awaitingUser === true ||
        cached.status === 'awaiting-dev-confirmation' ||
        cached.status === 'awaiting-spec-review' ||
        cached.status === 'awaiting-input');
    const actionableInDb = this.isConversationPhase(projectId, dbPhase) || gateOpenInDb;
    if (!actionableInDb) return;

    const diverged = livePhase !== dbPhase || gateOpenInDb;
    if (!diverged) return;

    if (dbPhase !== rt.lastTurnPhase) {
      rt.turnsThisPhase = 0;
      rt.lastTurnPhase = dbPhase;
    }
    logger.info(
      { projectId, livePhase, dbPhase, gateOpenInDb },
      'reconcileWithDb: divergencia live vs DB; semeando turno via evaluate (DB-first)',
    );
    this.evaluate(projectId, rt, { phase: dbPhase, status: 'reconcile-db' });
  }

  private evaluate(
    projectId: string,
    rt: DriveRuntimeState,
    ctx: { phase: number | null; status: string },
  ): void {
    if (rt.reacting) return;

    const breach = checkAntiRunaway(
      {
        tokensSpent: rt.tokensSpent,
        turnsThisDrive: rt.turnsThisDrive,
        turnsThisPhase: rt.turnsThisPhase,
      },
      {
        tokenBudget: DRIVE_TOKEN_BUDGET,
        maxTurnsPerDrive: MAX_TURNS_PER_DRIVE,
        maxTurnsPerPhase: MAX_ORCHESTRATOR_TURNS_PER_PHASE,
      },
    );
    if (breach === 'budget') {
      this.escalate(
        projectId,
        rt,
        `O drive atingiu o budget de tokens (${DRIVE_TOKEN_BUDGET.toLocaleString('pt-BR')}). ` +
          `Parei por seguranca. Quer que eu continue (responda "retomar") ou prefere assumir?`,
        { stop: true, reason: 'budget' },
      );
      return;
    }
    if (breach === 'max-turns-drive') {
      this.escalate(
        projectId,
        rt,
        `Ja rodei ${rt.turnsThisDrive} turnos neste drive (teto de ${MAX_TURNS_PER_DRIVE}). ` +
          `Parei por seguranca (anti-loop). Quer ajustar a direcao ou assumir?`,
        { stop: true, reason: 'max-turns-drive' },
      );
      return;
    }
    if (breach === 'max-turns-phase') {
      this.escalate(
        projectId,
        rt,
        `Ja rodei ${rt.turnsThisPhase} turnos na fase ${ctx.phase ?? '?'} sem fechar. ` +
          `Parei por seguranca (anti-loop). Quer ajustar a direcao ou assumir?`,
        { stop: true, reason: 'max-turns-phase' },
      );
      return;
    }

    const project = getHarnessProject(projectId);
    if (!project) return;
    const phase = project.pipelineCurrentPhase ?? ctx.phase ?? 1;

    if (this.isOpenDesignStudioPhase(projectId, phase)) {
      return;
    }

    if (rt.drive.requiresHumanPhases.includes(phase)) {
      this.handoffTemporary(projectId, rt, phase);
      return;
    }

    const greetingEntry = this.pendingGreetings.get(this.greetingKey(projectId, phase));
    if (greetingEntry) {
      if (greetingEntry.timedOut) {
        this.escalate(
          projectId,
          rt,
          `A fase ${phase} nao respondeu ao iniciar (o greeting nao fechou no tempo esperado). ` +
            `O drive pausou aguardando voce. Quer que eu tente de novo (responda "retomar") ou prefere assumir?`,
          { reason: 'greeting-timeout' },
        );
        return;
      }
      if (rt.turnInFlightSince !== null) {
        rt.pendingFollowup = { reason: 'greeting-gate' };
      }
      logger.info(
        { projectId, phase, hadTurnInFlight: rt.turnInFlightSince !== null },
        'evaluate: greeting-gate represou o turno (greeting in-flight); aguardando o stream done',
      );
      return;
    }

    this.fireOrchestratorTurn(projectId, rt, project, phase);
  }

  private fireOrchestratorTurn(
    projectId: string,
    rt: DriveRuntimeState,
    project: ReturnType<typeof getHarnessProject>,
    phase: number,
  ): void {
    if (!project) return;
    const sessionId = rt.drive.sessionId;
    if (!sessionId) {
      logger.warn({ projectId }, 'fireOrchestratorTurn: sem sessionId, nao posso disparar turno');
      return;
    }

    const inFlightAction = decideOneInFlight({
      turnInFlightSince: rt.turnInFlightSince,
      now: Date.now(),
      hasPendingFollowup: rt.pendingFollowup !== null,
      inflightTimeoutMs: TURN_INFLIGHT_TIMEOUT_MS,
    });
    if (inFlightAction === 'coalesce') {
      if (rt.pendingTickTurn) {
        rt.pendingTickTurn = false;
        logger.info(
          { projectId, phase },
          'fireOrchestratorTurn: tick com turno em voo - PULA (sem pendingFollowup)',
        );
        return;
      }
      const reason = `phase=${phase}`;
      const wasPending = rt.pendingFollowup !== null;
      rt.pendingFollowup = { reason };
      const inFlightForMs = Date.now() - (rt.turnInFlightSince ?? Date.now());
      logger.info(
        { projectId, phase, inFlightForMs, wasPending },
        'fireOrchestratorTurn: turno em voo - coalesci o evento em UM follow-up pendente',
      );
      return;
    }
    const isTickTurn = rt.pendingTickTurn;
    rt.pendingTickTurn = false;
    rt.turnInFlightSince = Date.now();
    const driveTurnId = mintDriveTurnIdCore(projectId, this.globalTurnSeq);
    rt.currentDriveTurnId = driveTurnId;
    if (isTickTurn) this.tickTurnIds.add(driveTurnId);

    rt.reacting = true;
    rt.turnsThisPhase += 1;
    rt.turnsThisDrive += 1;
    rt.lastTurnPhase = phase;

    let prompt: string;
    if (isTickTurn) {
      prompt = this.buildTickPrompt(project, phase, rt.drive.mode);
    } else {
      const pendingQuestion = resolvePendingQuestion(projectId, project.pipelineType, phase);
      const controlGate = isControlGate(project.pipelineType, phase);
      const humanGate = isHumanGate(project.pipelineType, phase);
      const cachedForPrompt = getCachedPhaseChanged(projectId);
      const specReviewOpen =
        this.isSpecLoopPhase(projectId, phase) &&
        cachedForPrompt?.phase === phase &&
        cachedForPrompt?.status === 'awaiting-spec-review';
      const humanInterject = rt.pendingHumanInterject;
      rt.pendingHumanInterject = null;
      prompt = this.buildSeededPrompt({
        project,
        phase,
        pendingQuestion,
        mode: rt.drive.mode,
        controlGate,
        humanGate,
        specReviewOpen,
        humanInterject,
      });
    }

    logger.info(
      { projectId, phase, turnsThisPhase: rt.turnsThisPhase, mode: rt.drive.mode, isTickTurn },
      'fireOrchestratorTurn: disparando turno de drive',
    );

    const lease = createInternalCapabilityLease({
      coordinator: 'pipeline-drive-coordinator',
      driveProjectId: projectId,
      driveTurnId,
      allowedServerIds: ['lionclaw-pipeline-control'],
      allowedToolPrefixes: ['pipeline_'],
      ttlMs: DRIVE_LEASE_TTL_MS,
      maxUses: DRIVE_LEASE_MAX_USES,
    });

    this.runOrchestratorTurn(
      sessionId,
      prompt,
      projectId,
      phase,
      driveTurnId,
      {
        internalLeaseToken: lease.token,
        leaseCoordinator: 'pipeline-drive-coordinator',
        leaseCapability: 'pipelineControl',
      },
      rt.drive.startedAt,
    );

    setTimeout(() => {
      rt.reacting = false;
    }, 0);
  }


  runOrchestratorTurn(
    sessionId: string,
    seededPrompt: string,
    driveProjectId: string,
    drivePhase: number,
    driveTurnId: string,
    lease?: {
      internalLeaseToken: string;
      leaseCoordinator: InternalCapabilityCoordinator;
      leaseCapability: ChatCapabilityName;
    },
    driveEpoch?: string,
  ): void {
    submitMessage(
      seededPrompt,
      {
        sessionId,
        origin: 'system-event',
        driveProjectId,
        drivePhase,
        driveTurnId,
        ...(driveEpoch ? { driveEpoch } : {}),
        ...(lease ?? {}),
      },
      this.getWindow,
    );
  }


  buildSeededPrompt(args: {
    project: NonNullable<ReturnType<typeof getHarnessProject>>;
    phase: number;
    pendingQuestion: string | null;
    mode: 'semi' | 'full';
    controlGate: boolean;
    humanGate: boolean;
    specReviewOpen?: boolean;
    humanInterject?: string | null;
  }): string {
    const {
      project,
      phase,
      pendingQuestion,
      mode,
      controlGate,
      humanGate,
      specReviewOpen,
      humanInterject,
    } = args;
    const phaseDef = getPhasesForProject({ pipelineType: project.pipelineType }).find(
      (p) => p.number === phase,
    );
    const phaseName = phaseDef?.name ?? `Fase ${phase}`;

    const lines: string[] = [];
    lines.push(
      `[DRIVE DE PIPELINE] Voce esta dirigindo o pipeline "${project.name}" (id: ${project.id}, ` +
        `tipo: ${project.pipelineType ?? 'development'}).`,
    );
    lines.push(`Fase atual: ${phase} - ${phaseName}.`);
    if (pendingQuestion) {
      lines.push('');
      lines.push('Pergunta/saida pendente do agente da fase:');
      lines.push('"""');
      const HEAD = 6000;
      const TAIL = 3000;
      const stripLoneHigh = (s: string): string => s.replace(/[\uD800-\uDBFF]$/, '');
      const stripLoneLow = (s: string): string => s.replace(/^[\uDC00-\uDFFF]/, '');
      let pendingText: string;
      if (pendingQuestion.length <= HEAD + TAIL) {
        pendingText = stripLoneHigh(pendingQuestion);
      } else {
        const head = stripLoneHigh(pendingQuestion.slice(0, HEAD));
        const tail = stripLoneLow(pendingQuestion.slice(pendingQuestion.length - TAIL));
        pendingText = `${head}\n[...saida truncada - use pipeline_inspect para o texto completo...]\n${tail}`;
      }
      lines.push(pendingText);
      lines.push('"""');
    }
    if (humanInterject) {
      lines.push('');
      lines.push('ATENCAO - O HUMANO RESPONDEU DIRETO NA CONVERSA DA FASE (painel do pipeline):');
      lines.push('"""');
      lines.push(humanInterject);
      lines.push('"""');
      lines.push(
        'Trate o texto acima como a resposta/decisao DELE para a pergunta ou gate pendente. ' +
          'NAO repita a pergunta e NAO fique aguardando outro OK no chat: aja de acordo ' +
          '(pipeline_reply para encaminhar a conversa, ou pipeline_approve se ele aprovou um gate ' +
          '- a resposta direta dele CONTA como o OK do modo semi).',
      );
    }
    lines.push('');
    lines.push(...operatingContractLines(phaseDef, specReviewOpen === true));
    lines.push('');
    lines.push(
      'Use o contexto da nossa conversa (a intencao do humano) para conduzir. Decida UMA acao usando as tools pipeline_*:',
    );
    lines.push(
      '- pipeline_reply(id, message): responder/questionar/pedir mudanca na fase conversacional (motor da conversa).',
    );
    lines.push('- pipeline_approve(id, metadata?): aprovar o gate e avancar de fase.');
    lines.push(
      '- pipeline_escalate(id, message): ceder ao humano. O drive PAUSA em awaiting-human ' +
        'ate eu responder. Use para escalar um control gate (semi) ou quando voce divergir num ' +
        'control gate (full). NAO basta escrever no chat: so o pipeline_escalate pausa o drive.',
    );
    lines.push('- pipeline_inspect(id): reler estado/pergunta pendente se precisar.');
    lines.push('');
    lines.push(...gateContractLines(project.pipelineType, resolveBugPlanPath(project)));
    const preview = previewOpenLines(project, phaseDef);
    if (preview.length > 0) {
      lines.push('');
      lines.push(...preview);
    }
    lines.push('');
    lines.push('REGRAS DE AUTONOMIA E ESCALONAMENTO (obrigatorias):');
    if (humanGate) {
      lines.push(
        '- ATENCAO: a fase atual e uma DECISAO DO HUMANO. Voce NUNCA aprova sozinho (nem em full): ' +
          'esta escolha e sempre dele. Ceda com pipeline_escalate(id, mensagem) e aguarde - nao chame ' +
          'pipeline_approve aqui.',
      );
    }
    if (mode === 'semi') {
      lines.push(
        '- Modo SEMI: nos CONTROL GATES (aprovar PRD/SPEC, validar sprints e os checkpoints deste ' +
          'pipeline) NAO aprove sozinho - escale com pipeline_escalate(id, mensagem) (resumo + o que ' +
          'precisa do meu OK) e aguarde minha resposta. No RESTANTE (fases conversacionais, gates de ' +
          'baixo risco), conduza e aprove normalmente com pipeline_approve.',
      );
      if (controlGate && !humanGate) {
        lines.push(
          '- ATENCAO: a fase atual e um CONTROL GATE. Escale com pipeline_escalate(id, mensagem) antes ' +
            'de qualquer pipeline_approve - o drive pausa ate eu responder.',
        );
      }
    } else {
      lines.push(
        '- Modo FULL: em gates de BAIXO risco voce aprova sozinho (pipeline_approve). Nos CONTROL ' +
          'GATES deste pipeline, NAO carimbe: LEIA o artefato, AVALIE vs a intencao (Discovery + nossa ' +
          'conversa) e DECIDA - se estiver ALINHADO, aprove (pipeline_approve) com uma JUSTIFICATIVA ' +
          'curta amarrada a intencao; se DIVERGIR, escale com pipeline_escalate(id, mensagem).',
      );
      if (controlGate && !humanGate) {
        lines.push(
          '- ATENCAO: a fase atual e um CONTROL GATE. Antes de aprovar, LEIA o artefato e AVALIE vs a ' +
            'intencao: aprove com pipeline_approve + uma justificativa curta SO se estiver alinhado; se ' +
            'divergir, escale com pipeline_escalate(id, mensagem). Nada de aprovacao cega.',
        );
      }
    }
    lines.push(
      '- Se estiver INCERTO sobre a resposta ou a decisao, escale com pipeline_escalate(id, mensagem): ' +
        'resumo claro + a pergunta, em vez de chutar.',
    );
    lines.push(
      '- Para escalar/ceder ao humano, chame pipeline_escalate(id, mensagem) (NAO basta escrever no ' +
        'chat): o drive pausa em awaiting-human ate eu responder.',
    );
    lines.push(
      '- Se pipeline_reply/approve retornar que o drive foi PARADO ou ASSUMIDO pelo humano, este prompt esta DEFASADO: encerre o turno com UMA confirmacao curta, sem re-tentar tools e sem re-engajar.',
    );
    lines.push('');
    lines.push('PADROES DE SOBREVIVENCIA (obrigatorios):');
    lines.push(
      '- Diante de QUALQUER divergencia (fase/estado diferente do esperado, retorno confuso ou ' +
        'inconsistente), SEMPRE rode pipeline_inspect ANTES de agir. Inspecione antes de AGIR; ' +
        'NUNCA inspecione para ESPERAR (vigiar/poll por mudanca de estado): voce sera acordado por evento.',
    );
    lines.push(
      '- Erro de TRANSPORTE (Connection closed / timeout) NAO significa falha: a operacao PODE ter ' +
        'completado no servidor. Inspecione com pipeline_inspect ANTES de repetir uma escrita ' +
        '(create/reply/approve).',
    );
    lines.push(
      '- Nos gates de validacao, se pipeline_approve retornar um erro INSTRUTIVO, SIGA a instrucao ' +
        'do erro em vez de alternar reply/approve cegamente.',
    );
    return lines.join('\n');
  }


  private escalate(
    projectId: string,
    rt: DriveRuntimeState,
    message: string,
    opts?: { stop?: boolean; reason?: string },
  ): void {
    const sessionId = rt.drive.sessionId;
    if (sessionId) {
      pushAssistantMessage(sessionId, message, { getWindow: this.getWindow });
      pushDrivePaused(sessionId, { getWindow: this.getWindow });
    }
    this.notifyTelegramHandoff(message);
    const reason = opts?.reason ?? 'unspecified';
    if (opts?.stop) {
      logger.info({ projectId, reason }, 'escalate: drive stopped (anti-runaway)');
      this.stopDrive(projectId, 'anti-runaway');
      return;
    }
    if (rt.tickTimer) clearTimeout(rt.tickTimer);
    rt.tickTimer = null;
    const drive = setDriveState(projectId, { status: 'awaiting-human' });
    rt.drive = drive;
    rt.reacting = false;
    logger.info({ projectId, reason }, 'escalate: drive awaiting-human');
    this.notifyDriveChanged(projectId, drive);
  }

  private announceDesignBand(projectId: string, rt: DriveRuntimeState): void {
    if (rt.designBandAnnounced) return;
    rt.designBandAnnounced = true;
    const message =
      'Agora e a parte do design e ela e sua: escolha o provider/modelo, inicie a ' +
      'geracao e aprove o layout na pagina Pipeline. Eu nao conduzo essa parte; ' +
      'assim que voce aprovar o layout, retomo a conducao automaticamente.';
    const sessionId = rt.drive.sessionId;
    if (sessionId) {
      pushAssistantMessage(sessionId, message, { getWindow: this.getWindow });
    }
    this.notifyTelegramHandoff(message);
    logger.info({ projectId }, 'announceDesignBand: design band announced (once)');
  }

  private handoffTemporary(projectId: string, rt: DriveRuntimeState, phase: number): void {
    const project = getHarnessProject(projectId);
    const phaseName =
      getPhasesForProject({ pipelineType: project?.pipelineType }).find((p) => p.number === phase)
        ?.name ?? `Fase ${phase}`;
    const sessionId = rt.drive.sessionId;
    if (sessionId) {
      pushAssistantMessage(
        sessionId,
        `A fase ${phase} - ${phaseName} e sua: e o design visual, que eu nao conduzo. ` +
          `Faca e aprove na pagina Pipeline; assim que voce concluir, eu retomo a conducao automaticamente.`,
        { getWindow: this.getWindow },
      );
      pushDrivePaused(sessionId, { getWindow: this.getWindow });
    }
    if (rt.tickTimer) clearTimeout(rt.tickTimer);
    rt.tickTimer = null;
    const drive = setDriveState(projectId, {
      status: 'awaiting-human',
      handoff: 'temporary',
    });
    rt.drive = drive;
    rt.reacting = false;
    rt.handoffTemporaryPhase = phase;
    logger.info({ projectId, phase }, 'handoffTemporary: requiresHuman phase ceded to human');
    this.notifyDriveChanged(projectId, drive);
  }

  private handleTerminal(
    projectId: string,
    rt: DriveRuntimeState,
    status: string,
    payload: PhaseChangedPayload,
  ): void {
    const sessionId = rt.drive.sessionId;
    if (sessionId) {
      const project = getHarnessProject(projectId);
      const name = project?.name ?? projectId;
      let msg: string;
      if (status === 'failed') {
        msg = `O pipeline "${name}" falhou${payload.phase != null ? ` na fase ${payload.phase}` : ''}. Quer que eu investigue ou prefere assumir?`;
      } else if (status === 'aborted') {
        msg = `O pipeline "${name}" foi abortado. O drive encerrou.`;
      } else {
        msg = `O pipeline "${name}" concluiu. O drive encerrou.`;
      }
      pushAssistantMessage(sessionId, msg, { getWindow: this.getWindow });
    }

    const closeStatus: NonNullable<LiveActivityEvent['status']> =
      status === 'failed' ? 'error' : status === 'aborted' ? 'stopped' : 'done';
    for (const openPhase of Array.from(rt.activityPhaseStart.keys())) {
      this.recordPipelineBlockEnd(rt, projectId, openPhase, closeStatus);
    }

    this.clearGreetingGatesForProject(projectId);

    if (status === 'failed') {
      if (rt.tickTimer) clearTimeout(rt.tickTimer);
      rt.tickTimer = null;
      if (sessionId) pushDrivePaused(sessionId, { getWindow: this.getWindow });
      const drive = setDriveState(projectId, { status: 'awaiting-human' });
      rt.drive = drive;
      rt.reacting = false;
      this.notifyDriveChanged(projectId, drive);
    } else {
      this.stopDrive(projectId, `terminal:${status}`);
    }
  }

  private onPipelineCompleted(payload: PhaseChangedPayload): void {
    const projectId = payload.projectId;
    if (!projectId) return;
    const status = payload.status ?? '';
    if (status !== 'pipeline-completed' && status !== 'completed') return;
    if (payload.phase !== null && payload.phase !== undefined) return;
    if (this.completionAnnounced.has(projectId)) return;

    const persisted = getDriveState(projectId);
    if (!persisted || persisted.driver !== 'orchestrator' || !persisted.sessionId) {
      return;
    }
    const sessionId = persisted.sessionId;

    this.completionAnnounced.add(projectId);

    const project = getHarnessProject(projectId);
    const name = project?.name ?? projectId;

    const bugOutcome = project?.config?.bug?.outcome;
    const isNoBug = project?.pipelineType === 'bug' && bugOutcome === 'no-bug';
    const planoPath = isNoBug && project ? resolveBugPlanPath(project) : null;

    const prompt = isNoBug
      ? `[evento do sistema] O pipeline bug "${name}" (${projectId}) foi ENCERRADO SEM ` +
        `CORRECAO: o plano concluiu que nao ha bug a corrigir. Nao ha entrega. O desfecho ` +
        `esta registrado em ${planoPath ?? 'plano de correcao do run (use pipeline_inspect para o gateDocumentPath)'}. ` +
        `Explique ao dono em poucas linhas por que foi encerrado. NAO chame tools de pipeline.`
      : `[evento do sistema] O pipeline "${name}" (${projectId}) acabou de CONCLUIR: ` +
        `todas as fases/sprints terminaram e a entrega esta pronta. Resuma a entrega ` +
        `para o dono em poucas linhas (o que foi feito, onde olhar) e avise-o. NAO chame ` +
        `tools de pipeline (pipeline_reply/approve/escalate): o pipeline ja encerrou e ` +
        `nao ha drive ativo. (O aviso pro Telegram, se configurado, ja sai automatico.)`;

    this.notifyTelegramHandoff(
      isNoBug
        ? `O pipeline "${name}" foi encerrado sem correcao (nao ha bug).`
        : `O pipeline "${name}" concluiu. A entrega esta pronta.`,
    );

    const driveTurnId = mintDriveTurnIdCore(projectId, this.globalTurnSeq);
    logger.info({ projectId, status }, 'onPipelineCompleted: enfileirando turno de resumo da entrega');
    this.runOrchestratorTurn(sessionId, prompt, projectId, 0, driveTurnId);
  }


  private isTerminalStatus(status: string): boolean {
    return (
      status === 'done' ||
      status === 'aborted' ||
      status === 'pipeline-completed' ||
      status === 'failed'
    );
  }

  private isConversationPhase(projectId: string, phase: number): boolean {
    const project = getHarnessProject(projectId);
    const type = project?.pipelineType;
    return conversationPhasesOf(type).has(phase);
  }


  private pipelineActivityId(projectId: string, phase: number): string {
    return `pipeline:${projectId}:phase:${phase}`;
  }

  private pipelinePhaseLabel(pipelineType: string | undefined, phase: number, phaseName?: string): string {
    const name =
      phaseName ??
      getPhasesForProject({ pipelineType }).find((p) => p.number === phase)?.name ??
      `Fase ${phase}`;
    return `Fase ${phase} - ${name}`;
  }

  private emitPipelineActivity(rt: DriveRuntimeState, ev: LiveActivityEvent): void {
    const sessionId = rt.drive.sessionId;
    if (!sessionId) return;
    try {
      const turnIndex = getLatestUserTurnIndex(sessionId);
      const win = this.resolveWindow();
      const send = (chunk: StreamChunk): void => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('chat:stream', { ...chunk, sessionId });
        }
      };
      recordActivity(sessionId, turnIndex, ev, send);
    } catch (err) {
      logger.warn(
        { sessionId, activityId: ev.id, error: (err as Error).message },
        'emitPipelineActivity falhou (drive nao afetado)',
      );
    }
  }

  private recordPipelineBlockStart(
    rt: DriveRuntimeState,
    payload: PhaseChangedPayload,
    status: string,
  ): void {
    if (status !== 'started' && status !== 'loop-ready') return;
    const phase = typeof payload.phase === 'number' ? payload.phase : null;
    if (phase === null) return;
    if (rt.activityPhaseStart.has(phase)) return;

    const project = getHarnessProject(payload.projectId ?? '');
    const startedAt = new Date().toISOString();
    rt.activityPhaseStart.set(phase, startedAt);

    this.emitPipelineActivity(rt, {
      id: this.pipelineActivityId(payload.projectId ?? '', phase),
      kind: 'pipeline',
      phase: 'start',
      label: this.pipelinePhaseLabel(project?.pipelineType, phase, payload.phaseName),
      status: 'running',
      startedAt,
      projectId: payload.projectId,
    });
  }

  private recordPipelineBlockEnd(
    rt: DriveRuntimeState,
    projectId: string,
    phase: number,
    status: NonNullable<LiveActivityEvent['status']>,
  ): void {
    const startedAt = rt.activityPhaseStart.get(phase);
    if (!startedAt) return; // sem start correspondente -> nada a fechar
    rt.activityPhaseStart.delete(phase);

    const project = getHarnessProject(projectId);
    const endedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
    const summary =
      status === 'done'
        ? 'fase concluida'
        : status === 'error'
          ? 'fase falhou'
          : 'fase interrompida';

    this.emitPipelineActivity(rt, {
      id: this.pipelineActivityId(projectId, phase),
      kind: 'pipeline',
      phase: 'end',
      label: this.pipelinePhaseLabel(project?.pipelineType, phase),
      status,
      summary,
      endedAt,
      durationMs,
      projectId,
    });
  }

  private isOpenDesignStudioPhase(projectId: string, phase: number): boolean {
    const project = getHarnessProject(projectId);
    if (project?.pipelineType !== 'development-v2') return false;
    const def = getPhasesForProject({ pipelineType: project.pipelineType }).find(
      (p) => p.number === phase,
    );
    return def?.agentId === 'open-design-studio';
  }

  private static readonly SPEC_LOOP_BUILDER_AGENT_IDS = new Set<string>([
    'spec-builder',
    'pipe2-spec-builder',
  ]);

  private isSpecLoopPhase(projectId: string, phase: number): boolean {
    const project = getHarnessProject(projectId);
    const def = getPhasesForProject({ pipelineType: project?.pipelineType }).find(
      (p) => p.number === phase,
    );
    return (
      def !== undefined &&
      PipelineDriveCoordinator.SPEC_LOOP_BUILDER_AGENT_IDS.has(def.agentId)
    );
  }

  private isSpecLoopActive(projectId: string, phase: number, status: string): boolean {
    return status !== 'awaiting-spec-review' && this.isSpecLoopPhase(projectId, phase);
  }

  private isLoopPhase(projectId: string, phase: number): boolean {
    const project = getHarnessProject(projectId);
    const def = getPhasesForProject({ pipelineType: project?.pipelineType }).find(
      (p) => p.number === phase,
    );
    return def?.type === 'loop';
  }


  private armTick(projectId: string): void {
    const rt = this.states.get(projectId);
    if (!rt) return;
    if (rt.tickTimer) clearTimeout(rt.tickTimer);
    rt.tickIdleCount = 0;
    rt.tickLastSnapshot = null;
    rt.tickTimer = setTimeout(() => {
      this.onTick(projectId);
    }, DRIVE_TICK_INTERVAL_MS);
  }

  private clearTick(projectId: string, reason: string): void {
    const rt = this.states.get(projectId);
    if (!rt) return;
    if (rt.tickTimer) {
      clearTimeout(rt.tickTimer);
      logger.info({ projectId, reason }, 'clearTick: tick de reconciliacao desligado (drive segue)');
    }
    rt.tickTimer = null;
    rt.tickIdleCount = 0;
    rt.tickLastSnapshot = null;
  }

  private resetTickIdle(projectId: string): void {
    const rt = this.states.get(projectId);
    if (!rt || rt.tickTimer === null) return;
    rt.tickIdleCount = 0;
    rt.tickLastSnapshot = null;
  }

  private computeIdleSnapshot(projectId: string): string {
    const project = getHarnessProject(projectId);
    if (!project) return 'no-project';
    const dbPhase =
      project.pipelineCurrentPhase ?? project.pipelineStartPhase ?? null;
    const cached = getCachedPhaseChanged(projectId);
    const gateOpen =
      cached !== null &&
      cached.phase === dbPhase &&
      (cached.awaitingUser === true ||
        cached.status === 'awaiting-dev-confirmation' ||
        cached.status === 'awaiting-spec-review' ||
        cached.status === 'awaiting-input');
    return `phase=${dbPhase ?? '-'}|status=${project.status}|gate=${gateOpen ? '1' : '0'}`;
  }

  private onTick(projectId: string): void {
    const rt = this.liveStateOf(projectId);
    if (!rt) {
      this.clearTick(projectId, 'tick:drive-not-driving');
      return;
    }

    const project = getHarnessProject(projectId);
    if (!project || this.isTerminalStatus(project.status)) {
      this.clearTick(projectId, 'tick:terminal');
      return;
    }

    const phase =
      project.pipelineCurrentPhase ?? project.pipelineStartPhase ?? rt.lastTurnPhase ?? null;

    if (phase !== null && this.isOpenDesignStudioPhase(projectId, phase)) {
      logger.info({ projectId, phase }, 'onTick: fase OD (faixa silenciosa), no-op total; re-armando');
      this.rearmTick(projectId);
      return;
    }

    if (
      rt.turnInFlightSince !== null &&
      Date.now() - rt.turnInFlightSince < TURN_INFLIGHT_TIMEOUT_MS
    ) {
      logger.info({ projectId, phase }, 'onTick: turno em voo, tick pula (one-in-flight); re-armando');
      this.rearmTick(projectId);
      return;
    }

    const snapshot = this.computeIdleSnapshot(projectId);
    if (rt.tickLastSnapshot !== null && rt.tickLastSnapshot === snapshot) {
      rt.tickIdleCount += 1;
      logger.info(
        { projectId, phase, idleCount: rt.tickIdleCount, snapshot },
        'onTick: tick OCIOSO (snapshot identico ao anterior)',
      );
      if (rt.tickIdleCount >= DRIVE_TICK_MAX_IDLE) {
        this.clearTick(projectId, `tick:idle-${rt.tickIdleCount}`);
        return;
      }
      this.rearmTick(projectId);
      return;
    }

    rt.tickLastSnapshot = snapshot;
    rt.tickIdleCount = 0;
    this.fireTickTurn(projectId, rt);
    if (this.liveStateOf(projectId)) {
      this.rearmTick(projectId);
    }
  }

  private rearmTick(projectId: string): void {
    const rt = this.states.get(projectId);
    if (!rt) return;
    if (rt.tickTimer) clearTimeout(rt.tickTimer);
    rt.tickTimer = setTimeout(() => {
      this.onTick(projectId);
    }, DRIVE_TICK_INTERVAL_MS);
  }

  private fireTickTurn(projectId: string, rt: DriveRuntimeState): void {
    if (!rt.drive.sessionId) return;

    logger.info({ projectId }, 'fireTickTurn: roteando RONDA de tick pelo evaluate central');

    rt.pendingTickTurn = true;
    this.evaluate(projectId, rt, { phase: rt.lastTurnPhase, status: 'tick' });
    rt.pendingTickTurn = false;
  }

  buildTickPrompt(
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
    phase: number,
    mode: 'semi' | 'full',
  ): string {
    const phaseDef = getPhasesForProject({ pipelineType: project.pipelineType }).find(
      (p) => p.number === phase,
    );
    const phaseName = phaseDef?.name ?? `Fase ${phase}`;
    const lines: string[] = [];
    lines.push(
      `[DRIVE DE PIPELINE - RONDA PERIODICA] Verificacao de rotina do pipeline ` +
        `"${project.name}" (id: ${project.id}, tipo: ${project.pipelineType ?? 'development'}).`,
    );
    lines.push(`Fase atual: ${phase} - ${phaseName}.`);
    lines.push('');
    lines.push(
      'Esta e uma RONDA PERIODICA automatica (a cada 5 minutos), nao um evento novo. ' +
        'Rode pipeline_inspect UMA vez e confira se alguma fase espera UMA acao SUA agora:',
    );
    lines.push('- um gate de aprovacao aberto aguardando pipeline_approve/pipeline_reply;');
    lines.push('- um erro/stall que exija escalar para o dono.');
    lines.push('');
    lines.push(
      'Se houver uma acao pendente, AJA agora (respeitando o modo ' +
        `${mode === 'semi' ? 'SEMI: escale gates ao dono' : 'FULL: aprove so gates de baixo risco'}). ` +
        'Se NADA espera por voce, ENCERRE o turno IMEDIATAMENTE sem fazer nada (nao monitore, ' +
        'nao faca polling, nao poste no chat): a proxima ronda ou um evento real te acordam.',
    );
    return lines.join('\n');
  }

  private notifyMessagesUpdated(projectId: string, phase: number): void {
    try {
      emitIPC('pipeline:messages-updated', { projectId, phase });
    } catch (err) {
      logger.warn(
        { projectId, phase, error: (err as Error).message },
        'notifyMessagesUpdated falhou (drive nao afetado)',
      );
    }
  }

  private notifyDriveChanged(projectId: string, drive: DriveState | null): void {
    try {
      emitIPC('drive:state-changed', { projectId, drive });
    } catch (err) {
      logger.warn(
        { projectId, error: (err as Error).message },
        'notifyDriveChanged falhou (drive nao afetado)',
      );
    }
  }

  private notifyTelegramHandoff(text: string): void {
    void import('./telegram-bridge')
      .then((mod) => mod.notifyDriveHandoff(text))
      .catch((err) => {
        logger.warn(
          { error: (err as Error).message },
          'notifyTelegramHandoff falhou (drive nao afetado)',
        );
      });
  }

  private resolveWindow(): BrowserWindow | null {
    try {
      const win = this.getWindow();
      if (win) return win;
    } catch {
    }
    const wins = BrowserWindow.getAllWindows();
    return wins.length > 0 ? wins[0] : null;
  }

  private tokensFromMetrics(metrics: SprintCompletePayload['metrics']): number {
    if (!metrics || typeof metrics !== 'object') return 0;
    const m = metrics as Record<string, unknown>;
    const total = m['totalTokens'];
    if (typeof total === 'number') return total;
    const tin = typeof m['tokensIn'] === 'number' ? (m['tokensIn'] as number) : 0;
    const tout = typeof m['tokensOut'] === 'number' ? (m['tokensOut'] as number) : 0;
    return tin + tout;
  }

  private enforceBudget(projectId: string, rt: DriveRuntimeState): void {
    if (rt.tokensSpent >= DRIVE_TOKEN_BUDGET) {
      this.escalate(
        projectId,
        rt,
        `O drive atingiu o budget de tokens (${DRIVE_TOKEN_BUDGET.toLocaleString('pt-BR')}). ` +
          `Parei por seguranca. Quer que eu continue (responda "retomar") ou prefere assumir?`,
        { stop: true, reason: 'budget' },
      );
    }
  }
}


let _coordinator: PipelineDriveCoordinator | null = null;

export function initPipelineDriveCoordinator(
  getWindow: () => BrowserWindow | null,
): PipelineDriveCoordinator {
  if (_coordinator) return _coordinator;
  _coordinator = new PipelineDriveCoordinator(getWindow);
  _coordinator.start();
  _coordinator.recoverInterruptedDrives();
  return _coordinator;
}

export function getPipelineDriveCoordinator(): PipelineDriveCoordinator | null {
  return _coordinator;
}

export function _resetPipelineDriveCoordinatorForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error(
      '_resetPipelineDriveCoordinatorForTesting can only be called in test environment',
    );
  }
  if (_coordinator) _coordinator.stop();
  _coordinator = null;
}
