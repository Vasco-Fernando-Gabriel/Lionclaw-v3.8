import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Pause,
  PlayCircle,
  Square,
  LifeBuoy,
  Loader2,
  Camera,
  RotateCcw,
  HelpCircle,
  LayoutDashboard,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import {
  useDynamicWorkflowStore,
  deriveTouchedFilesFromEvents,
} from '@/stores/dynamic-workflow-store';
import { parseSqliteUtc } from '@/lib/sqlite-time';
import { AbortRunConfirm } from './AbortRunConfirm';
import { deriveRoundsFromNodeRuns } from './WorkflowProgressBar';
import { WorkflowCockpitRail, deriveTouchedFiles } from './WorkflowCockpitRail';
import { WorkflowStreamView } from './WorkflowStreamView';
import { WorkflowEventTimeline, buildTimelineFeed } from './WorkflowEventTimeline';
import { DynamicWorkflowNodeTimeline } from './DynamicWorkflowNodeTimeline';
import { WorkflowCostTab } from './WorkflowCostTab';
import { WorkflowOutputsTab } from './WorkflowOutputsTab';
import { WorkflowHandoffView } from './WorkflowHandoffView';
import {
  DynamicWorkflowGateModal,
  type GateCheckView,
  type GateFindingView,
} from './DynamicWorkflowGateModal';
import { RecoveryBanner } from './RecoveryBanner';
import type { DynamicWorkflowUIStatus } from '@/stores/dynamic-workflow-store';

type RunTab = 'stream' | 'execution' | 'cost' | 'outputs' | 'timeline';


function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function checkFromEntry(entry: unknown, ok: boolean): GateCheckView | null {
  if (typeof entry === 'string') {
    return entry.length > 0 ? { id: entry, label: entry, ok } : null;
  }
  const r = asRecord(entry);
  if (!r) return null;
  const id =
    typeof r.id === 'string' ? r.id : typeof r.label === 'string' ? r.label : null;
  if (!id) return null;
  return {
    id,
    label: typeof r.label === 'string' ? r.label : id,
    ok,
    detail: typeof r.detail === 'string' ? r.detail : undefined,
  };
}

function findingFromEntry(entry: unknown): GateFindingView | null {
  const r = asRecord(entry);
  if (!r) return null;
  const problem =
    typeof r.problem === 'string'
      ? r.problem
      : typeof r.detail === 'string'
        ? r.detail
        : null;
  if (!problem) return null;
  return {
    severity: typeof r.severity === 'string' ? r.severity : 'P2',
    where: typeof r.where === 'string' ? r.where : undefined,
    problem,
    fix: typeof r.fix === 'string' ? r.fix : undefined,
  };
}

export function deriveGateViews(
  events: import('@/types').DynamicWorkflowEvent[],
  gateId: string | null,
): { gateChecks: GateCheckView[]; gateFindings: GateFindingView[] } {
  const empty = { gateChecks: [] as GateCheckView[], gateFindings: [] as GateFindingView[] };
  let checksArr: unknown[] | null = null;
  for (const ev of events) {
    if (ev.type !== 'gate-blocked') continue;
    let payload: Record<string, unknown> | null = null;
    try {
      payload = asRecord(ev.payloadJson ? JSON.parse(ev.payloadJson) : null);
    } catch {
      payload = null;
    }
    if (!payload) continue;
    if (gateId && typeof payload.gateId === 'string' && payload.gateId !== gateId) {
      continue;
    }
    if (Array.isArray(payload.checks)) checksArr = payload.checks;
  }
  if (!checksArr) return empty;

  const checks: GateCheckView[] = [];
  const findings: GateFindingView[] = [];
  for (const e of checksArr) {
    const rec = asRecord(e);
    const ok = rec ? rec.ok === true : false;
    const c = checkFromEntry(e, ok);
    if (c) checks.push(c);
    if (!ok) {
      const f = findingFromEntry(e);
      if (f) findings.push(f);
    }
  }
  return { gateChecks: checks, gateFindings: findings };
}

export function findPendingOpenedAtMs(
  events: import('@/types').DynamicWorkflowEvent[],
  match: (eventType: string) => boolean,
): number | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (!match(ev.type)) continue;
    const date = parseSqliteUtc(ev.createdAt);
    return date ? date.getTime() : null;
  }
  return null;
}


export interface DynamicWorkflowRunViewProps {
  runId: string;
}

