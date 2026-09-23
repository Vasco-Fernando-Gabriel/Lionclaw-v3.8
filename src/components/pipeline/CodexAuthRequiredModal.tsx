import { useEffect, useState, useCallback } from 'react';
import type { HarnessProject } from '@/types';

interface AuthRequiredPayload {
  projectId: string;
  phaseNumber: number;
  agentId: string;
  message: string;
  provider: 'codex' | 'grok' | 'kimi';
  runtime: 'codex' | 'grok' | 'kimi';
  ownerKind?: 'pipeline' | 'harness' | 'enrich';
  roundId?: string;
}

export function authRequiredPayloadFromProject(project: HarnessProject): AuthRequiredPayload | null {
  const checkpoint = project.config.providerAuthCheckpoint;
  if (!checkpoint) return null;
  const isRecoverable =
    project.status === 'paused' || (project.status === 'running' && checkpoint.claimState === 'claimed');
  if (!isRecoverable) return null;
  const providerLabel =
    checkpoint.provider === 'grok' ? 'Grok Build' : checkpoint.provider === 'kimi' ? 'Kimi' : 'Codex';
  return {
    projectId: project.id,
    phaseNumber: checkpoint.phaseNumber,
    agentId: checkpoint.agentId,
    message: `Reconecte o ${providerLabel} e verifique a autenticacao para retomar do checkpoint salvo.`,
    provider: checkpoint.provider,
    runtime: checkpoint.provider,
    ownerKind: checkpoint.ownerKind,
    ...(checkpoint.roundId ? { roundId: checkpoint.roundId } : {}),
  };
}

