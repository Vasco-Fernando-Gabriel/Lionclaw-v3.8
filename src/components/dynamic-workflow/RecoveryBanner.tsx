import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  PlayCircle,
  Clock,
  UserCog,
  Square,
  LifeBuoy,
  RotateCcw,
  KeyRound,
} from 'lucide-react';
import type { DynamicWorkflowRun, DynamicWorkflowSnapshot } from '@/types';
import { translateLlmError } from '@/utils/translate-llm-error';


export type RecoveryScenario =
  | 'stall'
  | 'provider-limit'
  | 'provider-auth'
  | 'policy-changed'
  | 'interrupted'
  | 'failed'
  | 'node-failed'
  | 'none';

const PROVIDER_FAILURE_CLASSES = ['provider-limit', 'provider-error', 'timeout'];

export interface RecoveryView {
  scenario: RecoveryScenario;
  title: string;
  reason: string;
  nodeId: string | null;
}

interface PendingDecisionShape {
  type?: string;
  prompt?: string;
  nodeId?: string;
  failureClass?: string;
  retriesExhausted?: boolean;
  policyChanged?: boolean;
  invalidatedNodeIds?: string[];
  nodeError?: string | null;
}

export function readPendingDecision(run: DynamicWorkflowRun): PendingDecisionShape | null {
  try {
    const input = JSON.parse(run.inputJson || '{}') as { pendingDecision?: PendingDecisionShape };
    return input.pendingDecision ?? null;
  } catch {
    return null;
  }
}

export interface StallInfo {
  message: string;
  at: string;
}

export function deriveRecoveryView(
  run: DynamicWorkflowRun | null,
  snapshot: DynamicWorkflowSnapshot | null,
  stall: StallInfo | null = null,
): RecoveryView {
  const none: RecoveryView = { scenario: 'none', title: '', reason: '', nodeId: null };
  if (!run) return none;

  const pd = readPendingDecision(run);
  const snapPd = (snapshot?.pendingDecision ?? null) as PendingDecisionShape | null;

  const infoPd = [pd, snapPd].find((p) => p?.type === 'error');
  if (run.status === 'blocked' && infoPd) {
    return {
      scenario: 'node-failed',
      title: 'Bloqueado por infra (inconclusivo)',
      reason:
        infoPd.prompt ??
        'Os checks nao produziram veredito (toolchain/infra). Conserte o ambiente e retome.',
      nodeId: infoPd.nodeId ?? null,
    };
  }

  if (pd?.type === 'provider' || snapPd?.type === 'provider') {
    if (pd?.policyChanged) {
      return {
        scenario: 'policy-changed',
        title: 'Permissao/config mudou',
        reason:
          pd.prompt ??
          'A permissao ou config de um ou mais nodes mudou desde a ultima execucao. Aceite reusar os resultados antigos ou reexecute os nodes afetados.',
        nodeId: pd.nodeId ?? null,
      };
    }
    if (pd?.failureClass === 'provider-auth') {
      return {
        scenario: 'provider-auth',
        title: 'Autenticacao caiu',
        reason: pd.prompt ?? 'A credencial do provedor expirou. Reconecte em Settings > Provedores e clique em Retomar.',
        nodeId: pd.nodeId ?? null,
      };
    }
    const fc = pd?.failureClass ?? snapPd?.failureClass;
    if (fc && !PROVIDER_FAILURE_CLASSES.includes(fc)) {
      return {
        scenario: 'node-failed',
        title: fc === 'schema' ? 'Saida fora do schema' : 'Falha no node',
        reason:
          (fc === 'schema'
            ? 'O node nao produziu saida no formato esperado (schema). Ajuste e re-execute a rodada (Resetar node/rodada) ou resolva com agente.'
            : `O node falhou no proprio trabalho (${fc}), nao e limite de provedor. Ajuste o escopo/plano e re-execute a rodada (Resetar node/rodada) ou resolva com agente.`) +
          (pd?.nodeError ?? snapPd?.nodeError
            ? `\n\nErro do node: ${pd?.nodeError ?? snapPd?.nodeError}`
            : ''),
        nodeId: pd?.nodeId ?? snapPd?.nodeId ?? null,
      };
    }

    return {
      scenario: 'provider-limit',
      title: 'Limite do provedor',
      reason:
        pd?.prompt ??
        snapPd?.prompt ??
        'O limite do provedor estourou. Retomar agora, Agendar retomada, Trocar agente ou Abortar.',
      nodeId: pd?.nodeId ?? null,
    };
  }

  if (run.status === 'interrupted') {
    return {
      scenario: 'interrupted',
      title: 'Interrompido',
      reason: 'O run foi interrompido (queda do app ou pausa). Retomar de onde parou; o progresso foi preservado (WIP commit).',
      nodeId: run.currentNodeId ?? null,
    };
  }

  if (run.status === 'failed') {
    let failedReason =
      run.error ??
      'O run falhou. Retomar (re-executa do checkpoint, historico preservado), Resolver com agente ou abortar.';
    if (run.error) {
      const humanized = translateLlmError({ error: run.error });
      if (humanized.code !== 'UNKNOWN') {
        failedReason = `${humanized.body}\n\nErro: ${run.error}`;
      }
    }
    return {
      scenario: 'failed',
      title: 'Falha no run',
      reason: failedReason,
      nodeId: run.currentNodeId ?? null,
    };
  }

  if (
    stall &&
    run.status !== 'running' &&
    run.status !== 'delivered' &&
    run.status !== 'completed' &&
    run.status !== 'aborted'
  ) {
    return {
      scenario: 'stall',
      title: 'Sem progresso',
      reason: stall.message,
      nodeId: run.currentNodeId ?? null,
    };
  }

  return none;
}


