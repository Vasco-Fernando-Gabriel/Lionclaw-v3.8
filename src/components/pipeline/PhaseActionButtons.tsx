import { useState } from 'react';
import {
  ThumbsUp,
  XCircle,
  AlertTriangle,
  Square,
  Rocket,
  CheckCircle2,
} from 'lucide-react';
import { usePipelineStore } from '@/stores/pipeline-store';
import { useActiveProjectState } from '@/hooks/useActiveProjectState';


interface FeedbackInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

function FeedbackInput({ value, onChange, placeholder }: FeedbackInputProps) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={2}
      className="w-full rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 placeholder-zinc-600 px-3 py-2 resize-none focus:outline-none focus:border-zinc-500"
    />
  );
}

const APPROVAL_PHASES = new Set([1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);


interface ApprovalButtonsProps {
  disabled: boolean;
  onApprove: () => void;
  label?: string;
}

function ApprovalButtons({ disabled, onApprove, label = 'Aprovar' }: ApprovalButtonsProps) {
  return (
    <div className="flex gap-2 justify-center">
      <button
        onClick={onApprove}
        disabled={disabled}
        className="flex items-center gap-1.5 px-5 py-2 text-xs font-semibold bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ThumbsUp size={13} />
        {label}
      </button>
    </div>
  );
}


interface MaxLoopsPausedButtonsProps {
  disabled: boolean;
  onAcceptWithRestrictions: () => void;
  onRejectSprint: (feedback: string) => void;
  onAbort: () => void;
}

function MaxLoopsPausedButtons({
  disabled,
  onAcceptWithRestrictions,
  onRejectSprint,
  onAbort,
}: MaxLoopsPausedButtonsProps) {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');

  const handleRejectClick = () => {
    if (!showFeedback) {
      setShowFeedback(true);
      return;
    }
    onRejectSprint(feedback);
    setFeedback('');
    setShowFeedback(false);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 justify-center mb-1">
        <AlertTriangle size={12} className="text-amber-400" />
        <span className="text-[11px] text-amber-400 font-medium">
          Limite de loops atingido
        </span>
      </div>
      {showFeedback && (
        <FeedbackInput
          value={feedback}
          onChange={setFeedback}
          placeholder="Feedback para nova tentativa..."
        />
      )}
      <div className="flex flex-wrap gap-2 justify-center">
        <button
          onClick={onAcceptWithRestrictions}
          disabled={disabled}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <CheckCircle2 size={13} />
          Aceitar com Restricoes
        </button>
        <button
          onClick={handleRejectClick}
          disabled={disabled}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-red-600/80 hover:bg-red-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <XCircle size={13} />
          {showFeedback ? 'Confirmar Rejeicao' : 'Rejeitar Sprint'}
        </button>
        <button
          onClick={onAbort}
          disabled={disabled}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-zinc-400 border border-zinc-700 hover:border-red-500/40 hover:text-red-400 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Square size={13} />
          Abortar Pipeline
        </button>
        {showFeedback && (
          <button
            onClick={() => { setShowFeedback(false); setFeedback(''); }}
            className="px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}



interface BugGateButtonsProps {
  disabled: boolean;
  onApprovePlan: () => void;
  onClosePipeline: () => void;
}

function BugGateButtons({ disabled, onApprovePlan, onClosePipeline }: BugGateButtonsProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 justify-center mb-1">
        <AlertTriangle size={12} className="text-amber-400" />
        <span className="text-[11px] text-amber-400 font-medium">
          Plano de correcao pronto: aprovar a correcao ou encerrar sem corrigir
        </span>
      </div>
      <div className="flex flex-wrap gap-2 justify-center">
        <button
          onClick={onApprovePlan}
          disabled={disabled}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ThumbsUp size={13} />
          Aprovar
        </button>
        <button
          onClick={onClosePipeline}
          disabled={disabled}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-zinc-300 border border-zinc-700 hover:border-red-500/40 hover:text-red-400 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Square size={13} />
          Encerrar Pipeline
        </button>
      </div>
    </div>
  );
}


interface DevConfirmationButtonsProps {
  disabled: boolean;
  onConfirm: () => void;
  onAbort: () => void;
}

function DevConfirmationButtons({ disabled, onConfirm, onAbort }: DevConfirmationButtonsProps) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-amber-300 text-center font-medium">
        Plano de sprints aprovado. Iniciar desenvolvimento?
      </p>
      <div className="flex gap-2 justify-center">
        <button
          onClick={onConfirm}
          disabled={disabled}
          className="flex items-center gap-1.5 px-5 py-2 text-xs font-semibold bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Rocket size={13} />
          Iniciar Desenvolvimento
        </button>
        <button
          onClick={onAbort}
          disabled={disabled}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-zinc-400 border border-zinc-700 hover:border-red-500/40 hover:text-red-400 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Square size={13} />
          Abortar
        </button>
      </div>
    </div>
  );
}


interface PhaseActionButtonsProps {
  currentPhase: number | null;
  pausedByMaxLoops?: boolean;
  readOnly?: boolean;
}

export function PhaseActionButtons({
  currentPhase,
  pausedByMaxLoops = false,
  readOnly = false,
}: PhaseActionButtonsProps) {
  const isStreaming = useActiveProjectState(s => s.isStreaming) ?? false;
  const awaitingUser = useActiveProjectState(s => s.awaitingUser) ?? false;
  const agentCompleted = useActiveProjectState(s => s.agentCompleted) ?? false;
  const phaseStatus = useActiveProjectState(s => s.phaseStatus) ?? '';
  const pipelineType = usePipelineStore(s => {
    const p = s.projects.find((proj) => proj.id === s.activeProjectId);
    return p?.pipelineType ?? 'development';
  });
  const getCurrentMessages = usePipelineStore(s => s.getCurrentMessages);
  const approvePhase = usePipelineStore(s => s.approvePhase);
  const abortPipeline = usePipelineStore(s => s.abortPipeline);
  const confirmDevelopment = usePipelineStore(s => s.confirmDevelopment);

  const disabled = isStreaming;
  const messages = getCurrentMessages();

  if (readOnly) return null;

  if (!awaitingUser || isStreaming) return null;

  const handleApprove = () => void approvePhase();
  const handleAbort = () => void abortPipeline();

  const hasAssistantMessage = messages.some((m) => m.role === 'assistant');

  const containerClass =
    'border-t border-amber-500/20 bg-amber-500/5 px-4 py-3 shrink-0';
  const innerClass = 'max-w-2xl mx-auto';
  const titleClass = 'text-xs text-amber-400 font-medium text-center mb-3';

  if (pausedByMaxLoops) {
    return (
      <div className={containerClass}>
        <div className={innerClass}>
          <MaxLoopsPausedButtons
            disabled={disabled}
            onAcceptWithRestrictions={() => void approvePhase({ acceptWithRestrictions: true })}
            onRejectSprint={(feedback: string) => void approvePhase({ feedback })}
            onAbort={handleAbort}
          />
        </div>
      </div>
    );
  }

  if (currentPhase === null) return null;


  if (phaseStatus === 'awaiting-dev-confirmation') {
    return (
      <div className={containerClass}>
        <div className={innerClass}>
          <DevConfirmationButtons
            disabled={disabled}
            onConfirm={() => void confirmDevelopment()}
            onAbort={() => void abortPipeline()}
          />
        </div>
      </div>
    );
  }

  if (pipelineType === 'bug' && currentPhase === 3) {
    return (
      <div className={containerClass}>
        <div className={innerClass}>
          <BugGateButtons
            disabled={disabled || !hasAssistantMessage}
            onApprovePlan={() => void approvePhase({ action: 'approve-plan' })}
            onClosePipeline={() => void approvePhase({ action: 'close-pipeline' })}
          />
        </div>
      </div>
    );
  }

  if (APPROVAL_PHASES.has(currentPhase)) {
    const approvalDisabled = disabled || !hasAssistantMessage;
    const isArchPhase4 =
      pipelineType === 'architecture-review' && currentPhase === 4;
    const approvalLabel = isArchPhase4
      ? 'Fechar decisoes e gerar SPEC'
      : 'Aprovar';
    const hintText = isArchPhase4
      ? agentCompleted
        ? 'Entrevista cobriu o essencial. Fechar dispara a geracao da SPEC (~5-10min).'
        : 'Continue a entrevista ou feche quando achar que cobriu o essencial. Fechar gera a SPEC automaticamente.'
      : agentCompleted
        ? 'Agente concluiu esta fase. Clique em Aprovar para avancar.'
        : 'Voce pode continuar conversando ou clicar em Aprovar para avancar.';
    return (
      <div className={containerClass}>
        <div className={innerClass}>
          <p className={titleClass}>{hintText}</p>
          <ApprovalButtons
            disabled={approvalDisabled}
            onApprove={handleApprove}
            label={approvalLabel}
          />
        </div>
      </div>
    );
  }

  return null;
}