export function CodexAuthRequiredModal() {
  const [payload, setPayload] = useState<AuthRequiredPayload | null>(null);
  const [authVerified, setAuthVerified] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  useEffect(() => {
    const unsub = window.lionclaw.pipeline.onAuthRequired((data) => {
      setPayload(data);
      setAuthVerified(false);
      setTestMessage(null);
    });
    let cancelled = false;
    void window.lionclaw.harness
      .listProjects()
      .then((projects) => {
        if (cancelled) return;
        const recovered = projects
          .map(authRequiredPayloadFromProject)
          .find((candidate): candidate is AuthRequiredPayload => candidate !== null);
        if (recovered) setPayload((current) => current ?? recovered);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const handleReconectar = useCallback(async () => {
    if (payload?.provider === 'grok') await window.lionclaw.grok.openLogin();
    else if (payload?.provider === 'kimi') await window.lionclaw.kimi.openLogin();
    else await window.lionclaw.codex.openLogin();
  }, [payload]);

  const handleVerificar = useCallback(async () => {
    setTesting(true);
    setTestMessage(null);
    try {
      const result =
        payload?.provider === 'grok'
          ? await window.lionclaw.grok.test()
          : payload?.provider === 'kimi'
            ? await window.lionclaw.kimi.status().then((status) => ({
                ok: status.usable,
                message: status.reason ?? (status.usable ? 'Kimi autenticado.' : 'Kimi ainda nao autenticado.'),
              }))
            : ((await window.lionclaw.codex.test()) as { ok: boolean; message: string });
      if (result.ok) {
        setAuthVerified(true);
        setTestMessage('Autenticado com sucesso.');
      } else {
        setAuthVerified(false);
        setTestMessage(result.message ?? 'Ainda nao autenticado.');
      }
    } catch {
      setAuthVerified(false);
      setTestMessage('Erro ao verificar autenticacao.');
    } finally {
      setTesting(false);
    }
  }, [payload]);

  const handleRetomar = useCallback(async () => {
    if (!payload || !authVerified) return;
    setResuming(true);
    try {
      const result =
        payload.ownerKind === 'harness'
          ? await window.lionclaw.harness.resumeAfterAuth(payload.projectId, payload.provider)
          : payload.ownerKind === 'enrich'
            ? await window.lionclaw.enrich.resumeAfterAuth(payload.projectId, payload.provider)
            : await window.lionclaw.pipeline.resumeAfterAuth(payload.projectId, payload.provider);
      if (!result || (!('error' in result) && 'ok' in result && result.ok)) {
        setPayload(null);
      } else {
        setTestMessage(
          'message' in result
            ? result.message
            : (result.error ?? 'Nao foi possivel retomar. Tente verificar novamente.'),
        );
        setAuthVerified(false);
      }
    } catch {
      setTestMessage('Erro ao retomar pipeline.');
    } finally {
      setResuming(false);
    }
  }, [payload, authVerified]);

  const handleCancelar = useCallback(async () => {
    if (!payload) return;
    setAborting(true);
    try {
      if (payload.ownerKind === 'harness') await window.lionclaw.harness.abort(payload.projectId);
      else if (payload.ownerKind === 'enrich') await window.lionclaw.enrich.abort(payload.projectId);
      else await window.lionclaw.pipeline.abort(payload.projectId);
    } finally {
      setPayload(null);
      setAborting(false);
    }
  }, [payload]);

  if (!payload) return null;
  const isGrok = payload.provider === 'grok';
  const isKimi = payload.provider === 'kimi';
  const providerLabel = isGrok ? 'Grok Build' : isKimi ? 'Kimi' : 'Codex';
  const loginCommand = isGrok ? 'grok login --device-auth' : isKimi ? 'kimi acp --login' : 'codex login';
  const executionLabel =
    payload.ownerKind === 'harness' ? 'harness' : payload.ownerKind === 'enrich' ? 'enrich' : 'pipeline';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
        <h2 className="text-lg font-semibold text-white mb-2">{providerLabel} desconectado</h2>

        <p className="text-sm text-zinc-300 mb-1">
          O {executionLabel} foi pausado porque o {providerLabel} perdeu a autenticacao por assinatura durante a
          execucao da fase {payload.phaseNumber}.
        </p>

        <p className="text-xs text-zinc-500 mb-4 font-mono bg-zinc-800 rounded p-2 break-words">{payload.message}</p>

        <p className="text-sm text-zinc-300 mb-4">
          Clique em <span className="font-medium text-amber-400">Reconectar</span> para abrir o terminal com{' '}
          <code className="text-amber-400">{loginCommand}</code>, autentique-se, depois clique em{' '}
          <span className="font-medium text-amber-400">Verificar</span> para confirmar e{' '}
          <span className="font-medium text-green-400">Retomar {executionLabel}</span> para continuar.
        </p>

        {testMessage && (
          <p
            className={`text-xs mb-4 px-3 py-2 rounded ${
              authVerified
                ? 'bg-green-900/40 text-green-300 border border-green-700'
                : 'bg-red-900/40 text-red-300 border border-red-700'
            }`}
          >
            {testMessage}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <button
            onClick={handleReconectar}
            className="w-full px-4 py-2 text-sm font-medium rounded-lg bg-amber-700 hover:bg-amber-600 text-white transition-colors"
          >
            Reconectar (abre {isGrok ? 'grok login' : isKimi ? 'kimi login' : 'codex login'})
          </button>

          <button
            onClick={handleVerificar}
            disabled={testing}
            className="w-full px-4 py-2 text-sm font-medium rounded-lg bg-zinc-700 hover:bg-zinc-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {testing ? 'Verificando...' : 'Verificar autenticacao'}
          </button>

          <button
            onClick={handleRetomar}
            disabled={!authVerified || resuming}
            className="w-full px-4 py-2 text-sm font-medium rounded-lg bg-green-700 hover:bg-green-600 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {resuming ? 'Retomando...' : `Retomar ${executionLabel}`}
          </button>

          <button
            onClick={handleCancelar}
            disabled={aborting}
            className="w-full px-4 py-2 text-sm font-medium rounded-lg border border-zinc-600 text-zinc-400 hover:text-red-400 hover:border-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {aborting ? 'Cancelando...' : `Cancelar ${executionLabel}`}
          </button>
        </div>
      </div>
    </div>
  );
}
