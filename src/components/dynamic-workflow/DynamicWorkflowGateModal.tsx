import { useState } from 'react';
import { ShieldCheck, Check, X, Loader2, AlertTriangle, RotateCcw } from 'lucide-react';

export interface GateCheckView {
  id: string;
  label?: string;
  ok: boolean;
  detail?: string;
}

export interface GateFindingView {
  severity: string;
  where?: string;
  problem: string;
  fix?: string;
}

export interface DynamicWorkflowGateModalProps {
  open: boolean;
  gateId: string;
  mode: 'auto' | 'orchestrator' | 'human';
  prompt?: string;
  checks?: GateCheckView[];
  findings?: GateFindingView[];
  allowReplan?: boolean;
  onClose: () => void;
  onDecide: (decision: 'approve' | 'reject' | 'replan', reason?: string) => Promise<string | null>;
}

function severityColor(sev: string): string {
  const s = sev.toUpperCase();
  if (s === 'P1' || s === 'CRITICAL' || s === 'BLOCKER') return 'text-red-400 border-red-500/40 bg-red-500/10';
  if (s === 'P2' || s === 'MAJOR') return 'text-amber-300 border-amber-500/40 bg-amber-500/10';
  return 'text-zinc-400 border-zinc-700 bg-zinc-800/60';
}

export function DynamicWorkflowGateModal({
  open,
  gateId,
  mode,
  prompt,
  checks = [],
  findings = [],
  allowReplan = false,
  onClose,
  onDecide,
}: DynamicWorkflowGateModalProps) {
  const [reason, setReason] = useState('');
  const [deciding, setDeciding] = useState<'approve' | 'reject' | 'replan' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const canDecide = mode === 'human' || mode === 'orchestrator';
  const allOk = checks.length > 0 && checks.every((c) => c.ok);
  const failedCount = checks.filter((c) => !c.ok).length;
  const actionable = findings.filter((f) => {
    const s = f.severity.toUpperCase();
    return s === 'P1' || s === 'P2' || s === 'CRITICAL' || s === 'MAJOR' || s === 'BLOCKER';
  });

  const handle = async (decision: 'approve' | 'reject' | 'replan') => {
    setDeciding(decision);
    setError(null);
    const err = await onDecide(decision, reason.trim() || undefined);
    setDeciding(null);
    if (err) {
      setError(err);
      return;
    }
    onClose();
  };

  const approveLabel = 'Aprovar';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/75 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-3 border-b border-zinc-800 shrink-0">
          <ShieldCheck size={16} className="text-amber-400 shrink-0" />
          <h2 className="text-sm font-semibold text-zinc-100 leading-tight">{`Gate: ${gateId}`}</h2>
          <span className="ml-auto text-[10px] font-mono text-zinc-500">{mode}</span>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto">
          {prompt && <p className="text-xs text-zinc-300 leading-relaxed">{prompt}</p>}

          {/* Checks deterministicos */}
          {checks.length > 0 && (
            <div>
              <p className="text-xs font-medium text-zinc-400 mb-1.5">
                Checks ({checks.length - failedCount}/{checks.length} ok)
              </p>
              <ul className="flex flex-col gap-1">
                {checks.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 text-[11px] bg-zinc-800/60 rounded px-2 py-1">
                    {c.ok ? (
                      <Check size={12} className="text-green-400 shrink-0 mt-0.5" />
                    ) : (
                      <X size={12} className="text-red-400 shrink-0 mt-0.5" />
                    )}
                    <span className="min-w-0">
                      <span className="font-mono text-zinc-300">{c.label ?? c.id}</span>
                      {c.detail && <span className="block text-zinc-500">{c.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Findings estruturados (7.5) */}
          {findings.length > 0 && (
            <div>
              <p className="text-xs font-medium text-zinc-400 mb-1.5">
                Findings ({actionable.length} acionaveis de {findings.length})
              </p>
              <ul className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
                {findings.map((f, i) => (
                  <li key={`${f.problem}-${i}`} className="rounded border border-zinc-800 bg-zinc-800/40 px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-bold ${severityColor(f.severity)}`}
                      >
                        {f.severity}
                      </span>
                      {f.where && <span className="font-mono text-[10px] text-zinc-500 truncate">{f.where}</span>}
                    </div>
                    <p className="mt-1 text-[11px] text-zinc-300">{f.problem}</p>
                    {f.fix && <p className="mt-0.5 text-[10px] text-zinc-500">fix: {f.fix}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Resumo do estado do gate */}
          {checks.length > 0 && (
            <div
              className={`flex items-start gap-2.5 rounded-lg px-3 py-2.5 border ${
                allOk ? 'border-green-500/30 bg-green-500/10' : 'border-amber-500/30 bg-amber-500/10'
              }`}
            >
              <AlertTriangle size={14} className={`${allOk ? 'text-green-400' : 'text-amber-400'} shrink-0 mt-0.5`} />
              <p className={`text-xs leading-relaxed ${allOk ? 'text-green-300' : 'text-amber-200'}`}>
                {allOk
                  ? 'Todos os checks passaram. Aprovar libera o merge/entrega.'
                  : allowReplan
                    ? 'Ha findings no plano. Aprovar materializa o plano corrente; "Voltar pro planner" roda mais uma rodada com os findings.'
                    : 'Ha checks falhando. Aprovar mesmo assim e decisao sua.'}
              </p>
            </div>
          )}

          {/* Motivo opcional (auditado em gate_decisions.reason) */}
          {canDecide && (
            <div>
              <label className="text-[11px] text-zinc-500 mb-1 block">Motivo (opcional, auditado)</label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-amber-500/50 focus:outline-none"
                placeholder="Ex: aprovado, findings restantes sao falsos positivos"
              />
            </div>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 pb-5 pt-1 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={deciding !== null}
            className="px-4 py-1.5 text-xs font-medium rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors disabled:opacity-40"
          >
            Fechar
          </button>
          {canDecide && (
            <>
              <button
                type="button"
                onClick={() => void handle('reject')}
                disabled={deciding !== null}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg border border-red-500/40 text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-50"
              >
                {deciding === 'reject' && <Loader2 size={11} className="animate-spin" />}
                Rejeitar
              </button>
              {/* SM-2 (gate humano leve): voltar pro planner (re-plan) em vez de
                  aprovar as-is. So no gate de plano (allowReplan). Roda UMA rodada
                  extra de planner com os findings. */}
              {allowReplan && (
                <button
                  type="button"
                  data-testid="gate-replan-button"
                  onClick={() => void handle('replan')}
                  disabled={deciding !== null}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg border border-sky-500/40 text-sky-300 hover:bg-sky-500/10 transition-colors disabled:opacity-50"
                >
                  {deciding === 'replan' ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                  Voltar pro planner
                </button>
              )}
              <button
                type="button"
                onClick={() => void handle('approve')}
                disabled={deciding !== null}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50"
              >
                {deciding === 'approve' && <Loader2 size={11} className="animate-spin" />}
                {approveLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