export function DynamicWorkflowRunView({ runId }: DynamicWorkflowRunViewProps) {
  const run = useDynamicWorkflowStore((s) => s.selectedRun);
  const nodes = useDynamicWorkflowStore((s) => s.nodes);
  const nodeRuns = useDynamicWorkflowStore((s) => s.nodeRuns);
  const manifest = useDynamicWorkflowStore((s) => s.manifest);
  const artifacts = useDynamicWorkflowStore((s) => s.artifacts);
  const snapshot = useDynamicWorkflowStore((s) => s.snapshot);
  const nodeStreams = useDynamicWorkflowStore((s) => s.nodeStreams);
  const selectedRoundIndex = useDynamicWorkflowStore((s) => s.selectedRoundIndex);
  const error = useDynamicWorkflowStore((s) => s.error);
  const streamingRunIds = useDynamicWorkflowStore((s) => s.streamingRunIds);

  const events = useDynamicWorkflowStore((s) => s.events);
  const structuralEvents = useDynamicWorkflowStore((s) => s.structuralEvents);
  const pendingQuestion = useDynamicWorkflowStore((s) => s.pendingQuestion);
  const closerThread = useDynamicWorkflowStore((s) => s.closerThread);
  const closerBusyRunIds = useDynamicWorkflowStore((s) => s.closerBusyRunIds);

  const closeRun = useDynamicWorkflowStore((s) => s.closeRun);
  const pause = useDynamicWorkflowStore((s) => s.pause);
  const resume = useDynamicWorkflowStore((s) => s.resume);
  const scheduleResume = useDynamicWorkflowStore((s) => s.scheduleResume);
  const abort = useDynamicWorkflowStore((s) => s.abort);
  const reopenRun = useDynamicWorkflowStore((s) => s.reopenRun);
  const approveGate = useDynamicWorkflowStore((s) => s.approveGate);
  const selectRound = useDynamicWorkflowStore((s) => s.selectRound);
  const getUIStatus = useDynamicWorkflowStore((s) => s.getUIStatus);
  const start = useDynamicWorkflowStore((s) => s.start);
  const sendMessage = useDynamicWorkflowStore((s) => s.sendMessage);
  const resolveWithCloser = useDynamicWorkflowStore((s) => s.resolveWithCloser);
  const finalizeWorkflow = useDynamicWorkflowStore((s) => s.finalizeWorkflow);
  const switchAgent = useDynamicWorkflowStore((s) => s.switchAgent);
  const resetNodeRound = useDynamicWorkflowStore((s) => s.resetNodeRound);
  const scheduledResumeAtMap = useDynamicWorkflowStore((s) => s.scheduledResumeAt);
  const stalledByRun = useDynamicWorkflowStore((s) => s.stalledByRun);
  const narrationByRun = useDynamicWorkflowStore((s) => s.narrationByRun);
  const persistedNarrationByRun = useDynamicWorkflowStore(
    (s) => s.persistedNarrationByRun,
  );
  const gateDecisionsByRun = useDynamicWorkflowStore((s) => s.gateDecisionsByRun);

  const [tab, setTab] = useState<RunTab>('stream');
  const [gateOpen, setGateOpen] = useState(false);
  const [abortConfirmOpen, setAbortConfirmOpen] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<{ nodeId: string | null } | null>(null);
  const [switchAgentId, setSwitchAgentId] = useState('');
  const [showRunDetail, setShowRunDetail] = useState(false);
  const [questionReply, setQuestionReply] = useState('');
  const [questionReplySending, setQuestionReplySending] = useState(false);

  const scheduledResumeAt = scheduledResumeAtMap[runId] ?? null;
  const stalled = stalledByRun[runId] ?? null;
  const liveNarration = narrationByRun[runId] ?? null;
  const persistedNarration = persistedNarrationByRun[runId] ?? null;
  const narrationLines =
    liveNarration && liveNarration.length > 0 ? liveNarration : persistedNarration;
  const gateDecisions = gateDecisionsByRun[runId] ?? null;

  const uiStatus: DynamicWorkflowUIStatus = getUIStatus(runId);
  const isStreaming = streamingRunIds.has(runId);

  const isRunning = uiStatus === 'running' || uiStatus === 'streaming';
  const isPausing = uiStatus === 'pausing';
  const isPausable = (isRunning || uiStatus === 'awaiting-user' || uiStatus === 'blocked') && !isPausing;
  const isResumable = uiStatus === 'paused' || uiStatus === 'interrupted';
  const isReopenable = uiStatus === 'aborted' || uiStatus === 'failed';
  const isStartable = uiStatus === 'created';
  const isTerminal =
    uiStatus === 'completed' || uiStatus === 'failed';

  const isClosingPhase = uiStatus === 'delivered' || uiStatus === 'completed';

  async function submitQuestionReply(): Promise<void> {
    const text = questionReply.trim();
    if (text.length === 0 || questionReplySending) return;
    setQuestionReplySending(true);
    try {
      const result = await sendMessage(runId, text);
      if (!('error' in result)) {
        setQuestionReply('');
      }
    } finally {
      setQuestionReplySending(false);
    }
  }

  const workflowName = useMemo<string>(() => {
    const fallback = `Workflow ${runId.slice(0, 8)}`;
    if (!run?.inputJson) return fallback;
    try {
      const parsed = JSON.parse(run.inputJson) as { name?: unknown };
      return typeof parsed.name === 'string' && parsed.name.trim()
        ? parsed.name
        : fallback;
    } catch {
      return fallback;
    }
  }, [run?.inputJson, runId]);

  const composerFeed = useMemo(() => buildTimelineFeed(events, nodeRuns), [events, nodeRuns]);

  const streamNodes = useMemo(() => {
    const order = new Map(nodes.map((n, i) => [n.nodeId, i]));
    return Object.values(nodeStreams).sort(
      (a, b) =>
        (order.get(a.nodeId) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.nodeId) ?? Number.MAX_SAFE_INTEGER),
    );
  }, [nodeStreams, nodes]);

  const liveTouchedFiles = useMemo(() => deriveTouchedFiles(nodeStreams), [nodeStreams]);
  const durableTouched = useMemo(
    () => deriveTouchedFilesFromEvents(structuralEvents),
    [structuralEvents],
  );
  const touchedFiles = durableTouched.files.length > 0 ? durableTouched.files : liveTouchedFiles;

  const runningNodeIdsWithoutStream = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const nr of nodeRuns) {
      if (nr.status !== 'running') continue;
      if (seen.has(nr.nodeId)) continue;
      seen.add(nr.nodeId);
      if (!nodeStreams[nr.nodeId]) out.push(nr.nodeId);
    }
    return out;
  }, [nodeRuns, nodeStreams]);

  const parallelGroupNodeIds = useMemo(() => {
    const runningByPhase = new Map<string, string[]>();
    for (const nr of nodeRuns) {
      if (nr.status !== 'running') continue;
      const list = runningByPhase.get(nr.phaseId) ?? [];
      list.push(nr.nodeId);
      runningByPhase.set(nr.phaseId, list);
    }
    for (const ids of runningByPhase.values()) {
      if (ids.length >= 2) return ids;
    }
    return [];
  }, [nodeRuns]);

  const selectedRoundNodeIds = useMemo(() => {
    if (selectedRoundIndex === null) return null;
    const round = deriveRoundsFromNodeRuns(nodeRuns).find(
      (r) => r.index === selectedRoundIndex,
    );
    return round ? round.nodeIds : null;
  }, [nodeRuns, selectedRoundIndex]);

  const rawPendingDecision = snapshot?.pendingDecision ?? null;
  const pendingGate = rawPendingDecision?.type === 'gate' ? rawPendingDecision : null;
  const pendingInfoBlock =
    rawPendingDecision && rawPendingDecision.type === 'error' ? rawPendingDecision : null;
  const { gateChecks, gateFindings } = useMemo(
    () => deriveGateViews(structuralEvents, pendingGate?.id ?? null),
    [structuralEvents, pendingGate?.id],
  );

  const gateAllowsReplan = useMemo(() => {
    if (!pendingGate || pendingGate.type !== 'gate') return false;
    const gate = manifest?.gates.find((g) => g.id === pendingGate.id);
    return gate?.kind === 'plan-review';
  }, [manifest, pendingGate]);

  const gateKindLabel = useMemo<string | null>(() => {
    if (!pendingGate || pendingGate.type !== 'gate') return null;
    const gate = manifest?.gates.find((g) => g.id === pendingGate.id);
    if (!gate) return null;
    if (gate.kind === 'plan-review') return 'revise o plano de sprints';
    if (gate.kind === 'delivery') return 'merge/aceite da entrega';
    return null;
  }, [manifest, pendingGate]);

  const gatePrompt =
    gateKindLabel ?? pendingGate?.prompt ?? undefined;

  const gateOpenedAtMs = useMemo(
    () =>
      findPendingOpenedAtMs(
        structuralEvents,
        (t) =>
          t === 'gate-blocked' ||
          (t.includes('gate') && (t.includes('pending') || t.includes('awaiting'))),
      ),
    [structuralEvents],
  );
  const questionOpenedAtMs = useMemo(
    () => findPendingOpenedAtMs(events, (t) => t.includes('question')),
    [events],
  );


  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header (padrao DriveControls; sem seletor de autonomia - 13.6) */}
      <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-950/80 px-4 py-2.5 shrink-0">
        <button
          type="button"
          onClick={closeRun}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800"
        >
          <ArrowLeft size={14} />
          Voltar
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-zinc-100">
              {run?.currentPhaseId
                ? `Workflow - ${run.currentPhaseId}`
                : `Workflow ${runId.slice(0, 8)}`}
            </span>
            {(isRunning || isStreaming || isPausing) && (
              <Loader2 size={12} className="animate-spin text-amber-400 shrink-0" />
            )}
          </div>
          {run?.worktreePath && (
            <p className="truncate font-mono text-[11px] text-zinc-500">
              {run.worktreePath}
            </p>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {/* SM-34: enquanto pausando, mostra estado intermediario (no encerrando). */}
          {isPausing && (
            <HeaderButton
              onClick={() => {}}
              disabled
              className="text-amber-300 border-amber-500/30 opacity-70"
              icon={<Loader2 size={12} className="animate-spin" />}
              label="pausando..."
            />
          )}
          {isPausable && (
            <HeaderButton
              onClick={() => void pause(runId)}
              className="text-zinc-300 border-zinc-700 hover:bg-zinc-800"
              icon={<Pause size={12} />}
              label="Parar"
            />
          )}
          {isStartable && (
            <HeaderButton
              onClick={() => void start(runId)}
              className="text-green-400 border-green-500/30 hover:bg-green-500/10"
              icon={<PlayCircle size={12} />}
              label="Iniciar"
            />
          )}
          {isResumable && (
            <HeaderButton
              onClick={() => void resume(runId)}
              className="text-green-400 border-green-500/30 hover:bg-green-500/10"
              icon={<PlayCircle size={12} />}
              label="Retomar"
            />
          )}
          {/* SM-37/SM-51: Reabrir para runs abortados E failed (REGRA MAXIMA -
              recuperabilidade). reopen transiciona terminal -> interrupted e
              re-executa do checkpoint (SM-50 saneia o plano no re-materialize). */}
          {isReopenable && (
            <HeaderButton
              onClick={() => void reopenRun(runId)}
              className="text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
              icon={<RotateCcw size={12} />}
              label="Reabrir"
              title="Retomar do checkpoint (branch e historico preservados)"
            />
          )}
          {/* Resolver com agente (closer): SPEC 13.8 - botao em TODA linha de
              friccao (blocked/interrupted/failed). Abre/retoma a sessao do closer
              com o contexto do problema injetado (resolve-with-closer). Em
              delivered/completed o closer ja e a tela principal (CloserChatView),
              entao o botao do header so aparece fora da fase de fechamento. */}
          {(uiStatus === 'blocked' ||
            uiStatus === 'interrupted' ||
            uiStatus === 'failed') && (
            <HeaderButton
              onClick={() => {
                void resolveWithCloser(
                  runId,
                  'Estado de friccao: usuario pediu ajuda do agente de fechamento.',
                ).then(() => setTab('stream'));
              }}
              className="text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
              icon={<LifeBuoy size={12} />}
              label="Resolver com agente"
              title="Abre o chat do closer com o contexto do problema (8.8)"
            />
          )}
          {/* SM-36: popup de confirmacao antes de abortar (semi-destrutivo). */}
          {!isTerminal && !isReopenable && (
            <HeaderButton
              onClick={() => setAbortConfirmOpen(true)}
              className="text-zinc-400 border-zinc-700 hover:bg-red-500/10 hover:text-red-400"
              icon={<Square size={12} />}
              label="Abortar"
              title="Para a execucao mas preserva tudo (da pra Reabrir)"
            />
          )}
        </div>
      </div>

      {/* Erro */}
      {error && (
        <div className="border-b border-red-500/20 bg-red-500/10 px-4 py-1.5 text-[11px] text-red-300 shrink-0">
          {error}
        </div>
      )}

      {/* Topo declutter (pedido do dono): a barra de fase (nos PLA/DES + chip de
          sprint) foi REMOVIDA - era so ruido ocupando o topo. O chat (esquerda) e o
          cockpit (direita) sobem ate o topo. A fase e a sprint atual ja aparecem no
          Cockpit (campo FASE + chip de sprint no rail). */}

      {/* Gate pendente: banner com CTA para o modal (AC-9). Inc6: pulse dot +
          "aguardando ha Xmin" para parecer estado vivo, nao travado. */}
      {pendingGate && (uiStatus === 'blocked' || uiStatus === 'awaiting-user') && (
        <button
          type="button"
          onClick={() => setGateOpen(true)}
          className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-left text-[11px] text-amber-200 transition-colors hover:bg-amber-500/15 shrink-0"
          data-testid="gate-pending-banner"
        >
          <PulseDot />
          <span className="font-semibold">Decisao pendente ({pendingGate.type}):</span>
          <span className="truncate">{gatePrompt}</span>
          <PendingWaitedFor openedAtMs={gateOpenedAtMs} />
          <span className="ml-auto rounded-md border border-amber-500/40 px-2 py-0.5 text-amber-300">
            Revisar
          </span>
        </button>
      )}

      {/* Bloqueio INFORMATIVO (inconclusivo/infra): sem modal de gate — o
          RETOMAR e a decisao (re-roda os checks apos o conserto da infra). */}
      {pendingInfoBlock && uiStatus === 'blocked' && (
        <div
          className="flex items-center gap-2 border-b border-sky-500/30 bg-sky-500/10 px-4 py-2 text-[11px] text-sky-200 shrink-0"
          data-testid="info-block-banner"
        >
          <PulseDot />
          <span className="font-semibold">
            Run bloqueado (infra):
          </span>
          <span className="truncate">{pendingInfoBlock.prompt}</span>
          <span className="ml-auto rounded-md border border-sky-500/40 px-2 py-0.5 text-sky-300">
            Retomar destrava
          </span>
        </div>
      )}

      {/* Pergunta de agente pendente (13.3.4.2): a attempt segue `running` no DB
          (status NUNCA persistido como awaiting - AC-23); a UI deriva awaiting-user
          do evento `question-pending` + pendingQuestion. E6.2: a resposta volta
          para a MESMA attempt pelo REPLY INLINE deste banner (campo + Enviar),
          ligado a `dynamic-workflow:send-message` SEM o marcador do Maestro
          (caminho `runner.intervene`). Resolve a pergunta sem o chat do Maestro
          (que sai no E6.3). Banner so quando ha pergunta viva. */}
      {pendingQuestion && (
        <div
          className="flex flex-col gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[11px] text-amber-200 shrink-0"
          data-testid="question-pending-banner"
        >
          <div className="flex items-start gap-2">
            <HelpCircle size={13} className="mt-0.5 shrink-0 text-amber-400" />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <PulseDot />
                <span className="font-semibold">O agente perguntou</span>
                {pendingQuestion.nodeId && (
                  <span className="font-mono text-amber-300/70">[{pendingQuestion.nodeId}]</span>
                )}
                <PendingWaitedFor openedAtMs={questionOpenedAtMs} />
              </div>
              <p className="break-words text-amber-100/90">{pendingQuestion.prompt}</p>
              <p className="mt-0.5 text-[10px] text-amber-300/60">
                Responda aqui mesmo (a resposta volta para a mesma tentativa).
              </p>
            </div>
          </div>
          {/* E6.2: reply inline. Enter envia (Shift+Enter quebra linha). */}
          <div className="flex items-end gap-2 pl-[21px]">
            <textarea
              value={questionReply}
              onChange={(e) => setQuestionReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submitQuestionReply();
                }
              }}
              rows={1}
              placeholder="Responda a pergunta do agente..."
              disabled={questionReplySending}
              data-testid="question-reply-input"
              className="min-h-[30px] flex-1 resize-y rounded-md border border-amber-500/30 bg-zinc-950/60 px-2 py-1.5 text-[11px] text-amber-100 outline-none placeholder:text-amber-300/40 focus:border-amber-500/60 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void submitQuestionReply()}
              disabled={questionReply.trim().length === 0 || questionReplySending}
              data-testid="question-reply-send"
              className="shrink-0 rounded-md border border-amber-500/40 px-3 py-1.5 text-[11px] font-medium text-amber-200 transition-colors hover:bg-amber-500/15 disabled:opacity-40"
            >
              {questionReplySending ? 'Enviando...' : 'Enviar'}
            </button>
          </div>
        </div>
      )}

      {/* S17: banner da jornada de recuperacao (13.8). Estado NOMEADO + motivo +
          acao de 1 clique por cenario (provider-limit/auth, interrompido,
          policy-changed, falha) + countdown do backoff + "Resolver com agente" em
          toda linha. So aparece em friccao (blocked/interrupted/failed). */}
      <RecoveryBanner
        run={run}
        snapshot={snapshot}
        scheduledResumeAt={scheduledResumeAt}
        stalled={stalled}
        onResume={() => void resume(runId)}
        onReopen={() => void reopenRun(runId)}
        onScheduleResume={() => void scheduleResume(runId)}
        onAbort={() => setAbortConfirmOpen(true)}
        onResolveWithCloser={() => {
          void resolveWithCloser(
            runId,
            'Estado de friccao: usuario pediu ajuda do agente de fechamento.',
          ).then(() => setTab('stream'));
        }}
        onSwitchAgent={(nodeId) => {
          setSwitchAgentId('');
          setSwitchTarget({ nodeId });
        }}
        onResetNode={(nodeId) => {
          if (!nodeId) return;
          void resetNodeRound(runId, nodeId, 'Resetar node/rodada (13.8): refazer do commit anterior.');
        }}
      />

      {/* S17: dialogo inline de troca de agente (provider-limit -> switch-agent).
          Pede o id do agente novo; delega ao store.switchAgent (valida catalogo +
          preflight 8.7 + ampliacao de permissao no main - 14.1.1). */}
      {switchTarget && (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-zinc-950/90 px-4 py-2 shrink-0">
          <span className="text-[11px] text-zinc-300">
            Trocar agente do node{' '}
            <span className="font-mono text-amber-300">{switchTarget.nodeId ?? '(atual)'}</span>:
          </span>
          <input
            type="text"
            value={switchAgentId}
            onChange={(e) => setSwitchAgentId(e.target.value)}
            placeholder="id do agente novo"
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none focus:border-amber-500/50"
          />
          <button
            type="button"
            disabled={!switchAgentId.trim() || !switchTarget.nodeId}
            onClick={() => {
              const nodeId = switchTarget.nodeId;
              if (!nodeId) return;
              void switchAgent(
                runId,
                nodeId,
                switchAgentId.trim(),
                'Limite do provedor: trocar para outro agente (13.8/14.1.1).',
              ).then(() => setSwitchTarget(null));
            }}
            className="rounded-md border border-green-500/30 px-2 py-1 text-[11px] font-medium text-green-400 transition-colors hover:bg-green-500/10 disabled:opacity-40"
          >
            Trocar
          </button>
          <button
            type="button"
            onClick={() => setSwitchTarget(null)}
            className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800"
          >
            Cancelar
          </button>
        </div>
      )}

      {/* Fase de FECHAMENTO (delivered/completed): a tela vira o HANDOFF pro
          ORQUESTRADOR. Mostra o resumo de "como rodar" (walkthrough do closer,
          read-only) + o botao "Encerrar e abrir no orquestrador". Encerrar (REGRA
          MAXIMA) NAO deleta: finaliza (delivered -> completed, preservado) e passa
          o contexto da entrega ao orquestrador, navegando pro Chat (draft no
          composer pra revisar e enviar). O orquestrador so RECEBE a mensagem: sem
          embed/mistura, sem tocar orchestrator.ts. Substitui as abas/stream/
          composer enquanto durar. */}
      {isClosingPhase && !showRunDetail ? (
        <WorkflowHandoffView
          runId={runId}
          projectName={workflowName}
          status={run?.status ?? uiStatus}
          projectPath={run?.projectPath ?? null}
          branch={run?.baseBranch ?? null}
          closerThread={closerThread}
          closerBusy={closerBusyRunIds.has(runId)}
          nodeRuns={nodeRuns}
          nodes={nodes}
          totalCostUsd={run?.totalCostUsd ?? null}
          onViewDetails={() => setShowRunDetail(true)}
          onFinalize={() => finalizeWorkflow(runId)}
        />
      ) : (
        <>
      {/* Quando o run ja fechou mas o usuario abriu o DETALHE (tela anterior),
          um banner permite voltar pra tela de entrega/metricas. */}
      {isClosingPhase && showRunDetail && (
        <div className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-4 py-1.5 shrink-0">
          <span className="text-[11px] text-amber-300/90">Detalhes do run (encerrado)</span>
          <button
            type="button"
            onClick={() => setShowRunDetail(false)}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800"
            data-testid="back-to-delivery"
          >
            <ArrowLeft size={12} />
            Voltar à entrega
          </button>
        </div>
      )}
      {/* Corpo (E6.3): a coluna esquerda do chat do Maestro per-run FOI REMOVIDA.
          O orquestrador principal dirige o run pelo chat principal; a RunView e um
          COCKPIT PURO (controle + visibilidade). O cockpit ocupa a tela inteira:
          rail limpo (narracao re-hidratada do DB - E6.1; fase/custo/tempo/tokens;
          decisoes de gate do driver) + abas SECUNDARIAS lazy (stream cru, inspecao,
          linha do tempo). O envio do humano se da pelo reply inline do banner de
          pergunta (E6.2) e pelo chat principal. */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
      <div
        className="flex flex-1 flex-col min-h-0"
        data-testid="run-cockpit"
      >
        {/* Cabecalho do cockpit: titulo no topo da coluna (mesmo padrao do header
            do ActivityPanel do chat do orquestrador). */}
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <LayoutDashboard size={13} className="text-zinc-500" />
            <span className="text-[11px] font-medium text-zinc-300">Cockpit</span>
            {isStreaming && (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
            )}
          </div>
        </div>
        {/* Rail do cockpit: fase/custo/tempo/tokens + agentes agrupados por fase.
            Ganha mais altura (flex-[1.6]); as abas secundarias lazy ficam no rodape
            (flex-1). */}
        <div className="flex min-h-0 flex-[1.6] overflow-hidden border-b border-zinc-800">
          <WorkflowCockpitRail
            run={run}
            nodeRuns={nodeRuns}
            nodes={nodes}
            manifest={manifest}
            isStreaming={isStreaming}
            touchedFiles={touchedFiles}
            nodeStreams={nodeStreams}
            gateDecisions={gateDecisions ?? undefined}
            narration={
              narrationLines && narrationLines.length > 0 ? (
                <NarrationFeed lines={narrationLines} />
              ) : isRunning && run?.currentNodeId ? (
                <span className="font-mono text-[10px] text-zinc-500">
                  trabalhando... (no {run.currentNodeId} rodando)
                </span>
              ) : undefined
            }
          />
        </div>

        {/* Abas SECUNDARIAS lazy (sec 5.1 / D20-D25): Stream, Execucao (+Ambiente),
            Custo, Saidas, Linha do tempo. So a aba ativa monta (lazy). */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-800 px-2 shrink-0">
            {(
              [
                ['stream', 'Stream'],
                ['execution', 'Execucao'],
                ['cost', 'Custo'],
                ['outputs', 'Saidas'],
                ['timeline', 'Linha do tempo'],
              ] as [RunTab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`whitespace-nowrap px-2.5 py-1.5 text-[11px] font-medium transition-colors border-b-2 -mb-px ${
                  tab === key
                    ? 'border-amber-500 text-amber-300'
                    : 'border-transparent text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-1 flex-col overflow-hidden min-h-0">
            {tab === 'stream' && (
              <WorkflowStreamView
                nodes={streamNodes}
                parallelGroupNodeIds={parallelGroupNodeIds}
                pendingNodeIds={runningNodeIdsWithoutStream}
              />
            )}
            {tab === 'execution' && (
              <div className="flex flex-1 flex-col overflow-y-auto min-h-0">
                <EnvironmentHeader
                  run={run}
                  lastCheckpointAt={snapshot?.lastCheckpointAt ?? null}
                  nodeRunCount={nodeRuns.length}
                />
                {selectedRoundNodeIds && (
                  <div
                    className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-4 py-1.5 text-[11px] text-amber-200 shrink-0"
                    data-testid="round-filter-banner"
                  >
                    <RotateCcw size={11} className="shrink-0" />
                    <span className="font-semibold">
                      Rodada {selectedRoundIndex !== null ? selectedRoundIndex + 1 : ''}
                    </span>
                    <span className="text-amber-300/70">
                      {selectedRoundNodeIds.length} nodes
                    </span>
                    <button
                      type="button"
                      onClick={() => selectRound(null)}
                      className="ml-auto rounded-md border border-amber-500/30 px-2 py-0.5 text-amber-300 transition-colors hover:bg-amber-500/10"
                    >
                      Ver todas
                    </button>
                  </div>
                )}
                <DynamicWorkflowNodeTimeline
                  manifest={manifest}
                  nodes={nodes}
                  nodeRuns={nodeRuns}
                  filterNodeIds={selectedRoundNodeIds}
                />
              </div>
            )}
            {tab === 'cost' && (
              <WorkflowCostTab
                nodeRuns={nodeRuns}
                manifest={manifest}
                totalCostUsd={run?.totalCostUsd ?? 0}
                totalDurationMs={run?.totalDurationMs ?? 0}
              />
            )}
            {tab === 'outputs' && (
              <WorkflowOutputsTab
                runId={runId}
                run={run}
                touched={durableTouched}
                liveTouchedFiles={liveTouchedFiles}
                artifacts={artifacts}
              />
            )}
            {/* Linha do tempo (eventos + intervencoes, payload projetado, hora
                local), aba lazy (sec 5.1/5.3, D22). */}
            {tab === 'timeline' && <WorkflowEventTimeline feed={composerFeed} />}
          </div>
        </div>
      </div>
      </div>
        </>
      )}

      {/* SM-36: popup de confirmacao de abortar (semi-destrutivo: para mas preserva). */}
      {abortConfirmOpen && (
        <AbortRunConfirm
          runId={runId}
          onCancel={() => setAbortConfirmOpen(false)}
          onConfirm={() => {
            setAbortConfirmOpen(false);
            void abort(runId);
          }}
        />
      )}

      {/* Modal de gate (AC-9) */}
      {pendingGate && (
        <DynamicWorkflowGateModal
          open={gateOpen}
          gateId={pendingGate.id}
          mode="human"
          prompt={gatePrompt}
          checks={gateChecks}
          findings={gateFindings}
          allowReplan={gateAllowsReplan}
          onClose={() => setGateOpen(false)}
          onDecide={async (decision, reason) => {
            const input =
              decision === 'replan'
                ? {
                    decision: 'approve' as const,
                    payload: { action: 'replan' },
                    ...(reason ? { reason } : {}),
                  }
                : { decision, ...(reason ? { reason } : {}) };
            return await approveGate(runId, pendingGate.id, input);
          }}
        />
      )}
    </div>
  );
}


function HeaderButton({
  onClick,
  className,
  icon,
  label,
  title,
  disabled,
}: {
  onClick: () => void;
  className: string;
  icon: React.ReactNode;
  label: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-40 ${className}`}
    >
      {icon}
      {label}
    </button>
  );
}

function PulseDot() {
  return (
    <span className="relative flex h-2 w-2 shrink-0" aria-hidden data-testid="pulse-dot">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" />
    </span>
  );
}

function formatWaited(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  return `${min}min`;
}

function PendingWaitedFor({ openedAtMs }: { openedAtMs: number | null }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (openedAtMs === null) return;
    let id: ReturnType<typeof setInterval>;
    const schedule = () => {
      const elapsedMs = Date.now() - openedAtMs;
      const stepMs = elapsedMs < 60_000 ? 1_000 : 30_000;
      id = setInterval(() => {
        setNowMs(Date.now());
        if (Date.now() - openedAtMs >= 60_000 && stepMs === 1_000) {
          clearInterval(id);
          schedule();
        }
      }, stepMs);
    };
    schedule();
    return () => clearInterval(id);
  }, [openedAtMs]);
  if (openedAtMs === null) return null;
  return (
    <span
      className="rounded-md border border-amber-500/40 px-1.5 py-0.5 font-mono text-[10px] text-amber-300/80"
      data-testid="pending-waited-for"
    >
      aguardando ha {formatWaited(Math.max(0, nowMs - openedAtMs))}
    </span>
  );
}

function NarrationFeed({ lines }: { lines: string[] }) {
  const lastIndex = lines.length - 1;
  return (
    <div className="flex flex-col gap-0.5" data-testid="narration-feed">
      {lines.map((line, i) => (
        <p
          key={`${i}-${line.slice(0, 12)}`}
          className={
            i === lastIndex
              ? 'text-[11px] leading-relaxed text-zinc-200'
              : 'text-[10px] leading-relaxed text-zinc-500'
          }
        >
          {line}
        </p>
      ))}
    </div>
  );
}

function EnvironmentHeader({
  run,
  lastCheckpointAt,
  nodeRunCount,
}: {
  run: import('@/types').DynamicWorkflowRun | null;
  lastCheckpointAt: string | null;
  nodeRunCount: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-zinc-800 shrink-0" data-testid="execution-environment">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-4 py-1.5 text-left text-[11px] font-medium text-zinc-300 transition-colors hover:bg-zinc-900/60"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0 text-zinc-500" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-zinc-500" />
        )}
        Ambiente
        <span className="ml-1 font-mono text-[10px] text-zinc-500">
          {run?.workspaceMode ?? '(nao decidido)'}
        </span>
        <span className="ml-auto font-mono text-[10px] text-zinc-500">
          {nodeRunCount} node_run{nodeRunCount === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 px-4 pb-3 text-[11px]" data-testid="execution-environment-fields">
          <Field label="Definition" value={run?.definitionId ?? '-'} mono />
          <Field label="Modo de workspace" value={run?.workspaceMode ?? '(nao decidido)'} />
          <Field label="Branch base" value={run?.baseBranch ?? '-'} mono />
          <Field label="Commit base" value={run?.baseCommitSha?.slice(0, 12) ?? '-'} mono />
          <Field label="Worktree" value={run?.worktreePath ?? '-'} mono />
          <Field
            label="Ultimo checkpoint"
            value={lastCheckpointAt ?? '(nenhum)'}
            icon={<Camera size={11} className="text-zinc-500" />}
          />
          <Field label="Nodes" value={String(nodeRunCount)} mono />
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-36 shrink-0 text-zinc-500">{label}</span>
      <span className={`min-w-0 break-all text-zinc-300 ${mono ? 'font-mono' : ''}`}>
        {icon && <span className="mr-1 inline-flex align-middle">{icon}</span>}
        {value}
      </span>
    </div>
  );
}
