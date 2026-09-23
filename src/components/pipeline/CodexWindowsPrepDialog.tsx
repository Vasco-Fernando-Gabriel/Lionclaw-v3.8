import { useState, useCallback, useEffect } from 'react';
import { AlertTriangle, X, CheckCircle2, AlertOctagon, Loader2 } from 'lucide-react';
import type { CodexPrepCheckResult, CodexPrepApplyResult } from '@/types';

interface Props {
  check: CodexPrepCheckResult;
  onClose: () => void;
  onDone?: (result: CodexPrepApplyResult | null) => void;
}

export function CodexWindowsPrepDialog({ check, onClose, onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CodexPrepApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeCheck, setActiveCheck] = useState<CodexPrepCheckResult>(check);

  useEffect(() => {
    setActiveCheck(check);
    setResult(null);
    setError(null);
  }, [check]);

  const handlePrepare = useCallback(async () => {
    if (!activeCheck.repoRoot) return;
    setBusy(true);
    setError(null);
    try {
      const res = (await window.lionclaw.codex.applyPrep(activeCheck.repoRoot)) as CodexPrepApplyResult;
      setResult(res);
      if (!res.applied) {
        const reason = res.reason;
        const msg =
          reason === 'dirty-tree'
            ? 'Working tree tem mudancas nao commitadas alem do .gitattributes do prep. Commite ou stash primeiro.'
            : reason === 'has-submodules'
              ? 'Repo tem submodules — auto-prep nao roda por seguranca.'
              : reason === 'no-git-repo'
                ? 'Path nao e repo Git valido.'
                : reason === 'error'
                  ? `Erro: ${res.message ?? 'desconhecido'}`
                  : `Pulado: ${reason}`;
        setError(msg);
        return;
      }

      const followup = (await window.lionclaw.codex.checkPrepNeeded(activeCheck.repoRoot)) as CodexPrepCheckResult;
      if (followup.needs) {
        setActiveCheck(followup);
        setResult(null);
        setError(
          'Preparacao aplicada, mas ainda existem issues detectados. Revise a lista atualizada e tente novamente se fizer sentido.',
        );
        return;
      }

      onDone?.(res);
      setTimeout(onClose, 1500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [activeCheck.repoRoot, onClose, onDone]);

  const handleSkipForever = useCallback(async () => {
    if (!activeCheck.repoRoot) return;
    setBusy(true);
    try {
      await window.lionclaw.codex.grantSkipConsent(activeCheck.repoRoot);
      onDone?.(null);
      onClose();
    } finally {
      setBusy(false);
    }
  }, [activeCheck.repoRoot, onClose, onDone]);

  if (!activeCheck.needs || !activeCheck.repoRoot) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg max-w-2xl w-full mx-4 shadow-2xl">
        <div className="flex items-start justify-between p-5 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-6 h-6 text-amber-400" />
            <h2 className="text-lg font-semibold text-zinc-100">Preparar projeto pra Codex no Windows?</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-zinc-500 hover:text-zinc-300 disabled:opacity-30"
            aria-label="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-sm text-zinc-300">
            Codex CLI tem dificuldade com line endings Windows (CRLF) e encoding UTF-8 sem BOM. Sem esta preparacao,
            edicoes de codigo podem falhar em loop (apply_patch verification failed).
          </p>

          <div className="bg-zinc-950/50 rounded p-3 border border-zinc-800">
            <div className="text-xs text-zinc-400 uppercase font-medium mb-2">Issues detectados</div>
            <ul className="space-y-1.5 text-sm">
              {activeCheck.issues?.map((issue) => (
                <li key={issue.type} className="flex items-start gap-2">
                  <span
                    className={`text-xs font-mono px-1.5 py-0.5 rounded mt-0.5 flex-shrink-0 ${
                      issue.severity === 'high'
                        ? 'bg-red-900/40 text-red-200'
                        : issue.severity === 'medium'
                          ? 'bg-amber-900/40 text-amber-200'
                          : 'bg-zinc-800 text-zinc-400'
                    }`}
                  >
                    {issue.severity.toUpperCase()}
                  </span>
                  <div>
                    <div className="text-zinc-200">{issue.message}</div>
                    <div className="text-xs text-zinc-500 mt-0.5">{issue.hint}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-zinc-950/50 rounded p-3 border border-zinc-800">
            <div className="text-xs text-zinc-400 uppercase font-medium mb-2">
              Sera feito UMA VEZ (re-pedido se a preparacao mudar)
            </div>
            <ul className="text-xs text-zinc-300 space-y-1 font-mono">
              <li>1. git config core.autocrlf false (local, nao global)</li>
              <li>2. Criar/atualizar .gitattributes com '* text=auto eol=lf'</li>
              <li>3. git add .gitattributes && git add --renormalize .</li>
              <li>4. Reescrever em LF arquivos rastreados com w/crlf ou mixed</li>
            </ul>
          </div>

          <div className="text-xs text-zinc-500">
            <span className="font-medium text-zinc-400">Repo:</span>{' '}
            <span className="font-mono">{activeCheck.repoRoot}</span>
          </div>

          <div className="text-xs text-amber-300/70 bg-amber-950/20 rounded p-2 border border-amber-900/40">
            <span className="font-medium">Pre-requisito:</span> working tree limpo ou contendo apenas .gitattributes
            gerado por este preparo. Arquivos ignorados, untracked e binarios nao entram.
          </div>

          {error && (
            <div className="bg-red-950/30 border border-red-900/50 rounded p-3 flex items-start gap-2">
              <AlertOctagon className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-red-200">{error}</div>
            </div>
          )}

          {result?.applied && (
            <div className="bg-green-950/30 border border-green-900/50 rounded p-3 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-green-200">
                Preparado com sucesso. {result.filesAffected} arquivo(s) renormalizado(s).
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 p-5 border-t border-zinc-800 bg-zinc-950/30">
          <button
            type="button"
            onClick={handleSkipForever}
            disabled={busy}
            className="text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
          >
            Nunca para este projeto
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-3 py-1.5 text-sm rounded text-zinc-300 hover:bg-zinc-800 disabled:opacity-30"
            >
              Agora nao
            </button>
            <button
              type="button"
              onClick={handlePrepare}
              disabled={busy || result?.applied}
              className="px-4 py-1.5 text-sm rounded bg-amber-600 hover:bg-amber-500 text-white font-medium flex items-center gap-2 disabled:opacity-50"
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Preparar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