export function formatCountdown(atIso: string | null, nowMs: number): string | null {
  if (!atIso) return null;
  const at = Date.parse(atIso);
  if (Number.isNaN(at)) return null;
  const remaining = Math.max(0, at - nowMs);
  const totalSec = Math.ceil(remaining / 1000);
  if (totalSec <= 0) return 'agora';
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min}min${sec > 0 ? ` ${sec}s` : ''}`;
  return `${sec}s`;
}


export interface RecoveryBannerProps {
  run: DynamicWorkflowRun | null;
  snapshot: DynamicWorkflowSnapshot | null;
  scheduledResumeAt: string | null;
  stalled?: StallInfo | null;
  onResume: () => void;
  onReopen: () => void;
  onScheduleResume: () => void;
  onAbort: () => void;
  onResolveWithCloser: () => void;
  onSwitchAgent: (nodeId: string | null) => void;
  onResetNode: (nodeId: string | null) => void;
}

export function RecoveryBanner({
  run,
  snapshot,
  scheduledResumeAt,
  stalled = null,
  onResume,
  onReopen,
  onScheduleResume,
  onAbort,
  onResolveWithCloser,
  onSwitchAgent,
  onResetNode,
}: RecoveryBannerProps) {
  const view = deriveRecoveryView(run, snapshot, stalled);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!scheduledResumeAt) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [scheduledResumeAt]);

  if (view.scenario === 'none') return null;

  const countdown = formatCountdown(scheduledResumeAt, nowMs);

  return (
    <div
      className="flex flex-col gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5 shrink-0"
      data-testid="recovery-banner"
      data-scenario={view.scenario}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-amber-200">{view.title}</span>
            {view.nodeId && (
              <span className="font-mono text-[10px] text-amber-300/70">[{view.nodeId}]</span>
            )}
            {countdown && (
              <span
                className="rounded-md border border-amber-500/40 px-1.5 py-0.5 font-mono text-[10px] text-amber-300"
                data-testid="recovery-countdown"
              >
                nova tentativa em {countdown}
              </span>
            )}
          </div>
          <p className="whitespace-pre-wrap break-words text-[11px] text-amber-100/90">{view.reason}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 pl-6">
        {/* Acao deterministica por cenario (1 clique - 13.8). */}
        {(view.scenario === 'provider-limit' ||
          view.scenario === 'provider-auth' ||
          view.scenario === 'interrupted' ||
          view.scenario === 'policy-changed' ||
          view.scenario === 'node-failed' ||
          view.scenario === 'stall') && (
          <RecoveryButton
            onClick={onResume}
            icon={<PlayCircle size={12} />}
            label={view.scenario === 'provider-limit' ? 'Retomar agora' : 'Retomar'}
            tone="green"
          />
        )}
        {view.scenario === 'provider-limit' && (
          <>
            <RecoveryButton
              onClick={onScheduleResume}
              icon={<Clock size={12} />}
              label="Agendar retomada"
              tone="amber"
              title="Re-tenta quando a janela do provedor renovar (backoff)"
            />
            <RecoveryButton
              onClick={() => onSwitchAgent(view.nodeId)}
              icon={<UserCog size={12} />}
              label="Trocar agente"
              tone="amber"
              title="Continua o node com outro provedor (switch-agent, 14.1.1)"
            />
          </>
        )}
        {view.scenario === 'provider-auth' && (
          <span className="flex items-center gap-1 text-[10px] text-amber-300/70">
            <KeyRound size={11} /> reconecte o provedor antes de retomar
          </span>
        )}
        {/* SM-51 (REGRA MAXIMA): num run failed a acao PRIMARIA e Retomar (reopen ->
            resume re-executa do checkpoint saneando o plano; branch e historico
            preservados). NUNCA um beco sem saida. */}
        {view.scenario === 'failed' && (
          <RecoveryButton
            onClick={onReopen}
            icon={<PlayCircle size={12} />}
            label="Retomar"
            tone="green"
            title="Re-executa do checkpoint saneando o plano; branch e historico preservados"
          />
        )}
        {/* Resetar node/rodada em interrupted E node-failed: ha node vivo e o
            requestReplan scope:node faz sentido (re-executa a rodada do node que
            falhou por trabalho). Num failed estrutural pre-node o currentNodeId
            costuma ser null e o reset cairia num no-op (botao morto) - removido. */}
        {(view.scenario === 'interrupted' || view.scenario === 'node-failed') &&
          view.nodeId && (
          <RecoveryButton
            onClick={() => onResetNode(view.nodeId)}
            icon={<RotateCcw size={12} />}
            label="Resetar node/rodada"
            tone="amber"
            title="git reset ao commit do node anterior + nova attempt (13.8)"
          />
        )}

        {/* Botao universal de TODA linha (13.8): Resolver com agente (closer 8.8). */}
        <RecoveryButton
          onClick={onResolveWithCloser}
          icon={<LifeBuoy size={12} />}
          label="Resolver com agente"
          tone="amber"
          title="Abre o chat do closer com o contexto do problema (8.8)"
        />

        {/* Abortar: a branch dynworkflow/<runId> fica VIVA por default (autopsia). */}
        <RecoveryButton
          onClick={onAbort}
          icon={<Square size={12} />}
          label="Abortar"
          tone="red"
          title="Aborta o run; a branch fica viva por default para autopsia"
        />
      </div>
    </div>
  );
}

function RecoveryButton({
  onClick,
  icon,
  label,
  tone,
  title,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tone: 'green' | 'amber' | 'red';
  title?: string;
}) {
  const toneClass =
    tone === 'green'
      ? 'text-green-400 border-green-500/30 hover:bg-green-500/10'
      : tone === 'red'
        ? 'text-zinc-400 border-zinc-700 hover:bg-red-500/10 hover:text-red-400'
        : 'text-amber-300 border-amber-500/30 hover:bg-amber-500/10';
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors ${toneClass}`}
    >
      {icon}
      {label}
    </button>
  );
}
