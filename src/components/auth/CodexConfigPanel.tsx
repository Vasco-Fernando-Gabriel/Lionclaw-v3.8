import { useState, useEffect } from 'react';
import {
  CheckCircle,
  XCircle,
  Terminal,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  ArrowRight,
} from 'lucide-react';
import { CODEX_DEFAULT_MODEL } from '@/constants/codex-models';
import type { SdkCompleteHandler } from '@/types';

interface CodexStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  appServerSupported: boolean;
  error?: string;
}

interface CodexConfigPanelProps {
  onComplete: SdkCompleteHandler;
}

export function CodexConfigPanel({ onComplete }: CodexConfigPanelProps) {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testPassed, setTestPassed] = useState(false);
  const [showPathField, setShowPathField] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const [savingPath, setSavingPath] = useState(false);
  const [pathSaved, setPathSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const fetchStatus = async () => {
    setLoadingStatus(true);
    try {
      const s = await window.lionclaw.codex.status();
      setStatus(s as CodexStatus);
    } catch {
      setStatus({
        installed: false,
        version: null,
        authenticated: false,
        appServerSupported: false,
      });
    } finally {
      setLoadingStatus(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handleOpenLogin = async () => {
    try {
      await window.lionclaw.codex.openLogin();
    } catch {
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = (await window.lionclaw.codex.test()) as { ok: boolean; message: string };
      setTestResult(result);
      if (result.ok) {
        setTestPassed(true);
        await fetchStatus();
      } else {
        setTestPassed(false);
      }
    } catch {
      setTestResult({ ok: false, message: 'Erro inesperado ao testar conexao' });
      setTestPassed(false);
    } finally {
      setTesting(false);
    }
  };

  const handleSavePath = async () => {
    const trimmed = customPath.trim();
    if (!trimmed) return;
    setSavingPath(true);
    try {
      await window.lionclaw.codex.setBinaryPath(trimmed);
      setPathSaved(true);
      setTimeout(() => setPathSaved(false), 2000);
      await fetchStatus();
      setTestPassed(false);
      setTestResult(null);
    } catch {
    } finally {
      setSavingPath(false);
    }
  };

  const handleContinue = async () => {
    setSubmitting(true);
    setSubmitError('');
    const result = await onComplete({
      orchestratorRuntime: 'codex-sdk',
      orchestratorProvider: 'codex',
      orchestratorModel: CODEX_DEFAULT_MODEL,
    });
    if ('error' in result) {
      setSubmitError(result.error);
    }
    setSubmitting(false);
  };

  const statusBadge = () => {
    if (loadingStatus) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400">
          <span className="w-2 h-2 rounded-full bg-zinc-600 animate-pulse" />
          Verificando...
        </span>
      );
    }
    if (!status || !status.installed) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-red-950 text-red-400 border border-red-800">
          <XCircle size={12} />
          Nao instalado
        </span>
      );
    }
    if (!status.authenticated) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-yellow-950 text-yellow-400 border border-yellow-800">
          <span className="w-2 h-2 rounded-full bg-yellow-500" />
          Instalado, nao autenticado
        </span>
      );
    }
    if (!status.appServerSupported) {
      return (
        <span
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-red-950 text-red-400 border border-red-800"
          title={status.error}
        >
          <XCircle size={12} />
          App Server indisponivel
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-green-950 text-green-400 border border-green-800">
        <CheckCircle size={12} />
        Conectado
      </span>
    );
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <Terminal size={16} className="text-amber-500" />
        <span className="text-sm font-medium text-zinc-300">Codex SDK (OpenAI)</span>
      </div>

      {/* Card */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-4">
        {/* Explanation */}
        <p className="text-xs text-zinc-500 leading-relaxed">
          O Codex e cobrado pela sua assinatura ChatGPT Plus. Autentique via CLI
          com{' '}
          <code className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-300 text-[10px]">
            codex login
          </code>{' '}
          antes de continuar. Instale com{' '}
          <code className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-300 text-[10px]">
            npm install -g @openai/codex
          </code>
          .
        </p>

        {/* Status row */}
        <div className="flex items-center gap-3">
          {statusBadge()}
          {status?.version && (
            <span className="text-xs text-zinc-500">
              versao:{' '}
              <span className="text-zinc-400 font-mono">{status.version}</span>
            </span>
          )}
          <button
            onClick={fetchStatus}
            disabled={loadingStatus}
            title="Atualizar status"
            className="ml-auto text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
          >
            <RefreshCw size={13} className={loadingStatus ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Not-installed hint */}
        {!loadingStatus && status && !status.installed && (
          <p className="text-xs text-zinc-500">
            Instale via{' '}
            <code className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-300 text-[10px]">
              npm install -g @openai/codex
            </code>{' '}
            e depois clique em "Verificar novamente".
          </p>
        )}

        {/* Action buttons — shown only when CLI is installed */}
        {!loadingStatus && status?.installed && (
          <div className="flex flex-wrap gap-3">
            {/* Conectar Codex */}
            {!status.authenticated && (
              <button
                onClick={handleOpenLogin}
                className="px-3 py-1.5 text-xs rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors"
              >
                Conectar Codex
              </button>
            )}

            {/* Testar conexao */}
            <button
              onClick={handleTest}
              disabled={testing}
              className="px-3 py-1.5 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors disabled:opacity-50"
            >
              {testing ? 'Testando...' : 'Testar conexao'}
            </button>
          </div>
        )}

        {/* Test result */}
        {testResult && (
          <div
            className={`flex items-start gap-2 text-xs rounded-lg px-3 py-2 ${
              testResult.ok
                ? 'bg-green-950 border border-green-800 text-green-300'
                : 'bg-red-950 border border-red-800 text-red-300'
            }`}
          >
            {testResult.ok ? (
              <CheckCircle size={13} className="mt-0.5 shrink-0" />
            ) : (
              <XCircle size={13} className="mt-0.5 shrink-0" />
            )}
            <span className="font-mono break-all">{testResult.message}</span>
          </div>
        )}

        {/* Custom binary path (collapsible) */}
        <div className="pt-2 border-t border-zinc-800 space-y-2">
          <button
            onClick={() => setShowPathField((v) => !v)}
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {showPathField ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            Caminho do binario Codex (avancado)
          </button>

          {showPathField && (
            <div className="flex gap-2">
              <input
                type="text"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                placeholder="/usr/local/bin/codex"
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
              />
              <button
                onClick={handleSavePath}
                disabled={savingPath || !customPath.trim()}
                className="px-3 py-2 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors disabled:opacity-50"
              >
                {savingPath ? 'Salvando...' : pathSaved ? 'Salvo!' : 'Salvar'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Submit error */}
      {submitError && (
        <p className="text-xs text-red-400">{submitError}</p>
      )}

      {/* Continuar — gated on testPassed */}
      <button
        onClick={handleContinue}
        disabled={!testPassed || submitting}
        className="w-full flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? (
          <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
        ) : (
          <>
            Continuar
            <ArrowRight size={16} />
          </>
        )}
      </button>

      {!testPassed && (
        <p className="text-xs text-zinc-500 text-center">
          Execute "Testar conexao" com sucesso para habilitar o botao Continuar.
        </p>
      )}
    </div>
  );
}
